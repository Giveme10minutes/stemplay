# StemPlay 前端（第 1 轮：引擎和舞台骨架）

六轨拆解舞台的 React + TypeScript + Vite + shadcn/ui 实现。线上定位为**纯前端**：消费本地管线
（`pipeline/`，schemaVersion=1）产出的静态资源，全部交互用浏览器 Web Audio API 完成。
本轮交付资源适配、播放状态机、真实多轨时间轴、统一时钟、拖动、Mute/Solo/音量、跟随/全览、手机布局。
主题/动效/导入（第 2–6 轮）不在本轮范围，仅留接缝（CSS 变量、单一渲染循环、引擎与 UI 分离、顶栏 inert 按钮）。

> 版权红线：`build/test_song/` 与 `separated/` 为版权测试曲，**仅本地**。本目录源码与 `public/` 不含任何音频；
> 开发期音频由 Vite dev-server 中间件在请求时从 `build/test_song/` 读取，绝不拷贝进可部署路径。
> 部署前必须换 CC 协议曲目（见 `pipeline/README.md` 白名单）。

## 运行

```bash
cd app
npm install        # 本机 npm 直连官方 registry 可用（node v24 / npm 11）
npm run dev        # http://localhost:5173
```

前置：仓库根目录已构建本地资源（`build/test_song/current.json` 存在）。若未构建，
`/resources/current.json` 返回 503，UI 显示"本地资源未构建"。重建命令见 `pipeline/README.md`：

```bash
PY=.venv/Scripts/python.exe
$PY -m pipeline build --stems separated/htdemucs_6s/test_song --out build/test_song --config configs/test_song.json
```

资源中间件（`vite.config.ts` 内 `stemplay-local-resources` 插件）：
- `GET /resources/*` 映射到 `<repo>/build/test_song/*`（相对配置文件解析仓库根）。
- 路径越界（含编码 `%2f` 穿越）→ 403；`current.json` 每次请求现读，重建后刷新即生效。
- MIME：`.json→application/json`、`.m4a→audio/mp4`、`.wav→audio/wav`；支持 Range（206）与全量 200 + `Accept-Ranges`。
- 仅 dev-server 生效；生产构建不含该中间件，也不含音频。

其他命令：`npm run build`（tsc -b + vite build）、`npm run preview`、`npm run lint`（oxlint）。

## 架构地图

| 文件 | 职责 |
|---|---|
| `vite.config.ts` | 资源中间件（映射/越界防护/MIME/Range/503）、`@` 别名、tailwind 插件 |
| `src/lib/resources.ts` | 会话固定 release 适配：读 `current.json` 一次→pin `releaseBase`；相对路径以所属 JSON 的 URL 为基准；preview-first 加载 manifest/presets/preview/preview-beats/逐轨切片特征；逐轨 `decodeAudioData` + 进度(n/6) + 取消代次；轨道 id/标签/身份色动态映射（不写死轨表） |
| `src/lib/view.ts` | 跟随(16s 窗/42% 锚点/首尾 clamp)/全览视图数学、`fmt`/`clamp`、`DrawFn` 类型 |
| `src/audio/engine.ts` | `StemEngine`：单 AudioContext + 每轨 GainNode→master；**所有源同一 `when` 起播**（样本级对齐）；`position()=currentTime−startedAt+startOffset`；seek 停旧源统一重建；scrub 暂停/松手恢复；`effectiveGain`(mute/solo 优先)×preset×vol，`setTargetAtTime` 平滑；master 音量；无 React state |
| `src/App.tsx` | 离散 React state（playing/view/preset/mix/load）+ **单一 rAF 循环**经 refs 画 canvas/更新时间/进度/播放线；键盘(Space/←→/Shift/Home/End)；加载/重试；dev 暴露 `window.__stemplay` |
| `src/components/TopBar.tsx` | 封面占位、歌名(manifest)、"六轨拆解舞台 · 预览"、inert 外观/动效/导入（title=即将开放） |
| `src/components/Stage.tsx` | 玻璃主面板；头部(预览标签/BPM/跟随·全览/回到播放位置)；左身份列+右波形区+贯穿播放线 overlay；滚轮平移 |
| `src/components/TrackRow.tsx` | 身份色点/标签/延迟待核验徽章；M/S Toggle；桌面音量 Slider / 移动点按展开 |
| `src/components/Waveform.tsx` | 逐像素列 min(peakMin)/max(peakMax) 聚合（缩小不漏瞬态）；dim(α0.35)+bright(α1) 双 offscreen 缓存（仅尺寸/缩放/数据变化重绘）；rAF 合成+已播裁剪；pointer scrub |
| `src/components/TimeRuler.tsx` | 共享时间尺、自适应刻度(1/2/5s…)、拖拽平移 |
| `src/components/BottomBar.tsx` | 播放/暂停、整曲+片段双时间、进度 scrub、三预设(active)、主音量 |
| `src/components/ui/*` | shadcn（button/slider/toggle/tooltip/badge） |
| `src/index.css` | tailwind + 深色 token + CSS 变量（轨道身份色/玻璃/播放线/布局尺寸），第 2 轮主题接缝 |

时间契约（`pipeline/README.md` preview 节）：预览内容时间 T∈[0,durationSec]；源 offset=T+(delaySec??0)；
特征下标=clamp(floor(T×frameRate),0,nFrames−1)（用预览切片特征）；整曲时间=originSec+T；
`delayStatus=uncertain`(delaySec=null) 按 0 不补偿并标"延迟待核验"；拍点=localBeat+delaySec，仅 snapEnabled 时用。

## 验证记录（2026-11-18，headless Chrome 1440×900 / 390×844 + Qoder 内置浏览器）

方法：puppeteer-core 驱动本机 Chrome 于精确视口做定量测试与截图；Qoder 内置浏览器（browser-use MCP，
视口固定 524×557）做交互复核与 console 检查。本机验证生成的截图和结果保留在 `verification/`。仓库保留验证脚本和封面测试样本生成器。
**控制台 0 错误、0 pageerror**（仅 vite debug 与 React DevTools info）。

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 资源加载/六轨解码 | PASS | tracks=[vocals,drums,bass,guitar,piano,other] duration=40 |
| 2 | 播放启动/时间前进（真实手势） | PASS | playing=true position 0.679→前进；browser-use 8.91→9.92/1s |
| 3 | 10 次 seek/暂停/恢复无漂移 | PASS | seekΔ≤0.089/pauseΔ≤0.009/resumeΔ≤0.089（=0.05s 调度 lead+轮询粒度，非漂移） |
| 4 | seek 到 37s 继续播放 | PASS | position=37.368 playing=true；desktop-03 |
| 5 | 波形 scrub 拖动暂停/松手恢复 | PASS | before.playing→during.paused→after.playing；desktop-02 |
| 6 | Solo 人声→其余轨增益 0 | PASS | effective={vocals:1,其余:0}；desktop-04 |
| 7 | Mute 鼓组→鼓 0 其余恢复 | PASS | drums=0 vocals=1 |
| 8 | 三套预设增益过渡到位 | PASS | fullΔ0.0000/vocalΔ0.0017/rhythmΔ0.0021（≈preset.gains×vol）；desktop-05 |
| 9 | 主音量缩放 master | PASS | master=0.5 |
| 10 | 跟随平移(滚轮+标尺拖拽)→回到播放位置→恢复 | PASS | wheel/ruler→manual+按钮；点击→manual=false；desktop-06 |
| 11 | 切换全览（固定整段、播放线移动） | PASS | mode=overview；desktop-07 |
| 12 | 连续播放 60s 无中断/单调 | PASS* | 40s 完整到结尾自动停+20s 二段=60s；monotonic=true；playback-60s-samples.json |
| 13 | 键盘 Space/→+1s | PASS | spacePlay/spacePause/arrowΔ=1.000 |
| 14 | 移动 390px 布局 | PASS | identity-w=88px/row-h=64px/6 行共享尺/M·S≥44px/播放 48px；mobile-01/02 |
| 15 | 移动音量点按展开 | PASS | 6 个展开控件 |
| 16 | 控制台 0 错误 | PASS | consoleErrors=[] pageErrors=[]（两套浏览器一致） |

截图：desktop-01-idle / 02-playing / 03-seek37 / 04-solo / 05-preset / 06-pan / 07-overview / 08-after60s；
mobile-01-idle / 02-playing；browser-use-mobile-playing。

### 诚实限制（未声称已验收）

- **样本级音频对齐**由"同一 when"设计保证；时钟数学已定量验证，但**六轨听感对齐/分离音质需人工试听**（浏览器待验证项）。
- **AAC 浏览器 gapless/延迟补偿**：后端实测 5 轨 delay=0、piano uncertain→null（已标徽章、不补偿）。
  `decodeAudioData` 的浏览器 gapless 行为属后端标注的"浏览器待验证"，本轮未独立听测复核。
- **60s 连续**：预览仅 40s，无法单段 uninterrupted 60s；实测为 40s 完整（干净自动停）+20s 二段，共 60s 引擎运行、段内单调。
- **视口**：Qoder 内置浏览器视口固定 524×557 不可 resize；精确 1440×900 与 390×844 截图/定量测试由 headless Chrome 完成，
  内置浏览器用于交互与 console 复核（524px 亦触发移动布局，双重确认移动 CSS）。
- **性能**(60fps/p95≤20ms) 属第 6 轮，本轮未测；设计上无每帧 setState、静态波形缓存、DPR cap 2。
- AudioContext 于加载时创建（suspended，供 `decodeAudioData`），首次手势 `resume()`；
  与"首手势才创建"略有出入但无 autoplay 警告（console 干净），属解码必需的权衡。
## 第 2 轮：主题与材质（2026-11-18）

在已验证的第 1 轮引擎/舞台之上叠加外观层：**引擎与单一 rAF 循环零改动**；主题/背景/材质全部是离散事件
（`useSyncExternalStore` 外部存储），不进入每帧路径。策划书 §二 的三组独立控制 + 封面取色 + 持久化 + 玻璃可读性。

### 架构新增

| 文件 | 职责 |
|---|---|
| `src/lib/theme.ts` | 外观中央存储：四套预设（深海蓝紫/极光青绿/琥珀暖金/雾白银蓝，各自 accent+面板染色+渐变 stop，非机械 hue-rotate）、深/浅/跟随系统（matchMedia 实时）、自定义强调色、跟随封面开关（手选即暂停）；背景五类型与锁定语义（仅 `theme` 自动模式随曲目/封面变化）；材质三滑杆；`apply()` 把语义 token 写到 `:root`（深浅各自定义文字/面板/边线/阴影）；遮罩=亮度/繁杂度自动项+用户暗化+**面板文字对比度兜底（调遮罩不改文字色）**；localStorage `stemplay.appearance.v1` 版本化+逐字段 sanitize 兜底 |
| `src/lib/palette.ts` | 零依赖颜色数学（WCAG 亮度/对比/复合/HSL）+ median-cut 取色（96px 抽样、忽略近透明、黑白近灰返回 null 兜底）+ 背景亮度/繁杂度粗测 + 按模式校正强调色（浅 ≤0.42 明度保 ≥3:1）+ 封面派生渐变 |
| `src/lib/idb.ts` | ~50 行 IndexedDB blob wrapper（`custom-bg` / `cover-art`）；失败降级会话内有效并 toast，绝不持久化失效 blob URL |
| `src/components/BackgroundLayer.tsx` | 全屏固定背景：底色+渐变（2-4 stop 位置随数量、角度走注册变量）+纯色+图片（object-fit/position/zoom/blur）+自动遮罩+提亮层+`--sp-fx` 装饰辉光；无图回退主题渐变 |
| `src/components/AppearanceDrawer.tsx` | 设置抽屉：桌面右侧 / 移动底部（matchMedia 767px）；三组控制+封面取色入口（**仅提取主题素材，明确不等于导入歌曲**）；手写 shadcn 风格控件 |
| `src/components/ThemeToast.tsx` | 诚实提示（会话内有效/恢复默认/缺封面等） |
| `src/components/ui/sheet.tsx` / `ui/switch.tsx` | radix Dialog 焦点陷阱/Esc/aria + 280ms 转场；Switch 移动热区 44px |
| `src/index.css` | `@property` 注册 30+ token 为可插值类型 + `:root` 400ms ease-out 过渡（材质 200ms）→ **连续切换从当前计算值续接、可中断、不排队**；`.glass-panel` 消费 `--glass-blur`(16-24px)/`--glass-shadow`；新增 `.panel-solid`（舞台内浮层不嵌套 blur）；reduced-motion 关过渡 |
| 既有组件 token 化 | Stage/TrackRow/Waveform/BottomBar/TopBar 的 `white/*`、`black/*` 硬编码换语义 token（浅色可读）；TrackRow 移动音量浮层改 `.panel-solid` 去嵌套 blur；TimeRuler 刻度色随模式重绘（key 含 mode）；TopBar「外观」启用、封面占位换提取封面；播放线芯/辉光随模式与 `--sp-fx` |
| `src/App.tsx` / `main.tsx` | 首帧前 `initAppearance()` 防闪烁；抽屉开关；抽屉打开时播放器键盘让位；`window.__stemplay.theme` 暴露 store 门面 |

依赖新增：`music-metadata`（MIT，**动态 import 代码分割**，仅封面提取时加载）；dev：`puppeteer-core`（验证脚本驱动本机 Chrome）。

### 验证记录（headless Chrome 1440×900 / 390×844，35/35 PASS，控制台 0 错误 0 pageerror）

复跑：`node verification/make-assets.mjs && node verification/round2-verify.mjs`（需 `npm run dev`）。
证据：`verification/round2-*.png`、`round2-results.json`、`round2-transition-samples.json`。
Qoder 内置浏览器复核：抽屉开合/浅色/主题/渐变/播放交互正常、console 仅 vite debug 与 DevTools info。

| # | 验收项 | 结果 | 证据/数值 |
|---|---|---|---|
| 1 | 默认深色 #0B1020、玻璃 blur∈[16,24] | PASS | blur=20.8px；round2-01 |
| 2 | 浅色独立 token（乳白面板/深文字） | PASS | bg=#eef2f8 fg=#1c2536 无 .dark；round2-02 |
| 3 | 四套主题 accent 互异 + 手选暂停跟随封面 | PASS | accents 见 results.json；round2-03 |
| 4 | 自定义强调色覆盖 | PASS | 存 #ff3d81 → 浅色校正 #d6004b |
| 5 | 纯色背景 | PASS | opacity=1 color=#7c3aed；round2-04 |
| 6 | 3-stop 渐变 + 角度 90° | PASS | computed linear-gradient(90deg, 用户三色)；round2-05 |
| 7 | 亮/繁杂自定义图自动加深遮罩 | PASS | scrim 0.202→0.700（lum 0.64/busy 0.25）；round2-06 |
| 8 | 模糊/缩放/位置/暗化/提亮/包含 | PASS | blur(20px)/scale1.5/50% 0%/scrim↑/白叠 0.3/contain |
| 9 | 材质三滑杆（玻璃/明暗/特效） | PASS | glass70→面板 α、brightness40→0.91、fx30→blur18.4px |
| 10 | 刷新恢复全部偏好 + IndexedDB 图片 | PASS | prefs 深相等、blob: URL 恢复、blur(8px) 保留；round2-07 |
| 11 | 损坏 localStorage JSON 兜底 | PASS | 回退 ocean 默认 |
| 12 | palette 单测（合成封面走同一函数） | PASS | 取色非空、黑白/0 尺寸→null、对比 dark7.0/light3.6 |
| 13 | 无封面音频 → 诚实提示保持主题 | PASS | 合成无封面 mp3 + 真实 flac 均 missing |
| 14 | 损坏/非音频输入 → 兜底不崩溃 | PASS | 「封面解析失败（Guessed MIME-type not supported…）」 |
| 15 | 内嵌 front cover 提取（music-metadata parseBlob+selectCover） | PASS | 合成 ID3v2.3 APIC mp3 → palette+缩略图；round2-08 |
| 16 | 重开跟随封面 → accent 由封面驱动 | PASS | #8fb3d9→#f97e1f |
| 17 | 封面用作背景 | PASS | bg.type=cover 且 img.src=cover.url；round2-09 |
| 18 | 跟随系统实时明暗 | PASS | emulateMediaFeatures light/dark → mode 跟随 |
| 19 | 恢复默认三组 | PASS | prefs==DEFAULT_PREFS + toast |
| 20 | 快速连续切换可中断/续接/不排队 | PASS | 40ms 采样 maxΔ=64（无跳变）、尾段稳定、11 个中间值；samples.json |
| 21 | Esc 关闭 + 焦点陷阱（15×Tab 不出抽屉） | PASS | headless 真实键事件 |
| 22 | 用户锁定背景不被 seek/刷新覆盖 | PASS | solid 保持；锁定语义=仅 theme 自动 |
| 23 | 回归：播放/seek37/Solo/预设/键盘 | PASS | pos37≈37、solo 增益 {vocals:1,其余:0}、preset=full、Space/→ 正常；round2-10 |
| 24 | 移动 390×844 底部面板 + 热区≥44px | PASS | side=bottom w=390 bottom=844、无 <44px 按钮；round2-11/12 |
| 25 | 控制台 0 错误（桌面+移动全程） | PASS | consoleErrors=[] pageErrors=[] |

### 诚实限制

- **真实曲目无内嵌封面**：`music-src/test_song.flac` 实测 status=missing（B 站源未带 PICTURE）。
  「提取成功」路径用自合成的 ID3v2.3 APIC（front cover）mp3 走**同一** parseBlob/selectCover/取色链路验证；
  缺封面/损坏输入兜底均实测。未声称真实曲目取色成功。
- **内置浏览器 press_key 的 Escape 未送达页面**（harness 限制）；Esc/焦点陷阱以 headless Chrome 真实键事件为准；
  内置浏览器复核了开合（X 按钮）、主题/背景切换与播放、console 干净。内置视口本轮为 1026×636（桌面右抽屉）。
- 浅色下未播波形 dim 层 α0.35 偏淡（沿用第 1 轮双缓存设计），身份色点/标签/已播亮层保证可区分；第 3 轮光带会再增强。
- 封面取色只在导入/恢复时运行；`--sp-fx` 本轮仅驱动辉光/玻璃模糊，动效语义第 3-4 轮接入。
- 对比度兜底用背景均色近似（图片实测均色/渐变 stop 均值），非逐像素 WCAG 审计；正文对面板实测 ≥4.5 由兜底循环保证。
- 60s 无漂移/听感对齐等第 1 轮限制 unchanged（引擎未动，本轮仅回归子集复测）。

## 第 3 轮：基础音画（光带穿梭 / 接触波纹 / 频带呼吸，2026-11-18）

在单一 rAF 循环之上叠加每轨独立 overlay canvas（`pointer-events-none`，不挡 scrub）；静态波形双缓存纪律不动。
数据映射严格按设计文档 §四：`rms`/`onset` 为幅度量 ×g，`low/mid/high` 为均方量 ×g²（g=`effectiveGain×masterVol`），
共享 `display.*Ref` 不逐轨归一；静音/solo 抑制时 g=0 → 全部视觉收敛。

### 架构新增

| 文件 | 职责 |
|---|---|
| `src/lib/fx.ts` | 模块级 `fxStore` 单例（同 theme.ts 模式）：每轨包络（attack 60ms/release 250ms，按真实 dt 指数积分）+ 波纹/粒子数组 + 滞回/触发常量 + `snapshot()` 供验证；`matchMedia` 实时读 `prefers-reduced-motion`（关波纹/粒子/流光/sparkle，保留播放线与亮度反馈）与移动端粒子硬上限 40（桌面 120） |
| `src/components/FxOverlay.tsx` | 每轨叠加层：A 光带（播放线附近已播柔亮/未来更暗 + 播放中流光细纹）；能量段条=rms 显示值双阈值滞回（进 0.45/出 0.22）；B onset 区间跨越（整数帧 `prev<i<=cur`，非浮点相等）触发波纹环+水平扩散粒子（每帧每轨≤1 事件，全局粒子上限）；C 低频→宽幅柔光起伏、中频→段条厚度/亮度、高频→sparkle；seek/后台返回检测（pos 回退或 >max(0.25,dt×4) 跳变）清空波纹/粒子/包络不补放 |
| `src/App.tsx` | rAF 循环计算真实 dt（钳 0..0.1）与秒级时钟，经 `DrawFn(pos,t0,t1,dt,now)` 下发；订阅 theme store 同步 `--sp-fx`；加载/切歌 `resetAll()`；dev 暴露 `window.__stemplay.fx` |
| `src/components/Stage.tsx` / `src/lib/view.ts` | 波形行外包 `relative` 容器承载叠加层；`DrawFn` 增加 dt/now 参数 |

### 验证记录（headless Chrome 1440×900，12/12 PASS，控制台 0 错误 0 pageerror）

复跑：`node verification/round3-verify.mjs`（需 `npm run dev`）。证据：`verification/round3-0*.png`、`round3-results.json`。
采样器逐帧 `getImageData` 六张叠加 canvas 亮点数 + `fx.snapshot()`（验证脚本内 rAF，非产品代码）。

| # | 验收项 | 结果/数值 |
|---|---|---|
| 1 | 6 张叠加 canvas 挂载 | canvases=6 stems=6 |
| 2 | 播放中叠加层持续动画 | 244 帧 nonEmpty=100%、changed=96.7%、逐帧亮点总差 32425 |
| 3 | onset 真实触发波纹+粒子 | 2.6s 内 spawnedR=63/spawnedP=171，峰值粒子 42 |
| 4 | 粒子硬上限 | max=42 ≤ 120 |
| 5 | 静音鼓组（真实 M 按钮）音画耦合 | 鼓包络尾段 0.0006→0，可听轨峰值 0.892 |
| 6 | 主音量 0（真实滑杆最左） | masterVol=0、全轨包络 0.0012、叠加亮点 0（播放态 37238） |
| 7 | 向后 seek 无补放 | 单帧 spawn≤2（上限 6/帧）、seek 帧粒子=0、峰值 27 ≤ 120 |
| 8 | 暂停收敛 | 包络 0.0051→0、粒子/波纹=0、播放线保留 |
| 9 | reduced-motion（emulateMediaFeatures 实时） | reduced=true、spawn=0、粒子=0、亮度反馈 nonEmpty=100% |
| 10 | 控制台 0 错误 | consoleErrors=[] pageErrors=[] |

### 诚实限制

- 波纹/粒子/呼吸的**观感**以截图为准（round3-01/02/03），未做逐帧像素级美学审计；浅色模式下叠加层用 source-over 合成（深色用 lighter），亮度反馈保留但未单独截图验收。
- `beats.snapEnabled` 的拍点脉冲属第 4 轮范围；本轮按设计走 energy/onset 回退，未消费 beats。
- 移动端 40 粒子上限为运行时 matchMedia 实现，本轮 headless 仅桌面视口复测（120 上限实测）；移动上限第 6 轮动效验收覆盖。
