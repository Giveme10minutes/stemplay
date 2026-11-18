import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MOTION_TIERS, setMaster, setTier, useMotion } from "@/lib/motion";

// 动效设置浮层：master 总开关 + 四档强度。离散点击 → motionStore → fxStore.motionTarget，
// 强度乘子由单一 rAF 循环平滑逼近（~120ms），档位连续切换从当前值续接、不跳帧。

export function MotionPanel() {
  const [open, setOpen] = useState(false);
  const prefs = useMotion();
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

  return (
    <div ref={wrapRef} className="relative">
      <Button
        variant="outline"
        size="sm"
        data-testid="open-motion"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        className="max-md:h-11 max-md:px-2 max-md:text-xs"
      >
        动效
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="动效设置"
          data-testid="motion-panel"
          className="panel-solid animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 absolute top-[calc(100%+8px)] right-0 z-50 w-72 rounded-xl p-3 duration-250"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">动效</div>
            <Switch
              checked={prefs.master}
              onCheckedChange={setMaster}
              aria-label="动效总开关"
              data-testid="motion-master"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {prefs.master ? "选择强度档位；强效果不会每拍闪烁" : "已关闭冲击/粒子/抖动/背景推动，仅保留播放线基础明暗"}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {MOTION_TIERS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={prefs.tier === t.id ? "default" : "outline"}
                data-tier={t.id}
                aria-pressed={prefs.tier === t.id}
                onClick={() => setTier(t.id)}
                title={t.desc}
                className="h-9 text-xs"
              >
                {t.name}
              </Button>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            高能冲击来自局部能量检测（能量高分位 + 明显上升 + 强起音），不代表副歌或乐器识别。
          </p>
        </div>
      )}
    </div>
  );
}
