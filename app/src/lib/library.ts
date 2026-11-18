// 本机曲库：LS 存元数据（stemplay.library.v1），资源包 blob 存 IndexedDB（pack:<id>:<relPath>）。
// 刷新后不自动读 blob（首屏仍走 dev/URL 源），仅在用户点“载入”时恢复。
// 镜像 theme.ts 的 store 模式：离散事件 + useSyncExternalStore，不进 rAF。

import { useSyncExternalStore } from "react";
import { idbDelMany, idbGet, idbKeysByPrefix, idbSet } from "@/lib/idb";
import { normalizePackFiles, validatePack, type PackInfo } from "@/lib/resources";

export interface LibraryEntry {
  id: string;
  name: string;
  trackTitle: string;
  addedAt: string;
  sizeBytes: number;
  lastUsedAt: string;
}

export interface LibraryState {
  entries: LibraryEntry[];
  selectedId: string | null;
  /** 运行期标记：IDB blob 缺失/损坏的条目（不持久化） */
  brokenIds: string[];
}

const LS_KEY = "stemplay.library.v1";
const PACK_PREFIX = "pack:";

function packKey(id: string, relPath: string): string {
  return `${PACK_PREFIX}${id}:${relPath}`;
}

function loadPersisted(): { entries: LibraryEntry[]; selectedId: string | null } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { entries: [], selectedId: null };
    const parsed = JSON.parse(raw) as { v?: number; entries?: unknown; selectedId?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.entries)) return { entries: [], selectedId: null };
    const entries = parsed.entries
      .filter((e): e is LibraryEntry => typeof e === "object" && e !== null && typeof (e as LibraryEntry).id === "string")
      .map((e) => ({
        id: e.id,
        name: typeof e.name === "string" ? e.name : e.id,
        trackTitle: typeof e.trackTitle === "string" ? e.trackTitle : "",
        addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
        sizeBytes: typeof e.sizeBytes === "number" ? e.sizeBytes : 0,
        lastUsedAt: typeof e.lastUsedAt === "string" ? e.lastUsedAt : new Date().toISOString(),
      }));
    const ids = new Set(entries.map((e) => e.id));
    const selectedId = typeof parsed.selectedId === "string" && ids.has(parsed.selectedId) ? parsed.selectedId : null;
    return { entries, selectedId };
  } catch {
    return { entries: [], selectedId: null };
  }
}

function persist() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ v: 1, entries: state.entries, selectedId: state.selectedId }),
    );
  } catch {
    /* 隐私模式等：曲库仅会话内有效 */
  }
}

const persisted = loadPersisted();
let state: LibraryState = { entries: persisted.entries, selectedId: persisted.selectedId, brokenIds: [] };

const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function setState(patch: Partial<LibraryState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribeLibrary(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLibrary(): LibraryState {
  return state;
}

export function useLibrary(): LibraryState {
  return useSyncExternalStore(subscribeLibrary, getLibrary, getLibrary);
}

// ---------- 加载器注册（App 注入 doLoad 通道，面板与门面共用） ----------

type PackLoader = (files: Map<string, Blob>, label: string) => Promise<void>;
let packLoader: PackLoader | null = null;

export function setPackLoader(fn: PackLoader | null) {
  packLoader = fn;
}

export async function loadPackFiles(files: Map<string, Blob>, label: string): Promise<void> {
  if (!packLoader) throw new Error("播放加载器尚未就绪，请稍后再试");
  await packLoader(files, label);
}

// ---------- 曲库操作 ----------

export async function addPack(info: PackInfo, files: Map<string, Blob>, name?: string): Promise<string> {
  const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const written: string[] = [];
  try {
    for (const [rel, blob] of files) {
      const key = packKey(id, rel);
      await idbSet(key, blob);
      written.push(key);
    }
  } catch (err) {
    await idbDelMany(written).catch(() => undefined); // 不留半成品
    throw new Error(`写入本机曲库失败（可能超出存储配额）：${err instanceof Error ? err.message : String(err)}`);
  }
  const now = new Date().toISOString();
  const entry: LibraryEntry = {
    id,
    name: name || info.trackTitle,
    trackTitle: info.trackTitle,
    addedAt: now,
    sizeBytes: info.sizeBytes,
    lastUsedAt: now,
  };
  setState({ entries: [entry, ...state.entries.filter((e) => e.id !== id)], selectedId: id });
  persist();
  return id;
}

/** 从 IDB 恢复某个曲库条目的全部 blob；缺失即如实报错并标记 broken */
export async function restorePack(id: string): Promise<Map<string, Blob>> {
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) throw new Error("曲库中不存在该条目");
  const keys = await idbKeysByPrefix(packKey(id, ""));
  if (keys.length === 0) {
    setState({ brokenIds: [...new Set([...state.brokenIds, id])] });
    throw new Error(`「${entry.name}」的本机数据已丢失（IndexedDB 中没有文件），请重新导入资源包`);
  }
  const files = new Map<string, Blob>();
  const prefix = packKey(id, "");
  for (const key of keys) {
    const blob = await idbGet(key);
    if (!blob) {
      setState({ brokenIds: [...new Set([...state.brokenIds, id])] });
      throw new Error(`「${entry.name}」的本机数据不完整（缺少 ${key.slice(prefix.length)}），请删除后重新导入`);
    }
    files.set(key.slice(prefix.length), blob);
  }
  const normalized = normalizePackFiles(files);
  await validatePack(normalized); // 载入前重新校验：损坏数据不进入播放器
  setState({ brokenIds: state.brokenIds.filter((b) => b !== id) });
  return normalized;
}

/** 载入库中资源包：恢复 blob → 校验 → 走 App 的 doLoad 通道 → 更新 selectedId/lastUsedAt */
export async function select(id: string): Promise<void> {
  const files = await restorePack(id);
  const entry = state.entries.find((e) => e.id === id);
  await loadPackFiles(files, entry?.name ?? "曲库资源包");
  markUsed(id);
}

export function markUsed(id: string) {
  const now = new Date().toISOString();
  setState({
    entries: state.entries.map((e) => (e.id === id ? { ...e, lastUsedAt: now } : e)),
    selectedId: id,
  });
  persist();
}

export async function remove(id: string): Promise<void> {
  const keys = await idbKeysByPrefix(packKey(id, ""));
  await idbDelMany(keys);
  setState({
    entries: state.entries.filter((e) => e.id !== id),
    selectedId: state.selectedId === id ? null : state.selectedId,
    brokenIds: state.brokenIds.filter((b) => b !== id),
  });
  persist();
}

export function list(): LibraryEntry[] {
  return state.entries;
}

export function libraryState(): LibraryState {
  return state;
}

export const libraryStore = {
  getState: getLibrary,
  subscribe: subscribeLibrary,
  list,
  select,
  remove,
  addPack,
  restorePack,
  markUsed,
  setPackLoader,
  loadPackFiles,
  state: libraryState,
};
