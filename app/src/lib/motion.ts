// 动效偏好中央存储：master 开关 + 四档强度（安静/轻柔/标准/增强）。
// 与 theme.ts 同模式：模块单例 + useSyncExternalStore + localStorage 持久化 + 迁移安全解析。
// 离散事件驱动，不进 rAF；强度乘子写入 fxStore.motionTarget，由单一 rAF 循环平滑逼近（切换可中断续接）。

import { useSyncExternalStore } from "react";
import type { MotionMult } from "@/lib/fx";

export type MotionTier = "quiet" | "soft" | "standard" | "enhanced";

export interface MotionPrefs {
  master: boolean;
  tier: MotionTier;
}

export interface MotionTierDef extends MotionMult {
  id: MotionTier;
  name: string;
  desc: string;
  /** 是否启用高能冲击 */
  impacts: boolean;
}

export const MOTION_TIERS: MotionTierDef[] = [
  { id: "quiet", name: "安静", desc: "只留基础明暗，无冲击与粒子", particle: 0, shake: 0, glow: 0.55, push: 0, impacts: false },
  { id: "soft", name: "轻柔", desc: "轻微冲击（0.5–1px），粒子减半", particle: 0.5, shake: 0.5, glow: 0.8, push: 0, impacts: true },
  { id: "standard", name: "标准", desc: "默认强度（1–2px 冲击）", particle: 1, shake: 1, glow: 1, push: 0, impacts: true },
  { id: "enhanced", name: "增强", desc: "更强冲击（≤3px）+ 背景推动", particle: 1.6, shake: 1.7, glow: 1.25, push: 1, impacts: true },
];

export const DEFAULT_MOTION: MotionPrefs = { master: true, tier: "standard" };

const LS_KEY = "stemplay.motion.v1";

const TIER_IDS = MOTION_TIERS.map((t) => t.id);

/** 迁移安全解析：任何字段损坏都回退默认 */
export function sanitizeMotionPrefs(raw: unknown): MotionPrefs {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_MOTION };
  const r = raw as Record<string, unknown>;
  return {
    master: typeof r.master === "boolean" ? r.master : DEFAULT_MOTION.master,
    tier: TIER_IDS.includes(r.tier as MotionTier) ? (r.tier as MotionTier) : DEFAULT_MOTION.tier,
  };
}

export function tierDef(id: MotionTier): MotionTierDef {
  return MOTION_TIERS.find((t) => t.id === id) ?? MOTION_TIERS[2];
}

function load(): MotionPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_MOTION };
    const parsed = JSON.parse(raw) as { v?: number; prefs?: unknown };
    if (parsed?.v !== 1) return { ...DEFAULT_MOTION };
    return sanitizeMotionPrefs(parsed.prefs);
  } catch {
    return { ...DEFAULT_MOTION };
  }
}

function save(prefs: MotionPrefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, prefs }));
  } catch {
    /* 隐私模式：仅会话内有效 */
  }
}

let state: MotionPrefs = load();
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function update(patch: Partial<MotionPrefs>) {
  state = { ...state, ...patch };
  save(state);
  emit();
}

export function subscribeMotion(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getMotion(): MotionPrefs {
  return state;
}

export function useMotion(): MotionPrefs {
  return useSyncExternalStore(subscribeMotion, getMotion, getMotion);
}

export function setMaster(on: boolean) {
  update({ master: on });
}

export function setTier(tier: MotionTier) {
  update({ tier });
}

/** 供 App 同步与 dev 验证使用的 store 门面 */
export const motionStore = {
  getState: getMotion,
  subscribe: subscribeMotion,
  setMaster,
  setTier,
  tierDef,
  MOTION_TIERS,
  DEFAULT_MOTION,
};
