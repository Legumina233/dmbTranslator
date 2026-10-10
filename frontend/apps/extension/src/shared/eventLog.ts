/**
 * M0 · 统一事件流 —— 日志体系重构的**唯一新出口**（设计见 `docs/CHANGELOG.md` §二）。
 *
 * ★ 为什么要有它（而不是继续往现有 8 个出口里加）：
 *   现有出口里，排障主力（诊断日志）默认关、整页日志只记终态、DOM dataset 无开关、
 *   服务端三件套各写各的 schema。再加一层聚合只会变成第 9 个出口 —— 所以这里是**收敛的起点**：
 *   所有可排障信息变成 append-only 事件，扩展与服务端写**同一份 schema**。
 *
 * ★ 硬约束（用户口径 2026-10-05：**不影响翻译任务的速度**）：
 *   1. `emit()` 必须是**同步 O(1)**：只往缓冲 push 一个对象；
 *      **不做 `JSON.stringify`、不发网络、不碰存储**（`ts` 也只记毫秒数，序列化延后到 flush/导出）。
 *   2. 落盘/上报**批量异步**：满 `batchSize` 条或 `flushIntervalMs` 触发一次，
 *      `fetch(..., {keepalive:true})` fire-and-forget，**永不 await**。
 *   3. 缓冲有上限，满了丢最旧的并计 `dropped`（**丢事件可以，卡住翻译不行**）。
 *   4. 关闭时整套退化成 **no-op** —— 连那层函数调用都不产生（调用方用三元包一层）。
 *   5. 序列化只发生在 flush / 导出时。
 *
 * 本模块**零 import**（与 M1/M3 的纯逻辑模块同风格）：调度器、时钟、出口全部由外部注入，
 * 因此可以完全离线自检"批量与丢弃"行为。
 */

/** 事件级别。 */
export type DmbEventLevel = 'debug' | 'info' | 'warn' | 'error';

/** 事件来源。跨仓库统一：`extension`（本扩展）/ `server`（本机服务 11436）。 */
export type DmbEventWhere = {
  repo: 'extension' | 'server';
  module: string;
  fn?: string;
};

/** 错误明细。只留可安全外发的信息（stack 由调用方决定是否给，默认不给）。 */
export type DmbEventError = {
  type?: string;
  message: string;
  code?: string;
};

/**
 * 统一事件 schema（v=2）。**扩展与服务端同源** —— 字段定义以本文为准，新增 kind 必须
 * 同步登记到设计文档 §7。读取端忽略未知字段（`v` 只增不减）。
 */
export type DmbEvent = {
  v: 2;
  ts: string;
  seq: number;
  sessionId: string;
  runId?: string;
  pageKey?: string;
  /** ★ 跨进程贯穿 ID：扩展生成，服务端回显，两侧按它对齐（设计 §6）。 */
  requestId?: string;
  level: DmbEventLevel;
  kind: string;
  where?: DmbEventWhere;
  what?: Record<string, unknown>;
  err?: DmbEventError;
  dur_ms?: number;
};

/** `emit` 的入参：`ts/seq/sessionId/v` 由本模块补，`kind` 必填。 */
export type DmbEventInput = Omit<DmbEvent, 'v' | 'ts' | 'seq' | 'sessionId'>;

/** 缓冲内部形态：`ts` 存毫秒，避免 emit 时 `toISOString()` 的分配（约束 1）。 */
type PendingEvent = Omit<DmbEvent, 'ts'> & { tsMs: number };

/** 出口：拿到一批**已序列化**的事件。抛错由本模块吞掉（日志不许影响主流程）。 */
export type EventLogSink = (events: readonly DmbEvent[]) => void;

export type EventLogOptions = {
  sessionId?: string;
  /** 缓冲上限（超出丢最旧）。默认 512。 */
  capacity?: number;
  /** 批量大小。默认 32。 */
  batchSize?: number;
  /** 距首次入队的批量等待窗口（ms）。默认 500。 */
  flushIntervalMs?: number;
  /** 总闸。默认 true（L0 常开）；false 时 `emit` 是 no-op。 */
  enabled?: boolean;
  /** L1 详细层（原文/译文等）。默认 false。 */
  verbose?: boolean;
  sink?: EventLogSink;
  now?: () => number;
  /** 定时器注入（默认 `setTimeout`），便于离线自检。 */
  schedule?: (fn: () => void, ms: number) => void;
};

export type EventLogStats = {
  emitted: number;
  flushed: number;
  dropped: number;
  pending: number;
};

export type EventLog = {
  /** 同步 O(1)。关闭时直接返回。 */
  emit(input: DmbEventInput): void;
  /** 立刻冲刷（批量/定时器之外，例如页面卸载前）。 */
  flush(): void;
  setEnabled(enabled: boolean): void;
  setVerbose(verbose: boolean): void;
  /** 导出用：把缓冲里的事件**序列化**成 schema 形态（唯一允许 stringify 的时刻之一）。 */
  snapshot(): readonly DmbEvent[];
  stats(): EventLogStats;
};

const defaultCapacity = 512;
const defaultBatchSize = 32;
const defaultFlushIntervalMs = 500;

export function createEventLog(options: EventLogOptions = {}): EventLog {
  const capacity = options.capacity ?? defaultCapacity;
  const batchSize = options.batchSize ?? defaultBatchSize;
  const flushIntervalMs = options.flushIntervalMs ?? defaultFlushIntervalMs;
  const sessionId = options.sessionId ?? 's-unknown';
  const sink = options.sink;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule
    ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms); });

  let enabled = options.enabled !== false;
  let verbose = options.verbose === true;
  let seq = 0;
  let timerArmed = false;
  const buffer: PendingEvent[] = [];
  const counts = { emitted: 0, flushed: 0, dropped: 0 };

  function toEvent(pending: PendingEvent): DmbEvent {
    const { tsMs, ...rest } = pending;
    return { ...rest, ts: new Date(tsMs).toISOString() };
  }

  function drain(): void {
    if (!sink || buffer.length === 0) return;
    // 只取一批：剩下的继续排队，下一次定时器/调用带走（约束 2：不阻塞、不无限堆积）。
    const batch = buffer.splice(0, batchSize).map(toEvent);
    counts.flushed += batch.length;
    try {
      sink(batch);
    } catch {
      // 出口抛错绝不影响主流程 —— 日志是旁路。
    }
  }

  function armTimer(): void {
    if (timerArmed) return;
    timerArmed = true;
    try {
      schedule(() => {
        timerArmed = false;
        if (!enabled) return;
        // 一次 timer 只冲一批；还有剩余就再排一次，避免"最后一小批永远不出"。
        drain();
        if (buffer.length > 0) armTimer();
      }, flushIntervalMs);
    } catch {
      timerArmed = false;
    }
  }

  return {
    emit(input): void {
      if (!enabled) return;
      // L1：只有显式打开详细层，才允许携带 `verboseOnly` 标记的事件（原文/译文/字节等）。
      if (input.level === 'debug' && !verbose) return;
      seq += 1;
      counts.emitted += 1;
      if (buffer.length >= capacity) {
        buffer.shift();
        counts.dropped += 1;
      }
      buffer.push({ ...input, v: 2, seq, sessionId, tsMs: now() });
      if (buffer.length >= batchSize) drain();
      else armTimer();
    },

    flush(): void {
      if (!enabled) return;
      drain();
    },

    setEnabled(next): void {
      enabled = next === true;
    },

    setVerbose(next): void {
      verbose = next === true;
    },

    snapshot(): readonly DmbEvent[] {
      return buffer.map(toEvent);
    },

    stats(): EventLogStats {
      return {
        emitted: counts.emitted,
        flushed: counts.flushed,
        dropped: counts.dropped,
        pending: buffer.length,
      };
    },
  };
}

/** 生成 requestId（跨进程贯穿 ID，设计 §6）。短、可读、够随机。 */
export function createRequestId(prefix = 'q'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}
