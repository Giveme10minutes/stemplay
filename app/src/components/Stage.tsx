import { useEffect, useRef } from "react";
import { LocateFixed } from "lucide-react";
import type { StemEngine } from "@/audio/engine";
import { Button } from "@/components/ui/button";
import { FxOverlay } from "@/components/FxOverlay";
import { TimeRuler } from "@/components/TimeRuler";
import { TrackRow } from "@/components/TrackRow";
import { Waveform } from "@/components/Waveform";
import type { FxStore } from "@/lib/fx";
import type { Beats, TrackInfo } from "@/lib/resources";
import { fmt, type DrawFn, type ViewMode, type ViewRange } from "@/lib/view";

export interface MixState {
  vol: Record<string, number>;
  muted: Record<string, boolean>;
  solo: Record<string, boolean>;
}

interface StageProps {
  tracks: TrackInfo[];
  beats: Beats | null;
  duration: number;
  originSec: number;
  fullDurationSec: number;
  mix: MixState;
  viewMode: ViewMode;
  followPaused: boolean;
  playheadRef: React.RefObject<HTMLDivElement | null>;
  fx: FxStore;
  getEngine: () => StemEngine | null;
  registerDraw: (id: string, fn: DrawFn | null) => void;
  registerRuler: (fn: DrawFn | null) => void;
  xToTime: (frac: number) => number;
  getView: () => ViewRange;
  onScrubStart: () => void;
  onScrubMove: (t: number) => void;
  onScrubEnd: (t?: number) => void;
  onPan: (dt: number) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onVol: (id: string, v: number) => void;
  onSetMode: (m: ViewMode) => void;
  onResumeFollow: () => void;
}

export function Stage(props: StageProps) {
  const {
    tracks,
    beats,
    duration,
    originSec,
    fullDurationSec,
    mix,
    viewMode,
    followPaused,
    playheadRef,
    fx,
    getEngine,
    registerDraw,
    registerRuler,
    xToTime,
    getView,
    onScrubStart,
    onScrubMove,
    onScrubEnd,
    onPan,
    onToggleMute,
    onToggleSolo,
    onVol,
    onSetMode,
    onResumeFollow,
  } = props;

  const waveAreaRef = useRef<HTMLDivElement>(null);
  const onPanRef = useRef(onPan);
  const getViewRef = useRef(getView);
  const modeRef = useRef(viewMode);
  useEffect(() => {
    onPanRef.current = onPan;
    getViewRef.current = getView;
    modeRef.current = viewMode;
  });

  useEffect(() => {
    const el = waveAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (modeRef.current !== "follow") return;
      e.preventDefault();
      const { t0, t1 } = getViewRef.current();
      const width = el.clientWidth || 1;
      onPanRef.current(((e.deltaY + e.deltaX) * (t1 - t0)) / width);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const soloActive = tracks.some((t) => mix.solo[t.id]);

  return (
    <section className="glass-panel rounded-2xl">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 md:px-4">
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground md:text-sm">
          <span className="truncate">
            {Math.round(duration)}s 预览 · 原曲 {fmt(fullDurationSec)} · 起点 {fmt(originSec)}
          </span>
          {beats && (
            <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] md:inline">
              BPM {beats.bpm.toFixed(1)}
              {beats.snapEnabled ? "" : " · 拍点降级"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {viewMode === "follow" && followPaused && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onResumeFollow}
              className="h-9 gap-1 text-xs max-md:h-11"
            >
              <LocateFixed className="size-3.5" />
              回到播放位置
            </Button>
          )}
          <div className="flex overflow-hidden rounded-lg border border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSetMode("follow")}
              aria-pressed={viewMode === "follow"}
              className={`h-9 rounded-none px-3 text-xs max-md:h-11 ${viewMode === "follow" ? "bg-foreground/15 text-foreground" : "text-muted-foreground"}`}
            >
              跟随
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSetMode("overview")}
              aria-pressed={viewMode === "overview"}
              className={`h-9 rounded-none px-3 text-xs max-md:h-11 ${viewMode === "overview" ? "bg-foreground/15 text-foreground" : "text-muted-foreground"}`}
            >
              全览
            </Button>
          </div>
        </div>
      </div>

      <div className="flex">
        <div className="shrink-0" style={{ width: "var(--identity-w)" }}>
          <div style={{ height: "var(--ruler-h)" }} />
          {tracks.map((t) => (
            <TrackRow
              key={t.id}
              track={t}
              vol={mix.vol[t.id] ?? 1}
              muted={!!mix.muted[t.id]}
              solo={!!mix.solo[t.id]}
              silenced={!!mix.muted[t.id] || (soloActive && !mix.solo[t.id])}
              onToggleMute={onToggleMute}
              onToggleSolo={onToggleSolo}
              onVol={onVol}
            />
          ))}
        </div>
        <div ref={waveAreaRef} className="relative min-w-0 flex-1">
          <TimeRuler originSec={originSec} registerDraw={registerRuler} getView={getView} onPan={onPan} />
          {tracks.map((t) => (
            <div key={t.id} className="relative">
              <Waveform
                track={t}
                duration={duration}
                registerDraw={registerDraw}
                xToTime={xToTime}
                onScrubStart={onScrubStart}
                onScrubMove={onScrubMove}
                onScrubEnd={onScrubEnd}
              />
              <FxOverlay track={t} duration={duration} registerDraw={registerDraw} fx={fx} getEngine={getEngine} />
            </div>
          ))}
          <div ref={playheadRef} className="playhead-line" style={{ left: "0%" }} />
        </div>
      </div>
    </section>
  );
}