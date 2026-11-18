"""自动质检报告（第 4 轮）。

阻断性错误（fail）→ 禁止发布；非关键分析失败 → degraded/warn 降级放行。
自动质检只验证工程正确性（解码/对齐/完整性/峰值/体积），不等于判断分离音质。
授权未确认 → whitelist 为空，资源包仅限本地。
"""
from __future__ import annotations

import json
import math
import wave
from datetime import datetime, timezone
from pathlib import Path

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .audio import AudioError, sha256_file
from .contract import atomic_write_json
from .preview import ALIGNMENT_MIN_CORR, DURATION_TOLERANCE_SEC, MAX_DELAY_SAMPLES

PREVIEW_AUDIO_TARGET_BYTES = 10 * 1024 * 1024  # 45s 六轨优化目标（非阻断）

BACKEND_VERIFIED = [
    "预览 AAC 逐轨解码回检：能量包络粗定位 + 波形细化实测起点延迟（delayStatus=measured/uncertain/silent；"
    "uncertain → delaySec=null 不写补偿值、非阻断待核验）、内容时长、对齐相关系数",
    "六轨预览同一裁剪窗口；特征为整曲数组 hop 网格精确切片；拍点已平移",
    "全部特征数组有限值、等长、无 NaN/Infinity（allow_nan=False 落盘）；立体声逐声道能量合并，反相不抵消",
    "三套预设按导出增益流式重读源 WAV 逐声道实测峰值 ≤ headroomTarget（统一缩放保持声部比例），"
    "并校验 busPeak 字段与实测一致（防篡改/失真）",
    "manifest 挂载与产物 sha256 一致；缓存命中前已验完整性；源音频路径逐一复核存在",
]
BROWSER_PENDING = [
    "decodeAudioData 对 m4a 编码延迟（gapless 元数据）的处理是否与 ffmpeg 回检一致 → 用 delaySec 补偿后实测对齐；"
    "delaySec=null（delayStatus=uncertain）表示延迟不确定，前端不做补偿并视为待核验",
    "六轨 BufferSource 同一 when 启动的样本级同步（沿用现有引擎，预览需按 delaySec 逐轨补偿或统一裁掉 priming）",
    "setTargetAtTime 预设过渡听感、移动端解码内存与首屏耗时",
    "特征驱动动画的主观效果（阈值/缩放参数可在 analysisConfig 覆盖后重建）",
]


def _remeasure_preset_peaks(out_dir: Path, track: dict, presets_doc: dict):
    """流式重读源 WAV，按导出增益对每套预设逐块累加混音并维护逐声道运行最大值。

    不整曲混音数组驻留内存；返回形状 (预设数, 声道数) 的实测峰值数组。
    """
    import numpy as np

    from .audio import _pcm_to_float32

    stems = track["stems"]
    paths = [(out_dir / s["audio"]["path"]).resolve() for s in stems]
    for p in paths:
        if not p.is_file():
            raise AudioError(f"源音频缺失，无法重测峰值: {p}")
    presets = presets_doc["presets"]
    n_ch = int(track["channels"])
    peaks = np.zeros((len(presets), n_ch), dtype=np.float64)
    handles = [wave.open(str(p), "rb") for p in paths]
    try:
        metas = [(w.getsampwidth(), w.getnchannels(), w.getnframes()) for w in handles]
        total = metas[0][2]
        chunk = 1 << 18
        done = 0
        while done < total:
            blocks = []
            for w, (width, ch, _frames) in zip(handles, metas):
                raw = w.readframes(min(chunk, total - done))
                got = len(raw) // (width * ch)
                if got == 0:
                    raise AudioError(f"WAV 数据截断（重测峰值读到 {done}/{total} 帧）")
                blocks.append(_pcm_to_float32(raw, width, ch))
            m = min(len(b) for b in blocks)
            for pi, preset in enumerate(presets):
                mix = np.zeros((m, n_ch), dtype=np.float64)
                for block, s in zip(blocks, stems):
                    mix += preset["gains"][s["id"]] * block[:m]
                np.maximum(peaks[pi], np.max(np.abs(mix), axis=0), out=peaks[pi])
            done += m
    finally:
        for w in handles:
            w.close()
    return peaks


def run_report(out_dir: Path) -> dict:
    from .manifest import load_manifest

    out_dir = Path(out_dir).resolve()
    manifest = load_manifest(out_dir)
    track = manifest["track"]
    checks: list[dict] = []

    def add(cid, status, detail):
        checks.append({"id": cid, "status": status, "detail": detail})

    # 授权（restricted 不阻断本地构建，但公开白名单为空）
    lic = track["license"]
    add("license", "pass" if lic["publicDeployAllowed"] else "restricted",
        f"status={lic['status']} spdx={lic['spdx']} publicDeployAllowed={lic['publicDeployAllowed']}")

    # 挂载完整性
    missing = [s["id"] for s in track["stems"] if s["features"]["status"] != "ready"]
    add("features-mounts", "fail" if missing else "pass",
        f"缺失特征轨: {missing}" if missing else f"{len(track['stems'])} 轨特征 ready")
    for kind in ("beats", "presets", "preview"):
        st = manifest["resources"][kind]["status"]
        add(f"{kind}-mount", "fail" if st != "ready" else "pass", f"status={st}")

    # 源音频路径兜底复核（路径缓存/重写错误时在此阻断）
    missing_src = [s["id"] for s in track["stems"]
                   if not (out_dir / s["audio"]["path"]).resolve().is_file()]
    add("source-audio-paths", "fail" if missing_src else "pass",
        f"源音频缺失: {missing_src}" if missing_src else f"{len(track['stems'])} 轨源音频路径均可解析")

    pv = None
    pv_path = out_dir / "preview/preview.json"
    if pv_path.is_file():
        pv = json.loads(pv_path.read_text(encoding="utf-8"))

    # 解码回检 + 长度对齐（delayStatus=uncertain → warn 非阻断，不做延迟/时长严格校验）
    if pv:
        bad, uncertain = [], []
        for sid, e in pv["stems"].items():
            if not e.get("decodeVerified"):
                bad.append(f"{sid}: 未解码验证")
            status = e.get("delayStatus", "measured")
            if status == "uncertain":
                uncertain.append(sid)
            else:
                delay = e.get("delaySamples")
                if delay is not None and delay > MAX_DELAY_SAMPLES:
                    bad.append(f"{sid}: 延迟 {delay} 超上限")
                if abs(e["contentDurationSec"] - pv["durationSec"]) > DURATION_TOLERANCE_SEC:
                    bad.append(f"{sid}: 内容时长偏差超容差")
            corr = e.get("alignmentCorr")
            if corr is not None and corr < ALIGNMENT_MIN_CORR:
                bad.append(f"{sid}: 对齐 corr={corr}")
        detail = "; ".join(bad) or (
            f"延迟不确定（待核验，不补偿）: {uncertain}" if uncertain else
            f"{len(pv['stems'])} 轨解码回检通过（延迟/时长/互相关）")
        add("preview-decode", "fail" if bad else ("warn" if uncertain else "pass"), detail)
        spread = pv.get("delaySpreadSamples", 0)
        add("preview-delay-consistency", "warn" if spread > 128 else "pass",
            f"逐轨编码延迟极差 {spread} 样本（前端按各轨 delaySec 补偿）")
        # 网格吸附：originSec 必须落在 hop 网格上
        fr = pv["features"]["frameRate"]
        grid_err = abs(pv["originSec"] * fr - round(pv["originSec"] * fr))
        add("preview-grid-snap", "fail" if grid_err > 1e-6 else "pass",
            f"originSec×frameRate 偏离整数 {grid_err:.2e}")
        # 预览特征完整性
        bad = []
        for sid in pv["stems"]:
            f = json.loads((out_dir / "preview/features" / f"{sid}.json").read_text(encoding="utf-8"))
            if f["nFrames"] != pv["features"]["nFrames"]:
                bad.append(f"{sid}: nFrames 不一致")
            for k, arr in f["arrays"].items():
                if len(arr) != f["nFrames"] or not all(math.isfinite(v) for v in arr):
                    bad.append(f"{sid}: 数组 {k} 长度/有限值异常")
            if f["originSec"] != pv["originSec"]:
                bad.append(f"{sid}: originSec 不一致")
        add("preview-features", "fail" if bad else "pass",
            "; ".join(bad) or f"切片特征完整（K={pv['features']['nFrames']}，时间基准一致）")
        # 预览拍点范围
        pb = json.loads((out_dir / "preview/beats.json").read_text(encoding="utf-8"))
        out_of_range = [t for t in pb["beatsSec"] if not (0 <= t <= pv["durationSec"] + 1e-6)]
        add("preview-beats-range", "fail" if out_of_range else "pass",
            f"{len(pb['beatsSec'])} 个局部拍点，越界 {len(out_of_range)}")
    else:
        add("preview-decode", "fail", "preview.json 不存在")

    # 整曲特征完整性（抽查文件可解析 + 数组等长有限）
    bad = []
    for s in track["stems"]:
        if s["features"]["status"] != "ready":
            continue
        f = json.loads((out_dir / s["features"]["path"]).read_text(encoding="utf-8"))
        if f["sourceSha256"] != s["audio"]["sha256"]:
            bad.append(f"{s['id']}: 特征绑定的源哈希过期")
        for k, arr in f["arrays"].items():
            if len(arr) != f["nFrames"] or not all(math.isfinite(v) for v in arr):
                bad.append(f"{s['id']}: {k} 异常")
    add("full-features", "fail" if bad else "pass", "; ".join(bad) or "整曲特征完整且绑定当前源")

    # 预设峰值：不能只信 busPeak 字段——流式重读源 WAV，按导出增益逐声道实测
    if manifest["resources"]["presets"]["status"] == "ready":
        p = json.loads((out_dir / "presets.json").read_text(encoding="utf-8"))
        bad = []
        try:
            peaks = _remeasure_preset_peaks(out_dir, track, p)
            measured = []
            for pi, x in enumerate(p["presets"]):
                actual = float(peaks[pi].max())
                measured.append(f"{x['id']}={actual:.4f}")
                if actual > p["headroomTarget"] + 1e-6:
                    bad.append(f"{x['id']}: 导出增益实测逐声道峰值 {actual:.4f} 超 headroom")
                if abs(float(x["busPeak"]) - actual) > 0.002:
                    bad.append(f"{x['id']}: busPeak 字段 {x['busPeak']} 与实测 {actual:.4f} 偏差超 0.002")
            detail = "; ".join(bad) or ("逐声道实测 " + "; ".join(measured))
        except (AudioError, OSError, wave.Error) as e:
            bad, detail = [str(e)], f"无法重测峰值: {e}"
        add("preset-peaks", "fail" if bad else "pass", detail)
    else:
        add("preset-peaks", "fail", "presets.json 缺失")

    # 节拍降级状态（非阻断）
    if manifest["resources"]["beats"]["status"] == "ready":
        b = json.loads((out_dir / "beats.json").read_text(encoding="utf-8"))
        add("beats-state", "pass" if b["snapEnabled"] else "degraded",
            f"bpm={b['bpm']} score={b['heuristicScore']} snapEnabled={b['snapEnabled']}"
            + (f" reason={b['degradedReason']}" if not b["snapEnabled"] else ""))
    else:
        add("beats-state", "fail", "beats.json 缺失")

    # 体积
    sizes = {}
    if pv:
        sizes["previewAudioBytes"] = sum(e["bytes"] for e in pv["stems"].values())
        pkg_files = [out_dir / "manifest.json", out_dir / "beats.json", out_dir / "presets.json",
                     out_dir / "preview/preview.json", out_dir / "preview/beats.json"]
        pkg_files += list((out_dir / "features").glob("*.json"))
        pkg_files += list((out_dir / "preview/features").glob("*.json"))
        pkg_files += [out_dir / "preview" / e["path"] for e in pv["stems"].values()]
        sizes["packageBytes"] = sum(f.stat().st_size for f in pkg_files if f.is_file())
        met = sizes["previewAudioBytes"] <= PREVIEW_AUDIO_TARGET_BYTES
        add("size-target", "pass" if met else "warn",
            f"预览音频 {sizes['previewAudioBytes'] / 1048576:.2f}MB / 目标 10MB "
            f"({'达标' if met else '未达标，可降码率'})；资源包合计 {sizes['packageBytes'] / 1048576:.2f}MB")

    counts = {s: sum(c["status"] == s for c in checks) for s in ("pass", "warn", "degraded", "fail", "restricted")}
    blocking = [c["id"] for c in checks if c["status"] == "fail"]
    whitelist = []
    if lic["publicDeployAllowed"]:
        whitelist = ["manifest.json", "beats.json", "presets.json", "report.json",
                     "features/"] + [f"preview/{e['path']}" for e in (pv["stems"].values() if pv else [])]
        whitelist += ["preview/preview.json", "preview/beats.json", "preview/features/"]
        if (track.get("artwork") or {}).get("status") == "ready":
            whitelist.append("artwork/")
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "report",
        "pipelineVersion": PIPELINE_VERSION,
        "trackId": track["id"],
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "checks": checks,
        "summary": counts,
        "blocking": blocking,
        "publishable": not blocking,
        "sizes": sizes,
        "previewAudioTargetBytes": PREVIEW_AUDIO_TARGET_BYTES,
        "license": lic,
        "whitelist": whitelist,
        "whitelistNote": "授权未确认 → 白名单为空，资源包仅限本地；公开部署另需人工确认分离音质（自动质检不判断音质）",
        "backendVerified": BACKEND_VERIFIED,
        "browserPending": BROWSER_PENDING,
    }
    atomic_write_json(out_dir / "report.json", doc, indent=2)
    return doc