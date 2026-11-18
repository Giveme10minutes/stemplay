"""原子发布（第 4 轮）：releases/<id> 完整资源包 + current.json 单文件原子指针。

质检通过才发布；指针切换是单文件 os.replace（原子），读取方要么看到旧包要么看到新包，
不会新旧混用。保留最近 3 个 release，更早的自动清理。
"""
from __future__ import annotations

import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from .audio import sha256_file
from .contract import atomic_write_json, posix_relpath

KEEP_RELEASES = 3


def _is_complete_release(path: Path) -> bool:
    """判断目录是否为本管线产出的完整资源包（缺任一要件即视为不完整）。"""
    if not path.is_dir():
        return False
    for name in ("manifest.json", "beats.json", "presets.json", "report.json"):
        if not (path / name).is_file():
            return False
    return (path / "features").is_dir() and (path / "preview").is_dir()


def _package_fingerprint(root: Path) -> dict:
    """完整包内容指纹：相对路径 → (大小, sha256)。复用判定不能只看 report 哈希——
    源迁移后报告可能逐字节相同，但包内 manifest 的音频路径已过时。"""
    return {
        posix_relpath(p, root): (p.stat().st_size, sha256_file(p))
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def _replace_dir(tmp: Path, final: Path) -> None:
    """同卷目录原子改名。Windows 下杀毒/索引器可能短暂持有新目录句柄导致
    PermissionError，做有限退避重试；仍失败则抛出（调用方只清理 tmp）。"""
    delay = 0.1
    for attempt in range(8):
        try:
            os.replace(tmp, final)
            return
        except PermissionError:
            if attempt == 7:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 1.0)


def publish(out_dir: Path, report: dict) -> dict:
    out_dir = Path(out_dir).resolve()
    if not report.get("publishable"):
        raise RuntimeError(f"质检存在阻断性错误，拒绝发布: {report['blocking']}")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_sha = sha256_file(out_dir / "report.json")
    rid = f"{stamp}-{report_sha[:6]}"
    releases = out_dir / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    final = releases / rid

    # 先完整组装 tmp，再决定复用/唯一 ID——复用必须按完整包内容指纹判定，
    # 不能只看 report 哈希（源迁移后报告可能相同，但包内 manifest 路径已过时）。
    tmp = releases / (rid + ".tmp")
    if tmp.exists():
        shutil.rmtree(tmp)  # 只清理本管线自产的同名 tmp 残留
    tmp.mkdir(parents=True)
    try:
        # manifest：音频相对路径重写到 release 目录视角（其余包内路径结构不变）
        manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
        for stem in manifest["track"]["stems"]:
            abs_audio = (out_dir / stem["audio"]["path"]).resolve()
            stem["audio"]["path"] = posix_relpath(abs_audio, final)
        atomic_write_json(tmp / "manifest.json", manifest, indent=2)

        for name in ("beats.json", "presets.json", "report.json"):
            shutil.copy2(out_dir / name, tmp / name)
        shutil.copytree(out_dir / "features", tmp / "features")
        shutil.copytree(out_dir / "preview", tmp / "preview")
        if (out_dir / "artwork").is_dir():
            shutil.copytree(out_dir / "artwork", tmp / "artwork")

        reuse = False
        if final.exists():
            if _is_complete_release(final) and _package_fingerprint(final) == _package_fingerprint(tmp):
                reuse = True  # 逐字节相同的完整包 → 直接复用，仅更新指针
            else:
                n = 2
                while (releases / f"{rid}-{n}").exists():
                    n += 1
                rid = f"{rid}-{n}"
                final = releases / rid
                # releases/<rid> 与 releases/<rid>-n 同深度，manifest 相对路径不变
        if reuse:
            shutil.rmtree(tmp)
        else:
            if final.exists():
                raise RuntimeError(f"发布目录已存在，拒绝覆盖: {final}")
            _replace_dir(tmp, final)  # 同卷目录改名，目标不存在 → 原子
    except BaseException:
        # 任何一步失败只清理本次 tmp，绝不触碰既有发布包与 current 指针
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    current = {
        "release": f"releases/{rid}",
        "publishedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "trackId": report["trackId"],
        "publicDeployAllowed": report["license"]["publicDeployAllowed"],
        "whitelist": report["whitelist"],
        "report": f"releases/{rid}/report.json",
        "summary": report["summary"],
    }
    atomic_write_json(out_dir / "current.json", current, indent=2)

    # 清理旧 release（仅管线自产产物）；current 正在引用的目录绝不清理，
    # 其余按名字排序保留最近 KEEP_RELEASES - 1 个（合计 ≤ KEEP_RELEASES）
    olds = sorted(p for p in releases.iterdir()
                  if p.is_dir() and not p.name.endswith(".tmp") and p != final)
    for p in olds[:max(0, len(olds) - (KEEP_RELEASES - 1))]:
        shutil.rmtree(p)
    return current