# StemPlay 本地资源生产管线

把已分离好的分轨 WAV 加工为"音乐拆解舞台"所需的静态资源：
**manifest / features / beats / presets / preview（压缩音频+切片特征+平移拍点）/ report / 原子发布资源包**。
管线只在本地运行，不重跑 Demucs 分离，不触碰 `web/` 与 `separated/` 源文件。

版权红线：`build/` 下由版权测试曲派生的资源仅供本地。**授权未确认（`license.publicDeployAllowed=false`）的曲目，发布白名单为空，不得进入 Qoder Sites 公开部署包。** 自动质检只验证工程正确性，不等于判断分离音质（后者需人工试听）。

## 环境（2026-11-18 本机实测，Windows）

- 解释器：`.venv/Scripts/python.exe`（Python 3.13）。系统 `python` 带 numpy 也能跑前 3 轮。
- 运行时依赖：**NumPy**（特征/节拍/预设全部纯 NumPy 标准 DSP）；**预览阶段另需 ffmpeg**——
  已装 `imageio-ffmpeg`（自带静态二进制，不污染系统）；有系统 ffmpeg 也会自动使用。
- `librosa` 已装但**仅作可选交叉验证**（测试自动跳过缺失环境），不是运行时依赖。
- 重建 venv：
  ```bash
  python -m venv .venv
  .venv/Scripts/python.exe -m pip install -i https://mirrors.aliyun.com/pypi/simple/ numpy imageio-ffmpeg
  # 本机清华镜像对 pip 返回 "versions: none"，阿里云镜像可用
  ```

## 命令

```bash
PY=.venv/Scripts/python.exe

# 一键构建（推荐）：manifest→features→beats→presets→preview→质检→原子发布
$PY -m pipeline build --stems separated/htdemucs_6s/test_song --out build/test_song --config configs/test_song.json
#   可选: --preview-sec 45 --preview-start 60 --bitrate 96k --force

# 仅预览：上游必须缓存有效；改预览参数后快速重切（不重算特征/节拍）
$PY -m pipeline preview --stems separated/htdemucs_6s/test_song --out build/test_song --config configs/test_song.json --preview-sec 45 --bitrate 96k

# 失败重跑：同一条 build 命令再跑一次即可——已完成阶段命中缓存，失败阶段自动重算
# 模拟中途失败（测试钩子）：--fail-at preview 在该阶段产物写入后、缓存写入前中断

# 单阶段（调试用，同一 --out 目录按序执行）
$PY -m pipeline manifest --stems <dir> --out <out> [--config <json>] [--track-id <id>]
$PY -m pipeline features --out <out>
$PY -m pipeline beats    --out <out>
$PY -m pipeline presets  --out <out>

# 测试（91 用例，合成样本为主，~70s）
$PY -m unittest discover -s tests -t .

# 旧波形脚本保持可用（未改动）
$PY scripts/make_peaks.py separated/htdemucs_6s/test_song build/peaks_check.json
```

失败语义：输入缺失/格式异常/轨道不一致 → 中文报错 + 退出码 1；质检存在阻断性错误 → 不发布 + 退出码 1。

## 产物布局与缓存

```
build/<track>/
  manifest.base.json      # manifest 阶段稳定产物（发现/校验/哈希/授权）
  manifest.json           # 投影：base + 各阶段实际产物挂载（任何阶段后可重建，损坏自动回落 missing）
  artwork/cover.png       # 可选：从原曲（config.sourceAudio）提取的封面，PNG ≤512px；提取失败不产出
  features/<stem>.json    # 整曲 50Hz 特征
  beats.json  presets.json
  preview/                # <stem>.m4a + preview.json + features/<stem>.json + beats.json
  report.json             # 最新质检
  .cache/<stage>.json     # 缓存键 + 产物 sha256/大小清单
  releases/<id>/          # 质检通过后原子发布的完整资源包（保留最近 3 个）
  current.json            # 单文件原子指针 → 当前 release（读取方不会新旧混用）
```

缓存键 = sha256(阶段 + PIPELINE_VERSION + SCHEMA_VERSION + 输入内容哈希 + 参数)，下游键包含上游键。
**命中前逐一验证产物存在、大小、sha256**——仅凭文件存在绝不跳过；损坏/篡改自动重算。
缓存条目在产物全部落盘后才写：中途失败 → 重跑该阶段。`--force` 全量重算；PIPELINE_VERSION 升级使全部缓存失效。

**挂载失效判定（sync_manifest，v0.6.0）**：产物"存在"不等于"有效"——
特征核对当前分析参数（hop/window/frameRate/silenceThreshold）+ 源哈希；beats 核对 frameRate +
sourceFeaturesSha256 + analysisParams；presets 核对 params + **sourceAudioSha256（逐轨源音频哈希）** + stem 集合；
preview 核对 frameRate + `upstreamSha256` 指纹。上游任何变化立即回落 missing，单阶段命令与失败中间状态同样保证契约有效。

**源目录迁移**：缓存键不含路径。build 在 manifest 阶段后调 `refresh_audio_paths` 按当前源目录
重算 audio.path（校验 sha 一致才刷新）——迁移后特征等昂贵阶段仍按内容哈希命中，路径投影始终有效；
base 被重写后同步调 `refresh_entry_artifact` 刷新缓存清单中该产物的 sha/size（键不变），
否则下次命中校验误判失效（连续第二次 preview_only 曾因此报错，v0.6.0 修复）。
质检另有 `source-audio-paths` 存在性检查兜底（缺失 → 阻断发布）。

**发布（v0.6.0）**：发布目录不可覆盖。先完整组装 tmp，再按**完整包内容指纹**（全部文件 相对路径→大小+sha256）
判定复用：逐字节一致 → 直接复用、仅原子更新 current；指纹不同（含"同秒同报告但源迁移后 manifest 路径已变"）
或目录不完整 → rid 追加 `-2/-3…` 唯一后缀，绝不复用路径过时的旧包。顺序：tmp 组装 → 原子改名 →
切 current → 才清理旧包；任何一步失败只清理本次 tmp，旧包与指针全程完好；清理绝不动 current 引用的目录。
Windows 下杀毒/索引器可能短暂持有新目录句柄导致目录改名 PermissionError → 有限退避重试（8 次，≤约 4.5s）。

## 数据契约 schemaVersion=1

通用：时间相对 `track.originSec`（默认 0 秒）；路径相对所在 JSON 目录、POSIX 分隔符；
未生成资源 `{"status":"missing","path":null}`；所有 JSON `allow_nan=False`。

### manifest.json

`track`: id/title/originSec/durationSec/sampleRate/channels/model{name,family,version}/
license{status,spdx,source,publicDeployAllowed}/analysisConfig(按曲目覆盖)/analysis(实际分析参数+共享 display)；
可选 `artist`/`album`（原曲 tags 解析，缺失为 null）与 `artwork{status,path,mime,width,height,sha256}`
（封面提取，任何失败一律 `{"status":"missing",...}`，绝不阻塞构建；sync 对悬空/内容不符的 ready 回落 missing）；
`track.stems[i]`: audio{path,format,sampleRate,channels,frames,durationSec,sha256} + features 挂载；
`resources`: beats/presets/preview 挂载（ready 时含 sha256 与摘要字段 bpm/snapEnabled/presetIds/originSec/durationSec）。
release 包内 manifest 的 audio.path 已重写到 release 目录视角（仍指向包外整曲源，仅本地用）。

**原曲封面与元数据（v0.7.0）**：config 可选 `sourceAudio`（相对 config 目录或绝对路径）指向未分离原曲。
manifest 阶段用 ffmpeg 提取内嵌视频流为封面（重编码 PNG、长边 ≤512px，`artwork/cover.png`）并解析
artist/album tags。**原曲内容 sha256 进 manifest 缓存键**——换封面/换原曲必然重跑 manifest 阶段；
无 sourceAudio、文件缺失、无内嵌封面或任何提取失败 → artwork=missing、tags=null，不报错不阻塞。
发布时 `artwork/` 目录随包复制；授权确认（publicDeployAllowed=true）后 artwork/ 进部署白名单。

### features/<stem>.json（整曲，第 2 轮）

- `hop=round(sr/50)`，`frameRate=sr/hop`；第 i 帧时间戳 `t_i = originSec + i/frameRate` = **窗口中心**
  （2048 样本 Hann 窗，越界补零，`windowCenterOffsetSec=0`，无系统提前/滞后）；`nFrames=ceil(样本数/hop)`。
- **立体声保留声道、逐声道分析后能量合并**（`channelMix="per-channel-energy-merge"`，v0.5.0）：
  绝不先均值下混——反相立体声（L=x,R=-x）会抵消成假静音。
- 数组（等长、跨轨可比、**不做逐轨归一化**）：`rms`(全样本全声道均方根)、`low/mid/high`(各声道频带均方值跨声道平均，20–250/250–2k/2k–16kHz，
  带内和≈rms²)、`onset`(各声道线性谱通量跨声道平均，首帧恒 0)、`peakMin/peakMax`(窗内全声道极值)。
- `display` 全轨共享（整曲 pooled 分位数）：`rmsRef`=p95(rms)、`bandRef`=rmsRef²、`onsetRef`=p99(onset)、
  `silenceThreshold`=0.001。弱音/串音轨不拉满。`sourceSha256` 绑定音频版本；`stats` 含 silentFrameRatio。

### beats.json（第 3 轮）

- 方法：鼓轨 onset（静音/缺鼓轨 → 全曲 onset 和兜底，`source` 注明）→ 自相关+梳状滤波定 tempo（抛物线亚帧细化）
  → **逐帧动态规划**（onset 收益 + 间隔对数惩罚，允许跳拍）→ onset 优先、tempo 一致的拍点，非等间隔伪造。
- `beatsSec` 相对 originSec；`bpm/periodSec`；`snapEnabled`；`heuristicScore` = 加权和
  （periodicity 0.35 / intervalStability 0.25 / gridCoverage 0.25 / tempoMargin 0.15，分量与权重全部输出）。
  **它是启发式评分，不是准确概率。** 评分 < snapThreshold(0.55) / 拍点 < 8 / 静音 → `snapEnabled=false`，
  前端继续用能量与起音特征。`downbeats=null`（不标注重拍）。`tempoCandidates` 给出次优 tempo 供排查。
- 按曲目覆盖：`analysisConfig.beats.{bpmRange,snapThreshold,minBeats,evidenceRel,intervalWindow,intervalPenalty,...}`。
- 交叉验证：真实素材 bpm=136.67（librosa 136.36），579 拍点 99.7% 与 librosa 相差 <0.1s。

### presets.json（第 3 轮）

| id | 名称 | 规则（默认） |
|---|---|---|
| full | 完整合奏 | 所有轨 gain=1，保持原声部比例 |
| vocal | 人声聚光 | vocals=1.0，其余 duck 0.22 |
| rhythm | 节奏主场 | drums=1.0、bass=0.9，其余 duck 0.15 |

- 每套含 `gains/muted/pan(默认0)/transitionSec`；focus 轨缺失 → 退化为 full（`degradedToFull`）；缺失轨不入表。
- 顶层 `sourceAudioSha256 = {stemId: 源音频sha256}`（v0.6.0）：sync 据此判定预设是否过期——
  源音频内容变化（如振幅调整）后只重跑 manifest/features，旧预设立即 missing，不得继续 ready。
- `busPeak` 为**整曲逐声道实测叠加峰值的最大值**（mix[:,c]=Σ g·x[:,c]，不做均值下混）；超 `headroomTarget`(0.95)
  时整套乘同一 `appliedScale`（保持比例，不逐轨归一化）。**gains 取整到 4 位小数导出后按导出增益重新实测**，
  仍超则继续微调缩放至收敛；`channelPeaks` 记录每声道峰值。质检会流式重读源 WAV 独立复核（不信任 busPeak 字段）。
- 覆盖：`analysisConfig.presets.{headroomTarget,vocalDuckGain,rhythmDuckGain,transitionSec}`。

### preview/preview.json（第 4 轮）

- 统一裁剪 30–45s（默认 40；短曲取整曲并注明），六轨同一起止；起点**能量自动选段**（整曲 pooled rms 滑窗最大）
  或 `--preview-start`/`analysisConfig.preview.startSec` 指定；**起点吸附 hop 网格**：`originSec = frameOffset*hop/sr`。
- AAC/m4a（默认 128k，`--bitrate` 可调）。**逐轨解码回检**（保留声道，反相不抵消）：
  延迟估计 = 10ms 能量包络互相关粗定位 + 波形细化 + 1ms 细包络消歧 + 2s 段落一致性投票，
  **绝不凭周期波形全局相关峰定延迟**（纯正弦的周期倍数峰曾造成 109–182ms 假延迟）。
  每轨输出 `delayStatus` ∈ {measured, uncertain, silent}：包络无结构/竞争峰不可消歧/段落投票不一致 →
  **uncertain，delaySamples/delaySec 写 null**（禁止写入错误补偿值，不因此阻断构建）；
  内容时长容差 ±0.12s、measured 对齐相关系数 ≥0.90。实测本机真实素材 delay=0（ffmpeg 遵循 gapless），
  近静音轨（piano）判 uncertain；浏览器行为可能不同 → 属浏览器待验证项。
- 顶层 `upstreamSha256 = {features:{stemId:sha}, beats:sha|null, presets:sha|null}`：sync 据此判定预览挂载是否过期。
- `preview/features/<stem>.json` = 整曲数组**精确切片** `[i0:i0+K]`（schema 同整曲，`scope:"preview"`、
  `sourceFrameOffset:i0`、display 沿用整曲共享值）；`preview/beats.json` = 窗口内拍点 − originSec，降级状态继承。
- **时间换算（禁止拿局部秒数直读整曲特征）**：
  `整曲时间 = originSec + p − delaySec`；`特征下标 = clamp(floor((p − delaySec)*frameRate), 0, K−1)`；
  `拍点触发位置 = 局部拍点 + delaySec`（p 为解码缓冲的局部播放位置）。
  **delaySec=null（uncertain）时不做补偿**，按 0 处理并在 UI 标记"延迟待核验"。
- 压缩降低**传输体积**；解码 PCM 内存由预览时长决定，与码率无关（不宣称等比例降内存）。

### report.json / current.json

- 质检项：授权(restricted 不阻断本地)、挂载、**源音频路径存在性（缺失→fail）**、预览解码/延迟一致性/网格吸附/切片特征/拍点范围
  （uncertain 延迟 → warn 非阻断）、整曲特征完整性、**预设峰值独立复核**（流式重读源 WAV 按导出增益逐声道实测；
  超限或 busPeak 字段与实测偏差 >0.002 → fail）、节拍降级(degraded 非阻断)、体积(10MB 目标 warn 非阻断)。
  `blocking` 非空 → 禁止发布。`whitelist`：仅 `publicDeployAllowed=true` 时列出可部署文件，否则为空。
- `backendVerified` / `browserPending` 字段表见下。
- `current.json`：`{release, publishedAt, publicDeployAllowed, whitelist, report, summary}`，单文件原子替换。

## 前端接入字段表

| 字段 | 来源 | 状态 |
|---|---|---|
| stems[].audio.{path,frames,durationSec,sha256} | manifest | 后端已验证（哈希/长度一致） |
| features 数组 + display + frameRate/originSec | features/*.json | 后端已验证（有限值/等长/脉冲定位/频带闭合） |
| beatsSec/bpm/snapEnabled/heuristicScore | beats.json | 后端已验证（librosa 交叉 99.7%）；**音乐性拍点听感属浏览器/人工待验证** |
| presets gains/transitionSec/busPeak | presets.json | 后端已验证（实测峰值≤0.95）；过渡听感待浏览器验证 |
| preview stems[].{path,delayStatus,delaySec,contentDurationSec,alignmentCorr} | preview/preview.json | 后端已验证（ffmpeg 解码回检；uncertain→null 不写错误补偿）；**浏览器 decodeAudioData 的 gapless 行为待验证** |
| preview features/beats 切片与平移 | preview/* | 后端已验证（逐值一致/网格吸附）；浏览器按 delaySec 补偿后对齐待验证 |
| 六轨同一 when 启动同步、移动端内存/首屏 | — | 浏览器待验证（沿用现有引擎设计） |

### 取值示例（不改现有播放器）

```js
// —— 整曲体验：posSec 用现有引擎媒体时间，gain 用 effectiveGain(id) ——
const feat = await (await fetch(`features/${id}.json`)).json();
const { display, arrays, nFrames, frameRate, originSec } = feat;
const clamp01 = v => Math.min(1, Math.max(0, v));
function driveVisual(posSec, gain) {
  const i = Math.min(nFrames - 1, Math.max(0, Math.floor((posSec - originSec) * frameRate)));
  if (arrays.rms[i] < display.silenceThreshold || gain === 0) return null;
  return {
    energy: clamp01(arrays.rms[i] / display.rmsRef) * gain,
    low: clamp01(arrays.low[i] / display.bandRef) * gain,
    mid: clamp01(arrays.mid[i] / display.bandRef) * gain,
    high: clamp01(arrays.high[i] / display.bandRef) * gain,
    onset: clamp01(arrays.onset[i] / display.onsetRef) * gain, // 事件型：峰值保持+指数衰减
    peak: [arrays.peakMin[i], arrays.peakMax[i]],
  };
}

// —— 预览体验：先读 preview/preview.json，逐轨补偿编码延迟 ——
const pv = await (await fetch("preview/preview.json")).json();
const pf = await (await fetch(`preview/features/${id}.json`)).json();
const delay = pv.stems[id].delaySec ?? 0;         // null=uncertain：不补偿，UI 标记待核验
function drivePreview(localPos, gain) {           // localPos = 解码缓冲局部播放秒数
  const songPos = localPos - delay;               // 相对预览起点
  const i = Math.min(pf.nFrames - 1, Math.max(0, Math.floor(songPos * pf.frameRate)));
  /* 同上取 arrays[i]；整曲时间 = pv.originSec + songPos */
}
// 预览拍点：beats.beatsSec[k] + delay 处触发（snapEnabled=false 时不做拍点吸附动画）

// —— 预设切换：按媒体时间 T 调度（沿用现有同步引擎时钟）——
const preset = presets.presets.find(p => p.id === "vocal");
const when = state.startedAt + (T - state.startOffset);   // 媒体时间 → AudioContext 时间
for (const t of TRACKS) {
  const target = (preset.gains[t.id] ?? 1) * state.vol[t.id]; // mute/solo 仍优先
  state.gains[t.id].gain.setTargetAtTime(target, when, preset.transitionSec / 3);
}
```

## 部署白名单（授权确认后）

`manifest.json、features/、beats.json、presets.json、preview/（m4a+切片特征+拍点）、report.json`。
整曲源 WAV（包外相对路径引用）**永不**进白名单；线上整曲体验需另行压缩 CC 曲目整曲音频（后续工作）。
测试曲 `configs/test_song.json` 授权 unverified → 白名单恒为空。

## 验证记录（2026-11-18，v0.7.0 第 5 轮后端 artwork/元数据）

- 单元/集成测试 **91/91** 通过（~40–70s）：原 86 + 第 5 轮新增 5（tests/test_round5_artwork.py）：
  封面 ready 全字段+tags 解析 / 无内嵌封面→missing 但 tags 仍解析 / 无 sourceAudio→missing+null /
  sync 对已删除封面文件回落 missing / **原曲内容进 manifest 缓存键**（换封面重跑 manifest、无变化命中）。
  素材全合成（ffmpeg lavfi 生成封面 PNG、libmp3lame+id3v2 封装内嵌封面），不依赖版权曲目。
- 真实六轨一键 build（v0.7.0，`--out build/test_song_v07` 全量重算）：test_song.flac 无内嵌封面/无
  artist-album tags → `artwork=missing`、`artist/album=null`、产物与 release 包内均无 artwork/ 目录、
  白名单空（授权 unverified）——**missing 路径全链路验证**。质量数字与 v0.6.0 逐项一致无回归：
  bpm=136.68、579 拍点、预设 busPeak≤0.9499、40s@128k 预览 3.74MB / 资源包 10.51MB、
  5 轨 delay=0 measured + piano uncertain→null（warn 非阻断）、质检 13 pass / 1 warn / 0 fail / 1 restricted。
- `git diff -- web separated scripts music-src 需求文档.md AGENTS.md` 为空：前端原型、音频、旧脚本零改动。

## 验证记录（2026-11-18，v0.6.0 第 0 轮 A/B/C 收口后）

- 单元/集成测试 **86/86** 通过（~40s）：v0.5.0 的 78 项 + 第 0 轮新增 8 项
  （A×3 源 SHA 绑定/振幅变化失效/篡改与旧文档 missing；B×1 迁移后连续两次 preview_only 全命中；
  C×4 完整包指纹复用/同报告不同 manifest 唯一 ID/不完整目录不复用/Windows 瞬时占用重试）。
  R3 旧"同秒复用"测试按新契约更新：逐字节一致才复用，外部改动包 → 唯一 ID 且旧包原样保留。
- 三项遗留问题实证闭环（复现脚本 build/verify_abc.py，修复前后对照）：
  - A：振幅 0.1→0.9 只重跑 manifest/features → 旧预设 **missing**（原 ready、busPeak=0.1906 失真）；
    重跑 presets 后 ready，full busPeakUnscaled>1.0、导出增益下 busPeak≤0.95。
  - B：源目录迁移后连续两次 preview_only 均成功，第二次五阶段**全部缓存命中**（原第二次报"上游缓存无效"）。
  - C：固定同秒 + 报告逐字节相同 + 源迁移 → 不复用旧包，rid 唯一后缀，current 包内音频路径全部可解析（原 [False,False]）。
  - 附带修复：Windows 杀毒/索引器短暂持有新目录句柄 → 目录改名 PermissionError，publish 加有限退避重试（实测复现 2 次后修复）。
- 真实六轨一键 build（v0.6.0 全量重算）：bpm=136.68、579 拍点、snap 可用；预设 busPeak≤0.9499；
  40s@128k 预览音频 3.74MB、资源包 10.51MB；5 轨 delay=0 measured、piano uncertain→null（warn 非阻断）；
  质检 13 pass / 1 warn / 0 fail / 1 restricted（授权）。重跑五阶段全命中；presets.sourceAudioSha256 与 manifest 逐轨一致；
  current 包内六轨音频路径全部存在。
- `git diff -- web separated scripts music-src 需求文档.md AGENTS.md` 为空：前端、音频、旧脚本零改动。

## 验证记录（2026-11-18，v0.5.0 六项可信度修复后）

- 单元/集成测试 **78/78** 通过（~24s）：原 38 + 修复轮新增 40（R1×19 立体声/峰值/延迟、R2×13 降级/失效/迁移、R3×8 发布原子性）。
- 六项报告问题逐项实证修复（复现脚本 build/verify_issues.py）：
  1. 反相立体声 rmsMax=0.531（原 0）、silentFrameRatio=0；真实六轨按导出增益独立逐声道复核 full L=0.914/R=0.898、rhythm L=0.946/R=0.930，均 ≤0.95（原超余量）。
  2. 440/220Hz 周期素材+静音标记：delay=0 measured corr=0.9999（原假延迟 902/8018 样本、220Hz 曾阻断构建）；不可消歧时 uncertain→null。
  3. 3s/120BPM 少起音：正常降级 snapEnabled=false、scoreComponents 完整（原 KeyError 崩溃）。
  4. frameRate 50→25 后旧 beats 挂载立即 missing（原仍 ready）。
  5. 源目录迁移：五阶段缓存全命中、路径刷新指向新目录且存在（原悬空路径仍 publishable）。
  6. 同秒重复发布复用完整包；改名失败旧包与 current 完好（原先删旧包再改名）。
- 真实六轨一键 build（v0.5.0 全量重算）：bpm=136.68、579 拍点、snap 可用；预设 busPeak≤0.9499（导出增益下逐声道实测）；
  40s@128k 预览音频 **3.74MB**、资源包 10.51MB；5 轨 delay=0 measured、piano（近静音串音）uncertain→null（warn 非阻断）；
  质检 13 pass / 1 warn / 0 fail / 1 restricted（授权）。
- `git diff -- web separated scripts music-src 需求文档.md AGENTS.md` 为空：前端、音频、旧脚本零改动。