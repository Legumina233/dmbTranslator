import type {
  ImageTarget,
  PhotoState,
  SiteAdapter,
} from './types';
import {
  createUiElements,
  injectStyles,
  renderUi,
} from './ui';
import type { UiElements } from './ui';
import type { ScreenshotRect, ScreenshotSelection } from './screenshot';
import { createImageTranslationExecutionModule } from './translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from './translation/imageTranslationExecutionArbiter';
import { ImageTranslationController } from './translation/imageTranslationController';
import { PhotoStateStore } from './state/photoStateStore';
import {
  createOffscreenTranslatedImageVault,
  type TranslatedImageVaultPort,
} from './state/offscreenTranslatedImageVault';
import { ReadingModeController } from './reading/readingModeController';
import { CardStateController } from './ui/cardState';
import { ScreenshotController } from './screenshot/screenshotController';
import { createDefaultReaderEngineReadingModeModule } from './reading/defaultReaderEngineReadingModeModule';
import type { ReaderEngineReadingModeModulePort } from './reading/readerEngineReadingModeModule';
import { createSiteReadingModeAdapter } from './reading/siteReadingModeAdapter';
import { createProbe } from '../../shared/probe';

/** 探针：只记录译图缓存的"读回"结果，不改变任何行为。定位完即删。 */
const probe = createProbe('content');

type MountedImage = {
  key: string;
  target: ImageTarget;
  ui: UiElements;
};

export class TranslatorCore {
  private adapter: SiteAdapter;
  private readonly stateStore = new PhotoStateStore();
  /**
   * 译图持久层（**off-screen 文档的内存缓存**，不落盘）—— Bug1 的缓存保全。
   * 内存层（`stateStore`）随文档生灭；这一层活在扩展源的另一个文档里，整页重载不动它，
   * 所以翻回已译页不用重跑管线。
   */
  private readonly vault: TranslatedImageVaultPort;
  /**
   * 库里**已有记录、但还没回填到内存**的页身份。
   * `hydrateVault()` 只读这些键（不读 Blob），真正取图推迟到该页被挂载的那一刻。
   */
  private readonly pendingVaultKeys = new Set<string>();
  private readonly imageTranslationExecution = createImageTranslationExecutionModule();
  private readonly imageTranslationExecutionArbiter = createImageTranslationExecutionArbiter(
    this.imageTranslationExecution,
  );
  private readonly cardStateController = new CardStateController();
  private readonly screenshotController = new ScreenshotController(
    this.stateStore,
    this.imageTranslationExecutionArbiter,
    this.cardStateController,
  );
  private readonly imageTranslationController: ImageTranslationController;
  private readonly readingModeController: ReadingModeController;
  private readonly readerEngineReadingModeModule: ReaderEngineReadingModeModulePort | null;
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private disposePageshow: (() => void) | null = null;
  private syncTimer: number | null = null;
  private stopped = false;

  constructor(adapter: SiteAdapter, contentSessionId?: string, vault?: TranslatedImageVaultPort) {
    this.adapter = adapter;
    this.vault = vault ?? createOffscreenTranslatedImageVault();
    this.imageTranslationController = new ImageTranslationController(
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      {
        resolveTarget: (key) => this.mounted.get(key)?.target,
        resolveTranslationContext: (target) => this.adapter.getTranslationContext?.(target) ?? {
          status: 'empty',
        },
        applyImage: (target, state) => this.applyMountedStateImage(target.key, state),
        onToggleDisplay: () => { this.toggleDisplayMode(); },
        render: (key) => this.renderForKey(key),
        persistTranslatedImage: (key, image) => { void this.persistVaultEntry(key, image); },
      },
    );
    this.readingModeController = new ReadingModeController(
      createSiteReadingModeAdapter(adapter),
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      () => this.scheduleSync(),
      () => this.cancelScheduledSync(),
    );
    this.readerEngineReadingModeModule = contentSessionId
      ? createDefaultReaderEngineReadingModeModule(
          this.stateStore,
          this.imageTranslationExecutionArbiter,
        )
      : null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // ★ 探针：内容脚本层归零的**唯一**入口。它出现在 `page:hide(persisted=false)` 之后
    //   是设计使然（翻页/重载都归零），不代表 off-screen 那份缓存丢了。
    probe('core:stop', { reason: 'page teardown' });
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    if (this.disposePageshow) {
      this.disposePageshow();
      this.disposePageshow = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.readingModeController.teardown();
    this.readerEngineReadingModeModule?.dispose();
    this.screenshotController.dispose();
    this.imageTranslationController.dispose();
    this.imageTranslationExecutionArbiter.dispose('翻译核心已停止');
    this.stateStore.dispose();
  }

  start(): void {
    if (this.stopped) return;
    injectStyles();
    this.readerEngineReadingModeModule?.start();
    this.disposeObserver = this.adapter.observe(() => this.scheduleSync());
    // ── bfcache（历史导航/往返缓存）恢复时 DOM 与 JS 状态原样解冻、站点零请求，
    // 适配器的 DOM 观察器不一定触发 → 主动补一次 sync（到达还原走内存，零成本）。
    // （测试环境没有 window —— 无 window 时静默跳过，与其它 DOM 触点的容错口径一致。）
    if (typeof window !== 'undefined') {
      const onPageshow = (event: PageTransitionEvent): void => {
        if (this.stopped || !event.persisted) return;
        this.scheduleSync();
      };
      window.addEventListener('pageshow', onPageshow);
      this.disposePageshow = () => window.removeEventListener('pageshow', onPageshow);
    }
    // 先读持久层（异步），再 sync —— 读回来会自己补一拍 sync 把译图贴上去。
    // 刻意**不 await**：读一次缓存要走一趟扩展端口（必要时还要先把 off-screen 文档拉起来），
    // 拿它挡住 UI 挂载只会换来一段白屏；晚一拍贴图比晚一拍出界面划算得多。
    void this.hydrateVault();
    this.sync();
  }

  async startScreenshotTranslate(): Promise<void> {
    await this.screenshotController.startScreenshotTranslate();
  }

  async translateImageInFloatingOverlay(
    originalUrl: string,
    imageElement: HTMLImageElement,
    fallbackDocumentRect: ScreenshotRect,
  ): Promise<void> {
    await this.screenshotController.translateImageInFloatingOverlay(
      originalUrl,
      imageElement,
      fallbackDocumentRect,
    );
  }

  async translateScreenshotSelection(selection: ScreenshotSelection): Promise<void> {
    await this.screenshotController.translateScreenshotSelection(selection);
  }

  /**
   * 内存译图缓存：**占用 = 条数**（一张译图一条，每层不统计字节）。
   * 弹窗「译图缓存」那一行读的就是这个。
   */
  getMemoryCacheInfo(): { size: number; limit: number } {
    return { size: this.stateStore.size(), limit: this.stateStore.limit() };
  }

  /**
   * 读 **落盘那份缓存**里现有的条数（弹窗的「译图缓存 N 张」读的就是它）。
   *
   * 与 `getMemoryCacheInfo().size` 的区别，是这两层的寿命不同：
   * - `stateStore` 那层随本文档生灭 —— 刷新页面（`pagehide` → `stop()` → `dispose()`）必归零；
   * - 落盘那层跨页面 / 跨 SW 重启存活，才是"缓存里到底留了几张"的真相。
   *
   * 弹窗原先显示前者的条数，于是每次刷新都会看到数字掉到 0（图其实还在），
   * 用户误以为缓存被清空。**只读键**，不把 Blob 搬回来（一次全量读会把整库图片
   * 塞进调用方的堆里）。
   *
   * ★ 2026-10-10：**返回 `reached`** —— 读不到时不能再谎报"0 张"。
   *   真机上"宿主失联"与"缓存真的空"长得一模一样，弹窗显示 0 张把排查带偏过。
   */
  async getVaultCacheSize(): Promise<{ size: number; reached: boolean }> {
    try {
      const result = await this.vault.loadKeys();
      if (result.status === 'unavailable') {
        probe('vault:size-unavailable', { reason: result.reason });
        return { size: 0, reached: false };
      }
      return { size: result.value.length, reached: true };
    } catch (error) {
      // 注入的替身不一定守"不抛"的约定：照样不能谎报数字。
      probe('vault:size-unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { size: 0, reached: false };
    }
  }

  /**
   * 改译图缓存的条数上限。**两层一起改**。
   *
   * 缓存分两层：本文档的 `stateStore` 与 off-screen 文档的 `vault`。用户改上限这件事
   * 是**一个动作、一个目的**（"最多留几张"），所以必须一次落到两层 —— 只改一层的话，
   * 弹窗上的数字管不住真正占内存的那一份（vault 才是跨页面重载存活、能攒到上限的那个）。
   *
   * 两条细节：
   * - **先由内存层定出生效值**（非法值由它回落到默认），再把这个值原样交给另一层，
   *   两层不会各算各的；
   * - 调小会**立刻裁**掉最久未用的那些（不是等下次写入才缩）。
   */
  setMemoryCacheLimit(limit: number): { size: number; limit: number } {
    const effective = this.stateStore.setLimit(limit);
    void this.vault.setLimit(effective).catch(() => undefined);
    return this.getMemoryCacheInfo();
  }

  /** M4 预取执行器用：该页是否"在跑或已有译图"（busy = 不重复派发）。 */
  isPageBusy(key: string): boolean {
    return this.imageTranslationController.isKeyBusy(key);
  }

  /** M4 预取执行器的派发口：后台翻译一个未挂载的页（`key` = `${gid}-${page}`）。返回值 = 任务完成。 */
  translatePageInBackground(key: string, imageUrl: string): Promise<void> {
    return this.imageTranslationController.translateInBackground(key, imageUrl);
  }

  /** 意图即换图用：该页内存里是否已有译图（有 = 翻页瞬间就能换画框）。 */
  getTranslatedUrl(key: string): string | null {
    return this.stateStore.get(key)?.translatedUrl ?? null;
  }

  /**
   * 清空内存译图。
   * **必须顺手把常驻画框上的旧图撤掉** —— blob URL 一撤销，画框再挂着就是一张裂图。
   *
   * ⚠️ 后端那份缓存**全扩展共用一份**（off-screen 文档属扩展源），
   * 所以这个按钮是"清掉所有站点的译图缓存"，不只是当前站点。
   */
  clearMemoryCache(): { size: number; limit: number; cleared: number } {
    const cleared = this.stateStore.clear();
    // ★ 探针：这条路径就是"用户主动点清空"的唯一入口。日志里出现它 = 不是 bug。
    probe('cache:clear-memory', { cleared });
    // 持久层必须一起清 —— 只清内存的话，重载一次被"清掉"的译图又从那边的缓存里回来了，
    // 用户看到的就是「清空按钮没用」。待回填队列同理。
    this.pendingVaultKeys.clear();
    void this.vault.clear().catch(() => undefined);
    for (const mounted of this.mounted.values()) {
      this.adapter.applyOverlayImage?.(mounted.target, null);
      mounted.ui.host.remove();
    }
    this.mounted.clear();
    // 用 scheduleSync（下一拍）而不是 sync：清空当下的条数要如实回报给弹窗（0 条），
    // 重建 UI 会重新 ensure 当前页那条空状态，别让它抢在回数之前。
    this.scheduleSync();
    return { ...this.getMemoryCacheInfo(), cleared };
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 100);
  }

  private cancelScheduledSync(): void {
    if (this.syncTimer === null) return;
    window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private sync(): void {
    if (this.adapter.isReadingMode?.()) {
      this.readingModeController.sync();
      return;
    }

    // Reading DOM can disappear during SPA transitions. Detach its UI without
    // cancelling already-submitted work; stop() owns final cancellation.
    this.readingModeController.suspend();

    const targets = this.adapter.findImages();
    const currentKeys = new Set(targets.map((t) => t.key));

    for (const [key, mounted] of this.mounted) {
      if (!currentKeys.has(key)) {
        mounted.ui.host.remove();
        this.mounted.delete(key);
      }
    }

    for (const target of targets) {
      const mounted = this.mounted.get(target.key);
      if (mounted?.ui.host.isConnected) {
        mounted.target = target;
        const state = this.stateStore.ensure(target.key, target.originalUrl);
        this.adoptVaultedImage(target.key, state);
        this.applyStateImage(target, state);
        continue;
      }
      if (mounted) {
        this.mounted.delete(target.key);
      }

      const key = target.key;
      const anchor = this.adapter.createUiAnchor(target);
      const ui = createUiElements();
      anchor.appendChild(ui.host);

      ui.button.addEventListener('click', () => {
        const currentTarget = this.mounted.get(key)?.target ?? target;
        void this.imageTranslationController.handleTranslateClick(currentTarget);
      });
      // ── 到达页面时只**查缓存**，命中就直接显示译图（Step 7 的验收：回到该页直接是译图，不重跑不闪原图）──
      // 刻意**只查不译**：没命中什么都不做，不给页面自动加活。
      //
      // ★ 门控口径显式化（2026-10-09 · 4.3）：判据是 **`findImages()` 恰好 1 张** ——
      //   这是"单图页"的**形状判定，不是站点判定**。所以 **Twitter / Pixiv 的单图页同样走这里**，
      //   不是只有 e-hentai 阅读页。这一点此前没有写下来，属于"没被声明的跨站点行为"。
      //   · 为什么无害：`restoreFromCache` 是**同步 + 纯内存**的（`stateStore` 里没译图就直接 return，
      //     代价 ≈ 一次 Map 查询；新 key 时顺带建状态，`sync()` 本来也要用），**不是跨进程调用**。
      //   · 但不是"恒 MISS"：用户在 Twitter / Pixiv 上**手动译过**之后，同一页再 `sync()`
      //     就会真的命中并重新贴一次图 —— 这正是想要的行为，别按"反正不会命中"删掉这段。
      //   · 多图的自动还原属于阅读流程（M6），刻意不在这个分支做 —— 滚动型站点每出现一张新图
      //     都还原一次，代价太大。
      //
      // ⚠️ 将来若给 Twitter / Pixiv 接上**预载**，本分支会在那些站点变成"预载图自动贴上去"，
      //   语义会**静默扩大**。到那时要么把它收窄成显式站点门控，要么明确接受并改这条注释。
      // 控制器内部按 key 去重，`sync()` 反复触发也不会重复查。
      if (targets.length === 1) {
        void this.imageTranslationController.restoreFromCache(target);
      }
      ui.stageTimingCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleStageTimingCard(state, () => this.renderForKey(key));
      });
      ui.errorDetailCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleErrorDetailCard(state, () => this.renderForKey(key));
      });

      this.mounted.set(key, { key, target, ui });
      const state = this.stateStore.ensure(key, target.originalUrl);
      this.adoptVaultedImage(key, state);
      this.applyStateImage(target, state);
      renderUi(ui, state, { cancelableWhileRunning: true });
    }
  }

  private renderForKey(key: string): void {
    const mounted = this.mounted.get(key);
    if (!mounted?.ui.host.isConnected) return;
    const state = this.stateStore.get(key) ?? null;
    renderUi(mounted.ui, state, { cancelableWhileRunning: true });
  }

  // ───────────────────────── 译图持久层（Bug1 缓存保全） ─────────────────────────
  //
  // 背景：e-hentai 阅读页翻页是**整页重载**（站点自己的 `load_image()` 偶发抛异常也会打翻文档）。
  // 文档一销毁就走 `pagehide(persisted=false)` → `stop()` → `stateStore.dispose()`，
  // 内存译图连同 blob URL 一起归零 —— 翻回已译页得把十几秒的管线重跑一遍。
  //
  // 下面三个方法合起来构成闭环：
  //   `persistVaultEntry`（译好即写缓存）→ `hydrateVault`（重载后读回键）
  //   → `materializeVaultedImage`（该页真被挂载时按需取图并贴）
  //
  // ★ 缓存**不落盘**（2026-10-10 用户拍板）：它活在 off-screen 文档的内存里，
  //   跨文档存活靠的是"那个文档不随页面导航生灭"，而不是"写进了磁盘"。
  //   本类只认 `TranslatedImageVaultPort` 这个接口，换后端不动这里的任何一行。

  /**
   * 译图写缓存。**不 await、不抛** —— 它跑在翻译刚完成的关键路径上，
   * 端口慢或宿主不可用都不能让页面上的那张图晚出哪怕一帧。
   */
  private async persistVaultEntry(key: string, image: Blob): Promise<void> {
    // 内存里已经有这张图了，不必再等缓存里的那份回填。
    this.pendingVaultKeys.delete(key);
    const t0 = probe.mark();
    try {
      const result = await this.vault.put(key, image);
      if (result.status === 'unavailable') {
        probe.timed('vault:put-unavailable', t0, { key, reason: result.reason });
        return;
      }
      probe.timed('vault:put-ok', t0, { key, bytes: image.size });
    } catch (error) {
      probe.timed('vault:put-failed', t0, {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      // vault 内部已兜底；这里是双保险（注入的替身不一定守约定）。
    }
  }

  /**
   * 读回「缓存里有哪些页已经译好」。**只读键，不读 Blob**。
   *
   * 一次把整库图片搬回来（200 张 × 2 MiB ≈ 400 MiB）无论对哪一侧的堆都是灾难，
   * 所以真正的图一律推迟到该页被挂载时按需取（见 `materializeVaultedImage`）。
   */
  private async hydrateVault(): Promise<void> {
    const t0 = probe.mark();
    let keys: string[];
    try {
      const result = await this.vault.loadKeys();
      // ★ 这里就是"看着像被清空、其实数据还在"的分叉点：
      //   不可达（宿主没起来 / 端口断了 / 超时）与"真的 0 个键"必须分开记。
      if (result.status === 'unavailable') {
        probe.timed('vault:hydrate-unavailable', t0, { reason: result.reason });
        return;
      }
      keys = result.value;
    } catch (error) {
      probe.timed('vault:hydrate-failed', t0, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    probe.timed('vault:hydrate-ok', t0, { count: keys.length });
    if (this.stopped || keys.length === 0) return;
    for (const key of keys) this.pendingVaultKeys.add(key);
    // 读回完成时 DOM 早就稳定、适配器观察器不会再触发 —— 主动补一拍。
    this.scheduleSync();
  }

  /**
   * 挂载时的回填入口：这一页在**上一次文档**里译好了。
   * 命中就异步取图，取回来直接贴 —— 用户看到的第一帧就是译图，不重跑管线。
   */
  private adoptVaultedImage(key: string, state: PhotoState): void {
    if (state.translatedUrl || state.status === 'running') return;
    if (!this.pendingVaultKeys.has(key)) return;
    this.pendingVaultKeys.delete(key);
    void this.materializeVaultedImage(key, state);
  }

  private async materializeVaultedImage(key: string, state: PhotoState): Promise<void> {
    const t0 = probe.mark();
    let blob: Blob | undefined;
    try {
      const result = await this.vault.get(key);
      if (result.status === 'unavailable') {
        // 通道不可达 ≠ 缓存里没有 —— 分开记，否则命中率问题会被读成"缓存是空的"。
        probe.timed('vault:materialize-unavailable', t0, { key, reason: result.reason });
        return;
      }
      blob = result.value;
    } catch (error) {
      probe.timed('vault:materialize-failed', t0, {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!blob) {
      // ★ 探针：这一页**被记账为"缓存里有"，真去取却没有** —— 命中率问题的直接证据。
      probe.timed('vault:materialize-miss', t0, { key });
      return;
    }
    probe.timed('vault:materialize-ok', t0, { key, bytes: blob.size });
    // 取图是异步的，这中间世界可能已经变了：文档被停掉 / 用户自己点了翻译 / 已经有图了。
    if (this.stopped || state.translatedUrl || state.status === 'running') return;
    // 这条 state 可能已被内存层淘汰（改小上限 / 写入挤掉）——
    // 往一个不在 store 里的对象上写图 = 页面贴了图、状态卡片却是空的。
    if (this.stateStore.get(key) !== state) return;
    let url: string;
    try {
      url = URL.createObjectURL(blob);
    } catch {
      return; // 无 URL 实现的环境（测试）→ 静默跳过，退回重跑管线
    }
    state.translatedUrl = url;
    state.status = 'translated';
    this.applyMountedStateImage(key, state);
    this.renderForKey(key);
  }

  private applyMountedStateImage(key: string, state: PhotoState): void {
    const mounted = this.mounted.get(key);
    if (!mounted?.ui.host.isConnected) return;
    this.applyStateImage(mounted.target, state);
  }

  /** 全局显示模式（用户拍板 2026-10-04）：切换对所有页生效，不再每页独立。 */
  private displayMode: 'translated' | 'original' = 'translated';

  isDisplayModeTranslated(): boolean {
    return this.displayMode === 'translated';
  }

  toggleDisplayMode(): 'translated' | 'original' {
    this.displayMode = this.displayMode === 'translated' ? 'original' : 'translated';
    const mounted = [...this.mounted.values()].find((m) => m.ui.host.isConnected);
    if (mounted) {
      const state = this.stateStore.get(mounted.key);
      if (state) this.applyStateImage(mounted.target, state);
    }
    return this.displayMode;
  }

  private applyStateImage(target: ImageTarget, state: PhotoState): void {
    // ── 常驻画框模式（e-hentai）：站点 <img> 的 src **永不被改写**，译图画在我们自己的画框上。
    // 有译图 → 画框现身；没译图 / 原文模式 → 画框隐身，露出站点原图。
    const applyOverlay = this.adapter.applyOverlayImage;
    if (applyOverlay !== undefined) {
      const translatedUrl = this.displayMode === 'translated' && state.status === 'translated'
        ? state.translatedUrl
        : undefined;
      if (!translatedUrl) {
        applyOverlay.call(this.adapter, target, null);
        return;
      }
      // ★★ 闸门已拆（2026-10-03 用户拍板）：**不再等站点原图下载完**。
      // 被拆掉的那条规则来自 `5eb38b2`（2026-10-03 02:39）：
      // 「原图 load/error 落定前绝不贴译图」——它的成立前提是**改写站点 img 的 src**，
      // 换 src 会顶掉正在加载的原图 → 先空白再出图（v0.1.4 起翻回已译页必闪的机理）。
      // 画框模式下我们根本不碰站点 img，那个前提不成立，所以等待纯属白等：
      // 它等的那几秒正是屏幕上空白的那几秒。
      this.commitImage(target, translatedUrl, (t, url) => applyOverlay.call(this.adapter, t, url));
      return;
    }

    // ── 其它站点：仍是改写站点 <img> 的 src，规则不变 ──
    if (!state.translatedUrl) return;
    const imageUrl = state.status === 'translated' ? state.translatedUrl : state.originalUrl;
    if (target.element.src === imageUrl) return; // 已是目标图：不动
    this.commitImage(target, imageUrl, (t, url) => this.adapter.applyImage(t, url));
  }

  /**
   * 先解码再落地：换的那一帧就是画好的图，不留解码空白（大图 decode 可达上百毫秒）。
   * 解码失败/无 Image 环境也会在 500ms 兜底或立即落地，宁可晚一点也不丢功能。
   */
  private commitImage(
    target: ImageTarget,
    url: string,
    apply: (target: ImageTarget, url: string) => void,
  ): void {
    try {
      const probe = new Image();
      let done = false;
      const go = (): void => {
        if (done) return;
        done = true;
        apply(target, url);
      };
      probe.onload = go;
      probe.onerror = go;
      probe.src = url;
      if (typeof probe.decode === 'function') {
        probe.decode().then(go).catch(go);
      }
      window.setTimeout(go, 500);
    } catch {
      apply(target, url); // 异常环境（无 Image/window）→ 立即落
    }
  }

}
