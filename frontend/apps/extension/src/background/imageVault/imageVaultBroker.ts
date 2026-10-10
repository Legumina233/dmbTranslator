import type { ExtensionPort } from '../../shared/extensionRuntime';
import { guardExtensionListener, guardRegistration } from '../../shared/extensionRuntime';
import {
  IMAGE_VAULT_CLIENT_PORT,
  IMAGE_VAULT_HOST_PORT,
  isImageVaultClientMessage,
  isImageVaultHostMessage,
  isImageVaultTerminalMessage,
  type ImageVaultClientMessage,
} from '../../shared/imageVaultProtocol';
import type { PipelineHostLifecycle } from '../localPipeline/pipelineHostLifecycle';

/** 等 off-screen 文档把译图缓存宿主端口接上来的上限（与流水线宿主的连接超时同量级）。 */
export const IMAGE_VAULT_HOST_CONNECT_TIMEOUT_MS = 10_000;

/**
 * 等宿主端口的等待者。**同时最多一个**：`ensureHost()` 是单飞的（`creationPromise`），
 * 每个创建周期只会 `waitForHost()` 一次，其余并发调用者复用的是同一个 promise。
 */
type HostWaiter = {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
};

function safelyPost(port: ExtensionPort, message: unknown): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * 译图缓存的跨进程路由：content ↔ background ↔ off-screen。
 *
 * ## 它为什么不自己监听 `runtime.onConnect`
 * `PipelineHostBroker` 是端口命名空间的唯一所有者（它认得名字就接管，不认得就断开）。
 * 这里再挂一个 `onConnect` 只会得到一份"已经被对面断掉"的端口。所以本类是**被委托**的：
 * `PipelineHostBroker.handlePort` 在认出流水线端口之后、兜底断开之前，把端口交给
 * 它注册进来的处理器（见 `registerPortHandler`）。
 *
 * ## 为什么要保证投递顺序
 * 一条 `vault-put` 后面跟着若干 `vault-put-chunk`，乱序到达 = 分块校验必然失败。
 * 这里靠一个性质保持顺序：每条消息在投递前都 `await` **同一个** `ensureHost()` promise，
 * promise 的续体按注册顺序（即消息到达顺序）执行，因此宿主收到的顺序与内容脚本发出的顺序一致。
 *
 * ## 缓存丢了怎么办
 * 一律**静默降级**：宿主不可用 / 超时 → 回一条 `vault-failed`，内容脚本把这一次读写当成
 * "空缓存"（读不到 → 退回重跑管线；写不进 → 只是没缓存）。缓存是加速器，不是正确性依赖。
 */
export class ImageVaultBroker {
  private hostPort: ExtensionPort | null = null;
  /** `requestId` → 发起它的内容脚本端口（回执按原路返回）。 */
  private readonly pending = new Map<string, ExtensionPort>();
  private hostWaiter: HostWaiter | null = null;
  private creationPromise: Promise<void> | null = null;

  /**
   * `lifecycle` 必须显式传入：译图缓存与本地流水线**共用同一份 off-screen 文档**，
   * 但两者要的"宿主"不是一回事 —— 这里只要文档存在、有人把缓存端口接上来。
   *
   * 所以 Chromium 传 `ChromiumPipelineHostLifecycle`（就是"把 offscreen.html 拉起来"），
   * Firefox 也传它：那边没有 off-screen 文档，`ensureHost()` 会立刻抛
   * `PIPELINE_HOST_UNAVAILABLE` → 缓存整条链路快速降级成"没有缓存"（行为等同加缓存之前），
   * **而不是**顺手把 Firefox 那个进程内流水线宿主拉起来再等一个永远不会来的端口。
   */
  constructor(private readonly lifecycle: PipelineHostLifecycle) {}

  /** 认得这个端口就接管并返回 true；不认得原样交还给调用方。 */
  handlePort(port: ExtensionPort): boolean {
    if (port.name === IMAGE_VAULT_HOST_PORT) {
      this.attachHost(port);
      return true;
    }
    if (port.name === IMAGE_VAULT_CLIENT_PORT) {
      this.attachClient(port);
      return true;
    }
    return false;
  }

  private attachHost(port: ExtensionPort): void {
    if (!this.lifecycle.matchesHostPort(port)) {
      port.disconnect();
      return;
    }
    if (this.hostPort && this.hostPort !== port) {
      this.hostPort.disconnect();
    }
    this.hostPort = port;
    guardRegistration(() => port.onMessage.addListener(guardExtensionListener((message) => {
      this.handleHostMessage(port, message);
    })));
    guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(() => {
      if (this.hostPort !== port) return;
      this.hostPort = null;
      // 宿主没了就没有人能回执了：把在途请求全部就地了结，别让内容脚本等到超时。
      for (const [requestId, client] of [...this.pending]) {
        this.pending.delete(requestId);
        safelyPost(client, {
          type: 'vault-failed',
          requestId,
          message: '译图缓存宿主已断开',
        });
      }
    })));
    this.settleHostWaiter();
  }

  private attachClient(port: ExtensionPort): void {
    guardRegistration(() => port.onMessage.addListener(guardExtensionListener((message) => {
      void this.handleClientMessage(port, message);
    })));
    guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(() => {
      this.releaseClient(port);
    })));
  }

  private releaseClient(port: ExtensionPort): void {
    for (const [requestId, client] of [...this.pending]) {
      if (client === port) this.pending.delete(requestId);
    }
  }

  private async handleClientMessage(client: ExtensionPort, value: unknown): Promise<void> {
    if (!isImageVaultClientMessage(value)) return;
    const requestId = value.requestId;
    const owner = this.pending.get(requestId);
    if (isRequestOpening(value)) {
      // requestId 由内容脚本生成；同一个 ID 来自第二条连接只可能是串号 —— 拒绝，别覆盖归属。
      if (owner && owner !== client) return;
      this.pending.set(requestId, client);
    } else if (owner !== client) {
      // 分块 / 收尾必须来自发起该请求的那条连接。
      return;
    }

    const host = await this.ensureHost();
    if (!host) {
      this.pending.delete(requestId);
      safelyPost(client, {
        type: 'vault-failed',
        requestId,
        message: '译图缓存宿主不可用',
      });
      return;
    }
    if (!safelyPost(host, value)) {
      this.pending.delete(requestId);
      if (this.hostPort === host) this.hostPort = null;
      safelyPost(client, {
        type: 'vault-failed',
        requestId,
        message: '向译图缓存宿主投递失败',
      });
    }
  }

  private handleHostMessage(host: ExtensionPort, value: unknown): void {
    if (host !== this.hostPort || !isImageVaultHostMessage(value)) return;
    const client = this.pending.get(value.requestId);
    if (!client) return;
    if (isImageVaultTerminalMessage(value)) this.pending.delete(value.requestId);
    safelyPost(client, value);
  }

  private ensureHost(): Promise<ExtensionPort | null> {
    if (this.hostPort) return Promise.resolve(this.hostPort);
    if (!this.creationPromise) {
      this.creationPromise = (async () => {
        await this.lifecycle.ensureHost();
        await this.waitForHost();
      })()
        .catch(() => undefined)
        .finally(() => {
          this.creationPromise = null;
        });
    }
    return this.creationPromise.then(() => this.hostPort);
  }

  private waitForHost(): Promise<void> {
    if (this.hostPort) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.hostWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.hostWaiter = null;
          resolve();
        }, IMAGE_VAULT_HOST_CONNECT_TIMEOUT_MS),
      };
    });
  }

  /** 宿主接上来了（或这条路由已不再需要它）—— 放行等待者。 */
  private settleHostWaiter(): void {
    const waiter = this.hostWaiter;
    if (!waiter) return;
    this.hostWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

/** 请求的**首条**消息（其余都是续投）。 */
function isRequestOpening(message: ImageVaultClientMessage): boolean {
  return message.type === 'vault-list'
    || message.type === 'vault-get'
    || message.type === 'vault-put'
    || message.type === 'vault-clear';
}
