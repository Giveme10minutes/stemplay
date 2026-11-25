import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { StemEngine } from "@/audio/engine";
import { AppearanceDrawer } from "@/components/AppearanceDrawer";
import { BackgroundLayer } from "@/components/BackgroundLayer";
import { BottomBar } from "@/components/BottomBar";
import { Stage, type MixState } from "@/components/Stage";
import { ThemeToast } from "@/components/ThemeToast";
import { TopBar } from "@/components/TopBar";
import { Button } from "@/components/ui/button";
import { fxStore, type FxStore } from "@/lib/fx";
import { buildImpacts, stepImpacts, type ImpactModel } from "@/lib/impacts";
import { libraryStore, setPackLoader } from "@/lib/library";
import { motionStore, tierDef } from "@/lib/motion";
import {
  loadCatalog,
  loadResources,
  ResourceError,
  type Catalog,
  type CatalogTrack,
  type LoadedResources,
  type LoadSpec,
  type Preset,
} from "@/lib/resources";
import { themeStore } from "@/lib/theme";
import { clamp, computeView, fmt, type DrawFn, type ViewMode, type ViewRange, type ViewState } from "@/lib/view";

declare global {
  interface Window {
    __stemplay?: {
      engine: StemEngine;
      resources: LoadedResources;
      view: { current: ViewState };
      theme: typeof themeStore;
      fx: FxStore;
      motion: typeof motionStore;
      library: typeof libraryStore;
    };
  }
}

type LoadState =
  | { status: "loading"; decoded: number; total: number }
  | { status: "ready" }
  | { status: "error"; message: string };

const EMPTY_MIX: MixState = { vol: {}, muted: {}, solo: {} };

const TRACK_KEY = "stemplay.track.v1";
const EMPTY_CATALOG_MESSAGE =
  "曲库为空：请把 pipeline 发布包放入 app/public/resources/tracks/<曲目>/ 后刷新";

export default function App() {
  const [load, setLoad] = useState<LoadState>({ status: "loading", decoded: 0, total: 6 });
  const [data, setData] = useState<LoadedResources | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mix, setMix] = useState<MixState>(EMPTY_MIX);
  const [viewMode, setViewMode] = useState<ViewMode>("follow");
  const [followPaused, setFollowPaused] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [masterVol, setMasterVol] = useState(100);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const drawerOpenRef = useRef(false);
  useEffect(() => {
    drawerOpenRef.current = appearanceOpen;
  }, [appearanceOpen]);

  const engineRef = useRef<StemEngine | null>(null);
  const impactRef = useRef<ImpactModel | null>(null);
  const genRef = useRef(0);
  const loadedRef = useRef<LoadedResources | null>(null);
  const lastSpecRef = useRef<LoadSpec | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const viewRef = useRef<ViewState>({ mode: "follow", windowSec: 16, manual: false, manualStart: 0 });
  const lastViewRef = useRef<ViewRange>({ t0: 0, t1: 40 });
  const drawsRef = useRef(new Map<string, DrawFn>());
  const rulerDrawRef = useRef<DrawFn | null>(null);
  const scrubWasPlayingRef = useRef(false);
  const playheadRef = useRef<HTMLDivElement>(null);
  const timeCurRef = useRef<HTMLSpanElement>(null);
  const localTimeRef = useRef<HTMLSpanElement>(null);
  const progressFillRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const lastAriaSecRef = useRef(-1);
  const lastPlayingRef = useRef(false);

  // spec=null：按曲库启动（上次听过的歌，否则第一首可用的）；重试时沿用同一语义
  const doLoad = useCallback(async (spec: LoadSpec | null = null): Promise<boolean> => {
    const gen = ++genRef.current;
    const cancelled = () => genRef.current !== gen;
    lastSpecRef.current = spec;
    lastErrorRef.current = null;
    engineRef.current?.dispose();
    const engine = new StemEngine();
    engineRef.current = engine;
    loadedRef.current?.disposeUrls(); // 释放上一次加载（含 pack 对象 URL），防泄漏
    loadedRef.current = null;
    setData(null);
    setLoad({ status: "loading", decoded: 0, total: 6 });
    try {
      const ctx = engine.ensureContext();
      let target = spec;
      if (target === null) {
        const cat = await loadCatalog();
        if (cancelled()) {
          engine.dispose();
          return false;
        }
        setCatalog(cat);
        const ready = cat.tracks.filter((t) => t.status === "ready");
        let saved: string | null = null;
        try {
          saved = localStorage.getItem(TRACK_KEY);
        } catch {
          /* 隐私模式等：不记忆曲目 */
        }
        const chosen = ready.find((t) => t.id === saved) ?? ready[0];
        if (!chosen) throw new ResourceError(EMPTY_CATALOG_MESSAGE);
        target = { kind: "url", trackId: chosen.id, trackPath: chosen.path };
        lastSpecRef.current = target;
      }
      const res = await loadResources(
        ctx,
        (decoded, total) => {
          if (!cancelled()) setLoad({ status: "loading", decoded, total });
        },
        cancelled,
        target,
      );
      if (cancelled()) {
        engine.dispose();
        res.disposeUrls();
        return false;
      }
      setTrackId(target.kind === "url" ? target.trackId : null);
      if (target.kind === "url") {
        try {
          localStorage.setItem(TRACK_KEY, target.trackId);
        } catch {
          /* 存不进去只影响下次默认曲目 */
        }
      }
      engine.init(
        res.tracks.map((t) => ({ id: t.id, delaySec: t.delaySec })),
        res.buffers,
        res.durationSec,
      );
      viewRef.current = { mode: "follow", windowSec: 16, manual: false, manualStart: 0 };
      lastViewRef.current = { t0: 0, t1: res.durationSec };
      // 冲击候选一次性离线构建（分位数/平滑/上升比），运行时只按实际增益门控
      const model = buildImpacts(res.tracks);
      impactRef.current = model;
      fxStore.resetAll(); // 切歌/重载：清空特效状态
      fxStore.scene.p90 = model.sceneP90;
      fxStore.scene.p75 = model.sceneP75;
      loadedRef.current = res;
      setData(res);
      setLoad({ status: "ready" });
      setPlaying(false);
      setMix({ vol: { ...engine.vol }, muted: { ...engine.muted }, solo: { ...engine.solo } });
      setViewMode("follow");
      setFollowPaused(false);
      setActivePresetId(null);
      setMasterVol(100);
      if (import.meta.env.DEV) {
        window.__stemplay = {
          engine,
          resources: res,
          view: viewRef,
          theme: themeStore,
          fx: fxStore,
          motion: motionStore,
          library: libraryStore,
        };
      }
      // 资源包封面 → 第 2 轮取色流程（仅 followCover 开启且用户本会话未手动导入封面时）
      const prefs = themeStore.getState().prefs;
      if (
        res.artwork?.status === "ready" &&
        res.artwork.url &&
        prefs.followCover &&
        !themeStore.hasSessionCoverImport()
      ) {
        const url = res.artwork.url;
        void (async () => {
          try {
            const r = await fetch(url);
            if (!r.ok || cancelled()) return;
            const blob = await r.blob();
            if (cancelled()) return;
            await themeStore.applyArtworkFromBlob(blob);
          } catch {
            /* 封面不可得：静默回退，无视觉回归 */
          }
        })();
      }
      return true;
    } catch (err) {
      if (cancelled()) {
        engine.dispose();
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      lastErrorRef.current = message;
      setLoad({ status: "error", message });
      return false;
    }
  }, []);

  useEffect(() => {
    void doLoad();
    return () => {
      genRef.current += 1;
    };
  }, [doLoad]);

  // 曲库/导入面板共用的加载通道：失败如实抛错（面板显示错误 + 重试）
  useEffect(() => {
    setPackLoader(async (files, label) => {
      const ok = await doLoad({ kind: "pack", label, files });
      if (!ok) throw new Error(lastErrorRef.current ?? "加载资源包失败");
    });
    return () => setPackLoader(null);
  }, [doLoad]);

  const ready = load.status === "ready" && data !== null;

  // 特效强度 --sp-fx 与 reduced-motion/移动端上限：离散事件同步，不进 rAF
  useEffect(() => {
    fxStore.attachMedia();
    const sync = () => {
      fxStore.fx = themeStore.getState().prefs.material.fx / 100;
    };
    sync();
    return themeStore.subscribe(sync);
  }, []);

  // 动效预设（master + 档位）：离散事件同步到 fxStore 目标乘子，平滑在单一 rAF 内完成
  useEffect(() => {
    const sync = () => {
      const p = motionStore.getState();
      const def = tierDef(p.tier);
      fxStore.motionOn = p.master;
      fxStore.motionTier = p.tier;
      fxStore.impactsOn = p.master && def.impacts;
      fxStore.motionTarget = {
        particle: p.master ? def.particle : 0,
        shake: p.master ? def.shake : 0,
        glow: p.master ? def.glow : 1,
        push: p.master ? def.push : 0,
      };
    };
    sync();
    return motionStore.subscribe(sync);
  }, []);

  useEffect(() => {
    if (!ready || !data) return;
    let raf = 0;
    let lastTs = 0;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      // 真实帧间隔（后台返回钳制到 0.1s，位置跳变由叠加层 seek 检测另行清态）
      const dt = lastTs === 0 ? 0.016 : clamp((ts - lastTs) / 1000, 0, 0.1);
      lastTs = ts;
      const engine = engineRef.current;
      if (!engine) return;
      const pos = engine.position();
      if (engine.playing && pos >= engine.duration) {
        engine.pausePlayback();
        engine.pausedAt = engine.duration;
      }
      if (lastPlayingRef.current !== engine.playing) {
        lastPlayingRef.current = engine.playing;
        setPlaying(engine.playing);
      }
      const view = computeView(viewRef.current, pos, engine.duration);
      lastViewRef.current = view;
      // 第 4 轮：视觉增益/冲击/场景状态先于所有 draw 推进（同一循环，无新 rAF）
      const impactModel = impactRef.current;
      if (impactModel) stepImpacts(impactModel, engine, fxStore, pos, dt, ts / 1000);
      drawsRef.current.forEach((fn) => fn(pos, view.t0, view.t1, dt, ts / 1000));
      rulerDrawRef.current?.(pos, view.t0, view.t1, dt, ts / 1000);

      const ph = playheadRef.current;
      if (ph) {
        const frac = (pos - view.t0) / (view.t1 - view.t0);
        if (frac < -1e-6 || frac > 1 + 1e-6) {
          ph.style.opacity = "0";
        } else {
          ph.style.opacity = "1";
          ph.style.left = `${clamp(frac, 0, 1) * 100}%`;
        }
      }
      if (timeCurRef.current) timeCurRef.current.textContent = fmt(data.originSec + pos);
      if (localTimeRef.current) {
        const s = Math.max(0, pos);
        localTimeRef.current.textContent = `片段 ${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
      }
      if (progressFillRef.current) {
        progressFillRef.current.style.width = `${(pos / engine.duration) * 100}%`;
      }
      const sec = Math.floor(pos);
      if (progressRef.current && sec !== lastAriaSecRef.current) {
        lastAriaSecRef.current = sec;
        progressRef.current.setAttribute("aria-valuenow", String(sec));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ready, data]);

  const registerDraw = useCallback((id: string, fn: DrawFn | null) => {
    if (fn) drawsRef.current.set(id, fn);
    else drawsRef.current.delete(id);
  }, []);
  const registerRuler = useCallback((fn: DrawFn | null) => {
    rulerDrawRef.current = fn;
  }, []);
  const xToTime = useCallback((frac: number) => {
    const { t0, t1 } = lastViewRef.current;
    return t0 + frac * (t1 - t0);
  }, []);
  const getView = useCallback(() => lastViewRef.current, []);
  const getEngine = useCallback(() => engineRef.current, []);

  const syncMix = useCallback(() => {
    const e = engineRef.current;
    if (e) setMix({ vol: { ...e.vol }, muted: { ...e.muted }, solo: { ...e.solo } });
  }, []);

  const togglePlay = useCallback(() => {
    const e = engineRef.current;
    if (!e || e.tracks.length === 0) return;
    setPlaying(e.toggle());
  }, []);

  const onScrubStart = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    scrubWasPlayingRef.current = e.playing;
    if (e.playing) {
      e.pausePlayback();
      setPlaying(false);
    }
  }, []);
  const onScrubMove = useCallback((t: number) => {
    engineRef.current?.scrubTo(t);
  }, []);
  const onScrubEnd = useCallback((t?: number) => {
    const e = engineRef.current;
    if (!e) return;
    const wasPlaying = scrubWasPlayingRef.current;
    scrubWasPlayingRef.current = false;
    const target = t ?? e.pausedAt;
    e.scrubTo(target);
    if (wasPlaying && target < e.duration) {
      e.startPlayback(target);
      setPlaying(true);
    }
  }, []);

  const onPan = useCallback((dt: number) => {
    const v = viewRef.current;
    const e = engineRef.current;
    if (v.mode !== "follow" || !e) return;
    v.manual = true;
    v.manualStart = clamp(lastViewRef.current.t0 + dt, 0, Math.max(0, e.duration - v.windowSec));
    setFollowPaused(true);
  }, []);
  const onResumeFollow = useCallback(() => {
    viewRef.current.manual = false;
    setFollowPaused(false);
  }, []);
  const onSetMode = useCallback((m: ViewMode) => {
    viewRef.current.mode = m;
    if (m === "follow") {
      viewRef.current.manual = false;
      setFollowPaused(false);
    }
    setViewMode(m);
  }, []);

  const onToggleMute = useCallback(
    (id: string) => {
      engineRef.current?.toggleMute(id);
      syncMix();
    },
    [syncMix],
  );
  const onToggleSolo = useCallback(
    (id: string) => {
      engineRef.current?.toggleSolo(id);
      syncMix();
    },
    [syncMix],
  );
  const onVol = useCallback(
    (id: string, v: number) => {
      engineRef.current?.setVol(id, v);
      syncMix();
    },
    [syncMix],
  );
  const onPreset = useCallback((p: Preset) => {
    const e = engineRef.current;
    if (!e) return;
    if (e.preset?.id === p.id) {
      e.setPreset(null);
      setActivePresetId(null);
    } else {
      e.setPreset(p);
      setActivePresetId(p.id);
    }
  }, []);
  const onMasterVol = useCallback((v: number) => {
    engineRef.current?.setMasterVol(v / 100);
    setMasterVol(v);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => {
      // 抽屉打开时焦点在设置层，播放器快捷键让位（Esc/焦点陷阱由 Dialog 处理）
      if (drawerOpenRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (t && t.closest('[data-slot="slider"]') && e.key !== " " && e.key !== "Spacebar") return;
      const engine = engineRef.current;
      if (!engine) return;
      switch (e.key) {
        case " ":
        case "Spacebar":
          if (t && (t.tagName === "BUTTON" || t.closest("button"))) return;
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          engine.seek(engine.position() - (e.shiftKey ? 5 : 1));
          break;
        case "ArrowRight":
          e.preventDefault();
          engine.seek(engine.position() + (e.shiftKey ? 5 : 1));
          break;
        case "Home":
          e.preventDefault();
          engine.seek(0);
          break;
        case "End":
          e.preventDefault();
          engine.seek(engine.duration);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, togglePlay]);

  const onSelectTrack = useCallback(
    (t: CatalogTrack) => {
      void doLoad({ kind: "url", trackId: t.id, trackPath: t.path });
    },
    [doLoad],
  );

  // 切歌加载期间沿用歌单里的歌名，标题不会闪回 "StemPlay"
  const title =
    catalog?.tracks.find((t) => t.id === trackId)?.title ?? data?.manifest.track.title ?? "StemPlay";

  return (
    <div className="flex min-h-dvh flex-col">
      <BackgroundLayer registerDraw={registerDraw} />
      <TopBar
        title={title}
        artist={data?.artist ?? null}
        album={data?.album ?? null}
        artwork={data?.artwork ?? null}
        catalog={catalog}
        trackId={trackId}
        switching={load.status === "loading"}
        onSelectTrack={onSelectTrack}
        onOpenAppearance={() => setAppearanceOpen(true)}
      />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-3 py-2 pb-40 md:px-6 md:pb-32">
        {ready && data ? (
          <Stage
            tracks={data.tracks}
            beats={data.beats}
            duration={data.durationSec}
            originSec={data.originSec}
            fullDurationSec={data.manifest.track.durationSec}
            mix={mix}
            viewMode={viewMode}
            followPaused={followPaused}
            playheadRef={playheadRef}
            fx={fxStore}
            getEngine={getEngine}
            registerDraw={registerDraw}
            registerRuler={registerRuler}
            xToTime={xToTime}
            getView={getView}
            onScrubStart={onScrubStart}
            onScrubMove={onScrubMove}
            onScrubEnd={onScrubEnd}
            onPan={onPan}
            onToggleMute={onToggleMute}
            onToggleSolo={onToggleSolo}
            onVol={onVol}
            onSetMode={onSetMode}
            onResumeFollow={onResumeFollow}
          />
        ) : (
          <section className="glass-panel rounded-2xl p-4">
            <div className="mb-3 h-8 animate-pulse rounded bg-foreground/5" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="mb-2 flex items-center gap-3">
                <div className="h-10 w-40 animate-pulse rounded bg-foreground/5 max-md:w-20" />
                <div className="h-14 flex-1 animate-pulse rounded bg-foreground/5" />
              </div>
            ))}
            <div className="flex flex-col items-center gap-3 py-6 text-sm text-muted-foreground">
              {load.status === "error" ? (
                <>
                  <AlertTriangle className="size-6 text-amber-400" />
                  <p className="max-w-md text-center">{load.message}</p>
                  <Button onClick={() => void doLoad(lastSpecRef.current)} className="gap-1.5">
                    <RotateCcw className="size-4" />
                    重试
                  </Button>
                </>
              ) : load.status === "loading" ? (
                <>
                  <Loader2 className="size-6 animate-spin" />
                  <p>
                    {load.decoded > 0 ? `解码中 ${load.decoded}/${load.total}` : "加载资源…"}
                  </p>
                </>
              ) : null}
            </div>
          </section>
        )}
      </main>
      {ready && data && (
        <BottomBar
          playing={playing}
          duration={data.durationSec}
          originSec={data.originSec}
          presets={data.presets}
          activePresetId={activePresetId}
          masterVol={masterVol}
          timeCurRef={timeCurRef}
          localTimeRef={localTimeRef}
          progressFillRef={progressFillRef}
          progressRef={progressRef}
          onTogglePlay={togglePlay}
          onPreset={onPreset}
          onMasterVol={onMasterVol}
          onScrubStart={onScrubStart}
          onScrubMove={onScrubMove}
          onScrubEnd={onScrubEnd}
        />
      )}
      <AppearanceDrawer open={appearanceOpen} onOpenChange={setAppearanceOpen} />
      <ThemeToast />
    </div>
  );
}