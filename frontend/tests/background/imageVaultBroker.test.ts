import { describe, expect, it, vi } from 'vitest';
import type { ExtensionPort } from '../../apps/extension/src/shared/extensionRuntime';
import type { PipelineHostLifecycle } from '../../apps/extension/src/background/localPipeline/pipelineHostLifecycle';
import { ImageVaultBroker } from '../../apps/extension/src/background/imageVault/imageVaultBroker';
import {
  IMAGE_VAULT_CLIENT_PORT,
  IMAGE_VAULT_HOST_PORT,
} from '../../apps/extension/src/shared/imageVaultProtocol';

class FakePort implements ExtensionPort {
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: unknown, port: ExtensionPort) => void> = [];
  readonly disconnectListeners: Array<(port: ExtensionPort) => void> = [];
  disconnected = false;

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('port disconnected');
    this.sent.push(message);
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
}

/** 宏任务一拍：够了，`handleClientMessage` 只有一层 `await`。 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function createLifecycle(
  overrides: Partial<PipelineHostLifecycle> = {},
): PipelineHostLifecycle {
  return {
    ensureHost: vi.fn(async () => undefined),
    closeHost: vi.fn(async () => undefined),
    matchesHostPort: vi.fn(() => true),
    ...overrides,
  };
}

function createHarness(lifecycle: PipelineHostLifecycle = createLifecycle()) {
  const broker = new ImageVaultBroker(lifecycle);
  const host = new FakePort(IMAGE_VAULT_HOST_PORT);
  const client = new FakePort(IMAGE_VAULT_CLIENT_PORT);
  broker.handlePort(host);
  broker.handlePort(client);
  return { broker, host, client, lifecycle };
}

describe('ImageVaultBroker', () => {
  it('declines port names it does not own', () => {
    const broker = new ImageVaultBroker(createLifecycle());

    expect(broker.handlePort(new FakePort(IMAGE_VAULT_HOST_PORT))).toBe(true);
    expect(broker.handlePort(new FakePort(IMAGE_VAULT_CLIENT_PORT))).toBe(true);
    // 认不出来必须原样交还给流水线 broker —— 由它走"不认识的端口当场断开"的兜底，
    // 这里要是也返回 true，就等于悄悄把别人的端口吞了。
    expect(broker.handlePort(new FakePort('mt:content-session:abc'))).toBe(false);
  });

  it('routes a request to the host and the reply back to its origin', async () => {
    const { host, client } = createHarness();

    client.emit({ type: 'vault-get', requestId: 'r1', key: 'page-1' });
    await flush();

    expect(host.sent).toEqual([{ type: 'vault-get', requestId: 'r1', key: 'page-1' }]);
    host.emit({ type: 'vault-image', requestId: 'r1', found: false });

    expect(client.sent).toEqual([{ type: 'vault-image', requestId: 'r1', found: false }]);
  });

  it('preserves the order of an upload request and its chunks', async () => {
    const { host, client } = createHarness();

    client.emit({
      type: 'vault-put',
      requestId: 'r1',
      key: 'k',
      contentType: 'image/png',
      meta: { chunkCount: 2, totalChars: 8 },
    });
    client.emit({ type: 'vault-put-chunk', requestId: 'r1', index: 0, data: 'AAAA' });
    client.emit({ type: 'vault-put-chunk', requestId: 'r1', index: 1, data: 'BBBB' });
    client.emit({ type: 'vault-put-complete', requestId: 'r1' });
    await flush();

    expect(host.sent.map((message) => (message as { type: string }).type)).toEqual([
      'vault-put',
      'vault-put-chunk',
      'vault-put-chunk',
      'vault-put-complete',
    ]);
    expect((host.sent[2] as { index: number }).index).toBe(1);
  });

  it('creates the off-screen document once for concurrent requests', async () => {
    const host = new FakePort(IMAGE_VAULT_HOST_PORT);
    const client = new FakePort(IMAGE_VAULT_CLIENT_PORT);
    let broker!: ImageVaultBroker;
    // 宿主端口在文档被创建之后才接上来 —— 与真机顺序一致（先 createDocument，再等端口）。
    const ensureHost = vi.fn(async () => {
      broker.handlePort(host);
      return undefined;
    });
    broker = new ImageVaultBroker(createLifecycle({ ensureHost }));
    broker.handlePort(client);

    client.emit({ type: 'vault-list', requestId: 'r1' });
    client.emit({ type: 'vault-list', requestId: 'r2' });
    await flush();

    expect(ensureHost).toHaveBeenCalledTimes(1);
    expect(host.sent).toHaveLength(2);
  });

  it('fails the request instead of hanging when no host can be created', async () => {
    const lifecycle = createLifecycle({
      ensureHost: vi.fn(async () => {
        throw new Error('当前 Chromium 不支持扩展流水线宿主');
      }),
    });
    const broker = new ImageVaultBroker(lifecycle);
    const client = new FakePort(IMAGE_VAULT_CLIENT_PORT);
    broker.handlePort(client);

    client.emit({ type: 'vault-list', requestId: 'r1' });
    await flush();

    // 快速失败，不拖到"等宿主连接"的超时 —— 缓存是加速器，缺了就该立刻退回"无缓存"。
    expect(client.sent).toEqual([{
      type: 'vault-failed',
      requestId: 'r1',
      message: '译图缓存宿主不可用',
    }]);
  });

  it('recovers from a stale host context by closing and recreating it once', async () => {
    // 真机事故（2026-10-10 15:46–15:48）：service worker 重启后 `getContexts()` 仍报一个
    // 连不上来的僵尸文档 → lifecycle.ensureHost() 直接 return、永不 createDocument →
    // 只能干等超时（日志：7 次 ensure-host-start / 0 次 document-loaded）。
    // 现在超时后**强制复位一次**：closeDocument → 重建 → 再等。
    vi.useFakeTimers();
    try {
      const host = new FakePort(IMAGE_VAULT_HOST_PORT);
      const client = new FakePort(IMAGE_VAULT_CLIENT_PORT);
      let ensureCalls = 0;
      let broker!: ImageVaultBroker;
      const ensureHost = vi.fn(async () => {
        ensureCalls += 1;
        // 第一次：只报"文档存在"（僵尸），宿主永远不接上来；复位重建时才真的接上。
        if (ensureCalls === 1) return undefined;
        broker.handlePort(host);
        return undefined;
      });
      const closeHost = vi.fn(async () => undefined);
      broker = new ImageVaultBroker(createLifecycle({ ensureHost, closeHost }));
      broker.handlePort(client);

      client.emit({ type: 'vault-list', requestId: 'r1' });
      await vi.advanceTimersByTimeAsync(2_100); // 第一次等端口超时 → 触发复位
      await vi.advanceTimersByTimeAsync(10);    // 第二次：宿主已接上

      expect(closeHost).toHaveBeenCalledTimes(1);
      expect(ensureHost).toHaveBeenCalledTimes(2);
      expect(host.sent).toEqual([{ type: 'vault-list', requestId: 'r1' }]);
      expect(client.sent).toEqual([]); // 没有回失败：请求被成功转发了
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the recovery attempt fails too', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakePort(IMAGE_VAULT_CLIENT_PORT);
      // ensureHost 成功但永远没有宿主端口接上来。
      const broker = new ImageVaultBroker(createLifecycle());
      broker.handlePort(client);

      client.emit({ type: 'vault-list', requestId: 'r1' });
      await vi.advanceTimersByTimeAsync(2_100); // 第一次超时
      await vi.advanceTimersByTimeAsync(1_100); // 复位后的第二次也超时

      // 最坏情况有明确上界（2s + 1s），然后如实回失败 —— 不悬挂。
      expect(client.sent).toEqual([{
        type: 'vault-failed',
        requestId: 'r1',
        message: '译图缓存宿主不可用',
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a request bound to the connection that opened it', async () => {
    const { broker, host, client } = createHarness();
    const intruder = new FakePort(IMAGE_VAULT_CLIENT_PORT);
    broker.handlePort(intruder);

    client.emit({ type: 'vault-put', requestId: 'r1', key: 'k', contentType: 'image/png', meta: { chunkCount: 0, totalChars: 0 } });
    await flush();
    host.sent.length = 0;

    // 同一个 requestId 从第二条连接再来一次：不覆盖归属。
    intruder.emit({ type: 'vault-put', requestId: 'r1', key: 'k2', contentType: 'image/png', meta: { chunkCount: 0, totalChars: 0 } });
    // 分块也必须来自发起方。
    intruder.emit({ type: 'vault-put-chunk', requestId: 'r1', index: 0, data: 'AQ==' });
    await flush();

    expect(host.sent).toEqual([]);
    expect(intruder.sent).toEqual([]);

    host.emit({ type: 'vault-stored', requestId: 'r1' });
    expect(client.sent).toEqual([{ type: 'vault-stored', requestId: 'r1' }]);
    expect(intruder.sent).toEqual([]);
  });

  it('stops tracking a request once it reaches a terminal message', async () => {
    const { host, client } = createHarness();

    client.emit({ type: 'vault-get', requestId: 'r1', key: 'k' });
    await flush();
    host.emit({ type: 'vault-image', requestId: 'r1', found: false });
    client.sent.length = 0;

    // 终态之后的残包（迟到的分块 / 重复回执）不该再投给内容脚本。
    host.emit({ type: 'vault-image-chunk', requestId: 'r1', index: 0, data: 'AQ==' });

    expect(client.sent).toEqual([]);
  });

  it('fails in-flight requests when the host port drops', async () => {
    const { host, client } = createHarness();

    client.emit({ type: 'vault-get', requestId: 'r1', key: 'k' });
    await flush();

    host.disconnect();

    expect(client.sent).toEqual([{
      type: 'vault-failed',
      requestId: 'r1',
      message: '译图缓存宿主已断开',
    }]);
  });

  it('forgets a request when its originating connection drops', async () => {
    const { host, client } = createHarness();

    client.emit({ type: 'vault-get', requestId: 'r1', key: 'k' });
    await flush();
    client.disconnect();

    host.emit({ type: 'vault-image', requestId: 'r1', found: false });

    expect(client.sent).toEqual([]);
  });
});
