/**
 * M4 Step 14a · 预取数据链（隔离世界侧协调器）—— 施工修订二（预取预翻译定稿）。
 *
 * **目标**：用户看第 N 页时，后台把 N+1…N+4 的 showpage JSON 拿到手，
 * 为 Step 14b（预取执行器：提取原图 URL → 跑管线 → 译图进内存层）备好数据。
 * **本模块不碰管线、不碰 DOM、不发网络** —— 只决定「什么时候、要哪一页」。
 *
 * **数据从哪来**：隔离世界**直连 api.php**（showpageClient，请求形态照归档真机已验证实现
 * 原样回放；showkey 从页面内联脚本提取）。发起与接收是两条独立通道，
 * 本模块只管发起（去重 + 节流）和接收（入库 + 链下一环）。
 *
 * **链式取页**：当前页 imgkey 就在 pathname 里（`/s/{imgkey}/{gid}-{page}`，M0 实测 8 样本全符合）；
 * 每页 showpage JSON 的 `n`/`i3` 字段带相邻页的 `load_image(页,'imgkey')` 与 `/s/…` href ——
 * 取「大于链上页号的最小页」作为下一环，深度封顶（调度器窗口语义 N+1…N+4，见 pageScheduler.ts）。
 *
 * **风控（M3b 同款参数）**：所有请求经串行泵、同 host 最小间隔 250ms；时钟/sleep 可注入以便离线钉死。
 * 直连通道熔断（连续失败且零成功）→ 本模块也不再发（notifyExecutorFailed）。
 *
 * **纪律**：零 import；间隔是请求节流参数、不是判定时间阈值；一切状态变化发布遥测快照
 * （真机读 `data-m5-chain` 即可核对，见 index.ts 的接线）。
 */

/** 一次 showpage 请求的发起参数（gid/showkey/端点由直连执行器自行补齐）。 */
export type ShowpageRequestParams = {
  page: number;
  imgkey: string;
};

export type PrefetchChainSnapshot = {
  enabled: boolean;
  /** 熔断原因（空串 = 未熔断）。 */
  disabledReason: string;
  /** 已拿到 JSON 的页键数（本文档生命周期）。 */
  knownCount: number;
  /** 已发起的 showpage 请求数。 */
  requested: number;
  /** 收到 showpage JSON 的次数（去重后）。 */
  received: number;
  /** 因去重被跳过的重复请求次数。 */
  duplicates: number;
  /** 请求最终失败的次数（每次失败都计，含自动补发的那次）。 */
  failed: number;
  /** 链到达过的最远页号（0 = 尚无）。 */
  farthestPage: number;
  /** 最近一次到达的页键。 */
  lastPageKey: string;
};

export type PrefetchChainDeps = {
  /** 向直连执行器发起一次 showpage 请求（异步发饼；结果经 onShowpageJson 回流）。 */
  requestShowpage(params: ShowpageRequestParams): void;
  /** 查内存档（本文档生命周期内已拿到的 JSON）：有就不发网络，直接当链上已有的一环。 */
  getJson(pageKey: string): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 每次状态变化发布快照（真机接线写 `data-m5-chain`；测试里用计数器接住）。 */
  publish(snapshot: PrefetchChainSnapshot): void;
};

export type PrefetchChainOptions = {
  /** 窗口深度：允许请求的页号上限 = 到达页 + depth（调度器默认 4）。 */
  depth: number;
  /** 串行泵的最小请求间隔（M3b：250ms）。 */
  minIntervalMs: number;
};

export type PrefetchChain = {
  /** 页面到达（pathname 变化）。identity 来自 M0 的 pathname 解析，imgkey 来自同一 pathname。 */
  onPageArrived(identity: { gid: number; page: number }, currentImgkey: string | null): void;
  /** 收到一页 showpage JSON（直连执行器回流；主动请求的结果走同一条通道）。 */
  onShowpageJson(pageKey: string, json: string): void;
  /** 直连通道熔断 → 本模块停发。 */
  notifyExecutorFailed(reason: string): void;
  /**
   * 一次 showpage 请求**最终失败**（HTTP 错 / 非 JSON / 超时）。
   * 必须把该页从去重集里放出来 —— 否则它永远不会被再请求，而链是接龙结构：
   * 缺了这一页，它后面所有页的 imgkey 都拿不到（整条链断掉）。
   * 同时**自动补发一次**（每页上限 1 次）；再失败就交给下次到达时的走链补，不无限重试。
   */
  notifyDispatchFailed(gid: number, page: number): void;
  /**
   * 设置变更：改窗口深度（0 = 关闭预取链，不再发起任何 showpage 请求）。
   * 与执行器 setDepth 必须同步改 —— 只改一边会出现"链爬到 4 页外、执行器只派 2 页"，
   * 白花请求（M3b 风控口径下不该有）。
   */
  setDepth(depth: number): void;
  snapshot(): PrefetchChainSnapshot;
};

/** 从 `/s/{imgkey}/{gid}-{page}` 提取当前页 imgkey（非法输入返回 null）。 */
export function extractImgkeyFromPathname(pathname: string): string | null {
  const m = /^\/s\/([0-9a-f]+)\/(\d+)-(\d+)(?:[?#/]|$)/i.exec(pathname);
  return m ? m[1] : null;
}

/**
 * 从 showpage JSON 提取链的下一环：取「大于 fromPage 的最小页」。
 * 候选来源：`n`（导航 HTML：首/上/下/末四条 `load_image(页,'imgkey')`）与
 * `i3`（主图 anchor 的 onclick，指向下一页）。两者都缺 / JSON 损坏 → null（链断，调用方停止）。
 */
export function extractNextPageFromShowpage(
  json: string,
  fromPage: number,
): { page: number; imgkey: string } | null {
  let candidates: { page: number; imgkey: string }[] = [];
  try {
    const parsed = JSON.parse(json) as { n?: unknown; i3?: unknown };
    const haystacks: string[] = [];
    if (typeof parsed.n === 'string') haystacks.push(parsed.n);
    if (typeof parsed.i3 === 'string') haystacks.push(parsed.i3);
    const re = /load_image\(\s*(\d+)\s*,\s*'([0-9a-f]+)'\s*\)/g;
    for (const hay of haystacks) {
      for (const m of hay.matchAll(re)) {
        candidates.push({ page: Number(m[1]), imgkey: m[2] });
      }
    }
  } catch {
    return null;
  }
  const next = candidates
    .filter((c) => Number.isFinite(c.page) && c.page > fromPage && c.imgkey.length > 0)
    .sort((a, b) => a.page - b.page)[0];
  return next ?? null;
}

export function createPrefetchChain(
  deps: PrefetchChainDeps,
  options: PrefetchChainOptions,
): PrefetchChain {
  if (!Number.isFinite(options.depth) || options.depth < 0) {
    throw new Error(`非法预取深度：${options.depth}`);
  }
  if (!Number.isFinite(options.minIntervalMs) || options.minIntervalMs < 0) {
    throw new Error(`非法最小间隔：${options.minIntervalMs}`);
  }

  const known = new Set<string>(); // 已拿到 JSON 的页键
  const requestedOrKnown = new Set<string>(); // 去重集：已请求过 / 已有 JSON 的页键
  const state: PrefetchChainSnapshot = {
    enabled: true,
    disabledReason: '',
    knownCount: 0,
    requested: 0,
    received: 0,
    duplicates: 0,
    failed: 0,
    farthestPage: 0,
    lastPageKey: '',
  };

  let windowAnchorPage = 0; // 当前到达页 —— 请求上限 = 它 + depth
  let lastDispatchAt = -Number.POSITIVE_INFINITY;
  let pump: Promise<void> = Promise.resolve();
  let depth = options.depth; // 设置可改（setDepth）；0 = 停发

  function publish(): void {
    state.knownCount = known.size;
    deps.publish({ ...state });
  }

  function disabledByExecutor(): boolean {
    return state.disabledReason.length > 0;
  }

  /** 串行泵：保证任意两次 showpage 请求之间至少隔 minIntervalMs。 */
  function dispatch(params: ShowpageRequestParams): void {
    pump = pump.then(async () => {
      const wait = options.minIntervalMs - (deps.now() - lastDispatchAt);
      if (wait > 0) await deps.sleep(wait);
      lastDispatchAt = deps.now();
      state.requested += 1;
      deps.requestShowpage(params);
      publish();
    });
  }

  /** 已发出的请求参数（按页键存）：失败重试要原样重发 —— imgkey 只有发出去那一刻有一份。 */
  const dispatchedParams = new Map<string, ShowpageRequestParams>();
  /** 每页的**自动**重试次数（上限 1）：失败一次自动补发一次，再失败就交给下次到达时走链补。 */
  const autoRetryCount = new Map<string, number>();
  const maxAutoRetries = 1;

  function dispatchPage(pageKey: string, params: ShowpageRequestParams): void {
    dispatchedParams.set(pageKey, params);
    dispatch(params);
  }

  /** 链的下一环：窗口内、未请求过 → 入队。 */
  function requestNext(next: { page: number; imgkey: string }, gid: number): void {
    if (disabledByExecutor()) return;
    if (next.page > windowAnchorPage + depth) return; // 窗口外：不要
    const pageKey = `${gid}-${next.page}`;
    if (requestedOrKnown.has(pageKey)) {
      state.duplicates += 1;
      return;
    }
    requestedOrKnown.add(pageKey);
    if (next.page > state.farthestPage) state.farthestPage = next.page;
    dispatchPage(pageKey, { page: next.page, imgkey: next.imgkey });
  }

  /** 收到一页 JSON：入库计数 + 接链下一环。 */
  function ingest(pageKey: string, json: string): void {
    const page = Number(pageKey.split('-')[1]);
    const gid = pageKey.split('-')[0];
    known.add(pageKey);
    state.received += 1;
    if (Number.isFinite(page) && page > state.farthestPage) state.farthestPage = page;
    publish();
    const next = extractNextPageFromShowpage(json, page);
    if (next) requestNext(next, Number(gid));
  }

  /**
   * **沿已在手的数据把链走到新窗口边缘**（2026-10-04 根因修复）。
   *
   * 链是逐跳爬的：要请求第 P 页，必须持有 P 的 imgkey，而 imgkey 只在前一页的 JSON 里。
   * 老逻辑里，到达页的数据若已在手就**原地返回**，于是新窗口的边缘页（上一个锚点的窗口
   * 装不下的那一页）永远不会被请求 —— 每翻一页窗口尾部就永久缺一页数据
   * （真机表现：计数卡在 2/3 且标注"数据缺 1 页"，翻页后有时只能冷启动）。
   *
   * 所以到达时要重新走一遍：从当前页出发，逐跳读**已在手**的 JSON 找下一页；
   * 遇到第一个缺口页（未请求过）就派发它，然后停 —— 它的 JSON 回流后会由 ingest 接着爬。
   * 全程只读内存档 + 派发缺失的那一页，不发任何多余请求，也不设任何定时器。
   */
  async function advanceToWindowEdge(anchor: { gid: number; page: number }): Promise<void> {
    let cursor = anchor.page;
    // 最多 depth+1 跳：窗口就这么宽，多出的只是防坏数据成环的护栏。
    for (let hop = 0; hop <= depth + 1; hop += 1) {
      if (disabledByExecutor()) return;
      const cursorKey = `${anchor.gid}-${cursor}`;
      const json = known.has(cursorKey) ? await deps.getJson(cursorKey) : null;
      if (typeof json !== 'string' || json.length === 0) return; // 这一跳的数据还没到：等它回流
      const next = extractNextPageFromShowpage(json, cursor);
      if (!next) return; // 没有下一页（末页）
      if (next.page > windowAnchorPage + depth) return; // 已到窗口边缘：窗口填满了
      const nextKey = `${anchor.gid}-${next.page}`;
      if (!requestedOrKnown.has(nextKey)) {
        requestNext(next, anchor.gid); // 派发缺口；它回流后 ingest 会继续往前爬
        return;
      }
      if (!known.has(nextKey)) return; // 在飞：等它回来（ingest 会接上）
      cursor = next.page; // 已在手：继续往前找缺口
    }
  }

  return {
    onPageArrived(identity, currentImgkey): void {
      if (disabledByExecutor()) return;
      windowAnchorPage = identity.page;
      state.lastPageKey = `${identity.gid}-${identity.page}`;
      const pageKey = state.lastPageKey;
      if (known.has(pageKey)) {
        state.duplicates += 1;
        publish();
        // 到达页的数据已在手 —— 但**新窗口的边缘是新的**，必须继续往前走到边缘，
        // 否则每翻一页都会永久缺一页（见 advanceToWindowEdge 的说明）。
        void advanceToWindowEdge(identity);
        return;
      }
      void (async () => {
        // 内存档已有 → 不发网络，直接当链上已有的一环继续接
        const stored = await deps.getJson(pageKey);
        if (disabledByExecutor()) return;
        if (typeof stored === 'string' && stored.length > 0) {
          requestedOrKnown.add(pageKey);
          ingest(pageKey, stored);
          void advanceToWindowEdge(identity); // 已有页也要把窗口边缘推到新位置
          return;
        }
        if (known.has(pageKey) || requestedOrKnown.has(pageKey)) return; // 异步期间已被别处请求/收到
        if (!currentImgkey) return; // 没有 imgkey 就发不了 showpage —— 如实停在这
        requestedOrKnown.add(pageKey);
        if (identity.page > state.farthestPage) state.farthestPage = identity.page;
        dispatchPage(pageKey, { page: identity.page, imgkey: currentImgkey });
      })();
      publish();
    },

    onShowpageJson(pageKey, json): void {
      if (disabledByExecutor()) return;
      if (typeof json !== 'string' || json.length === 0) return;
      if (!requestedOrKnown.has(pageKey)) requestedOrKnown.add(pageKey); // 被动收到的也入集
      if (known.has(pageKey)) {
        state.duplicates += 1;
        return; // 同页 JSON 重复回流（去重，不重复接链）
      }
      ingest(pageKey, json);
    },

    notifyExecutorFailed(reason): void {
      if (state.disabledReason.length > 0) return;
      state.disabledReason = reason;
      publish();
    },

    notifyDispatchFailed(gid, page): void {
      const pageKey = `${gid}-${page}`;
      if (known.has(pageKey)) return; // 迟到的失败：其实早已成功
      state.failed += 1;
      requestedOrKnown.delete(pageKey); // 放出去：允许补发 / 允许走链重新请求
      publish();
      if (disabledByExecutor()) return;
      if (page < windowAnchorPage || page > windowAnchorPage + depth) return; // 已出窗：不追
      const attempts = autoRetryCount.get(pageKey) ?? 0;
      if (attempts >= maxAutoRetries) return; // 自动补发用完：等下次到达走链再补
      const params = dispatchedParams.get(pageKey);
      if (!params) return; // 不是本模块发的（无原参数）：无从补发
      autoRetryCount.set(pageKey, attempts + 1);
      requestedOrKnown.add(pageKey);
      dispatchPage(pageKey, params);
    },

    setDepth(nextDepth): void {
      if (!Number.isFinite(nextDepth) || nextDepth < 0) return;
      depth = nextDepth;
      state.enabled = nextDepth > 0 && state.disabledReason.length === 0;
      publish();
    },

    snapshot(): PrefetchChainSnapshot {
      return { ...state };
    },
  };
}
