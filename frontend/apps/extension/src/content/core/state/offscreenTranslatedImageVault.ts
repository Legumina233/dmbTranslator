/**
 * 译图缓存的读写契约 —— 内容脚本只认这一层。
 *
 * ## 为什么每个方法都返回 `TranslatedImageVaultResult`（2026-10-10 修订）
 * 上一版所有方法**永不抛、失败即返回空**：读不到就 `[]`、取不到就 `undefined`。
 * 后果是真机上分不清两种截然不同的状态：
 *   · **缓存是空的**（正常：新页面、被淘汰、用户点过清空）；
 *   · **缓存不可达**（异常：宿主没起来 / 端口断了 / 超时）。
 * 两者的表现一模一样 —— 真机日志里 `vault:hydrate-ok count=0` 刷屏，实际是宿主失联
 * （背景事件 `vault-broker:host-unavailable`），排查时被读成"缓存被清空了"。
 * 现在**必须显式回答"读到了没有"**：`{status:'ok', value}` / `{status:'unavailable', reason}`。
 * 两条路径都不能抛（缓存是加速器，不是正确性依赖），但**不许再把失败伪装成空**。
 */

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

/** 缓存读写的两种结果 —— **不可达与空必须分开**（见文件头）。 */
export type TranslatedImageVaultResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unavailable'; reason: string };

export type TranslatedImageVaultPort = {
  /** 列出缓存里现有的全部页身份。**只读键**，不读 Blob。 */
  loadKeys(): Promise<TranslatedImageVaultResult<string[]>>;
  /** 取一张译图；没有则 `value: undefined`。 */
  get(key: string): Promise<TranslatedImageVaultResult<Blob | undefined>>;
  /** 落一张译图（同 key 覆盖），并把总量裁到上限内。 */
  put(key: string, blob: Blob): Promise<TranslatedImageVaultResult<void>>;
  /**
   * 改缓存的条数上限（调小则立刻裁）。
   *
   * 缓存分**两层**（内容脚本内存 + 落盘 IndexedDB），而"改上限"对一个用户
   * 动作只发生一次 —— 所以调用方 `TranslatorCore.setMemoryCacheLimit()` 两层一起改。
   */
  setLimit(limit: number): Promise<TranslatedImageVaultResult<void>>;
  /** 清空缓存。「清空译图缓存」用它，否则重载一次旧图会自己回来。 */
  clear(): Promise<TranslatedImageVaultResult<void>>;
};

/** 单次请求的上限。超过就判定"这条路不通"，不让调用方一直悬着。 */
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

function unavailable(reason: string): { status: 'unavailable'; reason: string } {
  return { status: 'unavailable', reason };
}

/**
 * 译图缓存后端：**扩展源的 IndexedDB**（经 background 转发到 off-screen 的读写代理）。
 *
 * ## 它修的是什么
 * 内容脚本的内存活不过一次文档销毁：e-hentai 阅读页刷新 / 站点自身整页重载都会走
 * `pagehide(persisted=false)` → `TranslatorCore.stop()` → 内存译图清零。
 * 译图落在 IndexedDB 后，**跨页面、跨 SW 重启、跨浏览器重启**都还在
 * （上一版放在 off-screen 文档的 JS 堆里，SW 一被回收就整体消失 —— 真机日志里
 * `vault-list size=5` 五秒后变 `size=0`）。
 *
 * ## 键为什么要加命名空间
 * 缓存是**所有站点共用一份**（同一个扩展源）。而键（`gid-page`）本身不带站点，
 * 两个站点用同一串 `gid-page` 就会互相串图 —— 所以给键加 `location.origin` 前缀，
 * 把"译图只在它来自的那个站点有意义"这条语义还原回来。
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
   * 三种结局都收敛成 `TranslatedImageVaultResult`：宿主明确成功 / 宿主明确失败 /
   * 通道本身不可用（连不上、断了、超时、上下文失效）。
   */
  const run = <T>(
    send: (requestId: string, port: ExtensionPort) => void,
    reduce: (
      message: ImageVaultHostMessage,
      settle: {
        ok: (value: T) => void;
        fail: (reason: string) => void;
      },
    ) => void,
  ): Promise<TranslatedImageVaultResult<T>> => {
    const runtime = getExtensionRuntime();
    if (!runtime) return Promise.resolve(unavailable('扩展上下文不可用'));
    let port: ExtensionPort;
    try {
      port = runtime.connect(IMAGE_VAULT_CLIENT_PORT);
    } catch (error) {
      return Promise.resolve(
        unavailable(`连接译图缓存通道失败: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    const requestId = createRequestId();
    return new Promise<TranslatedImageVaultResult<T>>((resolve) => {
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
      const finish = (result: TranslatedImageVaultResult<T>): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      function handleMessage(value: unknown): void {
        if (settled) return;
        if (!isImageVaultHostMessage(value) || value.requestId !== requestId) return;
        reduce(value, {
          ok: (result) => finish({ status: 'ok', value: result }),
          fail: (reason) => finish(unavailable(reason)),
        });
      }
      function handleDisconnect(): void {
        finish(unavailable('译图缓存通道已断开'));
      }
      timer = setTimeout(() => finish(unavailable(`译图缓存请求超时（${timeoutMs}ms）`)), timeoutMs);
      guardRegistration(() => port.onMessage.addListener(guardExtensionListener(handleMessage)));
      guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(handleDisconnect)));
      try {
        send(requestId, port);
      } catch (error) {
        finish(unavailable(`投递译图缓存请求失败: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  };

  return {
    async loadKeys(): Promise<TranslatedImageVaultResult<string[]>> {
      const result = await run<string[]>((requestId, port) => {
        port.postMessage({ type: 'vault-list', requestId } satisfies ImageVaultClientMessage);
      }, (message, settle) => {
        if (message.type === 'vault-keys') settle.ok(message.keys);
        else if (message.type === 'vault-failed') settle.fail(message.message);
      });
      if (result.status === 'unavailable') return result;
      // 只回本命名空间的键，并把前缀还原成内容脚本认得的原始键。
      return {
        status: 'ok',
        value: result.value
          .map(unscoped)
          .filter((key): key is string => key !== null),
      };
    },

    async get(key: string): Promise<TranslatedImageVaultResult<Blob | undefined>> {
      let assembler: Base64ChunkAssembler | null = null;
      let contentType = 'image/png';
      return run<Blob | undefined>((requestId, port) => {
        port.postMessage({
          type: 'vault-get',
          requestId,
          key: scoped(key),
        } satisfies ImageVaultClientMessage);
      }, (message, settle) => {
        switch (message.type) {
          case 'vault-image':
            if (!message.found) {
              settle.ok(undefined);
              return;
            }
            assembler = new Base64ChunkAssembler(message.meta);
            contentType = message.contentType;
            return;
          case 'vault-image-chunk':
            try {
              assembler?.add(message.index, message.data);
            } catch (error) {
              settle.fail(`译图分块重组失败: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          case 'vault-image-complete':
            if (!assembler) {
              settle.fail('译图分块不完整');
              return;
            }
            try {
              settle.ok(base64ToBlob(assembler.complete(), contentType));
            } catch (error) {
              settle.fail(`译图解码失败: ${error instanceof Error ? error.message : String(error)}`);
            }
            return;
          case 'vault-failed':
            settle.fail(message.message);
            return;
          default:
            return;
        }
      });
    },

    async put(key: string, blob: Blob): Promise<TranslatedImageVaultResult<void>> {
      let base64: string;
      try {
        base64 = await blobToBase64(blob);
      } catch (error) {
        return unavailable(`译图编码失败: ${error instanceof Error ? error.message : String(error)}`);
      }
      const chunks = splitBase64Chunks(base64);
      return run<void>((requestId, port) => {
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
      }, (message, settle) => {
        if (message.type === 'vault-stored') settle.ok(undefined);
        else if (message.type === 'vault-failed') settle.fail(message.message);
      });
    },

    async setLimit(limit: number): Promise<TranslatedImageVaultResult<void>> {
      return run<void>((requestId, port) => {
        port.postMessage({
          type: 'vault-set-limit',
          requestId,
          limit,
        } satisfies ImageVaultClientMessage);
      }, (message, settle) => {
        if (message.type === 'vault-limit-set') settle.ok(undefined);
        else if (message.type === 'vault-failed') settle.fail(message.message);
      });
    },

    async clear(): Promise<TranslatedImageVaultResult<void>> {
      return run<void>((requestId, port) => {
        port.postMessage({ type: 'vault-clear', requestId } satisfies ImageVaultClientMessage);
      }, (message, settle) => {
        if (message.type === 'vault-cleared') settle.ok(undefined);
        else if (message.type === 'vault-failed') settle.fail(message.message);
      });
    },
  };
}
