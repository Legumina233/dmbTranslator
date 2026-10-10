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
import type { TranslatedImageMemoryVault } from './translatedImageMemoryVault';

/**
 * off-screen 文档里的译图缓存宿主。
 *
 * 它只做一件事：把 background 转发来的请求翻译成对 `TranslatedImageMemoryVault` 的读写，
 * 并把结果回执出去。**它自己不持有缓存**（缓存由外部传入），这样 `PipelineHost`
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

  constructor(private readonly vault: TranslatedImageMemoryVault) {}

  connect(): void {
    let port: ExtensionPort;
    try {
      const runtime = getExtensionRuntime();
      if (!runtime) return;
      port = runtime.connect(IMAGE_VAULT_HOST_PORT);
    } catch (error) {
      // 扩展被重载/更新后，残留的旧文档连不上新实例 —— 静默退场（新实例自己会建新宿主）。
      if (isExtensionContextInvalidated(error)) return;
      throw error;
    }
    this.port = port;
    guardRegistration(() => port.onMessage.addListener(guardExtensionListener((message) => {
      void this.handleMessage(message);
    })));
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
    try {
      await this.apply(value);
    } catch (error) {
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
          keys: this.vault.listKeys(),
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
        this.vault.put(pending.key, base64ToBlob(pending.assembler.complete(), pending.contentType));
        this.post({ type: 'vault-stored', requestId: message.requestId });
        return;
      }
      case 'vault-set-limit':
        this.vault.setLimit(message.limit);
        this.post({ type: 'vault-limit-set', requestId: message.requestId });
        return;
      case 'vault-clear':
        this.vault.clear();
        this.post({ type: 'vault-cleared', requestId: message.requestId });
        return;
    }
  }

  private async replyImage(requestId: string, key: string): Promise<void> {
    const blob = this.vault.get(key);
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
