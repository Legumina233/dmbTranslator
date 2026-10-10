/**
 * M4 Step 14a · showpage 直连执行器（隔离世界 → api.php）。
 *
 * 请求形态**照归档真机已验证实现原样回放**（`m4-archive-20261003` 版 index.ts，
 * probe/m5-flashdiag 实测 dispatchOk=4 / dispatchFail=0）：
 * `POST {method:'showpage', gid, page, imgkey, showkey}`、带凭据、响应 JSON 含 `p` 字段。
 *
 * **捕获源（施工修订二 §2.1）**：showkey 由接线方从页面**内联脚本**提取（真机实录坐实
 * showkey 以 JSON 字面量内嵌在页面里）；端点用推导值（归档真机捕获同值）。
 * showkey/端点/gid 未就绪时请求**排队**，就绪即冲（链的 250ms 节流在 prefetchChain 侧）。
 *
 * **熔断**：连续失败 ×3 且成功为 0 → 通知接线方熔断（本次文档生命周期不再发请求）。
 * 一旦成功过一次就不再熔断 —— 偶发失败不该关掉整条通道。
 *
 * **失败上报（2026-10-04）**：每次请求**最终失败**（HTTP 错 / 非 JSON / 缺 p / 超时）都经
 * `onDispatchFailed` 回调接线方 → 预取链。链是接龙结构（要请求第 P 页必须持有 P 的 imgkey，
 * imgkey 只在前一页 JSON 里），一次失败不补救就会让它后面所有页都拿不到数据，所以失败必须
 * 让链知道（链负责把该页放出去重请求）。超时用 `AbortSignal.timeout`：fetch 挂死也算失败，
 * 否则链上留一个永远等不到的洞。
 *
 * **纪律**：零 import；失败计数只用于熔断，不是判定时间阈值。超时是网络参数，不是判定阈值。
 */

/** 单次 showpage 请求的硬超时（毫秒）：挂死的响应视同失败，不把链吊死在一个请求上。 */
const REQUEST_TIMEOUT_MS = 15_000;

/** 从内联脚本文本里提取 showkey。同时认 JSON 形态与赋值形态（真机两种都见过）。 */
export function extractShowkeyFromScripts(sources: readonly string[]): string | null {
  for (const source of sources) {
    if (typeof source !== 'string' || source.length === 0) continue;
    const jsonForm = /"showkey"\s*:\s*"([0-9a-zA-Z]+)"/.exec(source);
    if (jsonForm) return jsonForm[1];
    const assignForm = /\bshowkey\s*=\s*['"]([0-9a-zA-Z]+)['"]/.exec(source);
    if (assignForm) return assignForm[1];
  }
  return null;
}

/** 端点兜底推导（正式值口径：归档真机捕获 endpointSource=captured 与此同值）。 */
export function deriveShowpageEndpoint(hostname: string): string | null {
  if (/(^|\.)exhentai\.org$/.test(hostname)) return 'https://s.exhentai.org/api.php';
  if (/(^|\.)e-hentai\.org$/.test(hostname)) return 'https://api.e-hentai.org/api.php';
  return null;
}

export type ShowpageClientStats = {
  ok: number;
  fail: number;
  failStreak: number;
  pending: number;
  circuitOpen: boolean;
};

export type ShowpageClientOptions = {
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  getGid(): number;
  getShowkey(): string;
  getEndpoint(): string | null;
  onJson(pageKey: string, json: string): void;
  onCircuitOpen(reason: string): void;
  /** 单次请求最终失败（含超时）。接线方转给预取链放出该页重请求；缺省 = 只计数不补救（旧行为）。 */
  onDispatchFailed?(params: ShowpageDispatchParams): void;
  /** 请求硬超时（毫秒）。缺省 15s；测试可注入短超时（AbortSignal.timeout 是原生定时器，fake 时钟推不动）。 */
  requestTimeoutMs?: number;
};

/** 一次 showpage 请求的完整身份（失败上报用，gid 由客户端补齐）。 */
export type ShowpageDispatchParams = { page: number; imgkey: string; gid: number };

export type ShowpageClient = {
  dispatch(params: { page: number; imgkey: string }): void;
  /** showkey/端点/gid 就绪时调用：冲掉排队中的请求（保持排队顺序）。 */
  notifyReady(): void;
  stats(): ShowpageClientStats;
};

export function createShowpageClient(options: ShowpageClientOptions): ShowpageClient {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const pending: { page: number; imgkey: string }[] = [];
  const stats = { ok: 0, fail: 0, failStreak: 0, pending: 0, circuitOpen: false };

  const ready = (): boolean =>
    options.getShowkey().length > 0 && options.getEndpoint() !== null && options.getGid() > 0;

  function send(params: { page: number; imgkey: string }): void {
    const gid = options.getGid();
    const endpoint = options.getEndpoint();
    const showkey = options.getShowkey();
    void fetchImpl(endpoint ?? '', {
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ method: 'showpage', gid, page: params.page, imgkey: params.imgkey, showkey }),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const record = JSON.parse(text) as { p?: unknown };
        const page = Number(record.p);
        if (!Number.isFinite(page)) throw new Error('响应缺 p 字段');
        stats.ok += 1;
        stats.failStreak = 0;
        options.onJson(`${gid}-${page}`, text);
      })
      .catch((reason: unknown) => {
        stats.fail += 1;
        stats.failStreak += 1;
        options.onDispatchFailed?.({ page: params.page, imgkey: params.imgkey, gid });
        if (!stats.circuitOpen && stats.failStreak >= 3 && stats.ok === 0) {
          stats.circuitOpen = true;
          options.onCircuitOpen(`直连请求连续失败×${stats.failStreak}：${String(reason)}`);
        }
      });
  }

  function flushPending(): void {
    while (pending.length > 0 && ready() && !stats.circuitOpen) {
      const next = pending.shift();
      if (next) send(next);
    }
    stats.pending = pending.length;
  }

  return {
    dispatch(params): void {
      if (stats.circuitOpen) return;
      if (!ready()) {
        pending.push(params); // showkey/端点/gid 未就绪：先排队，就绪即冲
        stats.pending = pending.length;
        return;
      }
      send(params);
    },

    notifyReady(): void {
      flushPending();
    },

    stats(): ShowpageClientStats {
      return { ...stats };
    },
  };
}
