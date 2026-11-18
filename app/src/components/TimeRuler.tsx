import { useEffect, useRef } from "react";
import { useAppearance } from "@/lib/theme";
import { fmt, type DrawFn, type ViewRange } from "@/lib/view";

interface TimeRulerProps {
  originSec: number;
  registerDraw: (fn: DrawFn | null) => void;
  getView: () => ViewRange;
  onPan: (dt: number) => void;
}

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

export function TimeRuler({ originSec, registerDraw, getView, onPan }: TimeRulerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastKeyRef = useRef("");
  const panningRef = useRef(false);
  const lastXRef = useRef(0);
  const mode = useAppearance().mode;

  useEffect(() => {
    const draw: DrawFn = (_pos, t0, t1) => {
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
      const key = `${W}|${H}|${t0.toFixed(4)}|${t1.toFixed(4)}|${originSec}|${mode}`;
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const g = canvas.getContext("2d")!;
      g.clearRect(0, 0, W, H);
      const pxPerSec = cssW / span;
      const step = STEPS.find((s) => s * pxPerSec >= 64) ?? STEPS[STEPS.length - 1];
      g.strokeStyle = mode === "dark" ? "rgba(255,255,255,0.35)" : "rgba(28,37,54,0.35)";
      g.fillStyle = mode === "dark" ? "rgba(255,255,255,0.6)" : "rgba(28,37,54,0.65)";
      g.lineWidth = 1;
      g.font = `${Math.round(10 * dpr)}px 'Geist Variable', 'Microsoft YaHei', sans-serif`;
      g.textBaseline = "top";
      g.beginPath();
      g.moveTo(0, H - 0.5);
      g.lineTo(W, H - 0.5);
      g.stroke();
      const k0 = Math.ceil(t0 / step - 1e-6);
      const k1 = Math.floor(t1 / step + 1e-6);
      for (let k = k0; k <= k1; k++) {
        const t = k * step;
        const x = Math.round(((t - t0) / span) * W) + 0.5;
        g.beginPath();
        g.moveTo(x, H - 7 * dpr);
        g.lineTo(x, H);
        g.stroke();
        g.fillText(fmt(originSec + t), x + 3 * dpr, 2 * dpr);
        const half = t + step / 2;
        if (half < t1) {
          const hx = Math.round(((half - t0) / span) * W) + 0.5;
          g.beginPath();
          g.moveTo(hx, H - 4 * dpr);
          g.lineTo(hx, H);
          g.stroke();
        }
      }
    };
    registerDraw(draw);
    return () => registerDraw(null);
  }, [originSec, registerDraw, mode]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="time-ruler"
      className="block w-full cursor-grab touch-none active:cursor-grabbing"
      style={{ height: "var(--ruler-h)" }}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        e.preventDefault();
        try {
          canvasRef.current!.setPointerCapture(e.pointerId);
        } catch {
          /* 旧浏览器 */
        }
        panningRef.current = true;
        lastXRef.current = e.clientX;
      }}
      onPointerMove={(e) => {
        if (!panningRef.current) return;
        const dx = e.clientX - lastXRef.current;
        lastXRef.current = e.clientX;
        const { t0, t1 } = getView();
        const width = canvasRef.current!.clientWidth || 1;
        onPan((-dx * (t1 - t0)) / width);
      }}
      onPointerUp={() => {
        panningRef.current = false;
      }}
      onPointerCancel={() => {
        panningRef.current = false;
      }}
    />
  );
}