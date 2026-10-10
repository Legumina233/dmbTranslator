import { describe, expect, it, vi } from 'vitest';
import {
  buildSupportBundle,
  defaultSupportServerBase,
  fetchServerSupport,
  resolveSupportServerBase,
  supportBundleFilenamePrefix,
} from '../../apps/extension/src/shared/supportBundle';
import type { DmbEvent } from '../../apps/extension/src/shared/eventLog';

function event(partial: Partial<DmbEvent> = {}): DmbEvent {
  return {
    v: 2,
    ts: '2026-10-05T09:00:00.000Z',
    seq: 1,
    sessionId: 's-test',
    level: 'error',
    kind: 'failure',
    ...partial,
  };
}

describe('resolveSupportServerBase', () => {
  it('keeps a loopback custom base', () => {
    expect(resolveSupportServerBase({ customBaseUrl: 'http://127.0.0.1:11436/v1' }))
      .toBe('http://127.0.0.1:11436');
    expect(resolveSupportServerBase({ customBaseUrl: 'http://localhost:8080/api' }))
      .toBe('http://localhost:8080');
  });

  /**
   * ★ 这条守的是"日志永不外发"（设计 §1/§4.2）：
   * LLM 的 base 可能是 `api.openai.com`，拿它拼 `/support` 会把本机日志
   * POST 给第三方，或者得到一个 404。不是本机就退回默认端口。
   */
  it('refuses a non-loopback base and falls back to the default', () => {
    expect(resolveSupportServerBase({ customBaseUrl: 'https://api.openai.com/v1' }))
      .toBe(defaultSupportServerBase);
    expect(resolveSupportServerBase({ customBaseUrl: 'https://example.com' }))
      .toBe(defaultSupportServerBase);
  });

  it('falls back for an unparsable or empty base', () => {
    expect(resolveSupportServerBase({ customBaseUrl: 'not a url' }))
      .toBe(defaultSupportServerBase);
    expect(resolveSupportServerBase({ customBaseUrl: '   ' }))
      .toBe(defaultSupportServerBase);
    expect(resolveSupportServerBase()).toBe(defaultSupportServerBase);
  });

  it('honours an explicit fallback', () => {
    expect(resolveSupportServerBase({ customBaseUrl: 'https://api.openai.com', fallback: 'http://127.0.0.1:9999' }))
      .toBe('http://127.0.0.1:9999');
  });
});

describe('buildSupportBundle', () => {
  const env = { browser: 'UA/1.0', platform: 'Win32', language: 'zh-CN', timezone: 'Asia/Shanghai' };

  it('takes events and summary from the server half when reachable', () => {
    const bundle = buildSupportBundle({
      env,
      settings: { llmProvider: 'sakura' },
      server: {
        v: 2,
        events: [event({ kind: 'page.completed', level: 'info' })],
        summary: { total: 1, counts: { byKind: { 'page.completed': 1 } } },
        server: { health: { status: 'ok' }, eventLogPath: 'logs/events/2026-10-05.events.jsonl' },
        privacy: { containsOriginalText: false },
      },
      now: new Date('2026-10-05T09:10:00.000Z'),
    });

    expect(bundle.v).toBe(2);
    expect(bundle.generatedAt).toBe('2026-10-05T09:10:00.000Z');
    expect(bundle.exporter.repo).toBe('dmb-extension');
    expect(bundle.env).toEqual(env);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.summary).toMatchObject({ total: 1 });
    expect(bundle.server).toMatchObject({ eventLogPath: 'logs/events/2026-10-05.events.jsonl' });
    expect(bundle.serverError).toBeUndefined();
    expect(bundle.privacy.containsOriginalText).toBe(false);
  });

  /**
   * ★ 诊断器铁律：「没采到」与「采到了但为空」必须能分开。
   * 服务没起时**不许给一个空壳假装采完了** —— 那会让看日志的人得出
   * "事件确实一条都没有"的错误结论。
   */
  it('refuses to fake an empty result when the server is unreachable', () => {
    const bundle = buildSupportBundle({
      env,
      settings: {},
      server: null,
      serverError: 'http://127.0.0.1:11436 不可达：Failed to fetch',
    });

    expect(bundle.events).toEqual([]);
    expect(bundle.server).toBeNull();
    expect(bundle.serverError).toContain('不可达');
    // summary 必须自证"不可用"，不能长得像"统计结果是 0"。
    expect(bundle.summary).toMatchObject({ note: expect.stringContaining('未取到服务端事件') });
    expect(bundle.summary).toMatchObject({ reason: expect.stringContaining('不可达') });
    expect(bundle.privacy.containsOriginalText).toBe(false);
  });

  it('marks original text as absent even if the server omits the privacy block', () => {
    const bundle = buildSupportBundle({ env, settings: {}, server: { events: [event()] } });

    expect(bundle.privacy.containsOriginalText).toBe(false);
    expect(bundle.privacy.note).toContain('默认不含漫画原文');
  });

  it('passes through the server flag when the server reports original text', () => {
    const bundle = buildSupportBundle({
      env,
      settings: {},
      server: { events: [event()], privacy: { containsOriginalText: true } },
    });

    expect(bundle.privacy.containsOriginalText).toBe(true);
  });

  it('notes a missing summary instead of inventing one', () => {
    const bundle = buildSupportBundle({ env, settings: {}, server: { events: [event()] } });

    expect(bundle.summary).toMatchObject({ note: '服务端未返回 summary' });
  });

  it('uses a timestamped dmb-support filename prefix', () => {
    expect(supportBundleFilenamePrefix).toBe('dmb-support');
  });
});

describe('fetchServerSupport', () => {
  it('GETs /support and appends the limit when given', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ v: 2, events: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const payload = await fetchServerSupport('http://127.0.0.1:11436/', {
      limit: 200,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11436/support?limit=200',
      { method: 'GET' },
    );
    expect(payload).toMatchObject({ v: 2 });
  });

  it('omits the query when no limit is given', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    await fetchServerSupport('http://127.0.0.1:11436', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11436/support', { method: 'GET' });
  });

  /** 失败必须如实抛出 —— 内部吞成"空结果"会让调用方分不清"服务没起"和"事件为空"。 */
  it('throws on a non-2xx response so the caller can report it', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));

    await expect(fetchServerSupport('http://127.0.0.1:11436', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow('HTTP 503');
  });
});
