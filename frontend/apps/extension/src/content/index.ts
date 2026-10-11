import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { ehentaiAdapter, parseEhentaiPageIdentity } from './adapters/ehentai';
import type { SiteAdapter } from './core/types';
import { TranslatorCore } from './core/TranslatorCore';
import { createPrefetchChain, extractImgkeyFromPathname } from './core/scheduler/prefetchChain';
import {
  createShowpageClient,
  deriveShowpageEndpoint,
  extractShowkeyFromScripts,
} from './core/scheduler/showpageClient';
import { createPrefetchExecutor } from './core/scheduler/prefetchExecutor';
import { defaultPrefetchDepth, normalizePrefetchDepth } from '../shared/config';
import { sendRuntimeMessage } from '../shared/messages';
import { createProbe, flushProbeRelay } from '../shared/probe';
import { getExtensionApi, isExtensionContextInvalidated, type ExtensionPort } from '../shared/extensionRuntime';
import { toErrorMessage } from '../shared/utils';
import {
  createContentSessionId,
  setActiveContentSessionId,
  toContentSessionPortName,
} from '../shared/contentSession';
import { bindContentLifecycle } from './core/contentLifecycle';
import { emitContentFailure, flushContentEventLog } from './core/telemetry/contentEventLog';
import {
  buildScreenshotElementCandidates,
  toDocumentScreenshotRect,
  toViewportScreenshotRect,
} from './core/screenshot';
import type { ScreenshotRect, ScreenshotSelection } from './core/screenshot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Null adapter for non-supported sites — supports only context-menu translation. */
function createNullAdapter(): SiteAdapter {
  return {
    match: () => false,
    findImages: () => [],
    createUiAnchor: () => document.createElement('div'),
    applyImage: () => {},
    observe: () => () => {},
  };
}

const adapters = [twitterAdapter, pixivAdapter, ehentaiAdapter];
const contentSessionId = createContentSessionId();
setActiveContentSessionId(contentSessionId);
let contentSessionPort: ExtensionPort | null = null;
try {
  contentSessionPort = getExtensionApi()?.runtime?.connect?.({
    name: toContentSessionPortName(contentSessionId),
  }) ?? null;
} catch {
  // Page lifecycle still stops the content core when Port creation is unavailable.
}
const adapter = adapters.find(a => a.match()) || createNullAdapter();
const core = new TranslatorCore(adapter, contentSessionId);
core.start();
bindContentLifecycle(core, contentSessionPort);

// --- 临时测量（2026-10-11）：只记录时间线，**不参与任何判断、不影响功能** ---
// 要回答三个问题：
//   ① 站点什么时候才算"接受"一次翻页（改网址？换图？原图加载完？）→ 决定"抢先贴译图"能不能安全保留；
//   ② 快速连点两下时，站点到底有没有真的翻到第二下那一页；
//   ③ 我们现在用的图源（站点 showpage JSON）什么时候才到手 → 这就是"慢半拍"的量化值。
type PageActionProbe = {
  at: number;
  kind: 'keyboard' | 'click';
  gid: number;
  fromPage: number;
  targetPage: number;
  /** 目标页的译图当时在不在内存里（= 会不会出现"译图先于原图"）。 */
  cached: boolean;
  elementSrc: string;
};
let lastPageAction: PageActionProbe | null = null;

/** 图址的尾巴（去掉 keystamp 之类的查询串，便于人读日志）。 */
function srcTail(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url, location.href);
    return parsed.pathname.split('/').pop() ?? '';
  } catch {
    return url.slice(-24);
  }
}

// --- 意图即换图（2026-10-04）：点击/方向键的瞬间，目标页就写在 anchor href / ±1 里，
// 译图已在内存 → 画框立即换，不等站点 api.php 往返（实测省 ~0.5-1s）。
// 导航意图与结果不符时，下一次 sync 会用当前页状态自我纠正（画框常驻，无需回滚）。
if (adapter === ehentaiAdapter) {
  // ★ 临时测量：把"画框入口"包一层，记录每一次现身/隐身（谁、在哪个网址页码下、贴了哪一页）。
  //   只是转发，不改行为；万一包不上（被冻结等）就自动跳过，测量降级但功能不受影响。
  const originalApplyOverlay = adapter.applyOverlayImage?.bind(adapter);
  if (originalApplyOverlay) {
    adapter.applyOverlayImage = (target, url) => {
      probe('overlay:apply', {
        key: target.key,
        shown: url !== null,
        pathPage: parseEhentaiPageIdentity(location.pathname)?.page ?? null,
      });
      return originalApplyOverlay(target, url);
    };
  }
  const intentShow = (page: number, kind: 'keyboard' | 'click'): void => {
    const identity = parseEhentaiPageIdentity(location.pathname);
    if (!identity) return;
    const img = document.getElementById('img') as HTMLImageElement | null;
    // ★ 临时测量：动作本身 + 目标页译图在不在手 + 站点那张图此刻是什么。**不改变下面的任何判断。**
    const at = probe.mark();
    const cached = core.getTranslatedUrl(`${identity.gid}-${page}`) !== null;
    lastPageAction = {
      at,
      kind,
      gid: identity.gid,
      fromPage: identity.page,
      targetPage: page,
      cached,
      elementSrc: img?.currentSrc || img?.src || '',
    };
    probe.timed('page:action', at, {
      kind,
      fromPage: identity.page,
      targetPage: page,
      cached,
      src: srcTail(lastPageAction.elementSrc),
    });
    if (!core.isDisplayModeTranslated()) return; // 全局原图模式：画框不抢戏
    const url = core.getTranslatedUrl(`${identity.gid}-${page}`);
    if (!url) return;
    if (!img) return;
    adapter.applyOverlayImage?.(
      { element: img, key: `${identity.gid}-${identity.page}`, originalUrl: img.currentSrc || img.src },
      url,
    );
  };
  window.addEventListener('keydown', (ev) => {
    const identity = parseEhentaiPageIdentity(location.pathname);
    if (!identity) return;
    if (ev.key === 'ArrowRight') intentShow(identity.page + 1, 'keyboard');
    else if (ev.key === 'ArrowLeft') intentShow(identity.page - 1, 'keyboard');
  }, true);
  window.addEventListener('click', (ev) => {
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    const anchor = (ev.target as Element | null)?.closest?.('a[href]');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    try {
      const m = /^\/s\/[0-9a-f]+\/(\d+)-(\d+)(?:[?#/]|$)/i.exec(new URL(href, location.href).pathname);
      if (m) intentShow(Number(m[2]), 'click');
    } catch { /* 非法 href 忽略 */ }
  }, true);
}

// --- M4 Step 14a/14b · 预取预翻译（施工修订二，2026-10-03 用户拍板：预载是 M4 唯一目标）---
// 看第 N 页时后台把 N+1…N+4 的 showpage JSON 拿到手（隔离世界直连 api.php，showkey 从
// 页面内联脚本提取），提取原图 URL（showpage i3），经调度器（并发恒 1、串行 250ms）
// 跑真实管线，译图进内存层 —— 翻过去时到达还原走内存直贴，画框直接贴译图。
/**
 * 开发期 kill switch：改成 false 即整段停掉预取系统（下面的预取块不再接线）。
 *
 * **它不是死代码，别按"恒为 true 的常量"删掉** —— 预取是本项目最容易出问题的子系统，
 * 真机排查时"整个关掉再跑一遍"是最快的二分手段；没有它就只能去注释代码。
 * 真机核对口径：`documentElement.dataset.m5Chain`。
 *
 * **当前页不自动翻译**（保持"点按钮才译"；要开自动译，用设置里的「进入自动翻译」）。
 */
/**
 * 临时诊断探针（见 `shared/probe.ts`）：记录页面进退场/可见性/导航，
 * 以及预取与缓存两条消息的到达情况。**只记录，不改变行为。**
 */
const probe = createProbe('content');

const PREFETCH_ENABLED = true;
/**
 * 预取设置补丁：**弹窗推来的变更**（`mt:prefetch-config`）
 * 或**后台 sync 应答回读的当前值**（`mt:prefetch-config-sync`）都走这个形状。
 * 两个字段都可缺席，逐个应用。
 */
type PrefetchConfigPatch = {
  prefetchDepth?: unknown;
  autoTranslateOnEnter?: unknown;
};
/**
 * 预取设置的应用入口（由预取块填充；非 e-hentai 页 / 预取关时为 null）。
 * 消息 listener 在模块级，而预取执行器活在下面的块作用域里 —— 用这个引用桥接，
 * 避免把整块预取逻辑提到模块级（那会带来一堆"未接线时运行"的判空）。
 */
let applyPrefetchConfig: ((config: PrefetchConfigPatch) => void) | null = null;
/**
 * 扩展重载/更新后，残留的旧上下文（旧 content script、旧 offscreen 文档）的
 * chrome.runtime 已失效；新实例 popup 一广播（mt:prefetch-config / mt:memory-cache），
 * 旧 listener 一调 sendResponse 就抛 "Extension context invalidated."，Chrome 包装成
 * "Error in event handler" —— 「后台一直报错但功能正常」的真凶。
 * 捕获到它 → 静默退场：注销消息监听、断开软导航 observer，不再产生 chrome API 调用。
 */
let runtimeMessageListener: ((
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean) | null = null;
/** e-hentai 软导航观察器（块内创建）；旧上下文退场时 disconnect。 */
let navigationObserver: MutationObserver | null = null;
/**
 * 右下角「已预载 x/N」的刷新定时器（块内创建）。
 * 必须能在两条退场路径上停掉：扩展上下文失效（`retireAfterContextInvalidated`）
 * 与页面真卸载（`pagehide` 且非 bfcache）。不停 = 死页面上每秒白跑一次
 * `countPreloadedAhead()`（每趟都扫 DOM + 查缓存）。
 */
let prefetchProgressTimer: number | null = null;

/** 停掉预载进度定时器（幂等）。 */
function stopPrefetchProgressTimer(): void {
  if (prefetchProgressTimer === null) return;
  window.clearInterval(prefetchProgressTimer);
  prefetchProgressTimer = null;
}
if (adapter === ehentaiAdapter && PREFETCH_ENABLED && typeof window !== 'undefined') {
  const jsonStore = new Map<string, string>(); // pageKey → showpage JSON 原文（本文档生命周期）
  let lastGid = 0;
  let showkey = '';
  function collectScriptSources(): string[] {
    return Array.from(document.querySelectorAll('script')).map((s) => s.textContent ?? '');
  }

  /** showkey 只提取一次；站点每页内联脚本都带（真机实录），失败进遥测如实上报。 */
  function captureShowkey(): boolean {
    if (showkey.length > 0) return true;
    const found = extractShowkeyFromScripts(collectScriptSources());
    if (found) showkey = found;
    return showkey.length > 0;
  }

  function publishTelemetry(): void {
    try {
      document.documentElement.dataset.m5Chain = JSON.stringify({
        chain: chain.snapshot(),
        dispatch: client.stats(),
        executor: executor.snapshot(),
        showkeyFound: showkey.length > 0,
      });
    } catch {
      // 遥测失败不影响主流程
    }
  }

  const chain = createPrefetchChain(
    {
      requestShowpage: (params) => client.dispatch(params),
      getJson: async (pageKey) => jsonStore.get(pageKey) ?? null,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); }),
      publish: () => publishTelemetry(),
    },
    { depth: defaultPrefetchDepth, minIntervalMs: 250 },
  );

  const executor = createPrefetchExecutor(
    {
      isBusy: (pageKey) => core.isPageBusy(pageKey),
      translate: (pageKey, imageUrl) => core.translatePageInBackground(pageKey, imageUrl),
    },
    // 弹窗推来真实设置之前先按默认跑（深度 4、不自动译当前页）—— 与未配置设备一致。
    { depth: defaultPrefetchDepth, autoTranslateOnEnter: false },
  );

  // ── 设置项（弹窗改 → 后台转发；右下角开关改 → 后台回读）──────────────
  // 内容脚本拿不到 settings，只能等弹窗打开时推一次（同 mt:memory-cache 的口径）。
  // 收到前的默认值 = config 层的默认（深度 4、不自动译），与未配置设备的体验一致。
  //
  // ★ 2026-10-09 收敛（4.2）：本函数是**唯一**把设置写进执行器的地方。
  //   写入的两个去向只有「链 + 执行器」，content 不再另存副本 ——
  //   右下角开关的显示直接读 `executor.snapshot()`（见 renderPageToggles）。
  function applyPrefetchConfigImpl(config: PrefetchConfigPatch): void {
    if (config.prefetchDepth !== undefined) {
      const nextDepth = normalizePrefetchDepth(config.prefetchDepth);
      // 链与执行器**必须同步改**：只改一边会出现"链爬到 4 页外、执行器只派 2 页"，白花请求。
      chain.setDepth(nextDepth);
      executor.setDepth(nextDepth);
    }
    if (config.autoTranslateOnEnter !== undefined) {
      executor.setAutoTranslateOnEnter(config.autoTranslateOnEnter === true);
    }
    // 值已经落在执行器里了，重绘即可取到最新值（UI 是快照的投影，不需要在这里再抄一遍）。
    renderPageToggles();
    publishTelemetry();
  }
  applyPrefetchConfig = applyPrefetchConfigImpl;

  // ── 右下角两个快捷开关（预载 / 进入自动翻译）────────────────────────────────
  // 用户要求（2026-10-04）：翻译按钮挪到视口右下角后，同区域再给开关。
  // 预载那个 = 弹窗「向后预载」开关的快捷投影（开/关 = 深度 默认值/0）；
  // 自动翻译那个 = 弹窗「进入自动翻译」，两者独立、互不携带。
  // （弹窗那一行的开关有"上次非零深度"记忆，因为它的输入框能把数值显示出来；
  //   这里看不到数值，所以固定"开 = 恢复默认深度"。同一个动作、两种粒度，只差这一个可见性。）
  // 开启时只显示实时进度「已预载 x/N」—— 页数由弹窗那行输入，这里不重复。
  //
  // ★ 2026-10-09 收敛（4.2）：**内容脚本不再自存开关键**。
  //   值的来源只有两处 —— ① 弹窗改完后台推来的 `mt:prefetch-config`；
  //   ② 右下角开关写回后，后台在 `mt:prefetch-config-sync` 的应答里回读的当前值。
  //   两条都汇进 `applyPrefetchConfigImpl` → 写进执行器；UI 从这里**读执行器快照**做投影。
  //   此前 content 另存 `prefetchToggleDepth` / `autoTranslateToggleOn` 两个平行变量，
  //   与执行器里真正生效的值可以漂移 ——「深度被设成 0、开关仍显示"开"」就是这么来的，
  //   当年为了解释这种自相矛盾还额外加了一档"预载数量为 0"的文案。
  //
  //   预载那半边本来也**没有布尔态**：`depth > 0` 就是"开"（0 = 关闭预载，见 config.ts）。
  const prefetchToggleBottomPx = 60; // 让开下方翻译按钮（内缩 12 + 按钮高约 36 + 间隙 12）
  let prefetchToggleRoot: HTMLElement | null = null;
  const prefetchToggleLabel: { prefetch: HTMLElement | null; autoTranslate: HTMLElement | null } = {
    prefetch: null,
    autoTranslate: null,
  };

  /**
   * 向后窗口里**已经有译图**的页数 —— 这就是"已预载"的真值（内存里有才算数）。
   *
   * 【2026-10-04 奥卡姆剃刀】这里一度长出过"缺口原因分类"（数据缺 / 翻译失败 / 停滞）
   * 与配套的末页截断分母。那是**为了定位 bug 加的观测装置，不是需求**（需求只有"显示数量"）。
   * bug 修好后（窗口边缘推进 + 失败补救），装置本身成了新的麻烦：它要在"活还在路上"的
   * 那一瞬判断状态，天然有竞态，堵一个窗口又冒出另一个（真机表现：有概率闪一下"数据缺"）。
   * 于是整套撤掉 —— 数量本身（x/N 长时间不涨）就是最好的信号，原始症状就是这么被发现的。
   * 全量事实仍在遥测里（`data-m5-chain`：chain/dispatch/executor 三份快照），需要时可读。
   *
   * `depth` 由调用方从执行器快照传入 —— 本函数不再自己持有一份副本。
   */
  function countPreloadedAhead(depth: number): number {
    const identity = parseEhentaiPageIdentity(location.pathname);
    if (!identity || depth <= 0) return 0;
    let done = 0;
    for (let offset = 1; offset <= depth; offset += 1) {
      if (core.getTranslatedUrl(`${identity.gid}-${identity.page + offset}`)) done += 1;
    }
    return done;
  }

  /**
   * 按钮文字 = 状态本身（用户口径 2026-10-04）：关 →「关闭」；开 →「已预载 x/N」。
   * 不再有独立的计数行 —— 一个按钮说清一件事，也就不存在"两处文案各说各话"。
   */
  function renderPageToggles(): void {
    // 值一律**现读执行器快照** —— 它是运行时唯一权威，UI 只做投影、不自存副本。
    const { depth, autoTranslateOnEnter } = executor.snapshot();
    const prefetchLabel = prefetchToggleLabel.prefetch;
    if (prefetchLabel) {
      // 两态（2026-10-09 收敛）：深度 0 = 关闭，否则报实时进度。
      // 此前还有一档"开着但数量为 0" —— 那是「布尔开关 + 深度」两份状态打架的产物。
      // 布尔删掉后它和"预载关闭"就是同一件事，没理由留两个说法。
      prefetchLabel.textContent = depth <= 0
        // 用户口径（2026-10-04）：单独一个"关闭"看不出关的是什么，要写"预载关闭"。
        ? '预载关闭'
        : `已预载 ${countPreloadedAhead(depth)}/${depth}`;
    }
    const autoLabel = prefetchToggleLabel.autoTranslate;
    if (autoLabel) {
      // 与预载并列，标明自己管的是"当前页自动译"，避免两个按钮被认成同一个。
      autoLabel.textContent = autoTranslateOnEnter ? '自动翻译开' : '自动翻译关';
    }
  }

  function ensurePageToggles(): void {
    if (prefetchToggleRoot !== null && prefetchToggleRoot.isConnected) return;
    const root = document.createElement('div');
    root.className = 'mt-x-page-prefetch';
    root.dataset.theme = 'dark';
    root.style.cssText = [
      'position:fixed',
      'right:12px',
      `bottom:${prefetchToggleBottomPx}px`,
      'z-index:2147483001', // 与翻译按钮同级（画框 2147483000 之下不行，必须更高）
      'display:flex',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:6px',
    ].join(';');
    const buildToggle = (kind: 'prefetch' | 'autoTranslate', ariaLabel: string): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mt-x-control'; // 与翻译按钮同一套观感
      button.dataset.status = 'idle';
      button.setAttribute('aria-label', ariaLabel);
      const label = document.createElement('span');
      label.className = 'mt-x-label';
      button.appendChild(label);
      button.addEventListener('click', () => {
        // 预载开关 = "深度 0 ↔ 默认深度"。
        // 关 = 0（真正的关闭，不只是不显示进度）；开 = 回到默认页数。
        // 用户若在弹窗里调过 8，关一下再开会回到 4 —— 这是"重新打开 = 恢复默认"的常规语义，
        // 好过为此再存一个"上次的非零深度"（那等于用一个新字段换掉刚删掉的那个）。
        const { depth, autoTranslateOnEnter } = executor.snapshot();
        void (kind === 'prefetch'
          ? syncPageToggles({ prefetchDepth: depth > 0 ? 0 : defaultPrefetchDepth })
          : syncPageToggles({ autoTranslateOnEnter: !autoTranslateOnEnter }));
      });
      root.appendChild(button);
      prefetchToggleLabel[kind] = label;
      return button;
    };
    buildToggle('prefetch', '向后预载开关');
    buildToggle('autoTranslate', '进入阅读页自动翻译开关');
    document.body.appendChild(root);
    prefetchToggleRoot = root;
    renderPageToggles();
  }

  /** 两个开关共用的读写通道：写入由「带字段」触发，回读 + 回推由后台统一做。 */
  async function syncPageToggles(next?: {
    prefetchDepth?: number;
    autoTranslateOnEnter?: boolean;
  }): Promise<void> {
    try {
      // 走共享的 sendRuntimeMessage（已处理 this 绑定 + 空响应），不要自己抓 runtime.sendMessage。
      const data = (await sendRuntimeMessage({
        type: 'mt:prefetch-config-sync',
        ...(next ?? {}),
      })) as PrefetchConfigPatch;
      // 后台应答里的**当前值**直接喂给应用函数，由它写进执行器 ——
      // 应用函数自己按 `!== undefined` 逐字段判断，不用在这里先抄一遍、再让它抄第二遍。
      // （重绘也由它结尾统一做，这里不重复调。）
      applyPrefetchConfigImpl(data);
    } catch {
      // 后台不可用 / 上下文失效：开关保持上次状态，不刷错误。
    }
  }

  ensurePageToggles();
  void syncPageToggles();
  // 实时进度没有"完成事件"可订阅（预载翻译是异步跑完的），开着的时候按秒刷新计数。
  prefetchProgressTimer = window.setInterval(() => {
    // 关着预载时标签恒为"预载关闭"、没有可刷新的进度 —— 不必每秒白重绘一次。
    if (executor.snapshot().depth > 0) renderPageToggles();
    // ★ 临时测量：站点可能整个换掉那个 `<img>` 元素，这里补挂一次观察（幂等、不改行为）。
    probeObserveImage();
  }, 1000);

  const client = createShowpageClient({
    getGid: () => lastGid,
    getShowkey: () => showkey,
    getEndpoint: () => deriveShowpageEndpoint(location.hostname),
    onJson: (pageKey, json) => {
      jsonStore.set(pageKey, json);
      // ★ 临时测量：这一页的站点数据什么时候到手 —— 这就是现在"当前页图源"的等待时间。
      probe.timed('page:json', lastPageAction?.at ?? probe.mark(), {
        page: pageKey,
        targetPage: lastPageAction?.targetPage ?? null,
      });
      executor.onShowpageJson(pageKey, json);
      chain.onShowpageJson(pageKey, json);
      publishTelemetry();
    },
    onCircuitOpen: (reason) => {
      chain.notifyExecutorFailed(reason);
      publishTelemetry();
    },
    // 请求最终失败（HTTP 错 / 非 JSON / 超时）→ 链把该页放出去补发。
    // 链是接龙结构，一次失败不补救 = 该页之后所有页都拿不到 imgkey（整条链断掉）。
    onDispatchFailed: (params) => {
      chain.notifyDispatchFailed(params.gid, params.page);
      publishTelemetry();
    },
  });

  // ── 临时测量：盯住站点那张 `<img>` —— 它的 src 什么时候换、原图什么时候加载完 ──────
  // 这两个时刻是回答"站点什么时候算接受翻页"的关键；只记录，不做任何事。
  let probeImage: HTMLImageElement | null = null;
  let probeSrcObserver: MutationObserver | null = null;
  let probeLastSrc = '';
  function probeSrcReport(event: string): void {
    const identity = parseEhentaiPageIdentity(location.pathname);
    probe.timed(event, lastPageAction?.at ?? probe.mark(), {
      pathPage: identity ? identity.page : null,
      targetPage: lastPageAction?.targetPage ?? null,
      // 站点有没有翻到"用户想去的那一页"—— 这就是"接受 / 没接受"的判据。
      accepted: identity !== null && lastPageAction !== null
        ? identity.page === lastPageAction.targetPage
        : null,
      src: srcTail(probeLastSrc),
    });
  }
  function probeOnImageLoad(): void {
    probeSrcReport('page:onload');
  }
  function probeObserveImage(): void {
    const element = adapter.findImages()[0]?.element as HTMLImageElement | undefined;
    if (!element || element === probeImage) return;
    probeImage?.removeEventListener('load', probeOnImageLoad);
    probeSrcObserver?.disconnect();
    probeImage = element;
    probeLastSrc = element.currentSrc || element.src || '';
    element.addEventListener('load', probeOnImageLoad);
    probeSrcObserver = new MutationObserver(() => {
      const next = element.currentSrc || element.src || '';
      if (next === probeLastSrc) return;
      probeLastSrc = next;
      probeSrcReport('page:src');
    });
    probeSrcObserver.observe(element, { attributes: true, attributeFilter: ['src'] });
  }

  let lastPathname = '';
  const onMaybeNavigated = (): void => {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    const identity = parseEhentaiPageIdentity(location.pathname);
    probe('page:navigate', { path: location.pathname, isReadingPage: identity !== null });
    if (!identity) return; // 非阅读页（画廊页等）：预取整体不参与
    // ★ 临时测量：网址页码变化 = 站点"答应"翻页的时刻（与你的动作相隔多久、是不是你想去的那页）。
    probe.timed('page:path', lastPageAction?.at ?? probe.mark(), {
      from: lastPageAction?.fromPage ?? null,
      to: identity.page,
      targetPage: lastPageAction?.targetPage ?? null,
      accepted: lastPageAction !== null ? identity.page === lastPageAction.targetPage : null,
    });
    lastGid = identity.gid;
    if (captureShowkey()) client.notifyReady(); // showkey 就绪：冲掉排队中的请求
    executor.onPageArrived(identity); // 窗口平移：近页排上、出窗的离队
    chain.onPageArrived(identity, extractImgkeyFromPathname(location.pathname));
    probeObserveImage();
    publishTelemetry();
  };

  captureShowkey();
  onMaybeNavigated();
  // e-hentai 翻页是软导航（零整页重载）：DOM 变了就得重新看 —— 否则下一页永远 MISS。
  // observer 存模块级变量：扩展重载后旧上下文要能 disconnect 自己（见 runtimeMessageListener）。
  navigationObserver = new MutationObserver(onMaybeNavigated);
  navigationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// --- Context menu support ---

type ContextMenuTranslateTarget =
  | {
      kind: 'image';
      element: HTMLImageElement;
      originalUrl: string;
      documentRect: ScreenshotRect;
    }
  | {
      kind: 'screenshot';
      selection: ScreenshotSelection;
    };

type PointerPosition = {
  clientX: number;
  clientY: number;
};

/** The last right-click translation target. */
let contextMenuTarget: ContextMenuTranslateTarget | null = null;
let lastPointerPosition: PointerPosition | null = null;
let shortcutToastElement: HTMLElement | null = null;
let shortcutToastTimer: number | null = null;

function toElementScreenshotRect(element: Element): ScreenshotRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function toElementDocumentScreenshotRect(element: Element): ScreenshotRect {
  return toDocumentScreenshotRect(toElementScreenshotRect(element), window.scrollX, window.scrollY);
}

function isUsableScreenshotRect(rect: ScreenshotRect): boolean {
  return rect.width >= 12 && rect.height >= 12;
}

function toScreenshotSelection(rect: ScreenshotRect): ScreenshotSelection | null {
  const viewportRect = toViewportScreenshotRect(rect, window.innerWidth, window.innerHeight);
  if (!isUsableScreenshotRect(viewportRect)) return null;
  return {
    viewportRect,
    documentRect: toDocumentScreenshotRect(viewportRect, window.scrollX, window.scrollY),
  };
}

function isDirectImageResourceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, location.href);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    return hostname === 'pbs.twimg.com' ||
      hostname === 'i.pximg.net' ||
      hostname.endsWith('.pximg.net') ||
      /\.(?:avif|gif|jpe?g|png|webp)$/u.test(pathname);
  } catch {
    return false;
  }
}

function toAbsoluteUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl, location.href).toString();
  } catch {
    return rawUrl;
  }
}

function readContextImageOriginalUrl(image: HTMLImageElement): string {
  const storedOriginal = image.getAttribute('data-mt-original-src');
  if (storedOriginal && isDirectImageResourceUrl(storedOriginal)) {
    return toAbsoluteUrl(storedOriginal);
  }

  const directLink = image.closest<HTMLAnchorElement>('a[href]');
  if (directLink?.href && isDirectImageResourceUrl(directLink.href)) {
    return toAbsoluteUrl(directLink.href);
  }

  const imageUrl = image.currentSrc || image.src;
  if (!imageUrl || imageUrl.startsWith('blob:') || imageUrl.startsWith('data:')) {
    return '';
  }
  return toAbsoluteUrl(imageUrl);
}

function isDmbUiElement(element: Element): boolean {
  return Boolean(element.closest('.mt-x-overlay-inline, .mt-x-reading-bar, .mt-x-screenshot-select, .mt-x-screenshot-result'));
}

function isContextMenuScreenshotElement(element: Element): boolean {
  if (isDmbUiElement(element)) return false;
  if (element === document.body || element === document.documentElement) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function collectScreenshotCandidateElements(addCandidates: (addElement: (element: Element | null) => void) => void): Element[] {
  const candidates: Element[] = [];
  const seen = new Set<Element>();
  const addElement = (element: Element | null): void => {
    if (!element || seen.has(element) || !isContextMenuScreenshotElement(element)) return;
    seen.add(element);
    candidates.push(element);
  };
  addCandidates(addElement);
  return candidates;
}

function toScreenshotSelectionFromElements(elements: Element[]): ScreenshotSelection | null {
  const candidates = buildScreenshotElementCandidates(
    elements.map((element) => ({
      element,
      rect: toElementScreenshotRect(element),
    })),
    { width: window.innerWidth, height: window.innerHeight },
  );
  const candidate = candidates.find((item) => item.area >= 1600) ?? candidates[0];
  return candidate ? toScreenshotSelection(candidate.rect) : null;
}

function findContextMenuScreenshotSelection(event: MouseEvent): ScreenshotSelection | null {
  const elements = collectScreenshotCandidateElements((addElement) => {
    for (const target of event.composedPath()) {
      if (target instanceof Element) addElement(target);
    }
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      addElement(element);
    }
  });
  return toScreenshotSelectionFromElements(elements);
}

function findContextMenuTarget(event: MouseEvent): ContextMenuTranslateTarget | null {
  const target = event.target;
  if (target instanceof Element && isDmbUiElement(target)) return null;
  if (target instanceof HTMLImageElement) {
    const originalUrl = readContextImageOriginalUrl(target);
    const documentRect = toElementDocumentScreenshotRect(target);
    if (originalUrl && isUsableScreenshotRect(documentRect)) {
      return {
        kind: 'image',
        element: target,
        originalUrl,
        documentRect,
      };
    }
  }
  const selection = findContextMenuScreenshotSelection(event);
  return selection ? { kind: 'screenshot', selection } : null;
}

function isPointerInsideViewport(position: PointerPosition): boolean {
  return position.clientX >= 0 &&
    position.clientY >= 0 &&
    position.clientX <= window.innerWidth &&
    position.clientY <= window.innerHeight;
}

function updateLastPointerPosition(event: MouseEvent | PointerEvent): void {
  lastPointerPosition = {
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function showShortcutToast(message: string): void {
  if (!shortcutToastElement) {
    shortcutToastElement = document.createElement('div');
    shortcutToastElement.className = 'mt-x-shortcut-toast';
    document.body.appendChild(shortcutToastElement);
  }
  shortcutToastElement.textContent = message;
  shortcutToastElement.dataset.visible = 'true';
  if (shortcutToastTimer !== null) {
    window.clearTimeout(shortcutToastTimer);
  }
  shortcutToastTimer = window.setTimeout(() => {
    if (!shortcutToastElement) return;
    shortcutToastElement.remove();
    shortcutToastElement = null;
    shortcutToastTimer = null;
  }, 1800);
}

function findHoverScreenshotSelection(elementsFromPoint: Element[]): ScreenshotSelection | null {
  const elements = collectScreenshotCandidateElements((addElement) => {
    for (const element of elementsFromPoint) {
      let current: Element | null = element;
      while (current && current !== document.body && current !== document.documentElement) {
        addElement(current);
        current = current.parentElement;
      }
    }
  });
  return toScreenshotSelectionFromElements(elements);
}

function findHoverTranslateTarget(): ContextMenuTranslateTarget | null {
  if (!lastPointerPosition || !isPointerInsideViewport(lastPointerPosition)) {
    return null;
  }
  const elements = document.elementsFromPoint(lastPointerPosition.clientX, lastPointerPosition.clientY);
  const topElement = elements[0];
  if (!topElement || isDmbUiElement(topElement)) {
    return null;
  }

  const hoverElement = elements.find((element) => isContextMenuScreenshotElement(element));
  if (!hoverElement) {
    return null;
  }

  if (hoverElement instanceof HTMLImageElement) {
    const originalUrl = readContextImageOriginalUrl(hoverElement);
    const documentRect = toElementDocumentScreenshotRect(hoverElement);
    if (originalUrl && isUsableScreenshotRect(documentRect)) {
      return {
        kind: 'image',
        element: hoverElement,
        originalUrl,
        documentRect,
      };
    }
  }

  const selection = findHoverScreenshotSelection(elements);
  return selection ? { kind: 'screenshot', selection } : null;
}

async function translateTarget(target: ContextMenuTranslateTarget): Promise<void> {
  if (target.kind === 'image') {
    await core.translateImageInFloatingOverlay(target.originalUrl, target.element, target.documentRect);
    return;
  }
  await core.translateScreenshotSelection(target.selection);
}

document.addEventListener('contextmenu', (event) => {
  contextMenuTarget = findContextMenuTarget(event);
}, true);
document.addEventListener('pointermove', updateLastPointerPosition, true);
document.addEventListener('mousemove', updateLastPointerPosition, true);
document.addEventListener('mouseleave', () => {
  lastPointerPosition = null;
}, true);

// Listen for context-menu translate requests from background
const chromeApi = getExtensionApi();

// ── 探针：内容脚本每次被注入就留一条（证明本次是"全新注入"还是旧实例仍在）──
// ★ `navType` 就是"手动刷新 vs 站点自己触发的刷新"的判据：
//   `reload` = 用户按 F5 / 右键刷新（站点代码也可能调 location.reload()）；
//   `navigate` = 一次普通导航（点下一页、站点改 location.href 都算这类）；
//   `back_forward` = 前进/后退（可能命中 bfcache，此时不该重新注入）。
//   两者若都是真导航，`pagehide(persisted=false)` 就是同一条路径 —— 数据上可验证。
function currentNavType(): string {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type ?? 'unknown';
  } catch {
    return 'unsupported';
  }
}
probe('content:loaded', {
  url: location.href,
  visibility: document.visibilityState,
  navType: currentNavType(),
  // ★ 判定"页面无操作自动刷新"的硬证据（2026-10-10 补）：
  //   · `wasDiscarded` = 本页上一次是被浏览器**内存回收丢弃**的（tab discarding）。
  //     这类"重新加载"不是站点刷的、也不是用户点的 —— 用户看到的正是"我没动它，它自己刷新了"。
  //     它只发生在后台标签页被丢弃后重新激活时，且**不稳定复现**（取决于当时的内存压力）。
  //   · `timeOrigin` = 换了就证明文档真的重建过（与探针每条的 `to` 互为印证）。
  wasDiscarded: readWasDiscarded(),
  timeOrigin: typeof performance.timeOrigin === 'number' ? Math.round(performance.timeOrigin) : undefined,
});

/** `document.wasDiscarded` 是 Page Lifecycle 的非标准字段，取不到就当未知。 */
function readWasDiscarded(): boolean | undefined {
  try {
    const value = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

// ── Page Lifecycle（Chrome）：内存压力下标签页会先被 **freeze**、再被 **discard** ──
// 与 `page:hide / page:show(persisted)` 合起来就是"无操作自动刷新"的完整判据链：
//   freeze → 页面被挂起（还没丢）；resume → 解冻；discard → 下次进来是全新文档。
document.addEventListener('freeze', () => {
  probe('page:freeze', { path: location.pathname, visibility: document.visibilityState });
});
document.addEventListener('resume', () => {
  probe('page:resume', { path: location.pathname, visibility: document.visibilityState });
});

// ── 探针：页面进退场与可见性 —— "到底有没有自动刷新"看这三条即可 ──
// `page:hide` 的 `persisted` 区分"真卸载"与"进 bfcache"；
// `page:show` 的 `persisted` 区分"从 bfcache 解冻"与"真重载"。
window.addEventListener('pageshow', (event) => {
  probe('page:show', {
    persisted: event.persisted,
    path: location.pathname,
    visibility: document.visibilityState,
  });
});
document.addEventListener('visibilitychange', () => {
  probe('page:visibility', {
    state: document.visibilityState,
    path: location.pathname,
  });
});

// 页面退场时的内容侧收尾：事件缓冲冲出去、预载进度停表。
// 统一在模块级收口 —— `stopPrefetchProgressTimer` 在非 e-hentai 页是 no-op，
// `flushContentEventLog` 则对所有站点都有效。
window.addEventListener('pagehide', (event) => {
  probe('page:hide', {
    persisted: event.persisted,
    path: location.pathname,
    visibility: document.visibilityState,
  });
  flushContentEventLog();
  // 探针自己的事件流批量窗口是 250ms：卸载前冲一次，否则最后几条会随上下文消失。
  // （探针的 storage 兜底通道不受影响，它每条都立即排队写。）
  flushProbeRelay();
  // bfcache（persisted=true）里页面还会回来，先别停表 —— 与 `bindContentLifecycle` 同口径。
  if (!event.persisted) stopPrefetchProgressTimer();
});

function retireAfterContextInvalidated(): void {
  if (runtimeMessageListener && chromeApi?.runtime?.onMessage?.removeListener) {
    chromeApi.runtime.onMessage.removeListener(runtimeMessageListener);
  }
  runtimeMessageListener = null;
  navigationObserver?.disconnect();
  navigationObserver = null;
  stopPrefetchProgressTimer();
}

const handleRuntimeMessage = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return false;
    }

    if (message.type === 'mt:context-menu-translate') {
      const target = contextMenuTarget;
      contextMenuTarget = null;
      if (target) {
        void (async () => {
          try {
            await translateTarget(target);
            sendResponse({ ok: true, type: 'mt:context-menu-translate' });
          } catch (error: unknown) {
            const failure = toErrorMessage(error);
            // 内容侧失败上报：这三个入口不在 background / offscreen 的视野里（见 contentEventLog 头注），
            // 不在这里记就没人记。
            emitContentFailure({
              message: failure,
              stage: 'context-menu-translate',
              module: 'content/index',
              fn: 'handleRuntimeMessage',
              what: { kind: target.kind },
            });
            sendResponse({ ok: false, type: 'mt:context-menu-translate', error: failure });
          }
        })();
      } else {
        sendResponse({ ok: false, type: 'mt:context-menu-translate', error: '未找到可翻译区域' });
      }
      return true;
    }

    if (message.type === 'mt:start-screenshot-translate') {
      core.startScreenshotTranslate().then(() => {
        sendResponse({ ok: true, type: 'mt:start-screenshot-translate' });
      }).catch((error: unknown) => {
        const failure = toErrorMessage(error);
        emitContentFailure({
          message: failure,
          stage: 'start-screenshot-translate',
          module: 'content/index',
          fn: 'handleRuntimeMessage',
          what: { entry: 'popup' },
        });
        sendResponse({ ok: false, type: 'mt:start-screenshot-translate', error: failure });
      });
      return true;
    }

    if (message.type === 'mt:shortcut-translate-hover') {
      const target = findHoverTranslateTarget();
      if (!target) {
        showShortcutToast('未找到可翻译区域');
        sendResponse({ ok: false, type: 'mt:shortcut-translate-hover', error: '未找到可翻译区域' });
        return true;
      }
      void (async () => {
        try {
          await translateTarget(target);
          sendResponse({ ok: true, type: 'mt:shortcut-translate-hover' });
        } catch (error: unknown) {
          const failure = toErrorMessage(error);
          emitContentFailure({
            message: failure,
            stage: 'shortcut-translate-hover',
            module: 'content/index',
            fn: 'handleRuntimeMessage',
            what: { kind: target.kind },
          });
          sendResponse({ ok: false, type: 'mt:shortcut-translate-hover', error: failure });
        }
      })();
      return true;
    }

    // 预取设置（预载页数 + 进入自动翻译）：弹窗改 → 后台转发到这里直接生效。
    // 与 mt:memory-cache 同口径：内容脚本没有 settings，只能被推。
    if (message.type === 'mt:prefetch-config') {
      // 探针：`applied` = 本页到底有没有可写的执行器。
      // 非 e-hentai 页此处为 false —— 推送会"回成功但什么都不做"，这一行专门记它。
      probe('msg:prefetch-config', {
        prefetchDepth: message.prefetchDepth,
        autoTranslateOnEnter: message.autoTranslateOnEnter,
        applied: applyPrefetchConfig !== null,
        path: location.pathname,
      });
      // 用共享的 `PrefetchConfigPatch` 收窄，不在本地再写一遍断言 —— 字段增删只改一处，
      // 不会再出现"本地断言漏了一个字段、于是那条路径在类型上隐形"的情况。
      applyPrefetchConfig?.(message as PrefetchConfigPatch);
      sendResponse({ ok: true, type: 'mt:prefetch-config' });
      return true;
    }

    // 弹窗读写**译图缓存**。缓存分两层：本文档的 `PhotoStateStore`（随文档生灭）与
    // off-screen 文档代理的 **IndexedDB 落盘缓存**（跨 SW 重启/浏览器重启存活）。
    // 「改上限 / 清空」由这里两层一起操作；「看有几张」必须报落盘那层的条数
    // （`vaultSize`），否则刷新一次数字就归零，用户会以为缓存被清了。
    if (message.type === 'mt:memory-cache') {
      void (async (): Promise<void> => {
        const cache = ((): { size: number; limit: number; cleared: number } => {
          if (message.action === 'clear') {
            return core.clearMemoryCache();
          }
          if (message.action === 'limit' && typeof message.limit === 'number') {
            return { ...core.setMemoryCacheLimit(message.limit), cleared: 0 };
          }
          return { ...core.getMemoryCacheInfo(), cleared: 0 };
        })();
        // clear 的 off-screen 那半是 `void` 发出的（不阻塞页面），读取排在它之后投递，
        // 由 broker 保证的投递顺序即可拿到清空后的真实条数。
        const vault = await core.getVaultCacheSize();
        // 探针：弹窗读到的那个数字，在页面侧长什么样。
        probe('msg:memory-cache', {
          action: message.action,
          documentLayerSize: cache.size,
          vaultSize: vault.size,
          vaultReached: vault.reached,
        });
        sendResponse({
          ok: true,
          type: 'mt:memory-cache',
          // ★ `reached=false` = 没读到（宿主失联），弹窗显示「未连接」而不是"0 张"。
          cache: { ...cache, vaultSize: vault.size, reached: vault.reached },
        });
      })();
      return true;
    }

    return false;
};

if (chromeApi?.runtime?.onMessage?.addListener) {
  const listener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void): boolean => {
    try {
      return handleRuntimeMessage(message, sender, sendResponse);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        retireAfterContextInvalidated();
        return false;
      }
      throw error;
    }
  };
  runtimeMessageListener = listener;
  chromeApi.runtime.onMessage.addListener(listener);
}
