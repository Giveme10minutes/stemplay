"""50Hz 音画联动特征（第 2 轮）。

时间定义（所有轨道一致，前端必须按此取值）：
- hop = round(sampleRate / 目标帧率)，实际 frameRate = sampleRate / hop。
- 第 i 帧的时间戳 t_i = originSec + i * hop / sampleRate，即窗口中心。
- 分析窗为以 t_i 为中心、长 windowSamples 的 Hann 窗，越界部分补零。
  windowCenterOffsetSec = 0：时间戳就是窗口中心，无系统性提前/滞后。
- nFrames = ceil(样本数 / hop)，末尾不足一窗补零计入，不伪造事件。

强度定义（跨轨可比，不做逐轨归一化；立体声逐声道计算后合并，绝不先均值下混）：
- rms：窗内全样本全声道均方根 sqrt(mean(x²))，幅度 0..1。反相立体声不会抵消。
- low/mid/high：各声道频带均方值（Parseval，含 Hann 窗功率补偿）跨声道平均，
  三者之和 ≈ rms²。
- onset：各声道线性幅度谱通量 sum(max(0, |X_i| - |X_{i-1}|)) / win 跨声道平均，首帧恒 0。
- peakMin/peakMax：同一中心窗内全声道最小/最大幅度。
同相立体声（L=R）合并结果与单声道完全一致。

显示缩放（display）由整首歌所有轨道 pooled 统计得出、全轨共享：
弱音/串音轨道不会被单独拉满。静音阈值是绝对幅度门限。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .audio import read_wav_channels, sha256_file
from .contract import atomic_write_json

DEFAULT_FRAME_RATE = 50.0
DEFAULT_WINDOW = 2048
DEFAULT_SILENCE_THRESHOLD = 1e-3  # 约 -60 dBFS
BANDS_HZ = {"low": [20.0, 250.0], "mid": [250.0, 2000.0], "high": [2000.0, 16000.0]}
BATCH = 512
ARRAY_KEYS = ("rms", "low", "mid", "high", "onset", "peakMin", "peakMax")


def _analysis_params(track: dict) -> dict:
    cfg = track.get("analysisConfig") or {}
    frame_rate = float(cfg.get("frameRate", DEFAULT_FRAME_RATE))
    window = int(cfg.get("windowSamples", DEFAULT_WINDOW))
    silence = float(cfg.get("silenceThreshold", DEFAULT_SILENCE_THRESHOLD))
    if not (1.0 <= frame_rate <= 200.0):
        raise ValueError(f"frameRate 超出合理范围 [1,200]: {frame_rate}")
    if window < 64 or window % 2:
        raise ValueError(f"windowSamples 必须是 >=64 的偶数: {window}")
    if silence < 0:
        raise ValueError(f"silenceThreshold 不能为负: {silence}")
    return {"frameRate": frame_rate, "windowSamples": window, "silenceThreshold": silence}


def _single_channel_arrays(x: np.ndarray, n_frames: int, hop: int, win: int,
                           hann: np.ndarray, band_idx: dict, band_weight: dict,
                           band_norm: float, flux_norm: float) -> dict:
    """对单个声道跑滑窗 + FFT，返回该声道的全部特征数组（与旧单声道实现一致）。"""
    n = len(x)
    half = win // 2
    padded = np.zeros(n + win, dtype=np.float32)
    padded[half : half + n] = x
    frames = np.lib.stride_tricks.sliding_window_view(padded, win)[::hop][:n_frames]

    arrays = {k: np.empty(n_frames, dtype=np.float64) for k in ARRAY_KEYS}
    prev_mag = None
    for start in range(0, n_frames, BATCH):
        batch = frames[start : start + BATCH]
        b64 = batch.astype(np.float64)
        arrays["rms"][start : start + len(batch)] = np.sqrt(np.mean(b64 * b64, axis=1))
        arrays["peakMin"][start : start + len(batch)] = batch.min(axis=1)
        arrays["peakMax"][start : start + len(batch)] = batch.max(axis=1)

        spec = np.fft.rfft(batch * hann, axis=1)
        mag = np.abs(spec)
        power = mag * mag
        for name in BANDS_HZ:
            idx, w = band_idx[name], band_weight[name]
            arrays[name][start : start + len(batch)] = (
                (power[:, idx] * w).sum(axis=1) * band_norm
            )
        flux = np.zeros(len(batch), dtype=np.float64)
        flux[1:] = np.maximum(0.0, mag[1:] - mag[:-1]).sum(axis=1) * flux_norm
        if prev_mag is not None:
            flux[0] = float(np.maximum(0.0, mag[0] - prev_mag).sum()) * flux_norm
        arrays["onset"][start : start + len(batch)] = flux
        prev_mag = mag[-1]
    return arrays


def extract_stem_arrays(samples: np.ndarray, sample_rate: int, params: dict) -> tuple[dict, dict]:
    """提取全部特征，返回 (arrays, meta)。

    samples 形状 (n, ch)（立体声保留声道）或 1d（视为单声道）。
    逐声道分别计算后按能量合并：rms=全声道均方根，频带/onset 跨声道平均，
    peakMin/peakMax 取全声道极值。同相立体声结果与单声道一致；反相不抵消。
    """
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    if x.ndim != 2 or x.shape[1] < 1:
        raise ValueError(f"samples 必须是 1d 或 (n, ch) 数组，收到形状 {np.shape(samples)}")
    n, ch = x.shape
    hop = int(round(sample_rate / params["frameRate"]))
    win = params["windowSamples"]
    frame_rate = sample_rate / hop
    n_frames = max(1, math.ceil(n / hop))

    hann = np.hanning(win).astype(np.float32)
    hann_power = float(np.mean(hann.astype(np.float64) ** 2))
    freqs = np.fft.rfftfreq(win, d=1.0 / sample_rate)
    nyquist = sample_rate / 2
    band_idx, band_weight = {}, {}
    for name, (lo, hi) in BANDS_HZ.items():
        hi = min(hi, nyquist)
        idx = np.flatnonzero((freqs >= lo) & (freqs < hi))
        w = np.full(len(idx), 2.0)
        w[freqs[idx] == 0.0] = 1.0
        if win % 2 == 0:
            w[freqs[idx] == nyquist] = 1.0
        band_idx[name], band_weight[name] = idx, w
    flux_norm = 1.0 / win
    band_norm = 1.0 / (win * win * hann_power)

    arrays = {k: np.zeros(n_frames, dtype=np.float64) for k in ARRAY_KEYS}
    arrays["peakMin"].fill(np.inf)
    arrays["peakMax"].fill(-np.inf)
    for c in range(ch):
        carr = _single_channel_arrays(x[:, c], n_frames, hop, win, hann,
                                      band_idx, band_weight, band_norm, flux_norm)
        arrays["rms"] += carr["rms"] ** 2  # 累加均方，最后开方 = 全声道均方根
        for name in BANDS_HZ:
            arrays[name] += carr[name]
        arrays["onset"] += carr["onset"]
        np.minimum(arrays["peakMin"], carr["peakMin"], out=arrays["peakMin"])
        np.maximum(arrays["peakMax"], carr["peakMax"], out=arrays["peakMax"])
    arrays["rms"] = np.sqrt(arrays["rms"] / ch)
    for name in BANDS_HZ:
        arrays[name] /= ch
    arrays["onset"] /= ch

    for key, arr in arrays.items():
        if not np.all(np.isfinite(arr)):
            raise RuntimeError(f"特征 {key} 含 NaN/Infinity，拒绝输出")

    meta = {
        "originSec": 0.0,
        "frameRate": frame_rate,
        "hopSamples": hop,
        "windowSamples": win,
        "windowCenterOffsetSec": 0.0,
        "nFrames": n_frames,
        "durationSec": n / sample_rate,
        "channels": ch,
        "channelMix": "per-channel-energy-merge",
        "bandsHz": BANDS_HZ,
    }
    return arrays, meta


def _shared_display(all_arrays: dict[str, dict], silence_threshold: float) -> dict:
    rms_pool = np.concatenate([a["rms"] for a in all_arrays.values()])
    onset_pool = np.concatenate([a["onset"] for a in all_arrays.values()])
    rms_ref = max(float(np.percentile(rms_pool, 95)), 1e-6)
    onset_ref = max(float(np.percentile(onset_pool, 99)), 1e-9)
    return {
        "sharedAcrossStems": True,
        "rmsRef": rms_ref,
        "bandRef": rms_ref * rms_ref,
        "onsetRef": onset_ref,
        "silenceThreshold": silence_threshold,
        "note": "display = clamp(raw / ref, 0, 1)；rms < silenceThreshold 的帧视为静音。ref 为整曲 pooled 分位数，全轨共享，禁止逐轨单独拉满。",
    }


def _round_sig(values: np.ndarray) -> list[float]:
    return [float(f"{v:.6g}") for v in values]


def run_features(out_dir: Path) -> dict:
    """读取 base manifest → 逐轨提取 → 共享显示参数 → 写特征文件并重投影 manifest。"""
    from .manifest import load_base, sync_manifest

    out_dir = Path(out_dir).resolve()
    manifest = load_base(out_dir)
    track = manifest["track"]
    params = _analysis_params(track)

    all_arrays, all_meta = {}, {}
    for stem in track["stems"]:
        audio = stem["audio"]
        audio_path = (out_dir / audio["path"]).resolve()
        actual_sha = sha256_file(audio_path)
        if actual_sha != audio["sha256"]:
            raise RuntimeError(
                f"{stem['id']}: 源音频已变化（sha256 不匹配），请重新运行 manifest 阶段"
            )
        samples = read_wav_channels(audio_path)
        arrays, meta = extract_stem_arrays(samples, audio["sampleRate"], params)
        meta["originSec"] = track["originSec"]
        all_arrays[stem["id"]] = arrays
        all_meta[stem["id"]] = meta
        print(
            f"  {stem['id']}: {meta['nFrames']} 帧 @ {meta['frameRate']:.3f}Hz, "
            f"rmsMax={arrays['rms'].max():.4f}"
        )

    display = _shared_display(all_arrays, params["silenceThreshold"])
    feat_dir = out_dir / "features"
    feat_dir.mkdir(parents=True, exist_ok=True)

    for stem in track["stems"]:
        sid = stem["id"]
        arrays, meta = all_arrays[sid], all_meta[sid]
        rms = arrays["rms"]
        doc = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "stem-features",
            "pipelineVersion": PIPELINE_VERSION,
            "trackId": track["id"],
            "stemId": sid,
            "sourceSha256": stem["audio"]["sha256"],
            **meta,
            "units": {
                "rms": "amplitude 0..1（全声道均方根，逐声道能量合并）",
                "low": "mean-square（各声道频带均方跨声道平均）",
                "mid": "mean-square（各声道频带均方跨声道平均）",
                "high": "mean-square（各声道频带均方跨声道平均）",
                "onset": "spectral-flux amplitude（各声道谱通量跨声道平均）",
                "peakMin": "amplitude -1..1（窗内全声道最小）",
                "peakMax": "amplitude -1..1（窗内全声道最大）",
            },
            "frameTime": "t_i = originSec + i / frameRate（窗口中心，无额外偏移）",
            "display": display,
            "stats": {
                "rmsMax": float(rms.max()),
                "rmsMean": float(rms.mean()),
                "silentFrameRatio": float(np.mean(rms < display["silenceThreshold"])),
            },
            "arrays": {k: _round_sig(arrays[k]) for k in ARRAY_KEYS},
        }
        rel = f"features/{sid}.json"
        atomic_write_json(out_dir / rel, doc, separators=(",", ":"))

    return sync_manifest(out_dir)