// 第 3 轮验收：光带穿梭 / 播放线接触波纹 / 频带呼吸。
// puppeteer-core + 本机 Chrome headless，定量采样叠加层像素与 FxStore 包络。
// 运行：cd app && node verification/round3-verify.mjs   （需先 npm run dev）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:5173/";
const results = [];
const consoleErrors = [];
const pageErrors = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  await page.screenshot({ path: path.join(dir, name) });
  console.log("shot:", name);
}
const store = (page, fn, ...args) => page.evaluate(fn, ...args);

// 页面内采样器：每帧读全部 fx 叠加 canvas 的亮点数 + FxStore 快照
async function startSampler(page, ms) {
  await page.evaluate((dur) => {
    window.__s3 = { frames: [], done: false };
    const fx = window.__stemplay.fx;
    const canvases = [...document.querySelectorAll("canvas[data-fx]")];
    const t0 = performance.now();
    const tick = () => {
      let lit = 0;
      for (const c of canvases) {
        if (!c.width || !c.height) continue;
        const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < data.length; i += 16) if (data[i] > 8) lit++; // 每 4px 抽样
      }
      const snap = fx.snapshot();
      const stems = snap.stems;
      let particles = 0;
      let ripples = 0;
      let spawnedR = 0;
      let spawnedP = 0;
      for (const id of Object.keys(stems)) {
        particles += stems[id].particles;
        ripples += stems[id].ripples;
        spawnedR += stems[id].spawnedRipples;
        spawnedP += stems[id].spawnedParticles;
      }
      window.__s3.frames.push({
        t: performance.now() - t0,
        lit,
        particles,
        ripples,
        spawnedR,
        spawnedP,
        cap: snap.particleCap,
        pos: window.__stemplay.engine.position(),
        env: Object.fromEntries(Object.entries(stems).map(([id, s]) => [id, { rms: s.envRms, mid: s.envMid, low: s.envLow, high: s.envHigh }])),
      });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else window.__s3.done = true;
    };
    requestAnimationFrame(tick);
  }, ms);
}
async function stopSampler(page) {
  await page.waitForFunction(() => window.__s3.done, { timeout: 30000, polling: 100 });
  return page.evaluate(() => window.__s3.frames);
}
function analyze(frames) {
  let nonEmpty = 0;
  let changed = 0;
  let totalDelta = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].lit > 0) nonEmpty++;
    if (i > 0) {
      const d = Math.abs(frames[i].lit - frames[i - 1].lit);
      totalDelta += d;
      if (d > 1) changed++;
    }
  }
  return { n: frames.length, nonEmpty, changed, totalDelta, maxLit: Math.max(...frames.map((f) => f.lit)) };
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--force-color-profile=srgb", "--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // 1. 加载
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null && window.__stemplay?.fx != null, { timeout: 90000 });
  await sleep(500);
  const fxInfo = await store(page, () => {
    const s = window.__stemplay.fx.snapshot();
    return { fx: s.fx, cap: s.particleCap, stems: Object.keys(s.stems).length, canvases: document.querySelectorAll("canvas[data-fx]").length };
  });
  record("FxStore + 6 个叠加 canvas 挂载", fxInfo.canvases === 6, fxInfo);

  // 2. 播放（真实 UI 按钮）→ 2.6s 逐帧采样
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(700);
  const posPlaying = await store(page, () => window.__stemplay.engine.position());
  record("播放启动（真实按钮）", posPlaying > 0.3, { posPlaying });
  await startSampler(page, 2600);
  await sleep(2700);
  const playFrames = await stopSampler(page);
  const playA = analyze(playFrames);
  const spawnedR = playFrames[playFrames.length - 1].spawnedR - playFrames[0].spawnedR;
  const spawnedP = playFrames[playFrames.length - 1].spawnedP - playFrames[0].spawnedP;
  const maxParticles = Math.max(...playFrames.map((f) => f.particles));
  record(
    "叠加层持续动画（光带/波纹/呼吸）",
    playA.nonEmpty / playA.n > 0.8 && playA.changed / playA.n > 0.5 && playA.totalDelta > 500,
    { ...playA, nonEmptyRatio: +(playA.nonEmpty / playA.n).toFixed(3), changedRatio: +(playA.changed / playA.n).toFixed(3) },
  );
  record("播放中 onset 触发波纹+粒子（真实特征数据）", spawnedR > 0 && spawnedP > 0, { spawnedR, spawnedP, maxParticles });
  record("粒子数不超过硬上限（桌面 120）", maxParticles <= 120, { maxParticles, cap: playFrames[0].cap });
  await shot(page, "round3-01-playing.png");

  // 3a. 静音鼓组（真实 M 按钮）→ 鼓包络收敛到 0，可听轨保持亮
  await page.evaluate(() => document.querySelector('button[aria-label="鼓组 静音"]')?.click());
  const drumsMuted = await store(page, () => window.__stemplay.engine.muted.drums === true);
  await startSampler(page, 1400);
  await sleep(1500);
  const muteFrames = await stopSampler(page);
  const tail = muteFrames.slice(-10);
  const drumsEnvTail = Math.max(...tail.map((f) => f.env.drums.mid + f.env.drums.rms));
  const otherLit = tail.map((f) =>
    Object.entries(f.env)
      .filter(([id]) => id !== "drums")
      .map(([, e]) => e.rms),
  );
  const audiblePeak = Math.max(...otherLit.flat());
  record(
    "静音鼓组 → 鼓显示值收敛 0、其余可听轨保持亮",
    drumsMuted && drumsEnvTail < 0.02 && audiblePeak > 0.05,
    { drumsMuted, drumsEnvTail: +drumsEnvTail.toFixed(4), audiblePeak: +audiblePeak.toFixed(4) },
  );
  await shot(page, "round3-02-muted-converge.png");
  await page.evaluate(() => document.querySelector('button[aria-label="鼓组 静音"]')?.click()); // 解除静音

  // 3b. 主音量 0（真实滑杆最左端）→ 全部轨收敛
  const mvBox = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[role="slider"],[data-slot="slider"]')].find((s) =>
      (s.getAttribute("aria-label") ?? "").includes("主音量"),
    );
    const root = el?.closest('[data-slot="slider"]') ?? el;
    const track = root?.querySelector('[data-slot="slider-track"]') ?? root;
    const r = track?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  });
  if (mvBox) await page.mouse.click(mvBox.x, mvBox.y + mvBox.h / 2);
  await sleep(300);
  const masterAfterSlider = await store(page, () => window.__stemplay.engine.masterVol);
  if (masterAfterSlider > 0) {
    // 滑杆点击未精确到 0 → 兜底走引擎（如实记录）
    await store(page, () => window.__stemplay.engine.setMasterVol(0));
  }
  const masterFinal = await store(page, () => window.__stemplay.engine.masterVol);
  await startSampler(page, 1300);
  await sleep(1400);
  const masterFrames = await stopSampler(page);
  const mTail = masterFrames.slice(-8);
  const allEnv = Math.max(...mTail.flatMap((f) => Object.values(f.env).flatMap((e) => [e.rms, e.mid, e.low, e.high])));
  const masterLit = Math.max(...mTail.map((f) => f.lit));
  record(
    "主音量 0 → 全部轨包络收敛 + 叠加亮点远低于播放态（g²/g 映射音画耦合）",
    masterFinal === 0 && allEnv < 0.02 && masterLit < playA.maxLit * 0.1,
    { masterAfterSlider, masterFinal, allEnv: +allEnv.toFixed(4), masterLit, playMaxLit: playA.maxLit, usedEngineFallback: masterAfterSlider > 0 },
  );
  await store(page, () => window.__stemplay.engine.setMasterVol(1));
  await page.evaluate(() => {
    // 主音量滑杆点回最右，恢复 React state 与引擎一致
    const el = [...document.querySelectorAll('[role="slider"],[data-slot="slider"]')].find((s) =>
      (s.getAttribute("aria-label") ?? "").includes("主音量"),
    );
    const root = el?.closest('[data-slot="slider"]') ?? el;
    const track = root?.querySelector('[data-slot="slider-track"]') ?? root;
    const r = track?.getBoundingClientRect();
    if (r) {
      const opts = { bubbles: true, clientX: r.x + r.width - 1, clientY: r.y + r.height / 2, pointerId: 1 };
      track.dispatchEvent(new PointerEvent("pointerdown", opts));
      track.dispatchEvent(new PointerEvent("pointerup", opts));
    }
  });
  await sleep(300);

  // 4. seek 清空状态：采样器横跨 seek 前后，帧内定位 pos 回退点，证明无历史事件补放
  await store(page, () => window.__stemplay.engine.setMasterVol(1));
  await sleep(200);
  const wBox = await page.evaluate(() => {
    const r = document.querySelector('canvas[data-track="drums"]').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await startSampler(page, 3000);
  await sleep(900);
  const posBefore = await store(page, () => window.__stemplay.engine.position());
  await page.mouse.click(wBox.x + wBox.w * 0.25, wBox.y + wBox.h / 2); // 跟随模式播放线在 42% → 点 25% 向后 seek
  await sleep(2300);
  const seekFrames = await stopSampler(page);
  // 定位 seek 帧：pos 非单调回退
  let seekIdx = -1;
  for (let i = 1; i < seekFrames.length; i++) {
    if (seekFrames[i].pos < seekFrames[i - 1].pos - 0.5) {
      seekIdx = i;
      break;
    }
  }
  const posAfter = seekIdx >= 0 ? seekFrames[seekIdx].pos : NaN;
  // 单帧 spawn 上限 = 6（每轨 break 限 1）；补放 bug 会表现为单帧大量 spawn 或 seek 帧粒子直接顶到上限
  let maxPerFrameSpawn = 0;
  for (let i = Math.max(1, seekIdx); i < seekFrames.length; i++) {
    maxPerFrameSpawn = Math.max(maxPerFrameSpawn, seekFrames[i].spawnedR - seekFrames[i - 1].spawnedR);
  }
  const particlesAtSeek = seekIdx >= 0 ? seekFrames[seekIdx].particles : NaN;
  const maxParticlesSeek = Math.max(...seekFrames.map((f) => f.particles));
  record("向后 seek 生效（采样帧内 pos 回退）", seekIdx > 0 && posAfter < posBefore - 0.5, { seekIdx, posBefore: +posBefore.toFixed(2), posAfter: +posAfter.toFixed(2) });
  record(
    "seek 后无爆量补放（单帧 spawn≤6、粒子有界、seek 帧粒子未顶上限）",
    maxPerFrameSpawn <= 6 && maxParticlesSeek <= 120 && particlesAtSeek <= 40,
    { maxPerFrameSpawn, maxParticlesSeek, particlesAtSeek, cap: seekFrames[0].cap },
  );
  await shot(page, "round3-03-seek.png");

  // 5. 暂停收敛：暂停 1s 后装饰包络/粒子归零（播放线与静态波形保留）
  await page.evaluate(() => document.querySelector('button[aria-label="暂停"]')?.click());
  await sleep(1200);
  const paused = await store(page, () => {
    const s = window.__stemplay.fx.snapshot().stems;
    const envs = Object.values(s).flatMap((x) => [x.envRms, x.envMid, x.envLow, x.envHigh]);
    return {
      playing: window.__stemplay.engine.playing,
      maxEnv: Math.max(...envs),
      particles: Object.values(s).reduce((a, x) => a + x.particles, 0),
      ripples: Object.values(s).reduce((a, x) => a + x.ripples, 0),
      playheadVisible: getComputedStyle(document.querySelector(".playhead-line")).opacity !== "0",
    };
  });
  record("暂停 → 装饰动画收敛、播放线保留", !paused.playing && paused.maxEnv < 0.02 && paused.particles === 0 && paused.ripples === 0 && paused.playheadVisible, paused);

  // 6. reduced-motion（matchMedia 实时）：波纹/粒子/流光关闭，亮度反馈与播放线保留
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await sleep(400);
  const rmFlag = await store(page, () => window.__stemplay.fx.reduced);
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(400);
  await startSampler(page, 1200);
  await sleep(1300);
  const rmFrames = await stopSampler(page);
  const rmSpawned = rmFrames[rmFrames.length - 1].spawnedR - rmFrames[0].spawnedR;
  const rmParticles = Math.max(...rmFrames.map((f) => f.particles));
  const rmA = analyze(rmFrames);
  record(
    "reduced-motion：无波纹/粒子，光带/段条亮度反馈保留",
    rmFlag && rmSpawned === 0 && rmParticles === 0 && rmA.nonEmpty / rmA.n > 0.5,
    { rmFlag, rmSpawned, rmParticles, nonEmptyRatio: +(rmA.nonEmpty / rmA.n).toFixed(3) },
  );
  await page.emulateMediaFeatures([]);
  await page.evaluate(() => document.querySelector('button[aria-label="暂停"]')?.click());
  await sleep(200);

  // 7. 控制台
  record("控制台 0 错误 / 0 pageerror", consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });

  fs.writeFileSync(
    path.join(dir, "round3-results.json"),
    JSON.stringify(
      {
        results,
        consoleErrors,
        pageErrors,
        playing: playA,
        spawnedDuringPlay: { spawnedR, spawnedP, maxParticles },
        mute: { drumsEnvTail, audiblePeak },
        seek: { posBefore, posAfter },
        paused,
      },
      null,
      2,
    ),
  );
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.name));
} finally {
  await browser.close();
}
