export type ViewMode = "follow" | "overview";

/** dt=真实帧间隔秒（App 单循环计算，钳制 0..0.1）；now=秒级时钟（rAF ts/1000），供叠加层包络/粒子寿命使用 */
export type DrawFn = (pos: number, t0: number, t1: number, dt: number, now: number) => void;

export interface ViewState {
  mode: ViewMode;
  windowSec: number;
  manual: boolean;
  manualStart: number;
}

export interface ViewRange {
  t0: number;
  t1: number;
}

export const FOLLOW_ANCHOR = 0.42;

export function computeView(v: ViewState, pos: number, duration: number): ViewRange {
  if (v.mode === "overview" || duration <= v.windowSec) {
    return { t0: 0, t1: duration };
  }
  const maxStart = duration - v.windowSec;
  const base = v.manual ? v.manualStart : pos - FOLLOW_ANCHOR * v.windowSec;
  const t0 = Math.max(0, Math.min(maxStart, base));
  return { t0, t1: t0 + v.windowSec };
}

export function fmt(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}