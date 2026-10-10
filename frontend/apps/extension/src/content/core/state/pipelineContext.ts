/**
 * M1 Step 4 —— 单页翻译管线（PagePipelineContext）的五态状态机。
 *
 * 定位：这里**只放状态机与迁移校验**。它不接执行、不做展示、不持有图片/blob、
 * 不依赖时钟；UI 状态（`PhotoState`）仍由 `photoStateStore` / `photoStateProjection`
 * 单向投影得到，**本模块禁止反向写回**。
 *
 * 为什么不用时间戳：管线各阶段的耗时随站点、网络、模型而变，用定时器或
 * "静默多久"来判定阶段属于哪一步，会在非预设场景下把中间态误判成终态
 * （M0 的 `settled` 就是这么错掉的）。这里只认**显式的阶段推进调用**，
 * 顺序由 `PIPELINE_STAGE_ORDER` 唯一确定，与耗时无关。
 *
 * 顺序即事实：`image → ocr → translation → typeset → render`。
 */

/** 管线的五个阶段，顺序即为真实管线顺序。 */
export const PIPELINE_STAGE_ORDER = [
  'image',
  'ocr',
  'translation',
  'typeset',
  'render',
] as const;

export type PipelineStage = typeof PIPELINE_STAGE_ORDER[number];

/** 每个阶段离开时的终态。 */
export type PipelineStageOutcome = 'READY' | 'FAILED' | 'CANCELLED';

export const PIPELINE_STAGE_OUTCOMES = ['READY', 'FAILED', 'CANCELLED'] as const;

export interface PipelineStageRecord {
  /** 序号，从 1 开始；刻意不用时间戳，避免任何"时间即状态"的语义。 */
  readonly seq: number;
  readonly stage: PipelineStage;
  /** 该阶段是否已离开（进入下一阶段即为 READY，异常离开为 FAILED/CANCELLED）。 */
  readonly outcome: PipelineStageOutcome | null;
}

export type PipelineContextSnapshot = {
  /** 当前正在进行的阶段；`null` 表示尚未开始或已离开全部阶段。 */
  readonly stage: PipelineStage | null;
  /** 已走过的阶段，含最终终态。 */
  readonly history: readonly PipelineStageRecord[];
};

export class PipelineContextError extends Error {
  constructor(
    readonly code: 'stage-out-of-order' | 'stage-already-left' | 'stage-not-entered'
      | 'already-finished',
    message: string,
  ) {
    super(message);
    this.name = 'PipelineContextError';
  }
}

/** 判断某阶段在整条管线里是不是最后一站。 */
export function isTerminalStage(stage: PipelineStage): boolean {
  return stage === PIPELINE_STAGE_ORDER[PIPELINE_STAGE_ORDER.length - 1];
}

/** 某一站的下一站；已是最后一站则返回 `null`。 */
export function nextPipelineStage(stage: PipelineStage | null): PipelineStage | null {
  if (stage === null) return PIPELINE_STAGE_ORDER[0];
  return nextStageOf(stage);
}

/**
 * 判断能不能从 `from` 进入 `to`。
 * `from === null` 只允许进入首个阶段。
 */
export function canEnterStage(from: PipelineStage | null, to: PipelineStage): boolean {
  if (from === null) return to === PIPELINE_STAGE_ORDER[0];
  const fromIndex = PIPELINE_STAGE_ORDER.indexOf(from);
  const toIndex = PIPELINE_STAGE_ORDER.indexOf(to);
  return toIndex === fromIndex + 1;
}

/**
 * 一页图的一次翻译管线上下文。
 *
 * 使用姿势（非法调用会抛 `PipelineContextError`，而不是悄悄改写状态）：
 * ```
 * ctx.enter('image'); ctx.leave();          // image → READY
 * ctx.enter('ocr');   ctx.leave('CANCELLED');
 * ```
 */
export class PagePipelineContext {
  /** 正在进行的阶段；未开始或已写终态时为 `null`。 */
  private current: PipelineStage | null = null;
  private history: PipelineStageRecord[] = [];
  private seq = 0;

  /** 当前正在进行的阶段，未开始/已离开当前阶段均为 `null`。 */
  get stage(): PipelineStage | null {
    return this.current;
  }

  /**
   * 管线推进到哪个阶段了（最后一个已进入的阶段），与"是否正在跑"无关。
   * 这是 `leave()` 之后仍能继续往后走的关键：只有 `current` 的话，位置信息
   * 会在写终态时被一起丢掉，后继阶段就再也进不去了。
   */
  get progress(): PipelineStage | null {
    return this.history[this.history.length - 1]?.stage ?? null;
  }

  /** 已走过的阶段（副本，防止外部改历史）。 */
  get record(): readonly PipelineStageRecord[] {
    return [...this.history];
  }

  /**
   * 进入一个阶段。必须是推进位置的**直接后继**：
   * 已在跑别的阶段时要求 `current` 的后继，没在跑时要求 `progress` 的后继。
   * 已离开的阶段不允许重入，也不允许跳级。
   */
  enter(stage: PipelineStage): PipelineStageRecord {
    const expected = this.current !== null
      ? nextStageOf(this.current)
      : this.progress === null
        ? PIPELINE_STAGE_ORDER[0]
        : nextStageOf(this.progress);

    if (stage !== expected) {
      const detail = this.current !== null
        ? `当前进行中的阶段是 ${this.current}`
        : this.progress === null
          ? '管线尚未开始'
          : `管线已推进到 ${this.progress}`;
      throw new PipelineContextError(
        'stage-out-of-order',
        `${detail}，非法进入 ${stage}（期望进入 ${expected}）`,
      );
    }

    if (this.current === null) {
      this.current = stage;
      this.seq += 1;
      this.history.push({ seq: this.seq, stage, outcome: null });
    }
    return this.history[this.history.length - 1];
  }

  /**
   * 给当前进行中的阶段一个终态。终态一旦写入，本阶段即离开（`stage` 回到 `null`），
   * 后面必须 `reset()` 才能重开一条管线。
   */
  leave(outcome: PipelineStageOutcome = 'READY'): PipelineStageRecord {
    const last = this.history[this.history.length - 1];
    // 先判"这一站已经写过终态"：否则一个刚 leave 过的上下文再调 leave，
    // 只会落到"没有进行中阶段"，把 stage-already-left 这条信息吞掉。
    if (last !== undefined && last.outcome !== null) {
      throw new PipelineContextError(
        'stage-already-left',
        `阶段 ${last.stage} 已经带终态 ${last.outcome}，不能重复写终态`,
      );
    }
    if (this.current === null) {
      throw new PipelineContextError(
        'stage-not-entered',
        '管线当前没有进行中的阶段，不能写终态',
      );
    }
    const record: PipelineStageRecord = { ...last, outcome };
    this.history[this.history.length - 1] = record;
    this.current = null;
    return record;
  }

  /** 开一条新管线：清空历史，回到"未开始"。 */
  reset(): void {
    this.current = null;
    this.history = [];
    this.seq = 0;
  }

  /** 拍一份只读快照，给探针/UI/日志消费。 */
  snapshot(): PipelineContextSnapshot {
    return { stage: this.current, history: [...this.history] };
  }
}

function nextStageOf(stage: PipelineStage): PipelineStage | null {
  const index = PIPELINE_STAGE_ORDER.indexOf(stage);
  if (index < 0 || index === PIPELINE_STAGE_ORDER.length - 1) return null;
  return PIPELINE_STAGE_ORDER[index + 1];
}
