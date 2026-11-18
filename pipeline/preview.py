"""轻量预览资源包（第 4 轮）：统一裁剪 + AAC 压缩 + 解码回检 + 特征/拍点同步平移。

时间契约（前端必须按此换算，禁止拿局部播放秒数直读整曲特征）：
- 预览起点吸附到特征 hop 网格：originSec = i0 * hop / sampleRate（整曲时间基准）。
- 预览特征 = 整曲特征的精确切片 [i0 : i0+K]，时间戳 t_i = originSec + i / frameRate。
- 压缩音频存在编码延迟（priming）：解码回检（能量包络粗定位 + 波形细化）测出
  delaySec 并逐轨记录，delayStatus ∈ measured/uncertain/silent。
  delaySec=null（uncertain）表示延迟不确定：前端不做补偿并视为待核验。
  局部播放位置 p → 整曲时间 = originSec + p - delaySec；
  特征下标 = floor((p - delaySec) * frameRate)；预览拍点同理加 delaySec 触发。
- 压缩降低的是传输体积；解码后 PCM 内存由预览时长决定，与码率无关（不宣称等比例降内存）。
"""
from __future__ import annotations

import io
import math
import os
import shutil
import subprocess
import wave
from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .audio import AudioError, _pcm_to_float32
from .contract import atomic_write_json

DEFAULT_PREVIEW_PARAMS = {"previewSec": 40.0, "startSec": None, "bitrate": "128k"}
MAX_DELAY_SAMPLES = 8192          # 编码延迟搜索上限（≈186ms @44.1k）
DURATION_TOLERANCE_SEC = 0.12     # 解码内容时长容差（AAC 帧粒度 + 末尾填充）
ALIGNMENT_MIN_CORR = 0.90         # 解码回检互相关下限


def ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
        raise RuntimeError(
            "预览压缩需要 ffmpeg：pip install -i https://mirrors.aliyun.com/pypi/simple/ "
            "imageio-ffmpeg（自带静态二进制），或安装系统 ffmpeg"
        )


def preview_params(track: dict, overrides: dict | None = None) -> dict:
    cfg = (track.get("analysisConfig") or {}).get("preview") or {}
    params = {**DEFAULT_PREVIEW_PARAMS, **cfg, **(overrides or {})}
    params = {k: v for k, v in params.items() if v is not None}
    params = {**DEFAULT_PREVIEW_PARAMS, **params}
    sec = float(params["previewSec"])
    duration = track["durationSec"]
    note = None
    if duration < 30.0:
        sec, note = duration, "曲目短于 30s，预览取整曲"
    elif sec > duration:
        sec, note = duration, "请求预览长于曲目，裁剪到整曲"
    elif not (30.0 <= sec <= 45.0):
        raise ValueError(f"previewSec 必须在 30–45 秒（收到 {sec}）")
    params["previewSec"] = sec
    params["shortTrackNote"] = note
    br = str(params["bitrate"])
    if not br.endswith("k") or not br[:-1].isdigit() or not (32 <= int(br[:-1]) <= 320):
        raise ValueError(f"bitrate 非法（期望 32k–320k）: {br}")
    if params["startSec"] is not None:
        params["startSec"] = float(params["startSec"])
        if not (0 <= params["startSec"] < duration):
            raise ValueError(f"startSec 超出曲目范围: {params['startSec']}")
    return params


def choose_window(track: dict, feats: dict, params: dict) -> dict:
    """能量自动选段（或配置指定），起点吸附 hop 网格。"""
    sr = track["sampleRate"]
    frame_rate = track["analysis"]["frameRate"]
    hop = track["analysis"]["hopSamples"]
    total_frames = track["stems"][0]["audio"]["frames"]
    n_frames = math.ceil(total_frames / hop)
    sec = params["previewSec"]
    K = min(n_frames, math.ceil(round(sec * sr) / hop))

    if params["startSec"] is not None:
        i0 = int(round(params["startSec"] * frame_rate))
        selection = "config"
    else:
        pooled = np.sum([np.array(f["arrays"]["rms"], dtype=np.float64)
                         for f in feats.values()], axis=0)
        W = max(1, int(round(sec * frame_rate)))
        if W >= len(pooled):
            i0 = 0
        else:
            cs = np.concatenate(([0.0], np.cumsum(pooled)))
            sums = cs[W:] - cs[:-W]
            i0 = int(np.argmax(sums))
        selection = "auto-energy"
    i0 = max(0, min(i0, n_frames - K))
    start_sample = i0 * hop
    preview_samples = min(round(sec * sr), total_frames - start_sample)
    K = math.ceil(preview_samples / hop)
    return {
        "frameOffset": i0,
        "nFrames": K,
        "startSample": start_sample,
        "previewSamples": preview_samples,
        "originSec": start_sample / sr,
        "durationSec": preview_samples / sr,
        "selection": selection,
    }


def _read_segment(path: Path, start: int, count: int) -> tuple[bytes, dict]:
    with wave.open(str(path), "rb") as w:
        meta = {"rate": w.getframerate(), "channels": w.getnchannels(),
                "width": w.getsampwidth()}
        w.setpos(start)
        raw = w.readframes(count)
    got = len(raw) // (meta["width"] * meta["channels"])
    if got != count:
        raise AudioError(f"预览裁剪读取不足（{got}/{count} 帧）: {path}")
    return raw, meta


def _wrap_wav(raw: bytes, meta: dict) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(meta["channels"])
        w.setsampwidth(meta["width"])
        w.setframerate(meta["rate"])
        w.writeframes(raw)
    return buf.getvalue()


def _run_ffmpeg(args: list[str], stdin: bytes | None = None) -> bytes:
    exe = ffmpeg_exe()
    proc = subprocess.run(
        [exe, "-hide_banner", "-loglevel", "error", "-y", *args],
        input=stdin, capture_output=True, timeout=180,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 失败（code={proc.returncode}）: "
                           f"{proc.stderr.decode('utf-8', 'replace')[-500:]}")
    return proc.stdout


def _encode_aac(wav_bytes: bytes, dest: Path, bitrate: str) -> None:
    tmp = dest.with_name(dest.name + ".tmp")
    _run_ffmpeg(["-f", "wav", "-i", "pipe:0", "-c:a", "aac", "-b:a", bitrate,
                 "-movflags", "+faststart", "-f", "mp4", str(tmp)], stdin=wav_bytes)
    os.replace(tmp, dest)


def _decode_back(m4a: Path) -> tuple[np.ndarray, int, int]:
    """解码回 PCM，保留声道（形状 (帧, 声道)）。均值下混会把反相立体声抵消成静音。"""
    raw = _run_ffmpeg(["-i", str(m4a), "-f", "wav", "-acodec", "pcm_s16le", "pipe:1"])
    with wave.open(io.BytesIO(raw), "rb") as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        data = w.readframes(w.getnframes())
    # 管道输出的 WAV 头 data 尺寸是占位值，帧数以实际读到的字节为准
    frames = len(data) // (width * channels)
    samples = _pcm_to_float32(data, width, channels)
    return samples, frames, rate


# ---- 延迟测量参数 ----------------------------------------------------------
ENV_HOP_SEC = 0.01          # 粗定位能量包络步长（~10ms，对波形周期不敏感）
FINE_ENV_HOP_SEC = 0.001    # 歧义消解用细包络步长（~1ms）
NEAR_PEAK_MARGIN = 0.02     # 细化窗内与最优峰差距小于此值视为竞争峰
FINE_ENV_MARGIN = 1e-4      # 细包络消歧所需的最小相关差
ENV_STRUCTURE_REL = 0.02    # 包络相对起伏低于此值视为无结构（纯正弦的 RMS 数值纹波 ~1.3% 也在此列）
ENV_STRUCTURE_ABS = 1e-4
SILENCE_LEVEL = 1e-4        # 源包络低于此值视为静音轨


def _channel_energy(x: np.ndarray) -> np.ndarray:
    """统一为逐样本非负能量：(n,ch) → 跨声道均方根（反相不抵消）；1d → 绝对值。

    1d 与 2d 输入语义必须一致，否则混用时带符号波形与整流能量互相关≈0。"""
    x = np.asarray(x, dtype=np.float64)
    if x.ndim == 2:
        return np.sqrt(np.mean(x * x, axis=1))
    return np.abs(x)


def _block_rms(x: np.ndarray, hop: int) -> np.ndarray:
    n = (len(x) // hop) * hop
    if n == 0:
        return np.zeros(0, dtype=np.float64)
    return np.sqrt(np.mean(x[:n].reshape(-1, hop) ** 2, axis=1))


def _env_corr_at(ea: np.ndarray, eb: np.ndarray, lag: int) -> float:
    m = min(len(ea), len(eb) - lag)
    if m < 8:
        return 0.0
    a = ea[:m] - ea[:m].mean()
    b = eb[lag : lag + m] - eb[lag : lag + m].mean()
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.dot(a, b) / denom) if denom > 1e-12 else 0.0


def _waveform_corr(a: np.ndarray, b: np.ndarray, max_lag: int) -> np.ndarray:
    """全信号 FFT 互相关，返回 lag=0..max_lag 的归一化相关系数（逐 lag 去均值/归一）。"""
    n = min(len(a), len(b) - max_lag)
    a = a[:n].astype(np.float64)
    a = a - a.mean()
    norm_a = float(np.linalg.norm(a))
    if n < 2 or norm_a < 1e-12:
        return np.zeros(max_lag + 1)
    b = b[: n + max_lag].astype(np.float64)
    size = 1 << (n + max_lag - 1).bit_length()
    cc = np.fft.irfft(np.conj(np.fft.rfft(a, size)) * np.fft.rfft(b, size), size)[: max_lag + 1]
    cs = np.concatenate(([0.0], np.cumsum(b)))
    cs2 = np.concatenate(([0.0], np.cumsum(b * b)))
    lags = np.arange(max_lag + 1)
    s1 = cs[lags + n] - cs[lags]
    s2 = cs2[lags + n] - cs2[lags]
    denom = norm_a * np.sqrt(np.maximum(s2 - s1 * s1 / n, 0.0))
    return np.where(denom > 1e-12, cc / np.maximum(denom, 1e-12), 0.0)


def measure_delay(src: np.ndarray, dec: np.ndarray, rate: int) -> tuple[int, float | None, str]:
    """测编码延迟，返回 (lag 样本数, 归一化相关系数, status)。

    status ∈ {"measured", "uncertain", "silent"}：
    - 先用 ~10ms 步长的短时能量包络互相关粗定位（包络对周期不敏感，
      静音标记/瞬态/段落变化给出唯一峰），再在粗定位 ±2 包络步长内做
      波形相关细化到样本级——绝不凭周期波形的全局相关峰定延迟。
    - 包络近乎恒定（无结构）、细化窗内多个竞争峰（差距 <0.02）且细包络
      无法消歧、或各非周期段落支持不一致 → uncertain（调用方不得写补偿值）。
    - 静音轨 → (0, None, "silent")。
    src/dec 可为 1d 或 (n,ch)；立体声用逐样本跨声道均方根合并，反相不抵消。
    """
    a = _channel_energy(src)
    b = _channel_energy(dec)
    max_lag = min(MAX_DELAY_SAMPLES, len(b) - 1)
    if len(a) < 256 or max_lag < 1:
        return 0, None, "uncertain"
    hop = max(1, int(round(rate * ENV_HOP_SEC)))
    env_a = _block_rms(a, hop)
    env_b = _block_rms(b, hop)
    if len(env_a) < 8:
        return 0, None, "uncertain"
    if float(env_a.max()) < SILENCE_LEVEL:
        return 0, None, "silent"

    corr = _waveform_corr(a, b, max_lag)
    structured = float(env_a.std()) > max(ENV_STRUCTURE_ABS, ENV_STRUCTURE_REL * float(env_a.mean()))
    if not structured:
        # 恒定包络：周期波形的全局相关峰不可信，只报告最优峰供参考
        lag = int(np.argmax(corr))
        return lag, float(corr[lag]), "uncertain"

    # 粗定位：包络互相关（10ms 网格）
    max_env_lag = max_lag // hop
    env_scores = [_env_corr_at(env_a, env_b, l) for l in range(max_env_lag + 1)]
    coarse = int(np.argmax(env_scores))
    center = coarse * hop
    radius = 2 * hop
    lo, hi = max(0, center - radius), min(max_lag, center + radius)
    best = lo + int(np.argmax(corr[lo : hi + 1]))
    best_corr = float(corr[best])

    # 细化窗内的竞争峰（局部极大且与最优峰差距 < NEAR_PEAK_MARGIN）
    near = []
    for i in range(lo, hi + 1):
        if corr[i] < best_corr - NEAR_PEAK_MARGIN:
            continue
        left_ok = i == lo or corr[i] > corr[i - 1]
        right_ok = i == hi or corr[i] >= corr[i + 1]
        if left_ok and right_ok:
            near.append(i)
    lag, status = best, "measured"
    if len(near) > 1:
        # 细包络（1ms）消歧：静音边缘/瞬态在细尺度上仍给出唯一对齐
        fhop = max(1, int(round(rate * FINE_ENV_HOP_SEC)))
        fe_a, fe_b = _block_rms(a, fhop), _block_rms(b, fhop)
        scored = sorted(((_env_corr_at(fe_a, fe_b, int(round(l / fhop))), l) for l in near),
                        reverse=True)
        if scored[0][0] - scored[1][0] > FINE_ENV_MARGIN:
            lag = scored[0][1]
        else:
            status = "uncertain"

    # 段落一致性：多个有结构的 2s 段落必须支持同一粗延迟（±1 包络步长）
    if status == "measured":
        chunk = max(8, int(round(2.0 / ENV_HOP_SEC)))
        votes = []
        for s in range(0, len(env_a) - chunk + 1, chunk):
            seg = env_a[s : s + chunk]
            if float(seg.std()) <= max(ENV_STRUCTURE_ABS, 0.05 * float(seg.mean())):
                continue  # 无结构段落不参与投票
            scores = [_env_corr_at(seg, env_b[s:], l) for l in range(max_env_lag + 1)]
            votes.append(int(np.argmax(scores)))
        if len(votes) >= 2 and max(votes) - min(votes) > 1:
            status = "uncertain"
    return lag, float(corr[lag]), status


def run_preview(out_dir: Path, overrides: dict | None = None) -> dict:
    from .manifest import load_manifest, sync_manifest

    out_dir = Path(out_dir).resolve()
    manifest = load_manifest(out_dir)
    track = manifest["track"]
    if "analysis" not in track:
        raise RuntimeError("缺少特征，请先运行 features 阶段")
    params = preview_params(track, overrides)

    feats = {}
    for stem in track["stems"]:
        if stem["features"]["status"] != "ready":
            raise RuntimeError(f"{stem['id']}: 特征缺失，请先运行 features 阶段")
        feats[stem["id"]] = json_load(out_dir / stem["features"]["path"])
    beats_doc = None
    if manifest["resources"]["beats"]["status"] == "ready":
        beats_doc = json_load(out_dir / manifest["resources"]["beats"]["path"])

    win = choose_window(track, feats, params)
    pv_dir = out_dir / "preview"
    (pv_dir / "features").mkdir(parents=True, exist_ok=True)
    sr = track["sampleRate"]
    origin = win["originSec"]
    pv_dur = win["durationSec"]

    stem_entries = {}
    for stem in track["stems"]:
        sid = stem["id"]
        audio_path = (out_dir / stem["audio"]["path"]).resolve()
        raw, meta = _read_segment(audio_path, win["startSample"], win["previewSamples"])
        src = _pcm_to_float32(raw, meta["width"], meta["channels"])  # 保留声道，反相不抵消

        m4a = pv_dir / f"{sid}.m4a"
        _encode_aac(_wrap_wav(raw, meta), m4a, params["bitrate"])
        dec, dec_frames, dec_rate = _decode_back(m4a)
        if dec_rate != sr:
            raise RuntimeError(f"{sid}: 解码采样率 {dec_rate} ≠ 源 {sr}")
        delay, corr, delay_status = measure_delay(src, dec, sr)
        # uncertain 时禁止写入错误补偿值：delaySamples/delaySec=null，时长按 delay=0 计
        # （真实编码 priming 远小于 0.12s 容差，uncertain 不因此阻断构建）
        # silent 轨无延迟可言，按原逻辑记 0
        delay_known = delay_status in ("measured", "silent")
        eff_delay = delay if delay_known else 0
        content_dur = (dec_frames - eff_delay) / dec_rate
        if abs(content_dur - pv_dur) > DURATION_TOLERANCE_SEC:
            raise RuntimeError(
                f"{sid}: 解码内容时长 {content_dur:.3f}s 与预览 {pv_dur:.3f}s 偏差超容差"
            )
        if not (win["previewSamples"] - 64 <= dec_frames <= win["previewSamples"] + 2 * MAX_DELAY_SAMPLES):
            raise RuntimeError(f"{sid}: 解码帧数 {dec_frames} 超出合理范围")
        if corr is not None and corr < ALIGNMENT_MIN_CORR:
            raise RuntimeError(f"{sid}: 解码对齐相关系数 {corr:.3f} < {ALIGNMENT_MIN_CORR}")
        stem_entries[sid] = {
            "path": f"{sid}.m4a",
            "sha256": sha256_of(m4a),
            "bytes": m4a.stat().st_size,
            "delayStatus": delay_status,
            "delaySamples": delay if delay_known else None,
            "delaySec": round(delay / dec_rate, 6) if delay_known else None,
            "decodedFrames": dec_frames,
            "decodedDurationSec": round(dec_frames / dec_rate, 6),
            "contentDurationSec": round(content_dur, 6),
            "alignmentCorr": round(corr, 4) if corr is not None else None,
            "decodeVerified": True,
        }
        print(f"  预览 {sid}: {m4a.stat().st_size // 1024}KB delay={delay}样本({delay_status}) "
              f"corr={corr if corr is None else round(corr, 3)}")

        # 特征 = 整曲数组精确切片（hop 网格对齐），显示参数沿用整曲共享值
        full = feats[sid]
        i0, K = win["frameOffset"], win["nFrames"]
        sliced = {k: v[i0 : i0 + K] for k, v in full["arrays"].items()}
        rms = np.array(sliced["rms"])
        doc = {
            **{k: full[k] for k in ("schemaVersion", "kind", "pipelineVersion", "trackId",
                                    "stemId", "sourceSha256", "frameRate", "hopSamples",
                                    "windowSamples", "windowCenterOffsetSec", "channelMix",
                                    "bandsHz", "units", "display")},
            "scope": "preview",
            "originSec": origin,
            "nFrames": K,
            "durationSec": pv_dur,
            "sourceFrameOffset": i0,
            "frameTime": "t_i = originSec + i / frameRate（整曲时间）；局部位置 p → i = floor((p - delaySec) * frameRate)",
            "stats": {
                "rmsMax": float(rms.max()),
                "rmsMean": float(rms.mean()),
                "silentFrameRatio": float(np.mean(rms < full["display"]["silenceThreshold"])),
            },
            "arrays": sliced,
        }
        atomic_write_json(pv_dir / "features" / f"{sid}.json", doc, separators=(",", ":"))

    # 拍点平移：整曲秒数 − originSec，仅保留预览窗口内的拍点；降级状态原样继承
    if beats_doc is not None:
        local = [round(t - origin, 4) for t in beats_doc["beatsSec"]
                 if origin <= t < origin + pv_dur]
        pv_beats = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "beats",
            "pipelineVersion": PIPELINE_VERSION,
            "trackId": track["id"],
            "scope": "preview",
            "originSec": origin,
            "frameRate": beats_doc["frameRate"],
            "bpm": beats_doc["bpm"],
            "periodSec": beats_doc["periodSec"],
            "beatsSec": local,
            "snapEnabled": beats_doc["snapEnabled"],
            "heuristicScore": beats_doc["heuristicScore"],
            "scoreComponents": beats_doc["scoreComponents"],
            "degradedReason": beats_doc["degradedReason"],
            "downbeats": None,
            "note": "局部拍点 = 整曲拍点 − originSec；播放触发位置 = 局部拍点 + delaySec（见 preview.json）",
        }
    else:
        pv_beats = {
            "schemaVersion": SCHEMA_VERSION, "kind": "beats", "pipelineVersion": PIPELINE_VERSION,
            "trackId": track["id"], "scope": "preview", "originSec": origin,
            "frameRate": track["analysis"]["frameRate"], "bpm": None, "periodSec": None,
            "beatsSec": [], "snapEnabled": False, "heuristicScore": 0.0,
            "scoreComponents": {}, "degradedReason": "beats-missing", "downbeats": None,
            "note": "整曲节拍缺失，预览不伪造拍点",
        }
    atomic_write_json(pv_dir / "beats.json", pv_beats, separators=(",", ":"))

    # 延迟极差只统计 measured 的延迟（uncertain=null 不参与，silent=0 参与）
    delays = [e["delaySamples"] for e in stem_entries.values()
              if e["delayStatus"] == "measured" and e["delaySamples"] is not None]
    doc = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": "preview",
        "pipelineVersion": PIPELINE_VERSION,
        "trackId": track["id"],
        "originSec": origin,
        "durationSec": pv_dur,
        "previewSec": params["previewSec"],
        "startSelection": win["selection"],
        "shortTrackNote": params["shortTrackNote"],
        "frameOffset": win["frameOffset"],
        "codec": "aac",
        "container": "m4a",
        "bitrate": params["bitrate"],
        "sampleRate": sr,
        "channels": track["channels"],
        "delaySpreadSamples": (max(delays) - min(delays)) if delays else 0,
        "stems": stem_entries,
        "upstreamSha256": {
            "features": {s["id"]: s["features"].get("sha256") for s in track["stems"]},
            "beats": manifest["resources"]["beats"].get("sha256"),
            "presets": manifest["resources"]["presets"].get("sha256"),
        },
        "features": {"dir": "features", "frameRate": track["analysis"]["frameRate"],
                     "nFrames": win["nFrames"], "sourceFrameOffset": win["frameOffset"]},
        "beats": {"path": "beats.json"},
        "timeMapping": (
            "整曲时间 = originSec + 局部播放位置 p - delaySec；"
            "特征下标 = clamp(floor((p - delaySec) * frameRate), 0, nFrames-1)；"
            "拍点触发位置 = 局部拍点 + delaySec。delaySec 逐轨见 stems。"
            "delaySec=null（delayStatus=uncertain）表示延迟不确定：前端不做补偿并视为待核验；"
            "delayStatus=silent 为静音轨，delaySec=0。"
        ),
        "memoryNote": "压缩降低传输体积；解码 PCM 内存由预览时长决定（45s×6轨 远低于整曲），与码率无关",
    }
    atomic_write_json(pv_dir / "preview.json", doc, separators=(",", ":"))
    return sync_manifest(out_dir)


def sha256_of(path: Path) -> str:
    from .audio import sha256_file

    return sha256_file(path)


def json_load(path: Path):
    import json

    return json.loads(Path(path).read_text(encoding="utf-8"))