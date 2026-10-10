/**
 * M2 · background 侧的统一事件流实例。
 *
 * ★ 为什么 background 也要有一份：
 *   翻译链路上有一批失败**发生在 pipeline 之外**（最典型：原图字节下载失败 ——
 *   `imageDownloader` 在 background 抛错，content 拿到的是一句聚合好的字符串，
 *   offscreen 的 pipelineHost 根本没跑到，于是整页日志里一条都没有）。
 *   那类"结构性静默"只能由**错误的第一现场**自己上报，所以 background 必须能 emit。
 *
 * ★ 与 offscreen 的关系：
 *   两个 JS 上下文，各持一个实例（MV3 里没有共享内存可用）。同一批事件流靠
 *   `runId` / `pageKey` / `requestId` 在**服务端**汇合（服务端按 `requestId` 对齐，设计 §6）。
 *   `sessionId` 因此按上下文各自生成 —— 它是"这一侧的运行时"，不是"这一次任务"。
 *
 * 未 configure 之前整套是 **no-op**（`enabled:false`），连那层函数调用都不产生。
 */

import {
  createEventLog,
  createRequestId,
  type DmbEventInput,
  type EventLogStats,
} from '../../shared/eventLog';
import { createHttpEventLogSink, resolveEventLogBase } from '../../shared/eventLogSink';

const sessionId = createRequestId('s');

let base: string | undefined;

const log = createEventLog({
  sessionId,
  // 未配置出口前一律 no-op：不许"发不出去还在攒"。
  enabled: false,
  sink: (events) => { createHttpEventLogSink(base)(events); },
});

/**
 * 用当前设置刷新出口地址。
 *
 * 幂等、可重复调用（设置变更时再调一次即可）。返回是否启用 ——
 * 调用方可以据此决定要不要往下走，但**不强制**（emit 本身就是 no-op）。
 */
export function configureBackgroundEventLog(options: {
  llmBaseUrl?: string;
  ocrServerBaseUrl?: string;
  /** 用户侧的通道开关（弹窗「本机事件日志」）；缺省视为开。false = 一条都不发。 */
  enabled?: boolean;
  /** 是否允许写逐行原文/译文（隐私闸门，见 shared/config 的 `logSourceText`）。 */
  verbose?: boolean;
}): boolean {
  const next = resolveEventLogBase({
    llmBaseUrl: options.llmBaseUrl,
    ocrServerBaseUrl: options.ocrServerBaseUrl,
  });
  const online = next !== undefined;
  base = next;
  log.setEnabled(online && options.enabled !== false);
  log.setVerbose(online && options.verbose === true);
  return next !== undefined;
}

/** 同步 O(1)。未启用时直接返回。 */
export function emitBackgroundEvent(input: DmbEventInput): void {
  log.emit(input);
}

/** background 侧的失败上报（设计 §8：failure 第一公民）。 */
export function emitBackgroundFailure(input: {
  message: string;
  stage: string;
  module: string;
  fn?: string;
  runId?: string;
  pageKey?: string;
  requestId?: string;
  code?: string;
  type?: string;
  retryable?: boolean;
  what?: Record<string, unknown>;
  durMs?: number;
}): void {
  log.emit({
    level: 'error',
    kind: 'failure',
    runId: input.runId,
    pageKey: input.pageKey,
    requestId: input.requestId,
    where: { repo: 'extension', module: input.module, fn: input.fn },
    what: { stage: input.stage, retryable: input.retryable, ...input.what },
    err: { type: input.type, code: input.code, message: input.message },
    ...(input.durMs !== undefined ? { dur_ms: input.durMs } : {}),
  });
}

/** 立刻冲刷（例如 SW 即将休眠前）。 */
export function flushBackgroundEventLog(): void {
  log.flush();
}

/** 自检/导出用。 */
export function backgroundEventLogStats(): EventLogStats {
  return log.stats();
}

/** 测试用：把实例复位到"未配置"状态。 */
export function resetBackgroundEventLog(): void {
  base = undefined;
  log.setEnabled(false);
  log.setVerbose(false);
}
