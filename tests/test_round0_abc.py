"""第 0 轮收口回归：A 预设绑定源音频 SHA / B 迁移后连续 preview_only / C 发布复用指纹。

对应用户实测复现的三个问题（build/verify_abc.py）：
A. 振幅 0.1→0.9 只重跑 manifest/features 后，旧 presets 仍挂 ready（busPeak 失真）。
B. 源目录迁移后 refresh_audio_paths 重写 base，但缓存清单摘要未同步 →
   第二次 preview_only 报"上游阶段 [manifest] 缓存无效"。
C. 固定同秒 + 报告逐字节相同 → 复用旧 release，current 包内 manifest 指向已不存在的源。

只用合成素材/临时目录，不触碰 separated/ 真实素材。
运行: .venv/Scripts/python.exe -m unittest tests.test_round0_abc -v
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
import wave
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.build import run_build  # noqa: E402
from pipeline.features import run_features  # noqa: E402
from pipeline.manifest import build_manifest, load_manifest, sync_manifest, write_manifest  # noqa: E402
from pipeline.presets import run_presets  # noqa: E402
from pipeline.publish import publish  # noqa: E402

RATE = 22050
FROZEN = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)


def frozen_datetime():
    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return FROZEN
    return _Frozen


def write_wav(path: Path, mono: np.ndarray, rate: int = RATE, channels: int = 2) -> None:
    data = np.clip(mono, -1.0, 1.0)
    pcm = (data * 32767).astype("<i2")
    if channels > 1:
        pcm = np.repeat(pcm[:, None], channels, axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def mod_sine(dur: float, freq: float, amp: float, rate: int = RATE) -> np.ndarray:
    """带 0.5Hz 幅度包络的正弦：有结构，延迟测量/能量选段均可工作。"""
    t = np.arange(int(dur * rate)) / rate
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.5 * t)
    return (amp * env * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def make_stems(stems_dir: Path, dur: float, amp: float) -> None:
    stems_dir.mkdir(parents=True, exist_ok=True)
    write_wav(stems_dir / "vocals.wav", mod_sine(dur, 440.0, amp))
    write_wav(stems_dir / "drums.wav", mod_sine(dur, 220.0, amp))


class PresetShaBindingTests(unittest.TestCase):
    """A：presets.json 必须绑定源音频 SHA，输入变化立即 missing。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.stems = self.tmp / "stems"
        self.out = self.tmp / "build"
        make_stems(self.stems, dur=4.0, amp=0.1)
        write_manifest(build_manifest(self.stems, self.out), self.out)
        run_features(self.out)
        run_presets(self.out)

    def tearDown(self):
        self._tmp.cleanup()

    def _presets_doc(self) -> dict:
        return json.loads((self.out / "presets.json").read_text(encoding="utf-8"))

    def test_presets_doc_binds_source_audio_sha(self):
        manifest = sync_manifest(self.out)
        self.assertEqual(manifest["resources"]["presets"]["status"], "ready")
        doc = self._presets_doc()
        expected = {s["id"]: s["audio"]["sha256"] for s in manifest["track"]["stems"]}
        self.assertEqual(doc.get("sourceAudioSha256"), expected)

    def test_amplitude_change_invalidates_then_rebuilds(self):
        # 用户场景：振幅 0.1→0.9，只重跑 manifest/features，不重跑 presets
        make_stems(self.stems, dur=4.0, amp=0.9)
        write_manifest(build_manifest(self.stems, self.out), self.out)
        run_features(self.out)
        manifest = sync_manifest(self.out)
        self.assertEqual(manifest["resources"]["presets"]["status"], "missing",
                         "源音频变化后旧预设必须立即 missing，不得继续 ready")
        # 重跑 presets → ready，且峰值反映新振幅（0.9×2 轨同相叠加 ≈1.8，缩放后 ≤0.95）
        run_presets(self.out)
        manifest = sync_manifest(self.out)
        self.assertEqual(manifest["resources"]["presets"]["status"], "ready")
        doc = self._presets_doc()
        full = next(p for p in doc["presets"] if p["id"] == "full")
        self.assertGreater(full["busPeakUnscaled"], 1.0)
        for p in doc["presets"]:
            self.assertLessEqual(p["busPeak"], doc["headroomTarget"])
        expected = {s["id"]: s["audio"]["sha256"] for s in manifest["track"]["stems"]}
        self.assertEqual(doc["sourceAudioSha256"], expected)

    def test_tampered_or_legacy_sha_field_missing(self):
        doc = self._presets_doc()
        doc["sourceAudioSha256"]["vocals"] = "0" * 64
        (self.out / "presets.json").write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["presets"]["status"], "missing")
        # 旧版（v0.5.0）文档没有该字段 → 同样视为过期
        doc.pop("sourceAudioSha256")
        (self.out / "presets.json").write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(sync_manifest(self.out)["resources"]["presets"]["status"], "missing")


class PreviewOnlyAfterMoveTests(unittest.TestCase):
    """B：源目录迁移后连续两次 preview_only 都必须成功（缓存摘要同步）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"

    def tearDown(self):
        self._tmp.cleanup()

    def test_two_consecutive_preview_only_after_move(self):
        # 真迁移：目录名不变（trackId 默认取目录名），只换父目录
        src_a = self.tmp / "loc_a" / "stems"
        make_stems(src_a, dur=35.0, amp=0.5)
        first = run_build(src_a, self.out)
        self.assertIsNotNone(first["current"], "首次完整 build 应可发布（本地）")

        src_b = self.tmp / "loc_b" / "stems"
        src_b.parent.mkdir(parents=True)
        shutil.move(str(src_a), str(src_b))

        second = run_build(src_b, self.out, preview_only=True)
        self.assertIsNotNone(second["current"])
        manifest = load_manifest(self.out)
        for stem in manifest["track"]["stems"]:
            p = (self.out / stem["audio"]["path"]).resolve()
            self.assertTrue(p.is_file(), f"迁移后 manifest 音频路径必须存在: {p}")
            self.assertIn("loc_b", str(p))

        # 核心回归：修复前这里抛"仅预览模式要求上游阶段 [manifest] 缓存有效"
        third = run_build(src_b, self.out, preview_only=True)
        self.assertIsNotNone(third["current"])
        self.assertTrue(all(third["hits"].values()),
                        f"第二次 preview_only 应全部缓存命中: {third['hits']}")
        base = json.loads((self.out / "manifest.base.json").read_text(encoding="utf-8"))
        for stem in base["track"]["stems"]:
            self.assertTrue((self.out / stem["audio"]["path"]).resolve().is_file())


class PublishReuseFingerprintTests(unittest.TestCase):
    """C：复用必须按完整包内容指纹判定；迁移后 current 包内路径必须全部可解析。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"
        (self.out / "audio").mkdir(parents=True)
        (self.out / "audio" / "vocals.wav").write_bytes(b"RIFFsynthetic-vocals")
        (self.out / "audio" / "drums.wav").write_bytes(b"RIFFsynthetic-drums")
        self.manifest = {"track": {"stems": [
            {"name": "vocals", "audio": {"path": "audio/vocals.wav"}},
            {"name": "drums", "audio": {"path": "audio/drums.wav"}},
        ]}}
        (self.out / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")
        (self.out / "beats.json").write_text(json.dumps({"bpm": 120.0}), encoding="utf-8")
        (self.out / "presets.json").write_text(json.dumps({"presetIds": ["full"]}), encoding="utf-8")
        (self.out / "features").mkdir()
        (self.out / "features" / "vocals.json").write_text("{}", encoding="utf-8")
        (self.out / "preview").mkdir()
        (self.out / "preview" / "preview.json").write_text("{}", encoding="utf-8")
        self.report = {
            "publishable": True, "blocking": [], "trackId": "synthetic-track",
            "license": {"status": "confirmed", "spdx": "CC-BY-4.0",
                        "source": "synthetic", "publicDeployAllowed": True},
            "whitelist": ["manifest.json", "beats.json"],
            "summary": {"pass": 5, "warn": 0, "degraded": 0, "fail": 0, "restricted": 0},
        }
        (self.out / "report.json").write_text(json.dumps(self.report), encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def _publish_frozen(self) -> dict:
        with patch("pipeline.publish.datetime", frozen_datetime()):
            return publish(self.out, self.report)

    def _release_dir(self, current: dict) -> Path:
        return self.out / current["release"]

    def _assert_current_paths_resolve(self, current: dict) -> None:
        rel_dir = self._release_dir(current)
        doc = json.loads((rel_dir / "manifest.json").read_text(encoding="utf-8"))
        for stem in doc["track"]["stems"]:
            p = (rel_dir / stem["audio"]["path"]).resolve()
            self.assertTrue(p.is_file(), f"current 包内音频路径必须可解析: {p}")

    def test_identical_package_reuses_release(self):
        c1 = self._publish_frozen()
        c2 = self._publish_frozen()
        self.assertEqual(c1["release"], c2["release"], "逐字节相同的完整包应复用")
        dirs = [p for p in (self.out / "releases").iterdir() if p.is_dir()]
        self.assertEqual(len(dirs), 1)
        self._assert_current_paths_resolve(c2)

    def test_same_report_different_manifest_gets_unique_rid(self):
        c1 = self._publish_frozen()
        old_dir = self._release_dir(c1)
        # 模拟源迁移：音频挪目录、manifest 路径更新，report 逐字节不变（同秒 rid 相同）
        shutil.move(str(self.out / "audio"), str(self.out / "audio_moved"))
        for stem in self.manifest["track"]["stems"]:
            stem["audio"]["path"] = stem["audio"]["path"].replace("audio/", "audio_moved/")
        (self.out / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

        c2 = self._publish_frozen()
        self.assertNotEqual(c1["release"], c2["release"],
                            "报告相同但包内容不同 → 必须唯一 ID，不得复用旧包")
        self.assertTrue(old_dir.is_dir(), "旧发布包不得被覆盖或删除")
        self._assert_current_paths_resolve(c2)
        current = json.loads((self.out / "current.json").read_text(encoding="utf-8"))
        self.assertEqual(current["release"], c2["release"])

    def test_incomplete_existing_dir_not_reused(self):
        c1 = self._publish_frozen()
        rid = Path(c1["release"]).name
        junk = self.out / "releases" / (rid + "-2")
        junk.mkdir(parents=True)
        (junk / "manifest.json").write_text("{}", encoding="utf-8")
        # 改动包内容使指纹不同 → 走唯一 ID 分支；-2 已被不完整目录占用 → 应落到 -3
        (self.out / "beats.json").write_text(json.dumps({"bpm": 121.0}), encoding="utf-8")
        c2 = self._publish_frozen()
        self.assertEqual(Path(c2["release"]).name, rid + "-3")
        self._assert_current_paths_resolve(c2)

    def test_transient_permission_error_retries(self):
        # Windows 杀毒/索引器短暂持有新目录句柄 → 目录改名偶发 PermissionError，
        # 有限重试后应成功；重试耗尽才允许失败（此处注入前两次失败）
        real_replace = os.replace
        attempts = {"n": 0}

        def flaky(src, dst):
            if Path(src).is_dir():  # 只模拟目录改名被占用，文件原子写不受影响
                attempts["n"] += 1
                if attempts["n"] <= 2:
                    raise PermissionError(5, "拒绝访问（模拟占用）")
            return real_replace(src, dst)

        with patch("pipeline.publish.os.replace", side_effect=flaky):
            cur = self._publish_frozen()
        self.assertEqual(attempts["n"], 3)
        self._assert_current_paths_resolve(cur)


if __name__ == "__main__":
    unittest.main(verbosity=2)