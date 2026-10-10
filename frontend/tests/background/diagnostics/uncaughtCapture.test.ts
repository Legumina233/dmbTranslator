import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticLogEvent } from '@dmb/diagnostics';
import {
  installUncaughtErrorCapture,
  resetUncaughtErrorCaptureForTests,
  setUncaughtErrorCaptureHookForTests,
} from '../../../apps/extension/src/background/diagnostics/uncaughtCapture';

/**
 * 错误黑匣子测试。
 *
 * 策略：install 一次（幂等），先于 install 用收集器替换 globalThis.addEventListener
 * 拿到注册的 listener 引用；每个用例注入自己的 write/scheduleFlush 钩子，
 * flush 回调由用例手动驱动（模拟 2 秒聚合窗口结束）。
 */

type RecordedListener = { type: string; listener: (event: unknown) => void };

const registeredListeners: RecordedListener[] = [];
const globalScope = globalThis as Omit<typeof globalThis, 'addEventListener'> & {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
};
const originalAddEventListener = typeof globalScope.addEventListener === 'function'
  ? globalScope.addEventListener
  : undefined;

// install 前替换 addEventListener，收集 listener（只收集黑匣子关心的两种类型，
// 其余透传给原实现——若无原实现则吞掉，避免影响同进程其他监听者）。
globalScope.addEventListener = (type: string, listener: (event: unknown) => void) => {
  if (type === 'error' || type === 'unhandledrejection') {
    registeredListeners.push({ type, listener });
    return;
  }
  return originalAddEventListener?.(type, listener);
};

installUncaughtErrorCapture();

function listenerOf(type: string): (event: unknown) => void {
  const found = registeredListeners.find((entry) => entry.type === type);
  if (!found) throw new Error(`未注册 ${type} 监听`);
  return found.listener;
}

describe('background 错误黑匣子（uncaughtCapture）', () => {
  let written: DiagnosticLogEvent[];
  let flushes: Array<() => void>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetUncaughtErrorCaptureForTests();
    written = [];
    flushes = [];
    setUncaughtErrorCaptureHookForTests({
      write: async (event) => {
        written.push(event);
      },
      scheduleFlush: (callback) => {
        flushes.push(callback);
      },
    });
  });

  afterEach(() => {
    setUncaughtErrorCaptureHookForTests(undefined);
    resetUncaughtErrorCaptureForTests();
  });

  function runPendingFlushes(): void {
    const pending = [...flushes];
    flushes.length = 0;
    for (const flush of pending) flush();
  }

  it('unhandledrejection（Error reason）→ 记录 kind/name/stack，level=error、category=error', () => {
    const boom = new Error('路由器炸了');
    boom.stack = `Error: 路由器炸了\n    at foo.ts:1:2`;

    listenerOf('unhandledrejection')({ reason: boom });
    runPendingFlushes();

    expect(written).toHaveLength(1);
    const event = written[0]!;
    expect(event.level).toBe('error');
    expect(event.category).toBe('error');
    expect(event.source.context).toBe('background');
    expect(event.message).toContain('路由器炸了');
    expect(event.data?.kind).toBe('unhandledrejection');
    expect(event.error?.name).toBe('Error');
    expect(event.error?.message).toBe('路由器炸了');
    expect(event.error?.stack).toContain('foo.ts');
  });

  it('error 事件带位置信息 → data.source 含 filename:lineno:colno', () => {
    listenerOf('error')({
      message: 'Cannot read properties of undefined',
      filename: 'chrome-extension://abc/background.js',
      lineno: 245,
      colno: 17,
      error: new TypeError('Cannot read properties of undefined'),
    });
    runPendingFlushes();

    expect(written).toHaveLength(1);
    const event = written[0]!;
    expect(event.data?.kind).toBe('error');
    expect(event.data?.source).toBe('chrome-extension://abc/background.js:245:17');
    expect(event.error?.name).toBe('TypeError');
  });

  it('非 Error reason（字符串 / 数字）→ String 化进 message，不抛', () => {
    listenerOf('unhandledrejection')({ reason: 'plain string reason' });
    listenerOf('unhandledrejection')({ reason: 42 });
    runPendingFlushes();

    const messages = written.map((event) => event.message);
    expect(messages[0]).toContain('plain string reason');
    expect(messages[1]).toContain('42');
    expect(written[0]!.error?.stack).toBeUndefined();
  });

  it('同一错误重复发生 → 聚合为一条，repeatCount 计数', () => {
    listenerOf('unhandledrejection')({ reason: new Error('同样的错') });
    listenerOf('unhandledrejection')({ reason: new Error('同样的错') });
    listenerOf('unhandledrejection')({ reason: new Error('同样的错') });
    runPendingFlushes();

    expect(written).toHaveLength(1);
    expect(written[0]!.data?.repeatCount).toBe(3);
  });

  it('不同错误互不聚合，各自一条', () => {
    listenerOf('unhandledrejection')({ reason: new Error('错误甲') });
    listenerOf('unhandledrejection')({ reason: new Error('错误乙') });
    runPendingFlushes();

    expect(written).toHaveLength(2);
    expect(written.map((event) => event.message).join('|')).toContain('错误甲');
    expect(written.map((event) => event.message).join('|')).toContain('错误乙');
  });

  it('巨型 stack 截断到 6000 字符', () => {
    const huge = new Error('stack 太长');
    huge.stack = `Error: stack 太长\n    at x.js:1:1\n${'    at y.js:1:1\n'.repeat(1000)}`;
    listenerOf('unhandledrejection')({ reason: huge });
    runPendingFlushes();

    expect(written[0]!.error?.stack!.length).toBeLessThanOrEqual(6000);
  });

  it('write 失败 → 静默，不影响后续错误记录', async () => {
    let calls = 0;
    setUncaughtErrorCaptureHookForTests({
      write: async (event) => {
        calls += 1;
        if (calls === 1) throw new Error('storage 炸了');
        written.push(event);
      },
      scheduleFlush: (callback) => {
        flushes.push(callback);
      },
    });

    listenerOf('unhandledrejection')({ reason: new Error('第一条') });
    runPendingFlushes();
    await Promise.resolve();
    listenerOf('unhandledrejection')({ reason: new Error('第二条') });
    runPendingFlushes();
    await Promise.resolve();

    expect(calls).toBe(2);
    expect(written).toHaveLength(1);
    expect(written[0]!.message).toContain('第二条');
  });
});
