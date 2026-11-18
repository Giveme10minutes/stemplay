"""混音场景预设（第 3 轮）：规则化生成 + 实测总线峰值 + 统一缩放保余量。

三套预设（规则显式、可按曲目覆盖 analysisConfig.presets）：
- full   完整合奏：所有轨 gain=1，保持原有声部比例。
- vocal  人声聚光：vocals=1.0，其余 duck 到 duckGain（默认 0.22，可闻但不抢戏）。
- rhythm 节奏主场：drums=1.0、bass=0.9，其余 duck 到 duckGain（默认 0.15）。

缺失轨道兼容：预设只包含实际存在的轨；focus 轨缺失时该预设退化为 full 并注明。
峰值保护：逐声道实测整曲叠加峰值（mix[:,c]=Σ g·x[:,c]，取全声道最大绝对值；
绝不先均值下混——反相立体声会抵消、同相叠加会低估单声道峰值）。
超过 headroomTarget 时对整套预设乘同一缩放系数（保持声部比例）；
gains 按 round(g,4) 导出后必须用取整后的导出增益重新实测，仍超则继续微调缩放，
直到导出增益下实测峰值 ≤ headroomTarget。busPeak = 最终导出增益下的逐声道最大峰值。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .audio import read_wav_channels
from .contract import atomic_write_json

DEFAULT_PRESET_PARAMS = {
    "headroomTarget": 0.95,
    "vocalDuckGain": 0.22,
    "rhythmDuckGain": 0.15,
    "transitionSec": {"full": 0.4, "vocal": 0.6, "rhythm": 0.6},
}

PRESET_DEFS = [
    {"id": "full", "name": "完整合奏", "focus": {}},
    {"id": "vocal", "name": "人声聚光", "focus": {"vocals": 1.0}, "duckKey": "vocalDuckGain"},
    {"id": "rhythm", "name": "节奏主场", "focus": {"drums": 1.0, "bass": 0.9}, "duckKey": "rhythmDuckGain"},
]


def preset_params(track: dict) -> dict:
    cfg = (track.get("analysisConfig") or {}).get("presets") or {}
    params = {**DEFAULT_PRESET_PARAMS, **cfg}
    params["transitionSec"] = {**DEFAULT_PRESET_PARAMS["transitionSec"],
                               **(cfg.get("transitionSec") or {})}
    if not (0.1 <= params["headroomTarget"] <= 1.0):
        raise ValueError("presets.headroomTarget 必须在 [0.1,1.0]")
    return params


def _measure_channel_peaks(stems: dict[str, np.ndarray], gains: dict[str, float],
                           n: int, ch: int) -> tuple[float, list[float]]:
    """按给定增益逐声道混音实测峰值（分块累加，不整曲驻留混音数组）。"""
    peaks = np.zeros(ch, dtype=np.float64)
    step = 1 << 20
    for s in range(0, n, step):
        e = min(n, s + step)
        mix = np.zeros((e - s, ch), dtype=np.float64)
        for sid, x in stems.items():
            mix += gains[sid] * x[s:e]
        np.maximum(peaks, np.max(np.abs(mix), axis=0), out=peaks)
    return float(peaks.max()), [float(v) for v in peaks]


def run_presets(out_dir: Path) -> dict:
    from .manifest import load_manifest, sync_manifest

    out_dir = Path(out_dir).resolve()
    manifest = load_manifest(out_dir)
    track = manifest["track"]
    params = preset_params(track)
    stem_ids = [s["id"] for s in track["stems"]]
    audio_paths = {s["id"]: (out_dir / s["audio"]["path"]).resolve() for s in track["stems"]}

    # 逐轨读入并保留声道（供三套预设逐声道累加，避免重复读盘）
    data, stem_peaks = {}, {}
    for sid in stem_ids:
        x = read_wav_channels(audio_paths[sid])
        data[sid] = x
        stem_peaks[sid] = float(np.max(np.abs(x)))  # 逐声道最大绝对值
    n, ch = data[stem_ids[0]].shape
    target = params["headroomTarget"]

    presets = []
    for defn in PRESET_DEFS:
        focus = {k: v for k, v in defn["focus"].items() if k in stem_ids}
        degraded = bool(defn["focus"]) and not focus
        if degraded:
            focus = {}
        duck = 1.0 if degraded or not defn.get("duckKey") else params.get(defn["duckKey"], 1.0)
        gains = {sid: float(focus.get(sid, duck)) for sid in stem_ids}
        peak_unscaled, _ = _measure_channel_peaks(data, gains, n, ch)
        scale = 1.0
        if peak_unscaled > target:
            scale = target / peak_unscaled
            gains = {sid: g * scale for sid, g in gains.items()}
        # 导出增益取整后必须重新实测；取整可能把峰值抬回目标之上 → 继续微调缩放
        export = {sid: round(g, 4) for sid, g in gains.items()}
        peak, channel_peaks = _measure_channel_peaks(data, export, n, ch)
        for _ in range(32):
            if peak <= target:
                break
            factor = target / peak
            scale *= factor
            new = {sid: round(g * factor, 4) for sid, g in export.items()}
            if new == export:  # 取整粒度吞掉缩放量 → 强制每档减 1e-4，保证收敛
                new = {sid: max(0.0, round(g - 1e-4, 4)) for sid, g in export.items()}
            export = new
            peak, channel_peaks = _measure_channel_peaks(data, export, n, ch)
        if peak > target:
            raise RuntimeError(f"预设 {defn['id']}: 导出增益峰值无法收敛到 headroomTarget")
        presets.append({
            "id": defn["id"],
            "name": defn["name"],
            "gains": export,
            "muted": {sid: False for sid in stem_ids},
            "pan": {sid: 0.0 for sid in stem_ids},
            "transitionSec": params["transitionSec"][defn["id"]],
            "busPeak": round(peak, 4),
            "channelPeaks": [round(v, 4) for v in channel_peaks],
            "busPeakUnscaled": round(peak_unscaled, 4),
            "appliedScale": round(scale, 4),
            "degradedToFull": degraded,
        })
        print(f"  预设 {defn['id']}: busPeak={peak:.4f} scale={scale:.4f}"
              + ("（focus 轨缺失，退化为合奏）" if degraded else ""))

    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "presets",
        "pipelineVersion": PIPELINE_VERSION,
        "trackId": track["id"],
        "sourceAudioSha256": {s["id"]: s["audio"]["sha256"] for s in track["stems"]},
        "presetIds": [p["id"] for p in presets],
        "headroomTarget": params["headroomTarget"],
        "params": params,
        "stemPeaks": {sid: round(v, 4) for sid, v in stem_peaks.items()},
        "peakMethod": (
            "整曲逐声道实测叠加峰值（mix[:,c]=Σ g·x[:,c]，busPeak=全声道最大绝对值，不做均值下混）；"
            "超限对整套预设统一缩放（保持声部比例），gains 取整到 4 位小数导出后按导出增益重新实测，"
            "仍超则继续微调缩放，确保导出增益下逐声道实测 ≤ headroomTarget；不做逐轨归一化"
        ),
        "presets": presets,
        "frontendScheduling": (
            "预设为静态场景，由用户动作或媒体时间调度触发：目标增益 = preset.gains[stem] × 用户音量，"
            "mute/solo 仍优先。用 GainNode.gain.setTargetAtTime(target, when, transitionSec/3) 平滑；"
            "按媒体时间 T 调度时 when = startedAt + (T - startOffset)（沿用现有同步引擎时钟）。"
        ),
    }
    atomic_write_json(out_dir / "presets.json", doc, separators=(",", ":"))
    return sync_manifest(out_dir)