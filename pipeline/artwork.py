"""可选封面/曲目元数据：从原曲读取内嵌封面与 tags（第 5 轮后端补充）。

取图必须来自原音频：Demucs 导出的分轨 WAV 不保证保留专辑图。
读取失败一律 missing（规格要求），不阻塞没有封面的歌曲。
缩略图统一重编码为 PNG（≤512px），保证 mime/尺寸/sha 稳定可缓存。
"""
from __future__ import annotations

import re
import struct
import subprocess
from pathlib import Path

from .audio import sha256_file

MAX_SIDE = 512

_TAG_RE = re.compile(r"^\s{2,}(artist|album)\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)


def missing_artwork() -> dict:
    return {"status": "missing", "path": None, "mime": None,
            "width": None, "height": None, "sha256": None}


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def _probe(source: Path) -> str:
    """ffmpeg -i 的 stderr 含流与 tags；无输出文件时退出码非 0 属正常。"""
    proc = subprocess.run(
        [_ffmpeg(), "-hide_banner", "-i", str(source)],
        capture_output=True, timeout=120,
    )
    return proc.stderr.decode("utf-8", "replace")


def parse_tags(info: str) -> dict:
    tags: dict = {"artist": None, "album": None}
    for m in _TAG_RE.finditer(info):
        tags[m.group(1).lower()] = m.group(2)
    return tags


def has_video_stream(info: str) -> bool:
    return re.search(r"Stream #\d+:\d+.*: Video:", info) is not None


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    w, h = struct.unpack(">II", data[16:24])
    return int(w), int(h)


def extract_artwork(source: Path, out_dir: Path) -> dict:
    """解析原曲内嵌封面 → out_dir/artwork/cover.png；任何失败返回 missing。"""
    try:
        if not source.is_file():
            return missing_artwork()
        info = _probe(source)
        if not has_video_stream(info):
            return missing_artwork()
        art_dir = Path(out_dir) / "artwork"
        art_dir.mkdir(parents=True, exist_ok=True)
        dest = art_dir / "cover.png"
        vf = f"scale='min({MAX_SIDE},iw)':'min({MAX_SIDE},ih)':force_original_aspect_ratio=decrease"
        proc = subprocess.run(
            [_ffmpeg(), "-y", "-hide_banner", "-loglevel", "error",
             "-i", str(source), "-map", "0:v:0", "-frames:v", "1",
             "-vf", vf, "-c:v", "png", str(dest)],
            capture_output=True, timeout=180,
        )
        if proc.returncode != 0 or not dest.is_file():
            return missing_artwork()
        w, h = png_size(dest)
        return {
            "status": "ready",
            "path": "artwork/cover.png",
            "mime": "image/png",
            "width": w,
            "height": h,
            "sha256": sha256_file(dest),
        }
    except (subprocess.SubprocessError, OSError, struct.error, ValueError):
        return missing_artwork()
