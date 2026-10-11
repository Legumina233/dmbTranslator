/**
 * 译图缓存的**落盘后端**（IndexedDB）—— 方案 B：普通缓存语义。
 *
 * ## 它替换掉了什么，为什么
 * 旧后端 `TranslatedImageMemoryVault` 把译图放在 **off-screen 文档的 JS 堆**里。而 off-screen
 * 文档随 MV3 service worker 一起被回收（空闲约 30 秒），于是"跨页面重载存活"的承诺只在
 * SW 活着的几十秒内成立 —— 真机日志里 `vault-list size=5` → 5 秒后 SW 重启 → `size=0`。
 *
 * 现在译图落在**扩展源**的 IndexedDB 里：
 *   · 跨 SW 重启、跨 off-screen 文档重建、跨浏览器重启都还在；
 *   · off-screen 文档只当"读写代理"，它什么时候死都不影响数据。
 *
 * ## 清除语义（方案 B：像浏览器自己的缓存）
 *   · 条数上限：用户设置的 `translationCacheLimit`（1–1000），淘汰**最久写入**的那条；
 *   · 字节上限：`TRANSLATED_IMAGE_MAX_BYTES`（条数上限能设到 1000，按每页 ~1.6MB 就是 1.6GB，
 *     落盘必须另有一道闸）；
 *   · `schemaVersion` 不匹配 → 整个清掉（只认格式版本，**不**认扩展版本：
 *     B 的语义就是"跨版本继续用"，按扩展版本清会变成"每次更新都白干"）；
 *   · 用户点弹窗「删除全部」→ `clear()`；
 *   · 不做"启动时清空"、也不做"退出时清空"（MV3 没有可靠的退出钩子）。
 *
 * ## 内存里留了什么
 * 只留**索引**（key + 字节数 + 写入序号，几十条，几 KB）和最近 `HOT_CACHE_MAX` 张的 Blob
 * （重复读同一页时零拷贝）。译图本体一律现读现取，绝不把整库搬进堆里
 * （200 张 × 1.5MB ≈ 300MB 是灾难）。
 *
 * ## 失败口径
 * 写失败**抛错**（宿主捕获后回 `vault-failed`，内容脚本按"没缓存"降级）；
 * 读失败同样抛错。缓存是加速器，不是正确性依赖 —— 但**不许把失败伪装成"空缓存"**。
 */

import { defaultTranslationCacheLimit } from '../shared/config';
import { createProbe } from '../shared/probe';

/** 临时诊断探针（见 `shared/probe.ts`）。 */
const probe = createProbe('offscreen');

export const TRANSLATED_IMAGE_DB_NAME = 'dmb-translated-images';
/** 数据格式版本。改了存储结构就必须 +1 —— 它触发一次整体清空。 */
/**
 * ★ 2026-10-11：1 → 2。**不是为了改结构，而是为了作废旧数据**：
 *   1 版期间存在一个污染窗口（S1 直接用页面上的图，软导航时可能拿到上一页的图，
 *   于是把上一页的译图存进了本页的键）。那些条目**看起来完全正常**、无法与新数据区分，
 *   唯一可靠的处理就是整体作废。升级即清空，不需要用户手动点「删除全部」。
 *   （同一页两次访问的图址带不同 keystamp，所以"按 URL 认领"救不了旧数据。）
 */
export const TRANSLATED_IMAGE_SCHEMA_VERSION = 2;
/** 字节上限：条数上限最大 1000，落盘必须另设一道闸。 */
export const TRANSLATED_IMAGE_MAX_BYTES = 256 * 1024 * 1024;
/** 内存里保留几张译图本体（重复读同一页时省一次 IDB 往返）。 */
export const HOT_CACHE_MAX = 2;

/** 索引里的一条：**不含 Blob**，所以可以整份读进内存。 */
export type TranslatedImageIndexRecord = {
  key: string;
  bytes: number;
  seq: number;
};

export type TranslatedImageCacheStats = {
  entries: number;
  bytes: number;
  limit: number;
  maxBytes: number;
  schemaVersion: number;
};

/** `ImageVaultHost` 只认这个接口（实现见本文件的 IndexedDB 后端）。 */
export type TranslatedImageCache = {
  /** 全部键（顺序 = 写入顺序）。 */
  listKeys(): Promise<string[]>;
  get(key: string): Promise<Blob | undefined>;
  put(key: string, blob: Blob): Promise<void>;
  setLimit(limit: number): Promise<number>;
  clear(): Promise<void>;
  /** **同步**条数：宿主用它决定空闲时要不要拒绝关闭（不能变成 async）。 */
  size(): number;
  stats(): Promise<TranslatedImageCacheStats>;
};

/**
 * 淘汰计划（**纯函数**，可离线单测）：给当前索引 + 两道上限，算出该删哪些键。
 *
 * 规则：按写入序号**从旧到新**删，直到条数与字节都回到上限内。
 * 极端情况：单张就超过字节上限 → 它自己也会被删（缓存装不下它，这是对的，
 * 否则它会永远占着位置把别人挤光）。
 */
export function planEviction(
  entries: readonly TranslatedImageIndexRecord[],
  limit: number,
  maxBytes: number,
): string[] {
  const victims: string[] = [];
  let count = entries.length;
  let bytes = entries.reduce((sum, entry) => sum + normalizeBytes(entry.bytes), 0);
  if (count <= limit && bytes <= maxBytes) return victims;

  const oldestFirst = [...entries].sort(
    (left, right) => (left.seq - right.seq) || left.key.localeCompare(right.key),
  );
  for (const entry of oldestFirst) {
    if (count <= limit && bytes <= maxBytes) break;
    victims.push(entry.key);
    count -= 1;
    bytes -= normalizeBytes(entry.bytes);
  }
  return victims;
}

function normalizeBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeLimit(value: number): number {
  const parsed = Math.trunc(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : defaultTranslationCacheLimit;
}

// ── 存储端口：逻辑与 IDB 调用分离，测试注入内存实现 ────────────────────────

export type TranslatedImageStoragePort = {
  readIndex(): Promise<TranslatedImageIndexRecord[]>;
  read(key: string): Promise<Blob | undefined>;
  write(record: TranslatedImageIndexRecord & { blob: Blob }): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  clearImages(): Promise<void>;
  readSchemaVersion(): Promise<number | undefined>;
  writeSchemaVersion(version: number): Promise<void>;
};

export type TranslatedImageCacheOptions = {
  limit?: number;
  maxBytes?: number;
  /** 存储端口；缺省用 IndexedDB。测试注入内存实现。 */
  port?: TranslatedImageStoragePort;
  /** 只为诊断（写进 meta，便于事后判断"这份数据是谁写的"）。 */
  extensionVersion?: string;
  /** 注入 IndexedDB 工厂（缺省 `globalThis.indexedDB`）；传 null 表示不可用。 */
  factory?: IDBFactory | null;
};

export function createTranslatedImageCache(
  options: TranslatedImageCacheOptions = {},
): TranslatedImageCache {
  const maxBytes = Number.isFinite(options.maxBytes) && (options.maxBytes ?? 0) > 0
    ? Math.trunc(options.maxBytes as number)
    : TRANSLATED_IMAGE_MAX_BYTES;
  let limit = normalizeLimit(options.limit ?? defaultTranslationCacheLimit);

  const index = new Map<string, TranslatedImageIndexRecord>();
  const hot = new Map<string, Blob>();
  let nextSeq = 1;
  let readyPromise: Promise<TranslatedImageStoragePort> | null = null;
  /**
   * 已打开的端口。`ready()` 内部（首次装载）**不能**再 `await ready()` —— 那是在等自己，
   * 会死锁。所以 `trim()` 走这个引用，取不到才回落到 `ready()`（外部调用路径）。
   */
  let portRef: TranslatedImageStoragePort | null = null;

  function remember(record: TranslatedImageIndexRecord): void {
    index.set(record.key, record);
  }

  function forget(keys: readonly string[]): void {
    for (const key of keys) {
      index.delete(key);
      hot.delete(key);
    }
  }

  function promoteHot(key: string, blob: Blob): void {
    hot.delete(key);
    hot.set(key, blob);
    while (hot.size > HOT_CACHE_MAX) {
      const oldest = hot.keys().next().value;
      if (oldest === undefined) break;
      hot.delete(oldest);
    }
  }

  async function ready(): Promise<TranslatedImageStoragePort> {
    if (readyPromise) return readyPromise;
    readyPromise = (async (): Promise<TranslatedImageStoragePort> => {
      const port = options.port ?? createIndexedDbStoragePort(options.factory);
      portRef = port;
      const schemaVersion = await port.readSchemaVersion();
      if (schemaVersion !== undefined && schemaVersion !== TRANSLATED_IMAGE_SCHEMA_VERSION) {
        // 存储结构变过：旧数据不可信，整体清掉（这是唯一会"无差别清空"的路径）。
        await port.clearImages();
        await port.writeSchemaVersion(TRANSLATED_IMAGE_SCHEMA_VERSION);
        probe('vault-store:schema-reset', { from: schemaVersion, to: TRANSLATED_IMAGE_SCHEMA_VERSION });
      } else if (schemaVersion === undefined) {
        await port.writeSchemaVersion(TRANSLATED_IMAGE_SCHEMA_VERSION);
      }

      const records = await port.readIndex();
      index.clear();
      for (const record of records) {
        remember({
          key: record.key,
          bytes: normalizeBytes(record.bytes),
          seq: Number.isFinite(record.seq) ? record.seq : 0,
        });
      }
      nextSeq = records.reduce((max, record) => Math.max(max, record.seq + 1), 1);
      // 打开时就裁一次：上限可能在别的会话里被调小过。
      await trim();
      probe('vault-store:ready', {
        entries: index.size,
        bytes: totalBytes(),
        limit,
        maxBytes,
        extensionVersion: options.extensionVersion,
      });
      return port;
    })();
    // 打开失败不能把 promise 永久钉死（否则这一整个文档生命周期都没有缓存）。
    readyPromise = readyPromise.catch((error: unknown) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }

  function totalBytes(): number {
    let sum = 0;
    for (const record of index.values()) sum += normalizeBytes(record.bytes);
    return sum;
  }

  async function trim(): Promise<void> {
    const victims = planEviction([...index.values()], limit, maxBytes);
    if (victims.length === 0) return;
    const port = portRef ?? await ready();
    await port.remove(victims);
    forget(victims);
    probe('vault-store:trim', { victims: victims.length, entries: index.size, bytes: totalBytes() });
  }

  return {
    async listKeys(): Promise<string[]> {
      await ready();
      // 按写入序号返回：`Map` 的插入序在"同键重写"时不会移动，而语义上重写 = 变成最新。
      return [...index.values()]
        .sort((left, right) => (left.seq - right.seq) || left.key.localeCompare(right.key))
        .map((record) => record.key);
    },

    async get(key: string): Promise<Blob | undefined> {
      const cached = hot.get(key);
      if (cached) return cached;
      const port = await ready();
      if (!index.has(key)) return undefined;
      const blob = await port.read(key);
      if (blob) promoteHot(key, blob);
      return blob;
    },

    async put(key: string, blob: Blob): Promise<void> {
      const port = await ready();
      // 同键重写 = 一次**新写入**（与旧的 Map `delete` 再 `set` 同口径：挪到最新）。
      const record: TranslatedImageIndexRecord = {
        key,
        bytes: normalizeBytes(blob.size),
        seq: nextSeq,
      };
      nextSeq += 1;
      await port.write({ ...record, blob });
      remember(record);
      promoteHot(key, blob);
      probe('vault-store:put', { key, bytes: record.bytes, entries: index.size });
      await trim();
    },

    async setLimit(nextLimit: number): Promise<number> {
      limit = normalizeLimit(nextLimit);
      await ready();
      await trim();
      probe('vault-store:set-limit', { limit });
      return limit;
    },

    async clear(): Promise<void> {
      const port = await ready();
      await port.clearImages();
      index.clear();
      hot.clear();
      probe('vault-store:clear', {});
    },

    size(): number {
      return index.size;
    },

    async stats(): Promise<TranslatedImageCacheStats> {
      await ready();
      return {
        entries: index.size,
        bytes: totalBytes(),
        limit,
        maxBytes,
        schemaVersion: TRANSLATED_IMAGE_SCHEMA_VERSION,
      };
    },
  };
}

// ── 真实后端：IndexedDB ────────────────────────────────────────────────────

const IMAGE_STORE = 'images';
const INDEX_STORE = 'index';
const META_STORE = 'meta';

function createIndexedDbStoragePort(factoryOption?: IDBFactory | null): TranslatedImageStoragePort {
  const factory = factoryOption ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  if (!factory) {
    throw new Error('IndexedDB 不可用，译图缓存无法落盘');
  }
  // 显式收窄成非空常量：闭包里 TS 不会为它保留上面的判空收窄。
  const idbFactory: IDBFactory = factory;
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = idbFactory.open(TRANSLATED_IMAGE_DB_NAME, 1);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(IMAGE_STORE)) {
          database.createObjectStore(IMAGE_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(INDEX_STORE)) {
          database.createObjectStore(INDEX_STORE, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('打开译图缓存数据库失败'));
      request.onblocked = () => reject(new Error('译图缓存数据库被其它版本占用'));
    }).catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  }

  function request<T>(source: IDBRequest<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      source.onsuccess = () => resolve(source.result);
      source.onerror = () => reject(source.error ?? new Error(message));
    });
  }

  function done(transaction: IDBTransaction, message: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error(message));
      transaction.onabort = () => reject(transaction.error ?? new Error(message));
    });
  }

  return {
    async readIndex(): Promise<TranslatedImageIndexRecord[]> {
      const database = await db();
      const transaction = database.transaction(INDEX_STORE, 'readonly');
      const all = await request(
        transaction.objectStore(INDEX_STORE).getAll() as IDBRequest<TranslatedImageIndexRecord[]>,
        '读取译图缓存索引失败',
      );
      return Array.isArray(all) ? all : [];
    },

    async read(key: string): Promise<Blob | undefined> {
      const database = await db();
      const transaction = database.transaction(IMAGE_STORE, 'readonly');
      const value = await request<{ blob?: Blob } | undefined>(
        transaction.objectStore(IMAGE_STORE).get(key) as IDBRequest<{ blob?: Blob } | undefined>,
        '读取译图失败',
      );
      return value?.blob instanceof Blob ? value.blob : undefined;
    },

    async write(record): Promise<void> {
      const database = await db();
      const transaction = database.transaction([IMAGE_STORE, INDEX_STORE], 'readwrite');
      transaction.objectStore(IMAGE_STORE).put({ key: record.key, blob: record.blob });
      transaction.objectStore(INDEX_STORE).put({
        key: record.key,
        bytes: record.bytes,
        seq: record.seq,
      });
      await done(transaction, '写入译图失败');
    },

    async remove(keys: readonly string[]): Promise<void> {
      if (keys.length === 0) return;
      const database = await db();
      const transaction = database.transaction([IMAGE_STORE, INDEX_STORE], 'readwrite');
      for (const key of keys) {
        transaction.objectStore(IMAGE_STORE).delete(key);
        transaction.objectStore(INDEX_STORE).delete(key);
      }
      await done(transaction, '淘汰译图失败');
    },

    async clearImages(): Promise<void> {
      const database = await db();
      const transaction = database.transaction([IMAGE_STORE, INDEX_STORE], 'readwrite');
      transaction.objectStore(IMAGE_STORE).clear();
      transaction.objectStore(INDEX_STORE).clear();
      await done(transaction, '清空译图失败');
    },

    async readSchemaVersion(): Promise<number | undefined> {
      const database = await db();
      const transaction = database.transaction(META_STORE, 'readonly');
      const value = await request<{ schemaVersion?: number } | undefined>(
        transaction.objectStore(META_STORE).get('meta') as IDBRequest<{ schemaVersion?: number } | undefined>,
        '读取译图缓存元信息失败',
      );
      return typeof value?.schemaVersion === 'number' ? value.schemaVersion : undefined;
    },

    async writeSchemaVersion(version: number): Promise<void> {
      const database = await db();
      const transaction = database.transaction(META_STORE, 'readwrite');
      transaction.objectStore(META_STORE).put({ id: 'meta', schemaVersion: version });
      await done(transaction, '写入译图缓存元信息失败');
    },
  };
}
