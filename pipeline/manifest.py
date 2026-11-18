"""轨道自动发现、输入校验与版本化 manifest 生成（第 1 轮）。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from . import SCHEMA_VERSION
from .artwork import extract_artwork, missing_artwork, parse_tags, _probe
from .audio import AudioError, probe_wav, sha256_file
from .contract import (
    KNOWN_STEMS,
    atomic_write_json,
    generator_info,
    load_track_config,
    missing_resource,
    posix_relpath,
    ready_resource,
    resolve_license,
    slugify_track_id,
)


def discover_stems(stems_dir: Path) -> list[Path]:
    if not stems_dir.is_dir():
        raise AudioError(f"分轨目录不存在或不是目录: {stems_dir}")
    wavs = sorted(
        [p for p in stems_dir.iterdir() if p.suffix.lower() == ".wav" and p.is_file()],
        key=lambda p: p.name.lower(),
    )
    if not wavs:
        raise AudioError(f"分轨目录中没有找到任何 .wav 文件: {stems_dir}")
    ordered = [p for n in KNOWN_STEMS for p in wavs if p.stem.lower() == n]
    ordered += [p for p in wavs if p.stem.lower() not in KNOWN_STEMS]
    return ordered


def _infer_model(stems_dir: Path, cfg: dict) -> dict:
    model = {"name": None, "family": "demucs", "version": None}
    # Demucs 输出布局: separated/<model>/<track>/，据此推断模型名
    parent = stems_dir.resolve().parent.name
    if parent.startswith("htdemucs"):
        model["name"] = parent
    model.update(cfg.get("model") or {})
    if not model["name"]:
        model["name"] = "unknown"
    return model


def build_manifest(stems_dir: Path, out_dir: Path, config_path: Path | None = None,
                   track_id: str | None = None) -> dict:
    stems_dir = Path(stems_dir).resolve()
    out_dir = Path(out_dir).resolve()
    cfg = load_track_config(config_path)

    paths = discover_stems(stems_dir)
    metas = []
    for p in paths:
        meta = probe_wav(p)
        meta["path"] = p
        metas.append(meta)

    # 所有轨道必须采样率/声道/帧数一致，否则同步播放无从谈起
    ref = metas[0]
    problems = []
    for m in metas[1:]:
        for key in ("sampleRate", "channels", "frames"):
            if m[key] != ref[key]:
                problems.append(
                    f"{m['path'].name}: {key}={m[key]}，与 {ref['path'].name} 的 {ref[key]} 不一致"
                )
    if problems:
        raise AudioError("轨道格式/长度校验失败:\n  " + "\n  ".join(problems))

    tid = slugify_track_id(track_id or cfg.get("id") or stems_dir.name)

    # 可选原曲：内嵌封面与 tags（读取失败 missing，不阻塞无封面歌曲）
    artwork = missing_artwork()
    artist = None
    album = None
    src_rel = cfg.get("sourceAudio")
    if isinstance(src_rel, str) and src_rel.strip():
        src = Path(src_rel)
        if not src.is_absolute():
            src = (Path(config_path).resolve().parent / src).resolve() if config_path else src.resolve()
        if src.is_file():
            artwork = extract_artwork(src, out_dir)
            tags = parse_tags(_probe(src))
            artist, album = tags["artist"], tags["album"]

    stems = []
    for m in metas:
        p: Path = m["path"]
        stems.append({
            "id": p.stem.lower(),
            "audio": {
                "path": posix_relpath(p, out_dir),
                "format": m["format"],
                "sampleRate": m["sampleRate"],
                "channels": m["channels"],
                "frames": m["frames"],
                "durationSec": round(m["durationSec"], 6),
                "sha256": sha256_file(p),
            },
            "features": missing_resource(),
        })

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generator": generator_info(),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "track": {
            "id": tid,
            "title": cfg.get("title") or tid,
            "originSec": 0.0,
            "durationSec": round(ref["durationSec"], 6),
            "sampleRate": ref["sampleRate"],
            "channels": ref["channels"],
            "model": _infer_model(stems_dir, cfg),
            "license": resolve_license(cfg),
            "artist": artist,
            "album": album,
            "artwork": artwork,
            "stems": stems,
        },
        "resources": {
            "beats": missing_resource(),
            "presets": missing_resource(),
            "preview": missing_resource(),
        },
    }
    if cfg.get("analysis"):
        manifest["track"]["analysisConfig"] = cfg["analysis"]
    return manifest


def write_manifest(manifest: dict, out_dir: Path) -> Path:
    """写入 manifest.base.json（manifest 阶段的稳定产物），并投影出 manifest.json。

    base 只含发现/校验结果，挂载字段一律 missing；manifest.json 由 sync_manifest
    从各阶段实际产物重建，任何阶段完成后都可安全重投影（缓存与失败恢复的基础）。
    """
    import copy

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base = copy.deepcopy(manifest)
    for stem in base["track"]["stems"]:
        stem["features"] = missing_resource()
    for kind in base["resources"]:
        base["resources"][kind] = missing_resource()
    base["track"].pop("analysis", None)
    base_path = out_dir / "manifest.base.json"
    atomic_write_json(base_path, base, indent=2)
    sync_manifest(out_dir)
    return base_path


def load_base(out_dir: Path) -> dict:
    path = Path(out_dir) / "manifest.base.json"
    if not path.is_file():
        raise FileNotFoundError(f"未找到 manifest.base.json，请先运行 manifest 阶段: {path}")
    base = json.loads(path.read_text(encoding="utf-8"))
    if base.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(
            f"manifest schemaVersion={base.get('schemaVersion')} 与当前管线 "
            f"SCHEMA_VERSION={SCHEMA_VERSION} 不兼容，请重新生成"
        )
    return base


def _resource_mount(out_dir: Path, rel: str, kind: str, track_id: str, summary_keys: tuple,
                    validate=None) -> dict:
    path = out_dir / rel
    if not path.is_file():
        return missing_resource()
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return missing_resource()
    if doc.get("schemaVersion") != SCHEMA_VERSION or doc.get("kind") != kind:
        return missing_resource()
    if doc.get("trackId") != track_id:
        return missing_resource()
    if validate is not None and not validate(doc):
        return missing_resource()
    extra = {k: doc[k] for k in summary_keys if k in doc}
    return ready_resource(rel, sha256=sha256_file(path), **extra)


def sync_manifest(out_dir: Path) -> dict:
    """从各阶段产物重建 manifest.json 挂载字段；产物缺失/损坏/过期自动回落 missing。

    过期判定不止"文件存在"：特征核对当前分析参数；beats/presets/preview 核对
    上游哈希与参数——上游任何变化立即 missing，绝不把陈旧下游标成 ready。
    """
    import copy

    from .beats import beat_params
    from .features import _analysis_params
    from .presets import preset_params

    out_dir = Path(out_dir)
    manifest = copy.deepcopy(load_base(out_dir))
    track = manifest["track"]

    # artwork 为 base 字段而非挂载，但仍做存在性核对：文件被删/内容变 → 回落 missing
    art = track.get("artwork") or {}
    if art.get("status") == "ready":
        ap = out_dir / art["path"] if art.get("path") else None
        if ap is None or not ap.is_file() or sha256_file(ap) != art.get("sha256"):
            track["artwork"] = missing_artwork()

    fexp = _analysis_params(track)
    exp_hop = int(round(track["sampleRate"] / fexp["frameRate"]))
    exp_frame_rate = track["sampleRate"] / exp_hop

    analysis = None
    feature_shas: dict[str, str] = {}
    for stem in track["stems"]:
        rel = f"features/{stem['id']}.json"
        path = out_dir / rel
        mount = missing_resource()
        if path.is_file():
            try:
                doc = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                doc = {}
            if (
                doc.get("schemaVersion") == SCHEMA_VERSION
                and doc.get("kind") == "stem-features"
                and doc.get("sourceSha256") == stem["audio"]["sha256"]
                and doc.get("hopSamples") == exp_hop
                and doc.get("windowSamples") == fexp["windowSamples"]
                and doc.get("frameRate") == exp_frame_rate
                and (doc.get("display") or {}).get("silenceThreshold")
                == fexp["silenceThreshold"]
            ):
                mount = ready_resource(
                    rel, frameRate=doc["frameRate"], nFrames=doc["nFrames"],
                    sha256=sha256_file(path),
                )
                feature_shas[stem["id"]] = mount["sha256"]
                if analysis is None:
                    analysis = {
                        k: doc[k]
                        for k in ("frameRate", "hopSamples", "windowSamples",
                                  "windowCenterOffsetSec", "bandsHz", "display")
                        if k in doc
                    }
        stem["features"] = mount
    if analysis is not None:
        track["analysis"] = analysis

    all_features_ready = len(feature_shas) == len(track["stems"])
    stem_ids = {s["id"] for s in track["stems"]}
    analysis_fr = (analysis or {}).get("frameRate")

    def beats_current(doc: dict) -> bool:
        return (
            all_features_ready
            and doc.get("frameRate") == analysis_fr
            and doc.get("sourceFeaturesSha256") == feature_shas
            and doc.get("analysisParams") == beat_params(track)
        )

    def presets_current(doc: dict) -> bool:
        if doc.get("params") != preset_params(track):
            return False
        if doc.get("sourceAudioSha256") != {s["id"]: s["audio"]["sha256"] for s in track["stems"]}:
            return False
        if "stemPeaks" in doc:
            return set(doc.get("stemPeaks") or {}) == stem_ids
        presets = doc.get("presets") or []
        gains = presets[0].get("gains") if presets else None
        return set(gains or {}) == stem_ids

    beats_mount = _resource_mount(
        out_dir, "beats.json", "beats", track["id"], ("bpm", "snapEnabled"),
        validate=beats_current)
    presets_mount = _resource_mount(
        out_dir, "presets.json", "presets", track["id"], ("presetIds",),
        validate=presets_current)

    def preview_current(doc: dict) -> bool:
        if not all_features_ready:
            return False
        if (doc.get("features") or {}).get("frameRate") != analysis_fr:
            return False
        up = doc.get("upstreamSha256")
        if not isinstance(up, dict):
            return False
        expected = {
            "features": feature_shas,
            "beats": beats_mount.get("sha256") if beats_mount["status"] == "ready" else None,
            "presets": presets_mount.get("sha256") if presets_mount["status"] == "ready" else None,
        }
        return up == expected

    manifest["resources"]["beats"] = beats_mount
    manifest["resources"]["presets"] = presets_mount
    manifest["resources"]["preview"] = _resource_mount(
        out_dir, "preview/preview.json", "preview", track["id"], ("originSec", "durationSec"),
        validate=preview_current)
    atomic_write_json(out_dir / "manifest.json", manifest, indent=2)
    return manifest


def refresh_audio_paths(out_dir: Path, stems_dir: Path) -> bool:
    """源目录迁移后刷新 base 中的 audio.path（按 stem id 匹配当前目录）。

    缓存键只含内容哈希，不含路径——迁移后特征等昂贵阶段仍按内容命中；
    这里仅把 base 的相对路径重算到当前源目录，有变化才原子重写。
    顺带校验 sha256：内容已变则不动路径，交给正常缓存键流程重建。
    返回是否发生了重写。
    """
    out_dir = Path(out_dir).resolve()
    stems_dir = Path(stems_dir).resolve()
    base = load_base(out_dir)
    by_id = {p.stem.lower(): p for p in discover_stems(stems_dir)}
    changed = False
    for stem in base["track"]["stems"]:
        p = by_id.get(stem["id"])
        if p is None:
            continue
        new_rel = posix_relpath(p, out_dir)
        if new_rel == stem["audio"]["path"]:
            continue
        if sha256_file(p) != stem["audio"]["sha256"]:
            continue  # 内容变了：mkey 会失效，manifest 阶段自然重建
        stem["audio"]["path"] = new_rel
        changed = True
    if changed:
        atomic_write_json(out_dir / "manifest.base.json", base, indent=2)
    return changed


def load_manifest(out_dir: Path) -> dict:
    out_dir = Path(out_dir)
    if not (out_dir / "manifest.json").is_file():
        if (out_dir / "manifest.base.json").is_file():
            return sync_manifest(out_dir)
        raise FileNotFoundError(f"未找到 manifest，请先运行 manifest 阶段: {out_dir / 'manifest.json'}")
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError(
            f"manifest schemaVersion={manifest.get('schemaVersion')} 与当前管线 "
            f"SCHEMA_VERSION={SCHEMA_VERSION} 不兼容，请重新生成"
        )
    return manifest