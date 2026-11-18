// 生成第 2 轮验证素材（纯 Node，无第三方依赖）：
// 1) round2-bright-busy.png  高亮度繁杂背景图（触发自动遮罩）
// 2) round2-cover.png       饱和色封面（median-cut 可取色）
// 3) round2-with-cover.mp3  ID3v2.3 APIC 内嵌 front cover 的最小 MP3
// 4) round2-no-cover.mp3    无封面 MP3（missing 兜底路径）
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// 1) 亮且繁杂：40px 色块随机亮色
{
  const w = 800, h = 600;
  const rgba = Buffer.alloc(w * h * 4);
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let by = 0; by < h / 40; by++) {
    for (let bx = 0; bx < w / 40; bx++) {
      const r = 160 + Math.floor(rnd() * 96);
      const g = 160 + Math.floor(rnd() * 96);
      const b = 160 + Math.floor(rnd() * 96);
      for (let y = by * 40; y < (by + 1) * 40; y++) {
        for (let x = bx * 40; x < (bx + 1) * 40; x++) {
          const i = (y * w + x) * 4;
          rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
        }
      }
    }
  }
  fs.writeFileSync(path.join(dir, "round2-bright-busy.png"), encodePNG(w, h, rgba));
}

// 2) 封面：橙 50% / 青 30% / 紫 20% 大色块 + 黄色细条
const coverPng = (() => {
  const w = 320, h = 320;
  const rgba = Buffer.alloc(w * h * 4);
  const regions = [
    [0, 0, 320, 160, "#f97316"],
    [0, 160, 192, 320, "#14b8a6"],
    [192, 160, 320, 320, "#6d28d9"],
    [0, 150, 320, 162, "#facc15"],
  ];
  for (const [x0, y0, x1, y1, hex] of regions) {
    const [r, g, b] = hexRgb(hex);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
      }
    }
  }
  return encodePNG(w, h, rgba);
})();
fs.writeFileSync(path.join(dir, "round2-cover.png"), coverPng);

// MPEG1 Layer3 128kbps 44.1kHz 静音帧（417B/帧）
function silentFrames(n) {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x00;
  return Buffer.concat(Array.from({ length: n }, () => frame));
}
function syncsafe(n) {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}
function id3Tag(frames) {
  const body = Buffer.concat(frames);
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0]), syncsafe(body.length), body]);
}
function id3Frame(id, payload) {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from(id, "ascii"), size, Buffer.from([0, 0]), payload]);
}

// 3) 带 front cover 的 MP3
{
  const apic = Buffer.concat([
    Buffer.from([0]), // text encoding latin1
    Buffer.from("image/png\0"),
    Buffer.from([3]), // front cover
    Buffer.from("\0"), // description
    coverPng,
  ]);
  const tit2 = id3Frame("TIT2", Buffer.concat([Buffer.from([0]), Buffer.from("Round2 Cover Test")]));
  const tag = id3Tag([tit2, id3Frame("APIC", apic)]);
  fs.writeFileSync(path.join(dir, "round2-with-cover.mp3"), Buffer.concat([tag, silentFrames(24)]));
}
// 4) 无封面 MP3
{
  const tit2 = id3Frame("TIT2", Buffer.concat([Buffer.from([0]), Buffer.from("Round2 No Cover")]));
  fs.writeFileSync(path.join(dir, "round2-no-cover.mp3"), Buffer.concat([id3Tag([tit2]), silentFrames(24)]));
}
console.log("assets written:", fs.readdirSync(dir).filter((f) => f.startsWith("round2-")));