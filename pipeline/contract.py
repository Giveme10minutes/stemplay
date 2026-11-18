"""数据契约：manifest 结构、资源挂载状态与曲目配置。

schemaVersion=1 约定（后续轮次必须沿用）：
- 所有时间一律相对原曲起点 originSec（默认 0 秒），单位秒。
- 所有资源路径相对 manifest.json 所在目录，使用 POSIX 分隔符。
- 未生成的资源 status="missing"、path=null，绝不填写虚假可用地址。
- 轨道 features 挂在 track.stems[i].features；beats/presets/preview 挂在 resources。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from . import SCHEMA_VERSION, __version__

KNOWN_STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"]

RESOURCE_KINDS = ("features", "beats", "presets", "preview")


def missing_resource() -> dict:
    return {"status": "missing", "path": None}


def ready_resource(path: str, **meta) -> dict:
    return {"status": "ready", "path": path, **meta}


def posix_relpath(target: Path, start: Path) -> str:
    import os

    return Path(os.path.relpath(target, start)).as_posix()


def slugify_track_id(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-").lower()
    if not slug:
        raise ValueError(f"无法从 {name!r} 生成合法曲目 ID（仅允许字母/数字/-/_）")
    return slug


def load_track_config(path: Path | None) -> dict:
    """读取可选曲目配置；缺省字段由调用方补全。"""
    if path is None:
        return {}
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"曲目配置不存在: {path}")
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"曲目配置不是合法 JSON: {path} ({e})") from e
    if not isinstance(cfg, dict):
        raise ValueError(f"曲目配置必须是 JSON 对象: {path}")
    return cfg


def default_license() -> dict:
    # 测试曲来自版权内容，默认未确认授权 → 禁止进入公开部署包（第 4 轮强制检查）
    return {
        "status": "unverified",
        "spdx": None,
        "source": None,
        "publicDeployAllowed": False,
    }


def resolve_license(cfg: dict) -> dict:
    lic = {**default_license(), **(cfg.get("license") or {})}
    if lic["status"] not in ("unverified", "confirmed"):
        raise ValueError(f"license.status 必须是 unverified/confirmed，收到 {lic['status']!r}")
    # 只有明确确认授权（status=confirmed 且给出 SPDX 标识）才允许公开部署
    lic["publicDeployAllowed"] = bool(lic["status"] == "confirmed" and lic.get("spdx"))
    return lic


def generator_info() -> dict:
    return {"name": "stemplay-pipeline", "version": __version__, "schemaVersion": SCHEMA_VERSION}


def atomic_write_text(path: Path, text: str) -> None:
    """临时文件 + os.replace 原子落盘，避免中途失败留下半截产物。"""
    import os

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def atomic_write_json(path: Path, doc, **kwargs) -> None:
    atomic_write_text(path, json.dumps(doc, ensure_ascii=False, allow_nan=False, **kwargs))