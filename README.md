# StemPlay

把一首歌拆成人声、鼓、贝斯、吉他、钢琴和其他声部，在浏览器里同步播放与混音。

- 分离引擎：[Demucs (HTDemucs)](https://github.com/facebookresearch/demucs)（MIT 协议，Meta AI）
- 前端：React + TypeScript + shadcn/ui + Web Audio API
- 用途：2026 Qoder 高校创造力大赛 · LifeHack 赛道参赛作品

## Windows 本地启动

安装 Node.js 24 后，双击仓库根目录的 [`start.cmd`](start.cmd)。脚本会在缺少依赖时安装前端依赖，启动本地开发服务并打开浏览器。按 `Ctrl+C` 停止。

有已处理的分轨 WAV 时，按 [资源管线说明](pipeline/README.md) 生成 `build/test_song/`，即可加载默认试听。也可以从播放器的「导入」入口选择现有的资源包发布目录。新版播放器及验收说明见 [`app/README.md`](app/README.md)。

## 早期 MVP 计划

- [x] 本地 Demucs 分离链路跑通（M1 Pro MPS，4 分半歌曲约 44 秒完成分离）
- [ ] 四轨同步播放网页（seek 不漂移验收）
- [ ] 波形可视化 + 音量/Mute/Solo 混音
- [ ] 预设模式（卡拉OK / 纯伴奏 / 鼓点提取）
- [ ] Qoder Sites 公网部署

## 目录结构

```
music-src/          分离源音频（本地资产，不入线上版）
separated/          Demucs 分离输出（四轨/六轨 wav）
需求文档.md          项目需求、赛制约束与功能范围
AGENTS.md           开发交接文档（技术栈、验收标准、禁止事项）——前端开发先读这个
```

## 本地跑分离

```bash
python3.12 -m venv .venv
.venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple demucs numpy
.venv/bin/python3.12 -m demucs -n htdemucs -d mps -o separated music-src/xxx.flac
```
