"""第 3、4 轮测试：节拍/预设/预览/缓存/质检/发布（合成样本为主，秒级）。

运行: python -m unittest discover -s tests -t .
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.beats import run_beats  # noqa: E402
from pipeline.features import run_features  # noqa: E402
from pipeline.manifest import build_manifest, load_manifest, write_manifest  # noqa: E402
from pipeline.presets import run_presets  # noqa: E402
from tests.test_pipeline import RATE, make_stems_dir, pulse_train, sine  # noqa: E402


def click_track(dur: float, bpm: float, amp: float = 0.8) -> np.ndarray:
    period = 60.0 / bpm
    times = list(np.arange(0.2, dur - 0.1, period))
    return pulse_train(dur, times)


class BeatsPresetsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"

    def tearDown(self):
        self._tmp.cleanup()

    def _pipeline(self, specs, config=None):
        d = make_stems_dir(self.tmp, specs)
        cfg_path = None
        if config is not None:
            cfg_path = self.tmp / "track.json"
            cfg_path.write_text(json.dumps(config), encoding="utf-8")
        m = build_manifest(d, self.out, cfg_path)
        write_manifest(m, self.out)
        run_features(self.out)
        return m

    def _beats(self):
        run_beats(self.out)
        return json.loads((self.out / "beats.json").read_text(encoding="utf-8"))

    def test_known_bpm_click_track(self):
        self._pipeline({"drums": click_track(12.0, 120.0), "bass": sine(12.0, 110.0, 0.3)})
        b = self._beats()
        self.assertTrue(b["snapEnabled"], b["degradedReason"])
        self.assertAlmostEqual(b["bpm"], 120.0, delta=3.0)
        beats = np.array(b["beatsSec"])
        self.assertGreaterEqual(len(beats), 20)
        iv = np.diff(beats)
        self.assertAlmostEqual(float(np.median(iv)), 0.5, delta=0.06)
        self.assertGreater(b["heuristicScore"], 0.55)
        self.assertIsNone(b["downbeats"])  # 不标注重拍
        # 拍点相对 originSec，且与已知脉冲时刻对齐（0.2s 起每 0.5s）
        expected = np.arange(0.2, 11.9, 0.5)
        d = np.abs(beats[:, None] - expected[None, :]).min(axis=1)
        self.assertGreater(float((d < 0.08).mean()), 0.9)

    def test_silence_degrades(self):
        self._pipeline({"drums": np.zeros(RATE * 4, dtype=np.float32),
                        "vocals": np.zeros(RATE * 4, dtype=np.float32)})
        b = self._beats()
        self.assertFalse(b["snapEnabled"])
        self.assertEqual(b["beatsSec"], [])
        self.assertIsNone(b["bpm"])
        self.assertEqual(b["degradedReason"], "silence-or-too-short")

    def test_irregular_clicks_degrade(self):
        rng = np.random.default_rng(42)
        times = np.sort(rng.uniform(0.2, 11.8, 40))
        times = times[np.diff(np.concatenate(([0], times))) > 0.12]
        self._pipeline({"drums": pulse_train(12.0, list(times))})
        b = self._beats()
        self.assertFalse(b["snapEnabled"])
        self.assertLess(b["heuristicScore"], 0.55)

    def test_config_override_threshold(self):
        self._pipeline({"drums": click_track(12.0, 120.0)},
                       config={"analysis": {"beats": {"snapThreshold": 0.99}}})
        b = self._beats()
        self.assertFalse(b["snapEnabled"])  # 阈值覆盖 → 降级
        self.assertEqual(b["analysisParams"]["snapThreshold"], 0.99)

    def test_librosa_crosscheck(self):
        try:
            import librosa
        except ImportError:
            self.skipTest("librosa 未安装（可选交叉验证）")
        self._pipeline({"drums": click_track(12.0, 120.0)})
        b = self._beats()
        f = json.loads((self.out / "features/drums.json").read_text(encoding="utf-8"))
        env = np.array(f["arrays"]["onset"])
        lb, lbf = librosa.beat.beat_track(onset_envelope=env, sr=50, hop_length=1,
                                          units="frames", tightness=100)
        self.assertAlmostEqual(b["bpm"], float(np.atleast_1d(lb)[0]), delta=4.0)
        mine, theirs = np.array(b["beatsSec"]), lbf / 50
        d = np.abs(mine[:, None] - theirs[None, :]).min(axis=1)
        self.assertGreater(float((d < 0.1).mean()), 0.85)

    def test_presets_distinct_and_headroom(self):
        self._pipeline({"vocals": sine(4.0, 440.0, 0.6), "drums": click_track(4.0, 120.0),
                        "bass": sine(4.0, 110.0, 0.5), "other": sine(4.0, 330.0, 0.3)})
        run_presets(self.out)
        p = json.loads((self.out / "presets.json").read_text(encoding="utf-8"))
        self.assertEqual(p["presetIds"], ["full", "vocal", "rhythm"])
        full, vocal, rhythm = p["presets"]
        self.assertTrue(all(x["busPeak"] <= p["headroomTarget"] + 1e-6 for x in p["presets"]))
        # 三套有明确差别
        self.assertNotEqual(full["gains"], vocal["gains"])
        self.assertNotEqual(full["gains"], rhythm["gains"])
        self.assertGreater(vocal["gains"]["vocals"], vocal["gains"]["other"])
        self.assertGreater(rhythm["gains"]["drums"], rhythm["gains"]["other"])
        self.assertAlmostEqual(rhythm["gains"]["drums"] / rhythm["gains"]["bass"],
                               1.0 / 0.9, delta=1e-3)  # 统一缩放保持声部比例
        self.assertTrue(all(not m for x in p["presets"] for m in x["muted"].values()))
        self.assertIn("setTargetAtTime", p["frontendScheduling"])

    def test_presets_missing_focus_degrades(self):
        self._pipeline({"drums": click_track(4.0, 120.0), "bass": sine(4.0, 110.0, 0.4)})
        run_presets(self.out)
        p = json.loads((self.out / "presets.json").read_text(encoding="utf-8"))
        vocal = next(x for x in p["presets"] if x["id"] == "vocal")
        full = next(x for x in p["presets"] if x["id"] == "full")
        self.assertTrue(vocal["degradedToFull"])
        self.assertEqual(vocal["gains"], full["gains"])
        self.assertNotIn("vocals", vocal["gains"])  # 缺失轨兼容

    def test_presets_config_override(self):
        self._pipeline({"vocals": sine(4.0, 440.0, 0.5), "other": sine(4.0, 330.0, 0.3)},
                       config={"analysis": {"presets": {"vocalDuckGain": 0.5}}})
        run_presets(self.out)
        p = json.loads((self.out / "presets.json").read_text(encoding="utf-8"))
        vocal = next(x for x in p["presets"] if x["id"] == "vocal")
        ratio = vocal["gains"]["other"] / vocal["gains"]["vocals"]
        self.assertAlmostEqual(ratio, 0.5, delta=1e-3)

    def test_manifest_mounts(self):
        self._pipeline({"drums": click_track(6.0, 120.0), "vocals": sine(6.0, 440.0, 0.4)})
        run_beats(self.out)
        run_presets(self.out)
        m = load_manifest(self.out)
        from pipeline.audio import sha256_file
        for kind in ("beats", "presets"):
            mount = m["resources"][kind]
            self.assertEqual(mount["status"], "ready")
            self.assertEqual(mount["sha256"], sha256_file(self.out / mount["path"]))
        self.assertEqual(m["resources"]["preview"]["status"], "missing")
        self.assertIn("bpm", m["resources"]["beats"])
        self.assertIn("snapEnabled", m["resources"]["beats"])


class BuildTests(unittest.TestCase):
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
        self.stems = make_stems_dir(self.tmp, {
            "drums": click_track(12.0, 120.0), "vocals": sine(12.0, 440.0, 0.4),
        })

    def tearDown(self):
        self._tmp.cleanup()

    def _build(self, **kw):
        from pipeline.build import run_build

        return run_build(self.stems, self.out, **kw)

    def test_build_publish_and_alignment(self):
        result = self._build()
        self.assertTrue(result["report"]["publishable"], result["report"]["blocking"])
        cur = result["current"]
        self.assertIsNotNone(cur)
        rel = self.out / cur["release"]
        for name in ("manifest.json", "beats.json", "presets.json", "report.json",
                     "preview/preview.json", "preview/beats.json",
                     "preview/drums.m4a", "preview/vocals.m4a",
                     "preview/features/drums.json", "features/drums.json"):
            self.assertTrue((rel / name).is_file(), name)
        self.assertEqual(cur["whitelist"], [])  # 授权未确认 → 白名单为空
        self.assertFalse(cur["publicDeployAllowed"])
        pv = json.loads((rel / "preview/preview.json").read_text(encoding="utf-8"))
        self.assertIsNotNone(pv["shortTrackNote"])  # 12s 短曲取整曲
        self.assertEqual(pv["originSec"], 0.0)
        # 切片一致 + 网格吸附
        i0, K = pv["frameOffset"], pv["features"]["nFrames"]
        full = json.loads((self.out / "features/drums.json").read_text(encoding="utf-8"))
        pvf = json.loads((rel / "preview/features/drums.json").read_text(encoding="utf-8"))
        for k in full["arrays"]:
            self.assertEqual(pvf["arrays"][k], full["arrays"][k][i0:i0 + K])
        self.assertEqual(pvf["display"], full["display"])
        fr = pv["features"]["frameRate"]
        self.assertAlmostEqual(pv["originSec"] * fr, round(pv["originSec"] * fr), places=6)
        # 解码回检字段齐全
        for e in pv["stems"].values():
            self.assertTrue(e["decodeVerified"])
            if e.get("delayStatus") == "uncertain":
                self.assertIsNone(e["delaySamples"])  # 不确定不写错误补偿值
            else:
                self.assertLessEqual(e["delaySamples"], 8192)
            self.assertAlmostEqual(e["contentDurationSec"], pv["durationSec"], delta=0.12)
        # release manifest 音频路径重写后仍可解析到源
        m = json.loads((rel / "manifest.json").read_text(encoding="utf-8"))
        self.assertTrue((rel / m["track"]["stems"][0]["audio"]["path"]).resolve().is_file())

    def test_rerun_all_cache_hits(self):
        self._build()
        result = self._build()
        self.assertTrue(all(result["hits"].values()), result["hits"])
        self.assertTrue(result["report"]["publishable"])

    def test_fail_at_and_recovery(self):
        with self.assertRaises(RuntimeError):
            self._build(fail_at="preview")
        self.assertFalse((self.out / ".cache/preview.json").exists())  # 缓存未写
        result = self._build()  # 失败重跑
        self.assertTrue(result["report"]["publishable"])
        self.assertTrue(result["hits"]["features"])   # 上游命中
        self.assertFalse(result["hits"]["preview"])   # 失败阶段重算

    def test_corrupted_artifact_selfheal(self):
        self._build()
        victim = self.out / "preview/drums.m4a"
        data = bytearray(victim.read_bytes())
        data[len(data) // 2] ^= 0xFF
        victim.write_bytes(bytes(data))
        result = self._build()
        self.assertFalse(result["hits"]["preview"])  # 完整性校验发现损坏 → 重算
        self.assertTrue(result["report"]["publishable"])

    def test_preview_only_requires_upstream(self):
        with self.assertRaises(RuntimeError):
            self._build(preview_only=True)

    def test_preview_only_param_change(self):
        self._build()
        result = self._build(preview_only=True, preview_overrides={"bitrate": "96k"})
        self.assertTrue(result["hits"]["features"])
        self.assertFalse(result["hits"]["preview"])  # 参数变化 → 预览键失效
        self.assertTrue(result["report"]["publishable"])
        pv = json.loads((self.out / "preview/preview.json").read_text(encoding="utf-8"))
        self.assertEqual(pv["bitrate"], "96k")

    def test_report_blocks_publish(self):
        from pipeline.publish import publish
        from pipeline.report import run_report

        self._build()
        p = self.out / "presets.json"
        doc = json.loads(p.read_text(encoding="utf-8"))
        doc["presets"][0]["busPeak"] = 99.0  # 人为制造超限
        p.write_text(json.dumps(doc), encoding="utf-8")
        report = run_report(self.out)
        self.assertFalse(report["publishable"])
        self.assertIn("preset-peaks", report["blocking"])
        with self.assertRaises(RuntimeError):
            publish(self.out, report)

    def test_confirmed_license_whitelist(self):
        cfg = self.tmp / "track.json"
        cfg.write_text(json.dumps({
            "license": {"status": "confirmed", "spdx": "CC-BY-4.0", "source": "test"},
        }), encoding="utf-8")
        result = self._build(config=cfg)
        self.assertTrue(result["current"]["publicDeployAllowed"])
        self.assertIn("manifest.json", result["current"]["whitelist"])
        self.assertIn("preview/drums.m4a", result["current"]["whitelist"])

    def test_preview_params_validation(self):
        from pipeline.preview import preview_params

        with self.assertRaises(ValueError):
            preview_params({"durationSec": 200.0}, {"previewSec": 20.0})
        with self.assertRaises(ValueError):
            preview_params({"durationSec": 200.0}, {"bitrate": "999k"})
        short = preview_params({"durationSec": 12.0}, {"previewSec": 40.0})
        self.assertEqual(short["previewSec"], 12.0)
        self.assertIsNotNone(short["shortTrackNote"])
        ok = preview_params({"durationSec": 200.0}, {"previewSec": 45.0})
        self.assertEqual(ok["previewSec"], 45.0)


if __name__ == "__main__":
    unittest.main()