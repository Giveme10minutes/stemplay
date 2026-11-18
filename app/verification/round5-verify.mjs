// 第 5 轮验收：导入与曲库。
// 1) 复制 dev release 到系统临时目录模拟用户资源包（只读 ../build/test_song，只写 temp）
// 2) 真实点击打开导入面板 → webkitdirectory 回退输入 + 页内 DataTransfer 注入 → 切到 pack 源、
//    真实按钮播放、六叠加层动画、控制台 0 错
// 3) 刷新 → 曲库列出条目（trackTitle/大小）→ 点载入 → IDB 恢复 → pack 源可播放
// 4) 损坏 manifest 的包 → 错误文案 + 重试按钮 + 无部分状态
// 5) 删除曲库条目 → IDB pack 键清零 → 刷新后 dev/URL 源正常
// 6) 提取主题素材 与 替换歌曲 状态行分离，第 2 轮消息字符串不变
// 运行：cd app && node verification/round5-verify.mjs （需先 npm run dev）
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "../..");
const buildRoot = path.join(repoRoot, "build/test_song");
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

// ---------- 1. 准备临时资源包（读 repo build，写系统 temp） ----------
const current = JSON.parse(fs.readFileSync(path.join(buildRoot, "current.json"), "utf8"));
const releaseRel = current.release.endsWith("/") ? current.release.slice(0, -1) : current.release;
const releaseDir = path.join(buildRoot, releaseRel);
const rand = Math.random().toString(36).slice(2, 8);
const packDir = path.join(os.tmpdir(), `stemplay-pack-${rand}`);
const badDir = path.join(os.tmpdir(), `stemplay-pack-bad-${rand}`);
fs.cpSync(releaseDir, packDir, { recursive: true });
fs.cpSync(releaseDir, badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, "manifest.json"), "{ 这不是合法 JSON ]");

// 期望值从实际 manifest 派生（不硬编码，随后端 config/版本变化自动跟随）
const packManifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
const expectedTitle = packManifest.track.title;
const manifestArtwork = packManifest.track.artwork; // v0.7.0 起可能为 {status:"missing",...} 或缺省

function walkRel(root) {
  const out = [];
  (function rec(d, prefix) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) rec(path.join(d, e.name), `${rel}/`);
      else out.push(rel);
    }
  })(root, "");
  return out;
}
const packFiles = walkRel(packDir);
const badFiles = walkRel(badDir);
const packBytes = packFiles.reduce((a, rel) => a + fs.statSync(path.join(packDir, rel)).size, 0);
numbers.pack = { release: releaseRel, tempDir: packDir, files: packFiles.length, bytes: packBytes };

// 临时静态服务器（带 CORS）：把 temp 包文件喂给页面内 DataTransfer，不落任何仓库路径
function startHelper(root) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const rel = decodeURIComponent(new globalThis.URL(req.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
    const fp = path.join(root, rel);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader("Content-Type", "application/octet-stream");
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function injectPack(page, server, fileList, topFolder) {
  const port = server.address().port;
  await page.evaluate(
    async ({ port, fileList, topFolder }) => {
      const dt = new DataTransfer();
      for (const rel of fileList) {
        const r = await fetch(`http://127.0.0.1:${port}/${rel.split("/").map(encodeURIComponent).join("/")}`);
        if (!r.ok) throw new Error(`helper 404: ${rel}`);
        const blob = await r.blob();
        const f = new File([blob], rel.split("/").pop(), { type: "application/octet-stream" });
        Object.defineProperty(f, "webkitRelativePath", { value: `${topFolder}/${rel}` });
        dt.items.add(f);
      }
      const input = document.querySelector('[data-testid="pack-dir-input"]');
      if (!input) throw new Error("pack-dir-input 不存在");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { port, fileList, topFolder },
  );
}

async function openPanel(page) {
  await page.evaluate(() => document.querySelector('[data-testid="open-import"]')?.click());
  await page.waitForSelector('[data-testid="import-panel"]', { timeout: 10000 });
}
async function closePanel(page) {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[data-testid="import-panel"]'), { timeout: 10000 });
}
const packStatusText = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="pack-status"]')?.textContent ?? "");
const themeStatusText = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="theme-status"]')?.textContent ?? "");

async function sampleOverlays(page) {
  return page.evaluate(() => {
    const out = {};
    for (const c of document.querySelectorAll("canvas[data-fx]")) {
      if (!c.width || !c.height) { out[c.dataset.fx] = -1; continue; }
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 8) n++;
      out[c.dataset.fx] = n;
    }
    return out;
  });
}

const validServer = await startHelper(packDir);
const badServer = await startHelper(badDir);

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

  // ---------- 2. 初始 URL 源 + 导入资源包 ----------
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(400);
  const initial = await page.evaluate(() => ({
    kind: window.__stemplay.resources.source.kind,
    label: window.__stemplay.resources.source.label,
    importBtnDisabled: [...document.querySelectorAll("button")].find((b) => b.textContent === "导入")?.disabled ?? null,
    artwork: window.__stemplay.resources.artwork,
    artist: window.__stemplay.resources.artist,
    album: window.__stemplay.resources.album,
  }));
  // artwork 缺失有两种如实形态：旧包无字段→null；v0.7.0 有字段但 status=missing→{status,url:null}
  const artworkOk =
    initial.artwork === null ||
    (initial.artwork && initial.artwork.status === "missing" && initial.artwork.url === null);
  record(
    "初始为 URL 源（本地构建），导入按钮已启用，可选 artwork/artist/album 缺失时如实降级（null 或 status=missing）",
    initial.kind === "url" && initial.label === "本地构建" && initial.importBtnDisabled === false &&
      artworkOk && initial.artist === null && initial.album === null,
    initial,
  );

  await openPanel(page);
  const topFolder = path.basename(packDir);
  const t0 = Date.now();
  await injectPack(page, validServer, packFiles, topFolder);
  await page.waitForFunction(() => window.__stemplay?.resources?.source?.kind === "pack", { timeout: 90000 });
  await page.waitForFunction(() => window.__stemplay.library.list().length === 1, { timeout: 60000 }); // IDB 写入 ~11MB
  const packLoadMs = Date.now() - t0;
  const packInfo = await page.evaluate(() => ({
    kind: window.__stemplay.resources.source.kind,
    label: window.__stemplay.resources.source.label,
    tracks: window.__stemplay.resources.tracks.map((t) => t.id),
    duration: window.__stemplay.resources.durationSec,
    lib: window.__stemplay.library.list(),
    selectedId: window.__stemplay.library.state().selectedId,
  }));
  numbers.packLoadMs = packLoadMs;
  numbers.packEntry = packInfo.lib[0] ?? null;
  record(
    "注入临时目录资源包 → 切换到 pack 源（label=顶层文件夹名，六轨齐全）",
    packInfo.kind === "pack" && packInfo.label === topFolder && packInfo.tracks.length === 6 && packInfo.duration > 39,
    { ...packInfo, packLoadMs },
  );
  record(
    "曲库条目已写入（trackTitle 来自 manifest，sizeBytes 与 temp 包一致，selectedId 指向该条目）",
    packInfo.lib.length === 1 && packInfo.lib[0].trackTitle === expectedTitle &&
      packInfo.lib[0].sizeBytes === packBytes && packInfo.selectedId === packInfo.lib[0].id,
    { ...numbers.packEntry, expectedTitle },
  );
  await closePanel(page);

  // 真实按钮播放 + 六叠加层动画（逐轨定位到离线特征峰值窗口；静音轨如实单列）
  const STEM_IDS = ["vocals", "drums", "bass", "guitar", "piano", "other"];
  const feats = {};
  for (const id of STEM_IDS) {
    const f = JSON.parse(fs.readFileSync(path.join(packDir, "preview", "features", `${id}.json`), "utf8"));
    const rms = f.arrays.rms;
    const th = f.display.silenceThreshold;
    let bi = 0;
    for (let i = 0; i < rms.length; i++) if (rms[i] > rms[bi]) bi = i;
    feats[id] = { peakT: bi / f.frameRate, peakRms: rms[bi], audible: rms.some((v) => v >= th) };
  }
  numbers.stemFeatures = feats;
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(500);
  const pos1 = await page.evaluate(() => window.__stemplay.engine.position());
  const perStemLit = {};
  for (const id of STEM_IDS) {
    await page.evaluate((t) => window.__stemplay.engine.seek(t), Math.max(0, feats[id].peakT - 0.5));
    await sleep(700);
    const s = await sampleOverlays(page);
    perStemLit[id] = s[id] ?? null;
  }
  // 动画性：drums 峰值窗口 400ms 间隔两次采样，总亮像素应变化
  await page.evaluate((t) => window.__stemplay.engine.seek(t), feats.drums.peakT - 0.5);
  await sleep(400);
  const sA = await sampleOverlays(page);
  await sleep(400);
  const sB = await sampleOverlays(page);
  const totalA = Object.values(sA).reduce((a, b) => a + b, 0);
  const totalB = Object.values(sB).reduce((a, b) => a + b, 0);
  const pos2 = await page.evaluate(() => window.__stemplay.engine.position());
  const silentStems = STEM_IDS.filter((id) => !feats[id].audible);
  const audibleStems = STEM_IDS.filter((id) => feats[id].audible);
  const silentOk = await page.evaluate(
    (ids) =>
      ids.every((id) => {
        const c = document.querySelector(`canvas[data-fx="${id}"]`);
        const st = window.__stemplay.fx.stems.get(id);
        return c != null && c.width > 0 && c.height > 0 && st != null && st.gv > 0;
      }),
    silentStems,
  );
  numbers.overlays = {
    canvases: Object.keys(sA).length,
    perStemLitAtPeak: perStemLit,
    silentStems,
    animTotals: [totalA, totalB],
    pos1,
    pos2,
  };
  record(
    "pack 源真实按钮播放：位置推进，六个叠加层齐全；5 个有声轨在各自特征峰值窗口均亮起",
    pos1 > 0.3 && STEM_IDS.every((id) => perStemLit[id] !== null) &&
      audibleStems.every((id) => perStemLit[id] > 0) &&
      audibleStems.length === STEM_IDS.length - silentStems.length,
    numbers.overlays,
  );
  record(
    "叠加层逐帧动画（总亮像素随时间变化）；静音轨（piano，预览 40s 内 0/2000 帧超静音阈）叠加层在场且逐帧驱动（gv>0），如实不计亮像素",
    totalA !== totalB && silentOk && silentStems.join() === "piano",
    { animTotals: [totalA, totalB], silentStems, silentOk },
  );
  await shot(page, "round5-01-pack-loaded.png");

  // ---------- 3. 刷新 → 曲库列出 → 载入 ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(300);
  const afterReload = await page.evaluate(() => window.__stemplay.resources.source.kind);
  record("刷新后首屏仍走 URL 源（不自动读曲库 blob）", afterReload === "url", { afterReload });

  await openPanel(page);
  const entryId = packInfo.lib[0].id;
  await page.waitForSelector(`[data-testid="lib-entry-${entryId}"]`, { timeout: 10000 });
  const entryText = await page.evaluate(
    (id) => document.querySelector(`[data-testid="lib-entry-${id}"]`)?.textContent ?? "",
    entryId,
  );
  const mb = (packBytes / 1048576).toFixed(1);
  record(
    "曲库列出条目：含 trackTitle（来自 manifest）与大小（MB）",
    entryText.includes(expectedTitle) && entryText.includes(`${mb}MB`),
    { entryText, expectedTitle, expectMB: `${mb}MB` },
  );
  await shot(page, "round5-02-library.png");
  await page.evaluate((id) => document.querySelector(`[data-testid="lib-load-${id}"]`)?.click(), entryId);
  await page.waitForFunction(() => window.__stemplay?.resources?.source?.kind === "pack", { timeout: 90000 });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="pack-status"]')?.textContent ?? "").includes("已从曲库载入"),
    { timeout: 10000 },
  );
  await closePanel(page);
  await page.evaluate(() => document.querySelector('button[aria-label="播放"]')?.click());
  await sleep(600);
  const libPos = await page.evaluate(() => window.__stemplay.engine.position());
  const libState = await page.evaluate(() => ({ selectedId: window.__stemplay.library.state().selectedId }));
  record("载入（IDB 恢复）→ pack 源可播放，selectedId 更新", libPos > 0.3 && libState.selectedId === entryId, { libPos, ...libState });

  // ---------- 4. 损坏包：错误 + 重试 + 无部分状态 ----------
  const beforeBad = await page.evaluate(() => ({
    label: window.__stemplay.resources.source.label,
    tracks: window.__stemplay.resources.tracks.length,
  }));
  await openPanel(page);
  await injectPack(page, badServer, badFiles, `badpack-${rand}`);
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="pack-status"]')?.textContent ?? "").includes("不是有效 JSON"),
    { timeout: 30000 },
  );
  await sleep(300);
  const badStatus = await packStatusText(page);
  const retryPresent = await page.evaluate(() => !!document.querySelector('[data-testid="pack-retry"]'));
  const afterBad = await page.evaluate(() => ({
    label: window.__stemplay.resources.source.label,
    kind: window.__stemplay.resources.source.kind,
    tracks: window.__stemplay.resources.tracks.length,
    posWorks: Number.isFinite(window.__stemplay.engine.position()),
    libCount: window.__stemplay.library.list().length,
  }));
  numbers.badPack = { badStatus, retryPresent, afterBad };
  record(
    "损坏 manifest → 非空错误文案（指明无效 JSON）+ 重试按钮存在",
    badStatus.includes("不是有效 JSON") && retryPresent,
    { badStatus, retryPresent },
  );
  record(
    "无部分状态：当前资源/引擎/曲库均未被坏包改动",
    afterBad.label === beforeBad.label && afterBad.kind === "pack" && afterBad.tracks === 6 &&
      afterBad.posWorks && afterBad.libCount === 1,
    { beforeBad, afterBad },
  );
  await shot(page, "round5-03-import-error.png");

  // 重试按钮走已读 blobs：MutationObserver 记录状态行序列，证明重新校验而非假装成功
  await page.evaluate(() => {
    window.__r5retry = [];
    const el = document.querySelector('[data-testid="pack-status"]');
    new MutationObserver(() => window.__r5retry.push(el.textContent)).observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    document.querySelector('[data-testid="pack-retry"]')?.click();
  });
  await sleep(1500);
  const retrySeq = await page.evaluate(() => window.__r5retry);
  record(
    "重试从已读 blobs 重新校验（状态行经历校验中→同一诚实错误，不假装成功）",
    retrySeq.some((t) => t.includes("正在校验")) && retrySeq[retrySeq.length - 1].includes("不是有效 JSON"),
    { retrySeq },
  );

  // ---------- 5. 删除曲库条目 → IDB 清零 → URL 源正常 ----------
  await page.evaluate((id) => document.querySelector(`[data-testid="lib-remove-${id}"]`)?.click(), entryId);
  await page.waitForFunction(() => window.__stemplay.library.list().length === 0, { timeout: 10000 });
  const idbCount = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("stemplay", 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const keys = await new Promise((res, rej) => {
      const rq = db.transaction("blobs", "readonly").objectStore("blobs").getAllKeys();
      rq.onsuccess = () => res(rq.result.map(String));
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return { total: keys.length, packKeys: keys.filter((k) => k.startsWith("pack:")).length };
  });
  const lsAfter = await page.evaluate(() => localStorage.getItem("stemplay.library.v1"));
  record(
    "删除条目：列表清空、IDB pack:* 键为 0、LS 中 entries 为空",
    idbCount.packKeys === 0 && lsAfter != null && JSON.parse(lsAfter).entries.length === 0,
    { idbCount, lsAfter },
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__stemplay?.resources != null, { timeout: 90000 });
  await sleep(300);
  const finalSource = await page.evaluate(() => ({
    kind: window.__stemplay.resources.source.kind,
    label: window.__stemplay.resources.source.label,
    tracks: window.__stemplay.resources.tracks.length,
  }));
  record("删除后刷新：dev/URL 源正常加载（六轨）", finalSource.kind === "url" && finalSource.tracks === 6, finalSource);

  // ---------- 6. 提取主题素材：状态行分离 + 第 2 轮字符串不变 ----------
  await openPanel(page);
  const themeInput = await page.$('[data-testid="theme-audio-input"]');
  await themeInput.uploadFile(path.join(dir, "round2-no-cover.mp3"));
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="theme-status"]')?.textContent ?? "") === "该音频未内嵌封面，已保持当前主题",
    { timeout: 60000 },
  );
  await sleep(300);
  const themeText = await themeStatusText(page);
  const packText = await packStatusText(page);
  const kindAfterTheme = await page.evaluate(() => window.__stemplay.resources.source.kind);
  numbers.themeSection = { themeText, packText };
  record(
    "提取主题素材状态行与替换歌曲状态行分离，第 2 轮消息字符串不变，且不切歌",
    themeText === "该音频未内嵌封面，已保持当前主题" && packText !== themeText && kindAfterTheme === "url",
    numbers.themeSection,
  );

  // ---------- 7. 控制台 ----------
  record("控制台 0 错误 / 0 pageerror", consoleErrors.length === 0 && pageErrors.length === 0, { consoleErrors, pageErrors });

  fs.writeFileSync(path.join(dir, "round5-results.json"), JSON.stringify({ results, numbers, consoleErrors, pageErrors }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAILED:", failed.map((f) => f.name));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
  validServer.close();
  badServer.close();
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(badDir, { recursive: true, force: true });
}
