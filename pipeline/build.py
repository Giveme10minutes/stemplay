"""一键构建编排（第 4 轮）：manifest → features → beats → presets → preview → report → publish。

- 分阶段缓存：键含输入内容哈希 + 参数 + PIPELINE_VERSION，命中前验产物完整性。
- 失败重跑：同一命令再跑一次即可，已完成阶段命中缓存，失败阶段重算。
- 仅预览（preview_only）：上游必须缓存有效，否则报错提示先跑完整 build。
- 质检阻断 → 不发布；通过 → 原子发布 releases/<id> + current.json 指针。
"""
from __future__ import annotations

import json
from pathlib import Path

from .audio import sha256_file
from .beats import beat_params, run_beats
from .cache import make_key, refresh_entry_artifact, run_stage
from .contract import load_track_config, slugify_track_id
from .features import _analysis_params, run_features
from .manifest import (
    build_manifest,
    discover_stems,
    load_base,
    load_manifest,
    refresh_audio_paths,
    sync_manifest,
    write_manifest,
)
from .presets import preset_params, run_presets
from .preview import preview_params, run_preview
from .publish import publish
from .report import run_report


def run_build(stems: Path, out: Path, config: Path | None = None, track_id: str | None = None,
              preview_overrides: dict | None = None, force: bool = False,
              fail_at: str | None = None, preview_only: bool = False) -> dict:
    stems = Path(stems).resolve()
    out = Path(out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    paths = discover_stems(stems)
    audio_shas = {p.stem.lower(): sha256_file(p) for p in paths}
    cfg = load_track_config(config)
    config_sha = sha256_file(config) if config else None
    tid = slugify_track_id(track_id or cfg.get("id") or stems.name)
    # 原曲内容进 manifest 缓存键：换封面/换原曲必须重跑 manifest 阶段
    src_sha = None
    src_rel = cfg.get("sourceAudio")
    if isinstance(src_rel, str) and src_rel.strip():
        src = Path(src_rel)
        if not src.is_absolute() and config:
            src = Path(config).resolve().parent / src
        if Path(src).is_file():
            src_sha = sha256_file(src)
    hits: dict[str, bool] = {}

    mkey = make_key("manifest", {"audio": audio_shas, "config": config_sha,
                                 "sourceAudio": src_sha, "trackId": tid})

    def manifest_fn():
        m = build_manifest(stems, out, config, track_id)
        write_manifest(m, out)
        return [out / "manifest.base.json"]

    hits["manifest"] = run_stage(out, "manifest", mkey, manifest_fn, {"trackId": tid},
                                 force, fail_at, require_hit=preview_only)
    # 源目录迁移兜底：mkey 不含路径（特征缓存按内容哈希复用），命中后 base 里
    # 可能仍是旧目录的相对路径——这里按当前源目录刷新，后续 sync 自然带出新路径。
    # base 被重写后必须同步缓存清单摘要，否则下次命中校验误判失效（连续 preview_only）。
    if refresh_audio_paths(out, stems):
        refresh_entry_artifact(out, "manifest", out / "manifest.base.json")
    track = load_base(out)["track"]

    fparams = _analysis_params(track)
    fkey = make_key("features", {"upstream": mkey, "params": fparams})

    def features_fn():
        run_features(out)
        return [out / "features" / f"{s['id']}.json" for s in track["stems"]]

    hits["features"] = run_stage(out, "features", fkey, features_fn, fparams,
                                 force, fail_at, require_hit=preview_only)

    synced = load_manifest(out)
    fshas = {s["id"]: s["features"]["sha256"] for s in synced["track"]["stems"]}
    bparams = beat_params(track)
    bkey = make_key("beats", {"upstream": fkey, "params": bparams, "featuresShas": fshas})

    def beats_fn():
        run_beats(out)
        return [out / "beats.json"]

    hits["beats"] = run_stage(out, "beats", bkey, beats_fn, bparams,
                              force, fail_at, require_hit=preview_only)

    pparams = preset_params(track)
    pkey = make_key("presets", {"upstream": mkey, "params": pparams})

    def presets_fn():
        run_presets(out)
        return [out / "presets.json"]

    hits["presets"] = run_stage(out, "presets", pkey, presets_fn, pparams,
                                force, fail_at, require_hit=preview_only)

    pvparams = preview_params(track, preview_overrides)
    pvkey = make_key("preview", {
        "upstream": {"features": fkey, "beats": bkey, "presets": pkey},
        "params": pvparams, "audio": audio_shas,
    })

    def preview_fn():
        run_preview(out, preview_overrides)
        pv = json.loads((out / "preview/preview.json").read_text(encoding="utf-8"))
        arts = [out / "preview/preview.json", out / "preview/beats.json"]
        arts += [out / "preview" / e["path"] for e in pv["stems"].values()]
        arts += [out / "preview/features" / f"{sid}.json" for sid in pv["stems"]]
        return arts

    hits["preview"] = run_stage(out, "preview", pvkey, preview_fn, pvparams,
                                force, fail_at, require_hit=False)

    sync_manifest(out)
    report = run_report(out)
    s = report["summary"]
    print(f"质检: pass={s['pass']} warn={s['warn']} degraded={s['degraded']} "
          f"fail={s['fail']} restricted={s['restricted']}")
    result = {"hits": hits, "report": report, "current": None}
    if not report["publishable"]:
        print(f"阻断性错误，未发布: {report['blocking']}")
        return result
    current = publish(out, report)
    result["current"] = current
    sizes = report.get("sizes", {})
    print(f"已发布: {current['release']}")
    if sizes:
        print(f"预览音频 {sizes.get('previewAudioBytes', 0) / 1048576:.2f}MB | "
              f"资源包 {sizes.get('packageBytes', 0) / 1048576:.2f}MB | "
              f"公开白名单 {'非空' if current['whitelist'] else '空（授权未确认，仅本地）'}")
    return result