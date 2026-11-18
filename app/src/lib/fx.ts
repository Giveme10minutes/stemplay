// 第 3 轮基础音画状态：频带呼吸包络、播放线接触波纹/粒子、能量段条滞回参数。
// 全部高频值住在 store（refs 语义），绝不进 React state；由 App.tsx 单一 rAF 循环驱动。

export interface Ripple {
  /** 触发点（预览内容时间，秒）——锚定在波形上，随视图滚动 */
  t: number;
  bornAt: number;
  strength: number;
}

export interface Particle {
  t: number;
  /** 水平漂移速度（内容秒/秒），沿轨道扩散而非全屏 */
  vSec: number;
  /** 垂直偏移（行高比例 -0.5..0.5） */
  y0: number;
  vY: number;
  bornAt: number;
  life: number;
  size: number;
}

export interface StemFxState {
  // 包络（attack 60ms / release 250ms，按真实 dt 积分）
  envLow: number;
  envMid: number;
  envHigh: number;
  envRms: number;
  // 最近一帧显示值：rms/onset 为幅度量（×g），low/mid/high 为均方量（×g²）
  dispRms: number;
  dispLow: number;
  dispMid: number;
  dispHigh: number;
  dispOnset: number;
  silent: boolean;
  ripples: Ripple[];
  particles: Particle[];
  lastPos: number;
  lastFrameIdx: number;
  // 累计计数，供验证脚本断言"无历史事件补放"
  spawnedRipples: number;
  spawnedParticles: number;
  // 第 4 轮：视觉增益（解析指数包络，跟随预设过渡）、高能冲击状态
  gv: number;
  impactAt: number;
  impactStrength: number;
  /** 当前帧抖动幅度（CSS px），供验证断言各档位上限 */
  shakePx: number;
  impactsFired: number;
  /** 冲击候选游标（buildImpacts 预计算的帧列表），seek 时快进不补放 */
  candPtr: number;
}

export const ATTACK_SEC = 0.06;
export const RELEASE_SEC = 0.25;
export const RIPPLE_LIFE = 0.32; // 规格要求 180–350ms
export const ONSET_TRIGGER = 0.5; // onset 显示值超过该阈值 → 触发接触波纹
export const BAR_ENTER = 0.45; // 能量段条滞回：进入阈值（高）
export const BAR_EXIT = 0.22; // 退出阈值（低），防闪烁
export const IMPACT_COOLDOWN = 1.0; // 每轨冲击冷却（规格 0.8–1.2s）
export const IMPACT_DECAY = 0.22; // 冲击视觉衰减（规格 150–250ms）
export const SHAKE_BASE_PX = 1.6; // 标准档峰值 1.6px（1–2px）；轻柔 ×0.5、增强 ×1.7（≤3px）

/** 指数趋近：按真实 dt 积分，而非每帧固定比例 */
export function approach(env: number, target: number, dt: number): number {
  const tau = target > env ? ATTACK_SEC : RELEASE_SEC;
  return env + (target - env) * (1 - Math.exp(-dt / tau));
}

export function hash01(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 148, g: 163, b: 184 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export function rgba(c: { r: number; g: number; b: number }, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a.toFixed(3)})`;
}

function freshStem(): StemFxState {
  return {
    envLow: 0,
    envMid: 0,
    envHigh: 0,
    envRms: 0,
    dispRms: 0,
    dispLow: 0,
    dispMid: 0,
    dispHigh: 0,
    dispOnset: 0,
    silent: true,
    ripples: [],
    particles: [],
    lastPos: -1,
    lastFrameIdx: -1,
    spawnedRipples: 0,
    spawnedParticles: 0,
    gv: 0,
    impactAt: -99,
    impactStrength: 0,
    shakePx: 0,
    impactsFired: 0,
    candPtr: 0,
  };
}

/** 动效档位强度乘子（标准 = 第 3 轮默认值 1） */
export interface MotionMult {
  particle: number;
  shake: number;
  glow: number;
  push: number;
}

export interface ImpactLogEntry {
  id: string;
  /** performance 时钟秒（与 rAF ts/1000 同源） */
  at: number;
  /** 触发点内容时间（秒） */
  pos: number;
}

export interface SceneState {
  active: boolean;
  /** 平滑后的共享能量（全轨共享显示尺度求和） */
  shared: number;
  aboveSince: number;
  belowSince: number;
  enterCount: number;
  exitCount: number;
  /** 背景流速乘子（1..1.2，硬性上限 +20%） */
  flowMult: number;
  maxFlowMult: number;
  /** 光晕加强 0..1，BackgroundLayer 消费 */
  halo: number;
  p90: number;
  p75: number;
  /** 验证钩子：直接驱动共享能量输入（自然播放达不到持续场景时单元验证用） */
  testOverride: number | null;
}

/** 就地压缩数组，避免每帧 filter 分配 */
export function cull<T>(arr: T[], keep: (v: T) => boolean) {
  let w = 0;
  for (let i = 0; i < arr.length; i++) if (keep(arr[i])) arr[w++] = arr[i];
  arr.length = w;
}

export class FxStore {
  stems = new Map<string, StemFxState>();
  /** 特效强度 --sp-fx（material.fx/100），由 App 订阅主题 store 同步，不进 rAF */
  fx = 0.6;
  reduced = false;
  mobile = false;
  // 第 4 轮：动效预设（master 开关 + 档位乘子，平滑值/目标值分离 → 切换可中断续接）
  motionOn = true;
  impactsOn = true;
  motionTier = "standard";
  motion: MotionMult = { particle: 1, shake: 1, glow: 1, push: 0 };
  motionTarget: MotionMult = { particle: 1, shake: 1, glow: 1, push: 0 };
  // 高能冲击：多轨同帧触发合并为 1 次主冲击 + 各轨本地反馈
  mainImpacts = 0;
  triggerLog: ImpactLogEntry[] = [];
  /** 验证钩子：下一帧强制这些轨触发（走真实合并路径） */
  testForceIds: string[] | null = null;
  scene: SceneState = {
    active: false,
    shared: 0,
    aboveSince: 0,
    belowSince: 0,
    enterCount: 0,
    exitCount: 0,
    flowMult: 1,
    maxFlowMult: 1,
    halo: 0,
    p90: 0,
    p75: 0,
    testOverride: null,
  };
  private rmQuery: MediaQueryList | null = null;
  private mobQuery: MediaQueryList | null = null;

  /** 运行时读 matchMedia 并监听变化（实时响应） */
  attachMedia() {
    if (this.rmQuery) return;
    this.rmQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updR = () => {
      this.reduced = this.rmQuery!.matches;
    };
    updR();
    this.rmQuery.addEventListener("change", updR);
    this.mobQuery = window.matchMedia("(max-width: 767px)");
    const updM = () => {
      this.mobile = this.mobQuery!.matches;
    };
    updM();
    this.mobQuery.addEventListener("change", updM);
  }

  get particleCap(): number {
    return this.mobile ? 40 : 120;
  }

  ensure(id: string): StemFxState {
    let s = this.stems.get(id);
    if (!s) {
      s = freshStem();
      this.stems.set(id, s);
    }
    return s;
  }

  /** seek/切歌/后台返回：清空波纹/粒子/包络/冲击活动态，不补放历史事件 */
  resetStem(id: string) {
    const s = this.stems.get(id);
    if (!s) return;
    s.ripples.length = 0;
    s.particles.length = 0;
    s.envLow = s.envMid = s.envHigh = s.envRms = 0;
    s.dispRms = s.dispLow = s.dispMid = s.dispHigh = s.dispOnset = 0;
    s.lastPos = -1;
    s.lastFrameIdx = -1;
    s.impactAt = -99;
    s.impactStrength = 0;
    s.shakePx = 0;
  }

  resetAll() {
    for (const id of this.stems.keys()) this.resetStem(id);
    // 切歌/重载：冲击与场景累计状态归零（验证脚本按差值断言）
    for (const s of this.stems.values()) {
      s.impactsFired = 0;
      s.candPtr = 0;
    }
    this.mainImpacts = 0;
    this.triggerLog.length = 0;
    this.testForceIds = null;
    this.scene = { ...this.scene, active: false, shared: 0, aboveSince: 0, belowSince: 0, enterCount: 0, exitCount: 0, flowMult: 1, maxFlowMult: 1, halo: 0, testOverride: null };
  }

  totalParticles(): number {
    let n = 0;
    for (const s of this.stems.values()) n += s.particles.length;
    return n;
  }

  snapshot() {
    const stems: Record<string, unknown> = {};
    for (const [id, s] of this.stems) {
      stems[id] = {
        envRms: +s.envRms.toFixed(4),
        envLow: +s.envLow.toFixed(4),
        envMid: +s.envMid.toFixed(4),
        envHigh: +s.envHigh.toFixed(4),
        dispRms: +s.dispRms.toFixed(4),
        dispMid: +s.dispMid.toFixed(4),
        gv: +s.gv.toFixed(4),
        shakePx: +s.shakePx.toFixed(3),
        impactsFired: s.impactsFired,
        ripples: s.ripples.length,
        particles: s.particles.length,
        spawnedRipples: s.spawnedRipples,
        spawnedParticles: s.spawnedParticles,
      };
    }
    return {
      fx: this.fx,
      reduced: this.reduced,
      mobile: this.mobile,
      particleCap: this.particleCap,
      motion: { on: this.motionOn, tier: this.motionTier, impactsOn: this.impactsOn, ...this.motion },
      mainImpacts: this.mainImpacts,
      triggerLog: this.triggerLog.slice(-120),
      scene: {
        active: this.scene.active,
        shared: +this.scene.shared.toFixed(4),
        flowMult: +this.scene.flowMult.toFixed(4),
        maxFlowMult: +this.scene.maxFlowMult.toFixed(4),
        halo: +this.scene.halo.toFixed(4),
        enterCount: this.scene.enterCount,
        exitCount: this.scene.exitCount,
        p90: +this.scene.p90.toFixed(4),
        p75: +this.scene.p75.toFixed(4),
      },
      stems,
    };
  }
}

/** 模块级单例（与 theme.ts 同模式）：可变高频状态，永不进 React 渲染 */
export const fxStore = new FxStore();
