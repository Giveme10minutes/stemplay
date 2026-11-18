"""修复轮 1 回归测试：立体声能量/峰值（Bug A）+ AAC 延迟估计（Bug B）。

只用合成素材（tempfile），不对 separated/ 真实素材跑构建。
运行: .venv/Scripts/python.exe -m unittest tests.test_fixes_r1 -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.audio import read_wav_channels, read_wav_mono, sha256_file  # noqa: E402
from pipeline.features import _analysis_params, extract_stem_arrays, run_features  # noqa: E402
from pipeline.manifest import build_manifest, write_manifest  # noqa: E402
from pipeline.presets import run_presets  # noqa: E402
from pipeline.preview import measure_delay  # noqa: E402
from pipeline.report import run_report  # noqa: E402

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


def write_wav_channels(path: Path, data: np.ndarray, rate: int = RATE) -> None:
    """把 (n, ch) float [-1,1] 数组写为 PCM16 WAV（保留声道，不复制）。"""
    data = np.clip(np.asarray(data, dtype=np.float64), -1.0, 1.0)
    if data.ndim == 1:
        data = data[:, None]
    pcm = (data * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
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


def click_track(dur: float, bpm: float, amp: float = 0.8) -> np.ndarray:
    period = 60.0 / bpm
    times = list(np.arange(0.2, dur - 0.1, period))
    return pulse_train(dur, times)


def marked_sine(dur: float, freq: float, amp: float = 0.4) -> np.ndarray:
    """周期正弦 + 2–4s 静音标记（真实包络位移为 0 的可定位素材）。"""
    x = sine(dur, freq, amp)
    x[2 * RATE : 4 * RATE] = 0.0
    return x


def noise_bursts(dur: float = 8.0, seed: int = 7) -> np.ndarray:
    """音乐样素材：多个幅度各异的噪声 burst（非周期、包络有结构）。"""
    rng = np.random.default_rng(seed)
    x = np.zeros(int(dur * RATE), dtype=np.float32)
    for t, amp in [(0.3, 0.5), (1.2, 0.3), (2.5, 0.6), (3.8, 0.25), (5.1, 0.55), (6.4, 0.4)]:
        s, ln = int(t * RATE), int(0.25 * RATE)
        x[s : s + ln] = (amp * rng.standard_normal(ln)).astype(np.float32)
    return x


def make_stems_dir(tmp: Path, specs: dict[str, np.ndarray], rate: int = RATE) -> Path:
    """specs 值可为 1d（复制为立体声）或 (n, ch)（保留声道）。"""
    d = tmp / "stems"
    d.mkdir(parents=True, exist_ok=True)
    for name, audio in specs.items():
        if np.asarray(audio).ndim == 1:
            write_wav(d / f"{name}.wav", audio, rate)
        else:
            write_wav_channels(d / f"{name}.wav", audio, rate)
    return d


def remeasure_channel_peaks(stems_dir: Path, gains: dict[str, float]) -> np.ndarray:
    """测试侧独立实测：按给定增益逐声道混音，返回每声道峰值。"""
    data = {sid: read_wav_channels(stems_dir / f"{sid}.wav").astype(np.float64)
            for sid in gains}
    n, ch = next(iter(data.values())).shape
    mix = np.zeros((n, ch), dtype=np.float64)
    for sid, g in gains.items():
        mix += g * data[sid]
    return np.max(np.abs(mix), axis=0)


class StereoFeatureTests(unittest.TestCase):
    def setUp(self):
        self.params = _analysis_params({})

    def test_antiphase_stereo_energy_not_cancelled(self):
        x = sine(1.0, 440.0, 0.75)
        stereo = np.column_stack([x, -x])
        arrays, meta = extract_stem_arrays(stereo, RATE, self.params)
        rms = arrays["rms"][10:40]  # 避开边缘补零帧
        expected = 0.75 / np.sqrt(2)  # 每声道 RMS = 0.5303
        self.assertAlmostEqual(float(rms.mean()), expected, delta=expected * 0.01)
        self.assertEqual(float(np.mean(arrays["rms"] < 1e-3)), 0.0)  # silentFrameRatio=0
        self.assertEqual(meta["channelMix"], "per-channel-energy-merge")
        # 频带和 ≈ rms²（能量合并保持 Parseval）
        i = slice(10, 40)
        band_sum = float(np.mean(arrays["low"][i] + arrays["mid"][i] + arrays["high"][i]))
        self.assertAlmostEqual(band_sum, float(np.mean(arrays["rms"][i] ** 2)), delta=0.01)
        # 峰值取全声道极值：反相时 peakMin=-0.75, peakMax=+0.75
        self.assertAlmostEqual(float(arrays["peakMax"][25]), 0.75, delta=0.01)
        self.assertAlmostEqual(float(arrays["peakMin"][25]), -0.75, delta=0.01)

    def test_inphase_stereo_equals_mono(self):
        x = sine(1.0, 440.0, 0.5) + 0.3 * sine(1.0, 1000.0, 0.4)
        mono_arrays, _ = extract_stem_arrays(x, RATE, self.params)
        stereo_arrays, _ = extract_stem_arrays(np.column_stack([x, x]), RATE, self.params)
        for k in mono_arrays:
            np.testing.assert_allclose(stereo_arrays[k], mono_arrays[k], atol=1e-9, rtol=1e-9)

    def test_read_wav_channels_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "stereo.wav"
            left, right = sine(0.5, 440.0, 0.5), -sine(0.5, 440.0, 0.5)
            write_wav_channels(p, np.column_stack([left, right]))
            got = read_wav_channels(p)
            self.assertEqual(got.shape, (len(left), 2))
            self.assertEqual(got.dtype, np.float32)
            np.testing.assert_allclose(got[:, 0], left, atol=2.0 / 32767)
            np.testing.assert_allclose(got[:, 1], right, atol=2.0 / 32767)
            # read_wav_mono 保留且仍为均值下混（反相 → 近静音）
            self.assertLess(float(np.max(np.abs(read_wav_mono(p)))), 1e-4)


class PresetPeakTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"
        # 单声道混音完全抵消（L=x,R=-x 两轨同相叠加），但逐声道叠加峰值 1.2 > 0.95
        s = sine(2.0, 440.0, 0.6)
        self.specs = {"vocals": np.column_stack([s, -s]),
                      "drums": np.column_stack([s, -s])}
        self.stems = make_stems_dir(self.tmp, self.specs)
        m = build_manifest(self.stems, self.out)
        write_manifest(m, self.out)
        run_features(self.out)
        run_presets(self.out)
        self.doc = json.loads((self.out / "presets.json").read_text(encoding="utf-8"))

    def tearDown(self):
        self._tmp.cleanup()

    def test_mono_mix_would_cancel(self):
        # 构造有效性：均值下混后两轨都近零——旧方法必然低估
        for sid in self.specs:
            self.assertLess(float(np.max(np.abs(read_wav_mono(self.stems / f"{sid}.wav")))), 1e-4)

    def test_exported_gains_per_channel_peak_within_headroom(self):
        target = self.doc["headroomTarget"]
        for preset in self.doc["presets"]:
            peaks = remeasure_channel_peaks(self.stems, preset["gains"])
            self.assertLessEqual(float(peaks.max()), target + 1e-6, preset["id"])
            self.assertAlmostEqual(preset["busPeak"], float(peaks.max()), delta=0.002)
            self.assertEqual(len(preset["channelPeaks"]), 2)
            self.assertAlmostEqual(preset["busPeak"], max(preset["channelPeaks"]), delta=1e-4)
            np.testing.assert_allclose(preset["channelPeaks"], peaks, atol=0.002)
        full = self.doc["presets"][0]
        self.assertGreater(full["busPeakUnscaled"], 1.1)  # 原始逐声道叠加确实超限
        self.assertLess(full["appliedScale"], 1.0)
        self.assertGreater(full["busPeak"], 0.9)  # 缩放后贴着头寸，不是错误地缩到近零

    def test_stem_peaks_per_channel(self):
        for sid, peak in self.doc["stemPeaks"].items():
            self.assertAlmostEqual(peak, 0.6, delta=0.002)

    def test_report_passes_clean_presets(self):
        report = run_report(self.out)
        check = next(c for c in report["checks"] if c["id"] == "preset-peaks")
        self.assertEqual(check["status"], "pass", check["detail"])

    def test_report_fails_tampered_buspeak(self):
        p = self.out / "presets.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        doc["presets"][0]["busPeak"] = 99.0
        p.write_text(json.dumps(doc), encoding="utf-8")
        report = run_report(self.out)
        self.assertIn("preset-peaks", report["blocking"])

    def test_report_fails_real_overlimit(self):
        # 字段声称合格，但导出增益被改回未缩放值 → 实测超限必须被抓出
        p = self.out / "presets.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        doc["presets"][0]["gains"] = {sid: 1.0 for sid in doc["presets"][0]["gains"]}
        p.write_text(json.dumps(doc), encoding="utf-8")
        report = run_report(self.out)
        self.assertIn("preset-peaks", report["blocking"])
        check = next(c for c in report["checks"] if c["id"] == "preset-peaks")
        self.assertIn("超 headroom", check["detail"])


class DelayMeasureTests(unittest.TestCase):
    def test_silent_track(self):
        src = np.zeros((2 * RATE, 2), dtype=np.float32)
        lag, corr, status = measure_delay(src, src.copy(), RATE)
        self.assertEqual((lag, corr, status), (0, None, "silent"))

    def test_constant_envelope_uncertain(self):
        x = sine(6.0, 440.0, 0.4)
        src = np.column_stack([x, x])
        lag, corr, status = measure_delay(src, src.copy(), RATE)
        self.assertEqual(status, "uncertain")

    def test_periodic_440_marker_no_false_delay(self):
        x = marked_sine(12.0, 440.0)
        for src in (np.column_stack([x, x]), np.column_stack([x, -x])):
            lag, corr, status = measure_delay(src, src.copy(), RATE)
            self.assertTrue(status != "measured" or lag <= 256,
                            f"440Hz 假延迟 {lag} ({status})")
            self.assertNotEqual(status, "silent")  # 反相立体声不得被当成静音

    def test_periodic_220_marker_no_false_delay(self):
        x = marked_sine(12.0, 220.0)
        src = np.column_stack([x, x])
        lag, corr, status = measure_delay(src, src.copy(), RATE)
        self.assertTrue(status != "measured" or lag <= 256,
                        f"220Hz 假延迟 {lag} ({status})")

    def test_music_priming_measured_mono(self):
        x = noise_bursts()
        priming = 1024
        dec = np.concatenate([np.zeros(priming), x, np.zeros(2048)]).astype(np.float32)
        lag, corr, status = measure_delay(x, dec, RATE)
        self.assertEqual(status, "measured")
        self.assertLessEqual(abs(lag - priming), 4)
        self.assertGreater(corr, 0.99)

    def test_music_priming_measured_antiphase_stereo(self):
        x = noise_bursts()
        priming = 1024
        y = np.concatenate([np.zeros(priming), x, np.zeros(2048)]).astype(np.float32)
        src = np.column_stack([x, -x])
        dec = np.column_stack([y, -y])
        lag, corr, status = measure_delay(src, dec, RATE)
        self.assertEqual(status, "measured")
        self.assertLessEqual(abs(lag - priming), 4)


class PreviewBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from pipeline.preview import ffmpeg_exe

        try:
            ffmpeg_exe()
        except RuntimeError:
            raise unittest.SkipTest("ffmpeg 不可用（pip install imageio-ffmpeg）")

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"

    def tearDown(self):
        self._tmp.cleanup()

    def _build(self, specs):
        from pipeline.build import run_build

        stems = make_stems_dir(self.tmp, specs)
        return run_build(stems, self.out), stems

    def test_220hz_marker_build_not_blocked(self):
        result, _ = self._build({"drums": click_track(6.0, 120.0),
                                 "vocals": marked_sine(6.0, 220.0)})
        self.assertTrue(result["report"]["publishable"], result["report"]["blocking"])
        pv = json.loads((self.out / "preview/preview.json").read_text(encoding="utf-8"))
        e = pv["stems"]["vocals"]
        self.assertIn(e["delayStatus"], ("measured", "uncertain"))
        if e["delayStatus"] == "measured":
            self.assertLessEqual(e["delaySamples"], 256)

    def test_uncertain_null_fields_and_upstream_sha(self):
        result, _ = self._build({"drums": click_track(6.0, 120.0),
                                 "vocals": sine(6.0, 440.0, 0.4)})
        self.assertTrue(result["report"]["publishable"], result["report"]["blocking"])
        pv = json.loads((self.out / "preview/preview.json").read_text(encoding="utf-8"))
        e = pv["stems"]["vocals"]
        self.assertEqual(e["delayStatus"], "uncertain")
        self.assertIsNone(e["delaySamples"])
        self.assertIsNone(e["delaySec"])
        self.assertIsNotNone(e["alignmentCorr"])
        self.assertAlmostEqual(e["contentDurationSec"], pv["durationSec"], delta=0.12)
        check = next(c for c in result["report"]["checks"] if c["id"] == "preview-decode")
        self.assertEqual(check["status"], "warn")
        # 跨代理契约：upstreamSha256 取自当时 manifest 挂载
        up = pv["upstreamSha256"]
        for sid in pv["stems"]:
            self.assertEqual(up["features"][sid], sha256_file(self.out / "features" / f"{sid}.json"))
        self.assertEqual(up["beats"], sha256_file(self.out / "beats.json"))
        self.assertEqual(up["presets"], sha256_file(self.out / "presets.json"))
        self.assertIn("待核验", pv["timeMapping"])

    def test_upstream_sha_null_when_beats_presets_missing(self):
        stems = make_stems_dir(self.tmp, {"vocals": sine(2.0, 440.0, 0.4)})
        m = build_manifest(stems, self.out)
        write_manifest(m, self.out)
        run_features(self.out)
        from pipeline.preview import run_preview

        run_preview(self.out)
        pv = json.loads((self.out / "preview/preview.json").read_text(encoding="utf-8"))
        up = pv["upstreamSha256"]
        self.assertIsNone(up["beats"])
        self.assertIsNone(up["presets"])
        self.assertEqual(up["features"]["vocals"], sha256_file(self.out / "features/vocals.json"))

    def test_source_audio_paths_missing_fails(self):
        result, stems = self._build({"drums": click_track(6.0, 120.0),
                                     "vocals": sine(6.0, 440.0, 0.4)})
        self.assertTrue(result["report"]["publishable"])
        (stems / "vocals.wav").unlink()
        report = run_report(self.out)
        self.assertIn("source-audio-paths", report["blocking"])
        self.assertFalse(report["publishable"])


if __name__ == "__main__":
    unittest.main()