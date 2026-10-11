import type {
  TranslatedImageIndexRecord,
  TranslatedImageStoragePort,
} from '../../apps/extension/src/offscreen/translatedImageCacheStore';

/**
 * 内存版存储端口 —— 给 `translatedImageCacheStore` 与 `ImageVaultHost` 的单测用。
 *
 * 为什么要有它：真后端是 IndexedDB，而 vitest 跑在 **node 环境**（无 DOM、无 IDB，
 * 仓库也没装 `fake-indexeddb`）。把"存储端口"抽出来之后，**缓存本身的那套逻辑**
 * （索引、双上限淘汰、schema 校验、热层、失败传播）就能在 node 里被真实执行到，
 * 只剩一层薄薄的 IDB 调用封装没被单测覆盖。
 */
export type InMemoryStoragePort = {
  port: TranslatedImageStoragePort;
  /** 断言用窥视口（不参与生产逻辑）。 */
  peek(): {
    images: string[];
    index: TranslatedImageIndexRecord[];
    schemaVersion: number | undefined;
  };
  calls: { writes: number; removes: number; clears: number };
  /** 让后续调用按需失败，用来测"失败不许伪装成空"。 */
  failNext(message: string, times?: number): void;
};

export function createInMemoryStoragePort(
  options: { schemaVersion?: number } = {},
): InMemoryStoragePort {
  const blobs = new Map<string, Blob>();
  const index = new Map<string, TranslatedImageIndexRecord>();
  let schemaVersion = options.schemaVersion;
  const calls = { writes: 0, removes: 0, clears: 0 };
  let pendingFailure: { message: string; times: number } | null = null;

  function maybeFail(): void {
    if (!pendingFailure) return;
    pendingFailure.times -= 1;
    const message = pendingFailure.message;
    if (pendingFailure.times <= 0) pendingFailure = null;
    throw new Error(message);
  }

  const port: TranslatedImageStoragePort = {
    async readIndex(): Promise<TranslatedImageIndexRecord[]> {
      maybeFail();
      return [...index.values()].map((record) => ({ ...record }));
    },
    async read(key: string): Promise<Blob | undefined> {
      maybeFail();
      return blobs.get(key);
    },
    async write(record): Promise<void> {
      maybeFail();
      calls.writes += 1;
      blobs.set(record.key, record.blob);
      index.set(record.key, { key: record.key, bytes: record.bytes, seq: record.seq });
    },
    async remove(keys: readonly string[]): Promise<void> {
      maybeFail();
      calls.removes += 1;
      for (const key of keys) {
        blobs.delete(key);
        index.delete(key);
      }
    },
    async clearImages(): Promise<void> {
      maybeFail();
      calls.clears += 1;
      blobs.clear();
      index.clear();
    },
    async readSchemaVersion(): Promise<number | undefined> {
      maybeFail();
      return schemaVersion;
    },
    async writeSchemaVersion(version: number): Promise<void> {
      maybeFail();
      schemaVersion = version;
    },
  };

  return {
    port,
    peek: () => ({
      images: [...blobs.keys()],
      index: [...index.values()].map((record) => ({ ...record })),
      schemaVersion,
    }),
    calls,
    failNext: (message: string, times = 1) => {
      pendingFailure = { message, times };
    },
  };
}
