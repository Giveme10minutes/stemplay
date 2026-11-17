# StemPlay 工作交接文档

> 多窗口协作用：新会话/新窗口开工前先读这份文件。改动后请更新对应小节并注明日期。

最后更新：2026-11-17

## 项目一句话

StemPlay——音乐多轨分离演示平台，参加 2026 Qoder 高校创造力大赛 LifeHack 赛道。线上版为纯前端（预分离 wav + 浏览器 Web Audio 同步混音），价值点："亲手把人声抽掉那一刻的惊讶感"。

## 硬性时间线

- 作品发布截止 **2026-11-30 18:00**（剩余约 13 天）
- GitHub 公开仓：https://github.com/Giveme10minutes/stemplay（账号 Giveme10minutes，main 分支）
- 未决：天池报名组队、全员实名认证、阿里云大学生认证是否完成（均有截止风险）

## 已定架构决策（不要再推翻）

1. 线上版纯前端：预分离轨道 wav 静态托管 + Web Audio 同步混音；Demucs 只作本地分离工具（MPS 上 4.5 分钟歌约 44 秒）。
2. "上传任意歌曲实时分离"明确移出比赛范围。
3. 目标 A（音乐体验玩具）定稿；目标 B（上传自己的歌）只写进作品帖结尾作愿景。
4. 律动/动效走 AnalyserNode 实时分析，不用 MIDI。
5. 版权测试曲仅限本地/测试仓，**线上版必须换 CC 协议歌曲**（优先 CC BY）。
6. **四轨 vs 六轨：已定六轨**（2026-11-17 用户在另一窗口决定，前端与分轨资产均已按六轨构建）。
7. **技术栈定案：正式前端 = React + TypeScript + shadcn/ui**；现有 `web/` 原生 JS 版定性为"可视化测试原型"，由前端队友负责迁移（2026-11-17 用户决定）。迁移要点、实测命令与验收标准见仓库 `AGENTS.md` 的"队友任务"一节。

## 当前状态

- 本地分离链路已跑通（.venv，Python 3.12 + demucs 4.1.0）。
- **六轨播放器前端已完成并推送 GitHub（commit 7e35c05）**：
  - `web/`：六轨同步播放页（人声/鼓组/贝斯/吉他/钢琴/其他），共享 AudioContext 时钟保证 seek 不漂移，每轨波形 + 音量 + Mute/Solo，点击/拖动波形跳转。
  - `scripts/make_peaks.py`：从分轨 wav 生成 `web/peaks.json` 波形峰值数据（自动识别轨道数，默认读 `separated/htdemucs_6s/test_song`）。
  - 本地试听：项目根目录 `python3 -m http.server 8765`，访问 `http://localhost:8765/web/index.html`。
- 分轨输出：`separated/htdemucs/test_song`（四轨）、`separated/htdemucs_6s/test_song`（六轨）。

## 下一步（按优先级）

1. ~~用户试听四轨 vs 六轨，定正式版本~~ → 已定六轨（见已定架构决策 6）。
2. 动效层：每轨挂 AnalyserNode 实时频谱/律动动画（比赛亮点）。
3. 选 CC 协议歌曲 3-5 首，重新分离，压缩音频（现四轨约 190MB、六轨约 290MB，线上需降体积：降码率或单声道）。
4. 部署到 Qoder Sites 并设公开访问（比赛硬性要求）。
5. 作品帖五部分撰写（天池论坛）。

## 已知坑

- `decodeAudioData` 后内存占用大（六轨解码后约 570MB），线上版必须压缩音频。
- 版权音频已在 git 历史中；将来转正式作品仓需重写历史或另起新仓。
- Demucs 运行需手动确认 numpy 已装（曾缺失）。

## 环境/命令速查

- 分离：`.venv/bin/python -m demucs --mp3 ...`（实际命令见需求文档.md / README.md）
- 峰值生成：`.venv/bin/python scripts/make_peaks.py [stems目录] [输出json]`
- 前端本地跑：项目根 `python3 -m http.server 8765` → `/web/index.html`
