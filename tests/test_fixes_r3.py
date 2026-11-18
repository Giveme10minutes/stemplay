"""修复轮 3 回归：发布目录不可覆盖 + 失败保留旧包（pipeline/publish.py）。

只用合成素材/临时目录，不依赖其他阶段，不触碰 separated/ 真实素材。
运行: .venv/Scripts/python.exe -m unittest tests.test_fixes_r3 -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from pipeline.audio import sha256_file  # noqa: E402
from pipeline.publish import KEEP_RELEASES, publish  # noqa: E402

FROZEN = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
STAMP = FROZEN.strftime("%Y%m%dT%H%M%SZ")

PACKAGE_FILES = ("manifest.json", "beats.json", "presets.json", "report.json")


def make_report(marker: str) -> dict:
    """publish 实际读取的字段齐全的最小报告。"""
    return {
        "publishable": True,
        "blocking": [],
        "trackId": "synthetic-track",
        "license": {"status": "confirmed", "spdx": "CC-BY-4.0",
                    "source": "synthetic", "publicDeployAllowed": True},
        "whitelist": ["manifest.json", "beats.json"],
        "summary": {"pass": 5, "warn": 0, "degraded": 0, "fail": 0, "restricted": 0},
        "marker": marker,  # 改变报告内容 → 改变 sha256 → 不同 rid
    }


def frozen_datetime():
    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return FROZEN
    return _Frozen


class PublishR3Tests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.out = self.tmp / "build"
        self.out.mkdir(parents=True)
        # 最小可发布 out 目录：manifest 音频相对路径 + beats/presets/report + features/ + preview/
        (self.out / "audio").mkdir()
        (self.out / "audio" / "vocals.wav").write_bytes(b"RIFFsynthetic-vocals")
        (self.out / "audio" / "drums.wav").write_bytes(b"RIFFsynthetic-drums")
        manifest = {"track": {"stems": [
            {"name": "vocals", "audio": {"path": "audio/vocals.wav"}},
            {"name": "drums", "audio": {"path": "audio/drums.wav"}},
        ]}}
        (self.out / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (self.out / "beats.json").write_text(json.dumps({"bpm": 120.0}), encoding="utf-8")
        (self.out / "presets.json").write_text(json.dumps({"presetIds": ["full"]}), encoding="utf-8")
        (self.out / "features").mkdir()
        (self.out / "features" / "vocals.json").write_text("{}", encoding="utf-8")
        (self.out / "preview").mkdir()
        (self.out / "preview" / "preview.json").write_text("{}", encoding="utf-8")
        (self.out / "preview" / "vocals.m4a").write_bytes(b"synthetic-preview")
        self.set_report("a")

    def tearDown(self):
        self._tmp.cleanup()

    def set_report(self, marker: str) -> dict:
        report = make_report(marker)
        (self.out / "report.json").write_text(
            json.dumps(report, ensure_ascii=False), encoding="utf-8")
        return report

    def expected_rid(self) -> str:
        return f"{STAMP}-{sha256_file(self.out / 'report.json')[:6]}"

    def release_dirs(self) -> list[Path]:
        return sorted(p for p in (self.out / "releases").iterdir() if p.is_dir())

    def assert_complete_package(self, rel: Path):
        for name in PACKAGE_FILES:
            self.assertTrue((rel / name).is_file(), name)
        self.assertTrue((rel / "features" / "vocals.json").is_file())
        self.assertTrue((rel / "preview" / "preview.json").is_file())
        self.assertTrue((rel / "preview" / "vocals.m4a").is_file())

    def read_current(self) -> dict:
        return json.loads((self.out / "current.json").read_text(encoding="utf-8"))

    # ---- 1. 同秒同报告：完整包逐字节一致才复用；外部改动 → 唯一 ID，旧包原样保留 ----
    def test_same_second_same_report_reuses_dir(self):
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur1 = publish(self.out, self.set_report("a"))
            cur2 = publish(self.out, self.set_report("a"))
        self.assertEqual(cur1["release"], cur2["release"])
        self.assertEqual(len(self.release_dirs()), 1)
        # 第 0 轮 C 修复后复用按完整包内容指纹判定：向发布包加入外部文件 →
        # 指纹不再一致 → 不复用、不覆盖，走唯一后缀，旧包（含哨兵）原样保留
        rel = self.out / cur1["release"]
        sentinel = rel / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur3 = publish(self.out, self.set_report("a"))
        self.assertNotEqual(cur3["release"], cur1["release"])
        self.assertTrue(sentinel.is_file())
        self.assert_complete_package(self.out / self.read_current()["release"])

    # ---- 2. 目录被占用：不完整 / 异内容 → 唯一后缀，不删除既有目录 ----
    def test_incomplete_occupant_gets_unique_suffix(self):
        rid = self.expected_rid()
        occupant = self.out / "releases" / rid
        occupant.mkdir(parents=True)
        (occupant / "junk.txt").write_text("not-a-package", encoding="utf-8")
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur = publish(self.out, self.set_report("a"))
        self.assertEqual(cur["release"], f"releases/{rid}-2")
        self.assertTrue((occupant / "junk.txt").is_file())  # 旧目录原样保留
        self.assert_complete_package(self.out / cur["release"])
        self.assertEqual(self.read_current()["release"], cur["release"])

    def test_complete_but_different_report_gets_suffix(self):
        rid = self.expected_rid()
        occupant = self.out / "releases" / rid
        occupant.mkdir(parents=True)
        for name in PACKAGE_FILES:
            (occupant / name).write_text("{}", encoding="utf-8")
        (occupant / "features").mkdir()
        (occupant / "preview").mkdir()
        # 结构完整但 report.json 内容不同 → 不是同一个包，不得复用也不得覆盖
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur = publish(self.out, self.set_report("a"))
        self.assertEqual(cur["release"], f"releases/{rid}-2")
        self.assertEqual((occupant / "report.json").read_text(encoding="utf-8"), "{}")
        self.assert_complete_package(self.out / cur["release"])

    def test_suffix_increments_until_free(self):
        rid = self.expected_rid()
        for name in (rid, f"{rid}-2"):
            (self.out / "releases" / name).mkdir(parents=True)
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur = publish(self.out, self.set_report("a"))
        self.assertEqual(cur["release"], f"releases/{rid}-3")
        self.assertTrue((self.out / "releases" / rid).is_dir())
        self.assertTrue((self.out / "releases" / f"{rid}-2").is_dir())

    # ---- 3. os.replace 失败：旧发布包与 current 完好 ----
    def test_replace_failure_keeps_old_package_and_current(self):
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur1 = publish(self.out, self.set_report("a"))
        old_rel = self.out / cur1["release"]
        old_current_bytes = (self.out / "current.json").read_bytes()
        report2 = self.set_report("b")  # 不同报告哈希 → 不走复用路径
        self.assertNotEqual(self.expected_rid(), Path(cur1["release"]).name)

        real_replace = os.replace

        def fail_dir_rename(src, dst):
            if Path(src).is_dir():  # 只让 tmp 目录 → final 的改名失败
                raise OSError("simulated rename failure")
            return real_replace(src, dst)

        with patch("pipeline.publish.datetime", frozen_datetime()), \
                patch("pipeline.publish.os.replace", side_effect=fail_dir_rename):
            with self.assertRaises(OSError):
                publish(self.out, report2)
        self.assert_complete_package(old_rel)  # 旧包完好
        self.assertEqual((self.out / "current.json").read_bytes(), old_current_bytes)
        self.assertEqual(self.read_current()["release"], cur1["release"])
        # 本次失败的 tmp 已清理，不留残留
        self.assertFalse(any(p.name.endswith(".tmp")
                             for p in (self.out / "releases").iterdir()))

    # ---- 4. 连续发布 5 个不同报告：数量受控，current 目录必然存在 ----
    def test_five_publishes_respect_keep_limit(self):
        with patch("pipeline.publish.datetime", frozen_datetime()):
            for marker in ("a", "b", "c", "d", "e"):
                cur = publish(self.out, self.set_report(marker))
                rel = self.out / cur["release"]
                self.assertTrue(rel.is_dir())
                self.assert_complete_package(rel)
        dirs = self.release_dirs()
        self.assertLessEqual(len(dirs), KEEP_RELEASES)
        self.assertIn(self.out / self.read_current()["release"], dirs)

    # ---- 5. 清理保护：current 引用的目录即使排序最旧也不删 ----
    def test_cleanup_never_removes_current_even_if_oldest(self):
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur = publish(self.out, self.set_report("a"))
        # 人为放入按名字排序更新的目录，把 current 挤成"最旧"
        for name in ("zzz-1", "zzz-2", "zzz-3"):
            (self.out / "releases" / name).mkdir()
        with patch("pipeline.publish.datetime", frozen_datetime()):
            cur2 = publish(self.out, self.set_report("a"))  # 复用路径也触发清理
        self.assertEqual(cur2["release"], cur["release"])
        self.assertTrue((self.out / cur["release"]).is_dir())
        self.assert_complete_package(self.out / cur["release"])
        self.assertLessEqual(len(self.release_dirs()), KEEP_RELEASES)

    # ---- 6. 正常路径：manifest 音频相对路径重写后仍可解析到源文件 ----
    def test_manifest_audio_paths_resolve_to_source(self):
        cur = publish(self.out, self.set_report("a"))
        rel = self.out / cur["release"]
        m = json.loads((rel / "manifest.json").read_text(encoding="utf-8"))
        for stem in m["track"]["stems"]:
            resolved = (rel / stem["audio"]["path"]).resolve()
            self.assertTrue(resolved.is_file(), stem["audio"]["path"])
            src = (self.out / "audio" / f"{stem['name']}.wav").resolve()
            self.assertEqual(resolved, src)
            self.assertEqual(sha256_file(resolved), sha256_file(src))
        # current 字段结构保持
        for key in ("release", "publishedAt", "trackId", "publicDeployAllowed",
                    "whitelist", "report", "summary"):
            self.assertIn(key, cur)
        self.assertTrue((self.out / cur["report"]).is_file())


if __name__ == "__main__":
    unittest.main()