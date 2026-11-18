"""修复轮 2 回归测试：节拍降级崩溃(C) / 上游依赖失效(D) / 源路径缓存(E)。

运行: .venv/Scripts/python.exe -m unittest tests.test_fixes_r2 -v
全部使用合成素材（tempfile），不触碰 separated/ 真实素材。
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline import SCHEMA_VERSION  # noqa: E402
from pipeline.audio import sha256_file  # noqa: E402
from pipeline.beats import DEFAULT_BEAT_PARAMS, estimate_beats, run_beats  # noqa: E402
from pipeline.features import run_features  # noqa: E402
from pipeline.manifest import (  # noqa: E402
    build_manifest,
    load_manifest,
    refresh_audio_paths,
    sync_manifest,
    write_manifest,
)
from pipeline.presets import run_presets  # noqa: E402
from pipeline.preview import run_preview  # noqa: E402

RATE = 44100
SCORE_KEYS = set(DEFAULT_BEAT_PARAMS["scoreWeights"])


# ---- 辅助函数（写法参考 tests/test_pipeline.py，按要求复制到本文件） ----

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


def clicks(dur: float, bpm: float = 120.0) -> np.ndarray:
    period = 60.0 / bpm
    times = list(np.arange(0.2, dur - 0.1, period))
    return pulse_train(dur, times)


def make_stems_dir(parent: Path, specs: dict[str, np.ndarray], rate: int = RATE) -> Path:
    d = parent / "stems"
    d.mkdir(parents=True, exist_ok=True)
    for name, audio in specs.items():
        write_wav(d / f"{name}.wav", audio, rate)
    return d


def _ffmpeg_available() -> bool:
    from pipeline.preview import ffmpeg_exe

    try:
        ffmpeg_exe()
        return True
    except RuntimeError:
        return False


class _TmpCase(unittest.TestCase):
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
        return d, cfg_path

    def _beats_doc(self):
        return json.loads((self.out / "beats.json").read_text(encoding="utf-8"))


class TestDegradedNoCrash(_TmpCase):
    """Bug C：起音不足/极短素材降级不崩，分量齐全，下游阶段可继续。"""

    def test_3s_120bpm_too_few_onsets_then_downstream(self):
        if not _ffmpeg_available():
            self.skipTest("ffmpeg 不可用")
        # 3 秒 120BPM → 6 个 onset < minBeats=8
        self._pipeline({"drums": clicks(3.0, 120.0), "bass": sine(3.0, 110.0, 0.3)})
        run_beats(self.out)  # 修复前此处 KeyError: 'intervalStability'
        b = self._beats_doc()
        self.assertFalse(b["snapEnabled"])
        self.assertEqual(b["degradedReason"], "too-few-onsets")
        self.assertEqual(set(b["scoreComponents"]), SCORE_KEYS)
        self.assertEqual(b["beatsSec"], [])
        # 后续 presets / preview 阶段正常完成（短曲预览取整曲）
        run_presets(self.out)
        run_preview(self.out)
        m = load_manifest(self.out)
        self.assertEqual(m["resources"]["presets"]["status"], "ready")
        pv = json.loads((self.out / "preview/preview.json").read_text(encoding="utf-8"))
        self.assertIsNotNone(pv["shortTrackNote"])
        self.assertAlmostEqual(pv["durationSec"], 3.0, delta=0.01)
        pb = json.loads((self.out / "preview/beats.json").read_text(encoding="utf-8"))
        self.assertFalse(pb["snapEnabled"])
        self.assertEqual(pb["degradedReason"], "too-few-onsets")
        self.assertEqual(set(pb["scoreComponents"]), SCORE_KEYS)

    def test_half_second_degrades_without_crash(self):
        self._pipeline({"drums": clicks(0.5, 120.0)})
        run_beats(self.out)
        b = self._beats_doc()
        self.assertFalse(b["snapEnabled"])
        self.assertEqual(b["degradedReason"], "silence-or-too-short")
        self.assertEqual(set(b["scoreComponents"]), SCORE_KEYS)
        self.assertEqual(b["heuristicScore"], 0.0)

    def test_all_direct_degraded_paths_have_full_components(self):
        from pipeline.beats import beat_params

        params = beat_params({})
        cases = {
            "silence-or-too-short": np.zeros(100, dtype=np.float64),
            "no-variance": np.ones(100, dtype=np.float64),
            "too-short-for-bpm-range": np.random.default_rng(7).random(40),
        }
        for reason, env in cases.items():
            doc = estimate_beats(env, 50.0, params)
            self.assertEqual(doc["degradedReason"], reason)
            self.assertFalse(doc["snapEnabled"])
            self.assertEqual(set(doc["scoreComponents"]), SCORE_KEYS)
            self.assertTrue(all(v == 0.0 for v in doc["scoreComponents"].values()))


class TestUpstreamInvalidation(_TmpCase):
    """Bug D：上游参数/特征变化后，旧下游挂载必须立即 missing。"""

    def test_frame_rate_50_to_25_invalidates_beats(self):
        d, cfg = self._pipeline({"drums": clicks(12.0), "vocals": sine(12.0, 440.0, 0.4)},
                                config={"analysis": {"frameRate": 50}})
        run_beats(self.out)
        self.assertEqual(load_manifest(self.out)["resources"]["beats"]["status"], "ready")
        # 改配置 frameRate=25，重跑 manifest + features
        cfg.write_text(json.dumps({"analysis": {"frameRate": 25}}), encoding="utf-8")
        write_manifest(build_manifest(d, self.out, cfg), self.out)
        run_features(self.out)
        m = load_manifest(self.out)
        self.assertEqual(m["track"]["analysis"]["frameRate"], 25.0)
        self.assertEqual(m["resources"]["beats"]["status"], "missing")  # 旧 50Hz beats 过期
        # 重跑 beats → ready，且绑定新特征哈希
        run_beats(self.out)
        m = load_manifest(self.out)
        self.assertEqual(m["resources"]["beats"]["status"], "ready")
        b = self._beats_doc()
        self.assertEqual(b["frameRate"], 25.0)
        expected = {s["id"]: sha256_file(self.out / "features" / f"{s['id']}.json")
                    for s in m["track"]["stems"]}
        self.assertEqual(b["sourceFeaturesSha256"], expected)

    def test_tampered_beats_fields_go_missing(self):
        self._pipeline({"drums": clicks(12.0)})
        run_beats(self.out)
        path = self.out / "beats.json"
        original = path.read_text(encoding="utf-8")
        doc = json.loads(original)
        # 篡改 sourceFeaturesSha256
        bad = json.loads(original)
        sid = next(iter(bad["sourceFeaturesSha256"]))
        bad["sourceFeaturesSha256"][sid] = "0" * 64
        path.write_text(json.dumps(bad), encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["beats"]["status"], "missing")
        # 篡改 analysisParams
        bad = json.loads(original)
        bad["analysisParams"]["snapThreshold"] = 0.99
        path.write_text(json.dumps(bad), encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["beats"]["status"], "missing")
        # 恢复 → ready（自愈语义不变）
        path.write_text(original, encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["beats"]["status"], "ready")
        self.assertEqual(doc["trackId"], load_manifest(self.out)["track"]["id"])

    def test_tampered_presets_params_go_missing(self):
        self._pipeline({"drums": clicks(6.0), "bass": sine(6.0, 110.0, 0.4)})
        run_presets(self.out)
        path = self.out / "presets.json"
        original = path.read_text(encoding="utf-8")
        bad = json.loads(original)
        bad["params"]["vocalDuckGain"] = 0.9
        path.write_text(json.dumps(bad), encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["presets"]["status"], "missing")
        path.write_text(original, encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["presets"]["status"], "ready")


class TestPreviewUpstreamContract(_TmpCase):
    """Bug D-4：手工构造含 upstreamSha256 的 preview.json 验证挂载校验。

    不依赖并行代理对 preview.py 的改动：契约结构按任务给定固定格式构造。
    """

    def _setup(self):
        self._pipeline({"drums": clicks(12.0), "vocals": sine(12.0, 440.0, 0.4)})
        run_beats(self.out)
        run_presets(self.out)
        self.pv_path = self.out / "preview/preview.json"
        self.pv_path.parent.mkdir(parents=True, exist_ok=True)
        m = load_manifest(self.out)
        self.tid = m["track"]["id"]
        self.up = {
            "features": {s["id"]: sha256_file(self.out / "features" / f"{s['id']}.json")
                         for s in m["track"]["stems"]},
            "beats": sha256_file(self.out / "beats.json"),
            "presets": sha256_file(self.out / "presets.json"),
        }

    def _write_preview(self, up="keep", frame_rate=50.0):
        doc = {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "preview",
            "trackId": self.tid,
            "originSec": 0.0,
            "durationSec": 12.0,
            "features": {"dir": "features", "frameRate": frame_rate},
        }
        if up == "keep":
            doc["upstreamSha256"] = json.loads(json.dumps(self.up))
        elif isinstance(up, dict):
            doc["upstreamSha256"] = up
        self.pv_path.write_text(json.dumps(doc), encoding="utf-8")

    def _status(self):
        return sync_manifest(self.out)["resources"]["preview"]["status"]

    def test_matching_upstream_ready(self):
        self._setup()
        self._write_preview()
        self.assertEqual(self._status(), "ready")

    def test_feature_sha_mismatch_missing(self):
        self._setup()
        up = json.loads(json.dumps(self.up))
        up["features"]["drums"] = "0" * 64
        self._write_preview(up=up)
        self.assertEqual(self._status(), "missing")

    def test_field_absent_missing(self):
        self._setup()
        self._write_preview(up=None)
        self.assertEqual(self._status(), "missing")

    def test_frame_rate_mismatch_missing(self):
        self._setup()
        self._write_preview(frame_rate=25.0)
        self.assertEqual(self._status(), "missing")

    def test_beats_missing_expects_null(self):
        self._setup()
        (self.out / "beats.json").unlink()
        up = json.loads(json.dumps(self.up))
        up["beats"] = None  # beats 缺失 → 契约对应 null
        self._write_preview(up=up)
        m = sync_manifest(self.out)
        self.assertEqual(m["resources"]["beats"]["status"], "missing")
        self.assertEqual(m["resources"]["preview"]["status"], "ready")
        # 仍声称旧 beats sha → missing
        self._write_preview()
        self.assertEqual(self._status(), "missing")


class TestSourceRelocation(_TmpCase):
    """Bug E：源目录迁移后缓存命中，但 manifest 路径必须刷新到新目录。"""

    def test_move_source_keeps_feature_cache_and_fixes_paths(self):
        if not _ffmpeg_available():
            self.skipTest("ffmpeg 不可用")
        specs = {"drums": clicks(35.0, 120.0), "vocals": sine(35.0, 440.0, 0.4)}
        loc_a = self.tmp / "location_a"
        stems_a = make_stems_dir(loc_a, specs)
        from pipeline.build import run_build

        r1 = run_build(stems_a, self.out)
        self.assertTrue(r1["report"]["publishable"], r1["report"]["blocking"])
        old_rel = load_manifest(self.out)["track"]["stems"][0]["audio"]["path"]
        self.assertIn("location_a", old_rel)
        # 源目录整体迁移（旧位置不复存在）
        loc_b = self.tmp / "location_b"
        shutil.move(str(loc_a), str(loc_b))
        stems_b = loc_b / "stems"
        self.assertFalse((self.out / old_rel).exists())

        r2 = run_build(stems_b, self.out)
        self.assertTrue(r2["hits"]["manifest"])
        self.assertTrue(r2["hits"]["features"])  # 昂贵特征按内容哈希继续命中
        m = load_manifest(self.out)
        for s in m["track"]["stems"]:
            p = (self.out / s["audio"]["path"]).resolve()
            self.assertTrue(p.is_file(), s["audio"]["path"])
            self.assertIn("location_b", str(p))
        self.assertTrue(r2["report"]["publishable"], r2["report"]["blocking"])

    def test_refresh_audio_paths_noop_and_sha_guard(self):
        d = make_stems_dir(self.tmp, {"drums": clicks(2.0)})
        write_manifest(build_manifest(d, self.out), self.out)
        self.assertFalse(refresh_audio_paths(self.out, d))  # 路径未变 → 不重写
        # 迁移到新目录 → 刷新
        d2 = self.tmp / "elsewhere" / "stems"
        d2.mkdir(parents=True)
        shutil.move(str(d / "drums.wav"), str(d2 / "drums.wav"))
        self.assertTrue(refresh_audio_paths(self.out, d2))
        base = json.loads((self.out / "manifest.base.json").read_text(encoding="utf-8"))
        rel = base["track"]["stems"][0]["audio"]["path"]
        self.assertTrue((self.out / rel).resolve().is_file())
        self.assertIn("elsewhere", rel)
        # 内容变化（sha 不符）→ 不动路径，交给缓存键流程
        write_wav(d2 / "drums.wav", clicks(2.0, 140.0))
        before = (self.out / "manifest.base.json").read_text(encoding="utf-8")
        d3 = self.tmp / "third" / "stems"
        d3.mkdir(parents=True)
        shutil.move(str(d2 / "drums.wav"), str(d3 / "drums.wav"))
        self.assertFalse(refresh_audio_paths(self.out, d3))
        self.assertEqual((self.out / "manifest.base.json").read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()