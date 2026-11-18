import type { Preset } from "@/lib/resources";

export interface EngineTrack {
  id: string;
  delaySec: number;
}

export class StemEngine {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  gains: Record<string, GainNode> = {};
  buffers: Record<string, AudioBuffer> = {};
  tracks: EngineTrack[] = [];
  duration = 0;
  playing = false;
  startedAt = 0;
  startOffset = 0;
  pausedAt = 0;
  sources: AudioBufferSourceNode[] = [];
  vol: Record<string, number> = {};
  muted: Record<string, boolean> = {};
  solo: Record<string, boolean> = {};
  preset: Preset | null = null;
  masterVol = 1;
  /** 视觉增益包络记录（只读镜像 setTargetAtTime 的指数曲线，不影响音频调度） */
  gainEnv: Record<string, { from: number; to: number; t0: number; tau: number }> = {};

  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.masterVol;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  init(tracks: EngineTrack[], buffers: Record<string, AudioBuffer>, duration: number) {
    const ctx = this.ensureContext();
    this.stopSources();
    this.tracks = tracks;
    this.buffers = buffers;
    this.duration = duration;
    this.playing = false;
    this.pausedAt = 0;
    this.gains = {};
    this.gainEnv = {};
    for (const t of tracks) {
      this.vol[t.id] = 1;
      this.muted[t.id] = false;
      this.solo[t.id] = false;
      const g = ctx.createGain();
      g.connect(this.master!);
      this.gains[t.id] = g;
    }
    this.applyGains(0.001);
  }

  position(): number {
    if (!this.playing || !this.ctx) return this.pausedAt;
    return Math.min(this.duration, this.ctx.currentTime - this.startedAt + this.startOffset);
  }

  effectiveGain(id: string): number {
    const soloActive = this.tracks.some((t) => this.solo[t.id]);
    const silenced = this.muted[id] || (soloActive && !this.solo[id]);
    if (silenced) return 0;
    const presetGain = this.preset ? (this.preset.gains[id] ?? 1) : 1;
    return presetGain * this.vol[id];
  }

  private applyGains(tau: number) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // 记录视觉包络：from 取当前解析值 → 连续切换从当前值续接、可中断，绝不跳变
    const wall = performance.now() / 1000;
    for (const t of this.tracks) {
      const target = this.effectiveGain(t.id);
      this.gains[t.id].gain.setTargetAtTime(target, now, tau);
      const prev = this.gainEnv[t.id];
      this.gainEnv[t.id] = { from: prev ? this.visualGain(t.id, wall) : target, to: target, t0: wall, tau };
    }
  }

  /** 只读解析式视觉增益：与音频 setTargetAtTime 同数学（nowSec 与 rAF ts/1000 同源） */
  visualGain(id: string, nowSec: number): number {
    const env = this.gainEnv[id];
    if (!env) return this.effectiveGain(id);
    return env.to + (env.from - env.to) * Math.exp(-(nowSec - env.t0) / env.tau);
  }

  private stopSources() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 已停止 */
      }
      try {
        s.disconnect();
      } catch {
        /* 已断开 */
      }
    }
    this.sources = [];
  }

  startPlayback(from: number) {
    if (!this.ctx || this.tracks.length === 0) return;
    const start = Math.max(0, Math.min(this.duration, from));
    if (start >= this.duration) {
      this.pausedAt = this.duration;
      this.playing = false;
      return;
    }
    void this.ctx.resume();
    const when = this.ctx.currentTime + 0.05;
    this.sources = this.tracks.map((t) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = this.buffers[t.id];
      src.connect(this.gains[t.id]);
      // 全部源共享同一 when → 样本级对齐；编码延迟只在源 offset 层补偿一次
      src.start(when, start + t.delaySec);
      return src;
    });
    this.startedAt = when;
    this.startOffset = start;
    this.playing = true;
  }

  pausePlayback() {
    this.pausedAt = this.position();
    this.stopSources();
    this.playing = false;
  }

  toggle(): boolean {
    if (this.playing) {
      this.pausePlayback();
    } else {
      this.startPlayback(this.pausedAt >= this.duration ? 0 : this.pausedAt);
    }
    return this.playing;
  }

  seek(t: number) {
    const target = Math.max(0, Math.min(this.duration, t));
    if (this.playing) {
      this.stopSources();
      this.startPlayback(target);
    } else {
      this.pausedAt = target;
    }
  }

  scrubTo(t: number) {
    if (!this.playing) {
      this.pausedAt = Math.max(0, Math.min(this.duration, t));
    }
  }

  setVol(id: string, v: number) {
    this.vol[id] = v;
    this.applyGains(0.01);
  }

  toggleMute(id: string) {
    this.muted[id] = !this.muted[id];
    this.applyGains(0.01);
  }

  toggleSolo(id: string) {
    this.solo[id] = !this.solo[id];
    this.applyGains(0.01);
  }

  setPreset(p: Preset | null) {
    this.preset = p;
    this.applyGains(p ? p.transitionSec / 3 : 0.01);
  }

  setMasterVol(v: number) {
    this.masterVol = v;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
    }
  }

  dispose() {
    this.stopSources();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.gains = {};
  }
}