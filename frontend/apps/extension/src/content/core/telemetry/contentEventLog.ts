/**
 * M2b · 内容脚本侧的事件流客户端（设计 §12 M2：failure 覆盖**全部**抛出点）。
 *
 * ★ 为什么内容侧不能自己发：
 *   content script 的 `fetch` 受**页面 CSP**约束（`connect-src`），发不到
 *   `http://127.0.0.1:11436`；而 background / offscreen 用的是扩展自己的 CSP，发得出去。
 *   所以这里的 sink 不是 HTTP，而是 `sendRuntimeMessage({type:'mt:event-log'})` ——
 *   **出口实现仍然只有一处**（background），内容侧只负责"攒 + 交"。
 *
 * ★ 开关取舍（记录在案）：
 *   内容侧**拿不到 settings**（配置的持有者是 background），因此这里没有"是否开启"的本地依据。
 *   做法是：`enabled: true`，但**只在失败路径 emit** —— 成功路径一条都不记。
 *   于是代价被限定在"本来就要弹错误 UI 的那一次异常"上：一次 O(1) 的内存 push
 *   加（最多）一次异步消息往返，不影响正常翻译的任何一跳。
 */

import { createEventLog, createRequestId, type DmbEventInput } from '../../../shared/eventLog';
import { sendRuntimeMessage } from '../../../shared/messages';

const sessionId = createRequestId('cs');

const log = createEventLog({
  sessionId,
  enabled: true,
  verbose: false,
  sink: (events) => {
    // 剥掉本地编号（v/ts/seq/sessionId）：由 background 统一打点，避免两套编号打架。
    const payload: DmbEventInput[] = events.map(({ v: _v, ts: _ts, seq: _seq, sessionId: _sid, ...rest }) => rest);
    if (payload.length === 0) return;
    // fire-and-forget：日志是旁路，永不 await、永不因它改变主流程。
    void sendRuntimeMessage({ type: 'mt:event-log', events: payload }).catch(() => {
      // 内容脚本可能已失效（页面卸载/扩展更新），静默即可。
    });
  },
});

/** 同步 O(1)。 */
export function emitContentEvent(input: DmbEventInput): void {
  log.emit(input);
}

/**
 * 内容侧失败上报。**只报 pipeline 之外的失败** ——
 * 下载失败归 background 的第一现场（带结构化候选明细），pipeline 内失败归 offscreen，
 * 这里重复记只会稀释信号。
 */
export function emitContentFailure(input: {
  message: string;
  stage: string;
  module: string;
  fn?: string;
  pageKey?: string;
  runId?: string;
  code?: string;
  type?: string;
  retryable?: boolean;
  what?: Record<string, unknown>;
  durMs?: number;
}): void {
  log.emit({
    level: 'error',
    kind: 'failure',
    pageKey: input.pageKey,
    runId: input.runId,
    where: { repo: 'extension', module: input.module, fn: input.fn },
    what: { stage: input.stage, retryable: input.retryable, ...input.what },
    err: { type: input.type, code: input.code, message: input.message },
    ...(input.durMs !== undefined ? { dur_ms: input.durMs } : {}),
  });
}

/** 页面即将卸载时把缓冲冲出去。 */
export function flushContentEventLog(): void {
  log.flush();
}
