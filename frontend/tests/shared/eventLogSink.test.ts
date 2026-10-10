import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpEventLogSink,
  resolveEventLogBase,
} from '../../apps/extension/src/shared/eventLogSink';
import type { DmbEvent } from '../../apps/extension/src/shared/eventLog';

function event(partial: Partial<DmbEvent> = {}): DmbEvent {
  return {
    v: 2,
    ts: '2026-10-05T00:00:00.000Z',
    seq: 1,
    sessionId: 's-test',
    level: 'info',
    kind: 'test',
    ...partial,
  };
}

describe('resolveEventLogBase', () => {
  it('prefers the OCR server base when present', () => {
    expect(resolveEventLogBase({
      ocrServerBaseUrl: 'http://127.0.0.1:11436',
      llmBaseUrl: 'http://127.0.0.1:11436/v1',
    })).toBe('http://127.0.0.1:11436');
  });

  /**
   * ★ 这条守的是踩过的坑：地址曾只从 `ocrServerBaseUrl` 取，而那个字段只在
   * OCR 引擎是 `manga_ocr_server` 时才有值 —— 用户换引擎后整条日志旁路静默失效。
   */
  it('falls back to the LLM base origin when OCR base is absent', () => {
    expect(resolveEventLogBase({
      llmBaseUrl: 'http://127.0.0.1:11436/v1',
    })).toBe('http://127.0.0.1:11436');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolveEventLogBase({})).toBeUndefined();
    expect(resolveEventLogBase({ llmBaseUrl: '   ' })).toBeUndefined();
  });

  it('returns undefined for an unparsable LLM base instead of throwing', () => {
    expect(resolveEventLogBase({ llmBaseUrl: 'not a url' })).toBeUndefined();
  });

  /**
   * ★★ 隐私护栏：**日志永不外发**（设计 §1）。
   *
   * 云端模式下 `llmBaseUrl` 是 `https://api.openai.com/v1`，而事件里带失败详情、
   * 文件路径、主机名。若不拦，每次 flush 都会把它们 POST 给第三方，且 sink 吞错、全程静默。
   * 宁可事件流整体关闭，也不外发一个字节。
   */
  it('refuses to send events to a non-loopback (cloud) base', () => {
    expect(resolveEventLogBase({ llmBaseUrl: 'https://api.openai.com/v1' })).toBeUndefined();
    expect(resolveEventLogBase({ llmBaseUrl: 'https://api.deepseek.com' })).toBeUndefined();
    expect(resolveEventLogBase({ llmBaseUrl: 'http://192.168.1.50:11436/v1' })).toBeUndefined();
    expect(resolveEventLogBase({ ocrServerBaseUrl: 'https://evil.example.com' })).toBeUndefined();
    // 云端 base 也不会被 loopback 的 OCR base "带偏"——各判各的。
    expect(resolveEventLogBase({
      ocrServerBaseUrl: 'https://evil.example.com',
      llmBaseUrl: 'https://api.openai.com/v1',
    })).toBeUndefined();
  });

  it('normalizes a loopback base that carries a path', () => {
    expect(resolveEventLogBase({ ocrServerBaseUrl: 'http://127.0.0.1:11436/ocr' }))
      .toBe('http://127.0.0.1:11436');
    expect(resolveEventLogBase({ llmBaseUrl: 'http://localhost:11436/v1' }))
      .toBe('http://localhost:11436');
  });
});

function stubFetch() {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
}

describe('createHttpEventLogSink', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the batch to /log/events with keepalive', async () => {
    const fetchImpl = stubFetch();
    const sink = createHttpEventLogSink('http://127.0.0.1:11436/', fetchImpl as unknown as typeof fetch);

    sink([event({ kind: 'failure' })]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11436/log/events');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      events: [expect.objectContaining({ kind: 'failure' })],
    });
  });

  it('is a no-op when no base is configured', () => {
    const fetchImpl = stubFetch();
    const sink = createHttpEventLogSink(undefined, fetchImpl as unknown as typeof fetch);

    sink([event()]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores empty batches', () => {
    const fetchImpl = stubFetch();
    const sink = createHttpEventLogSink('http://127.0.0.1:11436', fetchImpl as unknown as typeof fetch);

    sink([]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** 日志是旁路：出口炸了不许把翻译任务带崩。 */
  it('swallows transport errors', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => {
      throw new Error('offline');
    });
    const sink = createHttpEventLogSink('http://127.0.0.1:11436', fetchImpl as unknown as typeof fetch);

    expect(() => sink([event()])).not.toThrow();
    await Promise.resolve();
  });
});
