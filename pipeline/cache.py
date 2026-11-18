"""分阶段缓存（第 4 轮）。

缓存键 = sha256(stage + PIPELINE_VERSION + SCHEMA_VERSION + 输入内容哈希 + 参数)，
下游键包含上游键 → 任何输入/参数/算法版本变化都会使下游失效。
命中前逐一验证产物存在、大小与 sha256 一致——仅凭文件存在绝不跳过。
缓存条目在阶段产物全部落盘后才写入：中途失败 → 无条目/旧键 → 重跑该阶段。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from . import PIPELINE_VERSION, SCHEMA_VERSION
from .audio import sha256_file
from .contract import atomic_write_json, posix_relpath


def make_key(stage: str, inputs: dict) -> str:
    payload = {
        "stage": stage,
        "pipelineVersion": PIPELINE_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "inputs": inputs,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def entry_path(out_dir: Path, stage: str) -> Path:
    return Path(out_dir) / ".cache" / f"{stage}.json"


def load_entry(out_dir: Path, stage: str) -> dict | None:
    path = entry_path(out_dir, stage)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def verify_entry(out_dir: Path, entry: dict) -> bool:
    out_dir = Path(out_dir)
    for art in entry.get("artifacts", []):
        p = out_dir / art["path"]
        if not p.is_file() or p.stat().st_size != art["size"]:
            return False
        if sha256_file(p) != art["sha256"]:
            return False
    return bool(entry.get("artifacts"))


def cache_hit(out_dir: Path, stage: str, key: str) -> bool:
    entry = load_entry(out_dir, stage)
    return bool(entry and entry.get("key") == key and verify_entry(out_dir, entry))


def save_entry(out_dir: Path, stage: str, key: str, artifacts: list[Path], params: dict) -> None:
    out_dir = Path(out_dir)
    arts = [
        {"path": posix_relpath(Path(p), out_dir), "sha256": sha256_file(p), "size": p.stat().st_size}
        for p in artifacts
    ]
    atomic_write_json(entry_path(out_dir, stage), {
        "stage": stage,
        "key": key,
        "params": params,
        "artifacts": arts,
        "completedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }, indent=2)


def refresh_entry_artifact(out_dir: Path, stage: str, artifact: Path) -> bool:
    """产物被合法投影刷新（如迁移后重写 audio.path）后，同步缓存清单中的 sha/size。

    键不变（内容哈希未变），只更新该产物的完整性摘要，避免下次命中校验误判失效。
    条目不存在或不含该产物时不动作。"""
    out_dir = Path(out_dir)
    entry = load_entry(out_dir, stage)
    if not entry:
        return False
    rel = posix_relpath(Path(artifact), out_dir)
    for art in entry.get("artifacts", []):
        if art["path"] == rel:
            art["sha256"] = sha256_file(artifact)
            art["size"] = artifact.stat().st_size
            atomic_write_json(entry_path(out_dir, stage), entry, indent=2)
            return True
    return False


def run_stage(out_dir: Path, stage: str, key: str, fn, params: dict,
              force: bool = False, fail_at: str | None = None,
              require_hit: bool = False) -> bool:
    """执行（或命中缓存跳过）一个阶段。fn 返回产物路径列表。返回是否命中。"""
    if not force and cache_hit(out_dir, stage, key):
        print(f"  [{stage}] 缓存命中，跳过")
        return True
    if require_hit:
        raise RuntimeError(
            f"仅预览模式要求上游阶段 [{stage}] 缓存有效；请先运行完整 build"
        )
    print(f"  [{stage}] 执行中…")
    artifacts = fn()
    if fail_at == stage:
        raise RuntimeError(f"故障注入：{stage} 产物已写、缓存未写，模拟中途失败")
    save_entry(out_dir, stage, key, artifacts, params)
    return False