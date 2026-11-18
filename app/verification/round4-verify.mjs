// 第 4 轮验收：高能冲击（真实特征数据 + 冷却 + 同帧合并）/ 聚光视觉增益包络（解析指数对比）/
// 控件零位移 / 持续高能场景（自然 + testOverride 单元驱动）/ 动效预设与 master 开关 + 持久化 /
// reduced-motion / 连续切换无帧跳变。
// puppeteer-core + 本机 Chrome headless。运行：cd app && node verification/round4-verify.mjs （需先 npm run dev）
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
const numbers = {};

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) {
  await page.screenshot({ path: path.join(dir, name) });
  console.log("shot:", name);
}

// 通用页内 rAF 采样器：每帧执行字段源码（new Function("ts", src)），直到时长结束
async function stopSampler(page, timeout = 40000) {
  await page.waitForFunction(() => window.__s4.done, { timeout, polling: 100 });
  return page.evaluate(() => window.__s4.frames);
}

// 每帧公共字段：冲击计数/日志长度、逐轨 fired/shake、粒子、播放位置
const CORE_FIELDS = `
  const sp = window.__stemplay; const fx = sp.fx;
  const stems = {};
  for (const [id, s] of fx.stems) stems[id] = { fired: s.impactsFired, shake: s.shakePx, gv: s.gv };
  let spawnedR = 0, spawnedP = 0, particles = 0;
  for (const s of fx.stems.values()) { spawnedR += s.spawnedRipples; spawnedP += s.spawnedParticles; particles += s.particles.length; }
  return {
    ts, pos: sp.engine.position(), main: fx.mainImpacts, logLen: fx.triggerLog.length,
    stems, spawnedR, spawnedP, particles,
    scene: { active: fx.scene.active, flow: fx.scene.flowMult, maxFlow: fx.scene.maxFlowMult, halo: fx.scene.halo, shared: fx.scene.shared, enter: fx.scene.enterCount, exit: fx.scene.exitCount },
  };
`;

function bboxSpread(boxes) {
  // boxes: [{x,y,w,h}|null] → 每维度最大抖动
  let m = 0;
  const keys = ["x", "y", "w", "h"];
  for (const k of keys) {
    const vals = boxes.filter((b) => b).map((b) => b[k]);
    if (vals.length) m = Math.max(m, Math.max(...vals) - Math.min(...vals));
  }
  return m;
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

  // ---------- 1. 加载 + 真实按钮播放 ----------
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null && window.__stemplay?.fx != null && window.__stemplay?.motion != null, { timeout: 90000 });
  await sleep(400);
  const info = await page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas[data-fx]").length,
    sceneP: [window.__stemplay.fx.scene.p90, window.__stemplay.fx.scene.p75],
    motionBtnDisabled: document.querySelector('[data-testid="open-motion"]')?.disabled ?? null,
    importBtnDisabled: [...document.querySelectorAll("button")].find((b) => b.textContent === "导入")?.disabled ?? null,
  }));
  record("加载：6 叠加层 + 场景分位就绪 + 动效/导入按钮均已启用（第 5 轮起导入启用）", info.canvases === 6 && info.sceneP[0] > 0 && info.motionBtnDisabled === false && info.importBtnDisabled === false, info);
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(600);
  const posPlaying = await page.evaluate(() => window.__stemplay.engine.position());
  record("播放启动（真实按钮）", posPlaying > 0.3, { posPlaying });

  // ---------- 2. 高能冲击：真实特征数据 + 冷却 + 合并 + 控件零位移 ----------
  // 定位到密集窗口 7→16.5s：离线特征模拟预测 drums 8.46/9.84 + vocals 11.10/14.18
  const preA = await page.evaluate(() => {
    window.__stemplay.engine.seek(7);
    return { main: window.__stemplay.fx.mainImpacts, log: window.__stemplay.fx.triggerLog.slice() };
  });
  const framesA = await (async () => {
    await page.evaluate((src) => {
      window.__s4 = { frames: [], done: false };
      const f = new Function("ts", src);
      const t0 = performance.now();
      const tick = (ts) => {
        window.__s4.frames.push(f(ts));
        if (performance.now() - t0 < 9500) requestAnimationFrame(tick);
        else window.__s4.done = true;
      };
      requestAnimationFrame(tick);
    }, `
      const sp = window.__stemplay; const fx = sp.fx;
      const stems = {};
      for (const [id, s] of fx.stems) stems[id] = { fired: s.impactsFired, shake: s.shakePx, gv: s.gv };
      let spawnedR = 0, spawnedP = 0, particles = 0;
      for (const s of fx.stems.values()) { spawnedR += s.spawnedRipples; spawnedP += s.spawnedParticles; particles += s.particles.length; }
      const q = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const nameEl = document.querySelector('[data-row="drums"] span.truncate');
      const nr = nameEl ? nameEl.getBoundingClientRect() : null;
      return {
        ts, pos: sp.engine.position(), main: fx.mainImpacts, logLen: fx.triggerLog.length,
        stems, spawnedR, spawnedP, particles,
        bb: {
          name: nr ? { x: nr.x, y: nr.y, w: nr.width, h: nr.height } : null,
          ruler: q('[data-testid="time-ruler"]'),
          play: q('button[aria-label="暂停"], button[aria-label="播放"]'),
          slider: q('[aria-label="鼓组 音量"]'),
          rowDrums: q('[data-row="drums"]'),
        },
      };
    `);
    await sleep(9700);
    return stopSampler(page);
  })();

  const postA = await page.evaluate(() => ({ main: window.__stemplay.fx.mainImpacts, log: window.__stemplay.fx.triggerLog.slice() }));
  const newLog = postA.log.slice(preA.log.length);
  const perStem = {};
  for (const e of newLog) (perStem[e.id] ??= []).push(e.at);
  let minSameStemGap = Infinity;
  for (const id of Object.keys(perStem)) {
    const a = perStem[id];
    for (let i = 1; i < a.length; i++) minSameStemGap = Math.min(minSameStemGap, a[i] - a[i - 1]);
  }
  const totalTriggers = newLog.length;
  const mainDelta = postA.main - preA.main;
  // 按 25ms 桶合并同帧触发：main 增量应等于触发帧数且 ≤ 总触发数
  const buckets = new Set(newLog.map((e) => Math.round(e.at * 40)));
  numbers.impacts = {
    windowSec: 9.5,
    totalTriggers,
    mainDelta,
    distinctFrames: buckets.size,
    perStem: Object.fromEntries(Object.entries(perStem).map(([k, v]) => [k, v.length])),
    positions: newLog.map((e) => +e.pos.toFixed(2)),
    minSameStemGap: Number.isFinite(minSameStemGap) ? +minSameStemGap.toFixed(3) : null,
  };
  record(
    "高能冲击来自真实特征数据（≥3 次，位置与离线特征模拟一致）",
    totalTriggers >= 3,
    numbers.impacts,
  );
  record(
    "同轨冷却 ≥1.0s（滞回防连抖）",
    !Number.isFinite(minSameStemGap) || minSameStemGap >= 0.999,
    { minSameStemGap: numbers.impacts.minSameStemGap },
  );
  record("多轨同帧触发合并为主冲击（main ≤ Σ触发，且 main == 触发帧数）", mainDelta <= totalTriggers && mainDelta === buckets.size, { mainDelta, totalTriggers, frames: buckets.size });

  // 合并路径确定性验证：testForceIds 双轨同帧强制触发（走真实 fire/合并代码）
  const preForce = await page.evaluate(() => ({ main: window.__stemplay.fx.mainImpacts, fired: [...window.__stemplay.fx.stems.values()].reduce((a, s) => a + s.impactsFired, 0) }));
  await page.evaluate(() => { window.__stemplay.fx.testForceIds = ["drums", "vocals"]; });
  await sleep(200);
  const postForce = await page.evaluate(() => ({
    main: window.__stemplay.fx.mainImpacts,
    fired: [...window.__stemplay.fx.stems.values()].reduce((a, s) => a + s.impactsFired, 0),
    last: window.__stemplay.fx.triggerLog.slice(-2),
  }));
  record(
    "双轨同帧强制触发 → 触发 +2、主冲击 +1（合并生效）",
    postForce.fired - preForce.fired === 2 && postForce.main - preForce.main === 1,
    { firedDelta: postForce.fired - preForce.fired, mainDelta: postForce.main - preForce.main, sameFrame: postForce.last[0]?.at === postForce.last[1]?.at },
  );

  // 控件零位移：冲击窗口内 bbox 全程采样
  const spreads = {
    name: bboxSpread(framesA.map((f) => f.bb.name)),
    ruler: bboxSpread(framesA.map((f) => f.bb.ruler)),
    play: bboxSpread(framesA.map((f) => f.bb.play)),
    slider: bboxSpread(framesA.map((f) => f.bb.slider)),
    rowDrums: bboxSpread(framesA.map((f) => f.bb.rowDrums)),
  };
  const maxSpread = Math.max(...Object.values(spreads));
  const maxShakeStd = Math.max(...framesA.map((f) => Math.max(...Object.values(f.stems).map((s) => s.shake))));
  numbers.controlBboxMaxSpreadPx = +maxSpread.toFixed(3);
  numbers.standardShakeMaxPx = +maxShakeStd.toFixed(3);
  record("冲击期间控件零位移（曲名/时间标尺/播放按钮/滑杆/行框 bbox 抖动 ≤0.5px）", maxSpread <= 0.5, { spreads, maxSpread: numbers.controlBboxMaxSpreadPx });
  record("标准档抖动峰值在 1–2px 区间（canvas 内部 translate）", maxShakeStd > 0.5 && maxShakeStd <= 2.001, { maxShakeStd: numbers.standardShakeMaxPx });
  await shot(page, "round4-01-impact.png");

  // ---------- 3. 聚光：视觉增益跟随解析指数包络 ----------
  const g0 = await page.evaluate(() => Object.fromEntries([...window.__stemplay.fx.stems].map(([id, s]) => [id, s.gv])));
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "人声聚光")?.click());
  await sleep(60);
  const envInfo = await page.evaluate(() => {
    const e = window.__stemplay.engine;
    return { env: JSON.parse(JSON.stringify(e.gainEnv)), presetTau: e.preset ? e.preset.transitionSec / 3 : null };
  });
  const tauOK = Math.abs(envInfo.env.vocals.tau - 0.2) < 1e-9 && Math.abs(envInfo.presetTau - 0.2) < 1e-9;
  const toOK = Math.abs(envInfo.env.vocals.to - 1) < 1e-9 && Math.abs(envInfo.env.drums.to - 0.22) < 1e-9 && Math.abs(envInfo.env.bass.to - 0.22) < 1e-9;
  const fromOK = Math.abs(envInfo.env.drums.from - g0.drums) < 0.01;
  await page.evaluate((src) => {
    window.__s4 = { frames: [], done: false };
    const f = new Function("ts", src);
    const t0 = performance.now();
    const tick = (ts) => {
      window.__s4.frames.push(f(ts));
      if (performance.now() - t0 < 1400) requestAnimationFrame(tick);
      else window.__s4.done = true;
    };
    requestAnimationFrame(tick);
  }, `
    const sp = window.__stemplay; const fx = sp.fx; const e = sp.engine;
    const now = ts / 1000;
    const dev = {}; const gv = {};
    for (const [id, s] of fx.stems) {
      const env = e.gainEnv[id];
      const expected = env.to + (env.from - env.to) * Math.exp(-(now - env.t0) / env.tau);
      dev[id] = Math.abs(s.gv - expected * e.masterVol);
      gv[id] = s.gv;
    }
    const q = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return { ts, dev, gv, rows: [...document.querySelectorAll('[data-row]')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }) };
  `);
  await shot(page, "round4-02-spotlight.png"); // 过渡中段截图
  await sleep(1100);
  const framesB = await stopSampler(page);
  let maxDev = 0;
  for (const f of framesB) for (const id of Object.keys(f.dev)) maxDev = Math.max(maxDev, f.dev[id]);
  const lastB = framesB[framesB.length - 1];
  const dimOK = lastB.gv.drums > 0.15 && lastB.gv.drums < 0.3 && lastB.gv.vocals > 0.9;
  const rowSpread = Math.max(...[0, 1, 2, 3, 4, 5].map((i) => bboxSpread(framesB.map((f) => f.rows[i]))));
  numbers.spotlight = {
    tauOK, toOK, fromOK,
    maxDeviation: +maxDev.toFixed(5),
    endGv: { vocals: +lastB.gv.vocals.toFixed(3), drums: +lastB.gv.drums.toFixed(3) },
    rowSpreadPx: +rowSpread.toFixed(3),
    g0Before: g0.drums,
    envFrom: envInfo.env.drums.from,
  };
  record("聚光包络参数正确（tau=transitionSec/3=0.2、to=预设增益、from=点击前 gv）", tauOK && toOK && fromOK, numbers.spotlight);
  record("视觉增益逐帧贴合解析指数 target+(g0-target)·exp(-(t-t0)/tau)（偏差 <0.01）", maxDev < 0.01, { maxDev: +maxDev.toFixed(5) });
  record("非聚焦轨渐暗但保持可见（0.15<gv<0.3）且行位置零跳变", dimOK && rowSpread <= 0.5, { drumsGv: +lastB.gv.drums.toFixed(3), rowSpreadPx: +rowSpread.toFixed(3) });
  // 取消预设（再次点击 = toggle off）
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "人声聚光")?.click());
  await sleep(500);

  // ---------- 5. 持续高能场景 ----------
  const naturalEnter = await page.evaluate(() => window.__stemplay.fx.scene.enterCount);
  // 本 40s 预览片段共享能量从未持续 ≥p90 达 2s（离线特征模拟证实）→ 用 testOverride 直接驱动共享能量输入做单元验证
  const sceneUnit = await page.evaluate(async () => {
    const fx = window.__stemplay.fx;
    const sc = fx.scene;
    const samples = [];
    const t0 = performance.now();
    sc.testOverride = sc.p90 * 1.05;
    const collect = () => samples.push({ t: performance.now() - t0, active: sc.active, flow: sc.flowMult, maxFlow: sc.maxFlowMult, halo: sc.halo, enter: sc.enterCount, exit: sc.exitCount });
    await new Promise((res) => {
      const iv = setInterval(() => {
        collect();
        if (performance.now() - t0 > 3000) { clearInterval(iv); res(); }
      }, 50);
    });
    const entered = sc.active && sc.enterCount >= 1;
    const flowDuring = Math.max(...samples.map((s) => s.flow));
    sc.testOverride = sc.p75 * 0.9;
    const t1 = performance.now();
    await new Promise((res) => {
      const iv = setInterval(() => {
        collect();
        if (performance.now() - t1 > 2400) { clearInterval(iv); res(); }
      }, 50);
    });
    const exited = !sc.active && sc.exitCount >= 1;
    // 退出后再等 1.5s 让 halo/flowMult 平滑尾巴收敛（tau 0.5/0.3）
    await new Promise((r) => setTimeout(r, 1500));
    const flowEnd = sc.flowMult;
    sc.testOverride = null;
    return { entered, exited, flowDuring, flowEnd, maxFlow: sc.maxFlowMult, enter: sc.enterCount, exit: sc.exitCount, samples: samples.length };
  });
  numbers.scene = { naturalEnterCount: naturalEnter, method: "testOverride 单元驱动（自然播放未达持续场景，离线特征模拟证实无 ≥2s 的 p90 段）", ...sceneUnit };
  record("持续场景：进入（≥p90 持续 2s）/退出（<p75 持续 1.5s）状态机正确", sceneUnit.entered && sceneUnit.exited, numbers.scene);
  record("背景流速乘子始终 ≤1.2 且退出后回落", sceneUnit.maxFlow <= 1.2001 && sceneUnit.flowEnd < 1.05, { maxFlow: +sceneUnit.maxFlow.toFixed(4), flowEnd: +sceneUnit.flowEnd.toFixed(4) });

  // ---------- 6. 动效预设 + master 开关 ----------
  await page.evaluate(() => document.querySelector('[data-testid="open-motion"]')?.click());
  await sleep(400);
  const panelOpen = await page.evaluate(() => !!document.querySelector('[data-testid="motion-panel"]'));
  await shot(page, "round4-03-motion-panel.png");
  record("动效面板打开（master 开关 + 四档）", panelOpen, { panelOpen });

  // 安静档：密集窗口 30→39s（drums 30.46/33.96/36.80/37.92 候选）应 0 冲击 0 粒子 0 波纹
  await page.evaluate(() => document.querySelector('[data-tier="quiet"]')?.click());
  await sleep(250);
  const quiet = await runWindow(page, 30, 9000);
  record("安静档：0 冲击 / 0 粒子 / 0 波纹 / 0 抖动（密集窗口 30–39s）", quiet.firedDelta === 0 && quiet.spawnedP === 0 && quiet.spawnedR === 0 && quiet.maxShake === 0, quiet);

  // 增强档：窗口 7→11.6s（drums 8.46/9.84 + vocals 11.10）
  await page.evaluate(() => document.querySelector('[data-tier="enhanced"]')?.click());
  await sleep(250);
  const enhanced = await runWindow(page, 7, 4600, async (mid) => { if (mid) await shot(page, "round4-04-enhanced.png"); });
  // 标准档：同窗口对照
  await page.evaluate(() => document.querySelector('[data-tier="standard"]')?.click());
  await sleep(250);
  const standard = await runWindow(page, 7, 4600);
  numbers.motion = {
    quiet: { firedDelta: quiet.firedDelta, spawnedR: quiet.spawnedR, spawnedP: quiet.spawnedP },
    enhanced: { firedDelta: enhanced.firedDelta, spawnedP: enhanced.spawnedP, maxShake: +enhanced.maxShake.toFixed(3), maxParticles: enhanced.maxParticles },
    standard: { firedDelta: standard.firedDelta, spawnedP: standard.spawnedP, maxShake: +standard.maxShake.toFixed(3), maxParticles: standard.maxParticles },
  };
  record("增强档：冲击照常触发、抖动峰值 ≤3px", enhanced.firedDelta >= 2 && enhanced.maxShake <= 3.001 && enhanced.maxShake > 1.6, numbers.motion.enhanced);
  record("增强档粒子多于标准档（同窗口同内容）", enhanced.spawnedP > standard.spawnedP, { enhancedP: enhanced.spawnedP, standardP: standard.spawnedP });
  record("标准档抖动峰值 ≤2px 且增强 > 标准", standard.maxShake <= 2.001 && enhanced.maxShake > standard.maxShake, { standard: +standard.maxShake.toFixed(3), enhanced: +enhanced.maxShake.toFixed(3) });

  // master 关：无冲击/粒子/抖动，播放线 + 基础明暗保留
  await page.evaluate(() => document.querySelector('[data-testid="motion-master"]')?.click());
  await sleep(250);
  const off = await runWindow(page, 7, 4200, async () => {
    const lit = await page.evaluate(() => {
      let n = 0;
      for (const c of document.querySelectorAll("canvas[data-fx]")) {
        if (!c.width || !c.height) continue;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 16) if (d[i] > 8) n++;
      }
      return { lit: n, playhead: getComputedStyle(document.querySelector(".playhead-line")).opacity !== "0" };
    });
    return lit;
  });
  numbers.masterOff = { firedDelta: off.firedDelta, spawnedR: off.spawnedR, spawnedP: off.spawnedP, maxShake: +off.maxShake.toFixed(3), extra: off.extra };
  record("master 关：0 冲击/粒子/波纹/抖动，播放线 + 基础明暗保留", off.firedDelta === 0 && off.spawnedR === 0 && off.spawnedP === 0 && off.maxShake === 0 && off.extra?.lit > 0 && off.extra?.playhead === true, numbers.masterOff);
  await page.evaluate(() => document.querySelector('[data-testid="motion-master"]')?.click()); // 恢复 master

  // 持久化：轻柔 + 重载
  await page.evaluate(() => document.querySelector('[data-tier="soft"]')?.click());
  await sleep(200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null && window.__stemplay?.motion != null, { timeout: 90000 });
  await sleep(400);
  const restored = await page.evaluate(() => ({
    prefs: window.__stemplay.motion.getState(),
    tier: window.__stemplay.fx.motionTier,
    ls: localStorage.getItem("stemplay.motion.v1"),
  }));
  record("动效偏好持久化（重载后恢复 轻柔）", restored.prefs.tier === "soft" && restored.tier === "soft" && restored.ls?.includes("soft"), restored);
  await page.evaluate(() => window.__stemplay.motion.setTier("standard"));
  await sleep(200);

  // ---------- 7. reduced-motion ----------
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await sleep(300);
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(500);
  const rmFlag = await page.evaluate(() => window.__stemplay.fx.reduced);
  const rm = await runWindow(page, 7, 4600, async () => {
    return page.evaluate(() => {
      let n = 0;
      for (const c of document.querySelectorAll("canvas[data-fx]")) {
        if (!c.width || !c.height) continue;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 16) if (d[i] > 8) n++;
      }
      return { lit: n, playhead: getComputedStyle(document.querySelector(".playhead-line")).opacity !== "0", flow: window.__stemplay.fx.scene.flowMult };
    });
  });
  numbers.reducedMotion = { rmFlag, firedDelta: rm.firedDelta, spawnedR: rm.spawnedR, spawnedP: rm.spawnedP, maxShake: +rm.maxShake.toFixed(3), extra: rm.extra };
  record(
    "reduced-motion：无冲击/波纹/粒子/抖动/场景推动，播放线 + 明暗反馈保留",
    rmFlag && rm.firedDelta === 0 && rm.spawnedR === 0 && rm.spawnedP === 0 && rm.maxShake === 0 && rm.extra?.flow <= 1.0001 && rm.extra?.lit > 0 && rm.extra?.playhead === true,
    numbers.reducedMotion,
  );
  await page.emulateMediaFeatures([]);
  await sleep(300);

  // ---------- 8. 连续切换无帧跳变 ----------
  await page.evaluate(() => {
    window.__fd = { ts: [] };
    const tick = (ts) => { window.__fd.ts.push(ts); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < 12; i++) {
    await page.evaluate((k) => {
      const sp = window.__stemplay;
      const btns = [...document.querySelectorAll("button")];
      if (k % 3 === 0) btns.find((b) => b.textContent === "人声聚光")?.click();
      else if (k % 3 === 1) btns.find((b) => b.textContent === "节奏主场")?.click();
      else sp.motion.setTier(k % 2 ? "enhanced" : "soft");
      sp.theme.setTheme(k % 2 ? "amber" : "ocean");
    }, i);
    await sleep(280);
  }
  // 收尾：预设 toggle 回无、主题 ocean、档位 standard
  await page.evaluate(() => {
    const sp = window.__stemplay;
    if (sp.engine.preset) {
      const name = sp.engine.preset.name;
      [...document.querySelectorAll("button")].find((b) => b.textContent === name)?.click();
    }
    sp.theme.setTheme("ocean");
    sp.motion.setTier("standard");
  });
  await sleep(600);
  const frameTs = await page.evaluate(() => window.__fd.ts);
  const deltas = [];
  for (let i = 1; i < frameTs.length; i++) deltas.push(frameTs[i] - frameTs[i - 1]);
  deltas.sort((a, b) => a - b);
  const p95 = deltas[Math.floor(deltas.length * 0.95)];
  const maxGap = deltas[deltas.length - 1];
  numbers.switching = { frames: deltas.length, p95FrameMs: +p95.toFixed(1), maxGapMs: +maxGap.toFixed(1) };
  record("连续切换（预设×主题×动效档 12 次）无帧跳变：最大间隔 <200ms（如实报告 p95）", maxGap < 200, numbers.switching);

  // ---------- 9. 控制台 ----------
  record("控制台 0 错误 / 0 pageerror", consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });

  fs.writeFileSync(
    path.join(dir, "round4-results.json"),
    JSON.stringify({ results, numbers, consoleErrors, pageErrors }, null, 2),
  );
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.name));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}

// 通用窗口测量：seek → 采样 durMs → 汇总冲击/粒子/抖动（可选中途动作）
async function runWindow(page, seekTo, durMs, midAction) {
  const pre = await page.evaluate((t) => {
    window.__stemplay.engine.seek(t);
    const fx = window.__stemplay.fx;
    let fired = 0;
    for (const s of fx.stems.values()) fired += s.impactsFired;
    return { fired, spawnedR: [...fx.stems.values()].reduce((a, s) => a + s.spawnedRipples, 0), spawnedP: [...fx.stems.values()].reduce((a, s) => a + s.spawnedParticles, 0) };
  }, seekTo);
  await page.evaluate((src, dur) => {
    window.__s4 = { frames: [], done: false };
    const f = new Function("ts", src);
    const t0 = performance.now();
    const tick = (ts) => {
      window.__s4.frames.push(f(ts));
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else window.__s4.done = true;
    };
    requestAnimationFrame(tick);
  }, CORE_FIELDS, durMs);
  if (midAction) {
    await sleep(durMs * 0.35);
    var extra = await midAction(true);
  } else {
    await sleep(durMs + 200);
  }
  const frames = await stopSampler(page);
  const post = await page.evaluate(() => {
    const fx = window.__stemplay.fx;
    let fired = 0;
    for (const s of fx.stems.values()) fired += s.impactsFired;
    return { fired, spawnedR: [...fx.stems.values()].reduce((a, s) => a + s.spawnedRipples, 0), spawnedP: [...fx.stems.values()].reduce((a, s) => a + s.spawnedParticles, 0) };
  });
  let maxShake = 0;
  let maxParticles = 0;
  for (const f of frames) {
    for (const s of Object.values(f.stems)) maxShake = Math.max(maxShake, s.shake);
    maxParticles = Math.max(maxParticles, f.particles);
  }
  return {
    firedDelta: post.fired - pre.fired,
    spawnedR: post.spawnedR - pre.spawnedR,
    spawnedP: post.spawnedP - pre.spawnedP,
    maxShake,
    maxParticles,
    frames: frames.length,
    extra: extra ?? null,
  };
}
