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
| **六轨**（人声/鼓/贝斯/吉他/钢琴/其他）已定，前端与资产均已按六轨构建 | 已确认（2026-11-17） |
| 律动视觉：AnalyserNode 实时频谱驱动，不用 MIDI | 已确认 |
| 现有 `web/` 原生 JS 版 = 可视化测试原型，**由队友迁移到 React + shadcn** | 已确认（2026-11-17） |

完整需求见 `需求文档.md`，跨窗口协作见 `handoff/HANDOFF.md`。

## 当前状态（2026-11-17）

- [x] 本地分离管线：`.venv`（Python 3.12 + demucs 4.1.0 + torch 2.15），模型已缓存离线可用
- [x] 测试曲已完成四轨与六轨分离（`separated/htdemucs/`、`separated/htdemucs_6s/`）
- [x] 原生 JS 六轨播放器原型（`web/`，commit 7e35c05）——**同步引擎设计已验证，是迁移的参考实现**
- [ ] **队友任务：迁移到 React + TS + shadcn/ui，并继续动效层**

## 队友任务：React + shadcn 迁移（按此动工）

1. **起项目**：Vite `react-ts` 模板，装 `tailwindcss @tailwindcss/vite`；shadcn 官方 Vite 接入流程（别名 `@/*`、tailwind 插件、`index.css` 只留 `@import "tailwindcss"`）
   - 实测注意：新版 shadcn CLI 参数是 `-b base/radix/aria`（组件库）和 `-p`（preset），旧教程里的 `--base-color` 已不存在
   - 本机 npm 直连官方 registry 可用（node v24 / npm 11）；Python 侧 pip 才需要镜像
2. **同步引擎必须原样移植原型 `web/app.js` 的设计**（这是全项目最难的部分，已验证可用）：
   - 单一 `AudioContext` + 每轨一个 `GainNode` 汇到 master
   - 播放/seek：**所有源用同一个 `when` 调 `src.start(when, offset)`**，样本级对齐；seek 时先停掉全部源再重建，不做"追时间"修正
   - 位置计算：`ctx.currentTime - startedAt + startOffset`，暂停时记录 `pausedAt`
   - 拖动 scrub：按下即暂停，松手恢复播放
   - Mute/Solo：`effectiveGain = soloActive && !solo ? 0 : (muted ? 0 : vol)`，用 `setTargetAtTime` 平滑
3. **验收（不变）**：seek 后六轨不错位；连续播放 1 分钟无漂移；暂停/恢复同步；控制台 0 报错
4. 波形：`scripts/make_peaks.py` 生成 `peaks.json`（自动识别轨道数），前端画双 canvas（暗层全量 + 亮层按进度裁剪）
5. 开发时音频在 `../separated/htdemucs_6s/test_song`（项目外）——Vite 需要 `server.fs.allow: ['..']` 或把资产拷进 `public/`；**部署前必须换成 CC 协议曲目并压缩**（现六轨约 290MB、解码后内存约 570MB）

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
