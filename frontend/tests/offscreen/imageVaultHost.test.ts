import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtensionPort } from '../../apps/extension/src/shared/extensionRuntime';
import { ImageVaultHost } from '../../apps/extension/src/offscreen/imageVaultHost';
import {
  createTranslatedImageCache,
  type TranslatedImageCache,
} from '../../apps/extension/src/offscreen/translatedImageCacheStore';
import { createInMemoryStoragePort } from '../helpers/inMemoryTranslatedImageStoragePort';
import { IMAGE_VAULT_HOST_PORT } from '../../apps/extension/src/shared/imageVaultProtocol';

/**
 * Node 没有 FileReader，而 `blobToBase64` 走的是它。
 * 补一个最小实现，好处是**真实**的 base64 编解码路径仍然被测到（不是把它 mock 掉）。
 */
class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer()
      .then((buffer) => {
        const binary = Buffer.from(buffer).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${binary}`;
        this.onload?.();
      })
      .catch(() => {
        this.onerror?.();
      });
  }
}

class FakePort implements ExtensionPort {
  readonly name = IMAGE_VAULT_HOST_PORT;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly messageListeners: Array<(message: unknown, port: ExtensionPort) => void> = [];
  disconnected = false;

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('port disconnected');
    this.sent.push(message as Record<string, unknown>);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  onMessage = {
    addListener: (listener: (message: unknown, port: ExtensionPort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  onDisconnect = {
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
  };

  emit(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message, this);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('ImageVaultHost', () => {
  let port: FakePort;
  let vault: TranslatedImageCache;
  let originalChrome: unknown;
  let originalFileReader: unknown;

  beforeEach(() => {
    port = new FakePort();
    // 用**真实的缓存实现** + 内存存储端口：宿主这一层的读写/淘汰语义被真实执行到，
    // 只有最底下那层 IndexedDB 调用被替换（node 环境没有 IDB）。
    vault = createTranslatedImageCache({ port: createInMemoryStoragePort().port, limit: 15 });
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: () => port },
    };
    (globalThis as { FileReader?: unknown }).FileReader = TestFileReader;
    new ImageVaultHost(vault).connect();
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as { FileReader?: unknown }).FileReader = originalFileReader;
    port.disconnect();
  });

  async function putImage(requestId: string, key: string, text: string): Promise<void> {
    const base64 = Buffer.from(text).toString('base64');
    port.emit({
      type: 'vault-put',
      requestId,
      key,
      contentType: 'image/png',
      meta: { chunkCount: 1, totalChars: base64.length },
    });
    port.emit({ type: 'vault-put-chunk', requestId, index: 0, data: base64 });
    port.emit({ type: 'vault-put-complete', requestId });
    await flush();
  }

  it('stores an uploaded image and reports it back', async () => {
    await putImage('r1', 'page-1', 'hello');

    expect(await vault.get('page-1')).toBeInstanceOf(Blob);
    expect(port.sent).toContainEqual({ type: 'vault-stored', requestId: 'r1' });
  });

  it('returns the stored image as a chunked payload', async () => {
    await putImage('r1', 'page-1', 'hello');
    port.sent.length = 0;

    port.emit({ type: 'vault-get', requestId: 'r2', key: 'page-1' });
    await flush();

    const meta = port.sent.find((message) => message.type === 'vault-image');
    expect(meta).toMatchObject({ type: 'vault-image', requestId: 'r2', found: true, contentType: 'image/png' });
    const chunks = port.sent.filter((message) => message.type === 'vault-image-chunk');
    expect(chunks).toHaveLength(1);
    expect(port.sent.at(-1)).toEqual({ type: 'vault-image-complete', requestId: 'r2' });
    const reassembled = Buffer.from(String(chunks[0]?.data), 'base64').toString();
    expect(reassembled).toBe('hello');
  });

  it('reports a miss without sending any chunk', async () => {
    port.emit({ type: 'vault-get', requestId: 'r1', key: '缺席' });
    await flush();

    expect(port.sent).toEqual([{ type: 'vault-image', requestId: 'r1', found: false }]);
  });

  it('lists keys and clears the store', async () => {
    await vault.put('a', new Blob(['a']));
    await vault.put('b', new Blob(['b']));

    port.emit({ type: 'vault-list', requestId: 'r1' });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: 'vault-keys', requestId: 'r1', keys: ['a', 'b'] });

    port.emit({ type: 'vault-clear', requestId: 'r2' });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: 'vault-cleared', requestId: 'r2' });
    expect(vault.size()).toBe(0);
  });

  it('applies a new entry limit and evicts down to it', async () => {
    for (const key of ['a', 'b', 'c', 'd']) await vault.put(key, new Blob([key]));

    port.emit({ type: 'vault-set-limit', requestId: 'r1', limit: 2 });
    await flush();
    expect(port.sent.at(-1)).toEqual({ type: 'vault-limit-set', requestId: 'r1' });
    // 调小 = 立刻裁，而不是等下一次写入。
    expect(vault.size()).toBe(2);
    await expect(vault.listKeys()).resolves.toEqual(['c', 'd']);
  });

  it('fails the request instead of throwing when the chunk stream is incomplete', async () => {
    port.emit({
      type: 'vault-put',
      requestId: 'r1',
      key: 'k',
      contentType: 'image/png',
      meta: { chunkCount: 2, totalChars: 8 },
    });
    port.emit({ type: 'vault-put-chunk', requestId: 'r1', index: 0, data: 'AQ==' });
    port.emit({ type: 'vault-put-complete', requestId: 'r1' });
    await flush();

    expect(port.sent.at(-1)).toMatchObject({ type: 'vault-failed', requestId: 'r1' });
    expect(vault.size()).toBe(0);
  });

  it('fails orphan upload continuations without killing the channel', async () => {
    // 宿主中途被重建时，进行中的上传会在新文档里"没有开头" —— 必须立刻了结，
    // 否则内容脚本只能干等到 20s 超时。
    port.emit({ type: 'vault-put-chunk', requestId: 'orphan', index: 0, data: 'AQ==' });
    await flush();

    expect(port.sent).toEqual([{
      type: 'vault-failed',
      requestId: 'orphan',
      message: '上传请求已失效',
    }]);

    port.emit({ type: 'vault-put-complete', requestId: 'orphan2' });
    await flush();
    expect(port.sent.at(-1)).toMatchObject({ type: 'vault-failed', requestId: 'orphan2' });

    // 通道仍然活着：正常请求照常处理。
    port.sent.length = 0;
    port.emit({ type: 'vault-list', requestId: 'r1' });
    await flush();
    expect(port.sent).toEqual([{ type: 'vault-keys', requestId: 'r1', keys: [] }]);
  });

  it('ignores malformed messages without killing the channel', async () => {
    port.emit({ type: 'nonsense' });
    port.emit('字符串');
    port.emit({ type: 'vault-get', requestId: '', key: 'k' });

    expect(port.sent).toEqual([]);
    port.emit({ type: 'vault-list', requestId: 'r1' });
    await flush();
    expect(port.sent).toEqual([{ type: 'vault-keys', requestId: 'r1', keys: [] }]);
  });

  it('stays silent when the extension context was invalidated', () => {
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => {
          throw new Error('Extension context invalidated.');
        },
      },
    };
    const host = new ImageVaultHost(
      createTranslatedImageCache({ port: createInMemoryStoragePort().port }),
    );

    expect(() => host.connect()).not.toThrow();
  });
});
