import {
  Base64ChunkAssembler,
  base64ToBlob,
  blobToBase64,
  splitBase64Chunks,
} from '@dmb/image-pipeline/protocol';
import {
  getExtensionRuntime,
  guardExtensionListener,
  guardRegistration,
  type ExtensionPort,
} from '../../../shared/extensionRuntime';
import {
  IMAGE_VAULT_CLIENT_PORT,
  isImageVaultHostMessage,
  type ImageVaultClientMessage,
  type ImageVaultHostMessage,
} from '../../../shared/imageVaultProtocol';

/**
 * 译图缓存的读写契约 —— 内容脚本只认这一层。
 *
 * 约定：所有方法**不抛**。读不到就当空缓存（退回重跑管线），写不进就只是没缓存；
 * 缓存是加速器，不是正确性依赖。
 */
export type TranslatedImageVaultPort = {
  /** 列出缓存里现有的全部页身份。**只读键**，不读 Blob。 */
  loadKeys(): Promise<string[]>;
  /** 取一张译图；没有则 `undefined`。 */
  get(key: string): Promise<Blob | undefined>;
  /** 落一张译图（同 key 覆盖），并把总量裁到上限内。 */
  put(key: string, blob: Blob): Promise<void>;
  /**
   * 改缓存的条数上限（调小则立刻裁）。
   *
   * 缓存分**两层**（内容脚本内存 + off-screen 文档内存），而"改上限"对一个用户
   * 动作只发生一次 —— 所以调用方 `TranslatorCore.setMemoryCacheLimit()` 两层一起改。
   */
  setLimit(limit: number): Promise<void>;
  /** 清空缓存。「清空译图缓存」用它，否则重载一次旧图会自己回来。 */
  clear(): Promise<void>;
};

/** 单次请求的上限。超过就当这条路不通、退回"无缓存"，不让调用方一直悬着。 */
const defaultRequestTimeoutMs = 20_000;

function resolveNamespace(): string {
  try {
    return globalThis.location?.origin ?? '';
  } catch {
    return '';
  }
}

function createRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `vault-${crypto.randomUUID()}`
    : `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 译图缓存后端：**off-screen 文档里的内存 Map**（经 background 转发）。
 *
 * ## 它修的是什么
 * 内容脚本的内存活不过一次文档销毁：e-hentai 阅读页翻页 / 站点自身整页重载都会走
 * `pagehide(persisted=false)` → `TranslatorCore.stop()` → 内存译图清零。
 * 译图改放在 off-screen 文档（扩展源、不随页面导航生灭）后，重载回来仍是瞬时命中。
 *
 * ## 键为什么要加命名空间
 * off-screen 文档是扩展源，**所有站点共用同一个缓存**。而键（`gid-page`）本身不带站点，
 * 两个站点用同一串 `gid-page` 就会互相串图 —— 所以给键加 `location.origin` 前缀，
 * 把"译图只在它来自的那个站点有意义"这条语义还原回来。
 *
 * ## 容错
 * 一律**不抛**：宿主不可用 / 超时 / 通道断开都退化成"没有缓存"。
 */
export function createOffscreenTranslatedImageVault(options: {
  /** 键命名空间，默认取本页 `location.origin`（见上"键为什么要加命名空间"）。 */
  namespace?: string;
  timeoutMs?: number;
} = {}): TranslatedImageVaultPort {
  const namespace = options.namespace ?? resolveNamespace();
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;

  const scoped = (key: string): string => (namespace ? `${namespace}::${key}` : key);
  const unscoped = (stored: string): string | null => {
    if (!namespace) return stored;
    const prefix = `${namespace}::`;
    return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
  };

  /**
   * 开一条只用一次的端口，跑完即断。
   *
   * 为什么一次一连接：缓存的读写频率是"每译好一张写一次、每挂载一页读一次"，
   * 常驻端口换来的只是"页面卸载时要记得断"这一堆生命周期负担。
   *
   * `send` 在监听挂好之后才被调用，因此**不会漏掉宿主的第一条回执**。
   */
  const run = <T>(
    send: (requestId: string, port: ExtensionPort) => void,
    reduce: (message: ImageVaultHostMessage, done: (value: T | undefined) => void) => void,
  ): Promise<T | undefined> => {
    const runtime = getExtensionRuntime();
    if (!runtime) return Promise.resolve(undefined);
    let port: ExtensionPort;
    try {
      port = runtime.connect(IMAGE_VAULT_CLIENT_PORT);
    } catch {
      return Promise.resolve(undefined);
    }
    const requestId = createRequestId();
    return new Promise<T | undefined>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer);
        // 收尾本身**绝不允许抛**：一抛就会跳过下面的 resolve，Promise 永远悬着。
        try {
          port.onMessage.removeListener?.(handleMessage);
          port.onDisconnect.removeListener?.(handleDisconnect);
          port.disconnect();
        } catch {
          // 上下文已失效 / 端口已断开 —— 都是收尾时的正常情况
        }
      };
      const finish = (value: T | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      function handleMessage(value: unknown): void {
        if (settled) return;
        if (!isImageVaultHostMessage(value) || value.requestId !== requestId) return;
        reduce(value, finish);
      }
      function handleDisconnect(): void {
        finish(undefined);
      }
      timer = setTimeout(() => finish(undefined), timeoutMs);
      guardRegistration(() => port.onMessage.addListener(guardExtensionListener(handleMessage)));
      guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(handleDisconnect)));
      try {
        send(requestId, port);
      } catch {
        finish(undefined);
      }
    });
  };

  return {
    async loadKeys(): Promise<string[]> {
      const keys = await run<string[]>((requestId, port) => {
        port.postMessage({ type: 'vault-list', requestId } satisfies ImageVaultClientMessage);
      }, (message, done) => {
        if (message.type === 'vault-keys') done(message.keys);
        else if (message.type === 'vault-failed') done(undefined);
      });
      if (!keys) return [];
      // 只回本命名空间的键，并把前缀还原成内容脚本认得的原始键。
      return keys
        .map(unscoped)
        .filter((key): key is string => key !== null);
    },

    async get(key: string): Promise<Blob | undefined> {
      let assembler: Base64ChunkAssembler | null = null;
      let contentType = 'image/png';
      return run<Blob | undefined>((requestId, port) => {
        port.postMessage({
          type: 'vault-get',
          requestId,
          key: scoped(key),
        } satisfies ImageVaultClientMessage);
      }, (message, done) => {
        switch (message.type) {
          case 'vault-image':
            if (!message.found) {
              done(undefined);
              return;
            }
            assembler = new Base64ChunkAssembler(message.meta);
            contentType = message.contentType;
            return;
          case 'vault-image-chunk':
            try {
              assembler?.add(message.index, message.data);
            } catch {
              done(undefined);
            }
            return;
          case 'vault-image-complete':
            if (!assembler) {
              done(undefined);
              return;
            }
            try {
              done(base64ToBlob(assembler.complete(), contentType));
            } catch {
              done(undefined);
            }
            return;
          case 'vault-failed':
            done(undefined);
            return;
          default:
            return;
        }
      });
    },

    async put(key: string, blob: Blob): Promise<void> {
      let base64: string;
      try {
        base64 = await blobToBase64(blob);
      } catch {
        return;
      }
      const chunks = splitBase64Chunks(base64);
      await run<void>((requestId, port) => {
        port.postMessage({
          type: 'vault-put',
          requestId,
          key: scoped(key),
          contentType: blob.type || 'image/png',
          meta: { chunkCount: chunks.length, totalChars: base64.length },
        } satisfies ImageVaultClientMessage);
        chunks.forEach((data, index) => {
          port.postMessage({
            type: 'vault-put-chunk',
            requestId,
            index,
            data,
          } satisfies ImageVaultClientMessage);
        });
        port.postMessage({ type: 'vault-put-complete', requestId } satisfies ImageVaultClientMessage);
      }, (message, done) => {
        if (message.type === 'vault-stored' || message.type === 'vault-failed') done(undefined);
      });
    },

    async setLimit(limit: number): Promise<void> {
      await run<void>((requestId, port) => {
        port.postMessage({
          type: 'vault-set-limit',
          requestId,
          limit,
        } satisfies ImageVaultClientMessage);
      }, (message, done) => {
        if (message.type === 'vault-limit-set' || message.type === 'vault-failed') done(undefined);
      });
    },

    async clear(): Promise<void> {
      await run<void>((requestId, port) => {
        port.postMessage({ type: 'vault-clear', requestId } satisfies ImageVaultClientMessage);
      }, (message, done) => {
        if (message.type === 'vault-cleared' || message.type === 'vault-failed') done(undefined);
      });
    },
  };
}
