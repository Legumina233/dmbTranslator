/**
 * M4 Step 14b · 预取执行器 —— showpage JSON 入手 → 提取原图 URL → 经调度器派发真实翻译。
 *
 * **口径（施工修订二 §2.2/§2.6 + 2026-10-03 用户设置项）**：
 * - 预载**下一页窗口**（distance ≥ 1）由 `depth` 单独控制，**深度 0 = 关闭预载**；
 *   **当前页是否自动翻译由设置决定**（`autoTranslateOnEnter`，默认 false = 保持"点按钮才译"；
 *   用户开「进入自动翻译」即 true）。
 *   ★ 两个旋钮**正交、互不携带**：深度 > 0 / 自动翻译关 = 后方几页先译好、当前页仍等点击；
 *   自动翻译开 / 深度 0 = 到达即译当前页、但**不**向后跑管线。
 *   （2026-10-05 曾另有一个 `prefetchEnabled` 布尔开关表达"要不要预载"，
 *   2026-10-09 删除 —— 它与 `depth = 0` 数学等价：深度 0 时
 *   `page >= currentPage + 1 && page <= currentPage` 无解，后页自然出局。）
 * - `depth` / `autoTranslateOnEnter` 都可**运行时改**（设置变更即调
 *   `setDepth`/`setAutoTranslateOnEnter`）；
 * - 本执行器是这两个设置的**运行时唯一权威**：`snapshot()` 除计数外也回这两个值，
 *   内容脚本右下角的开关直接投影它，不再自存副本
 *   （2026-10-09 收敛：此前 content 侧另存一份 `prefetchToggleDepth`/`autoTranslateToggleOn`，
 *   那份副本与这里实际生效的值可以漂移 —— 曾经长出过"开关显示开、深度却是 0"的第三态文案）；
 * - 「JSON 已入库 + 内存未命中」才派发（busy = 在跑或已有译图 → 跳过）；
 * - 经 `PageScheduler` 派发：**并发恒 1**（16GB 显存约束）、窗口门 N+1…N+4；
 * - 到达新页时 `retarget`：窗口平移，出窗任务安静离队（不碰任何缓存）。
 *
 * **本模块不发网络、不跑管线** —— translate 由接线方注入（真实翻译任务的唯一出口）。
 * 原图 URL 从 showpage JSON 的 `i3` 提取（真机实录：`i3` 就是
 * `<a onclick=…><img id="img" src="原图URL"></a>`，图址含逐请求签名，只能从这里拿）。
 */

import { PageScheduler } from './pageScheduler';

/** 从 showpage JSON 提取主图原图 URL（`i3` 里第一个 `<img>` 的 src）；损坏/缺失 → null。 */
export function extractImageFromShowpage(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { i3?: unknown };
    if (typeof parsed.i3 !== 'string') return null;
    const m = /<img\b[^>]*\ssrc="([^"]+)"/i.exec(parsed.i3);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export type PrefetchExecutorSnapshot = {
  /** 当前生效的窗口深度（**0 = 关闭预载**）—— 与 `setDepth` 写入的值一致。 */
  depth: number;
  /** 当前生效的"到达即译当前页"开关 —— 与 `setAutoTranslateOnEnter` 写入的值一致。 */
  autoTranslateOnEnter: boolean;
  knownUrls: number;
  submitted: number;
  skippedBusy: number;
  skippedNoImage: number;
  outOfWindow: number;
  queued: readonly string[];
  active: number;
};

export type PrefetchExecutorDeps = {
  /** 该页是否"在跑或已有译图"——忙页不重复派发。 */
  isBusy(pageKey: string): boolean;
  /**
   * 派发一个真实翻译任务。**返回值 = 任务完成**（或 void）——
   * 调度器的"并发恒 1"靠 await 它成立；即发即忘会让整队连发。
   */
  translate(pageKey: string, imageUrl: string): void | Promise<void>;
};

export type PrefetchExecutorOptions = {
  /** 预取窗口深度（N+1…N+depth，调度器同款默认 4）。**0 = 关闭预载**。 */
  depth: number;
  /**
   * 当前页是否也自动翻译（`distance ≥ 0`）。
   * false（默认）= 只用预载下一页窗口，当前页保持"点按钮才译"；
   * true = 到达页也入队（用户设置「进入自动翻译」打开）。
   */
  autoTranslateOnEnter?: boolean;
};

export type PrefetchExecutor = {
  onPageArrived(identity: { gid: number; page: number }): void;
  onShowpageJson(pageKey: string, json: string): void;
  resolveImageUrl(pageKey: string): string | undefined;
  /**
   * 设置变更：改预取窗口深度。**0 = 关闭预载** —— 这是"要不要预载"的唯一表达。
   * 改小到 0 时已排队的后页会被门挡住（留队但不派发），下一次 `onPageArrived`
   * 的 `retarget` 会把它们彻底清出队列。
   */
  setDepth(depth: number): void;
  /** 设置变更：当前页是否也自动翻译。 */
  setAutoTranslateOnEnter(enabled: boolean): void;
  /** 计数 + **当前生效的两个设置**（`depth` / `autoTranslateOnEnter`）。 */
  snapshot(): PrefetchExecutorSnapshot;
};

export function createPrefetchExecutor(
  deps: PrefetchExecutorDeps,
  options: PrefetchExecutorOptions,
): PrefetchExecutor {
  if (!Number.isFinite(options.depth) || options.depth < 0) {
    throw new Error(`非法预取深度：${options.depth}`);
  }

  const urls = new Map<string, string>(); // pageKey → 原图 URL（showpage i3）
  const counts = {
    submitted: 0,
    skippedBusy: 0,
    skippedNoImage: 0,
    outOfWindow: 0,
  };
  let currentPage = 0; // 0 = 尚未到达过任何页（接线保证先 onPageArrived 再有 JSON）
  let depth = options.depth;
  let autoTranslateOnEnter = options.autoTranslateOnEnter === true;

  const scheduler = new PageScheduler(
    ({ pageKey }: { pageKey: string }) => {
      const url = urls.get(pageKey);
      if (!url) return;
      counts.submitted += 1;
      return deps.translate(pageKey, url);
    },
    { maxDistance: depth },
  );

  function pageOf(pageKey: string): number {
    return Number(pageKey.split('-')[1]);
  }

  /** 窗口下界：不开自动翻译时当前页（distance 0）不入队；开了就放宽到 0。 */
  function distanceLowerBound(): number {
    return autoTranslateOnEnter ? 0 : 1;
  }

  function withinWindow(page: number): boolean {
    if (currentPage <= 0) return true; // 还没到达过任何页：先不设门（到达时会 retarget 重排）
    // 深度 0 时这条判断无解（`page >= currentPage + 1` 与 `page <= currentPage` 矛盾）
    // → 后页自然出局。「关闭预载」就是靠它成立的，不需要额外闸门。
    const lower = currentPage + distanceLowerBound();
    return page >= lower && page <= currentPage + depth;
  }

  function enqueueIfEligible(pageKey: string): void {
    const page = pageOf(pageKey);
    if (!Number.isFinite(page)) return;
    if (!withinWindow(page)) {
      counts.outOfWindow += 1;
      return;
    }
    if (deps.isBusy(pageKey)) {
      counts.skippedBusy += 1;
      return;
    }
    scheduler.enqueue({ pageKey, distance: Math.max(distanceLowerBound(), page - currentPage) });
  }

  return {
    onPageArrived(identity): void {
      currentPage = identity.page;
      // 窗口平移：仍在窗口内、有 URL、不忙的继续排（距离按新当前页重算）；出窗的安静离队。
      const lower = currentPage + distanceLowerBound();
      const plan = [...urls.entries()]
        .map(([pageKey]) => ({ pageKey, page: pageOf(pageKey) }))
        .filter((item) =>
          Number.isFinite(item.page) &&
          item.page >= lower &&
          item.page <= currentPage + depth &&
          !deps.isBusy(item.pageKey),
        )
        .map((item) => ({ pageKey: item.pageKey, distance: item.page - currentPage }));
      scheduler.retarget(plan);
      // 开了自动翻译：到达页的 URL 可能早已入手（预取过）→ 补一次入队。
      if (autoTranslateOnEnter) {
        const currentKey = `${identity.gid}-${identity.page}`;
        if (urls.has(currentKey)) enqueueIfEligible(currentKey);
      }
    },

    onShowpageJson(pageKey, json): void {
      const url = extractImageFromShowpage(json);
      if (!url) {
        counts.skippedNoImage += 1;
        return;
      }
      urls.set(pageKey, url);
      enqueueIfEligible(pageKey);
    },

    resolveImageUrl(pageKey): string | undefined {
      return urls.get(pageKey);
    },

    setDepth(nextDepth): void {
      if (!Number.isFinite(nextDepth) || nextDepth < 0) return;
      const widened = nextDepth > depth;
      depth = nextDepth;
      // 收窄（含降到 0 = 关闭预载）：`setMaxDistance` 会把超距任务挡在门外（留队但不派发），
      // 下一次 `onPageArrived` 的 `retarget` 再把它们彻底清出队列。
      scheduler.setMaxDistance(depth);
      if (!widened) return;
      // 放宽（含"从关闭恢复"）时，窗口内已有 URL、不忙的后页要**立刻补排**：
      // 它们可能早被上一次收窄时的 `retarget` 清出了队列，而 `onShowpageJson` 只在
      // JSON 新到手时才入队 —— 光靠它得等再翻一页才生效，用户会以为"开了没用"。
      // （这段原先长在 `setPrefetchEnabled(true)` 里；该开关 2026-10-09 删除后归到这里。）
      if (currentPage <= 0) return;
      for (let offset = 1; offset <= depth; offset += 1) {
        const pageKey = [...urls.keys()].find((key) => pageOf(key) === currentPage + offset);
        if (pageKey && !deps.isBusy(pageKey) && withinWindow(currentPage + offset)) {
          // `enqueue` 自带同 pageKey 去重（重复时保留更近的优先级），这里重复调用是安全的。
          scheduler.enqueue({ pageKey, distance: offset });
        }
      }
    },

    setAutoTranslateOnEnter(enabled): void {
      if (autoTranslateOnEnter === enabled) return;
      autoTranslateOnEnter = enabled;
      // 打开时把当前页补排上；关闭时当前页任务由 retarget 的窗口下界自然离队。
      if (enabled && currentPage > 0) {
        const currentKey = [...urls.keys()].find((key) => pageOf(key) === currentPage);
        if (currentKey && !deps.isBusy(currentKey)) {
          scheduler.enqueue({ pageKey: currentKey, distance: 0 });
        }
      }
    },

    snapshot(): PrefetchExecutorSnapshot {
      return {
        // 两个设置排在最前：调用方（内容脚本 UI）主要就靠它俩做投影。
        depth,
        autoTranslateOnEnter,
        knownUrls: urls.size,
        ...counts,
        queued: scheduler.queued.map((task) => task.pageKey),
        active: scheduler.active,
      };
    },
  };
}
