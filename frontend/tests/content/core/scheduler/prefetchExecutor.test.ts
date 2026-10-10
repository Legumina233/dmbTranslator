import { describe, expect, it, vi } from 'vitest';
import {
  createPrefetchExecutor,
  extractImageFromShowpage,
} from '../../../../apps/extension/src/content/core/scheduler/prefetchExecutor';

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const gid = 4218710;

function showpageJson(page: number, imageUrl: string): string {
  return JSON.stringify({
    p: page,
    k: page.toString(16).padStart(10, '0'),
    n: `<a onclick="return load_image(${page + 1}, 'aaaaaa${String(page + 1).padStart(4, '0')}')">…</a>`,
    i3: `<a onclick="return load_image(${page + 1}, 'aaaaaa${String(page + 1).padStart(4, '0')}')"><img id="img" src="${imageUrl}"></a>`,
  });
}

function createHarness(options: { busy?: (pageKey: string) => boolean; depth?: number } = {}) {
  const busy = options.busy ?? (() => false);
  const isBusy = vi.fn(busy);
  // 闸门：dispatch 的返回值 = 任务完成 —— 调度器的并发恒 1 靠它成立；
  // 测试里手动放行，才能稳定观察「一件在跑、其余排队」。
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const translate = vi.fn((_pageKey: string, _url: string) => gate);
  const executor = createPrefetchExecutor(
    { isBusy: (pageKey) => isBusy(pageKey), translate: (pageKey, url) => translate(pageKey, url) },
    { depth: options.depth ?? 4 },
  );
  return { executor, isBusy, translate, release };
}

describe('extractImageFromShowpage · 原图 URL 从 i3 提取', () => {
  it('真机实录格式：<a onclick=…><img id="img" src="原图URL"></a>', () => {
    const json = showpageJson(6, 'https://xx.hath.network/h/abc/keystamp=123');
    expect(extractImageFromShowpage(json)).toBe('https://xx.hath.network/h/abc/keystamp=123');
  });
  it('i3 缺失 / 损坏 → null', () => {
    expect(extractImageFromShowpage(JSON.stringify({ p: 6 }))).toBeNull();
    expect(extractImageFromShowpage('{{{')).toBeNull();
  });
});

describe('createPrefetchExecutor · 预取执行器', () => {
  it('收到窗口内页的 JSON → 入队并在调度时派发真实翻译（并发恒 1 交给调度器）', async () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    await tick(); // 调度器刻意的微任务延迟
    expect(h.translate).toHaveBeenCalledTimes(1);
    expect(h.translate).toHaveBeenCalledWith(`${gid}-6`, 'https://x/6.webp');
    expect(h.executor.snapshot().active).toBe(1);
    expect(h.executor.snapshot().submitted).toBe(1);

    h.release(); // 任务完成 → 不再有在飞
    await tick(); await tick();
    expect(h.executor.snapshot().active).toBe(0);
  });

  it('当前页（distance 0）与窗口外的页不派发 —— 本轮只预载下一页（施工修订二 §3.4）', () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp')); // 当前页
    h.executor.onShowpageJson(`${gid}-20`, showpageJson(20, 'https://x/20.webp')); // 窗外
    expect(h.translate).not.toHaveBeenCalled();
    // 两次各计一次：当前页（distance 0）一次 + 窗外（> depth）一次
    expect(h.executor.snapshot().outOfWindow).toBe(2);
    expect(h.executor.snapshot().queued).toEqual([]);
  });

  it('忙页（在跑 / 已有译图）跳过，不重复派发', () => {
    const h = createHarness({ busy: (pageKey) => pageKey === `${gid}-6` });
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    h.executor.onShowpageJson(`${gid}-7`, showpageJson(7, 'https://x/7.webp'));
    expect(h.executor.snapshot().skippedBusy).toBe(1);
    expect(h.executor.snapshot().queued).toEqual([`${gid}-7`]);
  });

  it('JSON 里提不出图（noImage）→ 计数并放弃该页', () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, JSON.stringify({ p: 6 }));
    expect(h.executor.snapshot().skippedNoImage).toBe(1);
    expect(h.executor.snapshot().knownUrls).toBe(0);
  });

  it('串行：一件在跑时其余排队；任务完成才派下一件', async () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    for (const page of [6, 7]) {
      h.executor.onShowpageJson(`${gid}-${page}`, showpageJson(page, `https://x/${page}.webp`));
    }
    await tick(); await tick();
    expect(h.executor.snapshot().active).toBe(1);
    expect(h.translate).toHaveBeenCalledTimes(1); // 只有第一件

    h.release();
    await tick(); await tick(); await tick();
    expect(h.translate).toHaveBeenCalledTimes(2); // 第二件接上
    expect(h.translate).toHaveBeenLastCalledWith(`${gid}-7`, 'https://x/7.webp');
  });

  it('翻页时窗口平移：新窗口内的继续排（距离重算），出窗的安静离队', async () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    for (const page of [6, 7, 8, 9]) {
      h.executor.onShowpageJson(`${gid}-${page}`, showpageJson(page, `https://x/${page}.webp`));
    }
    await tick(); await tick();
    // 并发恒 1：第一件（页 6）在跑，其余排队
    expect(h.executor.snapshot().active).toBe(1);

    h.executor.onPageArrived({ gid, page: 6 }); // 翻到 6：窗口变 7..10
    expect(h.executor.snapshot().queued).toEqual([`${gid}-7`, `${gid}-8`, `${gid}-9`]);
    // 用户翻到的 6 自己在跑 → 不进队列；完成即由 observeTranslation 贴图（14c 场景①）
  });

  it('翻页时新进入窗口的已有 URL 页会被补排上', () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-7`, showpageJson(7, 'https://x/7.webp')); // 在窗口内
    h.executor.onShowpageJson(`${gid}-12`, showpageJson(12, 'https://x/12.webp')); // 窗外
    h.executor.onPageArrived({ gid, page: 8 }); // 窗口变 9..12 → 12 进窗
    expect(h.executor.snapshot().queued).toContain(`${gid}-12`);
  });

  it('反向验证：负数深度当场抛错（0 是合法值 = 关闭预载）', () => {
    expect(() => createPrefetchExecutor({ isBusy: () => false, translate: () => undefined }, { depth: -1 })).toThrow();
    expect(() => createPrefetchExecutor({ isBusy: () => false, translate: () => undefined }, { depth: 0 })).not.toThrow();
  });

  // ── 2026-10-03 用户设置项：预载页数可调 + 进入自动翻译（distance 0 也译）──

  it('setDepth(0) 后不再派发任何预载任务（预载被关闭）', async () => {
    const h = createHarness();
    h.executor.setDepth(0);
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    await tick(); await tick();
    expect(h.translate).not.toHaveBeenCalled();
  });

  it('默认不自动翻译当前页（distance 0 不入队）', async () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp'));
    await tick(); await tick();
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.executor.snapshot().outOfWindow).toBe(1); // 当前页被"窗外"计数排除
  });

  it('开启 autoTranslateOnEnter 后当前页也入队翻译', async () => {
    const h = createHarness();
    h.executor.setAutoTranslateOnEnter(true);
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp'));
    await tick(); await tick();
    expect(h.translate).toHaveBeenCalledWith(`${gid}-5`, 'https://x/5.webp');
  });

  it('开启 autoTranslateOnEnter 时，已入手 URL 的当前页在到达时被补排', async () => {
    const h = createHarness();
    // 先正常预取（不开自动译）→ 当前页 5 的 URL 已在手但不入队
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp'));
    await tick(); await tick();
    expect(h.translate).not.toHaveBeenCalled();

    h.executor.setAutoTranslateOnEnter(true); // 用户打开开关 → 当前页立刻补排
    await tick(); await tick();
    expect(h.translate).toHaveBeenCalledWith(`${gid}-5`, 'https://x/5.webp');
  });

  // ── 2026-10-09：`prefetchEnabled` 删除后，「关闭预载」改由 `setDepth(0)` 表达 ──────
  // 本组原先是 `setPrefetchEnabled(true/false)` 的真值表（2026-10-05 拆开关时补的，
  // 此前该开关零执行器侧覆盖）。开关删除后语义整体挪到深度上，所以这里**改写而非删除** ——
  // 覆盖不能丢：谁管后页、谁管当前页、关掉一个会不会顺走另一个，这三条分界仍要钉死。
  //
  // ★ 一处**行为变化**（第 2 条）：原先 `setPrefetchEnabled(false)` 用 `retarget` 把后页
  //   直接**撤出队列**；现在 `setDepth(0)` 只把 `maxDistance` 降到 0，后页**留在队列里**
  //   但不再派发。这是刻意的 —— 深度是个纯数值旋钮，不该带"清队列"这种副作用；
  //   队列清理交给下一次 `onPageArrived` 的 `retarget`（最后一条测的就是它），
  //   而"恢复深度"时被门挡下的那些还能立刻接着跑，比撤掉再重建更省。

  it('setDepth(0)：新到的后页不再入队（按窗外计）', async () => {
    const h = createHarness();
    h.executor.setDepth(0);
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    await tick(); await tick();
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.executor.snapshot().outOfWindow).toBe(1);
  });

  it('setDepth(0)：已排队的后页被门挡住不派发，当前页任务照跑（它归 autoTranslateOnEnter 管）', async () => {
    const h = createHarness();
    h.executor.setAutoTranslateOnEnter(true);
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp')); // 当前页 → P0
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp')); // 后页 → P1
    expect(h.executor.snapshot().queued).toEqual([`${gid}-5`, `${gid}-6`]);

    h.executor.setDepth(0);
    // 后页仍在队列里等窗口（不是被撤掉），但 depth=0 让它的 distance 超过 maxDistance → 不派发。
    expect(h.executor.snapshot().queued).toEqual([`${gid}-5`, `${gid}-6`]);
    await tick(); await tick();
    // 关预载**不**越权带走当前页：那一件是另一个旋钮的。
    expect(h.translate).toHaveBeenCalledTimes(1);
    expect(h.translate).toHaveBeenCalledWith(`${gid}-5`, 'https://x/5.webp');
  });

  it('setDepth(0) 不越权：autoTranslateOnEnter 的当前页照常派发', async () => {
    const h = createHarness();
    h.executor.setAutoTranslateOnEnter(true);
    h.executor.setDepth(0);
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-5`, showpageJson(5, 'https://x/5.webp'));
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    await tick(); await tick();
    expect(h.translate).toHaveBeenCalledTimes(1);
    expect(h.translate).toHaveBeenCalledWith(`${gid}-5`, 'https://x/5.webp');
  });

  it('setDepth 从 0 恢复：窗口内已有 URL 的后页立刻补排（不必等下次到达）', async () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.setDepth(0);
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp')); // 关着 → 挡下，但 URL 已入库
    await tick(); await tick();
    expect(h.translate).not.toHaveBeenCalled();
    expect(h.executor.snapshot().knownUrls).toBe(1);

    h.executor.setDepth(4);
    await tick(); await tick();
    // 补排逻辑原先长在 `setPrefetchEnabled(true)` 里；开关删除后归到 `setDepth`。
    // 少了它，用户"关一下再开"后得再翻一页才生效 —— 会被当成"开了没用"。
    expect(h.translate).toHaveBeenCalledWith(`${gid}-6`, 'https://x/6.webp');
  });

  it('setDepth 收窄后翻页：出窗任务被 retarget 清出队列，不会永久挂起', () => {
    const h = createHarness();
    h.executor.onPageArrived({ gid, page: 5 });
    h.executor.onShowpageJson(`${gid}-6`, showpageJson(6, 'https://x/6.webp'));
    h.executor.onShowpageJson(`${gid}-7`, showpageJson(7, 'https://x/7.webp'));
    expect(h.executor.snapshot().queued).toEqual([`${gid}-6`, `${gid}-7`]);

    h.executor.setDepth(0); // 两件都进不了窗口，但仍在队列里等着（见上面第 2 条的说明）
    h.executor.onPageArrived({ gid, page: 6 }); // 翻页 → retarget 按新窗口重排
    // depth=0 时窗口只剩当前页，而 autoTranslateOnEnter 关着（下界 = +1）→ 计划为空。
    expect(h.executor.snapshot().queued).toEqual([]);
  });

  // ── 2026-10-09（4.2 收敛）：snapshot 兼作「当前生效设置」的唯一权威 ────────────
  // 内容脚本的右下角开关不再自存 `prefetchToggleDepth` / `autoTranslateToggleOn`，
  // 改成投影 `snapshot()`。于是这两个值必须能从快照里读到、且与 setter 写入的一致 ——
  // 这条契约一破，UI 就会显示过期状态（正是当年"深度被设成 0、开关仍显示开"的病根）。
  it('snapshot 回带当前生效的 depth / autoTranslateOnEnter（UI 投影的唯一依据）', () => {
    const h = createHarness({ depth: 3 });
    expect(h.executor.snapshot().depth).toBe(3);
    expect(h.executor.snapshot().autoTranslateOnEnter).toBe(false);

    h.executor.setDepth(0); // 0 = 关闭预载
    expect(h.executor.snapshot().depth).toBe(0);

    h.executor.setAutoTranslateOnEnter(true);
    expect(h.executor.snapshot().autoTranslateOnEnter).toBe(true);

    // 非法深度被 setter 拒绝时，快照里的旧值不能被改坏（UI 会拿它当分母）。
    h.executor.setDepth(-1);
    expect(h.executor.snapshot().depth).toBe(0);
  });
});
