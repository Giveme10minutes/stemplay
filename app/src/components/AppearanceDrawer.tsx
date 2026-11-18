import { useRef, useSyncExternalStore } from "react";
import {
  AudioLines,
  Check,
  ImagePlus,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  setBg,
  setBgGradient,
  setBgImage,
  setCustomAccent,
  setCustomImage,
  setFollowCover,
  setMaterial,
  setMode,
  setTheme,
  removeCustomImage,
  resetAll,
  clearCover,
  importCoverFromFile,
  applyCoverBackground,
  THEME_PRESETS,
  useAppearance,
  type ImagePosition,
  type ModePref,
} from "@/lib/theme";

interface AppearanceDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MODES: { id: ModePref; name: string; icon: typeof Moon }[] = [
  { id: "dark", name: "深色", icon: Moon },
  { id: "light", name: "浅色", icon: Sun },
  { id: "system", name: "跟随系统", icon: Monitor },
];

const POSITIONS: { id: ImagePosition; name: string }[] = [
  { id: "center", name: "居中" },
  { id: "top", name: "顶部" },
  { id: "bottom", name: "底部" },
  { id: "left", name: "左侧" },
  { id: "right", name: "右侧" },
];

function subscribeMobile(fn: () => void) {
  const mq = window.matchMedia("(max-width: 767px)");
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}
const getMobile = () => window.matchMedia("(max-width: 767px)").matches;

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-2 text-sm font-semibold text-foreground">{children}</h3>;
}

function SliderRow({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  suffix = "%",
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3" data-testid={testId}>
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <Slider
        className="flex-1"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {value}
        {suffix}
      </span>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  testId?: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <input
        type="color"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="size-11 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-1 md:size-8"
        aria-label={label}
      />
      <span className="font-mono uppercase">{value}</span>
    </label>
  );
}

export function AppearanceDrawer({ open, onOpenChange }: AppearanceDrawerProps) {
  const s = useAppearance();
  const isMobile = useSyncExternalStore(subscribeMobile, getMobile, () => false);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const { prefs } = s;
  const bg = prefs.bg;
  const locked = bg.type !== "theme";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={isMobile ? "bottom" : "right"} data-testid="appearance-drawer">
        <SheetHeader>
          <SheetTitle>外观</SheetTitle>
          <SheetDescription>色调、背景与材质三组独立控制，偏好自动保存在本机</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
          {/* A. UI 色调 */}
          <section>
            <SectionTitle>UI 色调</SectionTitle>
            <div className="mb-3 flex gap-1.5" role="group" aria-label="深浅模式">
              {MODES.map((m) => (
                <Button
                  key={m.id}
                  variant={prefs.mode === m.id ? "default" : "outline"}
                  size="sm"
                  aria-pressed={prefs.mode === m.id}
                  onClick={() => setMode(m.id)}
                  className="h-11 flex-1 gap-1 text-xs md:h-9"
                  data-testid={`mode-${m.id}`}
                >
                  <m.icon className="size-3.5" />
                  {m.name}
                </Button>
              ))}
            </div>
            <div className="mb-3 grid grid-cols-2 gap-2" role="group" aria-label="主题预设">
              {THEME_PRESETS.map((p) => {
                const active = prefs.theme === p.id && !prefs.followCover;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setTheme(p.id)}
                    aria-pressed={prefs.theme === p.id}
                    data-testid={`theme-${p.id}`}
                    className={`flex min-h-14 items-center gap-2 rounded-xl border p-2 text-left transition-colors md:min-h-12 ${
                      prefs.theme === p.id ? "border-ring bg-muted" : "border-border hover:bg-muted/60"
                    }`}
                  >
                    <span
                      className="relative size-9 shrink-0 rounded-lg border border-border"
                      style={{
                        background: `linear-gradient(135deg, ${p.grad[s.mode][0]}, ${p.grad[s.mode][2]})`,
                      }}
                    >
                      <span
                        className="absolute right-1 bottom-1 size-2.5 rounded-full"
                        style={{ background: p.accent }}
                      />
                    </span>
                    <span className="min-w-0 text-xs font-medium">{p.name}</span>
                    {active && <Check className="ml-auto size-3.5 shrink-0 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <ColorField
                label="自定义强调色"
                value={prefs.customAccent ?? s.accent}
                onChange={(hex) => setCustomAccent(hex)}
                testId="accent-input"
              />
              {prefs.customAccent && (
                <Button variant="ghost" size="sm" className="h-11 text-xs md:h-8" onClick={() => setCustomAccent(null)}>
                  清除自定义
                </Button>
              )}
            </div>
            <div className="mt-2 flex min-h-11 items-center justify-between gap-3">
              <div className="text-xs">
                <div className="font-medium text-foreground">跟随专辑封面</div>
                <div className="text-muted-foreground">手选主题/强调色后自动暂停</div>
              </div>
              <Switch
                checked={prefs.followCover}
                onCheckedChange={setFollowCover}
                aria-label="跟随专辑封面"
                data-testid="follow-cover"
                className="h-7 w-12 data-[state=checked]:bg-primary max-md:h-11 max-md:w-16"
              />
            </div>
          </section>

          {/* D. 封面取色（仅主题素材，不是导入歌曲） */}
          <section className="rounded-xl border border-border p-3">
            <SectionTitle>封面取色</SectionTitle>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              从本地音频读取内嵌封面并提取配色。
              <span className="font-medium text-foreground">仅提取主题素材，不会把歌曲加入曲库</span>
              （导入功能第 5 轮开放）。
            </p>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/*,.flac,.mp3,.m4a,.wav,.ogg"
              className="hidden"
              data-testid="cover-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importCoverFromFile(f);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              className="h-11 w-full gap-1.5 text-xs md:h-9"
              onClick={() => audioInputRef.current?.click()}
              disabled={s.cover.status === "reading"}
              data-testid="cover-import-btn"
            >
              <AudioLines className="size-4" />
              {s.cover.status === "reading" ? "正在读取…" : "从本地音频提取封面"}
            </Button>
            {s.cover.message && (
              <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="cover-status">
                {s.cover.message}
              </p>
            )}
            {s.cover.url && (
              <div className="mt-2 flex items-center gap-2">
                <img src={s.cover.url} alt="提取的专辑封面" className="size-14 rounded-lg border border-border object-cover" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Button variant="secondary" size="sm" className="h-11 text-xs md:h-8" onClick={applyCoverBackground}>
                    用作背景
                  </Button>
                  <Button variant="ghost" size="sm" className="h-11 text-xs md:h-8" onClick={clearCover}>
                    清除封面
                  </Button>
                </div>
                {s.palette && (
                  <div className="flex flex-col gap-1" aria-label="提取的配色">
                    {[s.palette.accent, s.palette.dominant, ...s.palette.candidates.slice(0, 2)].map((c, i) => (
                      <span key={i} className="size-4 rounded-full border border-border" style={{ background: c }} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* B. 背景 */}
          <section>
            <SectionTitle>背景</SectionTitle>
            <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="背景类型">
              {(
                [
                  ["theme", "跟随默认"],
                  ["solid", "纯色"],
                  ["gradient", "渐变"],
                  ["cover", "专辑封面"],
                  ["image", "自定义图片"],
                ] as const
              ).map(([id, name]) => (
                <Button
                  key={id}
                  variant={bg.type === id ? "default" : "outline"}
                  size="sm"
                  aria-pressed={bg.type === id}
                  data-testid={`bg-type-${id}`}
                  onClick={() => (id === "cover" ? applyCoverBackground() : setBg({ type: id }))}
                  className="h-11 px-2.5 text-xs md:h-8"
                >
                  {name}
                </Button>
              ))}
            </div>
            <p className="mb-2 text-[11px] text-muted-foreground" data-testid="bg-lock-hint">
              {locked ? "已锁定：切歌不会覆盖此背景" : "跟随默认：随主题/封面自动变化"}
            </p>

            {bg.type === "solid" && (
              <ColorField label="背景纯色" value={bg.solid} onChange={(c) => setBg({ solid: c })} testId="solid-input" />
            )}

            {bg.type === "gradient" && (
              <div className="space-y-1.5">
                {bg.gradient.colors.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <ColorField
                      label={`渐变色 ${i + 1}`}
                      value={c}
                      onChange={(hex) => {
                        const colors = [...bg.gradient.colors];
                        colors[i] = hex;
                        setBgGradient({ colors });
                      }}
                      testId={`grad-stop-${i}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`删除渐变色 ${i + 1}`}
                      disabled={bg.gradient.colors.length <= 2}
                      onClick={() => setBgGradient({ colors: bg.gradient.colors.filter((_, j) => j !== i) })}
                      className="ml-auto size-11 md:size-8"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
                {bg.gradient.colors.length < 4 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 gap-1 text-xs md:h-8"
                    data-testid="grad-add"
                    onClick={() =>
                      setBgGradient({ colors: [...bg.gradient.colors, bg.gradient.colors[bg.gradient.colors.length - 1]] })
                    }
                  >
                    <Plus className="size-3.5" />
                    添加颜色（{bg.gradient.colors.length}/4）
                  </Button>
                )}
                <SliderRow
                  label="角度"
                  value={bg.gradient.angle}
                  max={360}
                  step={5}
                  suffix="°"
                  onChange={(v) => setBgGradient({ angle: v })}
                  testId="grad-angle"
                />
              </div>
            )}

            {bg.type === "cover" && !s.cover.url && (
              <p className="text-xs text-muted-foreground">尚未提取到封面，暂回退主题渐变；请先在上方“封面取色”提取。</p>
            )}

            {(bg.type === "image" || bg.type === "cover") && (
              <div className="space-y-1.5">
                {bg.type === "image" && (
                  <>
                    <input
                      ref={imageInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      data-testid="image-file"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void setCustomImage(f);
                        e.target.value = "";
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        className="h-11 flex-1 gap-1.5 text-xs md:h-9"
                        onClick={() => imageInputRef.current?.click()}
                        data-testid="image-upload-btn"
                      >
                        <ImagePlus className="size-4" />
                        {s.customImage.url ? "更换图片" : "选择图片"}
                      </Button>
                      {s.customImage.url && (
                        <Button
                          variant="ghost"
                          className="h-11 gap-1 text-xs md:h-9"
                          onClick={removeCustomImage}
                          data-testid="image-remove"
                        >
                          <Trash2 className="size-3.5" />
                          移除
                        </Button>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground" data-testid="image-persist-hint">
                      {s.customImage.url
                        ? s.customImage.persisted
                          ? "图片已保存在本机（IndexedDB），刷新后仍在"
                          : "自定义图片仅本次会话有效"
                        : "图片仅保存在本机 IndexedDB，不会上传或打包"}
                    </p>
                  </>
                )}
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="图片位置">
                  {POSITIONS.map((p) => (
                    <Button
                      key={p.id}
                      variant={bg.image.position === p.id ? "default" : "outline"}
                      size="sm"
                      aria-pressed={bg.image.position === p.id}
                      data-testid={`img-pos-${p.id}`}
                      onClick={() => setBgImage({ position: p.id })}
                      className="h-11 px-2.5 text-xs md:h-8"
                    >
                      {p.name}
                    </Button>
                  ))}
                </div>
                <div className="flex gap-1.5" role="group" aria-label="图片缩放方式">
                  {(
                    [
                      ["cover", "铺满裁剪"],
                      ["contain", "完整包含"],
                    ] as const
                  ).map(([id, name]) => (
                    <Button
                      key={id}
                      variant={bg.image.fit === id ? "default" : "outline"}
                      size="sm"
                      aria-pressed={bg.image.fit === id}
                      data-testid={`img-fit-${id}`}
                      onClick={() => setBgImage({ fit: id })}
                      className="h-11 flex-1 text-xs md:h-8"
                    >
                      {name}
                    </Button>
                  ))}
                </div>
                <SliderRow label="缩放" value={bg.image.zoom} min={100} max={250} step={5} onChange={(v) => setBgImage({ zoom: v })} testId="img-zoom" />
                <SliderRow label="暗化/提亮" value={bg.image.dim} min={-50} max={80} onChange={(v) => setBgImage({ dim: v })} testId="img-dim" />
                <SliderRow label="模糊" value={bg.image.blur} max={40} suffix="px" onChange={(v) => setBgImage({ blur: v })} testId="img-blur" />
              </div>
            )}
          </section>

          {/* C. 材质与运动 */}
          <section>
            <SectionTitle>材质与运动</SectionTitle>
            <SliderRow label="玻璃透明度" value={prefs.material.glass} onChange={(v) => setMaterial({ glass: v })} testId="mat-glass" />
            <SliderRow label="背景明暗" value={prefs.material.brightness} onChange={(v) => setMaterial({ brightness: v })} testId="mat-brightness" />
            <SliderRow label="特效强度" value={prefs.material.fx} onChange={(v) => setMaterial({ fx: v })} testId="mat-fx" />
            <Button
              variant="outline"
              className="mt-2 h-11 w-full gap-1.5 text-xs md:h-9"
              onClick={resetAll}
              data-testid="reset-all"
            >
              <RotateCcw className="size-3.5" />
              恢复默认
            </Button>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}