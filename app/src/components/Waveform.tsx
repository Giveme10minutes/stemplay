import { useEffect, useRef } from "react";
import type { TrackInfo } from "@/lib/resources";
import { clamp, type DrawFn } from "@/lib/view";

interface WaveformProps {
  track: TrackInfo;
  duration: number;
  registerDraw: (id: string, fn: DrawFn | null) => void;
  xToTime: (frac: number) => number;
  onScrubStart: () => void;
  onScrubMove: (t: number) => void;
  onScrubEnd: (t?: number) => void;
}

interface StaticCache {
  c0: number;
  c1: number;
  W: number;
  H: number;
  span: number;
}

export function Waveform({
  track,
  duration,
  registerDraw,
  xToTime,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offDimRef = useRef<HTMLCanvasElement | null>(null);
  const offBrightRef = useRef<HTMLCanvasElement | null>(null);
  const cacheRef = useRef<StaticCache | null>(null);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    const draw: DrawFn = (pos, t0, t1) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;
      const span = t1 - t0;
      if (span <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(cssW * dpr));
      const H = Math.max(1, Math.round(cssH * dpr));
      if (!offDimRef.current) offDimRef.current = document.createElement("canvas");
      if (!offBrightRef.current) offBrightRef.current = document.createElement("canvas");
      const offDim = offDimRef.current;
      const offBright = offBrightRef.current;

      const cache = cacheRef.current;
      let rebuild =
        !cache || cache.W !== W || cache.H !== H || Math.abs(cache.span - span) > 1e-6;
      if (!rebuild && cache) {
        if (t0 < cache.c0 - 1e-9 || t1 > cache.c1 + 1e-9) {
          rebuild = true;
        } else {
          // 缓存窗口两侧各留 0.5 span 余量，消耗到 0.1 span 才重绘静态层
          const margin = 0.1 * span;
          if (cache.c0 > 1e-9 && t0 - cache.c0 < margin) rebuild = true;
          if (cache.c1 < duration - 1e-9 && cache.c1 - t1 < margin) rebuild = true;
        }
      }

      if (rebuild) {
        const c0 = Math.max(0, t0 - 0.5 * span);
        const c1 = Math.min(duration, t1 + 0.5 * span);
        const pxPerSec = W / span;
        const Wc = Math.max(W, Math.round((c1 - c0) * pxPerSec));
        offDim.width = Wc;
        offDim.height = H;
        offBright.width = Wc;
        offBright.height = H;
        const cssColor = getComputedStyle(document.documentElement)
          .getPropertyValue(`--track-${track.id}`)
          .trim();
        const color = cssColor || track.color;
        const { peakMin, peakMax } = track.features.arrays;
        const n = track.features.nFrames;
        const fr = track.features.frameRate;
        const mid = H / 2;
        const scale = mid * 0.92;
        const gd = offDim.getContext("2d")!;
        const gb = offBright.getContext("2d")!;
        gd.fillStyle = color;
        gb.fillStyle = color;
        gd.globalAlpha = 0.35;
        gb.globalAlpha = 1;
        for (let x = 0; x < Wc; x++) {
          const ta = c0 + (x / Wc) * (c1 - c0);
          const tb = c0 + ((x + 1) / Wc) * (c1 - c0);
          const i0 = clamp(Math.floor(ta * fr), 0, n - 1);
          const i1 = clamp(Math.ceil(tb * fr) - 1, i0, n - 1);
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = i0; i <= i1; i++) {
            if (peakMin[i] < mn) mn = peakMin[i];
            if (peakMax[i] > mx) mx = peakMax[i];
          }
          if (mn > mx) {
            mn = 0;
            mx = 0;
          }
          const y0 = mid - mx * scale;
          const h = Math.max(1, mid - mn * scale - y0);
          gd.fillRect(x, y0, 1, h);
          gb.fillRect(x, y0, 1, h);
        }
        cacheRef.current = { c0, c1, W, H, span };
      }

      const c = cacheRef.current!;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const g = canvas.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, W, H);
      const sx = Math.round((t0 - c.c0) * (W / span));
      g.drawImage(offDim, sx, 0, W, H, 0, 0, W, H);
      const px = clamp((pos - t0) / span, 0, 1) * W;
      if (px > 0) {
        g.save();
        g.beginPath();
        g.rect(0, 0, px, H);
        g.clip();
        g.drawImage(offBright, sx, 0, W, H, 0, 0, W, H);
        g.restore();
      }
    };
    registerDraw(track.id, draw);
    return () => registerDraw(track.id, null);
  }, [track, duration, registerDraw]);

  const fracFromEvent = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };

  return (
    <canvas
      ref={canvasRef}
      data-track={track.id}
      className="block w-full cursor-crosshair touch-none border-b border-border select-none"
      style={{ height: "var(--row-h)" }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        try {
          canvasRef.current!.setPointerCapture(e.pointerId);
        } catch {
          /* 旧浏览器 */
        }
        scrubbingRef.current = true;
        onScrubStart();
        onScrubMove(xToTime(fracFromEvent(e)));
      }}
      onPointerMove={(e) => {
        if (scrubbingRef.current) onScrubMove(xToTime(fracFromEvent(e)));
      }}
      onPointerUp={(e) => {
        if (!scrubbingRef.current) return;
        scrubbingRef.current = false;
        onScrubEnd(xToTime(fracFromEvent(e)));
      }}
      onPointerCancel={() => {
        if (!scrubbingRef.current) return;
        scrubbingRef.current = false;
        onScrubEnd();
      }}
    />
  );
}