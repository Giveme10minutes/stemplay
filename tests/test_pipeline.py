"""管线单元测试（合成样本，秒级跑完）。

运行: python -m unittest discover -s tests -t .
真实六轨素材的批量验证走 CLI（见 pipeline/README.md），不在单元测试里跑重活。
"""
from __future__ import annotations

import json
import math
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.audio import AudioError, probe_wav, sha256_file  # noqa: E402
from pipeline.cli import main as cli_main  # noqa: E402
from pipeline.features import extract_stem_arrays, run_features, _analysis_params  # noqa: E402
from pipeline.manifest import build_manifest, load_manifest, write_manifest  # noqa: E402

RATE = 44100


def write_wav(path: Path, mono: np.ndarray, rate: int = RATE, channels: int = 2) -> None:
    """把 float [-1,1] 单声道数组写为 PCM16 WAV（多声道复制）。"""
    data = np.clip(mono, -1.0, 1.0)
    pcm = (data * 32767).astype("<i2")
    if channels > 1:
        pcm = np.repeat(pcm[:, None], channels, axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def sine(dur: float, freq: float = 1000.0, amp: float = 0.5, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(dur * rate)) / rate
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def pulse_train(dur: float, times: list[float], rate: int = RATE) -> np.ndarray:
    x = np.zeros(int(dur * rate), dtype=np.float32)
    burst = (0.8 * np.sin(2 * np.pi * 1000 * np.arange(int(0.005 * rate)) / rate)).astype(np.float32)
    for t in times:
        s = int(t * rate)
        x[s : s + len(burst)] = burst
    return x


def make_stems_dir(tmp: Path, specs: dict[str, np.ndarray], rate: int = RATE) -> Path:
    d = tmp / "stems"
    d.mkdir(parents=True, exist_ok=True)
    for name, audio in specs.items():
        write_wav(d / f"{name}.wav", audio, rate)
    return d


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"

    def tearDown(self):
        self._tmp.cleanup()

    def test_real_six_stems(self):
        stems = REPO / "separated/htdemucs_6s/test_song"
        if not stems.is_dir():
            self.skipTest("真实六轨素材不存在")
        m = build_manifest(stems, self.out)
        self.assertEqual(m["schemaVersion"], 1)
        t = m["track"]
        self.assertEqual([s["id"] for s in t["stems"]],
                         ["vocals", "drums", "bass", "guitar", "piano", "other"])
        self.assertEqual(t["originSec"], 0.0)
        self.assertEqual(t["model"]["name"], "htdemucs_6s")
        self.assertFalse(t["license"]["publicDeployAllowed"])
        for kind in ("beats", "presets", "preview"):
            self.assertEqual(m["resources"][kind], {"status": "missing", "path": None})
        for s in t["stems"]:
            a = s["audio"]
            self.assertEqual(a["sampleRate"], 44100)
            self.assertEqual(a["channels"], 2)
            self.assertGreater(a["frames"], 0)
            self.assertAlmostEqual(a["durationSec"], a["frames"] / a["sampleRate"], places=5)
            self.assertEqual(s["features"], {"status": "missing", "path": None})
            resolved = (self.out / a["path"]).resolve()
            self.assertTrue(resolved.is_file())
            self.assertEqual(resolved, (stems / f"{s['id']}.wav").resolve())
        # 哈希抽验一轨
        s0 = t["stems"][0]
        self.assertEqual(s0["audio"]["sha256"], sha256_file(stems / f"{s0['id']}.wav"))
        # 所有轨道帧数一致
        self.assertEqual(len({s["audio"]["frames"] for s in t["stems"]}), 1)

    def test_missing_dir_fails(self):
        with self.assertRaises(AudioError):
            build_manifest(self.tmp / "nope", self.out)
        self.assertEqual(cli_main(["manifest", "--stems", str(self.tmp / "nope"),
                                   "--out", str(self.out)]), 1)

    def test_cli_process_exit_code(self):
        r = subprocess.run(
            [sys.executable, "-m", "pipeline", "manifest",
             "--stems", str(self.tmp / "nope"), "--out", str(self.out)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=REPO,
        )
        self.assertEqual(r.returncode, 1)
        self.assertIn("错误", r.stderr)

    def test_empty_dir_fails(self):
        d = self.tmp / "empty"
        d.mkdir()
        with self.assertRaises(AudioError):
            build_manifest(d, self.out)

    def test_length_mismatch_fails(self):
        d = make_stems_dir(self.tmp, {"vocals": sine(1.0), "drums": sine(1.5)})
        with self.assertRaises(AudioError) as ctx:
            build_manifest(d, self.out)
        self.assertIn("frames", str(ctx.exception))

    def test_rate_mismatch_fails(self):
        d = self.tmp / "stems"
        d.mkdir()
        write_wav(d / "vocals.wav", sine(1.0), rate=44100)
        write_wav(d / "drums.wav", sine(1.0), rate=48000)
        with self.assertRaises(AudioError) as ctx:
            build_manifest(d, self.out)
        self.assertIn("sampleRate", str(ctx.exception))

    def test_truncated_wav_fails(self):
        d = make_stems_dir(self.tmp, {"vocals": sine(1.0)})
        p = d / "vocals.wav"
        p.write_bytes(p.read_bytes()[: len(p.read_bytes()) // 2])
        with self.assertRaises(AudioError):
            build_manifest(d, self.out)

    def test_float_wav_fails_clearly(self):
        d = self.tmp / "stems"
        d.mkdir()
        # 手工构造 format=3 (IEEE float) 的 WAV 头
        fmt = struct.pack("<HHIIHH", 3, 1, RATE, RATE * 4, 4, 32)
        data = b"\x00\x00\x00\x00" * 100
        riff = b"fmt " + struct.pack("<I", len(fmt)) + fmt
        riff += b"data" + struct.pack("<I", len(data)) + data
        (d / "vocals.wav").write_bytes(b"RIFF" + struct.pack("<I", len(riff) + 4) + b"WAVE" + riff)
        with self.assertRaises(AudioError) as ctx:
            build_manifest(d, self.out)
        self.assertIn("PCM", str(ctx.exception))

    def test_config_overrides_and_license(self):
        d = make_stems_dir(self.tmp, {"vocals": sine(0.5), "drums": sine(0.5)})
        cfg = self.tmp / "track.json"
        cfg.write_text(json.dumps({
            "id": "My Song!", "title": "我的歌",
            "license": {"status": "confirmed", "spdx": "CC-BY-4.0", "source": "freemusicarchive"},
            "model": {"name": "htdemucs_6s", "version": "4.1.0"},
        }), encoding="utf-8")
        m = build_manifest(d, self.out, cfg)
        self.assertEqual(m["track"]["id"], "my-song")
        self.assertEqual(m["track"]["title"], "我的歌")
        self.assertTrue(m["track"]["license"]["publicDeployAllowed"])
        self.assertEqual(m["track"]["model"]["version"], "4.1.0")
        # 未确认授权即使填了 spdx 也不允许公开
        cfg.write_text(json.dumps({"license": {"status": "unverified", "spdx": "CC-BY-4.0"}}),
                       encoding="utf-8")
        m = build_manifest(d, self.out, cfg)
        self.assertFalse(m["track"]["license"]["publicDeployAllowed"])

    def test_unknown_stem_discovered(self):
        d = make_stems_dir(self.tmp, {"vocals": sine(0.5), "synth_lead": sine(0.5)})
        m = build_manifest(d, self.out)
        self.assertEqual([s["id"] for s in m["track"]["stems"]], ["vocals", "synth_lead"])


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"
        self.params = _analysis_params({})

    def tearDown(self):
        self._tmp.cleanup()

    def _run_pipeline(self, specs: dict[str, np.ndarray]) -> dict:
        d = make_stems_dir(self.tmp, specs)
        m = build_manifest(d, self.out)
        write_manifest(m, self.out)
        return run_features(self.out)

    def _load_feat(self, stem: str) -> dict:
        return json.loads((self.out / "features" / f"{stem}.json").read_text(encoding="utf-8"))

    def test_silence(self):
        self._run_pipeline({"vocals": np.zeros(RATE, dtype=np.float32)})
        f = self._load_feat("vocals")
        for key, arr in f["arrays"].items():
            self.assertTrue(all(v == 0.0 for v in arr), key)
            self.assertTrue(all(math.isfinite(v) for v in arr), key)
        self.assertEqual(f["stats"]["silentFrameRatio"], 1.0)
        self.assertGreater(f["display"]["rmsRef"], 0)  # 全静音时 ref 兜底，不除零
        self.assertEqual(f["nFrames"], 50)

    def test_pulse_timing_and_bands(self):
        self._run_pipeline({"drums": pulse_train(3.0, [0.5, 1.5])})
        f = self._load_feat("drums")
        self.assertEqual(f["frameRate"], 50.0)
        self.assertEqual(f["hopSamples"], 882)
        self.assertEqual(f["windowCenterOffsetSec"], 0.0)
        self.assertEqual(f["originSec"], 0.0)
        onset = np.array(f["arrays"]["onset"])
        rms = np.array(f["arrays"]["rms"])
        # 起音位置：已知脉冲 0.5s/1.5s → 帧 25/75，中心窗对称无系统偏移，容差 ±2 帧
        peaks = np.argsort(onset)[-4:]
        for t, expected in [(0.5, 25), (1.5, 75)]:
            self.assertTrue(any(abs(int(p) - expected) <= 2 for p in peaks),
                            f"{t}s 脉冲起音不在帧 {expected}±2，实际最强帧 {peaks}")
            self.assertGreater(rms[expected], 0.05)
        self.assertLess(rms[0], 1e-3)          # 开头静音
        self.assertLess(onset[0], 1e-9)        # 首帧不伪造起音
        # 1kHz 脉冲能量应落在 mid 频带
        i = 25
        self.assertGreater(f["arrays"]["mid"][i], f["arrays"]["low"][i] * 20)
        self.assertGreater(f["arrays"]["mid"][i], f["arrays"]["high"][i] * 20)
        self.assertAlmostEqual(f["arrays"]["peakMax"][i], 0.8, delta=0.02)
        # 时间换算: t_i = i / frameRate
        self.assertAlmostEqual(25 / f["frameRate"], 0.5, places=6)

    def test_short_audio(self):
        self._run_pipeline({"vocals": sine(0.02)})  # 882 样本 = 1 hop
        f = self._load_feat("vocals")
        self.assertEqual(f["nFrames"], 1)
        self.assertTrue(all(math.isfinite(v) for v in f["arrays"]["rms"]))

    def test_tail_partial_window(self):
        n = RATE + 400  # 末尾不足一窗
        self._run_pipeline({"vocals": sine(n / RATE)})
        f = self._load_feat("vocals")
        self.assertEqual(f["nFrames"], math.ceil(n / 882))
        self.assertTrue(all(math.isfinite(v) for arr in f["arrays"].values() for v in arr))

    def test_band_parseval_sine(self):
        mono = sine(1.0, 1000.0, 0.5)
        arrays, meta = extract_stem_arrays(mono, RATE, self.params)
        i = slice(10, 40)  # 避开边缘补零帧
        rms2 = float(np.mean(arrays["rms"][i] ** 2))
        mid = float(np.mean(arrays["mid"][i]))
        self.assertAlmostEqual(rms2, 0.5 ** 2 / 2, delta=0.01)
        self.assertAlmostEqual(mid / rms2, 1.0, delta=0.03)  # 频带和 ≈ rms²
        self.assertLess(float(np.mean(arrays["low"][i] + arrays["high"][i])), mid * 0.02)
        self.assertAlmostEqual(float(np.mean(arrays["rms"][i])), 0.5 / math.sqrt(2), delta=0.01)

    def test_shared_display_no_per_stem_boost(self):
        self._run_pipeline({"vocals": sine(2.0, amp=0.5), "other": sine(2.0, amp=0.01)})
        loud, quiet = self._load_feat("vocals"), self._load_feat("other")
        self.assertEqual(loud["display"], quiet["display"])  # 全轨共享同一组参数
        ref = quiet["display"]["rmsRef"]
        quiet_display = max(quiet["arrays"]["rms"]) / ref
        self.assertLess(quiet_display, 0.1)  # 弱音/串音不被单独拉满
        self.assertGreater(max(loud["arrays"]["rms"]) / ref, 0.8)

    def test_manifest_mounts_and_integrity(self):
        m = self._run_pipeline({"vocals": sine(1.0), "drums": pulse_train(1.0, [0.3])})
        for s in m["track"]["stems"]:
            mount = s["features"]
            self.assertEqual(mount["status"], "ready")
            p = self.out / mount["path"]
            self.assertTrue(p.is_file())
            self.assertEqual(mount["sha256"], sha256_file(p))
            self.assertEqual(mount["nFrames"], 50)
        for kind in ("beats", "presets", "preview"):
            self.assertEqual(m["resources"][kind]["status"], "missing")
        self.assertIn("display", m["track"]["analysis"])
        # manifest 落盘后可回读
        self.assertEqual(load_manifest(self.out)["track"]["id"], m["track"]["id"])

    def test_source_change_detected(self):
        d = make_stems_dir(self.tmp, {"vocals": sine(1.0)})
        m = build_manifest(d, self.out)
        write_manifest(m, self.out)
        write_wav(d / "vocals.wav", sine(1.0, amp=0.9))  # 篡改源音频
        with self.assertRaises(RuntimeError):
            run_features(self.out)

    def test_json_has_no_nan_literals(self):
        self._run_pipeline({"vocals": np.zeros(RATE, dtype=np.float32)})
        text = (self.out / "features/vocals.json").read_text(encoding="utf-8")
        for bad in ("NaN", "Infinity"):
            self.assertNotIn(bad, text)


class CompatTests(unittest.TestCase):
    def test_old_make_peaks_still_runs(self):
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            d = make_stems_dir(tmp, {"vocals": sine(0.5), "drums": sine(0.5)})
            out = tmp / "peaks.json"
            r = subprocess.run([sys.executable, str(REPO / "scripts/make_peaks.py"),
                                str(d), str(out)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(out.read_text())
            self.assertEqual(set(data), {"vocals", "drums"})
            self.assertEqual(data["vocals"]["rate"], RATE)
            self.assertAlmostEqual(data["vocals"]["duration"], 0.5, places=2)
            self.assertEqual(len(data["vocals"]["peaks"]), 50)  # 25 桶 × min/max


if __name__ == "__main__":
    unittest.main()