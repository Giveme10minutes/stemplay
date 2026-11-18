// 极简 IndexedDB blob 存取（自定义背景图 / 提取的封面）。失败时由调用方降级为会话内有效。

const DB_NAME = "stemplay";
const STORE = "blobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB 不可用"));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
      req.onblocked = () => reject(new Error("IndexedDB 被阻塞"));
    });
    dbPromise.catch(() => {
      dbPromise = null; // 允许下次重试
    });
  }
  return dbPromise;
}

export async function idbGet(key: string): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
    req.onerror = () => reject(req.error ?? new Error("读取失败"));
  });
}

export async function idbSet(key: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("写入中止（可能超出配额）"));
  });
}

export async function idbDel(key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除失败"));
  });
}

export async function idbKeysByPrefix(prefix: string): Promise<string[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys(range);
    req.onsuccess = () => resolve(req.result.map((k) => String(k)));
    req.onerror = () => reject(req.error ?? new Error("读取键失败"));
  });
}

export async function idbDelMany(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const k of keys) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("删除失败"));
    tx.onabort = () => reject(tx.error ?? new Error("删除中止"));
  });
}