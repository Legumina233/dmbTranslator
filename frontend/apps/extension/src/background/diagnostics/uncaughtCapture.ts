import { createDiagnosticEvent, createDiagnosticId } from '@dmb/diagnostics';
import type { DiagnosticLogEvent } from '@dmb/diagnostics';
import { recordDiagnosticLogEvent } from './logStore';

/**
 * 背景（SW）「错误黑匣子」：捕获 service worker 里**未捕获**的错误与 Promise rejection，
 * 写进诊断日志（storage 里的环形缓冲），让「后台一直报错但功能正常」这类问题可以
 * 通过弹窗「下载日志」拿到证据 —— 在此之前这些错误只出现在 SW console，转瞬即逝。
 *
 * 为什么需要：`dispatchBackgroundMessage` 只兜住**消息路由内**的异常（转成 ok:false 响应），
 * 事件 listener 里 `void promise.then(...)` 断链、模块顶层的意外抛错等都只打 SW console，
 * 且 SW console 随 DevTools 关闭即丢、无法回看。
 *
 * 为什么不做独立探针扩展：扩展的报错日志按扩展严格隔离，另一个扩展读不到本扩展的
 * console / chrome://extensions 错误面板（唯一例外是 chrome.debugger 附着，但需要
 * debugger 权限且浏览器顶部常驻"正在调试"横幅，不可接受）。
 *
 * 设计约束：
 * - **自身绝不抛**：序列化、写入全部 try/catch 静默 —— 黑匣子不能成为新的报错源。
 * - **按签名聚合**：同一错误 2 秒窗口内合并为一条（data.repeatCount 计数），
 *   防止"一直报错"把 2000 条环形缓冲刷满、淹没其他证据。SW 休眠导致计数丢失可接受
 *   （丢的只是重复计数，错误本身已落盘）。
 * - **stack 截断**：巨型 stack 会灌爆 storage，统一截到 `maxStackLength`。
 * - **无条件记录**：错误黑匣子不受 `enableDebugLog` 开关约束 —— 开关管的是业务事件量，
 *   未捕获错误是异常信号，量级天然有限（且已有聚合兜底）。
 */

const maxStackLength = 6000;
const aggregateWindowMs = 2000;

/** 本次 SW 会话 id：模块级常量，SW 每次冷启动重载模块即换新。 */
const backgroundSessionId = createDiagnosticId('background-session');

/** 每个待写事件的内存 pending 项（按错误签名聚合）。 */
type PendingUncaughtEntry = {
  key: string;
  event: DiagnosticLogEvent;
  repeatCount: number;
};

const pendingByKey = new Map<string, PendingUncaughtEntry>();
let installed = false;

export type UncaughtErrorCaptureHook = {
  /** 记录事件落地（生产 = 诊断日志；测试注入 spy）。 */
  write(event: DiagnosticLogEvent): Promise<void>;
  /** 调度聚合窗口结束（生产 = setTimeout；测试注入以配合 fake timer）。 */
  scheduleFlush(callback: () => void): void;
};

const defaultHook: UncaughtErrorCaptureHook = {
  write: (event) => recordDiagnosticLogEvent(event),
  scheduleFlush: (callback) => {
    setTimeout(callback, aggregateWindowMs);
  },
};

let hook: UncaughtErrorCaptureHook = defaultHook;

/** 测试注入钩子；传 undefined 恢复默认。 */
export function setUncaughtErrorCaptureHookForTests(
  override: Partial<UncaughtErrorCaptureHook> | undefined,
): void {
  hook = override ? { ...defaultHook, ...override } : defaultHook;
}

/** 清空 pending（测试用例间隔离；窗口计时由测试的 fake timer 自行掌控）。 */
export function resetUncaughtErrorCaptureForTests(): void {
  pendingByKey.clear();
}

function serializeReason(reason: unknown): {
  name?: string;
  message: string;
  stack?: string;
} {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message || '(空错误消息)',
      stack: reason.stack ? reason.stack.slice(0, maxStackLength) : undefined,
    };
  }
  // reason 可能是任何值（reject(123)、reject(undefined)）—— 只能 String 化。
  let text: string;
  try {
    text = String(reason);
  } catch {
    text = '(无法字符串化的 rejection reason)';
  }
  return { message: text || '(空 rejection reason)' };
}

function describeErrorSource(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const record = source as { filename?: unknown; lineno?: unknown; colno?: unknown };
  if (typeof record.filename !== 'string' || record.filename.length === 0) return undefined;
  const line = typeof record.lineno === 'number' ? record.lineno : '?';
  const column = typeof record.colno === 'number' ? record.colno : '?';
  return `${record.filename}:${line}:${column}`;
}

async function writeSafely(entry: PendingUncaughtEntry): Promise<void> {
  try {
    const event = entry.repeatCount > 1
      ? {
          ...entry.event,
          data: {
            ...entry.event.data,
            repeatCount: entry.repeatCount,
            note: `同一错误在聚合窗口内重复出现，已合并计数（repeatCount=${entry.repeatCount}）`,
          },
        }
      : entry.event;
    await hook.write(event);
  } catch {
    // 黑匣子写入失败必须静默 —— 不能因为记录错误而产生新错误。
  }
}

function enqueueUncaughtEvent(event: DiagnosticLogEvent): void {
  // 聚合签名：消息 + 来源位置（stack 差异太大，不进签名）。
  const source = typeof event.data?.source === 'string' ? event.data.source : '';
  const key = `${event.message}|${source}`;
  const existing = pendingByKey.get(key);
  if (existing) {
    existing.repeatCount += 1;
    return;
  }
  const entry: PendingUncaughtEntry = {
    key,
    event,
    repeatCount: 1,
  };
  pendingByKey.set(key, entry);
  hook.scheduleFlush(() => {
    // 被 reset 清掉的（测试隔离）不写。
    if (pendingByKey.get(key) !== entry) return;
    pendingByKey.delete(key);
    void writeSafely(entry);
  });
}

function recordUncaught(
  kind: 'error' | 'unhandledrejection',
  message: string,
  error: { name?: string; message: string; stack?: string },
  source?: string,
): void {
  try {
    const event = createDiagnosticEvent({
      level: 'error',
      category: 'error',
      source: { context: 'background', module: 'uncaughtCapture.ts' },
      message,
      data: {
        kind,
        ...(source ? { source } : {}),
      },
      error: {
        ...error,
      },
    }, backgroundSessionId);
    enqueueUncaughtEvent(event);
  } catch {
    // 序列化失败也静默。
  }
}

type ErrorEventLike = {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  error?: unknown;
};

type PromiseRejectionEventLike = {
  reason?: unknown;
};

/**
 * 给 service worker 挂全局错误钩子。幂等；只挂一次。
 * 在 `initializeBackground()` 最前调用（SW 每次冷启动都会执行）。
 */
export function installUncaughtErrorCapture(): void {
  if (installed) return;
  const scope = globalThis as typeof globalThis & {
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  };
  if (!scope.addEventListener) return;
  installed = true;

  scope.addEventListener('error', (rawEvent) => {
    const event = rawEvent as ErrorEventLike;
    const reason = serializeReason(event.error ?? event.message ?? '(未知错误)');
    recordUncaught(
      'error',
      `后台未捕获错误: ${reason.message}`,
      reason,
      describeErrorSource(event),
    );
  });

  scope.addEventListener('unhandledrejection', (rawEvent) => {
    const event = rawEvent as PromiseRejectionEventLike;
    const reason = serializeReason(event.reason);
    recordUncaught(
      'unhandledrejection',
      `后台未处理 rejection: ${reason.message}`,
      reason,
    );
  });
}
