import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

// 线上曲库 = public/resources/：构建产物自带，线上与本地读同一份，不需要后端。
// public/resources/tracks/<id>/ 各放一份 pipeline 发布包；静态托管不能列目录，
// 所以构建时扫描生成 catalog.json，开发时按请求现扫（放进新目录后刷新即出现）。
// STEMPLAY_RESOURCES=<构建目录> 仅用于本地评估未公开的曲目：单首包，歌单按 current.json 现合成。
const configDir = path.dirname(fileURLToPath(import.meta.url));
const publicResources = path.resolve(configDir, "public/resources");
const overrideRoot = process.env.STEMPLAY_RESOURCES
  ? path.resolve(configDir, process.env.STEMPLAY_RESOURCES)
  : null;

const MIME: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function scanTracks() {
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(path.join(publicResources, "tracks"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const dir = path.join(publicResources, "tracks", id);
      const missing: string[] = [];
      let title = id;
      let artist: string | null = null;
      try {
        const manifest = readJson(path.join(dir, "manifest.json"));
        title = manifest.track?.title || id;
        artist = manifest.track?.artist ?? null;
        const preview = readJson(path.join(dir, "preview/preview.json"));
        for (const [stemId, stem] of Object.entries<any>(preview.stems ?? {})) {
          for (const rel of [`preview/features/${stemId}.json`, `preview/${stem.path}`]) {
            if (!fs.existsSync(path.join(dir, rel))) missing.push(rel);
          }
        }
      } catch {
        missing.push("manifest.json 或 preview/preview.json 缺失/损坏");
      }
      return { id, title, artist, path: `tracks/${id}/`, status: missing.length ? "incomplete" : "ready", missing };
    });
}

function buildCatalog() {
  return { schemaVersion: 1, tracks: scanTracks() };
}

function writeCatalogIfChanged() {
  const file = path.join(publicResources, "catalog.json");
  const text = JSON.stringify(buildCatalog(), null, 2);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === text) return;
  fs.mkdirSync(publicResources, { recursive: true });
  fs.writeFileSync(file, text);
}

function overrideCatalog(root: string) {
  const current = readJson(path.join(root, "current.json"));
  const rel = current.release.endsWith("/") ? current.release : `${current.release}/`;
  const track = readJson(path.join(root, rel, "manifest.json")).track;
  return {
    schemaVersion: 1,
    tracks: [{ id: track.id, title: track.title, artist: track.artist ?? null, path: rel, status: "ready", missing: [] }],
  };
}

function stemplayResources(): Plugin {
  let command = "serve";
  return {
    name: "stemplay-resources",
    configResolved(config) {
      command = config.command;
    },
    buildStart() {
      if (command === "build") writeCatalogIfChanged();
    },
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const isCatalog = url.pathname === "/resources/catalog.json";
        if (isCatalog) {
          if (!overrideRoot) return sendJson(res, 200, buildCatalog());
          try {
            return sendJson(res, 200, overrideCatalog(overrideRoot));
          } catch {
            return sendJson(res, 503, {
              error: "本地资源未构建",
              hint: "请先在仓库根目录运行 pipeline build（见 pipeline/README.md）",
            });
          }
        }
        if (!overrideRoot || !url.pathname.startsWith("/resources/")) return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { error: "仅支持 GET" });
        }
        let rel: string;
        try {
          rel = decodeURIComponent(url.pathname.slice("/resources/".length));
        } catch {
          return sendJson(res, 400, { error: "非法路径" });
        }
        const filePath = path.resolve(overrideRoot, rel);
        if (filePath !== overrideRoot && !filePath.startsWith(overrideRoot + path.sep)) {
          return sendJson(res, 403, { error: "禁止访问资源目录之外的路径" });
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          return sendJson(res, 404, { error: `资源不存在: ${rel}` });
        }
        if (!stat.isFile()) return sendJson(res, 404, { error: `资源不存在: ${rel}` });

        const mime = MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
        res.setHeader("Content-Type", mime);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Cache-Control", "no-cache");

        const range = req.headers.range;
        const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
        if (m && (m[1] !== "" || m[2] !== "")) {
          let start: number;
          let end: number;
          if (m[1] === "") {
            start = Math.max(0, stat.size - Number(m[2]));
            end = stat.size - 1;
          } else {
            start = Number(m[1]);
            end = m[2] === "" ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1);
          }
          if (start >= stat.size || start > end) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${stat.size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          res.setHeader("Content-Length", String(end - start + 1));
          if (req.method === "HEAD") return res.end();
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Length", String(stat.size));
        if (req.method === "HEAD") return res.end();
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stemplayResources()],
  resolve: {
    alias: { "@": path.resolve(configDir, "src") },
  },
  server: { port: 5173 },
});
