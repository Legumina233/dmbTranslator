/**
 * 整页遥测的口径与形状（M4 从 `pageLog.ts` 迁来）。
 *
 * ★ 为什么这个文件存在：
 *   整页日志（独立系统 + `POST /log/page`）已于 M4 下线，改由事件流里的
 *   `page.completed` 承担。但**那套记录口径不能跟着一起丢** —— 尤其是这几条，
 *   都是踩过坑才定下来的：
 *
 *   * `total_ms` **只在 `parallel` 在场时**跳过它的子阶段（否则 Translate 被算两遍，
 *     记录写 5.1s、实际只有 3.0s，虚高 70%）；
 *   * 失败/取消时阶段只认**实时轨迹**（pipeline 抛异常后 orchestrator 的局部
 *     stageTimings 就没了，"出错之前的阶段"只能靠轨迹还原）；
 *   * `errorStage` **命中轨迹才**就地标 `failed`，不硬标（不许把错误标到没跑过的站上）；
 *   * 逐行译文的权威来源是调用方从翻译器返回值里摘的 `captured` ——
 *     `PipelineRecord.translations` 取的是 `order` 阶段（translate **之前**）的快照，
 *     它的 `translatedText` 恒为空串，拿它当译文会得到一整列空字符串（踩过）。
 *
 *   所以这里保留口径（纯函数）与形状（类型），只去掉"发 HTTP"那一层。
 */

import type { PipelineRecord } from '@dmb/image-pipeline';

/**
 * 只声明**本模块真正读到的字段**（结构性类型），不去动 image-pipeline 的导出面 ——
 * StageTiming 目前没有对外导出，为了记日志把它加进公共导出不值得。
 */
type StageTimingLike = { stage: string; label: string; durationMs: number };

/**
 * 服务端自报耗时（来自 `X-DMB-Timing` 响应头）。
 * `requestId` = 服务端为这次 `/ocr` 生成的贯穿 ID（M1）—— 扩展侧记下它，
 * 就能和 `logs/events/*.events.jsonl` 里服务端自己那条 `ocr.call` 事件按 ID 对齐。
 */
export type ServerOcrTiming = {
  total_ms?: number;
  infer_ms?: number;
  lines?: number;
  requestId?: string;
};

/** 服务端自报耗时（来自响应体 `dmb_timing`）。`requestId` 同上，对应 `llm.call` 事件。 */
export type ServerLlmTiming = {
  total_ms?: number;
  unload_other_ms?: number;
  stages?: Record<string, unknown>;
  requestId?: string;
};

/** 一条阶段轨迹：阶段名 + 中文标签 + 该阶段耗时。 */
export type StageTrailEntry = { stage: string; label: string; ms: number };
export type StageTelemetry = StageTrailEntry & { failed?: boolean };

/** 一行：原文 + 译文（+ 排序与书写方向）。box 由 `record` 按位置补。 */
export type PageLogLine = {
  id: string;
  jp: string;
  zh: string;
  order: number;
  direction?: string;
};

/**
 * `parallel` 是**容器阶段**：它的耗时就是 `Promise.all([翻译, 去字])` 的墙钟时间，
 * 里面已经含了下面这几个子阶段的耗时。求总耗时时必须把它们排除，
 * 否则 Translate 会被算两遍（记录写 5.1s、实际只有 3.0s，虚高 70%）。
 */
const PARALLEL_CHILD_STAGES = new Set(['translate', 'mask_refine', 'inpaint']);

/**
 * 逐行结果（L1 详细层用）。
 *
 * **译文的权威来源是 `captured`**（调用方从翻译器返回值里摘的）：`record` 只补 box ——
 * 两者顺序一致（都源自同一个 ordered 数组），按位置对齐即可。
 */
export function toLines(
  captured: PageLogLine[] | undefined,
  record: PipelineRecord | undefined,
): Array<Record<string, unknown>> {
  const fromRecord = record?.translations ?? [];
  if (captured?.length) {
    return captured.map((line, index) => {
      const box = fromRecord[index]?.box;
      return {
        id: line.id,
        jp: line.jp,
        zh: line.zh,
        order: line.order,
        ...(line.direction ? { direction: line.direction } : {}),
        ...(box ? { box } : {}),
      };
    });
  }
  // 没摘到译文（例如翻译被跳过/失败）时退回 record：至少留下原文与位置。
  return fromRecord.map((region) => ({
    id: region.id,
    jp: region.sourceText,
    zh: region.translatedText,
    order: region.order,
    ...(region.direction ? { direction: region.direction } : {}),
    ...(region.box ? { box: region.box } : {}),
  }));
}

/**
 * 阶段口径的唯一实现（`page.completed` 与 `failure` 共用）。
 *
 * 阶段来源分两路（不是二选一，是各自覆盖各自的事实）：
 *  - 成功：`summaryTimings` —— pipeline 自己算的权威 durationMs；
 *  - 失败/取消：`trail` —— 出错前的实时轨迹，最后一条就是出错所在阶段。
 *
 * 返回的 `totalMs` 已经处理好 `parallel` 容器的重复计数（见 `PARALLEL_CHILD_STAGES`）。
 */
export function summarizeStages(input: {
  summaryTimings?: StageTimingLike[];
  trail?: StageTrailEntry[];
  /** 失败/取消所在阶段。命中轨迹才就地标 `failed`。 */
  errorStage?: string;
}): { stages: StageTelemetry[]; totalMs: number } {
  const fromSummary: StageTelemetry[] = (input.summaryTimings ?? [])
    .map((t) => ({ stage: t.stage, label: t.label, ms: Math.round(t.durationMs) }));
  // 契约：**给了 `trail` 就以 `trail` 为准**（失败/取消路径显式带它，不能回退到 summary）。
  // 因此"成功路径要用权威 summary"这件事必须由**调用方**保证 —— 成功时不要传 `trail`。
  // （2026-10-06：`pipelineHost` 的成功分支原先两条都传，导致 summary 被丢弃、
  //   `parallel` 的三个子阶段 translate / mask_refine / inpaint 从不出现，已在那里修正。）
  const base: StageTelemetry[] = input.trail?.length ? input.trail : fromSummary;
  // 只在真的是"出错在哪一站"时才标记：轨迹里没有这一站就不硬标。
  const stages: StageTelemetry[] = input.errorStage && base.some((s) => s.stage === input.errorStage)
    ? base.map((s) => (s.stage === input.errorStage ? { ...s, failed: true } : s))
    : base;
  const hasParallel = stages.some((s) => s.stage === 'parallel');
  const totalMs = stages
    .filter((s) => !(hasParallel && PARALLEL_CHILD_STAGES.has(s.stage)))
    .reduce((sum, s) => sum + s.ms, 0);
  return { stages, totalMs };
}
