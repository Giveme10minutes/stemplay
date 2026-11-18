import { useEffect, useMemo, useRef } from "react";
import { fxStore } from "@/lib/fx";
import { imageObjectPosition, useAppearance } from "@/lib/theme";
import type { DrawFn } from "@/lib/view";

// 全屏氛围背景：底色 + 主题/自定义渐变 + 纯色 + 图片（封面/自定义）+ 自动遮罩。
// 颜色/角度/遮罩走 :root 上注册过的 CSS 变量过渡（400ms 缓出、可中断）；
// 图片换 URL 用 keyed 淡入；模糊/位置/缩放等参数直接作用于图层，短过渡跟手。
// 第 4 轮：装饰辉光层由单一 rAF 循环驱动缓慢漂移，持续高能场景时流速至多 +20%、光晕轻加强；
// reduced-motion / 动效 master 关 / 安静档 → 相位停止推进（不位移、不推动）。

interface BackgroundLayerProps {
  registerDraw?: (id: string, fn: DrawFn | null) => void;
}

export function BackgroundLayer({ registerDraw }: BackgroundLayerProps) {
  const s = useAppearance();
  const { bg } = s.prefs;
  const glowRef = useRef<HTMLDivElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(0);

  useEffect(() => {
    if (!registerDraw) return;
    const draw: DrawFn = (_pos, _t0, _t1, dt) => {
      const fx = fxStore;
      if (!fx.reduced && fx.motionOn && fx.motionTier !== "quiet") {
        phaseRef.current += dt * 0.05 * fx.scene.flowMult;
      }
      const ph = phaseRef.current;
      const g = glowRef.current;
      if (g) g.style.transform = `translate3d(${(Math.sin(ph) * 26).toFixed(2)}px, ${(Math.cos(ph * 0.8) * 14).toFixed(2)}px, 0)`;
      const h = haloRef.current;
      if (h) h.style.opacity = (fx.scene.halo * 0.4 * (0.4 + 0.6 * fx.fx)).toFixed(4);
    };
    registerDraw("bg-scene", draw);
    return () => registerDraw("bg-scene", null);
  }, [registerDraw]);

  const imageUrl = activeImageUrl(s);
  // 无图可用时回退当前主题渐变（规格 B）
  const showGradient =
    bg.type === "theme" || bg.type === "gradient" || ((bg.type === "image" || bg.type === "cover") && !imageUrl);
  const showSolid = bg.type === "solid";
  const showImage = imageUrl !== null && (bg.type === "image" || bg.type === "cover");

  // 渐变 stop 位置随数量变化（2-4 个），颜色本身由变量过渡
  const stops = bg.type === "gradient" ? bg.gradient.colors : s.gradStops;
  const n = Math.max(2, Math.min(4, stops.length));
  const pos = useMemo(() => {
    const p = [0, 100, 100, 100];
    if (n === 3) p[1] = 50;
    if (n === 4) {
      p[1] = 33.33;
      p[2] = 66.67;
    }
    return p;
  }, [n]);
  const gradientImage = `linear-gradient(var(--sp-bg-angle), var(--sp-grad-1) ${pos[0]}%, var(--sp-grad-2) ${pos[1]}%, var(--sp-grad-3) ${pos[2]}%, var(--sp-grad-4) ${pos[3]}%)`;

  const img = bg.image;
  const imageStyle: React.CSSProperties = {
    objectFit: img.fit,
    objectPosition: imageObjectPosition(img.position),
    transform: `scale(${img.zoom / 100})`,
    transformOrigin: imageObjectPosition(img.position),
    filter: `blur(${img.blur}px)`,
    transition: "filter 200ms ease-out, transform 200ms ease-out, object-position 200ms ease-out",
  };

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0" style={{ background: "var(--sp-bg-base)" }} />
      <div
        className="absolute inset-0"
        style={{
          filter: "brightness(var(--sp-bg-brightness))",
          transition: "filter 200ms ease-out",
        }}
      >
        <div
          data-testid="bg-gradient"
          className="absolute inset-0"
          style={{
            backgroundImage: gradientImage,
            opacity: showGradient ? 1 : 0,
            transition: "opacity 400ms ease-out",
          }}
        />
        <div
          data-testid="bg-solid"
          className="absolute inset-0"
          style={{
            background: "var(--sp-solid)",
            opacity: showSolid ? 1 : 0,
            transition: "opacity 400ms ease-out",
          }}
        />
        {showImage && imageUrl && (
          <img
            key={imageUrl}
            data-testid="bg-image"
            src={imageUrl}
            alt=""
            className="sp-bg-img absolute inset-0 size-full"
            style={imageStyle}
          />
        )}
        {/* 特效强度驱动的装饰辉光（第 3 轮起复用 --sp-fx）；持续高能场景下缓慢漂移 */}
        <div
          ref={glowRef}
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(900px 480px at 78% -8%, color-mix(in srgb, var(--sp-accent) 26%, transparent), transparent), radial-gradient(760px 420px at 6% 108%, color-mix(in srgb, var(--sp-grad-1) 55%, transparent), transparent)",
            opacity: "calc(var(--sp-fx) * 0.6)",
            transition: "opacity 200ms ease-out",
          }}
        />
        {/* 持续高能场景光晕：不透明度由 rAF 循环按 scene.halo 写入（进入/退出各自平滑） */}
        <div
          ref={haloRef}
          data-testid="scene-halo"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(1100px 620px at 50% 118%, color-mix(in srgb, var(--sp-accent) 40%, transparent), transparent)",
            opacity: 0,
          }}
        />
      </div>
      <div
        data-testid="bg-scrim"
        className="absolute inset-0"
        style={{ background: "var(--sp-scrim-color)", opacity: "var(--sp-scrim-alpha)" }}
      />
      <div
        data-testid="bg-brighten"
        className="absolute inset-0"
        style={{ background: "#ffffff", opacity: "var(--sp-brighten-alpha)" }}
      />
    </div>
  );
}

function activeImageUrl(s: ReturnType<typeof useAppearance>): string | null {
  if (s.prefs.bg.type === "image") return s.customImage.url;
  if (s.prefs.bg.type === "cover") return s.cover.url;
  return null;
}