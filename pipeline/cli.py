"""统一命令入口: python -m pipeline <stage> ...

第 1 轮: manifest   发现轨道 + 校验 + 生成版本化 manifest
第 2 轮: features   生成 50Hz 音画联动特征并回填 manifest
后续轮次在此追加 beats / presets / preview / build 子命令，复用同一契约。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .audio import AudioError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pipeline",
        description="StemPlay 本地资源生产管线（产物仅本地使用，版权素材不得进入公开部署包）",
    )
    parser.add_argument("--version", action="version", version=f"stemplay-pipeline {__version__}")
    sub = parser.add_subparsers(dest="stage", required=True)

    p = sub.add_parser("manifest", help="发现轨道、校验输入、生成版本化 manifest")
    p.add_argument("--stems", required=True, type=Path, help="分轨目录（含若干 .wav）")
    p.add_argument("--out", required=True, type=Path, help="输出目录（写 manifest.json 等）")
    p.add_argument("--config", type=Path, default=None, help="曲目配置 JSON（id/title/license/model/analysis）")
    p.add_argument("--track-id", default=None, help="覆盖曲目 ID（默认取配置或目录名）")

    p = sub.add_parser("features", help="为 manifest 中每轨生成 50Hz 特征并回填挂载")
    p.add_argument("--out", required=True, type=Path, help="manifest 阶段使用的同一输出目录")

    p = sub.add_parser("beats", help="估计 BPM/拍点与启发式可用性评分（需先有 features）")
    p.add_argument("--out", required=True, type=Path)

    p = sub.add_parser("presets", help="生成三套混音预设并实测总线峰值")
    p.add_argument("--out", required=True, type=Path)

    for name, help_text in (
        ("build", "一键构建：manifest→features→beats→presets→preview→质检→原子发布"),
        ("preview", "仅重建预览（上游阶段必须缓存有效；改预览参数后快速重切）"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--stems", required=True, type=Path)
        p.add_argument("--out", required=True, type=Path)
        p.add_argument("--config", type=Path, default=None)
        p.add_argument("--track-id", default=None)
        p.add_argument("--preview-sec", type=float, default=None, help="预览时长 30–45s（默认 40）")
        p.add_argument("--preview-start", type=float, default=None, help="预览起点秒数（默认能量自动选段）")
        p.add_argument("--bitrate", default=None, help="AAC 码率（默认 128k）")
        p.add_argument("--force", action="store_true", help="忽略缓存全部重算")
        p.add_argument("--fail-at", default=None,
                       choices=["manifest", "features", "beats", "presets", "preview"],
                       help="测试钩子：在指定阶段产物写入后、缓存写入前模拟中途失败")
    return parser


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    args = _build_parser().parse_args(argv)
    try:
        if args.stage == "manifest":
            from .manifest import build_manifest, write_manifest

            manifest = build_manifest(args.stems, args.out, args.config, args.track_id)
            path = write_manifest(manifest, args.out)
            track = manifest["track"]
            print(f"manifest 已生成: {path}")
            print(
                f"  曲目 {track['id']} | {len(track['stems'])} 轨 | "
                f"{track['sampleRate']}Hz {track['channels']}ch | {track['durationSec']:.3f}s | "
                f"模型 {track['model']['name']} | 授权 {track['license']['status']}"
            )
        elif args.stage == "features":
            from .features import run_features

            print(f"生成特征: {args.out}")
            manifest = run_features(args.out)
            ready = sum(s["features"]["status"] == "ready" for s in manifest["track"]["stems"])
            print(f"完成: {ready} 轨特征已挂入 manifest（beats/presets/preview 仍为 missing）")
        elif args.stage == "beats":
            from .beats import run_beats

            print(f"估计节拍: {args.out}")
            run_beats(args.out)
        elif args.stage == "presets":
            from .presets import run_presets

            print(f"生成混音预设: {args.out}")
            run_presets(args.out)
        elif args.stage in ("build", "preview"):
            from .build import run_build

            overrides = {"previewSec": args.preview_sec, "startSec": args.preview_start,
                         "bitrate": args.bitrate}
            print(f"{'一键构建' if args.stage == 'build' else '仅预览重建'}: {args.out}")
            result = run_build(
                args.stems, args.out, args.config, args.track_id, overrides,
                force=args.force, fail_at=args.fail_at,
                preview_only=(args.stage == "preview"),
            )
            if not result["report"]["publishable"]:
                return 1
    except (AudioError, FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    return 0