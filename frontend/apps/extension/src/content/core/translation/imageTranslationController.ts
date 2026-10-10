import type {
  ImageTarget,
  ImageTranslationContextResolution,
  PhotoState,
} from '../types';
import type { ProgressJankMonitor } from '../progressJank';
import { resolveImageReferrerPolicy } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import type {
  ImageTranslationExecutionActivity,
  ImageTranslationExecutionArbiter,
} from './imageTranslationExecutionArbiter';
import {
  createProgressJankMonitor,
  finishProgressJankMonitor,
  startPhotoStateImageTranslation,
} from './photoStateProjection';

export type ImageTranslationCallbacks = {
  resolveTarget(key: string): ImageTarget | undefined;
  resolveTranslationContext?(target: ImageTarget): ImageTranslationContextResolution;
  applyImage(target: ImageTarget, state: PhotoState): void;
  /** 已译页上的按钮点击 = 切全局显示模式（原图/译图对所有页生效）。 */
  onToggleDisplay?(): void;
  render(key: string): void;
  /**
   * 译图落库（持久化层）—— Bug1「整页重载后译图全丢」的缓存保全。缺省 = 不落库。
   *
   * 只从本控制器这两条路径调：**用户手点**与**预取后台**。
   * 它们正是 Bug1 的现场（e-hentai 阅读页单图 `gid-page`）。
   * 阅读模式的「逻辑页分片」路径有自己的一套 key 语义，未接入本钩子。
   */
  persistTranslatedImage?(key: string, image: Blob): void;
};

export type ImageTranslationRuntime = {
  createJankMonitor(entry: 'image'): ProgressJankMonitor;
  finishJankMonitor(monitor: ProgressJankMonitor, diagnosticRunId?: string): void;
};

const defaultRuntime: ImageTranslationRuntime = {
  createJankMonitor: createProgressJankMonitor,
  finishJankMonitor: (monitor, diagnosticRunId) => {
    finishProgressJankMonitor(monitor, diagnosticRunId);
  },
};

export class ImageTranslationController {
  private readonly activeActivities = new Map<string, ImageTranslationExecutionActivity>();

  constructor(
    private readonly stateStore: PhotoStateStore,
    private readonly executionArbiter: ImageTranslationExecutionArbiter,
    private readonly callbacks: ImageTranslationCallbacks,
    private readonly runtime: ImageTranslationRuntime = defaultRuntime,
  ) {}

  dispose(): void {
    for (const activity of this.activeActivities.values()) {
      activity.end('图片翻译控制器已停止');
    }
    this.activeActivities.clear();
  }

  /** 终止某页正在跑的翻译。reason 只用于诊断（页面离开 / 用户主动终止）。 */
  cancel(key: string, reason = '图片已离开页面'): void {
    this.activeActivities.get(key)?.end(reason);
    this.activeActivities.delete(key);
  }

  /** 该页是否"在跑或已有译图"——预取执行器用它去重，绝不对着同一页开两条管线。 */
  isKeyBusy(key: string): boolean {
    const state = this.stateStore.get(key);
    return state?.status === 'running' || Boolean(state?.translatedUrl);
  }

  /**
   * M4 Step 14b · 预取执行器的派发口：**后台翻译一个未挂载的页**（用户还没翻过去）。
   * 与手点翻译同一条管线（remote-image 源 → 管线 → 译图），差异只有三处：
   * ① 没有挂载元素 → 不解析元素 referrer 策略（background 按 referrer 响应头兜底）；
   * ② 没有推文上下文（那是 X/Pixiv 的概念）；
   * ③ 完成时不强求贴图 —— 用户已经在那一页的话 `observeTranslation` 会照常贴（含画框），
   *    还没翻过去就只更新内存层，等到达还原走内存直贴。
   * `key` 必须是 M0 页身份（`${gid}-${page}`），`imageUrl` 来自该页 showpage JSON 的 `i3`。
   * **返回值 = 任务完成**（内部已兜底，永不 reject）—— 调度器的"并发恒 1"
   * 靠 await 这个返回值成立，改成即发即忘会连发整队。
   */
  translateInBackground(key: string, imageUrl: string): Promise<void> {
    if (this.isKeyBusy(key)) return Promise.resolve();
    const state = this.stateStore.ensure(key, imageUrl);
    if (state.status === 'running' || state.translatedUrl) return Promise.resolve();

    const jankMonitor = this.runtime.createJankMonitor('image');
    const activity = this.executionArbiter.begin();
    const releaseState = this.stateStore.protect(key);
    const task = startPhotoStateImageTranslation({
      executionModule: activity,
      request: {
        source: {
          kind: 'remote-image',
          url: imageUrl,
        },
        // 整页日志：预取自动翻译（用户口径：有大模型翻译就记，trigger 仅作归类）
        pageKey: key,
        trigger: 'prefetch',
      },
      state,
      includeElapsedText: true,
      jankMonitor,
      finishJankMonitor: this.runtime.finishJankMonitor,
      onChange: () => this.callbacks.render(key),
      // 预取也算「译好了」：用户翻过去时它正好是 Bug1 里最先要用的那张。
      onImageTranslated: (image) => this.callbacks.persistTranslatedImage?.(key, image),
    });
    this.activeActivities.set(key, activity);

    return this.observeTranslation(key, state, activity, task, undefined, releaseState);
  }

  handleTranslateClick(target: ImageTarget): Promise<void> {
    const { key } = target;
    const state = this.stateStore.ensure(key, target.originalUrl);

    // 运行中再点一下 = **终止当前翻译**（按钮此时写着「终止翻译」）。
    // 取消通道本就存在：activity.end → 任务中止 → applyImageTranslationCancellation
    // 把状态投影回 idle（清 stageText/errorText），按钮随之回到「翻译」。
    if (state.status === 'running') {
      // 不在这里 render：此刻状态还是 running，重渲染只会再画一次"终止翻译"。
      // 取消是异步的 —— activity.end → 任务中止 → applyImageTranslationCancellation
      // 把状态投影回 idle，并由它自己的 notify() 驱动重渲染。
      this.cancel(key, '用户点了终止翻译');
      return Promise.resolve();
    }

    if (state.translatedUrl) {
      if (this.callbacks.onToggleDisplay) {
        // 2026-10-04 用户拍板：显示模式是**全局**的——切一次，所有页一起切。
        this.callbacks.onToggleDisplay();
        return Promise.resolve();
      }
      // 无全局开关的调用方（twitter 轮播等多图上下文）：保持每图独立的旧语义 ——
      // 每图自己的显示状态就是 `status`（translated ↔ showingOriginal），没有第二个字段。
      state.status = state.status === 'translated' ? 'showingOriginal' : 'translated';
      const currentTarget = this.callbacks.resolveTarget(key) ?? target;
      this.callbacks.applyImage(currentTarget, state);
      this.callbacks.render(key);
      return Promise.resolve();
    }

    const clickTarget = this.callbacks.resolveTarget(key) ?? target;
    let contextResolution: ImageTranslationContextResolution | undefined;
    try {
      contextResolution = this.callbacks.resolveTranslationContext?.(clickTarget);
    } catch {
      contextResolution = { status: 'unavailable' };
    }

    // ⚠️ 到这一行为止必须**保持同步**：有测试钉住"点击开始时就同步捕获推文上下文"
    // （`captures tweet context synchronously when the click starts`）。
    // 管线是异步的，所以只能塞进下面这个已经返回的 Promise 里 ——
    // 一旦把 `await` 插到上面去，同步段会被推迟到微任务之后，那条测试立刻红。
    return this.translateWithCache(key, state, clickTarget, contextResolution);
  }

  /**
   * 到达页面时的还原：**只有内存** —— `stateStore` 里有译图就同步贴一次（查 Map 零成本，
   * 不需要任何防抖守卫）；贴图时机（等原图画完 + 先解码）由
   * TranslatorCore.applyStateImage 统一裁决。
   */
  restoreFromCache(target: ImageTarget): void {
    const { key } = target;
    const state = this.stateStore.ensure(key, target.originalUrl);
    if (state.status === 'running') return;

    if (state.translatedUrl) {
      this.callbacks.applyImage(target, state);
      this.callbacks.render(key);
      return;
    }
  }

  /**
   * 跑一次译图管线。
   *
   * `key` 就是 M0 的页身份（e-hentai 上是 `${gid}-${page}`）。
   */
  private async translateWithCache(
    key: string,
    state: PhotoState,
    clickTarget: ImageTarget,
    contextResolution: ImageTranslationContextResolution | undefined,
  ): Promise<void> {
    const jankMonitor = this.runtime.createJankMonitor('image');
    const activity = this.executionArbiter.begin();
    const releaseState = this.stateStore.protect(key);
    const task = startPhotoStateImageTranslation({
      executionModule: activity,
      request: {
        source: {
          kind: 'remote-image',
          url: state.originalUrl,
          referrerPolicy: resolveImageReferrerPolicy(clickTarget.element),
        },
        translationContext: contextResolution?.status === 'available'
          ? contextResolution.context
          : undefined,
        // 整页日志：用户手点（trigger=user）
        pageKey: key,
        trigger: 'user',
      },
      state,
      includeElapsedText: true,
      jankMonitor,
      finishJankMonitor: this.runtime.finishJankMonitor,
      onChange: () => this.callbacks.render(key),
      onImageTranslated: (image) => this.callbacks.persistTranslatedImage?.(key, image),
    });
    this.activeActivities.set(key, activity);

    return this.observeTranslation(
      key,
      state,
      activity,
      task,
      contextResolution,
      releaseState,
    );
  }

  private async observeTranslation(
    key: string,
    state: PhotoState,
    activity: ImageTranslationExecutionActivity,
    task: ReturnType<typeof startPhotoStateImageTranslation>,
    contextResolution: ImageTranslationContextResolution | undefined,
    releaseState: () => void,
  ): Promise<void> {
    try {
      const outcome = await task.result;
      if (outcome.translationDebug?.tweetContextLengthFallback) {
        state.contextNoticeText = '推文上下文过长，已改为无上下文翻译';
      } else if (outcome.translationDebug && contextResolution?.status === 'unavailable') {
        state.contextNoticeText = '未找到推文作为上下文';
      }
      const latestTarget = this.callbacks.resolveTarget(key);
      if (latestTarget) this.callbacks.applyImage(latestTarget, state);
      this.callbacks.render(key);
    } catch {
      // The PhotoState projection already exposes the actionable error.
    } finally {
      if (this.activeActivities.get(key) === activity) {
        this.activeActivities.delete(key);
      }
      activity.end();
      releaseState();
    }
  }
}
