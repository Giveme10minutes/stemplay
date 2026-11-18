import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const resourceRoot = path.resolve(configDir, "../build/test_song");

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

function stemplayResources(): Plugin {
  return {
    name: "stemplay-local-resources",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/resources/")) return next();
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { error: "仅支持 GET" });
        }
        let rel: string;
        try {
          rel = decodeURIComponent(url.pathname.slice("/resources/".length));
        } catch {
          return sendJson(res, 400, { error: "非法路径" });
        }
        const filePath = path.resolve(resourceRoot, rel);
        if (filePath !== resourceRoot && !filePath.startsWith(resourceRoot + path.sep)) {
          return sendJson(res, 403, { error: "禁止访问资源目录之外的路径" });
        }
        if (rel === "current.json" && !fs.existsSync(filePath)) {
          return sendJson(res, 503, {
            error: "本地资源未构建",
            hint: "请先在仓库根目录运行 pipeline build（见 pipeline/README.md）",
          });
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
        res.setHeader("Cache-Control", rel === "current.json" ? "no-store" : "no-cache");

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