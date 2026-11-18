// 封面取色与颜色数学。除 canvas 外零依赖；只在导入/切歌/恢复时调用，绝不逐帧。

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Palette {
  dominant: string;
  accent: string;
  candidates: string[];
}

export interface ImageStats {
  /** 平均相对亮度 0..1 */
  luminance: number;
  /** 亮度标准差，近似"繁杂程度" 0..1 */
  busyness: number;
  /** 平均色，用于对比度估算 */
  avg: string;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  if (h.length < 6 || Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function isHexColor(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s.trim());
}

/** WCAG 相对亮度 */
export function relLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** src 以 alpha 叠在 dst 上（均为不透明 hex） */
export function composite(src: string, alpha: number, dst: string): string {
  const s = hexToRgb(src);
  const d = hexToRgb(dst);
  const a = clamp01(alpha);
  return rgbToHex({
    r: s.r * a + d.r * (1 - a),
    g: s.g * a + d.g * (1 - a),
    b: s.b * a + d.b * (1 - a),
  });
}

export function mixHex(a: string, b: string, t: number): string {
  return composite(a, clamp01(t), b);
}

export function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 1) + 1) % 1;
  s = clamp01(s);
  l = clamp01(l);
  if (s === 0) return rgbToHex({ r: l * 255, g: l * 255, b: l * 255 });
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return rgbToHex({ r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 });
}

/** 按模式校正强调色明度/饱和度，保证与底色可区分（浅色压暗到 ≥3:1 对比） */
export function correctAccent(hex: string, mode: "dark" | "light"): string {
  const { h, s, l } = rgbToHsl(hexToRgb(hex));
  const sat = Math.max(s, 0.35);
  const light = mode === "dark" ? Math.min(0.72, Math.max(0.55, l)) : Math.min(0.42, Math.max(0.28, l));
  return hslToHex(h, sat, light);
}

interface Box {
  pixels: RGB[];
}

function boxRange(pixels: RGB[]): { channel: keyof RGB; range: number } {
  let best: keyof RGB = "r";
  let bestRange = -1;
  for (const ch of ["r", "g", "b"] as const) {
    let mn = 255;
    let mx = 0;
    for (const p of pixels) {
      if (p[ch] < mn) mn = p[ch];
      if (p[ch] > mx) mx = p[ch];
    }
    if (mx - mn > bestRange) {
      bestRange = mx - mn;
      best = ch;
    }
  }
  return { channel: best, range: bestRange };
}

function medianCut(pixels: RGB[], maxBoxes: number): { avg: RGB; count: number }[] {
  let boxes: Box[] = [{ pixels }];
  while (boxes.length < maxBoxes) {
    // 取跨度最大的盒子沿最长 channel 中位切分
    let target = -1;
    let targetRange = 8; // 跨度太小不值得再切
    let channel: keyof RGB = "r";
    boxes.forEach((b, i) => {
      if (b.pixels.length < 2) return;
      const { channel: ch, range } = boxRange(b.pixels);
      if (range > targetRange) {
        targetRange = range;
        target = i;
        channel = ch;
      }
    });
    if (target < 0) break;
    const box = boxes[target];
    const sorted = [...box.pixels].sort((a, b) => a[channel] - b[channel]);
    const mid = sorted.length >> 1;
    boxes.splice(target, 1, { pixels: sorted.slice(0, mid) }, { pixels: sorted.slice(mid) });
  }
  return boxes
    .filter((b) => b.pixels.length > 0)
    .map((b) => {
      let r = 0;
      let g = 0;
      let bl = 0;
      for (const p of b.pixels) {
        r += p.r;
        g += p.g;
        bl += p.b;
      }
      const n = b.pixels.length;
      return { avg: { r: r / n, g: g / n, b: bl / n }, count: n };
    });
}

/**
 * 从图像提取调色板（median-cut）。缩到 ~96px 抽样，忽略近透明像素。
 * 黑白/近灰封面返回 null → 调用方回退默认主题，不伪造彩色。
 */
export function extractPalette(source: CanvasImageSource, srcW: number, srcH: number): Palette | null {
  if (srcW <= 0 || srcH <= 0) return null;
  const size = 96;
  const scale = Math.min(size / srcW, size / srcH, 1);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(source, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 跨域污染等
  }
  const pixels: RGB[] = [];
  let satSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const p = { r: data[i], g: data[i + 1], b: data[i + 2] };
    pixels.push(p);
    satSum += rgbToHsl(p).s;
  }
  if (pixels.length < 16) return null;
  if (satSum / pixels.length < 0.07) return null; // 黑白/近灰封面

  const boxes = medianCut(pixels, 8).sort((a, b) => b.count - a.count);
  const dominant = rgbToHex(boxes[0].avg);
  // 强调色：饱和度×占比权衡，避免选到一小撮噪声色
  let accentBox = boxes[0];
  let bestScore = -1;
  for (const b of boxes) {
    const { s, l } = rgbToHsl(b.avg);
    if (l < 0.08 || l > 0.94) continue;
    const score = s * Math.sqrt(b.count / pixels.length);
    if (score > bestScore) {
      bestScore = score;
      accentBox = b;
    }
  }
  const accent = rgbToHex(accentBox.avg);
  const candidates = boxes.slice(0, 5).map((b) => rgbToHex(b.avg));
  return { dominant, accent, candidates };
}

/** 粗测背景图亮度/繁杂度/均色，用于自动遮罩 */
export function measureImage(source: CanvasImageSource, srcW: number, srcH: number): ImageStats | null {
  if (srcW <= 0 || srcH <= 0) return null;
  const size = 48;
  const scale = Math.min(size / srcW, size / srcH, 1);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(source, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = g.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const lums: number[] = [];
  let r = 0;
  let gr = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    lums.push(relLuminance(rgbToHex({ r: data[i], g: data[i + 1], b: data[i + 2] })));
    r += data[i];
    gr += data[i + 1];
    b += data[i + 2];
    n++;
  }
  if (n === 0) return null;
  const mean = lums.reduce((a, v) => a + v, 0) / n;
  const variance = lums.reduce((a, v) => a + (v - mean) * (v - mean), 0) / n;
  return {
    luminance: mean,
    busyness: clamp01(Math.sqrt(variance) * 2.2),
    avg: rgbToHex({ r: r / n, g: gr / n, b: b / n }),
  };
}

/** 由封面调色板派生氛围渐变（深色压向底色、浅色提向乳白），不做机械 hue-rotate */
export function paletteGradient(palette: Palette, mode: "dark" | "light"): string[] {
  const base = mode === "dark" ? "#0b1020" : "#eef2f8";
  const d = palette.dominant;
  const a = palette.accent;
  if (mode === "dark") {
    return [mixHex(d, base, 0.72), base, mixHex(a, base, 0.8)];
  }
  return [mixHex(d, base, 0.82), base, mixHex(a, base, 0.86)];
}