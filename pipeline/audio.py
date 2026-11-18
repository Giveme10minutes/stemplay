"""WAV 探测、分块读取与哈希。

样本数据始终以 numpy 紧凑数组处理，绝不展开为 Python 整数序列。
仅支持 PCM WAV（Demucs 默认输出 int16）；float32 WAV 等给出明确错误。
"""
from __future__ import annotations

import hashlib
import wave
from pathlib import Path

import numpy as np


class AudioError(Exception):
    """输入音频缺失、不可读或格式异常。"""


def probe_wav(path: Path) -> dict:
    """读取 WAV 头并校验可读性，返回格式元数据（不解码样本）。"""
    path = Path(path)
    if not path.is_file():
        raise AudioError(f"音频文件不存在: {path}")
    try:
        with wave.open(str(path), "rb") as w:
            if w.getcomptype() != "NONE":
                raise AudioError(f"不支持的 WAV 压缩类型 {w.getcomptype()!r}: {path}")
            width = w.getsampwidth()
            if width not in (1, 2, 3, 4):
                raise AudioError(f"不支持的采样位宽 {width * 8}bit: {path}")
            rate = w.getframerate()
            channels = w.getnchannels()
            frames = w.getnframes()
            if rate <= 0 or channels <= 0:
                raise AudioError(f"WAV 头非法（rate={rate}, channels={channels}）: {path}")
            if frames <= 0:
                raise AudioError(f"WAV 不含任何样本帧: {path}")
            # 头部声明的帧数必须真实可读，防止截断文件静默通过
            w.setpos(frames - 1)
            if len(w.readframes(1)) != width * channels:
                raise AudioError(f"WAV 数据截断（声明 {frames} 帧，末尾不可读）: {path}")
    except wave.Error as e:
        raise AudioError(
            f"无法解析 WAV（可能为 float32/非 PCM 编码，请转换为 PCM16）: {path} ({e})"
        ) from e
    except EOFError as e:
        raise AudioError(f"WAV 数据截断: {path}") from e
    return {
        "format": f"wav-pcm{width * 8}",
        "sampleRate": rate,
        "channels": channels,
        "frames": frames,
        "durationSec": frames / rate,
    }


def sha256_file(path: Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _pcm_to_float32(raw: bytes, width: int, channels: int) -> np.ndarray:
    """把一帧交错的 PCM 字节转为 float32 数组，形状 (帧数, 声道)，范围 [-1, 1]。"""
    if width == 1:
        a = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        a = (a - 128.0) / 128.0
    elif width == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        a = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v & 0x800000, v - 0x1000000, v)
        a = v.astype(np.float32) / 8388608.0
    else:
        raise AudioError(f"不支持的采样位宽: {width * 8}bit")
    return a.reshape(-1, channels)


def read_wav_channels(path: Path, chunk_frames: int = 1 << 20) -> np.ndarray:
    """分块读取整轨，保留声道，返回 float32 紧凑数组，形状 (帧数, 声道)。

    不做任何下混：反相立体声（L=x, R=-x）均值下混会抵消成静音，
    能量/峰值分析必须逐声道进行。269 秒 44.1kHz 立体声 float32 约 95MB。
    """
    meta = probe_wav(path)
    n = meta["frames"]
    channels = meta["channels"]
    width = int(meta["format"].removeprefix("wav-pcm")) // 8
    out = np.empty((n, channels), dtype=np.float32)
    filled = 0
    with wave.open(str(path), "rb") as w:
        while filled < n:
            raw = w.readframes(min(chunk_frames, n - filled))
            got = len(raw) // (width * channels)
            if got == 0:
                raise AudioError(f"WAV 数据截断（读到 {filled}/{n} 帧）: {path}")
            out[filled : filled + got] = _pcm_to_float32(raw, width, channels)
            filled += got
    return out


def read_wav_mono(path: Path, chunk_frames: int = 1 << 20) -> np.ndarray:
    """分块读取整轨并下混为单声道 float32 紧凑数组（均值下混）。

    269 秒 44.1kHz 单声道 float32 约 47MB，远小于 Python 整数元组表示。
    """
    meta = probe_wav(path)
    n = meta["frames"]
    channels = meta["channels"]
    width = int(meta["format"].removeprefix("wav-pcm")) // 8
    out = np.empty(n, dtype=np.float32)
    filled = 0
    with wave.open(str(path), "rb") as w:
        while filled < n:
            raw = w.readframes(min(chunk_frames, n - filled))
            got = len(raw) // (width * channels)
            if got == 0:
                raise AudioError(f"WAV 数据截断（读到 {filled}/{n} 帧）: {path}")
            block = _pcm_to_float32(raw, width, channels)
            out[filled : filled + got] = block.mean(axis=1, dtype=np.float32)
            filled += got
    return out