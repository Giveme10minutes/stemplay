# StemPlay

把一首歌拆成人声、鼓、贝斯、其他四个轨道，在浏览器里亲手混音的交互式体验。

- 分离引擎：[Demucs (HTDemucs)](https://github.com/facebookresearch/demucs)（MIT 协议，Meta AI）
- 前端：React + TypeScript + shadcn/ui + Web Audio API
- 用途：2026 Qoder 高校创造力大赛 · LifeHack 赛道参赛作品

## 当前进度（MVP）

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
