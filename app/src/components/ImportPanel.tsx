import { useRef, useState } from "react";
import { AudioLines, FolderOpen, Library, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { addPack, loadPackFiles, remove, select, useLibrary, type LibraryEntry } from "@/lib/library";
import { PACK_MAX_BYTES, normalizePackFiles, validatePack } from "@/lib/resources";
import { importCoverFromFile, showToast, useAppearance } from "@/lib/theme";

// 导入面板：两个语义严格分开的入口——
// 1) 替换歌曲：导入 pipeline 产出的资源包（会切歌，进入曲库）
// 2) 提取主题素材：只读取本地音频内嵌封面做取色（第 2 轮语义，绝不切歌）

interface FsFileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
interface FsDirHandleLike {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FsFileHandleLike | FsDirHandleLike>;
}
type WindowWithPicker = Window & {
  showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FsDirHandleLike>;
};

type PackStatus = { text: string; tone: "idle" | "busy" | "ok" | "error" };

const IDLE_STATUS: PackStatus = { text: "尚未导入资源包", tone: "idle" };

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function readDirectoryHandle(handle: FsDirHandleLike): Promise<Map<string, Blob>> {
  const files = new Map<string, Blob>();
  let total = 0;
  async function walk(dir: FsDirHandleLike, prefix: string) {
    for await (const child of dir.values()) {
      if (child.kind === "directory") {
        await walk(child, `${prefix}${child.name}/`);
      } else {
        const file = await child.getFile();
        total += file.size;
        if (total > PACK_MAX_BYTES) {
          throw new Error(`文件夹超过 ${PACK_MAX_BYTES / 1048576}MB 上限，已停止读取；请选择预览发布目录`);
        }
        files.set(`${prefix}${child.name}`, file);
      }
    }
  }
  await walk(handle, "");
  return files;
}

export function ImportPanel() {
  const [open, setOpen] = useState(false);
  const lib = useLibrary();
  const appearance = useAppearance();
  const dirInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<PackStatus>(IDLE_STATUS);
  const [busy, setBusy] = useState(false);
  // 重试凭据：已读入内存的 blobs（校验/加载失败后可原样重来，不要求用户重新选目录）
  const [lastFiles, setLastFiles] = useState<{ files: Map<string, Blob>; label: string } | null>(null);

  async function importFromMap(raw: Map<string, Blob>, label: string) {
    setBusy(true);
    try {
      const files = normalizePackFiles(raw);
      setStatus({ text: `已读取 ${files.size} 个文件（${fmtMB([...files.values()].reduce((a, b) => a + b.size, 0))}），正在校验资源包…`, tone: "busy" });
      setLastFiles({ files, label });
      const info = await validatePack(files);
      setStatus({ text: `校验通过：${info.trackTitle}（${info.stemIds.length} 轨），正在加载与解码…`, tone: "busy" });
      await loadPackFiles(files, label);
      try {
        await addPack(info, files, label);
        setStatus({ text: `已导入并加入曲库：${info.trackTitle}`, tone: "ok" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast(msg);
        setStatus({ text: `已导入（仅本次会话）：${info.trackTitle} —— ${msg}`, tone: "ok" });
      }
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function pickDirectory() {
    const picker = (window as WindowWithPicker).showDirectoryPicker;
    if (picker) {
      try {
        const handle = await picker.call(window, { mode: "read" });
        const files = await readDirectoryHandle(handle);
        await importFromMap(files, handle.name);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return; // 用户取消
        setStatus({ text: err instanceof Error ? err.message : String(err), tone: "error" });
        return;
      }
    }
    dirInputRef.current?.click(); // 无目录选择 API：回退 webkitdirectory 文件输入
  }

  async function onPickFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const raw = new Map<string, Blob>();
    let total = 0;
    for (const f of fileList) {
      total += f.size;
      if (total > PACK_MAX_BYTES) {
        setStatus({ text: `文件夹超过 ${PACK_MAX_BYTES / 1048576}MB 上限，已停止读取；请选择预览发布目录`, tone: "error" });
        return;
      }
      raw.set(f.webkitRelativePath || f.name, f);
    }
    const first = fileList[0];
    const seg = (first.webkitRelativePath || "").split("/");
    const label = seg.length > 1 ? seg[0] : "本地文件夹";
    await importFromMap(raw, label);
  }

  async function onLoadEntry(entry: LibraryEntry) {
    setBusy(true);
    setStatus({ text: `正在从曲库恢复「${entry.name}」…`, tone: "busy" });
    try {
      await select(entry.id);
      setStatus({ text: `已从曲库载入：${entry.trackTitle}`, tone: "ok" });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function onRemoveEntry(entry: LibraryEntry) {
    try {
      await remove(entry.id);
      setStatus({ text: `已从曲库删除「${entry.name}」（本机数据已清除）`, tone: "ok" });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  const broken = new Set(lib.brokenIds);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="open-import"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="max-md:h-11 max-md:px-2 max-md:text-xs"
      >
        导入
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md" data-testid="import-panel">
          <SheetHeader>
            <SheetTitle>导入</SheetTitle>
            <SheetDescription>替换歌曲与提取主题素材是两个独立入口，互不影响</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-6 px-4 py-4">
            {/* 1. 替换歌曲 */}
            <section>
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <FolderOpen className="size-4" />
                替换歌曲（导入已处理资源包）
              </h3>
              <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                选择 pipeline 生成的发布目录（含 manifest.json、preview/、features/），校验通过后立即切换播放，并保存到本机曲库。不会上传任何文件。
              </p>
              <input
                ref={dirInputRef}
                type="file"
                multiple
                // 非标准属性走 spread 绕过 JSX 类型检查：目录选择回退方案
                {...{ webkitdirectory: "", directory: "" }}
                className="hidden"
                data-testid="pack-dir-input"
                onChange={(e) => {
                  void onPickFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                className="h-11 w-full gap-1.5 text-xs md:h-9"
                data-testid="pack-pick-btn"
                disabled={busy}
                onClick={() => void pickDirectory()}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
                选择资源包文件夹
              </Button>
              <p
                className={`mt-2 text-xs leading-relaxed ${status.tone === "error" ? "text-red-400" : "text-muted-foreground"}`}
                role="status"
                data-testid="pack-status"
              >
                {status.text}
              </p>
              {status.tone === "error" && lastFiles && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1 h-11 gap-1.5 text-xs md:h-8"
                  data-testid="pack-retry"
                  disabled={busy}
                  onClick={() => void importFromMap(lastFiles.files, lastFiles.label)}
                >
                  <RotateCcw className="size-3.5" />
                  重试
                </Button>
              )}

              {/* 曲库 */}
              <div className="mt-3" data-testid="library-list">
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Library className="size-3.5" />
                  本机曲库（{lib.entries.length}）
                </h4>
                {lib.entries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">曲库为空；导入的资源包会保存在本机（IndexedDB），刷新后可再次载入。</p>
                ) : (
                  <ul className="space-y-1.5">
                    {lib.entries.map((entry) => (
                      <li
                        key={entry.id}
                        data-testid={`lib-entry-${entry.id}`}
                        className={`flex items-center gap-2 rounded-xl border p-2 ${
                          lib.selectedId === entry.id ? "border-ring bg-muted" : "border-border"
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium">
                            {entry.trackTitle}
                            {lib.selectedId === entry.id && <span className="ml-1.5 text-[10px] text-muted-foreground">当前</span>}
                            {broken.has(entry.id) && <span className="ml-1.5 text-[10px] text-red-400">数据不完整</span>}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {fmtMB(entry.sizeBytes)} · 导入于 {fmtDate(entry.addedAt)} · 最近使用 {fmtDate(entry.lastUsedAt)}
                          </div>
                        </div>
                        <Button
                          variant={broken.has(entry.id) ? "secondary" : "outline"}
                          size="sm"
                          className="h-11 shrink-0 px-2.5 text-xs md:h-8"
                          data-testid={`lib-load-${entry.id}`}
                          disabled={busy}
                          onClick={() => void onLoadEntry(entry)}
                        >
                          {broken.has(entry.id) ? "重试" : "载入"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`删除「${entry.name}」`}
                          className="h-11 w-11 shrink-0 p-0 md:h-8 md:w-8"
                          data-testid={`lib-remove-${entry.id}`}
                          disabled={busy}
                          onClick={() => void onRemoveEntry(entry)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 2. 提取主题素材（第 2 轮语义，绝不切歌） */}
            <section className="rounded-xl border border-border p-3">
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <AudioLines className="size-4" />
                提取主题素材（读取本地音频内嵌封面）
              </h3>
              <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
                从本地音频读取内嵌封面并提取配色。
                <span className="font-medium text-foreground">仅提取主题素材，不会把歌曲加入曲库</span>。
              </p>
              <input
                ref={audioInputRef}
                type="file"
                accept="audio/*,.flac,.mp3,.m4a,.wav,.ogg"
                className="hidden"
                data-testid="theme-audio-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importCoverFromFile(f);
                  e.target.value = "";
                }}
              />
              <Button
                variant="outline"
                className="h-11 w-full gap-1.5 text-xs md:h-9"
                data-testid="theme-cover-btn"
                disabled={appearance.cover.status === "reading"}
                onClick={() => audioInputRef.current?.click()}
              >
                <AudioLines className="size-4" />
                {appearance.cover.status === "reading" ? "正在读取…" : "从本地音频提取封面"}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground" role="status" data-testid="theme-status">
                {appearance.cover.message || "尚未提取"}
              </p>
              {appearance.cover.url && (
                <img
                  src={appearance.cover.url}
                  alt="提取的专辑封面"
                  className="mt-2 size-14 rounded-lg border border-border object-cover"
                />
              )}
            </section>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
