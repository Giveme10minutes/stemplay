"use strict";

const TRACKS = [
  { id: "vocals", label: "人声", color: "#f59e0b" },
  { id: "drums", label: "鼓组", color: "#ef4444" },
  { id: "bass", label: "贝斯", color: "#8b5cf6" },
  { id: "guitar", label: "吉他", color: "#ec4899" },
  { id: "piano", label: "钢琴", color: "#06b6d4" },
  { id: "other", label: "其他", color: "#10b981" },
];
const AUDIO_DIR = "../separated/htdemucs_6s/test_song";

const state = {
  ctx: null,
  master: null,
  duration: 0,
  playing: false,
  startedAt: 0, // ctx.currentTime 对应的播放起点
  startOffset: 0, // 播放起点对应的媒体时间
  pausedAt: 0,
  buffers: {},
  gains: {},
  sources: [],
  vol: {},
  muted: {},
  solo: {},
  peaks: {},
};

const els = {};
const playBtn = document.getElementById("playBtn");
const timeLabel = document.getElementById("timeLabel");

function fmt(t) {
  t = Math.max(0, Math.floor(t));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

function position() {
  if (!state.playing) return state.pausedAt;
  return Math.min(state.duration, state.ctx.currentTime - state.startedAt + state.startOffset);
}

// ---------- 构建界面 ----------

function buildRow(track) {
  const row = document.createElement("div");
  row.className = "track";
  row.innerHTML = `
    <div class="track-label">
      <span class="track-dot" style="background:${track.color}"></span>
      <span class="track-name">${track.label}</span>
    </div>
    <div class="wave-wrap"><canvas class="wave" data-id="${track.id}"></canvas></div>
    <div class="track-ctrl">
      <input class="vol" type="range" min="0" max="100" value="100" data-id="${track.id}">
      <button class="mini-btn mute" data-id="${track.id}" title="静音">M</button>
      <button class="mini-btn solo" data-id="${track.id}" title="独奏">S</button>
    </div>`;
  document.getElementById("trackList").appendChild(row);

  const canvas = row.querySelector("canvas");
  els[track.id] = {
    canvas,
    g: canvas.getContext("2d"),
    row,
    offDim: document.createElement("canvas"),
    offBright: document.createElement("canvas"),
  };

  canvas.addEventListener("pointerdown", (e) => beginScrub(e, track.id));
  canvas.addEventListener("pointermove", (e) => {
    if (scrubbing === track.id) onScrub(e, track.id);
  });
  canvas.addEventListener("pointerup", (e) => endScrub(e, track.id));
  canvas.addEventListener("pointercancel", () => endScrub(null, track.id));
}

TRACKS.forEach((t) => {
  state.vol[t.id] = 1;
  state.muted[t.id] = false;
  state.solo[t.id] = false;
  buildRow(t);
});

// ---------- 波形绘制 ----------

function renderStatic(track) {
  const { canvas, offDim, offBright } = els[track.id];
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = 72;
  for (const c of [canvas, offDim, offBright]) {
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
  }

  const peaks = state.peaks[track.id];
  const buckets = peaks ? peaks.length / 2 : 0;
  for (const [target, color, dim] of [[offDim, track.color, true], [offBright, track.color, false]]) {
    const g = target.getContext("2d");
    g.clearRect(0, 0, target.width, target.height);
    if (!buckets) continue;
    g.fillStyle = color;
    g.globalAlpha = dim ? 0.35 : 1;
    const mid = target.height / 2;
    const scale = mid * 0.95;
    const w = target.width;
    for (let x = 0; x < w; x++) {
      const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
      const min = peaks[b * 2], max = peaks[b * 2 + 1];
      const y0 = mid - max * scale;
      const y1 = mid - min * scale;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }
}

function renderTrack(track) {
  const { canvas, g, offDim, offBright } = els[track.id];
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(offDim, 0, 0);
  const px = (position() / state.duration) * canvas.width;
  g.save();
  g.beginPath();
  g.rect(0, 0, px, canvas.height);
  g.clip();
  g.drawImage(offBright, 0, 0);
  g.restore();
  if (px > 0) {
    g.fillStyle = "#ffffff";
    g.fillRect(px - 1, 0, 2, canvas.height);
  }
}

function renderAll() {
  TRACKS.forEach(renderTrack);
  timeLabel.textContent = `${fmt(position())} / ${fmt(state.duration)}`;
}

window.addEventListener("resize", () => {
  TRACKS.forEach((t) => renderStatic(t));
  renderAll();
});

// ---------- 音频引擎 ----------

function effectiveGain(id) {
  const soloActive = TRACKS.some((t) => state.solo[t.id]);
  const silenced = state.muted[id] || (soloActive && !state.solo[id]);
  return silenced ? 0 : state.vol[id];
}

function updateGains() {
  const now = state.ctx ? state.ctx.currentTime : 0;
  for (const t of TRACKS) {
    state.gains[t.id].gain.setTargetAtTime(effectiveGain(t.id), now, 0.01);
  }
  TRACKS.forEach((t) => {
    els[t.id].row.classList.toggle("off", effectiveGain(t.id) === 0);
  });
}

function stopSources() {
  for (const s of state.sources) {
    try { s.stop(); } catch (e) { /* 已停止 */ }
    try { s.disconnect(); } catch (e) { /* 已断开 */ }
  }
  state.sources = [];
}

function startPlayback(from) {
  state.ctx.resume();
  const when = state.ctx.currentTime + 0.05;
  state.sources = TRACKS.map((t) => {
    const src = state.ctx.createBufferSource();
    src.buffer = state.buffers[t.id];
    src.connect(state.gains[t.id]);
    src.start(when, from); // 四轨同一 when，样本级对齐
    return src;
  });
  state.startedAt = when;
  state.startOffset = from;
  state.playing = true;
}

function pausePlayback() {
  state.pausedAt = position();
  stopSources();
  state.playing = false;
}

function seek(t) {
  const target = Math.max(0, Math.min(state.duration, t));
  if (state.playing) {
    stopSources();
    startPlayback(target);
  } else {
    state.pausedAt = target;
  }
  renderAll();
}

// ---------- 交互 ----------

let scrubbing = null; // 正在拖动 scrub 的 track id
let scrubWasPlaying = false;

function eventTime(e, id) {
  const rect = els[id].canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return frac * state.duration;
}

function beginScrub(e, id) {
  if (!state.duration) return;
  e.preventDefault();
  scrubbing = id;
  scrubWasPlaying = state.playing;
  try { els[id].canvas.setPointerCapture(e.pointerId); } catch (err) { /* 旧浏览器 */ }
  if (state.playing) pausePlayback();
  onScrub(e, id);
}

function onScrub(e, id) {
  state.pausedAt = eventTime(e, id);
  renderAll();
}

function endScrub(e, id) {
  if (scrubbing !== id && id !== null) return;
  const t = e ? eventTime(e, scrubbing) : state.pausedAt;
  scrubbing = null;
  if (scrubWasPlaying && t < state.duration) startPlayback(t);
  renderAll();
}

playBtn.addEventListener("click", () => {
  if (state.playing) {
    pausePlayback();
    playBtn.textContent = "播放";
  } else {
    const from = state.pausedAt >= state.duration ? 0 : state.pausedAt;
    startPlayback(from);
    playBtn.textContent = "暂停";
  }
});

document.getElementById("trackList").addEventListener("input", (e) => {
  if (e.target.classList.contains("vol")) {
    state.vol[e.target.dataset.id] = e.target.value / 100;
    updateGains();
  }
});

document.getElementById("trackList").addEventListener("click", (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.classList.contains("mute")) {
    state.muted[id] = !state.muted[id];
    e.target.classList.toggle("active", state.muted[id]);
  } else if (e.target.classList.contains("solo")) {
    state.solo[id] = !state.solo[id];
    e.target.classList.toggle("active", state.solo[id]);
  }
  updateGains();
});

// ---------- 主循环 ----------

let rafId = null;
function loop() {
  rafId = requestAnimationFrame(loop);
  if (!state.playing) return;
  if (position() >= state.duration) {
    pausePlayback();
    state.pausedAt = state.duration;
    playBtn.textContent = "播放";
  }
  renderAll();
}

// ---------- 初始化加载 ----------

async function init() {
  state.ctx = new (window.AudioContext || window.webkitAudioContext)();
  state.master = state.ctx.createGain();
  state.master.connect(state.ctx.destination);
  for (const t of TRACKS) {
    state.gains[t.id] = state.ctx.createGain();
    state.gains[t.id].connect(state.master);
  }

  const peaksData = await (await fetch("peaks.json")).json();
  state.peaks = Object.fromEntries(TRACKS.map((t) => [t.id, peaksData[t.id].peaks]));
  state.duration = peaksData[TRACKS[0].id].duration;
  TRACKS.forEach(renderStatic);

  await Promise.all(
    TRACKS.map(async (t) => {
      const buf = await (await fetch(`${AUDIO_DIR}/${t.id}.wav`)).arrayBuffer();
      state.buffers[t.id] = await state.ctx.decodeAudioData(buf);
    })
  );

  playBtn.disabled = false;
  playBtn.classList.add("ready");
  playBtn.textContent = "播放";
  renderAll();
  loop();
}

init();
