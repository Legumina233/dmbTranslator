import {
  createTranslatorCore,
  TranslationCancelledError,
  type TranslationTask,
} from '@dmb/translator-core';
import type {
  AcquiredImageTranslationSource,
  ImageTranslationExecutionModule,
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionRequest,
  ImageTranslationExecutionResult,
} from './imageTranslationExecution';
import { nextPipelineStage, PagePipelineContext } from '../state/pipelineContext';
import type { PipelineStage, PipelineStageOutcome } from '../state/pipelineContext';

export interface ImageTranslationExecutionActivity extends ImageTranslationExecutionModule {
  readonly signal: AbortSignal;
  end(reason?: unknown): void;
}

export interface ImageTranslationExecutionArbiter {
  begin(): ImageTranslationExecutionActivity;
  dispose(reason?: unknown): void;
}

/**
 * 把执行进度事件翻译成管线阶段。
 *
 * 站点/流水线报上来的 stage 名是 `runtime-prepare / load / detect / bubble /
 * ocr / merge / order / translate / inpaint / parallel / typeset / finalize`，
 * 五态只取其中真正对应"这一站做完了"的边界事件，其余一律 `null`（不记站）。
 *
 * 真实阶段名与五态的对应是**事实**而非约定，M1 落这个映射的目的就是把这条
 * 对应关系第一次摆到台面上验证：顺序对不上时，trace 会停在缺的那一站。
 */
/**
 * 把五态 trace 挂到 documentElement 上的属性名。
 *
 * MAIN 世界与隔离世界的 `window` 不共享，DOM 属性是两边唯一都能看见的地方，
 * 所以探针（隔离世界）就靠读这一份来验收五态顺序。
 * 只写不读：UI 状态仍然只从 PhotoState 单向投影，这里不反向影响了什么。
 */
const traceAttribute = 'data-m1-trace';

function publishTrace(pipeline: PagePipelineContext): void {
  try {
    document.documentElement.setAttribute(traceAttribute, JSON.stringify(pipeline.snapshot()));
  } catch {
    // 非文档环境（worker / 测试）里写不了就算了，trace 本身不受影响
  }
}

export type PipelineProgressStage = {
  stage: PipelineStage;
  /** 该阶段的输入图（目前只有 image 站能拿到，供桩 OCR 原样交回）。 */
  source?: AcquiredImageTranslationSource;
};

export function pipelineStageFromProgress(
  event: ImageTranslationExecutionProgress,
): PipelineProgressStage | null {
  if (event.phase === 'preparing') {
    if (event.operation === 'acquire-source') return { stage: 'image' };
    if (event.operation === 'source-ready') {
      return { stage: 'image', source: event.source };
    }
    return null;
  }
  if (event.phase === 'finalizing') return { stage: 'render' };
  if (event.phase !== 'executing' || event.execution.kind !== 'local-pipeline') return null;
  switch (event.execution.progress.stage) {
    case 'ocr':
      return { stage: 'ocr' };
    case 'translate':
      return { stage: 'translation' };
    case 'typeset':
      return { stage: 'typeset' };
    default:
      return null;
  }
}

/**
 * 桩 OCR：跳过真实 OCR，原样把图交回下游并打点，不调 LLM。
 *
 * 用途是让五态链路能在真机上先"看得见"地跑一遍 —— 真机验只需要确认
 * 迁移顺序 `image → ocr → translation → typeset → render` 和"桩被触发一次"，
 * 不必真的把 OCR 模型跑一遍。
 */
export class PipelineOcrStub {
  private calls = 0;

  constructor(private readonly onTrigger?: (callCount: number, source?: AcquiredImageTranslationSource) => void) {}

  /** 被触发的次数；真机验要求这一页恰好是 1。 */
  get callCount(): number {
    return this.calls;
  }

  /** 原图原样交回（本桩不消费它），只加一次计数；不碰任何 OCR / 翻译模型。 */
  run(source?: AcquiredImageTranslationSource): void {
    this.calls += 1;
    this.onTrigger?.(this.calls, source);
  }
}

type ExecutionTask = TranslationTask<
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionResult
>;

const defaultEndReason = '图片翻译执行活动已结束';
const disposedReason = '图片翻译执行仲裁器已停止';

function toCancellationError(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  if (
    reason !== null
    && typeof reason === 'object'
    && !Array.isArray(reason)
    && 'code' in reason
    && typeof reason.code === 'string'
    && 'messageKey' in reason
    && typeof reason.messageKey === 'string'
  ) {
    return new TranslationCancelledError({
      code: reason.code,
      messageKey: reason.messageKey,
      diagnosticSummary: 'diagnosticSummary' in reason
        && typeof reason.diagnosticSummary === 'string'
        ? reason.diagnosticSummary
        : undefined,
    });
  }
  return new TranslationCancelledError({
    code: 'cancelled',
    messageKey: 'translation.cancelled',
    diagnosticSummary: typeof reason === 'string' && reason ? reason : undefined,
  });
}

class ImageTranslationExecutionActivityImplementation
implements ImageTranslationExecutionActivity {
  private readonly abortController = new AbortController();
  private readonly tasks = new Set<ExecutionTask>();
  private ended = false;
  private deliveryBlockedReason: unknown = defaultEndReason;
  private lastSource: AcquiredImageTranslationSource | undefined;

  constructor(
    private readonly executionModule: ImageTranslationExecutionModule,
    private readonly onEnd: (
      activity: ImageTranslationExecutionActivityImplementation,
      reason?: unknown,
    ) => void,
    private readonly pipeline?: PagePipelineContext,
    private readonly ocrStub?: PipelineOcrStub,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * 推进一格并记录。只认"当前该进的那一站"：
   * 同一进度事件重复到达（流水线每阶段都发多条）时，第一站记完，
   * 后续同名事件因为 expected 已前移而自然被忽略，不会记成多站。
   * 返回是否真的记了一格。
   */
  private markStage(stage: PipelineStage, outcome: PipelineStageOutcome): boolean {
    if (!this.pipeline) return false;
    const expected = nextPipelineStage(this.pipeline.progress);
    if (expected === null || stage !== expected) return false;
    this.pipeline.enter(stage);
    this.pipeline.leave(outcome);
    publishTrace(this.pipeline);
    return true;
  }

  /** 把真实进度事件写进管线上下文；桩 OCR 会接管 ocr 这一站。 */
  private traceProgress(event: ImageTranslationExecutionProgress): void {
    const mapped = pipelineStageFromProgress(event);
    if (mapped === null) return;
    if (mapped.source !== undefined) this.lastSource = mapped.source;
    const recorded = this.markStage(mapped.stage, 'READY');
    // 桩 OCR 只在"ocr 这一站真的被记下"时触发一次，
    // 流水线随后补发的同名进度事件不会让它再计数。
    if (recorded && this.ocrStub && mapped.stage === 'ocr') {
      this.ocrStub.run(this.lastSource);
    }
  }

  start(request: ImageTranslationExecutionRequest): ExecutionTask {
    const core = createTranslatorCore<
      ImageTranslationExecutionRequest,
      undefined,
      ImageTranslationExecutionProgress,
      ImageTranslationExecutionResult
    >(async ({ input }, { signal, reportProgress }) => {
      if (signal.aborted) throw signal.reason;
      const executionTask = this.executionModule.start(input);
      const stopProgress = executionTask.progress((event) => {
        this.traceProgress(event);
        reportProgress(event);
      });
      const cancelExecution = (): void => executionTask.cancel(signal.reason);
      signal.addEventListener('abort', cancelExecution, { once: true });
      if (signal.aborted) cancelExecution();
      try {
        return await executionTask.result;
      } finally {
        signal.removeEventListener('abort', cancelExecution);
        stopProgress();
      }
    });
    const coreTask = core.run({ input: request, config: undefined });
    const task: ExecutionTask = {
      result: coreTask.result.then((result) => {
        if (this.ended) throw toCancellationError(this.deliveryBlockedReason);
        return result;
      }),
      signal: coreTask.signal,
      cancel: (reason) => coreTask.cancel(reason),
      progress: (listener) => {
        if (this.ended) return () => undefined;
        return coreTask.progress((progress) => {
          if (!this.ended) listener(progress);
        });
      },
    };
    this.tasks.add(task);
    void task.result
      .catch(() => undefined)
      .finally(() => this.tasks.delete(task));
    if (this.ended) task.cancel(this.deliveryBlockedReason);
    return task;
  }

  end(reason?: unknown): void {
    this.onEnd(this, reason);
  }

  revoke(reason: unknown = defaultEndReason): void {
    this.blockDelivery(reason);
    this.cancelTasks(reason);
    this.broadcastRevocation(reason);
  }

  blockDelivery(reason: unknown = defaultEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.deliveryBlockedReason = reason;
  }

  cancelTasks(reason: unknown = defaultEndReason): void {
    const tasks = [...this.tasks];
    this.tasks.clear();
    for (const task of tasks) task.cancel(reason);
  }

  broadcastRevocation(reason: unknown = defaultEndReason): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(reason);
  }
}

export type ImageTranslationExecutionArbiterOptions = {
  /** 写入五态上下文；不给则仲裁器自己 new 一个。 */
  pipeline?: PagePipelineContext;
  /**
   * 桩 OCR 工厂：每次 `begin()` 产出一个新桩，
   * 真机验数它这一页的 `callCount` 是不是 1。
   */
  createOcrStub?: () => PipelineOcrStub;
};

class ImageTranslationExecutionArbiterImplementation
implements ImageTranslationExecutionArbiter {
  private readonly activities = new Set<ImageTranslationExecutionActivityImplementation>();
  private readonly pipeline: PagePipelineContext;
  private disposed = false;

  constructor(
    private readonly executionModule: ImageTranslationExecutionModule,
    private readonly options: ImageTranslationExecutionArbiterOptions = {},
  ) {
    this.pipeline = options.pipeline ?? new PagePipelineContext();
  }

  /** 这一条仲裁器记录的五态序列；真机验直接读它。 */
  get trace(): PagePipelineContext {
    return this.pipeline;
  }

  begin(): ImageTranslationExecutionActivity {
    if (this.disposed) throw new Error(disposedReason);
    const activity = new ImageTranslationExecutionActivityImplementation(
      this.executionModule,
      (endedActivity, reason) => this.endActivity(endedActivity, reason),
      this.pipeline,
      this.options.createOcrStub?.(),
    );
    this.activities.add(activity);
    return activity;
  }

  dispose(reason: unknown = disposedReason): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeAll(reason);
    if (this.pipeline.stage !== null) {
      this.pipeline.leave('CANCELLED');
      publishTrace(this.pipeline);
    }
  }

  private endActivity(
    activity: ImageTranslationExecutionActivityImplementation,
    reason?: unknown,
  ): void {
    if (!this.activities.delete(activity)) return;
    activity.revoke(reason);
  }

  private revokeAll(reason: unknown): void {
    const activities = [...this.activities];
    this.activities.clear();
    for (const activity of activities) activity.blockDelivery(reason);
    for (const activity of activities) activity.cancelTasks(reason);
    for (const activity of activities) activity.broadcastRevocation(reason);
  }

}

export function createImageTranslationExecutionArbiter(
  executionModule: ImageTranslationExecutionModule,
  options: ImageTranslationExecutionArbiterOptions = {},
): ImageTranslationExecutionArbiter {
  return new ImageTranslationExecutionArbiterImplementation(executionModule, options);
}
