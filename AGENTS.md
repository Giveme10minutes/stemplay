# AGENTS.md — StemPlay 项目上下文与交接说明

> 本文件供 Qoder 及任何 AI 编码代理在本仓库工作时自动读取，也是给前端开发队友的交接文档。首次参与请通读。

## 项目一句话

把一首歌拆成人声/鼓/贝斯（/钢琴/吉他）等多个轨道，在浏览器里亲手同步播放与混音的交互式体验——2026 Qoder 高校创造力大赛 LifeHack 赛道作品。

## 硬性约束（最高优先级）

1. **截止 2026-11-30 18:00**：作品须部署到 Qoder Sites 公开访问，并在天池赛题页论坛发五部分介绍帖
2. **线上版是纯前端**：无任何服务端、无 API 依赖。分离好的 wav 作为静态资产托管，全部交互用浏览器 Web Audio API 完成。**不要把"上传歌曲实时分离"加回线上范围**（函数环境跑不动 GPU 模型）
3. **版权红线**：`music-src/` 与 `separated/` 下的测试音频来自 B 站版权内容，仅供本地评估分离质量，**绝不能进入 Qoder Sites 部署包**。线上资产必须换成 CC 协议曲目
4. **开发须在 Qoder 内完成**（大赛硬性要求，作品帖需附使用过程截图凭证），保留过程记录

## 架构决策（已定，勿翻案）

| 决策 | 状态 |
|---|---|
| 定位：预置 3-5 首精雕歌曲的"音乐体验玩具"（目标 A） | 已确认 |
| 线上纯前端；Demucs 只是本地资产生产工具 | 已确认 |
| 前端 React + TypeScript + shadcn/ui + Web Audio | 已确认 |
| 四轨 vs 六轨：待试听定；前端按"每首歌元数据声明声部数"设计，兼容两者 | 待定 |
| 律动视觉：AnalyserNode 实时频谱驱动，不用 MIDI | 已确认 |

完整需求见 `需求文档.md`。

## 当前状态（2026-11-17）

- [x] 本地分离管线：`.venv`（Python 3.12 + demucs 4.1.0 + torch 2.15），模型已缓存离线可用
- [x] 测试曲已完成四轨与六轨分离（`separated/htdemucs/`、`separated/htdemucs_6s/`）
- [ ] **前端从零开始——这是队友的战场**

## 前端任务与验收（MVP 顺序）

1. **Vite + React + TS 起项目**，shadcn/ui 接入
2. **多轨同步播放引擎**（最核心、最难）：
   - 四轨 wav 各自 `AudioBufferSourceNode`，同一 AudioContext
   - 验收 A：播放中拖动进度条 seek，四轨不错位
   - 验收 B：连续播放 1 分钟无漂移（M1 上用 `audioContext.currentTime` 对齐）
   - 验收 C：暂停/恢复后仍同步
3. **每轨 UI**：彩色波形、音量滑条、Mute/Solo
4. **预设模式**：卡拉OK（人声 Mute）、纯伴奏、鼓点提取
5. **后续**：AnalyserNode 律动背景、歌曲切换

前端先加载 `separated/htdemucs/test_song/` 下的四轨开发（本地文件名可硬编码），版权合规放到部署阶段再换正式曲目。

## 本地命令备忘

```bash
# 跑分离（新歌）：
.venv/bin/python3.12 -m demucs -n htdemucs -d mps -o separated music-src/xxx.flac   # 四轨
.venv/bin/python3.12 -m demucs -n htdemucs_6s -d mps -o separated music-src/xxx.flac # 六轨

# pip 一律走镜像（本机直连 PyPI 会 SSL 失败）：
pip install -i https://pypi.tuna.tsinghua.edu.cn/simple <pkg>
```

## 禁止与边界

- 不提交 `.venv/`、`.DS_Store`、构建产物（已 gitignore，提交前跑 `git status` 检查）
- 不改 `需求文档.md` 的既定决策；有异议先在群里提出
- 一次提交做一件事；功能没验收完不勾选任务清单
- 失败/未完成的项如实标注，不静默绕过

## 交付证据要求

每个功能完成时给出：可复现的验证步骤（如"第 37 秒拖到 2:00，四轨齐奏无错位"）+ 控制台无报错截图。大赛先例的质量线是"桌面与手机控制台 0 报错"。
