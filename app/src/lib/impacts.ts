// 第 4 轮：高能冲击检测 + 持续高能场景状态 + 视觉增益/动效乘子的每帧推进。
// 原始候选只在加载时计算一次（分位数/平滑/上升比全部离线），运行时只按实际增益门控与冷却，
// 绝不逐帧重算分位数。由 App.tsx 单一 rAF 循环调用（stepImpacts），状态全部写入 fxStore。
//
// 诚实声明：这里检测的是"局部能量冲击"（能量高分位 + 相比 2s 前明显上升 + 强 onset），
// 不是副歌/高潮/乐器识别，任何 UI 文案不得如此标注。

import type { StemEngine } from "@/audio/engine";
import { hash01, IMPACT_COOLDOWN, type FxStore, type StemFxState } from "@/lib/fx";
import type { TrackInfo } from "@/lib/resources";
import { clamp } from "@/lib/view";

const SMOOTH_W = 6; // 120ms 能量平滑（50fps）
const RISE_LAG = 100; // 与 ~2s 前比较
const RISE_RATIO = 1.25;
const E_PCT = 0.87; // 分段能量阈值取 p85–p90 之间
const O_PCT = 0.95; // 强 onset ≈ p95
const DISP_FLOOR = 0.4; // 共享显示尺度下限：弱轨（如钢琴串扰）逐轨分位数再高也够不到
const SCENE_SMOOTH = 0.24; // 共享能量平滑时间常数
const SCENE_ENTER_SEC = 2.0;
const SCENE_EXIT_SEC = 1.5;
const FLOW_MAX = 1.2; // 背景流速硬性上限 +20%

interface StemModel {
  /** 候选帧索引（升序） */
  idx: Int32Array;
  /** 候选帧平滑能量（raw） */
  sm: Float32Array;
  /** 候选帧 onset（raw） */
  on: Float32Array;
  /** 候选强度 0..1（onset 显示值） */
  strength: Float32Array;
  /** 全帧原始 rms（场景共享能量运行时按增益门控用） */
  rms: number[];
}

export interface ImpactModel {
  frameRate: number;
  nFrames: number;
  rmsRef: number;
  onsetRef: number;
  silence: number;
  stems: Map<string, StemModel>;
  sceneP90: number;
  sceneP75: number;
  candidateCounts: Record<string, number>;
  lastPos: number;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const arr = Float64Array.from(values as ArrayLike<number> & Iterable<number>);
  arr.sort();
  return arr[Math.floor(p * (n - 1))];
}

/** 加载时一次性构建：平滑能量、每轨分位阈值、原始候选帧、场景共享能量分位 */
export function buildImpacts(tracks: TrackInfo[]): ImpactModel {
  const first = tracks[0];
  const fr = first.features.frameRate;
  const n = first.features.nFrames;
  const d = first.features.display;
  const stems = new Map<string, StemModel>();
  const shared = new Float64Array(n);
  const candidateCounts: Record<string, number> = {};

  for (const t of tracks) {
    const f = t.features;
    const rms = f.arrays.rms;
    const onset = f.arrays.onset;
    // 120ms 滑动平均
    const sm = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += rms[i];
      if (i >= SMOOTH_W) sum -= rms[i - SMOOTH_W];
      sm[i] = sum / Math.min(i + 1, SMOOTH_W);
      shared[i] += Math.min(1, rms[i] / d.rmsRef);
    }
    const eThr = percentile(sm, E_PCT);
    const oThr = percentile(onset, O_PCT);
    const idxList: number[] = [];
    const smList: number[] = [];
    const onList: number[] = [];
    const stList: number[] = [];
    for (let i = RISE_LAG; i < n; i++) {
      if (sm[i] < eThr) continue;
      if (sm[i] < RISE_RATIO * sm[i - RISE_LAG]) continue;
      if (onset[i] < oThr) continue;
      if (rms[i] < d.silenceThreshold) continue;
      // 共享尺度下限在 gv=1 预筛一次（运行时再按实际 gv 复核）
      if (sm[i] / d.rmsRef < DISP_FLOOR || onset[i] / d.onsetRef < DISP_FLOOR) continue;
      idxList.push(i);
      smList.push(sm[i]);
      onList.push(onset[i]);
      stList.push(clamp(onset[i] / d.onsetRef, 0, 1));
    }
    candidateCounts[t.id] = idxList.length;
    stems.set(t.id, {
      idx: Int32Array.from(idxList),
      sm: Float32Array.from(smList),
      on: Float32Array.from(onList),
      strength: Float32Array.from(stList),
      rms,
    });
  }

  // 场景共享能量也做 240ms 平滑后取分位（进入 p90 / 退出 p75，滞回防抖）
  const shSm = new Float64Array(n);
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s2 += shared[i];
    if (i >= 12) s2 -= shared[i - 12];
    shSm[i] = s2 / Math.min(i + 1, 12);
  }

  return {
    frameRate: fr,
    nFrames: n,
    rmsRef: d.rmsRef,
    onsetRef: d.onsetRef,
    silence: d.silenceThreshold,
    stems,
    sceneP90: percentile(shSm, 0.9),
    sceneP75: percentile(shSm, 0.75),
    candidateCounts,
    lastPos: -1,
  };
}

function fire(fx: FxStore, id: string, st: StemFxState, tSec: number, strength: number, now: number, triggered: string[]) {
  st.impactAt = now;
  st.impactStrength = strength;
  st.impactsFired += 1;
  fx.triggerLog.push({ id, at: now, pos: tSec });
  if (fx.triggerLog.length > 400) fx.triggerLog.splice(0, 100);
  // 冲击视觉：一圈波纹环（装饰层内），增强档另加少量粒子迸发
  st.ripples.push({ t: tSec, bornAt: now, strength: 1 });
  st.spawnedRipples += 1;
  if (fx.motionTarget.push > 0) {
    const cap = fx.particleCap;
    const want = Math.round(5 * fx.motion.particle);
    for (let k = 0; k < want && fx.totalParticles() < cap; k++) {
      const seed = tSec * 71.3 + k * 23.9;
      st.particles.push({
        t: tSec,
        vSec: (hash01(seed) - 0.5) * 4.2,
        y0: (hash01(seed + 5) - 0.5) * 0.5,
        vY: (hash01(seed + 9) - 0.5) * 0.7,
        bornAt: now,
        life: 0.24 + hash01(seed + 13) * 0.14,
        size: 1.2 + hash01(seed + 17) * 2,
      });
      st.spawnedParticles += 1;
    }
  }
  triggered.push(id);
}

/** 每帧推进：视觉增益 → 动效乘子平滑 → 冲击检测（合并）→ 场景状态。App 单循环内、draws 之前调用 */
export function stepImpacts(model: ImpactModel, engine: StemEngine, fx: FxStore, pos: number, dt: number, now: number) {
  const ids = engine.tracks.map((t) => t.id);
  // 1) 视觉增益包络：镜像 setTargetAtTime 的解析指数（聚光过渡时灯光随真实增益渐变，不突跳）
  for (const id of ids) {
    const st = fx.ensure(id);
    st.gv = engine.visualGain(id, now) * engine.masterVol;
  }
  // 2) 动效乘子平滑（~120ms）：档位/开关切换从当前值续接，可中断
  const m = fx.motion;
  const mt = fx.motionTarget;
  const k = 1 - Math.exp(-dt / 0.12);
  m.particle += (mt.particle - m.particle) * k;
  m.shake += (mt.shake - m.shake) * k;
  m.glow += (mt.glow - m.glow) * k;
  m.push += (mt.push - m.push) * k;

  const fr = model.frameRate;
  const idx = clamp(Math.floor(pos * fr), 0, model.nFrames - 1);
  const sc = fx.scene;

  // seek/切歌/后台返回：游标快进到当前位置（跳过历史候选，绝不补放），场景计时清零
  const jump = model.lastPos < 0 || pos < model.lastPos - 1e-6 || pos - model.lastPos > Math.max(0.25, dt * 4);
  model.lastPos = pos;
  if (jump) {
    for (const id of ids) {
      const st = fx.ensure(id);
      const sm = model.stems.get(id);
      st.candPtr = 0;
      if (sm) while (st.candPtr < sm.idx.length && sm.idx[st.candPtr] <= idx) st.candPtr++;
      st.impactAt = -99;
      st.impactStrength = 0;
      st.shakePx = 0;
    }
    sc.aboveSince = 0;
    sc.belowSince = 0;
    sc.shared = 0;
    sc.active = false; // 场景状态随 seek 清零（不计入 exitCount）
    return;
  }

  // 3) 冲击检测：只消费上一帧到当前帧之间跨过的候选（原始条件已离线算好）
  const triggered: string[] = [];
  if (engine.playing) {
    const gate = fx.impactsOn && !fx.reduced;
    for (const id of ids) {
      const st = fx.ensure(id);
      const sm = model.stems.get(id);
      if (!sm) continue;
      while (st.candPtr < sm.idx.length && sm.idx[st.candPtr] <= idx) {
        const c = st.candPtr++;
        if (!gate) continue;
        if (now - st.impactAt < IMPACT_COOLDOWN) continue; // 每轨冷却 1s：持续响不会连抖
        if (st.gv <= 0.02) continue; // 不可听（mute/solo/聚光压到 0）不触发
        // 运行时按实际增益复核共享显示尺度（聚光中的弱轨串扰被压在下限之下）
        if ((sm.sm[c] * st.gv) / model.rmsRef < DISP_FLOOR) continue;
        if ((sm.on[c] * st.gv) / model.onsetRef < DISP_FLOOR) continue;
        fire(fx, id, st, sm.idx[c] / fr, sm.strength[c], now, triggered);
      }
    }
    if (fx.testForceIds) {
      for (const id of fx.testForceIds) {
        const st = fx.ensure(id);
        fire(fx, id, st, pos, 0.9, now, triggered);
      }
      fx.testForceIds = null;
    }
    // 多轨同帧触发合并为一次主冲击（各轨本地反馈已各自记录）
    if (triggered.length > 0) fx.mainImpacts += 1;
  }

  // 4) 持续高能场景：共享能量（可听轨、共享尺度）≥p90 持续 2s 进入 / <p75 持续 1.5s 退出
  let sharedNow = 0;
  for (const id of ids) {
    const st = fx.ensure(id);
    const sm = model.stems.get(id);
    if (!sm) continue;
    sharedNow += Math.min(1, (sm.rms[idx] * st.gv) / model.rmsRef);
  }
  const input = sc.testOverride ?? sharedNow;
  sc.shared += (input - sc.shared) * (1 - Math.exp(-dt / SCENE_SMOOTH));
  if (!sc.active) {
    if (sc.shared >= sc.p90) {
      if (sc.aboveSince === 0) sc.aboveSince = now;
      else if (now - sc.aboveSince >= SCENE_ENTER_SEC) {
        sc.active = true;
        sc.enterCount += 1;
        sc.aboveSince = 0;
        sc.belowSince = 0;
      }
    } else sc.aboveSince = 0;
  } else {
    if (sc.shared < sc.p75) {
      if (sc.belowSince === 0) sc.belowSince = now;
      else if (now - sc.belowSince >= SCENE_EXIT_SEC) {
        sc.active = false;
        sc.exitCount += 1;
        sc.belowSince = 0;
      }
    } else sc.belowSince = 0;
  }

  // 场景推动闸门：master 关 / reduced / 安静档 → 无背景推动
  const sceneGate = fx.motionOn && !fx.reduced && fx.motionTier !== "quiet" ? 1 : 0;
  const haloTarget = (sc.active ? 1 : 0) * sceneGate;
  sc.halo += (haloTarget - sc.halo) * (1 - Math.exp(-dt / 0.5));
  // 增强档：最近 0.5s 内的主冲击给一点瞬时推动；总量硬性钳制 ≤1.2
  let impulse = 0;
  for (const id of ids) {
    const st = fx.ensure(id);
    const age = now - st.impactAt;
    if (age >= 0 && age < 0.5) impulse = Math.max(impulse, 1 - age / 0.5);
  }
  const flowTarget = clamp(1 + 0.2 * sc.halo + 0.06 * impulse * m.push * sceneGate, 1, FLOW_MAX);
  sc.flowMult += (flowTarget - sc.flowMult) * (1 - Math.exp(-dt / 0.3));
  sc.maxFlowMult = Math.max(sc.maxFlowMult, sc.flowMult);
}

/** 模块级引用由 App 持有；此处仅暴露给 dev 验证读取模型概要 */
export function modelSummary(model: ImpactModel) {
  return { candidates: model.candidateCounts, sceneP90: model.sceneP90, sceneP75: model.sceneP75 };
}
