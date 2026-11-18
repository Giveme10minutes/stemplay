import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import type { TrackInfo } from "@/lib/resources";

interface TrackRowProps {
  track: TrackInfo;
  vol: number;
  muted: boolean;
  solo: boolean;
  silenced: boolean;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onVol: (id: string, v: number) => void;
}

export function TrackRow({ track, vol, muted, solo, silenced, onToggleMute, onToggleSolo, onVol }: TrackRowProps) {
  const [volOpen, setVolOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!volOpen) return;
    const close = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setVolOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [volOpen]);

  return (
    <div
      className="relative flex flex-col justify-center gap-1 border-b border-border px-1.5 md:px-3"
      style={{ height: "var(--row-h)", opacity: silenced ? 0.55 : 1 }}
      data-row={track.id}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full md:size-2.5"
          style={{ background: `var(--track-${track.id}, ${track.color})` }}
        />
        <span className="truncate text-xs font-medium md:text-sm">{track.label}</span>
        {track.delayStatus === "uncertain" && (
          <>
            <Badge
              variant="outline"
              className="hidden shrink-0 border-amber-400/40 px-1 py-0 text-[10px] font-normal text-amber-300 md:inline-flex"
              title="编码延迟未能可靠测量，暂不补偿"
            >
              延迟待核验
            </Badge>
            <span className="shrink-0 text-[10px] text-amber-300 md:hidden" title="延迟待核验">
              ⚠
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-1 max-md:-mx-1.5 max-md:gap-0">
        <Toggle
          size="sm"
          pressed={muted}
          onPressedChange={() => onToggleMute(track.id)}
          aria-label={`${track.label} 静音`}
          title="静音"
          className="h-7 min-w-7 rounded-md border border-border text-[11px] data-[state=on]:border-red-400/60 data-[state=on]:bg-red-500/25 data-[state=on]:text-red-300 max-md:h-11 max-md:w-11 max-md:min-w-11 max-md:text-sm"
        >
          M
        </Toggle>
        <Toggle
          size="sm"
          pressed={solo}
          onPressedChange={() => onToggleSolo(track.id)}
          aria-label={`${track.label} 独奏`}
          title="独奏"
          className="h-7 min-w-7 rounded-md border border-border text-[11px] data-[state=on]:border-amber-400/60 data-[state=on]:bg-amber-400/25 data-[state=on]:text-amber-300 max-md:h-11 max-md:w-11 max-md:min-w-11 max-md:text-sm"
        >
          S
        </Toggle>
        <Slider
          className="ml-1 hidden min-w-0 flex-1 md:flex"
          value={[Math.round(vol * 100)]}
          max={100}
          step={1}
          onValueChange={(v) => onVol(track.id, v[0] / 100)}
          aria-label={`${track.label} 音量`}
        />
      </div>

      <div ref={popRef} className="md:hidden">
        <button
          type="button"
          aria-label={`${track.label} 音量`}
          aria-expanded={volOpen}
          onClick={() => setVolOpen((o) => !o)}
          className="absolute top-1/2 left-full z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-lg border border-border bg-popover text-muted-foreground"
        >
          <SlidersHorizontal className="size-4" />
        </button>
        {volOpen && (
          <div className="panel-solid absolute top-[calc(50%+24px)] left-full z-30 w-48 rounded-xl p-3">
            <div className="mb-2 flex justify-between text-xs text-muted-foreground">
              <span>{track.label} 音量</span>
              <span>{Math.round(vol * 100)}%</span>
            </div>
            <Slider
              value={[Math.round(vol * 100)]}
              max={100}
              step={1}
              onValueChange={(v) => onVol(track.id, v[0] / 100)}
              aria-label={`${track.label} 音量`}
            />
          </div>
        )}
      </div>
    </div>
  );
}