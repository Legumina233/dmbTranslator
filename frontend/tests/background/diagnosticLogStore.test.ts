import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  exportDiagnosticLog,
  recordDiagnosticLogEvent,
} from '../../apps/extension/src/background/diagnostics/logStore';
import type { DiagnosticLogEvent } from '../../packages/diagnostics/src/diagnosticLog';

const diagnosticLogStorageKey = 'mangaTranslate.diagnosticLog';

function createStoredEvent(index: number): DiagnosticLogEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.parse('2026-07-15T00:00:00.000Z') + index).toISOString(),
    level: 'info',
    category: 'pipeline.stage',
    source: { context: 'pipeline-host', module: 'orchestrator.ts' },
    message: `event-${index}`,
  };
}

function requestedStorageKeys(keys: string | string[] | Record<string, unknown>): string[] {
  if (typeof keys === 'string') return [keys];
  if (Array.isArray(keys)) return keys;
  return Object.keys(keys);
}

/** 每次 `storage.set` 写入的条目数 —— 用来断言「追加一条不该重写整库」。 */
let storageWrites: Array<{ key: string; itemCount: number }> = [];

function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'object' && value !== null && Array.isArray((value as { events?: unknown[] }).events)) {
    return (value as { events: unknown[] }).events.length;
  }
  return 0;
}

/** 按当前（分片）或旧（整包）格式从 storage 里读出全部事件。 */
function readPersistedEvents(storage: Record<string, unknown>): DiagnosticLogEvent[] {
  const index = storage[diagnosticLogStorageKey] as
    { events?: DiagnosticLogEvent[]; chunks?: string[] } | undefined;
  if (Array.isArray(index?.events)) return index.events;
  return (index?.chunks ?? []).flatMap(
    (chunkId) => (storage[chunkId] as DiagnosticLogEvent[] | undefined) ?? [],
  );
}

function installStorage(initialDiagnosticStore: unknown): Record<string, unknown> {
  storageWrites = [];
  const storage: Record<string, unknown> = {
    [diagnosticLogStorageKey]: initialDiagnosticStore,
  };
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: 'test', manifest_version: 2 }),
    },
    storage: {
      local: {
        get(
          keys: string | string[] | Record<string, unknown>,
          callback: (items: Record<string, unknown>) => void,
        ) {
          const items = Object.fromEntries(
            requestedStorageKeys(keys).map((key) => [key, storage[key]]),
          );
          callback(items);
        },
        set(items: Record<string, unknown>, callback: () => void) {
          for (const [key, value] of Object.entries(items)) {
            storageWrites.push({ key, itemCount: countItems(value) });
          }
          Object.assign(storage, items);
          callback();
        },
        remove(keys: string | string[], callback: () => void) {
          for (const key of typeof keys === 'string' ? [keys] : keys) {
            delete storage[key];
          }
          callback();
        },
      },
    },
  });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnostic log store export', () => {
  it.each([80, 81, 2000])('exports all %i valid events without a top-level truncation marker', async (eventCount) => {
    const events = Array.from({ length: eventCount }, (_, index) => createStoredEvent(index));
    installStorage({ events });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(eventCount);
    expect(exported.text).toContain('"manifestVersion":2');
    expect(exported.text).toContain('event-0');
    expect(exported.text).toContain(`event-${eventCount - 1}`);
    expect(exported.text).not.toContain('[TRUNCATED_ARRAY:');
  });

  it('keeps a legacy event with a missing timestamp and renders unknown-time', async () => {
    const legacyEvent = {
      ...createStoredEvent(1),
      id: 'legacy-event',
      timestamp: undefined,
      message: 'legacy event without timestamp',
    };
    installStorage({ events: [createStoredEvent(0), legacyEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(2);
    expect(exported.text).toContain(
      '[unknown-time][INF][pipeline-host][no-run][pipeline.stage] orchestrator.ts | legacy event without timestamp',
    );
  });

  it('drops only an unrecoverable event and reports the skipped count', async () => {
    const invalidEvent = {
      ...createStoredEvent(1),
      id: 'invalid-event',
      source: undefined,
      message: 'invalid event should not be exported',
    };
    installStorage({ events: [createStoredEvent(0), invalidEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(1);
    expect(exported.text).toContain('event-0');
    expect(exported.text).not.toContain('invalid event should not be exported');
    expect(exported.text).toContain('日志已裁剪');
    expect(exported.text).toContain('持久化日志中有 1 条事件格式无效，已忽略');
  });

  it('redacts each recovered event while preserving nested data truncation', async () => {
    const imageDataUrl = `data:image/png;base64,${'a'.repeat(120)}`;
    const longPrompt = `请翻译：${'台词'.repeat(7000)}`;
    const sensitiveEvent = {
      ...createStoredEvent(0),
      message: 'Authorization: Bearer abc.def.ghi',
      data: {
        apiKey: 'sk-secret',
        sourceImageUrl: imageDataUrl,
        prompt: longPrompt,
        values: Array.from({ length: 81 }, (_, index) => index),
      },
    };
    installStorage({ events: [sensitiveEvent] });

    const exported = await exportDiagnosticLog();

    expect(exported.eventCount).toBe(1);
    expect(exported.text).toContain('Bearer [REDACTED]');
    expect(exported.text).toContain('"apiKey":"[REDACTED]"');
    expect(exported.text).toContain('[IMAGE_DATA_URL_REDACTED:');
    expect(exported.text).toContain('[TRUNCATED:');
    expect(exported.text).toContain('[TRUNCATED_ARRAY:1]');
    expect(exported.text).not.toContain('sk-secret');
    expect(exported.text).not.toContain(imageDataUrl);
    expect(exported.text).not.toContain(longPrompt);
  });

  it('does not mutate storage while reading and writes back the recovered store on the next append', async () => {
    const invalidEvent = {
      ...createStoredEvent(1),
      id: 'invalid-event',
      source: undefined,
    };
    const storage = installStorage({ events: [createStoredEvent(0), invalidEvent] });

    await exportDiagnosticLog();
    expect(readPersistedEvents(storage)).toHaveLength(2);

    await recordDiagnosticLogEvent(createStoredEvent(2));

    expect(readPersistedEvents(storage).map((event) => event.id)).toEqual(['event-0', 'event-2']);
    const index = storage[diagnosticLogStorageKey] as {
      truncated?: boolean;
      truncationReason?: string;
    };
    expect(index.truncated).toBe(true);
    expect(index.truncationReason).toContain('持久化日志中有 1 条事件格式无效，已忽略');
  });

  // ★ 这条是「开调试日志导致翻译越翻越慢」的回归护栏。
  // 老实现每追加一条都要 read 全库 → 复制 → write 全库，代价 O(总条数)；
  // 一页几十条事件串起来就是 O(N²)，实测把翻译请求拖慢 6~7 秒。
  // 分片之后单次追加只碰最后一块，写入量被 chunkSize 封顶。
  it('appends one event without rewriting the whole log', async () => {
    const seedCount = 500;
    const storage = installStorage({
      events: Array.from({ length: seedCount }, (_, index) => createStoredEvent(index)),
    });

    // 第一次追加会顺带把旧格式（整包）切成块 —— 迁移只发生这一次。
    await recordDiagnosticLogEvent(createStoredEvent(seedCount));
    const chunkSize = 100;
    expect(readPersistedEvents(storage)).toHaveLength(seedCount + 1);

    // 之后每次追加：写入量必须被 chunkSize 封住，而不是随总条数线性增长。
    for (let index = seedCount + 1; index < seedCount + 5; index += 1) {
      storageWrites = [];
      await recordDiagnosticLogEvent(createStoredEvent(index));
      const largestWrite = Math.max(...storageWrites.map((write) => write.itemCount));
      expect(largestWrite).toBeLessThanOrEqual(chunkSize);
    }

    expect(readPersistedEvents(storage)).toHaveLength(seedCount + 5);
  });
});
