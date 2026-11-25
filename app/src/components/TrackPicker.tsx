import { useEffect, useRef, useState } from "react";
import { Check, ListMusic } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Catalog, CatalogTrack } from "@/lib/resources";

interface TrackPickerProps {
  catalog: Catalog;
  trackId: string | null;
  switching: boolean;
  onSelect: (track: CatalogTrack) => void;
}

// 切歌菜单（同 MotionPanel 的浮层写法）：读静态曲库 catalog；资源不完整的目录如实禁用并说明缺什么。
export function TrackPicker({ catalog, trackId, switching, onSelect }: TrackPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = catalog.tracks.find((t) => t.id === trackId);

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <Button
        variant="outline"
        size="sm"
        data-testid="open-tracks"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={switching}
        onClick={() => setOpen((o) => !o)}
        className="max-md:h-11 max-md:px-2 max-md:text-xs"
      >
        <ListMusic className="size-4" />
        <span className="max-w-24 truncate md:max-w-40" data-testid="current-track">
          {current?.title ?? "曲目"}
        </span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="选择曲目"
          data-testid="track-panel"
          className="panel-solid animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 absolute top-[calc(100%+8px)] right-0 z-50 w-64 rounded-xl p-2 duration-250 max-md:fixed max-md:inset-x-3 max-md:top-[68px] max-md:w-auto"
        >
          <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
            曲目（{catalog.tracks.length}）
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {catalog.tracks.map((t) => {
              const ready = t.status === "ready";
              const active = t.id === trackId;
              return (
                <li key={t.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!ready || switching}
                    aria-current={active}
                    data-testid={`track-${t.id}`}
                    title={ready ? undefined : `资源不完整：${t.missing.join("，")}`}
                    onClick={() => {
                      setOpen(false);
                      onSelect(t);
                    }}
                    className="h-11 w-full justify-start gap-2 px-2 text-left md:h-9"
                  >
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    {!ready && <span className="shrink-0 text-[11px] text-red-400">资源不完整</span>}
                    {active && <Check className="size-4 shrink-0" />}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
