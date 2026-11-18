import { useState } from "react";
import { Music2 } from "lucide-react";
import { ImportPanel } from "@/components/ImportPanel";
import { MotionPanel } from "@/components/MotionPanel";
import { Button } from "@/components/ui/button";
import type { ArtworkInfo } from "@/lib/resources";
import { useAppearance } from "@/lib/theme";

interface TopBarProps {
  title: string;
  artist?: string | null;
  album?: string | null;
  artwork?: ArtworkInfo | null;
  onOpenAppearance: () => void;
}

export function TopBar({ title, artist, album, artwork, onOpenAppearance }: TopBarProps) {
  const coverUrl = useAppearance().cover.url;
  // 用户提取的封面优先；资源包 artwork 作为缩略图兜底（加载失败如实回退占位图）
  const [artworkFailed, setArtworkFailed] = useState<string | null>(null);
  const artworkUrl =
    artwork?.status === "ready" && artwork.url && artworkFailed !== artwork.url ? artwork.url : null;
  const thumb = coverUrl ?? artworkUrl;
  const subtitle =
    artist || album ? [artist, album].filter(Boolean).join(" · ") : "六轨拆解舞台 · 预览";
  return (
    <header className="mx-auto flex w-full max-w-[1440px] items-center gap-3 px-3 pt-4 pb-2 md:px-6">
      {thumb ? (
        <img
          src={thumb}
          alt="专辑封面"
          onError={() => setArtworkFailed(thumb)}
          className="size-11 shrink-0 rounded-lg border border-border object-cover md:size-12"
          data-testid="cover-thumb"
        />
      ) : (
        <div
          className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border md:size-12"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--sp-accent) 45%, transparent), color-mix(in srgb, var(--sp-grad-3) 60%, transparent))",
          }}
        >
          <Music2 className="size-5 text-foreground/80" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold md:text-lg">{title}</h1>
        <p className="truncate text-xs text-muted-foreground" data-testid="track-subtitle">
          {subtitle}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpenAppearance}
          data-testid="open-appearance"
          className="max-md:h-11 max-md:px-2 max-md:text-xs"
        >
          外观
        </Button>
        <MotionPanel />
        <ImportPanel />
      </div>
    </header>
  );
}
