import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionPort } from '../../../../apps/extension/src/shared/extensionRuntime';
import { createOffscreenTranslatedImageVault } from '../../../../apps/extension/src/content/core/state/offscreenTranslatedImageVault';
import { IMAGE_VAULT_CLIENT_PORT } from '../../../../apps/extension/src/shared/imageVaultProtocol';

/** Node 没有 FileReader，而 `put` 的 base64 编码走的正是它（见 imageVaultHost.test.ts）。 */
class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      })
      .catch(() => this.onerror?.());
  }
}

class FakePort implements ExtensionPort {
  readonly name = IMAGE_VAULT_CLIENT_PORT;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly messageListeners: Array<(message: unknown, port: ExtensionPort) => void> = [];
  readonly disconnectListeners: Array<(port: ExtensionPort) => void> = [];
  disconnected = false;

  postMessage(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener(this);
  }

  onMessage = {
    addListener: (listener: (message: unknown, port: ExtensionPort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  onDisconnect = {
    addListener: (listener: (port: ExtensionPort) => void): void => {
      this.disconnectListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  emit(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message, this);
  }

  requestId(): string {
    return String(this.sent[0]?.requestId);
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('createOffscreenTranslatedImageVault', () => {
  let ports: FakePort[];
  let originalChrome: unknown;
  let originalFileReader: unknown;

  beforeEach(() => {
    ports = [];
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    originalFileReader = (globalThis as { FileReader?: unknown }).FileReader;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => {
          const port = new FakePort();
          ports.push(port);
          return port;
        },
      },
    };
    (globalThis as { FileReader?: unknown }).FileReader = TestFileReader;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    (globalThis as { FileReader?: unknown }).FileReader = originalFileReader;
  });

  function createVault(options: { timeoutMs?: number } = {}) {
    return createOffscreenTranslatedImageVault({ namespace: 'https://example.com', ...options });
  }

  it('lists only this namespace and strips the prefix back off', async () => {
    const vault = createVault();
    const pending = vault.loadKeys();

    const port = ports[0]!;
    expect(port.sent[0]).toMatchObject({ type: 'vault-list' });
    port.emit({
      type: 'vault-keys',
      requestId: port.requestId(),
      keys: ['https://example.com::123-4', 'https://other.example::9-9', 'https://example.com::7-1'],
    });

    // 另一个站点（另一个命名空间）的键不能漏回来，否则两个站点会互相串图。
    await expect(pending).resolves.toEqual({ status: 'ok', value: ['123-4', '7-1'] });
    expect(port.disconnected).toBe(true);
  });

  it('namespaces the key on read and reassembles the image', async () => {
    const vault = createVault();
    const pending = vault.get('123-4');

    const port = ports[0]!;
    expect(port.sent[0]).toMatchObject({
      type: 'vault-get',
      key: 'https://example.com::123-4',
    });
    const base64 = Buffer.from('translated').toString('base64');
    port.emit({
      type: 'vault-image',
      requestId: port.requestId(),
      found: true,
      contentType: 'image/png',
      meta: { chunkCount: 1, totalChars: base64.length },
    });
    port.emit({
      type: 'vault-image-chunk',
      requestId: port.requestId(),
      index: 0,
      data: base64,
    });
    port.emit({ type: 'vault-image-complete', requestId: port.requestId() });

    const result = await pending;
    expect(result.status).toBe('ok');
    const blob = result.status === 'ok' ? result.value : undefined;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe('image/png');
    expect(Buffer.from(await blob!.arrayBuffer()).toString()).toBe('translated');
  });

  it('reports a miss as an ok result with no value', async () => {
    const vault = createVault();
    const pending = vault.get('123-4');

    const port = ports[0]!;
    port.emit({ type: 'vault-image', requestId: port.requestId(), found: false });

    // 「没有这张」是**成功回答**，与「读不到」是两件事。
    await expect(pending).resolves.toEqual({ status: 'ok', value: undefined });
  });

  it('uploads an image as a namespaced chunked request', async () => {
    const vault = createVault();
    const pending = vault.put('123-4', new Blob(['translated'], { type: 'image/png' }));
    await flush();

    const port = ports[0]!;
    expect(port.sent[0]).toMatchObject({
      type: 'vault-put',
      key: 'https://example.com::123-4',
      contentType: 'image/png',
    });
    expect(port.sent[1]).toMatchObject({ type: 'vault-put-chunk', index: 0 });
    expect(port.sent[2]).toMatchObject({ type: 'vault-put-complete' });

    port.emit({ type: 'vault-stored', requestId: port.requestId() });
    await expect(pending).resolves.toEqual({ status: 'ok', value: undefined });
  });

  it('clears the store', async () => {
    const vault = createVault();
    const pending = vault.clear();

    const port = ports[0]!;
    expect(port.sent[0]).toMatchObject({ type: 'vault-clear' });
    port.emit({ type: 'vault-cleared', requestId: port.requestId() });

    await expect(pending).resolves.toEqual({ status: 'ok', value: undefined });
  });

  it('reports "unavailable" (with the reason) instead of an empty cache on failure', async () => {
    // ★ 这条钉住 2026-10-10 的修订：宿主明确失败时**不许**再回 `[]` / `undefined` ——
    //   那会把"读不到"伪装成"缓存是空的"，真机排查被带偏过（日志里全是 count=0）。
    const vault = createVault();
    const failed = vault.loadKeys();
    const failedPort = ports[0]!;
    failedPort.emit({
      type: 'vault-failed',
      requestId: failedPort.requestId(),
      message: '译图缓存宿主不可用',
    });
    await expect(failed).resolves.toEqual({
      status: 'unavailable',
      reason: '译图缓存宿主不可用',
    });

    // 端到端不响应 → 超时同样算"不可达"，并且带上原因（不是异常）。
    vi.useFakeTimers();
    try {
      const failing = createVault({ timeoutMs: 50 });
      const pending = failing.get('123-4');
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toMatchObject({
        status: 'unavailable',
        reason: expect.stringContaining('超时'),
      });
    } finally {
      vi.useRealTimers();
    }

    // 端口直接断开（background 重启 / 扩展重载）也一样。
    const dropped = createVault();
    const pending = dropped.loadKeys();
    ports.at(-1)!.disconnect();
    await expect(pending).resolves.toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('断开'),
    });
  });

  it('reports every operation as unavailable when the extension runtime is gone', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    (globalThis as { browser?: unknown }).browser = undefined;
    const vault = createVault();

    for (const pending of [
      vault.loadKeys(),
      vault.get('123-4'),
      vault.put('123-4', new Blob(['x'])),
      vault.setLimit(3),
      vault.clear(),
    ]) {
      await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
    }
    expect(ports).toEqual([]);
  });
});
