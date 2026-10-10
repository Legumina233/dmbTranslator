/**
 * M2 · 统一事件流的**出口**（设计见 `docs/CHANGELOG.md` §二）。
 *
 * ★ 为什么单独一个文件：
 *   `eventLog.ts` 只管"怎么攒"（缓冲/批量/丢弃），本文件只管"往哪发"。
 *   攒与发分开，background 与 offscreen 才能**复用同一份出口解析** ——
 *   否则两侧各写一遍地址推导，迟早出现"一边发得出去、一边静默不发"（踩过：
 *   整页日志的地址曾搭在 OCR 引擎条件下，用户换引擎后日志全丢）。
 *
 * ★ 硬约束（用户口径 2026-10-05：**不影响翻译任务的速度**）：
 *   sink 内部 fire-and-forget，**永不 await**，`keepalive` 保证页面/文档卸载也能发出；
 *   失败静默吞掉 —— 日志是旁路，不该弹错、不该拖慢翻译。
 *
 * 本模块**零 import**（只从 `eventLog.ts` 取类型），可离线自检。
 */

import type { EventLogSink } from './eventLog';

/** 地址推导的输入：只取"翻译服务地址"，**不看 OCR 引擎设置**（理由见 `resolveEventLogBase`）。 */
export type EventLogBaseSource = {
  ocrServerBaseUrl?: string;
  llmBaseUrl?: string;
};

/** 只可能是本机的三个主机名。**外发地址一律不接受**（见下）。 */
const loopbackHostnamePattern = /^(127\.0\.0\.1|localhost|\[::1\])$/i;

/**
 * 解析成 loopback 的 origin；不是本机 / 解析不了 → undefined。
 *
 * ★ 为什么必须有这道闸：`llmBaseUrl` 在云端模式下是 `https://api.openai.com/v1`，
 *   而事件里带**失败详情、文件路径、主机名** —— 一旦拿它拼 `${base}/log/events`，
 *   每次 flush 都会把本机日志 POST 给第三方，而且 sink 吞错、**全程静默**。
 *   这跟设计 §1「日志永不外发、只在用户主动导出时离开本机」是直接冲突的，所以
 *   宁可让事件流整体关成 no-op，也不外发一个字节。
 */
function toLoopbackOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!loopbackHostnamePattern.test(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * 推导事件流的投递地址（本机服务 `http://127.0.0.1:11436`）。
 *
 * **不能只认 `ocrServerBaseUrl`**：那个字段只在 OCR 引擎是 `manga_ocr_server` 时才有值，
 * 而事件流是发给本机服务、与"OCR 走不走服务端"无关。一旦用户换了 OCR 引擎，地址就成了
 * undefined，整条旁路静默失效 —— 翻译明明在跑、错误明明在抛，日志却一条都没有（踩过）。
 *
 * 所以：优先 OCR 服务地址；没有就退回**翻译服务的同源地址**
 * （`http://127.0.0.1:11436/v1` → `http://127.0.0.1:11436`，正是 `/log/events` 所在）。
 * 两条路都**必须落在 loopback**，否则一律 undefined —— 由调用方把事件流整体关成 no-op。
 */
export function resolveEventLogBase(source: EventLogBaseSource): string | undefined {
  const ocr = (source.ocrServerBaseUrl ?? '').trim();
  if (ocr) {
    const origin = toLoopbackOrigin(ocr);
    if (origin) return origin;
  }
  const llm = (source.llmBaseUrl ?? '').trim();
  if (!llm) return undefined;
  return toLoopbackOrigin(llm);
}

/**
 * 造一个"批量 POST 到本机服务 `/log/events`"的 sink。
 *
 * `base` 为空时返回一个**什么都不做的** sink（而不是让调用方判空）——
 * 这样调用方不用在 emit 前后各判一次，也就不会漏判。
 */
export function createHttpEventLogSink(
  base: string | undefined,
  fetchImpl?: typeof fetch,
): EventLogSink {
  const target = base ? `${base.replace(/\/+$/, '')}/log/events` : '';
  if (!target) return () => {};
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return (events) => {
    if (events.length === 0) return;
    void doFetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true,
    }).catch(() => {
      // 旁路失败不算失败：日志不该影响翻译，也不该弹错误。
    });
  };
}
