import { describe, expect, it } from 'vitest';
import {
  createPrefetchChain,
  extractImgkeyFromPathname,
  extractNextPageFromShowpage,
  type PrefetchChainSnapshot,
  type ShowpageRequestParams,
} from '../../../../apps/extension/src/content/core/scheduler/prefetchChain';

const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

/** 真机实录格式的 showpage JSON（字段见 dev/docs/ARCHITECTURE.md §六；imgkey 一律十六进制串）。 */
function hexKey(n: number): string {
  return n.toString(16).padStart(10, '0');
}

function showpageJson(page: number, nextImgkey: string | null, nextPage: number | null): string {
  const links: string[] = [];
  if (nextPage !== null && nextImgkey !== null) {
    links.push(`<a onclick="return load_image(${nextPage}, '${nextImgkey}')" href="https://exhentai.org/s/${nextImgkey}/4218710-${nextPage}">`);
  }
  // 站点的 n 字段永远带「上一页」链接 —— 链必须只往前走
  if (page > 1) {
    links.push(`<a onclick="return load_image(${page - 1}, '${hexKey(page - 1)}')" href="https://exhentai.org/s/${hexKey(page - 1)}/4218710-${page - 1}">`);
  }
  return JSON.stringify({
    p: page,
    k: hexKey(page),
    n: `<div class="sn">${links.join('')}</div>`,
    i3: `<a onclick="return load_image(${page + 1}, 'feedc0de7')"><img id="img" src="https://xx.hath.network/h/.."></a>`,
    x: 1280,
    y: 1808,
    si: 'L5B',
  });
}

/** 可控时钟 + 可控内存档的测试挂具。 */
function createHarness(options: { depth?: number; minIntervalMs?: number; stored?: Map<string, string> } = {}) {
  const stored = options.stored ?? new Map<string, string>();
  const requests: ShowpageRequestParams[] = [];
  const snapshots: PrefetchChainSnapshot[] = [];
  let fakeNow = 0;

  const chain = createPrefetchChain(
    {
      requestShowpage: (params) => { requests.push({ ...params }); },
      getJson: async (pageKey) => stored.get(pageKey) ?? null,
      now: () => fakeNow,
      sleep: async (ms) => { fakeNow += ms; },
      publish: (snapshot) => { snapshots.push(snapshot); },
    },
    { depth: options.depth ?? 4, minIntervalMs: options.minIntervalMs ?? 250 },
  );
  return { chain, requests, snapshots, stored, nowMs: () => fakeNow };
}

describe('extractImgkeyFromPathname · 当前页 imgkey 就在 pathname 里（M0 实测）', () => {
  it('合法 /s/ 页 → imgkey', () => {
    expect(extractImgkeyFromPathname('/s/0b98c3ad02/4218710-5')).toBe('0b98c3ad02');
  });
  it('非阅读页 → null（画廊页 / 其它站点不发请求）', () => {
    expect(extractImgkeyFromPathname('/g/4218710/')).toBeNull();
    expect(extractImgkeyFromPathname('/')).toBeNull();
  });
});

describe('extractNextPageFromShowpage · 链的下一环', () => {
  it('取「大于当前页号的最小页」—— 上一页链接不参与', () => {
    const json = showpageJson(6, '3c42c4af78', 7);
    expect(extractNextPageFromShowpage(json, 6)).toEqual({ page: 7, imgkey: '3c42c4af78' });
  });
  it('n 字段缺失时回退 i3（主图 anchor 的 onclick）', () => {
    const json = JSON.stringify({
      p: 6,
      i3: `<a onclick="return load_image(7, 'feedc0de7')"><img id="img" src="https://x/6.webp"></a>`,
    });
    expect(extractNextPageFromShowpage(json, 6)).toEqual({ page: 7, imgkey: 'feedc0de7' });
  });
  it('没有下一页候选（末页）→ null；JSON 损坏 → null', () => {
    expect(extractNextPageFromShowpage(JSON.stringify({ p: 9 }), 9)).toBeNull();
    expect(extractNextPageFromShowpage('{{{', 9)).toBeNull();
  });
});

describe('createPrefetchChain · 预取数据链', () => {
  it('到达未知页 → 用 pathname 里的 imgkey 发起 bootstrap 请求', async () => {
    const h = createHarness();
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, '0b98c3ad02');
    await tick();
    expect(h.requests).toEqual([{ page: 5, imgkey: '0b98c3ad02' }]);
  });

  it('内存档已有当前页 JSON → 不发网络，直接接链下一页', async () => {
    const h = createHarness({
      stored: new Map([['4218710-5', showpageJson(5, hexKey(6), 6)]]),
    });
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, '0b98c3ad02');
    await tick(); await tick(); await tick();
    expect(h.requests).toEqual([{ page: 6, imgkey: hexKey(6) }]);
  });

  it('收到 showpage JSON → 接链下一页（imgkey 取自响应的 n 字段）', async () => {
    const h = createHarness();
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, '0b98c3ad02');
    await tick();
    h.chain.onShowpageJson('4218710-5', showpageJson(5, hexKey(6), 6));
    await tick(); await tick(); await tick();
    expect(h.requests).toEqual([
      { page: 5, imgkey: '0b98c3ad02' },
      { page: 6, imgkey: hexKey(6) },
    ]);
    expect(h.chain.snapshot().farthestPage).toBe(6);
  });

  it('窗口封顶：链上候选页全部超出「到达页 + depth」不再请求', async () => {
    const h = createHarness({ depth: 1 });
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    await tick();
    // n 与 i3 的候选（页 7 / 页 9）全部超出 5+1 → 一个都不请求
    h.chain.onShowpageJson('4218710-5', JSON.stringify({
      p: 5,
      n: `<a onclick="return load_image(7, 'abbbbbb007')">…</a>`,
      i3: `<a onclick="return load_image(9, 'cddcdcd09')">…</a>`,
    }));
    await tick(); await tick(); await tick();
    expect(h.requests).toEqual([{ page: 5, imgkey: 'a' }]);
  });

  it('串行泵：任意两次请求间隔 ≥ minIntervalMs（注入时钟，不真等）', async () => {
    const h = createHarness({ minIntervalMs: 250 });
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    await tick();
    h.chain.onShowpageJson('4218710-5', showpageJson(5, 'b', 6));
    await tick(); await tick(); await tick();
    h.chain.onShowpageJson('4218710-6', showpageJson(6, 'c', 7));
    await tick(); await tick(); await tick();
    expect(h.requests.map((r) => r.page)).toEqual([5, 6, 7]);
    // 第二次请求（页 6）的发起时刻 = 0 + 250 = 250；第三次 = 500 —— 由注入时钟推进
    expect(h.nowMs()).toBeGreaterThanOrEqual(500);
  });

  it('去重：同一页重复到达 / 重复回流不再发请求', async () => {
    const h = createHarness();
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    await tick();
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a'); // 软导航回看同一页
    await tick();
    h.chain.onShowpageJson('4218710-5', showpageJson(5, 'b', 6));
    h.chain.onShowpageJson('4218710-5', showpageJson(5, 'b', 6)); // 重复回流
    await tick(); await tick(); await tick();
    expect(h.requests.map((r) => r.page)).toEqual([5, 6]);
    expect(h.chain.snapshot().duplicates).toBeGreaterThanOrEqual(1);
  });

  it('直连通道熔断 → 链停发：后续到达不再发任何请求', async () => {
    const h = createHarness();
    h.chain.notifyExecutorFailed('直连请求连续失败×3');
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    h.chain.onShowpageJson('4218710-5', showpageJson(5, 'b', 6));
    await tick(); await tick(); await tick();
    expect(h.requests).toEqual([]);
    expect(h.chain.snapshot().disabledReason).toContain('直连');
  });

  it('反向验证：非法深度/非法间隔当场抛错（不许静默取默认值）', () => {
    const deps = {
      requestShowpage: () => undefined,
      getJson: async () => null,
      now: () => 0,
      sleep: async () => undefined,
      publish: () => undefined,
    };
    expect(() => createPrefetchChain(deps, { depth: -1, minIntervalMs: 250 })).toThrow();
    expect(() => createPrefetchChain(deps, { depth: 4, minIntervalMs: -1 })).toThrow();
  });

  it('深度 0 合法 = 关链（与执行器口径一致：0 是「关」不是「非法」）', () => {
    const h = createHarness({ depth: 0 });
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    h.chain.onShowpageJson('4218710-5', showpageJson(5, hexKey(6), 6));
    expect(h.requests).toEqual([]);
  });

  it('setDepth 收窄窗口 → 已经爬出去的那几页立即停发（链与执行器同口径）', async () => {
    const h = createHarness({ depth: 4 });
    h.chain.setDepth(1); // 用户把预载数量改成 1
    expect(h.chain.snapshot().enabled).toBe(true);
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    await tick();
    // 候选页 7 超出 5+1 → 拒绝
    h.chain.onShowpageJson('4218710-5', JSON.stringify({
      p: 5,
      n: `<a onclick="return load_image(7, 'abbbbbb007')">…</a>`,
      i3: `<a onclick="return load_image(9, 'cddcdcd09')">…</a>`,
    }));
    await tick(); await tick(); await tick();
    expect(h.requests.map((r) => r.page)).toEqual([5]);
  });

  it('setDepth(0) → 链整体停发，快照 enabled=false（设置里预载数量填 0 = 关预取）', async () => {
    const h = createHarness({ depth: 4 });
    h.chain.setDepth(0);
    expect(h.chain.snapshot().enabled).toBe(false);
    h.chain.onPageArrived({ gid: 4218710, page: 5 }, 'a');
    h.chain.onShowpageJson('4218710-5', showpageJson(5, hexKey(6), 6));
    await tick(); await tick();
    expect(h.requests).toEqual([]);
  });

  it('setDepth 非法值当场忽略（不静默改坏窗口）', () => {
    const h = createHarness({ depth: 4 });
    h.chain.setDepth(-2);
    h.chain.setDepth(Number.NaN);
    expect(h.chain.snapshot().enabled).toBe(true);
  });
});

describe('advanceToWindowEdge · 到达已取过数据的页也要把窗口推到新边缘（2026-10-04 根因）', () => {
  /** 模拟接线层：JSON 既入内存档（getJson 读它）也回流给链 —— 真机里 jsonStore 就是这么喂的。 */
  function feed(h: ReturnType<typeof createHarness>, pageKey: string, json: string): void {
    h.stored.set(pageKey, json);
    h.chain.onShowpageJson(pageKey, json);
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await tick();
  }

  it('翻到「数据已在手」的页时继续往前爬，补上新窗口边缘那一页', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    // 逐跳爬到窗口边缘：锚点 1 时窗口是 1..4
    for (let p = 1; p <= 4; p += 1) {
      feed(h, `4218710-${p}`, showpageJson(p, hexKey(p + 1), p + 1));
      await settle();
    }
    expect(h.requests.map((r) => r.page)).toEqual([1, 2, 3, 4]);

    // 用户翻到第 2 页（数据已在手）—— 老逻辑在这里原地返回，第 5 页永远没人请求。
    h.chain.onPageArrived({ gid: 4218710, page: 2 }, hexKey(2));
    await settle();
    expect(h.requests.map((r) => r.page)).toEqual([1, 2, 3, 4, 5]);
  });

  it('走到末页（没有下一页）→ 安静停下，不发多余请求', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 8 }, hexKey(8));
    await settle();
    // 真末页：n 只有「上一页」、i3 的主图 anchor 不带 load_image 下一页
    feed(h, '4218710-8', JSON.stringify({
      p: 8,
      k: hexKey(8),
      n: '<div class="sn"><a onclick="return load_image(7, ' + "'" + hexKey(7) + "'" + ')" href="https://exhentai.org/s/x/4218710-7">',
      i3: '<a href="https://exhentai.org/s/x/4218710-8"><img id="img" src="https://xx.hath.network/h/last"></a>',
    }));
    await settle();
    h.chain.onPageArrived({ gid: 4218710, page: 8 }, hexKey(8)); // 再到达一次（已已知）
    await settle();
    expect(h.requests.map((r) => r.page)).toEqual([8]);
  });

  it('缺口在飞时不重复派发（去重依然生效）', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    feed(h, '4218710-1', showpageJson(1, hexKey(2), 2)); // 派发第 2 页，但它的 JSON 还没回来
    await settle();
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1)); // 再到达：走链到第 2 页时应在飞
    await settle();
    expect(h.requests.filter((r) => r.page === 2)).toHaveLength(1);
  });
});

describe('notifyDispatchFailed · 失败补救（链是接龙，缺一环后面全断）', () => {
  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i += 1) await tick();
  }

  it('失败 → 自动补发一次（原 imgkey 原样重发），再失败就不补了', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    expect(h.requests.filter((r) => r.page === 1)).toHaveLength(1);

    h.chain.notifyDispatchFailed(4218710, 1);
    await settle();
    const resent = h.requests.filter((r) => r.page === 1);
    expect(resent).toHaveLength(2);
    expect(resent[1]).toEqual(resent[0]);

    h.chain.notifyDispatchFailed(4218710, 1); // 补发那次也失败
    await settle();
    expect(h.requests.filter((r) => r.page === 1)).toHaveLength(2); // 不无限重试
    expect(h.chain.snapshot().failed).toBe(2);
  });

  it('失败页已出窗（用户跳走）→ 不补发', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    h.chain.onPageArrived({ gid: 4218710, page: 9 }, hexKey(9)); // 窗口变成 9..12
    await settle();
    const before = h.requests.length;
    h.chain.notifyDispatchFailed(4218710, 1); // 第 1 页早已出窗
    await settle();
    expect(h.requests.length).toBe(before);
  });

  it('成功落地后迟到的失败：不计失败、不补发', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    h.stored.set('4218710-1', showpageJson(1, hexKey(2), 2));
    h.chain.onShowpageJson('4218710-1', showpageJson(1, hexKey(2), 2));
    await settle();
    const failedBefore = h.chain.snapshot().failed;
    h.chain.notifyDispatchFailed(4218710, 1);
    expect(h.chain.snapshot().failed).toBe(failedBefore);
    await settle();
    expect(h.requests.filter((r) => r.page === 1)).toHaveLength(1);
  });

  it('失败被放出后不再永久卡死：再次到达时走链会重新请求它', async () => {
    const h = createHarness({ depth: 3 });
    h.chain.onPageArrived({ gid: 4218710, page: 1 }, hexKey(1));
    await settle();
    h.stored.set('4218710-1', showpageJson(1, hexKey(2), 2));
    h.chain.onShowpageJson('4218710-1', showpageJson(1, hexKey(2), 2));
    await settle();
    expect(h.requests.filter((r) => r.page === 2)).toHaveLength(1);

    h.chain.notifyDispatchFailed(4218710, 2); // 首发失败 + 自动补发也失败
    await settle();
    h.chain.notifyDispatchFailed(4218710, 2);
    await settle();
    expect(h.requests.filter((r) => r.page === 2)).toHaveLength(2);

    // 翻到第 2 页（数据还没到手）→ 重新请求（老逻辑：去重集永久挡住，直到整页刷新）
    h.chain.onPageArrived({ gid: 4218710, page: 2 }, hexKey(2));
    await settle();
    expect(h.requests.filter((r) => r.page === 2)).toHaveLength(3);
  });
});
