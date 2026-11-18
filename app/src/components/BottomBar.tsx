import { useRef } from "react";
import { Pause, Play, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { Preset } from "@/lib/resources";
import { clamp, fmt } from "@/lib/view";

interface BottomBarProps {
  playing: boolean;
  duration: number;
  originSec: number;
  presets: Preset[];
  activePresetId: string | null;
  masterVol: number;
  timeCurRef: React.RefObject<HTMLSpanElement | null>;
  localTimeRef: React.RefObject<HTMLSpanElement | null>;
  progressFillRef: React.RefObject<HTMLDivElement | null>;
  progressRef: React.RefObject<HTMLDivElement | null>;
  onTogglePlay: () => void;
  onPreset: (p: Preset) => void;
  onMasterVol: (v: number) => void;
  onScrubStart: () => void;
  onScrubMove: (t: number) => void;
  onScrubEnd: (t?: number) => void;
}

export function BottomBar({
  playing,
  duration,
  originSec,
  presets,
  activePresetId,
  masterVol,
  timeCurRef,
  localTimeRef,
  progressFillRef,
  progressRef,
  onTogglePlay,
  onPreset,
  onMasterVol,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: BottomBarProps) {
  const scrubbingRef = useRef(false);

  const fracFromEvent = (e: React.PointerEvent) => {
    const rect = progressRef.current!.getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };

  return (
    <div className="glass-panel fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border-b-0">
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 md:px-6">
        <Button
          onClick={onTogglePlay}
          aria-label={playing ? "暂停" : "播放"}
          className="size-12 shrink-0 rounded-full md:size-14"
        >
          {playing ? <Pause className="size-6" /> : <Play className="size-6 translate-x-0.5" />}
        </Button>

        <div className="shrink-0 leading-tight">
          <div className="font-mono text-sm tabular-nums md:text-base">
            <span ref={timeCurRef}>{fmt(originSec)}</span>
            <span className="text-muted-foreground"> / {fmt(originSec + duration)}</span>
          </div>
          <div className="text-[10px] text-muted-foreground">
            <span ref={localTimeRef}>片段 0:00.0</span> / {fmt(duration)}
          </div>
        </div>

        <div className="order-last flex w-full min-w-0 items-center gap-3 md:order-none md:w-auto md:flex-1">
          <div
            ref={progressRef}
            role="slider"
            tabIndex={0}
            aria-label="预览进度"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={0}
            className="group relative flex h-11 min-w-0 flex-1 cursor-pointer touch-none items-center"
            onPointerDown={(e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              e.preventDefault();
              try {
                progressRef.current!.setPointerCapture(e.pointerId);
              } catch {
                /* 旧浏览器 */
              }
              scrubbingRef.current = true;
              onScrubStart();
              onScrubMove(fracFromEvent(e) * duration);
            }}
            onPointerMove={(e) => {
              if (scrubbingRef.current) onScrubMove(fracFromEvent(e) * duration);
            }}
            onPointerUp={(e) => {
              if (!scrubbingRef.current) return;
              scrubbingRef.current = false;
              onScrubEnd(fracFromEvent(e) * duration);
            }}
            onPointerCancel={() => {
              if (!scrubbingRef.current) return;
              scrubbingRef.current = false;
              onScrubEnd();
            }}
          >
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                ref={progressFillRef}
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/85"
                style={{ width: "0%" }}
              />
            </div>
          </div>
          <div className="flex w-28 shrink-0 items-center gap-2 md:w-32">
            <Volume2 className="size-4 shrink-0 text-muted-foreground" />
            <Slider
              value={[masterVol]}
              max={100}
              step={1}
              onValueChange={(v) => onMasterVol(v[0])}
              aria-label="主音量"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {presets.map((p) => (
            <Button
              key={p.id}
              variant={activePresetId === p.id ? "default" : "outline"}
              size="sm"
              onClick={() => onPreset(p)}
              aria-pressed={activePresetId === p.id}
              className="h-11 px-2.5 text-xs md:h-9 md:px-3"
            >
              {p.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}