"""第 5 轮后端：manifest 可选 artwork/artist/album 字段与缓存键绑定。"""
from __future__ import annotations

import json
import subprocess
import unittest
import wave
from pathlib import Path
from tempfile import TemporaryDirectory

import imageio_ffmpeg

from pipeline.artwork import missing_artwork
from pipeline.build import run_build
from pipeline.manifest import build_manifest, sync_manifest, write_manifest
from pipeline.audio import sha256_file

RATE = 22050
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()


def run_ff(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args],
                          capture_output=True, timeout=180)


def write_wav(path: Path, seconds: float = 5.0, freq: float = 440.0) -> None:
    import math

    n = int(RATE * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(
            int(12000 * math.sin(2 * math.pi * freq * i / RATE)).to_bytes(2, "little", signed=True)
            for i in range(n)
        ))


def make_png(path: Path, color: str, w: int = 600, h: int = 400) -> None:
    p = run_ff("-f", "lavfi", "-i", f"color=c={color}:s={w}x{h}:r=1", "-frames:v", "1", str(path))
    assert p.returncode == 0, p.stderr.decode()


def make_mp3(path: Path, wav: Path, cover: Path | None, artist: str | None = "Test Artist",
             album: str | None = "Test Album") -> None:
    args = ["-i", str(wav)]
    if cover is not None:
        args += ["-i", str(cover)]
    args += ["-map", "0:a"]
    if cover is not None:
        args += ["-map", "1:v", "-write_id3v2", "1", "-id3v2_version", "3"]
    if artist:
        args += ["-metadata", f"artist={artist}"]
    if album:
        args += ["-metadata", f"album={album}"]
    args += ["-c:a", "libmp3lame", "-b:a", "96k"]
    if cover is not None:
        args += ["-c:v", "mjpeg"]
    args.append(str(path))
    p = run_ff(*args)
    assert p.returncode == 0, p.stderr.decode()


class ArtworkFieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = TemporaryDirectory()
        root = Path(cls._tmp.name)
        cls.stems = root / "stems"
        cls.stems.mkdir()
        write_wav(cls.stems / "vocals.wav")
        write_wav(cls.stems / "drums.wav", freq=220.0)
        cls.wav = root / "tone.wav"
        write_wav(cls.wav, seconds=2.0)
        cls.cover_red = root / "red.png"
        cls.cover_blue = root / "blue.png"
        make_png(cls.cover_red, "red")
        make_png(cls.cover_blue, "blue")
        cls.mp3_cover = root / "with_cover.mp3"
        cls.mp3_plain = root / "no_cover.mp3"
        make_mp3(cls.mp3_cover, cls.wav, cls.cover_red)
        make_mp3(cls.mp3_plain, cls.wav, None)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def _cfg(self, root: Path, source: str | None) -> Path:
        cfg = root / "cfg.json"
        doc = {"id": "arttest", "title": "art", "license": {"status": "unverified"}}
        if source:
            doc["sourceAudio"] = source
        cfg.write_text(json.dumps(doc), encoding="utf-8")
        return cfg

    def test_ready_fields_and_tags(self):
        with TemporaryDirectory() as td:
            out = Path(td) / "out"
            cfg = self._cfg(Path(td), str(self.mp3_cover))
            m = build_manifest(self.stems, out, cfg)
            art = m["track"]["artwork"]
            self.assertEqual(art["status"], "ready")
            self.assertEqual(art["path"], "artwork/cover.png")
            self.assertEqual(art["mime"], "image/png")
            self.assertGreater(art["width"], 0)
            self.assertLessEqual(art["width"], 512)
            self.assertLessEqual(art["height"], 512)
            on_disk = out / art["path"]
            self.assertTrue(on_disk.is_file())
            self.assertEqual(art["sha256"], sha256_file(on_disk))
            self.assertEqual(m["track"]["artist"], "Test Artist")
            self.assertEqual(m["track"]["album"], "Test Album")

    def test_missing_without_cover_but_tags_parsed(self):
        with TemporaryDirectory() as td:
            out = Path(td) / "out"
            cfg = self._cfg(Path(td), str(self.mp3_plain))
            m = build_manifest(self.stems, out, cfg)
            self.assertEqual(m["track"]["artwork"], missing_artwork())
            self.assertEqual(m["track"]["artist"], "Test Artist")
            self.assertFalse((out / "artwork").exists())

    def test_missing_without_source(self):
        with TemporaryDirectory() as td:
            out = Path(td) / "out"
            cfg = self._cfg(Path(td), None)
            m = build_manifest(self.stems, out, cfg)
            self.assertEqual(m["track"]["artwork"], missing_artwork())
            self.assertIsNone(m["track"]["artist"])
            self.assertIsNone(m["track"]["album"])

    def test_sync_downgrades_deleted_artwork(self):
        with TemporaryDirectory() as td:
            out = Path(td) / "out"
            cfg = self._cfg(Path(td), str(self.mp3_cover))
            write_manifest(build_manifest(self.stems, out, cfg), out)
            self.assertEqual(sync_manifest(out)["track"]["artwork"]["status"], "ready")
            (out / "artwork" / "cover.png").unlink()
            self.assertEqual(sync_manifest(out)["track"]["artwork"]["status"], "missing")


class ArtworkCacheKeyTests(unittest.TestCase):
    """原曲内容进 manifest 缓存键：换封面重跑、无变化命中。"""

    def test_source_change_invalidates_manifest_stage(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            stems = root / "stems"
            stems.mkdir()
            write_wav(stems / "vocals.wav")
            write_wav(stems / "drums.wav", freq=220.0)
            wav = root / "tone.wav"
            write_wav(wav, seconds=2.0)
            src = root / "src.mp3"
            cover = root / "cover.png"
            out = root / "out"
            cfg = root / "cfg.json"
            cfg.write_text(json.dumps(
                {"id": "ck", "license": {"status": "unverified"}, "sourceAudio": "src.mp3"}),
                encoding="utf-8")

            make_png(cover, "red")
            make_mp3(src, wav, cover)
            r1 = run_build(stems, out, cfg)
            sha1 = sha256_file(out / "artwork" / "cover.png")
            self.assertFalse(r1["hits"]["manifest"])

            make_png(cover, "blue")
            make_mp3(src, wav, cover)
            r2 = run_build(stems, out, cfg)
            sha2 = sha256_file(out / "artwork" / "cover.png")
            self.assertNotEqual(sha1, sha2)
            self.assertFalse(r2["hits"]["manifest"])

            r3 = run_build(stems, out, cfg)
            self.assertTrue(r3["hits"]["manifest"])


if __name__ == "__main__":
    unittest.main()
