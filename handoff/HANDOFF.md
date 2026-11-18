# StemPlay 工作交接文档

> 多窗口协作用：新会话/新窗口开工前先读这份文件。改动后请更新对应小节并注明日期。

最后更新：2026-11-18

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
- **本地资源生产管线第 1–4 轮全部完成（2026-11-18，Windows 本机，v0.4.0）**：
  - 新增 `pipeline/` 包，统一入口 `python -m pipeline <manifest|features|beats|presets|build|preview>`；契约、前端接入字段表与命令详见 `pipeline/README.md`。
  - 第 1 轮：轨道自动发现 + WAV 校验（可读/格式/六轨长度一致）+ 版本化 manifest（schemaVersion=1，含哈希/授权/缺失资源挂载）。
  - 第 2 轮：每轨 50Hz 特征（rms/低中高频能量/起音谱通量/波形峰值），时间戳=窗中心；显示缩放整曲共享，弱音串音轨（piano）不会被拉满。
  - 第 3 轮：节拍（鼓轨 onset + 自相关/梳状滤波 + 逐帧 DP，非伪造等间隔）→ bpm=136.67（librosa 交叉 136.36），579 拍点 99.7% 相差 <0.1s；启发式评分 0.5686 → snapEnabled=true（**不是概率**，不可靠时自动降级不吸附）；三套混音预设（完整合奏/人声聚光/节奏主场），整曲实测叠加峰值统一缩放至 ≤0.95，保持声部比例，缺失轨退化。
  - 第 4 轮：一键 `build`（分阶段缓存：键=内容+参数+版本哈希，命中前验证 sha256，损坏自愈）→ 统一 40s 预览裁剪（能量自动选段、hop 网格吸附）+ AAC 压缩 + 逐轨解码回检（delay=0、corr≥0.968）+ 特征精确切片/拍点平移 → 自动质检（13 pass/0 fail，阻断性错误禁止发布）→ 原子发布 `releases/<id>` + `current.json` 指针。40s@128k 预览音频 **3.74MB**（目标 ≤10MB 达标）；仅预览模式 `preview --preview-sec 45 --bitrate 96k` → 3.16MB。
  - 验证：`python -m unittest discover -s tests -t .` **38/38** 通过；缓存复跑全命中、`--fail-at preview` 失败重跑恢复、m4a 篡改自愈均实测；`web/`、`separated/`、`scripts/make_peaks.py`、`music-src/` 零改动。
  - 依赖：运行时仅 NumPy；预览需 ffmpeg（已装 `imageio-ffmpeg` 自带二进制）；librosa 仅可选交叉验证。`.venv/Scripts/python.exe`（Windows 重建）。
  - `build/` 已 gitignore；测试曲授权 unverified → **发布白名单为空**，全部派生资源仅本地，禁止进公开部署包。
- **六项数据可信度修复完成（2026-11-18，v0.5.0，三轮并行修复+集成）**：
  - ① 立体声不再均值下混：特征逐声道分析后能量合并（反相 L=x/R=-x 的 rms 从假 0 恢复为 0.531）；预设逐声道测峰、按取整后的导出增益复核收敛，真实六轨 full/rhythm 独立复核 L/R 均 ≤0.95；质检流式重读源 WAV 独立复核峰值（不信任 busPeak 字段）。
  - ② AAC 延迟估计重写：能量包络粗定位+波形细化+细包络消歧+段落投票；440/220Hz 周期素材假延迟（902/8018 样本）消除，实测 lag=0 corr=0.9999；不可消歧 → delayStatus=uncertain、delaySec=null（前端不补偿、标记待核验），不再阻断构建。
  - ③ 节拍少起音/短曲降级不再 KeyError，scoreComponents 完整、后续阶段继续。
  - ④ sync_manifest 挂载按参数+上游 SHA 严格失效判定（改 frameRate 后旧 beats 立即 missing）；preview.json 新增 upstreamSha256 指纹。
  - ⑤ 源目录迁移：缓存键不含路径，build 后刷新 audio.path 投影——特征缓存仍按内容命中，路径不再悬空；质检新增 source-audio-paths 兜底。
  - ⑥ 发布目录不可覆盖：同秒同报告复用完整包，否则唯一后缀；先切 current 再清理，失败保留旧包。
  - 验证：**78/78 测试通过**（原 38 + 新增 40）；真实六轨 v0.5.0 重建：bpm=136.68/579 拍点、预览 3.74MB、5 轨 delay=0 measured + piano uncertain（warn）、质检 0 fail。复现脚本 `build/verify_issues.py`（gitignored，仅本地）。
  - 前端注意：delaySec 可能为 null（uncertain）→ 按 0 处理并标记待核验；presets 新增 channelPeaks；features channelMix="per-channel-energy-merge"。
- **第 0 轮后端收口完成（2026-11-18，v0.6.0，A/B/C 三项遗留修复）**：
  - A：presets.json 新增 `sourceAudioSha256`（逐轨源音频哈希），sync 据此严格失效——源音频内容变化后只重跑 manifest/features，旧预设立即 missing（原仍 ready、busPeak 失真）。
  - B：`refresh_audio_paths` 重写 base 后同步 `refresh_entry_artifact` 刷新缓存清单摘要——源迁移后**连续两次 preview_only** 均成功、第二次五阶段全命中（原第二次报"上游缓存无效"）。
  - C：发布复用改按**完整包内容指纹**（全部文件 大小+sha256）判定——同秒同报告但源迁移后不再复用路径过时的旧包，走唯一后缀；current 包内音频路径全部可解析。
  - 附带：Windows 杀毒/索引器短暂持有新目录句柄 → 目录改名偶发 PermissionError，publish 加有限退避重试（8 次）。
  - 验证：**86/86 测试通过**（78 + 新增 8，R3 旧"同秒复用"测试按新契约更新）；复现脚本 `build/verify_abc.py` 三项闭环；真实六轨 v0.6.0 重建结果与 v0.5.0 一致（bpm=136.68/579 拍点/预览 3.74MB/质检 0 fail），重跑全命中。
  - 前端注意：presets.json 顶层多了 sourceAudioSha256 字段（不影响 gains/transitionSec 用法）；PIPELINE_VERSION=0.6.0 使旧缓存全部失效属预期。
  - 依据策划书（`StemPlay_前端改造策划书_分轮执行.txt`）第 0 轮到此收口；接下来第 1 轮引擎与舞台骨架、第 2 轮主题与材质。
- **前端第 1 轮完成（2026-11-18，app/，React+TS+Vite+shadcn）**：
  - `app/` 新工程（web/ 原型零改动）：dev 中间件 `/resources/*` 只读 `build/test_song/`（越界 403/SPA 兜底不泄文件，Range 206）；会话固定 current.json 的 release；预览优先加载六轨 m4a + 切片特征 + 平移拍点。
  - 引擎 `app/src/audio/engine.ts` 原样移植原型同步设计：单一 AudioContext、全源同一 when 起播（延迟只在源 offset 补偿一次）、seek 停旧重建、scrub 按下暂停松手恢复、solo 优先、预设 transitionSec/3 平滑。
  - 舞台：共享时间尺 + 六轨波形（peakMin/peakMax 逐像素聚合、暗/亮双层 canvas）、贯穿播放线、跟随(16s 窗/42%)/全览、手动平移暂停跟随 + "回到播放位置"、底栏播放/双时间标/进度/三预设/主音量、键盘 Space/方向键/Home/End、手机 390px 共享尺 + ≥44px 热区。
  - 主会话独立复核（非仅代理自报）：10 次 seek/暂停/恢复时钟一致；AnalyserNode 实测 solo 时鼓轨 RMS 0.0721→0、预设同位置比值 0.224≈目标 0.22（内嵌浏览器 AudioParam.value 不反映自动化，须用真实输出测量）；控制台 0 报错；桌面/手机截图目视符合规格。证据 `app/verification/`。
  - 跑法：`cd app && npm install && npm run dev` → http://localhost:5173（需先有 build/test_song）。详见 `app/README.md`。
- **前端第 2 轮完成（2026-11-18，app/，主题与材质）**：
  - `app/src/lib/theme.ts` 中央外观存储：`useSyncExternalStore` 离散事件驱动，不进 rAF 循环；四预设（深海蓝紫/极光青绿/琥珀暖金/雾白银蓝）× 深/浅/跟随系统；自定义强调色；封面取色（music-metadata `parseBlob/selectCover` → median-cut 96px 调色板，黑白封面降级保持默认）；背景五类（跟随默认/纯色/渐变/专辑封面/自定义图片，图片模糊/缩放/位置/压暗）；材质三滑杆（玻璃/明暗/特效）；自动遮罩按背景亮度/繁杂度 + 面板文字对比度 ≥4.5 兜底；`@property` 注册变量 400ms 缓出可中断过渡，`prefers-reduced-motion` 关过渡；偏好 `localStorage stemplay.appearance.v1 = {v:1,prefs}` 迁移安全解析，图片/封面 blob 存 IndexedDB。
  - 主会话独立复核（非仅代理自报）：抽屉三组控制齐全；切浅色+琥珀后 inline/computed/body/colorScheme 全正确（注意 `--accent` 是 shadcn surface 色，品牌色在 `--sp-accent/--primary`，采样别采错；400ms 过渡中间态读数不代表终值）；浅色琥珀 surface 理论值与实测逐通道吻合；重载后偏好完整恢复（LS↔state 一致）；选纯色时渐变层 opacity 0、浅色模式深色纯色自动遮罩 0.604 保对比；控制台 0 报错。代理自检 35/35（headless Chrome，含自定义图/封面 IDB 持久化、合成 ID3 mp3 取色路径）。证据 `app/verification/round2-*`。
  - 诚实限制：真实测试 FLAC 无内嵌封面，取色链路用合成 ID3 mp3 验证；浅色模式波形暗层偏淡（可读，后续轮可微调）；内嵌浏览器截图不可用，截图走 headless；复核期间观察到页面被外部操作（抽屉被关闭、主题被切回 ocean），疑似用户预览试用，不影响机制结论。
  - 策划书第 0/1/2 轮到此收口；第 3 轮起动效层，待用户指示。
- **前端第 3 轮完成（2026-11-18，app/，基础音画）**：
  - `app/src/lib/fx.ts`（模块单例 fxStore，高频值永不进 React state）+ `app/src/components/FxOverlay.tsx`（每轨独立叠加 canvas，pointer-events-none，静态波形缓存纪律不动）。
  - A 光带穿梭：已播柔亮/未来暗 + 播放线附近流动光带与流光细纹；能量段条双阈值滞回（进 0.45/出 0.22）。B 接触波纹：onset 按整数帧区间跨越触发（prev<i<=idx，绝无浮点相等），波纹环+沿轨水平扩散粒子，寿命 220-340ms，硬上限桌面 120/移动 40。C 频带呼吸：attack 60ms/release 250ms 按真实 dt 指数积分；low→宽幅柔光、mid→段条厚度/亮度、high→sparkle。
  - 音画耦合严格按契约：rms/onset 幅度量 ×g÷rmsRef/onsetRef；low/mid/high 均方量 ×g²÷bandRef；g=effectiveGain×masterVol（mute/solo 抑制为 0 → 视觉收敛）；共享 ref 不逐轨归一。seek/后台返回位置回退或大跳变 → 清空波纹/粒子/包络，不补放历史事件。reduced-motion 实时 matchMedia：关粒子/波纹/流光/正弦起伏，保留播放线与亮度反馈。
  - 主会话独立复核：tsc --noEmit 退出 0；headless 复跑 12/12（静音鼓组 env 尾 0.0007 vs 可听峰 0.8928；主音量 0 全轨 env 0.0012、叠加亮点 0；seek 单帧 spawn≤2、无爆量；reduced 0 spawn；控制台 0 报错）；截图目视光带/波纹/明暗分层真实存在。证据 `app/verification/round3-*`。
  - 第 4 轮：高能冲击/持续场景/聚光包络/动效档位。
- **前端第 4 轮完成（2026-11-18，app/，高能与聚光）**：
  - `engine.ts` 仅增量：`gainEnv` 记录 + 只读 `visualGain(id,nowSec)`（解析镜像 setTargetAtTime 指数，from 取当前值→可中断续接）；音频调度零改动。
  - `app/src/lib/impacts.ts`：`buildImpacts` 加载时一次性算候选（120ms 平滑能量 ≥p87、较 2s 前 ≥1.25×、onset ≥p95、共享尺度下限 0.4 防弱轨串扰 qualifies）；`stepImpacts` 在 App 单 rAF 内：gv 包络→动效乘子平滑→冷却 1.0s/轨 + gv 门控 + 运行时共享下限复核→同帧多轨合并为一次主冲击→持续场景状态机（共享能量 ≥p90 持续 2s 进 / <p75 持续 1.5s 出，flowMult 硬钳 ≤1.2）；seek/后台返回游标快进不补放、场景计时清零。
  - `app/src/lib/motion.ts` + `MotionPanel.tsx`：master 开关 + 安静/轻柔/标准/增强，`stemplay.motion.v1` 持久化；TopBar 动效按钮启用（导入仍禁用待第 5 轮）；面板含诚实声明文案（局部能量检测≠副歌/乐器识别）。
  - `FxOverlay` 改用 gv（聚光渐暗不突跳、行不跳）；震动为 canvas 内部 translate（≤3px），控件零位移；`BackgroundLayer` 辉光漂移经 registerDraw 挂同一 rAF（无第二个循环），场景光晕/流速受 reduced/master/安静档闸门。
  - 主会话独立复核：tsc 0；round4 headless 复跑 23/23（冲击 4 次@8.46/9.84/11.10/14.18 与离线特征模拟一致、同轨最小间隔 1.378s；双轨同帧强制→触发+2/主+1；聚光偏差 0 vs 解析指数 tau=0.2、非聚焦轨 gv 0.22 可见、行 0px；控件 bbox 0px；场景 testOverride 单元驱动——40s 片段自然播放无 ≥2s 的 p90 段，离线模拟证实，maxFlow 1.191≤1.2；安静 0/0/0/0；增强 shake 2.72≤3 且粒子>标准；master 关保留播放线+明暗；重载恢复轻柔；reduced 全空间效果 0；12 次连切 maxGap 129.5ms）；round3 回归 12/12；控制台 0 报错。证据 `app/verification/round4-*`。
  - 诚实限制：持续高能场景在本 40s 片段不自然触发（用暴露钩子单元验证）；合并以强制同帧证明；headless 帧时（p95 22-44ms，软件渲染）不代替真机 60fps 实测（第 6 轮）。
  - 策划书第 3/4 轮到此收口；第 5 轮导入与曲库、第 6 轮整体打磨待用户指示。

## 下一步（按优先级）

1. ~~用户试听四轨 vs 六轨，定正式版本~~ → 已定六轨（见已定架构决策 6）。
2. ~~管线第 3、4 轮~~ → 已完成（2026-11-18），见"当前状态"。
3. **前端接入离线资源**（React 迁移队友）：按 `pipeline/README.md` 的字段表与取值示例接 features/beats/presets/preview；注意预览需按 delaySec 补偿、snapEnabled=false 时不做拍点吸附；浏览器端待验证项（decodeAudioData gapless、六轨同步、移动端内存）在表中已列出。
4. 选 CC 协议歌曲 3-5 首 → 重新分离（Mac/MPS 环境）→ 同一条 `build` 命令生产资源 → 在 `configs/<id>.json` 填 confirmed + SPDX → 白名单生效后方可部署（现四轨约 190MB、六轨约 290MB，线上整曲音频仍需另行压缩，管线预览已解决试听体积）。
5. 部署到 Qoder Sites 并设公开访问（比赛硬性要求）。
6. 作品帖五部分撰写（天池论坛），附 Qoder 使用过程截图。

## 已知坑

- `decodeAudioData` 后内存占用大（六轨解码后约 570MB），线上版必须压缩音频。
- 版权音频已在 git 历史中；将来转正式作品仓需重写历史或另起新仓。
- Demucs 运行需手动确认 numpy 已装（曾缺失）。
- **Windows 本机（2026-11-18 实测）**：清华 pip 镜像对 pip 返回 "versions: none"（curl 却通），**阿里云镜像可用**：`pip install -i https://mirrors.aliyun.com/pypi/simple/ <pkg>`；AGENTS.md 里 `.venv/bin/python3.12` 与 `-d mps` 是 Mac 环境写法，本机用 `.venv/Scripts/python.exe`（Python 3.13），无 MPS/GPU，未装 demucs/torch，管线不依赖它们。
- ffmpeg 管道输出 WAV 的 data chunk 大小是占位值，解码回检须按实际字节数算帧数（管线已处理）。
- 本机 ffmpeg（imageio-ffmpeg v9.0.2）对 m4a 编码延迟实测 0 样本（遵循 gapless edit list），浏览器 decodeAudioData 行为可能不同，前端仍按 delaySec 补偿。
- Windows 目录改名（os.replace）偶发 PermissionError：杀毒/索引器短暂持有刚写入目录的句柄；publish 已加有限退避重试，其它代码做目录级原子操作时留意。

## 环境/命令速查

- 分离（原 Mac 环境）：`.venv/bin/python -m demucs --mp3 ...`（实际命令见需求文档.md / README.md）
- 峰值生成（旧脚本，未改动）：`.venv/bin/python scripts/make_peaks.py [stems目录] [输出json]`
- **资源管线（Windows 本机，一键）**：`.venv/Scripts/python.exe -m pipeline build --stems separated/htdemucs_6s/test_song --out build/test_song --config configs/test_song.json`
- 仅预览/失败重跑：同命令加 `--preview-sec 45 --bitrate 96k` 用 `preview` 子命令；build 失败后原命令重跑即自动续算（详见 `pipeline/README.md`）
- 管线测试：`.venv/Scripts/python.exe -m unittest discover -s tests -t .`（86 用例）
- 前端本地跑：项目根 `python3 -m http.server 8765` → `/web/index.html`
