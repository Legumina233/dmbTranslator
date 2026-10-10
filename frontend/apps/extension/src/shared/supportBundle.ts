/**
 * M3 · 支持包（设计见 `docs/CHANGELOG.md` §二）。
 *
 * ★ 为什么事件由**服务端**出，不是扩展自己攒：
 *   扩展侧的事件缓冲是"过路"的 —— 满 32 条或 500ms 就 flush 走，job 结束还会强制 flush，
 *   所以任何时刻去内存里取，拿到的通常是空的。事件真正的家是服务端的
 *   `logs/events/YYYY-MM-DD.events.jsonl`。扩展在这里只负责**补自己才知道的两段**
 *   （env / settings）并把服务端那半拼进来。
 *
 * ★ 铁律（沿用诊断器那套）：
 *   **"没采到"与"采到了但为空"必须能分开**。服务端没起 / 请求失败时写
 *   `server: null` + `serverError`，**绝不给一个空壳假装采完了** ——
 *   那样排查的人会以为"事件确实一条都没有"，实际是压根没连上。
 *
 * 本模块只 import 类型（纯逻辑，可离线自检）。
 */

import type { DmbEvent } from './eventLog';

/** 服务端 `GET /support` 的响应（字段都可能缺席，读取端一律容错）。 */
export type ServerSupportPayload = {
  v?: number;
  generatedAt?: string;
  exporter?: { repo?: string; commit?: string | null };
  window?: {
    files?: string[];
    totalLines?: number;
    returned?: number;
    truncated?: boolean;
    days?: number;
  };
  summary?: Record<string, unknown>;
  events?: DmbEvent[];
  server?: {
    health?: Record<string, unknown>;
    tail?: { path?: string | null; lines?: string[]; error?: string | null };
    eventLogPath?: string;
    eventLogEnabled?: boolean;
  };
  privacy?: Record<string, unknown>;
};

export type SupportBundleEnv = {
  extensionVersion?: string;
  /** 浏览器 UA（原始，不打码 —— 排障需要它）。 */
  browser?: string;
  platform?: string;
  language?: string;
  timezone?: string;
};

export type SupportBundle = {
  v: 2;
  generatedAt: string;
  exporter: { repo: 'dmb-extension'; commit?: string | null };
  env: SupportBundleEnv;
  /** 已脱敏的设置快照（调用方用 `sanitizeExtensionSettings` 喂进来）。 */
  settings: unknown;
  summary: Record<string, unknown>;
  events: DmbEvent[];
  server: ServerSupportPayload['server'] | null;
  /** 服务端那一半没拿到的原因。**有值就说明 events 不可信**。 */
  serverError?: string;
  privacy: {
    containsOriginalText: boolean;
    redacted: string[];
    note: string;
  };
};

/**
 * 拼装支持包。
 *
 * `server` 为 null（没连上）时：`events` 给空数组、`summary` 里写明"未取到"，
 * 并在顶层留 `serverError`。**不伪造 summary** —— 空的统计比"没有统计"更容易误导。
 */
export function buildSupportBundle(input: {
  env: SupportBundleEnv;
  settings: unknown;
  server?: ServerSupportPayload | null;
  serverError?: string;
  now?: Date;
}): SupportBundle {
  const server = input.server ?? null;
  const events = server?.events ?? [];
  const reached = server !== null;
  return {
    v: 2,
    generatedAt: (input.now ?? new Date()).toISOString(),
    exporter: { repo: 'dmb-extension', commit: null },
    env: input.env,
    settings: input.settings ?? null,
    summary: reached
      ? (server?.summary ?? { note: '服务端未返回 summary' })
      : {
        note: '未取到服务端事件（服务未运行或地址不可达），以下统计不可用',
        ...(input.serverError ? { reason: input.serverError } : {}),
      },
    events,
    server: server?.server ?? null,
    ...(input.serverError ? { serverError: input.serverError } : {}),
    privacy: {
      containsOriginalText: reached
        ? Boolean((server?.privacy as { containsOriginalText?: boolean } | undefined)
          ?.containsOriginalText)
        : false,
      redacted: ['settings.*key', 'url.query'],
      note: '默认不含漫画原文/译文；原文只在用户显式打开详细层时出现。',
    },
  };
}

export const defaultSupportServerBase = 'http://127.0.0.1:11436';

/**
 * 推导支持包该去哪台本机服务取事件。
 *
 * **只认本机地址**：LLM 的 base 可能是 `api.openai.com` 之类，拿它拼 `/support`
 * 只会得到一个 404 或别人的服务。不是本机就退回默认端口 —— 支持包这件事
 * 本来就只对本机 dmb 服务有意义（设计 §4.2：日志永不外发）。
 */
export function resolveSupportServerBase(options: {
  customBaseUrl?: string;
  fallback?: string;
} = {}): string {
  const raw = (options.customBaseUrl ?? '').trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)) {
        return url.origin;
      }
    } catch {
      // 坏地址就当没配，走默认。
    }
  }
  return options.fallback ?? defaultSupportServerBase;
}
/**
 * 导出的文件名前缀。
 *
 * **不在这里拼完整文件名**：`downloadJson` 已经统一补时间戳与扩展名，
 * 再留一个"自己拼文件名"的函数就是第二份会漂移的真相（而且没人调用）。
 */
export const supportBundleFilenamePrefix = 'dmb-support';

/**
 * 拉服务端那一半。
 *
 * 失败**如实抛出**（由调用方转成 `serverError`）—— 不在内部吞成"空结果"，
 * 否则调用方无法区分"服务没起"和"事件确实为空"。
 */
export async function fetchServerSupport(
  base: string,
  options: { limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<ServerSupportPayload> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${base.replace(/\/+$/, '')}/support${options.limit ? `?limit=${options.limit}` : ''}`;
  const response = await doFetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`服务端返回 HTTP ${response.status}`);
  }
  return await response.json() as ServerSupportPayload;
}
