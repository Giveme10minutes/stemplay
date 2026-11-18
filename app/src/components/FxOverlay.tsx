import { useEffect, useRef } from "react";
import type { StemEngine } from "@/audio/engine";
import {
  approach,
  BAR_ENTER,
  BAR_EXIT,
  cull,
  hash01,
  hexToRgb,
  IMPACT_DECAY,
  ONSET_TRIGGER,
  RIPPLE_LIFE,
  rgba,
  SHAKE_BASE_PX,
  type FxStore,
} from "@/lib/fx";
import type { TrackInfo } from "@/lib/resources";
import { clamp, type DrawFn } from "@/lib/view";

interface FxOverlayProps {
  track: TrackInfo;
  duration: number;
  registerDraw: (id: string, fn: DrawFn | null) => void;
  fx: FxStore;
  getEngine: () => StemEngine | null;
}

interface Bar {
  t0: number;
  t1: number;
  avg: number;
}

/**
 * 第 3 轮基础音画叠加层：光带穿梭 / 播放线接触波纹+粒子 / 频带呼吸。
 * 叠在静态波形 canvas 之上（pointer-events-none，scrub 不受影响），
 * 每帧只画本叠加层，静态波形缓存纪律不动。
 */
export function FxOverlay({ track, duration, registerDraw, fx, getEngine }: FxOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef<{ rgb: { r: number; g: number; b: number }; at: number }>({
    rgb: hexToRgb(track.color),
    at: -10,
  });

  useEffect(() => {
    const draw: DrawFn = (pos, t0, t1, dt, now) => {
      const canvas = canvasRef.current;
      const engine = getEngine();
      if (!canvas || !engine) return;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;
      const span = t1 - t0;
      if (span <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, Math.round(cssW * dpr));
      const H = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      const g2 = canvas.getContext("2d")!;
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      g2.clearRect(0, 0, cssW, cssH);

      const st = fx.ensure(track.id);
      const f = track.features;
      const d = f.display;
      const fr = f.frameRate;
      const n = f.nFrames;
      const idx = clamp(Math.floor(pos * fr), 0, n - 1);
      // 视觉增益（stepImpacts 每帧先算好）：镜像 setTargetAtTime 指数包络，
      // 聚光过渡中非聚焦轨随真实增益渐暗但保持可见；mute/solo 仍以 ~10ms 时间常数收敛到 0
      const gain = st.gv;
      const gain2 = gain * gain;
      // 空间动效总闸：reduced-motion / master 关 / 安静档 → 只留明暗反馈（光带/段条/呼吸）
      const spatial = !fx.reduced && fx.motionOn && fx.motionTier !== "quiet";

      // 高能冲击抖动：只在叠加 canvas 内部 translate 装饰内容（≤3px），DOM 控件绝不受影响
      const iAge = now - st.impactAt;
      const inImpact = spatial && iAge >= 0 && iAge < IMPACT_DECAY;
      const shakeAmp = inImpact ? SHAKE_BASE_PX * fx.motion.shake * st.impactStrength * (1 - iAge / IMPACT_DECAY) : 0;
      st.shakePx = shakeAmp;
      if (shakeAmp > 0.01) {
        g2.translate(Math.sin(iAge * 110) * shakeAmp, Math.cos(iAge * 91) * shakeAmp * 0.6);
      }

      // 显示映射：rms/onset 幅度量 ×g；low/mid/high 均方量 ×g²；共享 ref，不逐轨归一
      st.dispRms = clamp((f.arrays.rms[idx] * gain) / d.rmsRef, 0, 1);
      st.dispLow = clamp((f.arrays.low[idx] * gain2) / d.bandRef, 0, 1);
      st.dispMid = clamp((f.arrays.mid[idx] * gain2) / d.bandRef, 0, 1);
      st.dispHigh = clamp((f.arrays.high[idx] * gain2) / d.bandRef, 0, 1);
      st.dispOnset = clamp((f.arrays.onset[idx] * gain) / d.onsetRef, 0, 1);
      st.silent = f.arrays.rms[idx] < d.silenceThreshold;

      // seek/后台返回检测：位置回退或大跳变 → 清空波纹/粒子/包络，不补放历史事件
      const jump = st.lastPos < 0 || pos < st.lastPos - 1e-6 || pos - st.lastPos > Math.max(0.25, dt * 4);
      if (jump) {
        st.ripples.length = 0;
        st.particles.length = 0;
        st.envLow = st.envMid = st.envHigh = st.envRms = 0;
      }
      const advancing = engine.playing && !jump;

      // onset 区间跨越触发（prevIdx < i <= idx 的整数帧遍历，绝不做浮点相等比较）
      // reduced-motion / 动效 master 关：波纹环/粒子均属空间振动，整体关闭
      if (advancing && !st.silent && spatial) {
        const from = st.lastFrameIdx < 0 ? idx : Math.min(st.lastFrameIdx + 1, idx);
        for (let i = from; i <= idx; i++) {
          const ov = (f.arrays.onset[i] * gain) / d.onsetRef;
          if (ov > ONSET_TRIGGER && f.arrays.rms[i] >= d.silenceThreshold) {
            const strength = Math.min(1, ov);
            st.ripples.push({ t: i / fr, bornAt: now, strength });
            st.spawnedRipples += 1;
            if (fx.motion.particle > 0.05) {
              const cap = fx.particleCap;
              const want = Math.round(
                (fx.mobile ? 1 + hash01(i * 3.7) * 1 : 2 + hash01(i * 3.7) * 3) * (0.4 + 0.6 * fx.fx) * fx.motion.particle,
              );
              for (let k = 0; k < want && fx.totalParticles() < cap; k++) {
                const seed = i * 91.7 + k * 17.3;
                st.particles.push({
                  t: i / fr,
                  vSec: (hash01(seed) - 0.5) * 3.2, // 沿轨道水平扩散
                  y0: (hash01(seed + 5) - 0.5) * 0.4,
                  vY: (hash01(seed + 9) - 0.5) * 0.5,
                  bornAt: now,
                  life: 0.22 + hash01(seed + 13) * 0.12,
                  size: 1 + hash01(seed + 17) * 1.6,
                });
                st.spawnedParticles += 1;
              }
            }
            break; // 每帧每轨最多一个事件，防爆量
          }
        }
      }
      st.lastPos = pos;
      st.lastFrameIdx = idx;

      // 包络按真实 dt 积分；暂停时目标为 0 → 装饰动画短暂收敛，不冻结在半闪状态
      const live = advancing ? 1 : 0;
      st.envLow = approach(st.envLow, st.dispLow * live, dt);
      st.envMid = approach(st.envMid, st.dispMid * live, dt);
      st.envHigh = approach(st.envHigh, st.dispHigh * live, dt);
      st.envRms = approach(st.envRms, st.dispRms * live, dt);

      cull(st.ripples, (r) => now - r.bornAt <= RIPPLE_LIFE);
      cull(st.particles, (p) => now - p.bornAt <= p.life);

      // fx=0 应显著收敛但不完全消失；reduced-motion 关闭空间振动/粒子/流光
      const fxk = (0.2 + 0.8 * fx.fx) * (0.55 + 0.45 * fx.motion.glow);
      const dark = document.documentElement.classList.contains("dark");
      const rgb = colorRef.current;
      if (now - rgb.at > 1) {
        const css = getComputedStyle(document.documentElement).getPropertyValue(`--track-${track.id}`).trim();
        rgb.rgb = hexToRgb(css || track.color);
        rgb.at = now;
      }
      const c = rgb.rgb;
      const comp = dark ? "lighter" : "source-over";
      const xOf = (t: number) => ((t - t0) / span) * cssW;
      const phX = xOf(pos);
      const midY = cssH / 2;
      // 光带/波纹总强度随包络：静音（g=0）时收敛到近乎不可见，只留播放线本体
      const E = 0.12 + 0.88 * st.envRms;

      g2.globalCompositeOperation = comp;

      // C-低频呼吸：宽幅柔光随 envLow 起伏（reduced 时去掉正弦起伏）
      if (st.envLow > 0.005) {
        const undulate = fx.reduced ? 1 : 0.8 + 0.2 * Math.sin(now * 2.4 + idx * 0.01);
        const r = Math.max(24, cssW * (0.08 + 0.24 * st.envLow));
        const grad = g2.createRadialGradient(phX, midY, 0, phX, midY, r);
        const a = 0.16 * st.envLow * fxk * undulate;
        grad.addColorStop(0, rgba(c, a));
        grad.addColorStop(1, rgba(c, 0));
        g2.fillStyle = grad;
        g2.fillRect(0, 0, cssW, cssH);
      }

      // A-能量段条：rms 显示值 + 双阈值滞回（进 BAR_ENTER / 出 BAR_EXIT），只表示轨道能量
      if (gain > 0) {
        const i0 = clamp(Math.floor(t0 * fr), 0, n - 1);
        const i1 = clamp(Math.floor(t1 * fr), 0, n - 1);
        const bars: Bar[] = [];
        let on = false;
        let bT0 = 0;
        let bSum = 0;
        let bCnt = 0;
        for (let i = i0; i <= i1; i++) {
          const v = clamp((f.arrays.rms[i] * gain) / d.rmsRef, 0, 1);
          if (!on) {
            if (v >= BAR_ENTER) {
              on = true;
              bT0 = i / fr;
              bSum = v;
              bCnt = 1;
            }
          } else if (v <= BAR_EXIT) {
            bars.push({ t0: bT0, t1: i / fr, avg: bSum / bCnt });
            on = false;
          } else {
            bSum += v;
            bCnt += 1;
          }
        }
        if (on) bars.push({ t0: bT0, t1: (i1 + 1) / fr, avg: bSum / bCnt });
        for (const b of bars) {
          // C-中频呼吸：段条厚度/亮度随 envMid 变化
          const th = 0.75 + 0.4 * st.envMid;
          const h = cssH * (0.14 + 0.44 * b.avg) * th;
          const a = (0.07 + 0.16 * b.avg) * (0.6 + 0.4 * st.envMid) * fxk;
          g2.fillStyle = rgba(c, a);
          g2.fillRect(xOf(b.t0), midY - h / 2, Math.max(1.5, xOf(b.t1) - xOf(b.t0)), h);
        }
      }

      // A-光带穿梭：播放线附近流动高亮带，已播侧柔亮、未来侧更暗
      if (phX > -cssW && phX < cssW * 2) {
        const bandW = Math.min(cssW * 0.24, 190);
        const gradP = g2.createLinearGradient(phX - bandW, 0, phX, 0);
        gradP.addColorStop(0, rgba(c, 0));
        gradP.addColorStop(1, rgba(c, 0.17 * E * fxk));
        g2.fillStyle = gradP;
        g2.fillRect(phX - bandW, 0, bandW, cssH);
        const fw = bandW * 0.65;
        const gradF = g2.createLinearGradient(phX, 0, phX + fw, 0);
        gradF.addColorStop(0, rgba(c, 0.06 * E * fxk));
        gradF.addColorStop(1, rgba(c, 0));
        g2.fillStyle = gradF;
        g2.fillRect(phX, 0, fw, cssH);
        // 流光细纹向播放线涌动（仅播放中且空间动效开启）
        if (advancing && spatial) {
          for (let j = 0; j < 3; j++) {
            const sx = phX - ((now * 80 + (j * bandW) / 3) % bandW);
            const fade = 1 - (phX - sx) / bandW;
            g2.fillStyle = rgba(c, 0.07 * E * fxk * fade);
            g2.fillRect(sx, cssH * 0.12, 2, cssH * 0.76);
          }
        }
      }

      // B-接触波纹环：锚定触发时刻的内容时间，随视图滚动
      for (const r of st.ripples) {
        const age = now - r.bornAt;
        const k = age / RIPPLE_LIFE;
        const rad = (4 + 40 * k) * (0.5 + 0.5 * r.strength);
        const a = Math.pow(1 - k, 1.5) * 0.55 * r.strength * fxk;
        g2.strokeStyle = rgba(c, a);
        g2.lineWidth = 0.6 + 1.8 * (1 - k);
        g2.beginPath();
        g2.arc(xOf(r.t), midY, rad, 0, Math.PI * 2);
        g2.stroke();
      }

      // B-粒子：沿轨道水平扩散，寿命 220–340ms，全局硬上限桌面 120 / 移动 40
      for (const p of st.particles) {
        const age = now - p.bornAt;
        const k = age / p.life;
        const a = (1 - k) * 0.75 * fxk;
        g2.fillStyle = rgba(c, a);
        const px = xOf(p.t + p.vSec * age);
        const py = midY + (p.y0 + p.vY * age) * cssH;
        g2.fillRect(px - p.size / 2, py - p.size / 2, p.size, p.size);
      }

      // C-高频 sparkle：细碎亮点数量随 envHigh（空间动效关闭时不画）
      if (spatial && st.envHigh > 0.02) {
        const cnt = Math.floor(st.envHigh * 9 * fxk);
        const tick = Math.floor(now * 7);
        for (let k = 0; k < cnt; k++) {
          const seed = tick * 31.7 + k * 13.1 + idx * 0.013;
          const hx = hash01(seed);
          const hy = hash01(seed + 3);
          const a = (0.15 + 0.45 * hash01(seed + 7)) * st.envHigh * fxk;
          g2.fillStyle = dark ? `rgba(255,255,255,${a.toFixed(3)})` : rgba(c, a);
          g2.fillRect(phX + (hx - 0.5) * cssW * 0.6, cssH * (0.12 + hy * 0.76), 1.6, 1.6);
        }
      }

      // E-冲击边缘增亮：衰减期内沿行边缘描一圈亮边（装饰层内部，不影响布局）
      if (inImpact) {
        const k = 1 - iAge / IMPACT_DECAY;
        g2.strokeStyle = rgba(c, 0.3 * k * st.impactStrength * fxk);
        g2.lineWidth = 1.5;
        g2.strokeRect(1.5, 1.5, cssW - 3, cssH - 3);
      }

      g2.globalCompositeOperation = "source-over";
    };
    registerDraw(`fx:${track.id}`, draw);
    return () => registerDraw(`fx:${track.id}`, null);
  }, [track, duration, registerDraw, fx, getEngine]);

  return (
    <canvas
      ref={canvasRef}
      data-fx={track.id}
      aria-hidden
      className="pointer-events-none absolute inset-0 block size-full"
    />
  );
}
