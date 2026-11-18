// 外观中央存储：主题/背景/材质三组独立偏好 + 封面取色状态。
// 离散事件驱动（useSyncExternalStore），不进入 rAF 渲染循环；
// 主题过渡交给 CSS（@property 注册变量 + :root transition），天然可中断、从当前值续接。

import { useSyncExternalStore } from "react";
import { idbDel, idbGet, idbSet } from "@/lib/idb";
import {
  composite,
  contrastRatio,
  correctAccent,
  extractPalette,
  hexToRgb,
  isHexColor,
  measureImage,
  mixHex,
  paletteGradient,
  relLuminance,
  rgbToHex,
  type ImageStats,
  type Palette,
  type RGB,
} from "@/lib/palette";

export type ThemeId = "ocean" | "aurora" | "amber" | "mist";
export type ModePref = "dark" | "light" | "system";
export type Mode = "dark" | "light";
export type BgType = "theme" | "solid" | "gradient" | "cover" | "image";
export type ImagePosition = "center" | "top" | "bottom" | "left" | "right";

export interface ThemePreset {
  id: ThemeId;
  name: string;
  accent: string;
  /** 面板染色（低饱和），不是整屏 hue-rotate */
  tint: RGB;
  grad: { dark: string[]; light: string[] };
  angle: number;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "ocean",
    name: "深海蓝紫",
    accent: "#8b93f8",
    tint: { r: 148, g: 163, b: 216 },
    grad: { dark: ["#1c2452", "#0b1020", "#2a1b4d"], light: ["#dfe6fb", "#eef2f8", "#e9e2fb"] },
    angle: 160,
  },
  {
    id: "aurora",
    name: "极光青绿",
    accent: "#2dd4bf",
    tint: { r: 110, g: 200, b: 190 },
    grad: { dark: ["#0e2f33", "#0b1020", "#123a2e"], light: ["#dcf3ef", "#eef2f8", "#e2f2e9"] },
    angle: 150,
  },
  {
    id: "amber",
    name: "琥珀暖金",
    accent: "#f4b942",
    tint: { r: 220, g: 180, b: 120 },
    grad: { dark: ["#38291a", "#0b1020", "#3d2410"], light: ["#f7ecd9", "#eef2f8", "#f6e6cf"] },
    angle: 170,
  },
  {
    id: "mist",
    name: "雾白银蓝",
    accent: "#8fb3d9",
    tint: { r: 170, g: 190, b: 215 },
    grad: { dark: ["#232c3a", "#0b1020", "#2a3444"], light: ["#e8edf4", "#eef2f8", "#e3e9f2"] },
    angle: 145,
  },
];

export interface BgPrefs {
  /** theme = 跟随默认（唯一会随曲目/封面自动变化的模式）；其余均为用户锁定 */
  type: BgType;
  solid: string;
  gradient: { colors: string[]; angle: number };
  image: { position: ImagePosition; fit: "cover" | "contain"; zoom: number; dim: number; blur: number };
}

export interface MaterialPrefs {
  glass: number; // 玻璃透明度 0..100
  brightness: number; // 背景明暗 0..100（50 = 原样）
  fx: number; // 特效强度 0..100（第 2 轮只用于辉光/模糊，后续轮次复用）
}

export interface Prefs {
  theme: ThemeId;
  mode: ModePref;
  customAccent: string | null;
  followCover: boolean;
  bg: BgPrefs;
  material: MaterialPrefs;
}

export type CoverStatus = "none" | "reading" | "ready" | "missing" | "error";

export interface AppearanceState {
  prefs: Prefs;
  mode: Mode;
  accent: string;
  gradStops: string[];
  palette: Palette | null;
  cover: { status: CoverStatus; url: string | null; message: string };
  customImage: { url: string | null; persisted: boolean };
  imageStats: ImageStats | null;
  /** 实际生效的遮罩不透明度（含自动增亮/压暗与对比度兜底），供验证断言 */
  scrim: number;
  toast: { id: number; text: string } | null;
}

const LS_KEY = "stemplay.appearance.v1";
const IDB_CUSTOM_BG = "custom-bg";
const IDB_COVER = "cover-art";

export const DEFAULT_PREFS: Prefs = {
  theme: "ocean",
  mode: "dark",
  customAccent: null,
  followCover: true,
  bg: {
    type: "theme",
    solid: "#101830",
    gradient: { colors: ["#1c2452", "#2a1b4d"], angle: 160 },
    image: { position: "center", fit: "cover", zoom: 100, dim: 20, blur: 0 },
  },
  material: { glass: 50, brightness: 50, fx: 60 },
};

const clampNum = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** 迁移安全解析：任何字段损坏都回退该项默认值，整体损坏回退全部默认 */
export function sanitizePrefs(raw: unknown): Prefs {
  if (typeof raw !== "object" || raw === null) return structuredClone(DEFAULT_PREFS);
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_PREFS;
  const theme = THEME_PRESETS.some((p) => p.id === r.theme) ? (r.theme as ThemeId) : d.theme;
  const mode = r.mode === "dark" || r.mode === "light" || r.mode === "system" ? r.mode : d.mode;
  const customAccent = isHexColor(r.customAccent) ? (r.customAccent as string) : null;
  const followCover = typeof r.followCover === "boolean" ? r.followCover : d.followCover;
  const bgRaw = (typeof r.bg === "object" && r.bg !== null ? r.bg : {}) as Record<string, unknown>;
  const bgType: BgType = ["theme", "solid", "gradient", "cover", "image"].includes(bgRaw.type as string)
    ? (bgRaw.type as BgType)
    : d.bg.type;
  const gradRaw = (typeof bgRaw.gradient === "object" && bgRaw.gradient !== null ? bgRaw.gradient : {}) as Record<
    string,
    unknown
  >;
  let colors = Array.isArray(gradRaw.colors) ? gradRaw.colors.filter(isHexColor) : [];
  if (colors.length < 2) colors = [...d.bg.gradient.colors];
  colors = colors.slice(0, 4);
  const imgRaw = (typeof bgRaw.image === "object" && bgRaw.image !== null ? bgRaw.image : {}) as Record<string, unknown>;
  const position: ImagePosition = ["center", "top", "bottom", "left", "right"].includes(imgRaw.position as string)
    ? (imgRaw.position as ImagePosition)
    : d.bg.image.position;
  const matRaw = (typeof r.material === "object" && r.material !== null ? r.material : {}) as Record<string, unknown>;
  return {
    theme,
    mode,
    customAccent,
    followCover,
    bg: {
      type: bgType,
      solid: isHexColor(bgRaw.solid) ? (bgRaw.solid as string) : d.bg.solid,
      gradient: { colors, angle: clampNum(gradRaw.angle, 0, 360, d.bg.gradient.angle) },
      image: {
        position,
        fit: imgRaw.fit === "contain" ? "contain" : "cover",
        zoom: clampNum(imgRaw.zoom, 100, 250, d.bg.image.zoom),
        dim: clampNum(imgRaw.dim, -50, 80, d.bg.image.dim),
        blur: clampNum(imgRaw.blur, 0, 40, d.bg.image.blur),
      },
    },
    material: {
      glass: clampNum(matRaw.glass, 0, 100, d.material.glass),
      brightness: clampNum(matRaw.brightness, 0, 100, d.material.brightness),
      fx: clampNum(matRaw.fx, 0, 100, d.material.fx),
    },
  };
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULT_PREFS);
    const parsed = JSON.parse(raw) as { v?: number; prefs?: unknown };
    if (parsed?.v !== 1) return structuredClone(DEFAULT_PREFS);
    return sanitizePrefs(parsed.prefs);
  } catch {
    return structuredClone(DEFAULT_PREFS);
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, prefs }));
  } catch {
    /* 隐私模式等：偏好仅会话内有效，不阻塞交互 */
  }
}

// ---------- store ----------

let state: AppearanceState = {
  prefs: structuredClone(DEFAULT_PREFS),
  mode: "dark",
  accent: THEME_PRESETS[0].accent,
  gradStops: THEME_PRESETS[0].grad.dark,
  palette: null,
  cover: { status: "none", url: null, message: "" },
  customImage: { url: null, persisted: false },
  imageStats: null,
  scrim: 0,
  toast: null,
};

const listeners = new Set<() => void>();
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | null = null;
let mediaQuery: MediaQueryList | null = null;
let initialized = false;

function emit() {
  for (const fn of listeners) fn();
}

function setState(patch: Partial<AppearanceState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribeAppearance(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAppearance(): AppearanceState {
  return state;
}

export function useAppearance(): AppearanceState {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

export function showToast(text: string) {
  const id = ++toastSeq;
  setState({ toast: { id, text } });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.id === id) setState({ toast: null });
  }, 4200);
}

// ---------- 应用 CSS 变量 ----------

const POSITION_MAP: Record<ImagePosition, string> = {
  center: "50% 50%",
  top: "50% 0%",
  bottom: "50% 100%",
  left: "0% 50%",
  right: "100% 50%",
};

export function imageObjectPosition(p: ImagePosition): string {
  return POSITION_MAP[p];
}

function resolveMode(prefs: Prefs): Mode {
  if (prefs.mode !== "system") return prefs.mode;
  return mediaQuery?.matches ? "dark" : "light";
}

function presetOf(id: ThemeId): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? THEME_PRESETS[0];
}

/** 当前背景的平均色/亮度/繁杂度（图片用实测，其余用颜色估算） */
function backgroundApprox(s: AppearanceState): { avg: string; luminance: number; busyness: number } {
  const { bg } = s.prefs;
  const isImage = (bg.type === "image" && s.customImage.url) || (bg.type === "cover" && s.cover.url);
  if (isImage && s.imageStats) {
    return { avg: s.imageStats.avg, luminance: s.imageStats.luminance, busyness: s.imageStats.busyness };
  }
  let stops: string[];
  if (bg.type === "solid") stops = [bg.solid];
  else if (bg.type === "gradient") stops = bg.gradient.colors;
  else stops = s.gradStops;
  const rgbs = stops.map(hexToRgb);
  const avg = rgbToHex({
    r: rgbs.reduce((a, c) => a + c.r, 0) / rgbs.length,
    g: rgbs.reduce((a, c) => a + c.g, 0) / rgbs.length,
    b: rgbs.reduce((a, c) => a + c.b, 0) / rgbs.length,
  });
  return { avg, luminance: relLuminance(avg), busyness: 0.12 };
}

function apply() {
  const s = state;
  const prefs = s.prefs;
  const mode = resolveMode(prefs);
  const preset = presetOf(prefs.theme);
  const useCoverPalette = prefs.followCover && s.palette !== null;

  const rawAccent = prefs.customAccent ?? (useCoverPalette ? s.palette!.accent : preset.accent);
  const accent = correctAccent(rawAccent, mode);
  const gradStops = useCoverPalette ? paletteGradient(s.palette!, mode) : preset.grad[mode];

  const tintHex = rgbToHex(preset.tint);
  const base = mode === "dark" ? "#0b1020" : "#eef2f8";
  const text = mode === "dark" ? "#f2f5fb" : "#1c2536";
  const mutedText = mode === "dark" ? "#a9b4c9" : "#5c6a80";
  const glassAlpha =
    mode === "dark" ? 0.05 + (prefs.material.glass / 100) * 0.12 : 0.5 + (prefs.material.glass / 100) * 0.35;
  const panelColor = mode === "dark" ? tintHex : "#ffffff";
  const card = mode === "dark" ? mixHex(tintHex, "#0f1730", 0.14) : mixHex("#ffffff", tintHex, 0.1);
  const popover = mode === "dark" ? mixHex(tintHex, "#101a36", 0.2) : "#ffffff";
  const surface = mode === "dark" ? mixHex(tintHex, "#1c2542", 0.25) : mixHex("#dfe5ef", tintHex, 0.12);
  const border = mode === "dark" ? "#ffffff1f" : "#16223c1f";
  const input = mode === "dark" ? "#ffffff26" : "#16223c29";
  const primaryFg = contrastRatio(accent, "#ffffff") >= contrastRatio(accent, "#101418") ? "#ffffff" : "#101418";

  // 遮罩：亮/繁杂背景自动加深（深色模式）或提亮（浅色模式），再按面板文字对比度兜底
  const approx = backgroundApprox(s);
  const isImageBg =
    (prefs.bg.type === "image" && s.customImage.url !== null) || (prefs.bg.type === "cover" && s.cover.url !== null);
  const userDim = isImageBg ? prefs.bg.image.dim : 0;
  const scrimColor = mode === "dark" ? "#05080f" : "#f4f7fc";
  let scrim =
    mode === "dark"
      ? 0.18 + Math.max(0, approx.luminance - 0.3) * 1.1 + approx.busyness * 0.18
      : 0.1 + Math.max(0, 0.55 - approx.luminance) * 0.9 + approx.busyness * 0.15;
  scrim = Math.min(0.7, Math.max(0, scrim + Math.max(userDim, 0) / 100));
  const brighten = Math.max(-userDim, 0) / 100;
  // 文字对比兜底：调遮罩而不是改文字色
  for (let i = 0; i < 12; i++) {
    const behind = composite(scrimColor, scrim, approx.avg);
    const panelSurface = composite(panelColor, glassAlpha, behind);
    if (contrastRatio(text, panelSurface) >= 4.5) break;
    scrim = Math.min(0.92, scrim + 0.06);
  }

  // 用户渐变优先写入渐变变量；其余类型用主题/封面派生渐变
  const stopsSrc = prefs.bg.type === "gradient" ? prefs.bg.gradient.colors : gradStops;
  const stops4 = [...stopsSrc];
  while (stops4.length < 4) stops4.push(stops4[stops4.length - 1]);
  const angle = prefs.bg.type === "gradient" ? prefs.bg.gradient.angle : preset.angle;
  const fx = prefs.material.fx / 100;

  const vars: Record<string, string> = {
    "--sp-accent": accent,
    "--sp-bg-base": base,
    "--sp-grad-1": stops4[0],
    "--sp-grad-2": stops4[1],
    "--sp-grad-3": stops4[2],
    "--sp-grad-4": stops4[3],
    "--sp-bg-angle": `${angle}deg`,
    "--sp-solid": prefs.bg.solid,
    "--sp-bg-brightness": String(0.55 + (prefs.material.brightness / 100) * 0.9),
    "--sp-fx": String(fx),
    "--sp-scrim-color": scrimColor,
    "--sp-scrim-alpha": String(scrim),
    "--sp-brighten-alpha": String(brighten),
    "--glass-bg": `${panelColor}${Math.round(glassAlpha * 255).toString(16).padStart(2, "0")}`,
    "--glass-border": mode === "dark" ? "#ffffff24" : "#16223c24",
    "--glass-highlight": mode === "dark" ? "#ffffff17" : "#ffffffb3",
    "--glass-shadow": mode === "dark" ? "0 12px 40px rgba(8,12,28,0.45)" : "0 12px 36px rgba(30,42,66,0.16)",
    "--glass-blur": `${16 + fx * 8}px`,
    "--playhead-glow": `${accent}${Math.round((0.3 + fx * 0.4) * 255).toString(16).padStart(2, "0")}`,
    "--playhead-core": mode === "dark" ? "#ffffff" : "#232c42",
    // shadcn 语义 token：深浅各自定义，不机械反色
    "--background": base,
    "--foreground": text,
    "--card": card,
    "--card-foreground": text,
    "--popover": popover,
    "--popover-foreground": text,
    "--primary": accent,
    "--primary-foreground": primaryFg,
    "--secondary": surface,
    "--secondary-foreground": text,
    "--muted": surface,
    "--muted-foreground": mutedText,
    "--accent": surface,
    "--accent-foreground": text,
    "--border": border,
    "--input": input,
    "--ring": accent,
  };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.classList.toggle("dark", mode === "dark");
  root.style.colorScheme = mode;

  setState({ mode, accent, gradStops, scrim });
}

function updatePrefs(patch: Partial<Prefs>) {
  state = { ...state, prefs: { ...state.prefs, ...patch } };
  savePrefs(state.prefs);
  apply();
}

// ---------- 动作 ----------

export function setTheme(id: ThemeId) {
  // 手选主题 → 暂停跟随封面，直到用户重新开启
  updatePrefs({ theme: id, followCover: false });
}

export function setMode(mode: ModePref) {
  updatePrefs({ mode });
}

export function setCustomAccent(hex: string | null) {
  updatePrefs({ customAccent: hex, followCover: false });
}

export function setFollowCover(on: boolean) {
  updatePrefs({ followCover: on });
  if (on && !state.palette && state.cover.status !== "reading") {
    showToast("尚未提取到可用封面，先保持当前主题；提取成功后自动跟随");
  }
}

export function setBg(patch: Partial<BgPrefs>) {
  const bg = { ...state.prefs.bg, ...patch };
  updatePrefs({ bg });
  if (patch.type === "image" && !state.customImage.url) void restoreCustomImage(false);
}

export function setBgImage(patch: Partial<BgPrefs["image"]>) {
  updatePrefs({ bg: { ...state.prefs.bg, image: { ...state.prefs.bg.image, ...patch } } });
}

export function setBgGradient(patch: Partial<BgPrefs["gradient"]>) {
  updatePrefs({ bg: { ...state.prefs.bg, gradient: { ...state.prefs.bg.gradient, ...patch } } });
}

export function setMaterial(patch: Partial<MaterialPrefs>) {
  updatePrefs({ material: { ...state.prefs.material, ...patch } });
}

export function resetAll() {
  state = { ...state, prefs: structuredClone(DEFAULT_PREFS) };
  savePrefs(state.prefs);
  apply();
  showToast("已恢复默认外观");
}

// ---------- 图片加载与测量 ----------

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片解码失败"));
    img.src = url;
  });
}

async function measureUrl(url: string): Promise<ImageStats | null> {
  try {
    const img = await loadImage(url);
    return measureImage(img, img.naturalWidth, img.naturalHeight);
  } catch {
    return null;
  }
}

export async function setCustomImage(file: File) {
  if (!file.type.startsWith("image/")) {
    showToast("请选择图片文件（PNG/JPEG/WebP…）");
    return;
  }
  const url = URL.createObjectURL(file);
  const stats = await measureUrl(url);
  if (!stats) {
    URL.revokeObjectURL(url);
    showToast("图片无法解码，请换一张试试");
    return;
  }
  if (state.customImage.url) URL.revokeObjectURL(state.customImage.url);
  let persisted = false;
  try {
    await idbSet(IDB_CUSTOM_BG, file);
    persisted = true;
  } catch {
    showToast("自定义图片仅本次会话有效");
  }
  state = { ...state, customImage: { url, persisted }, imageStats: stats };
  updatePrefs({ bg: { ...state.prefs.bg, type: "image" } });
}

export function removeCustomImage() {
  if (state.customImage.url) URL.revokeObjectURL(state.customImage.url);
  state = { ...state, customImage: { url: null, persisted: false }, imageStats: null };
  void idbDel(IDB_CUSTOM_BG).catch(() => undefined);
  updatePrefs({ bg: { ...state.prefs.bg, type: state.prefs.bg.type === "image" ? "theme" : state.prefs.bg.type } });
}

async function restoreCustomImage(notifyMissing: boolean) {
  try {
    const blob = await idbGet(IDB_CUSTOM_BG);
    if (!blob) {
      if (notifyMissing && state.prefs.bg.type === "image") {
        updatePrefs({ bg: { ...state.prefs.bg, type: "theme" } });
        showToast("未找到已保存的自定义图片，已回到主题渐变");
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const stats = await measureUrl(url);
    if (!stats) {
      URL.revokeObjectURL(url);
      return;
    }
    if (state.customImage.url) URL.revokeObjectURL(state.customImage.url);
    setState({ customImage: { url, persisted: true }, imageStats: stats });
    apply();
  } catch {
    if (notifyMissing && state.prefs.bg.type === "image") {
      updatePrefs({ bg: { ...state.prefs.bg, type: "theme" } });
      showToast("读取已保存图片失败，已回到主题渐变");
    }
  }
}

// ---------- 封面取色 ----------

/** 本会话用户是否手动提取过封面（决定资源包 artwork 是否可以进入取色流程） */
let sessionCoverImported = false;

export function hasSessionCoverImport(): boolean {
  return sessionCoverImported;
}

/**
 * 资源包自带封面（manifest.track.artwork）→ 走与手动提取相同的取色路径。
 * 调用方保证 followCover 开启且用户本会话未手动导入封面；失败静默保持原状态。
 */
export async function applyArtworkFromBlob(blob: Blob) {
  const prev = state.cover;
  setState({ cover: { ...prev, status: "reading", message: "正在读取资源包封面…" } });
  try {
    const { palette, stats, url } = await extractCoverBlob(blob);
    if (prev.url && prev.url !== url) URL.revokeObjectURL(prev.url);
    try {
      await idbSet(IDB_COVER, blob);
    } catch {
      /* 持久化失败：仅会话内生效，不打扰 */
    }
    setState({
      palette,
      imageStats: state.prefs.bg.type === "cover" ? stats : state.imageStats,
      cover: {
        status: "ready",
        url,
        message: palette
          ? "已跟随资源包封面配色"
          : "资源包封面为黑白或色彩过少，已保持默认主题（仍可用作背景）",
      },
    });
    apply();
    if (state.prefs.bg.type === "cover") void refreshCoverStats();
  } catch {
    setState({ cover: prev }); // 资源包封面解码失败：回到之前的封面状态，无视觉回归
  }
}

async function extractCoverBlob(blob: Blob): Promise<{ palette: Palette | null; stats: ImageStats | null; url: string }> {
  const url = URL.createObjectURL(blob);
  const img = await loadImage(url); // 损坏图片在此抛错 → 上层兜底
  const palette = extractPalette(img, img.naturalWidth, img.naturalHeight);
  const stats = measureImage(img, img.naturalWidth, img.naturalHeight);
  return { palette, stats, url };
}

/**
 * 仅提取主题素材（内嵌封面 → 调色板），不会把歌曲加入曲库。
 * 只在用户导入/恢复时调用，绝不逐帧。
 */
export async function importCoverFromFile(file: File) {
  sessionCoverImported = true; // 用户本会话手动导入过封面 → 资源包 artwork 不再抢占取色
  setState({ cover: { ...state.cover, status: "reading", message: "正在读取内嵌封面…" } });
  try {
    const { parseBlob, selectCover } = await import("music-metadata");
    const meta = await parseBlob(file, { duration: false, skipCovers: false });
    const picture = selectCover(meta.common.picture);
    if (!picture) {
      setState({ cover: { status: "missing", url: null, message: "该音频未内嵌封面，已保持当前主题" } });
      return;
    }
    const blob = new Blob([picture.data as BlobPart], { type: picture.format ?? "image/jpeg" });
    const { palette, stats, url } = await extractCoverBlob(blob);
    if (state.cover.url) URL.revokeObjectURL(state.cover.url);
    try {
      await idbSet(IDB_COVER, blob);
    } catch {
      showToast("封面仅本次会话有效");
    }
    setState({
      palette,
      imageStats: state.prefs.bg.type === "cover" ? stats : state.imageStats,
      cover: {
        status: "ready",
        url,
        message: palette
          ? "已提取封面配色"
          : "封面为黑白或色彩过少，已保持默认主题（仍可用作背景）",
      },
    });
    apply();
    if (state.prefs.bg.type === "cover") void refreshCoverStats();
  } catch (err) {
    setState({
      cover: {
        status: "error",
        url: null,
        message: `封面解析失败（${err instanceof Error ? err.message : String(err)}），已保持当前主题`,
      },
    });
  }
}

async function refreshCoverStats() {
  if (!state.cover.url) return;
  const stats = await measureUrl(state.cover.url);
  if (stats) {
    setState({ imageStats: stats });
    apply();
  }
}

export function applyCoverBackground() {
  if (!state.cover.url) {
    showToast("尚未提取到封面，请先从本地音频提取");
    return;
  }
  void refreshCoverStats();
  setBg({ type: "cover" });
}

export function clearCover() {
  if (state.cover.url) URL.revokeObjectURL(state.cover.url);
  void idbDel(IDB_COVER).catch(() => undefined);
  setState({ palette: null, cover: { status: "none", url: null, message: "" } });
  apply();
}

// ---------- 初始化 ----------

export function initAppearance() {
  if (initialized) return;
  initialized = true;
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", () => {
    if (state.prefs.mode === "system") apply();
  });
  state = { ...state, prefs: loadPrefs() };
  apply();
  // 异步恢复本地 blob；失败各自降级，不阻塞首屏
  if (state.prefs.bg.type === "image") void restoreCustomImage(true);
  void (async () => {
    try {
      const blob = await idbGet(IDB_COVER);
      if (!blob) return;
      const { palette, stats, url } = await extractCoverBlob(blob);
      setState({
        palette,
        cover: { status: "ready", url, message: palette ? "已恢复上次提取的封面配色" : "封面为黑白，保持默认主题" },
        imageStats: state.prefs.bg.type === "cover" ? stats : state.imageStats,
      });
      apply();
    } catch {
      /* 封面恢复失败静默回退默认主题 */
    }
  })();
}

/** 供 dev 验证与后续轮次使用的 store 门面 */
export const themeStore = {
  getState: getAppearance,
  subscribe: subscribeAppearance,
  setTheme,
  setMode,
  setCustomAccent,
  setFollowCover,
  setBg,
  setBgImage,
  setBgGradient,
  setMaterial,
  resetAll,
  setCustomImage,
  removeCustomImage,
  importCoverFromFile,
  applyArtworkFromBlob,
  hasSessionCoverImport,
  applyCoverBackground,
  clearCover,
  showToast,
  DEFAULT_PREFS,
  THEME_PRESETS,
};