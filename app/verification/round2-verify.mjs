// 第 2 轮验收：puppeteer-core + 本机 Chrome，精确视口定量测试与截图。
// 运行：node verification/round2-verify.mjs   （需先 npm run dev）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "../..");
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
async function cssVar(page, name) {
  // 注册过的 <color> 变量计算值序列化为 rgb()，统一归一化成 hex 便于断言
  return page.evaluate((n) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const m = v.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
    if (m) {
      const h = (x) => Math.round(Number(x)).toString(16).padStart(2, "0");
      return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
    }
    return v;
  }, name);
}
async function openDrawer(page) {
  const already = await page.$('[data-testid="appearance-drawer"]');
  if (!already) {
    await page.click('[data-testid="open-appearance"]');
    await page.waitForSelector('[data-testid="appearance-drawer"]', { visible: true });
    await sleep(320);
  }
}
async function closeDrawer(page) {
  if (await page.$('[data-testid="appearance-drawer"]')) {
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="appearance-drawer"]', { hidden: true });
    await sleep(320);
  }
}
async function setColor(page, testId, hex) {
  await page.evaluate(
    (sel, h) => {
      const el = document.querySelector(sel);
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(el, h);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    `[data-testid="${testId}"]`,
    hex,
  );
}
async function setSlider(page, testId, value) {
  const sel = `[data-testid="${testId}"]`;
  await page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);
  await sleep(200);
  await page.waitForSelector(`${sel} [data-slot="slider-thumb"]`, { visible: true });
  const { min, max } = await page.evaluate((s) => {
    const t = document.querySelector(`${s} [data-slot="slider-thumb"]`);
    return { min: Number(t.getAttribute("aria-valuemin")), max: Number(t.getAttribute("aria-valuemax")) };
  }, sel);
  const track = await page.$(`${sel} [data-slot="slider-track"]`);
  const box = await track.boundingBox();
  const frac = (value - min) / (max - min);
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
  await sleep(150);
}
async function upload(page, testId, file) {
  const input = await page.$(`[data-testid="${testId}"]`);
  await input.uploadFile(file);
}
async function waitCoverStatus(page, substr, timeout = 30000) {
  await page.waitForFunction(
    (s) => document.querySelector('[data-testid="cover-status"]')?.textContent?.includes(s),
    { timeout },
    substr,
  );
}
const store = (page, fn, ...args) => page.evaluate(fn, ...args);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", "--force-color-profile=srgb"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(600);

  // 1. 默认深色
  const defMode = await store(page, () => window.__stemplay.theme.getState().mode);
  const defBg = await cssVar(page, "--background");
  const defBlur = await cssVar(page, "--glass-blur");
  record("默认深色 #0B1020 + 玻璃 blur 16-24px", defMode === "dark" && defBg === "#0b1020" && parseFloat(defBlur) >= 16 && parseFloat(defBlur) <= 24, { defMode, defBg, defBlur });
  await shot(page, "round2-01-desktop-dark.png");

  // 播放（真实手势）
  await page.click('button[aria-label="播放"]');
  await sleep(900);
  const pos1 = await store(page, () => window.__stemplay.engine.position());
  record("播放启动（回归）", pos1 > 0.3, { pos1 });

  // 2. 浅色模式
  await openDrawer(page);
  await page.click('[data-testid="mode-light"]');
  await sleep(650);
  const lightBg = await cssVar(page, "--background");
  const lightFg = await cssVar(page, "--foreground");
  const hasDarkClass = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  record("浅色模式 token", lightBg === "#eef2f8" && lightFg === "#1c2536" && !hasDarkClass, { lightBg, lightFg, hasDarkClass });
  await closeDrawer(page);
  await shot(page, "round2-02-desktop-light.png");

  // 3. 四套主题 + 自定义强调色
  await openDrawer(page);
  const accents = {};
  for (const id of ["ocean", "aurora", "amber", "mist"]) {
    await page.click(`[data-testid="theme-${id}"]`);
    await sleep(550);
    accents[id] = await cssVar(page, "--sp-accent");
  }
  const distinct = new Set(Object.values(accents)).size === 4;
  record("四套主题强调色互异", distinct, accents);
  const followSuspended = await store(page, () => window.__stemplay.theme.getState().prefs.followCover);
  record("手选主题暂停跟随封面", followSuspended === false, { followSuspended });
  await page.click('[data-testid="theme-amber"]');
  await sleep(550);
  await closeDrawer(page);
  await shot(page, "round2-03-theme-amber-light.png");
  await openDrawer(page);
  await setColor(page, "accent-input", "#ff3d81");
  await sleep(550);
  const customAccent = await cssVar(page, "--sp-accent");
  const customStored = await store(page, () => window.__stemplay.theme.getState().prefs.customAccent);
  record("自定义强调色生效", customStored === "#ff3d81" && customAccent !== accents.amber, { customAccent, customStored });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="appearance-drawer"] button')];
    btns.find((b) => b.textContent.includes("清除自定义"))?.click();
  });
  await sleep(300);

  // 4a. 纯色背景
  await page.click('[data-testid="bg-type-solid"]');
  await setColor(page, "solid-input", "#7c3aed");
  await sleep(550);
  const solidOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bg-solid"]')).opacity);
  const solidColor = await cssVar(page, "--sp-solid");
  record("纯色背景", solidOpacity === "1" && solidColor === "#7c3aed", { solidOpacity, solidColor });
  await closeDrawer(page);
  await shot(page, "round2-04-bg-solid.png");

  // 4b. 渐变：3 stop + 角度
  await openDrawer(page);
  await page.click('[data-testid="bg-type-gradient"]');
  await page.click('[data-testid="grad-add"]');
  await setColor(page, "grad-stop-0", "#0ea5e9");
  await setColor(page, "grad-stop-1", "#312e81");
  await setColor(page, "grad-stop-2", "#db2777");
  await setSlider(page, "grad-angle", 90);
  await sleep(550);
  const angle = await cssVar(page, "--sp-bg-angle");
  const gradImage = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bg-gradient"]')).backgroundImage);
  const gradColors = await store(page, () => window.__stemplay.theme.getState().prefs.bg.gradient.colors);
  record("3-stop 渐变 + 角度 90°", Math.abs(parseFloat(angle) - 90) < 1 && gradColors.length === 3 && gradImage.includes("90deg") && gradImage.includes("14, 165, 233"), { angle, gradColors, gradImage: gradImage.slice(0, 110) });
  await closeDrawer(page);
  await shot(page, "round2-05-bg-gradient.png");

  // 4c. 自定义图片（深色模式下亮/繁杂图 → 自动加深遮罩）+ 参数控制
  await openDrawer(page);
  await page.click('[data-testid="mode-dark"]');
  await sleep(550);
  const scrimBefore = Number(await cssVar(page, "--sp-scrim-alpha"));
  await page.click('[data-testid="bg-type-image"]');
  await upload(page, "image-file", path.join(dir, "round2-bright-busy.png"));
  await page.waitForSelector('[data-testid="bg-image"]', { timeout: 10000 });
  await sleep(700);
  const scrimAfter = Number(await cssVar(page, "--sp-scrim-alpha"));
  const stats = await store(page, () => window.__stemplay.theme.getState().imageStats);
  record("亮/繁杂图自动加深遮罩", scrimAfter > scrimBefore + 0.1 && stats.luminance > 0.5, { scrimBefore, scrimAfter, stats });
  await setSlider(page, "img-blur", 20);
  await setSlider(page, "img-zoom", 150);
  await setSlider(page, "img-dim", 0);
  await sleep(450);
  const scrimAutoOnly = Number(await cssVar(page, "--sp-scrim-alpha"));
  await setSlider(page, "img-dim", 60);
  await sleep(450);
  await page.click('[data-testid="img-pos-top"]');
  await sleep(400);
  const imgStyle = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="bg-image"]');
    const cs = getComputedStyle(el);
    return { filter: cs.filter, transform: cs.transform, objectPosition: cs.objectPosition, objectFit: cs.objectFit };
  });
  const scrimDim = Number(await cssVar(page, "--sp-scrim-alpha"));
  record("模糊/缩放/位置/暗化控制", imgStyle.filter.includes("blur(20px)") && imgStyle.transform.includes("1.5") && imgStyle.objectPosition === "50% 0%" && scrimDim > scrimAutoOnly + 0.05, { imgStyle, scrimAutoOnly, scrimDim });
  await setSlider(page, "img-dim", -30);
  await sleep(450);
  const brightenAlpha = Number(await cssVar(page, "--sp-brighten-alpha"));
  record("提亮（负暗化）白色叠加", Math.abs(brightenAlpha - 0.3) < 0.01, { brightenAlpha });
  await setSlider(page, "img-dim", 35);
  await page.click('[data-testid="img-fit-contain"]');
  await sleep(250);
  const fit = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bg-image"]')).objectFit);
  record("包含缩放", fit === "contain", { fit });
  await page.click('[data-testid="img-fit-cover"]');
  await setSlider(page, "img-blur", 8);
  await setSlider(page, "img-dim", 35);
  await sleep(400);
  const persisted = await store(page, () => window.__stemplay.theme.getState().customImage.persisted);
  record("自定义图片写入 IndexedDB", persisted === true, { persisted });
  await closeDrawer(page);
  await shot(page, "round2-06-bg-image.png");

  // 材质滑杆
  await openDrawer(page);
  await setSlider(page, "mat-glass", 70);
  await setSlider(page, "mat-brightness", 40);
  await setSlider(page, "mat-fx", 30);
  await sleep(400);
  const mat = await store(page, () => window.__stemplay.theme.getState().prefs.material);
  const blurFx = await cssVar(page, "--glass-blur");
  const brightnessVar = await cssVar(page, "--sp-bg-brightness");
  record("材质三滑杆", mat.glass === 70 && mat.brightness === 40 && mat.fx === 30 && Math.abs(parseFloat(blurFx) - 18.4) < 0.2 && Math.abs(Number(brightnessVar) - 0.91) < 0.01, { mat, blurFx, brightnessVar });
  await page.click('[data-testid="theme-amber"]');
  await sleep(450);

  // 5. 持久化：刷新恢复
  const prefsBefore = await store(page, () => JSON.stringify(window.__stemplay.theme.getState().prefs));
  await closeDrawer(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await page.waitForSelector('[data-testid="bg-image"]', { timeout: 10000 });
  await sleep(800);
  const prefsAfter = await store(page, () => JSON.stringify(window.__stemplay.theme.getState().prefs));
  const lsRaw = await page.evaluate(() => localStorage.getItem("stemplay.appearance.v1"));
  const imgSrcAfter = await page.evaluate(() => document.querySelector('[data-testid="bg-image"]')?.src ?? "");
  const blurAfter = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="bg-image"]')).filter);
  record("刷新恢复全部偏好 + IndexedDB 图片", prefsBefore === prefsAfter && lsRaw.includes('"v":1') && imgSrcAfter.startsWith("blob:") && blurAfter.includes("blur(8px)"), { samePrefs: prefsBefore === prefsAfter, imgSrcAfter: imgSrcAfter.slice(0, 40), blurAfter });
  await shot(page, "round2-07-after-reload.png");

  // 损坏 JSON 兜底
  await page.evaluate(() => localStorage.setItem("stemplay.appearance.v1", "{corrupt!!"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(500);
  const fallbackTheme = await store(page, () => window.__stemplay.theme.getState().prefs.theme);
  record("损坏 JSON 回退默认", fallbackTheme === "ocean", { fallbackTheme });

  // 6. palette.ts 单元测试（合成封面走同一提取函数）
  const paletteTests = await page.evaluate(async () => {
    const mod = await import("/src/lib/palette.ts");
    const mk = (paint) => {
      const c = document.createElement("canvas");
      c.width = 200; c.height = 200;
      const g = c.getContext("2d");
      paint(g);
      return c;
    };
    const color = mk((g) => {
      g.fillStyle = "#f97316"; g.fillRect(0, 0, 200, 100);
      g.fillStyle = "#14b8a6"; g.fillRect(0, 100, 120, 100);
      g.fillStyle = "#6d28d9"; g.fillRect(120, 100, 80, 100);
    });
    const gray = mk((g) => {
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, 200, 100);
      g.fillStyle = "#111111"; g.fillRect(0, 100, 200, 100);
    });
    const p = mod.extractPalette(color, 200, 200);
    const g = mod.extractPalette(gray, 200, 200);
    const empty = mod.extractPalette(color, 0, 0);
    const dark = p ? mod.correctAccent(p.accent, "dark") : null;
    const light = p ? mod.correctAccent(p.accent, "light") : null;
    const contrastDark = dark ? mod.contrastRatio(dark, "#0b1020") : 0;
    const contrastLight = light ? mod.contrastRatio(light, "#eef2f8") : 0;
    return { p, grayIsNull: g === null, emptyIsNull: empty === null, contrastDark, contrastLight };
  });
  record("合成封面取色 + 黑白/空图兜底 + 对比校正", paletteTests.p !== null && paletteTests.grayIsNull && paletteTests.emptyIsNull && paletteTests.contrastDark >= 3 && paletteTests.contrastLight >= 3, paletteTests);

  // 7. music-metadata 真实路径
  await openDrawer(page);
  await upload(page, "cover-file", path.join(dir, "round2-no-cover.mp3"));
  await waitCoverStatus(page, "未内嵌封面");
  record("无封面 → 诚实提示并保持主题", true, await page.evaluate(() => document.querySelector('[data-testid="cover-status"]').textContent));

  await upload(page, "cover-file", path.join(dir, "round2-cover.png")); // 非音频/损坏输入
  await waitCoverStatus(page, "封面解析失败");
  record("损坏/非音频输入 → 兜底不崩溃", true, await page.evaluate(() => document.querySelector('[data-testid="cover-status"]').textContent));

  // 真实曲目 flac（只读喂给文件输入）
  const flacPath = path.join(repoRoot, "music-src", "test_song.flac");
  let flacResult = "未测试";
  if (fs.existsSync(flacPath)) {
    await upload(page, "cover-file", flacPath);
    try {
      await page.waitForFunction(
        () => {
          const s = window.__stemplay.theme.getState().cover.status;
          return s === "ready" || s === "missing" || s === "error";
        },
        { timeout: 120000 },
      );
      const c = await store(page, () => {
        const s = window.__stemplay.theme.getState();
        return { status: s.cover.status, message: s.cover.message, hasPalette: !!s.palette };
      });
      flacResult = c;
      record("真实 test_song.flac 封面读取", c.status !== "error", c);
    } catch {
      flacResult = "超时";
      record("真实 test_song.flac 封面读取", false, "超时");
    }
  }

  await upload(page, "cover-file", path.join(dir, "round2-with-cover.mp3"));
  await waitCoverStatus(page, "已提取封面配色");
  const coverState = await store(page, () => {
    const s = window.__stemplay.theme.getState();
    return { status: s.cover.status, palette: s.palette, url: (s.cover.url ?? "").slice(0, 20) };
  });
  record("内嵌 front cover 提取成功", coverState.status === "ready" && coverState.palette !== null, coverState);

  // 先手选主题（暂停跟随），再重新开启 → 强调色应由封面驱动
  await store(page, () => window.__stemplay.theme.setTheme("mist"));
  await sleep(600);
  const accentBeforeFollow = await cssVar(page, "--sp-accent");
  await page.click('[data-testid="follow-cover"]');
  await sleep(650);
  const accentAfterFollow = await cssVar(page, "--sp-accent");
  const followOn = await store(page, () => window.__stemplay.theme.getState().prefs.followCover);
  record("重新开启跟随封面 → 强调色由封面驱动", followOn === true && accentBeforeFollow !== accentAfterFollow, { accentBeforeFollow, accentAfterFollow, followOn });
  await shot(page, "round2-08-cover-drawer.png");

  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="appearance-drawer"] button')];
    btns.find((b) => b.textContent.trim() === "用作背景")?.click();
  });
  await sleep(600);
  const coverBg = await store(page, () => {
    const s = window.__stemplay.theme.getState();
    const el = document.querySelector('[data-testid="bg-image"]');
    return { type: s.prefs.bg.type, srcIsCover: el?.src === s.cover.url };
  });
  record("封面用作背景", coverBg.type === "cover" && coverBg.srcIsCover, coverBg);
  await closeDrawer(page);
  await shot(page, "round2-09-cover-bg.png");

  // 8. 跟随系统
  await openDrawer(page);
  await page.click('[data-testid="mode-system"]');
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await sleep(600);
  const sysLight = await store(page, () => window.__stemplay.theme.getState().mode);
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  await sleep(600);
  const sysDark = await store(page, () => window.__stemplay.theme.getState().mode);
  record("跟随系统实时切换", sysLight === "light" && sysDark === "dark", { sysLight, sysDark });
  await page.emulateMediaFeatures([]);

  // 9. 恢复默认
  await page.click('[data-testid="reset-all"]');
  await sleep(500);
  const resetState = await store(page, () => {
    const s = window.__stemplay.theme.getState();
    return { prefs: s.prefs, defaults: window.__stemplay.theme.DEFAULT_PREFS, toast: s.toast?.text ?? "" };
  });
  record("恢复默认三组偏好", JSON.stringify(resetState.prefs) === JSON.stringify(resetState.defaults) && resetState.toast.includes("恢复默认"), { toast: resetState.toast });

  // 10. 快速连续切换：过渡可中断、不排队
  await page.evaluate(() => {
    window.__samples = [];
    window.__sampler = setInterval(() => {
      window.__samples.push(getComputedStyle(document.documentElement).getPropertyValue("--sp-accent").trim());
    }, 40);
  });
  for (const id of ["aurora", "amber", "mist", "ocean"]) {
    await store(page, (t) => window.__stemplay.theme.setTheme(t), id);
    await sleep(80);
  }
  await sleep(1100);
  const samples = await page.evaluate(() => {
    clearInterval(window.__sampler);
    return window.__samples;
  });
  const parseC = (s) => {
    const m = s.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [0, 0, 0];
  };
  let maxDelta = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = parseC(samples[i - 1]);
    const b = parseC(samples[i]);
    maxDelta = Math.max(maxDelta, Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
  }
  const tail = samples.slice(-8);
  const settled = tail.every((v) => v === tail[0]);
  const distinctSamples = new Set(samples).size;
  record("快速切换可中断/续接/不排队", maxDelta < 150 && settled && distinctSamples > 5, { maxDelta, settled, distinctSamples, n: samples.length });
  fs.writeFileSync(path.join(dir, "round2-transition-samples.json"), JSON.stringify({ samples, maxDelta, settled }, null, 2));

  // 11. 抽屉 a11y：Esc + 焦点陷阱
  await closeDrawer(page);
  await openDrawer(page);
  let trapped = true;
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const sheet = document.querySelector('[data-slot="sheet-content"]');
      return sheet ? sheet.contains(document.activeElement) : false;
    });
    if (!inside) trapped = false;
  }
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="appearance-drawer"]', { hidden: true });
  const escClosed = !(await page.$('[data-testid="appearance-drawer"]'));
  record("Esc 关闭 + 焦点陷阱", trapped && escClosed, { trapped, escClosed });

  // 12. 锁定背景不受“切歌/重置资源”影响（doLoad 重跑）
  await openDrawer(page);
  await page.click('[data-testid="bg-type-solid"]');
  await sleep(300);
  await closeDrawer(page);
  await page.evaluate(() => window.__stemplay.engine.seek(0));
  const lockedType = await store(page, () => window.__stemplay.theme.getState().prefs.bg.type);
  record("用户锁定背景在 seek 后保持", lockedType === "solid", { lockedType });

  // 13. Round 1 回归：seek/solo/preset/键盘
  await page.click('button[aria-label="播放"]').catch(() => {});
  const playingNow = await store(page, () => window.__stemplay.engine.playing);
  if (!playingNow) await page.click('button[aria-label="播放"]');
  await store(page, () => window.__stemplay.engine.seek(37));
  await sleep(400);
  const pos37 = await store(page, () => window.__stemplay.engine.position());
  record("seek 37s 继续播放（回归）", Math.abs(pos37 - 37) < 0.6, { pos37 });
  await page.click('button[aria-label="人声 独奏"]');
  await sleep(250);
  const soloGains = await store(page, () => {
    const e = window.__stemplay.engine;
    return Object.fromEntries(e.tracks.map((t) => [t.id, Number(e.effectiveGain(t.id).toFixed(3))]));
  });
  record("Solo 人声（回归）", soloGains.vocals > 0.9 && soloGains.drums === 0, soloGains);
  await page.click('button[aria-label="人声 独奏"]');
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const p = btns.find((b) => b.textContent.includes("人声聚光") || b.textContent.includes("节奏") || b.textContent.includes("合奏"));
    p?.click();
  });
  await sleep(400);
  const presetActive = await store(page, () => window.__stemplay.engine.preset?.id ?? null);
  record("混音预设（回归）", presetActive !== null, { presetActive });
  // 焦点离开按钮（Space 在按钮上是原生激活，属第 1 轮既定行为）
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Space");
  await sleep(200);
  const afterSpace = await store(page, () => window.__stemplay.engine.playing);
  await page.keyboard.press("Space");
  await sleep(200);
  const afterSpace2 = await store(page, () => window.__stemplay.engine.playing);
  await page.keyboard.press("ArrowRight");
  await sleep(200);
  const posArrow = await store(page, () => window.__stemplay.engine.position());
  record("键盘 Space/→（回归）", afterSpace !== afterSpace2 && posArrow > 37.5, { afterSpace, afterSpace2, posArrow });
  await shot(page, "round2-10-desktop-playing-final.png");

  // 14. 移动端 390×844（先恢复默认，截图展示默认深色舞台）
  await store(page, () => window.__stemplay.theme.resetAll());
  await sleep(500);
  const mobile = await browser.newPage();
  mobile.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push("[mobile] " + m.text());
  });
  mobile.on("pageerror", (e) => pageErrors.push("[mobile] " + String(e)));
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mobile.goto(URL, { waitUntil: "domcontentloaded" });
  await mobile.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(600);
  await shot(mobile, "round2-11-mobile-main.png");
  await mobile.click('[data-testid="open-appearance"]');
  await mobile.waitForSelector('[data-testid="appearance-drawer"]', { visible: true });
  await sleep(350);
  const sheetInfo = await mobile.evaluate(() => {
    const el = document.querySelector('[data-slot="sheet-content"]');
    const r = el.getBoundingClientRect();
    const small = [...el.querySelectorAll("button")].filter((b) => {
      const br = b.getBoundingClientRect();
      return br.height > 0 && br.height < 44;
    }).map((b) => ({ text: b.textContent.trim().slice(0, 12), h: b.getBoundingClientRect().height }));
    return { side: el.getAttribute("data-side"), w: r.width, bottom: r.bottom, small };
  });
  record("移动底部面板 + 触控热区≥44px", sheetInfo.side === "bottom" && Math.abs(sheetInfo.w - 390) < 2 && Math.abs(sheetInfo.bottom - 844) < 2 && sheetInfo.small.length === 0, sheetInfo);
  await shot(mobile, "round2-12-mobile-drawer.png");
  await mobile.keyboard.press("Escape");
  await mobile.waitForSelector('[data-testid="appearance-drawer"]', { hidden: true });
  await mobile.click('button[aria-label="播放"]');
  await sleep(800);
  const mPos = await mobile.evaluate(() => window.__stemplay.engine.position());
  record("移动播放（回归）", mPos > 0.3, { mPos });
  await mobile.close();

  // 15. 控制台
  record("控制台 0 错误 / 0 pageerror", consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });

  fs.writeFileSync(
    path.join(dir, "round2-results.json"),
    JSON.stringify({ results, consoleErrors, pageErrors, flacResult, accents, transition: { maxDelta, settled, distinctSamples } }, null, 2),
  );
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.name));
} finally {
  await browser.close();
}