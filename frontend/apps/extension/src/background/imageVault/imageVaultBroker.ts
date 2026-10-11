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
import { createProbe } from '../../shared/probe';

/** 临时诊断探针（见 `shared/probe.ts`）。 */
const probe = createProbe('background');

/**
 * 等 off-screen 文档把译图缓存宿主端口接上来的上限。
 *
 * ★ 2026-10-10：从 10s 降到 2s。真机事故（15:47:07）里这条链路让**页面加载卡了 8168ms**，
 * 而当时的真相是"宿主根本起不来"——等 10 秒不会让它起来，只会让用户多等。
 * 缓存是加速器：拿不到就该**快速退回"无缓存"**，而不是拖住主流程。
 */
export const IMAGE_VAULT_HOST_CONNECT_TIMEOUT_MS = 2_000;

/**
 * 强制复位后**第二次**等端口的上限。
 *
 * 比第一次短：这一步的前提是"文档刚被我们亲手关掉、刚重新创建"，真机里
 * `offscreen:document-loaded` → `host-attached` 只隔 4ms（15:44:41.271 → .275），
 * 所以 1 秒足够；再等不到就说明重建也失败了，早点让调用方退回"无缓存"。
 */
export const IMAGE_VAULT_HOST_RECOVER_TIMEOUT_MS = 1_000;

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
    probe('vault-broker:host-attached');
    guardRegistration(() => port.onMessage.addListener(guardExtensionListener((message) => {
      this.handleHostMessage(port, message);
    })));
    guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(() => {
      if (this.hostPort !== port) return;
      this.hostPort = null;
      probe('vault-broker:host-disconnected', { pending: this.pending.size });
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
    probe('vault-broker:client-attached');
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
      probe('vault-broker:host-unavailable', { requestId, type: value.type });
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
      this.creationPromise = this.attachHostWithRecovery()
        .catch(() => undefined)
        .finally(() => {
          this.creationPromise = null;
        });
    }
    return this.creationPromise.then(() => this.hostPort);
  }

  /**
   * 建宿主 → 等端口；**等不到就强制复位一次再试**。
   *
   * ★ 2026-10-10（真机事故 15:46–15:48）：`lifecycle.ensureHost()` 内部先问 `hasHost()`，
   *   而 `hasHost()` **只判断"这个文档存不存在"**，不判断"我们的宿主有没有把端口接上来"。
   *   service worker 重启之后，`getContexts()` 可能仍报一个连不上来的**僵尸文档**：
   *   于是 `ensureHost()` 直接 return、**永不** `createDocument()`，我们只能干等超时。
   *   日志指纹：7 次 `ensure-host-start` / **0 次** `offscreen:document-loaded` / 6 次
   *   `host-unavailable` —— 缓存就此永久不可达（"刷新后什么都没了"）。
   *
   *   处置与 `PipelineHostBroker.ensurePipelineHost()` 同款：`closeDocument()` 掉那个文档
   *   → 清掉本地端口引用 → 重新 `createDocument()` → 再等一次。
   *
   *   代价要说清楚：**关文档会连带结束同文档里的流水线宿主**（两者共用一个 off-screen 文档）。
   *   所以这一步只在"等了 `IMAGE_VAULT_HOST_CONNECT_TIMEOUT_MS` 仍无人应答"时才做 ——
   *   那个状态本身就说明这个文档用不了；而且重试窗口取得很短（见下面的常量）。
   */
  private async attachHostWithRecovery(): Promise<void> {
    probe('vault-broker:ensure-host-start');
    await this.lifecycle.ensureHost();
    await this.waitForHost();
    if (this.hostPort) return;

    probe('vault-broker:host-reset');
    try {
      await this.lifecycle.closeHost();
    } catch {
      // 它可能已经自己消失了：这里失败不影响后面的重建。
    }
    this.hostPort = null;
    try {
      await this.lifecycle.ensureHost();
    } catch {
      // 建不出来就走下面的兜底（和"没建出来"一样处理）。
    }
    await this.waitForHost(IMAGE_VAULT_HOST_RECOVER_TIMEOUT_MS);
    if (!this.hostPort) probe('vault-broker:host-reset-failed');
  }

  private waitForHost(timeoutMs: number = IMAGE_VAULT_HOST_CONNECT_TIMEOUT_MS): Promise<void> {
    if (this.hostPort) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.hostWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.hostWaiter = null;
          probe('vault-broker:host-timeout', { ms: timeoutMs });
          resolve();
        }, timeoutMs),
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
