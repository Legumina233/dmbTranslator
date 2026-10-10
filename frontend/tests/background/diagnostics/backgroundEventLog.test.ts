import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backgroundEventLogStats,
  configureBackgroundEventLog,
  emitBackgroundFailure,
  flushBackgroundEventLog,
  resetBackgroundEventLog,
} from '../../../apps/extension/src/background/diagnostics/backgroundEventLog';

/** 单例跨用例留状态，每个用例前复位成"未配置"。 */
beforeEach(() => {
  resetBackgroundEventLog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetBackgroundEventLog();
});

function stubFetch() {
  const fetchImpl = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

describe('background event log', () => {
  /**
   * ★ M2 的验收标准：造一次失败 → 事件流里必有一条 failure。
   * 守的是"下载失败抛在 pipeline 之外、以前谁也没记"那类结构性静默。
   */
  it('emits a failure event once configured', () => {
    const fetchImpl = stubFetch();
    expect(configureBackgroundEventLog({ llmBaseUrl: 'http://127.0.0.1:11436/v1' })).toBe(true);

    emitBackgroundFailure({
      message: '无法取得原始图片字节: 候选 1/1, host=cdn.example',
      stage: 'load',
      module: 'background/images/imageDownloader',
      fn: 'downloadSerialized',
      pageKey: '1234567-94',
      runId: 'run-abc',
      code: 'IMAGE_TRANSLATION_SOURCE_ACQUISITION_FAILED',
      durMs: 1084,
      what: { imageHost: 'cdn.example', attemptCount: 1 },
    });
    flushBackgroundEventLog();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      v: 2,
      level: 'error',
      kind: 'failure',
      pageKey: '1234567-94',
      runId: 'run-abc',
      dur_ms: 1084,
      where: { repo: 'extension', module: 'background/images/imageDownloader' },
      what: { stage: 'load', imageHost: 'cdn.example' },
      err: {
        code: 'IMAGE_TRANSLATION_SOURCE_ACQUISITION_FAILED',
        message: expect.stringContaining('无法取得原始图片字节'),
      },
    });
  });

  /** 关闭时整套不存在：连那层调用都不产生（不是"调了但吞掉"）。 */
  it('is a no-op before configuration', () => {
    const fetchImpl = stubFetch();
    // 单例跨用例留着计数，所以比的是"这次有没有新增"，不是绝对值。
    const before = backgroundEventLogStats();

    emitBackgroundFailure({
      message: 'boom',
      stage: 'load',
      module: 'm',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(backgroundEventLogStats()).toEqual(before);
  });

  it('disables itself when no local service address is known', () => {
    const fetchImpl = stubFetch();

    expect(configureBackgroundEventLog({})).toBe(false);
    emitBackgroundFailure({ message: 'boom', stage: 'load', module: 'm' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
