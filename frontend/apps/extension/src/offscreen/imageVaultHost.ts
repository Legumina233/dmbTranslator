import {
  Base64ChunkAssembler,
  base64ToBlob,
  blobToBase64,
  splitBase64Chunks,
  type LocalPipelineChunkMeta,
} from '@dmb/image-pipeline/protocol';
import {
  getExtensionRuntime,
  guardExtensionListener,
  guardRegistration,
  isExtensionContextInvalidated,
  type ExtensionPort,
} from '../shared/extensionRuntime';
import {
  IMAGE_VAULT_HOST_PORT,
  isImageVaultClientMessage,
  type ImageVaultClientMessage,
  type ImageVaultHostMessage,
} from '../shared/imageVaultProtocol';
import type { TranslatedImageCache } from './translatedImageCacheStore';
import { createProbe } from '../shared/probe';

/** 临时诊断探针（见 `shared/probe.ts`）：记录端口连接/断开与每次缓存请求。 */
const probe = createProbe('offscreen');

/** 端口断线后的重连上限与退避间隔。 */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 500;

/**
 * off-screen 文档里的译图缓存宿主。
 *
 * 它只做一件事：把 background 转发来的请求翻译成对 `TranslatedImageCache`（落盘 IndexedDB）
 * 的读写，并把结果回执出去。**它自己不持有缓存**（缓存由外部传入），这样 `PipelineHost`
 * 也能拿着同一个实例判断"该不该为了保缓存而拒绝空闲关闭" —— 两边看的是同一份真相。
 *
 * 容错口径与内存层一致：任何一步失败都只回一条 `vault-failed`，**不抛**出去。
 * 缓存读写的失败不该让 off-screen 文档或页面上的翻译任务受牵连。
 */
export class ImageVaultHost {
  private port: ExtensionPort | null = null;
  /** 收集中、尚未 complete 的 `vault-put`。 */
  private readonly incoming = new Map<string, {
    key: string;
    contentType: string;
    assembler: Base64ChunkAssembler;
  }>();
  /**
   * 端口断线后的重连计数 / 定时器。
   *
   * ★ 2026-10-10 起**会重连**（上一版故意不重连，只把现象记下来）。
   *   为什么必须重连：background 的 service worker 会被回收，端口随之断开；
   *   而本文档（off-screen）不一定同时消失。不重连的话，缓存通道从此永久失效 ——
   *   真机表现就是"刷新后什么都没了"。重连本身也会**唤醒** SW（消息就是活动）。
   *   上限 `MAX_RECONNECT_ATTEMPTS`：真的是扩展被重载/上下文失效时，重试没有意义，
   *   由 `isExtensionContextInvalidated` 判定后直接退场。
   */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly vault: TranslatedImageCache) {}

  connect(): void {
    if (this.port) return;
    let port: ExtensionPort;
    try {
      const runtime = getExtensionRuntime();
      if (!runtime) {
        probe('vault-host:connect-skipped', { reason: 'no-runtime' });
        return;
      }
      port = runtime.connect(IMAGE_VAULT_HOST_PORT);
    } catch (error) {
      probe('vault-host:connect-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      // 扩展被重载/更新后，残留的旧文档连不上新实例 —— 静默退场（新实例自己会建新宿主）。
      if (isExtensionContextInvalidated(error)) return;
      throw error;
    }
    this.port = port;
    this.reconnectAttempts = 0;
    probe('vault-host:connect', { port: IMAGE_VAULT_HOST_PORT });
    guardRegistration(() => port.onMessage.addListener(guardExtensionListener((message) => {
      void this.handleMessage(message);
    })));
    guardRegistration(() => port.onDisconnect.addListener(guardExtensionListener(() => {
      const wasCurrentPort = this.port === port;
      probe('vault-host:port-disconnected', { wasCurrentPort, attempts: this.reconnectAttempts });
      if (wasCurrentPort) this.port = null;
      if (wasCurrentPort) this.scheduleReconnect();
    })));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      probe('vault-host:reconnect-given-up', { attempts: this.reconnectAttempts });
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      probe('vault-host:reconnect-attempt', { attempt });
      try {
        this.connect();
      } catch {
        // connect() 自己已经记过现场；再排一次（次数上限兜底）。
        this.scheduleReconnect();
      }
    }, RECONNECT_DELAY_MS);
  }

  private post(message: ImageVaultHostMessage): void {
    try {
      this.port?.postMessage(message);
    } catch {
      // 通道已断：结果没人收了，缓存本身的写入仍然生效（它是本地的）。
    }
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isImageVaultClientMessage(value)) return;
    // 探针：每次请求到达时顺手记下**当前真实条数** ——
    // "请求到底有没有到宿主"和"数据还在不在"就能从同一行读到。
    probe('vault-host:request', {
      type: value.type,
      key: 'key' in value ? value.key : undefined,
      size: this.vault.size(),
    });
    const t0 = probe.mark();
    try {
      await this.apply(value);
      // 探针：宿主侧的应答耗时（读 Map + base64 编码 + 分块发回）。
      // 与 content 侧 `vault:materialize-ok` 的 dur_ms 相减，就是纯通道开销。
      probe.timed('vault-host:responded', t0, { type: value.type, ok: true });
    } catch (error) {
      probe.timed('vault-host:responded', t0, {
        type: value.type,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      this.post({
        type: 'vault-failed',
        requestId: value.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async apply(message: ImageVaultClientMessage): Promise<void> {
    switch (message.type) {
      case 'vault-list':
        this.post({
          type: 'vault-keys',
          requestId: message.requestId,
          keys: await this.vault.listKeys(),
        });
        return;
      case 'vault-get':
        await this.replyImage(message.requestId, message.key);
        return;
      case 'vault-put':
        // 分块重组是异步到达的，状态挂在 `incoming` 上（一次请求一份）。
        this.incoming.set(message.requestId, {
          key: message.key,
          contentType: message.contentType,
          assembler: new Base64ChunkAssembler(message.meta),
        });
        return;
      case 'vault-put-chunk': {
        const pending = this.incoming.get(message.requestId);
        if (!pending) {
          // 没有对应的 vault-put 只有两种来路：协议被违反，或者宿主中途被重建过
          // （进行中的那次上传随旧文档一起没了）。两种都不可能再成功 —— 直接了结，
          // 别让内容脚本干等到超时。
          this.post({
            type: 'vault-failed',
            requestId: message.requestId,
            message: '上传请求已失效',
          });
          return;
        }
        pending.assembler.add(message.index, message.data);
        return;
      }
      case 'vault-put-complete': {
        const pending = this.incoming.get(message.requestId);
        if (!pending) {
          this.post({
            type: 'vault-failed',
            requestId: message.requestId,
            message: '上传请求已失效',
          });
          return;
        }
        this.incoming.delete(message.requestId);
        await this.vault.put(
          pending.key,
          base64ToBlob(pending.assembler.complete(), pending.contentType),
        );
        this.post({ type: 'vault-stored', requestId: message.requestId });
        return;
      }
      case 'vault-set-limit':
        await this.vault.setLimit(message.limit);
        this.post({ type: 'vault-limit-set', requestId: message.requestId });
        return;
      case 'vault-clear':
        await this.vault.clear();
        this.post({ type: 'vault-cleared', requestId: message.requestId });
        return;
    }
  }

  private async replyImage(requestId: string, key: string): Promise<void> {
    const blob = await this.vault.get(key);
    if (!blob) {
      this.post({ type: 'vault-image', requestId, found: false });
      return;
    }
    const base64 = await blobToBase64(blob);
    const chunks = splitBase64Chunks(base64);
    const meta: LocalPipelineChunkMeta = {
      chunkCount: chunks.length,
      totalChars: base64.length,
    };
    this.post({
      type: 'vault-image',
      requestId,
      found: true,
      contentType: blob.type || 'image/png',
      meta,
    });
    chunks.forEach((data, index) => {
      this.post({ type: 'vault-image-chunk', requestId, index, data });
    });
    this.post({ type: 'vault-image-complete', requestId });
  }
}
