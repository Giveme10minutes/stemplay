export interface Mount {
  status: string;
  path: string | null;
}

export interface ArtworkMount {
  status: "ready" | "missing" | "error";
  path: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  sha256: string | null;
}

export interface Manifest {
  schemaVersion: number;
  track: {
    id: string;
    title: string;
    artist?: string | null;
    album?: string | null;
    artwork?: ArtworkMount | null;
    originSec: number;
    durationSec: number;
    sampleRate: number;
    channels: number;
    stems: { id: string }[];
  };
  resources: {
    beats: Mount;
    presets: Mount;
    preview: Mount;
  };
}

export interface PreviewStem {
  path: string;
  delayStatus: "measured" | "uncertain" | "silent";
  delaySec: number | null;
  contentDurationSec: number;
}

export interface Preview {
  originSec: number;
  durationSec: number;
  stems: Record<string, PreviewStem>;
}

export interface FeatureDisplay {
  rmsRef: number;
  bandRef: number;
  onsetRef: number;
  silenceThreshold: number;
}

export interface Features {
  frameRate: number;
  nFrames: number;
  originSec: number;
  display: FeatureDisplay;
  arrays: {
    rms: number[];
    low: number[];
    mid: number[];
    high: number[];
    onset: number[];
    peakMin: number[];
    peakMax: number[];
  };
}

export interface Beats {
  beatsSec: number[];
  bpm: number;
  periodSec: number;
  snapEnabled: boolean;
}

export interface Preset {
  id: string;
  name: string;
  gains: Record<string, number>;
  transitionSec: number;
}

export interface TrackInfo {
  id: string;
  label: string;
  color: string;
  delayStatus: PreviewStem["delayStatus"];
  delaySec: number;
  features: Features;
}

export interface ArtworkInfo {
  status: "ready" | "missing" | "error";
  url: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
}

export interface LoadedResources {
  manifest: Manifest;
  preview: Preview;
  beats: Beats | null;
  presets: Preset[];
  tracks: TrackInfo[];
  buffers: Record<string, AudioBuffer>;
  durationSec: number;
  originSec: number;
  releaseBase: string;
  source: { kind: "url" | "pack"; label: string };
  artwork: ArtworkInfo | null;
  artist: string | null;
  album: string | null;
  /** 释放本次加载创建的对象 URL（被新加载替换时调用，防泄漏） */
  disposeUrls: () => void;
}

export interface UrlLoadSpec {
  kind: "url";
}

export interface PackLoadSpec {
  kind: "pack";
  label: string;
  /** 键为包根相对 POSIX 路径 */
  files: Map<string, Blob>;
}

export type LoadSpec = UrlLoadSpec | PackLoadSpec;

const LABELS: Record<string, string> = {
  vocals: "人声",
  drums: "鼓组",
  bass: "贝斯",
  guitar: "吉他",
  piano: "钢琴",
  other: "其他",
};

const COLORS: Record<string, string> = {
  vocals: "#f59e0b",
  drums: "#ef4444",
  bass: "#8b5cf6",
  guitar: "#ec4899",
  piano: "#06b6d4",
  other: "#10b981",
};

export const PACK_MAX_BYTES = 200 * 1024 * 1024;

export class ResourceError extends Error {}

async function fetchJson<T>(url: URL): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ResourceError(`无法访问资源：${url.pathname}`);
  }
  if (!res.ok) {
    let msg = `资源请求失败（${res.status}）：${url.pathname}`;
    try {
      const body = (await res.json()) as { error?: string; hint?: string };
      if (body.error) msg = body.hint ? `${body.error}（${body.hint}）` : body.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ResourceError(msg);
  }
  return (await res.json()) as T;
}

// ---------- 双源 IO 抽象 ----------
// url 源：ref 是绝对 URL 字符串，相对路径用 new URL(rel, ownerUrl) 按“属主 JSON”解析；
// pack 源：ref 是包内 POSIX 路径，相对路径按属主 JSON 所在目录做纯字符串解析（.. / . 归一化）。

interface SourceIO {
  kind: "url" | "pack";
  label: string;
  /** manifest.json 自身的 ref */
  manifestRef: string;
  /** 供 LoadedResources.releaseBase 使用的根描述 */
  rootRef: string;
  resolve(ownerRef: string, rel: string): string;
  has(ref: string): boolean;
  readJson<T>(ref: string): Promise<T>;
  readBuffer(ref: string, who: string): Promise<ArrayBuffer>;
  /** artwork 的可展示 URL；pack 源缺文件返回 null。创建的对象 URL 记入 urls */
  displayUrl(ref: string): string | null;
  urls: string[];
}

function posixDirOf(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i < 0 ? "" : filePath.slice(0, i + 1);
}

export function resolvePosix(baseDir: string, rel: string): string {
  const parts = baseDir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

async function createUrlIO(): Promise<SourceIO> {
  const currentUrl = new URL("/resources/current.json", window.location.href);
  const current = await fetchJson<{ release: string }>(currentUrl);
  const releasePath = current.release.endsWith("/") ? current.release : `${current.release}/`;
  const releaseBase = new URL(releasePath, currentUrl);
  const manifestUrl = new URL("manifest.json", releaseBase);
  return {
    kind: "url",
    label: "本地构建",
    manifestRef: manifestUrl.href,
    rootRef: releaseBase.href,
    resolve: (ownerRef, rel) => new URL(rel, ownerRef).href,
    has: () => true,
    readJson: (ref) => fetchJson(new URL(ref)),
    readBuffer: async (ref, who) => {
      const res = await fetch(new URL(ref));
      if (!res.ok) throw new ResourceError(`音频下载失败（${res.status}）：${who}`);
      return res.arrayBuffer();
    },
    displayUrl: (ref) => ref,
    urls: [],
  };
}

async function createPackIO(spec: PackLoadSpec): Promise<SourceIO> {
  const files = spec.files;
  // 会话内 release 钉住：包内含 current.json 且指向的目录存在 manifest 时按 release 加载，否则以包根为 release
  let root = "";
  if (files.has("current.json")) {
    try {
      const current = JSON.parse(await files.get("current.json")!.text()) as { release?: string };
      if (typeof current.release === "string") {
        const rel = current.release.endsWith("/") ? current.release : `${current.release}/`;
        if (files.has(resolvePosix(rel, "manifest.json"))) root = rel;
      }
    } catch {
      /* current.json 损坏：退回包根 */
    }
  }
  if (!files.has(resolvePosix(root, "manifest.json"))) {
    throw new ResourceError("资源包缺少 manifest.json，请选择 pipeline 生成的发布目录");
  }
  const io: SourceIO = {
    kind: "pack",
    label: spec.label,
    manifestRef: resolvePosix(root, "manifest.json"),
    rootRef: root,
    resolve: (ownerRef, rel) => resolvePosix(posixDirOf(ownerRef), rel),
    has: (ref) => files.has(ref),
    readJson: async <T>(ref: string): Promise<T> => {
      const blob = files.get(ref);
      if (!blob) throw new ResourceError(`资源包缺少文件：${ref}`);
      try {
        return JSON.parse(await blob.text()) as T;
      } catch {
        throw new ResourceError(`资源包文件不是有效 JSON：${ref}`);
      }
    },
    readBuffer: async (ref, who) => {
      const blob = files.get(ref);
      if (!blob) throw new ResourceError(`资源包缺少音频文件：${who}`);
      return blob.arrayBuffer();
    },
    displayUrl: (ref) => {
      const blob = files.get(ref);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      io.urls.push(url);
      return url;
    },
    urls: [],
  };
  return io;
}

function resolveArtwork(io: SourceIO, manifest: Manifest): ArtworkInfo | null {
  const mount = manifest.track.artwork;
  if (!mount || typeof mount !== "object") return null; // 字段可选：旧包无 artwork
  const base: ArtworkInfo = {
    status: mount.status === "ready" || mount.status === "error" ? mount.status : "missing",
    url: null,
    mime: mount.mime ?? null,
    width: mount.width ?? null,
    height: mount.height ?? null,
  };
  if (base.status === "ready" && mount.path) {
    const url = io.displayUrl(io.resolve(io.manifestRef, mount.path));
    if (url) base.url = url;
    else base.status = "missing"; // ready 但文件不在包里：如实降级
  }
  return base;
}

export async function loadResources(
  ctx: AudioContext,
  onProgress: (decoded: number, total: number) => void,
  isCancelled: () => boolean,
  spec: LoadSpec = { kind: "url" },
): Promise<LoadedResources> {
  const io = spec.kind === "pack" ? await createPackIO(spec) : await createUrlIO();

  const manifest = await io.readJson<Manifest>(io.manifestRef);

  const previewMount = manifest.resources.preview;
  if (previewMount.status !== "ready" || !previewMount.path) {
    throw new ResourceError("预览资源未就绪，请重新运行 pipeline build");
  }
  const previewRef = io.resolve(io.manifestRef, previewMount.path);
  const preview = await io.readJson<Preview>(previewRef);

  let presets: Preset[] = [];
  const presetsMount = manifest.resources.presets;
  if (presetsMount.status === "ready" && presetsMount.path) {
    const file = await io.readJson<{ presets: Preset[] }>(io.resolve(io.manifestRef, presetsMount.path));
    presets = file.presets;
  }

  let beats: Beats | null = null;
  try {
    beats = await io.readJson<Beats>(io.resolve(previewRef, "beats.json"));
  } catch {
    beats = null;
  }

  const manifestIds = manifest.track.stems.map((s) => s.id);
  const previewIds = Object.keys(preview.stems);
  const ids = [
    ...manifestIds.filter((id) => preview.stems[id]),
    ...previewIds.filter((id) => !manifestIds.includes(id)),
  ];
  if (ids.length === 0) throw new ResourceError("预览中没有可用轨道");

  const total = ids.length;
  let decoded = 0;
  onProgress(0, total);

  const tracks: TrackInfo[] = [];
  const buffers: Record<string, AudioBuffer> = {};
  await Promise.all(
    ids.map(async (id) => {
      const stem = preview.stems[id];
      const features = await io.readJson<Features>(io.resolve(previewRef, `features/${id}.json`));
      const buf = await ctx.decodeAudioData(await io.readBuffer(io.resolve(previewRef, stem.path), id));
      if (isCancelled()) return;
      buffers[id] = buf;
      tracks.push({
        id,
        label: LABELS[id] ?? id,
        color: COLORS[id] ?? "#94a3b8",
        delayStatus: stem.delayStatus,
        // uncertain/silent 的 delaySec 为 null：按 0 处理，不擅自补偿，UI 另行标记
        delaySec: stem.delaySec ?? 0,
        features,
      });
      decoded += 1;
      onProgress(decoded, total);
    }),
  );
  if (isCancelled()) throw new ResourceError("加载已取消");
  tracks.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const urls = io.urls;
  return {
    manifest,
    preview,
    beats,
    presets,
    tracks,
    buffers,
    durationSec: preview.durationSec,
    originSec: preview.originSec,
    releaseBase: io.rootRef,
    source: { kind: io.kind, label: io.label },
    artwork: resolveArtwork(io, manifest),
    artist: manifest.track.artist ?? null,
    album: manifest.track.album ?? null,
    disposeUrls: () => {
      for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    },
  };
}

// ---------- 导入资源包校验（B/C 共用） ----------

export interface PackInfo {
  trackId: string;
  trackTitle: string;
  artist: string | null;
  album: string | null;
  stemIds: string[];
  sizeBytes: number;
}

/**
 * 用户选择的文件夹可能带一层顶层目录名（webkitdirectory 行为）：
 * 若根下无 manifest.json，找最浅的 *\/manifest.json 并剥掉其前缀。
 */
export function normalizePackFiles(raw: Map<string, Blob>): Map<string, Blob> {
  if (raw.has("manifest.json")) return raw;
  let best: string | null = null;
  for (const key of raw.keys()) {
    if (!key.endsWith("/manifest.json")) continue;
    if (best === null || key.split("/").length < best.split("/").length) best = key;
  }
  if (best === null) return raw; // 交给 validatePack 报“缺少 manifest.json”
  const prefix = posixDirOf(best);
  const out = new Map<string, Blob>();
  for (const [key, blob] of raw) {
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length), blob);
  }
  return out;
}

export async function validatePack(files: Map<string, Blob>): Promise<PackInfo> {
  let sizeBytes = 0;
  for (const blob of files.values()) sizeBytes += blob.size;
  if (sizeBytes > PACK_MAX_BYTES) {
    throw new ResourceError(
      `资源包过大（${(sizeBytes / 1048576).toFixed(1)}MB），超过 ${PACK_MAX_BYTES / 1048576}MB 上限；请导入预览发布目录而非整曲资产`,
    );
  }
  const io = await createPackIO({ kind: "pack", label: "", files });
  const manifest = await io.readJson<Manifest>(io.manifestRef);
  if (manifest.schemaVersion !== 1) {
    throw new ResourceError(`不支持的资源包 schemaVersion：${String(manifest.schemaVersion)}（当前仅支持 1）`);
  }
  if (!manifest.track?.id || !Array.isArray(manifest.track.stems)) {
    throw new ResourceError("manifest.json 缺少 track.id / track.stems，不是有效的资源包");
  }
  const previewMount = manifest.resources?.preview;
  if (!previewMount || previewMount.status !== "ready" || !previewMount.path) {
    throw new ResourceError("manifest.json 的预览资源未就绪（resources.preview），无法作为导入包");
  }
  const previewRef = io.resolve(io.manifestRef, previewMount.path);
  if (!io.has(previewRef)) throw new ResourceError(`资源包缺少文件：${previewRef}`);
  const preview = await io.readJson<Preview & { kind?: string; schemaVersion?: number }>(previewRef);
  if (preview.kind !== undefined && preview.kind !== "preview") {
    throw new ResourceError(`preview.json 的 kind 应为 "preview"，实际为 "${String(preview.kind)}"`);
  }
  const manifestIds = manifest.track.stems.map((s) => s.id);
  const ids = manifestIds.filter((id) => preview.stems?.[id]);
  if (ids.length === 0) throw new ResourceError("manifest 与 preview 的轨道交集为空，资源包不完整");
  for (const id of ids) {
    const featRef = io.resolve(previewRef, `features/${id}.json`);
    if (!io.has(featRef)) throw new ResourceError(`资源包缺少文件：${featRef}`);
    const feat = await io.readJson<{ kind?: string }>(featRef);
    if (feat.kind !== undefined && feat.kind !== "stem-features") {
      throw new ResourceError(`features/${id}.json 的 kind 应为 "stem-features"，实际为 "${String(feat.kind)}"`);
    }
    const audioRef = io.resolve(previewRef, preview.stems[id].path);
    if (!io.has(audioRef)) throw new ResourceError(`资源包缺少音频文件：${id}（${audioRef}）`);
  }
  return {
    trackId: manifest.track.id,
    trackTitle: manifest.track.title || manifest.track.id,
    artist: manifest.track.artist ?? null,
    album: manifest.track.album ?? null,
    stemIds: ids,
    sizeBytes,
  };
}
