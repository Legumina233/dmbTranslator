import { describe, expect, it } from 'vitest';
import type { PipelineRecord } from '@dmb/image-pipeline';
import {
  summarizeStages,
  toLines,
  type StageTrailEntry,
} from '../../apps/extension/src/offscreen/pipelineTelemetry';

/**
 * 整页遥测口径（M4 从 `pageLog.test.ts` 迁来）。
 *
 * 整页日志那套独立系统已下线，但这些**口径**是踩过坑才定下来的，必须继续被守住 ——
 * 它们现在直接决定 `page.completed` / `failure` 事件里的 `stages` 与 `dur_ms`。
 */

/** 出错前的三个阶段（最后一条就是出错所在站）。 */
const trail: StageTrailEntry[] = [
  { stage: 'load', label: '加载图片', ms: 120 },
  { stage: 'detect', label: '文本检测', ms: 340 },
  { stage: 'translate', label: '翻译为中文', ms: 1840 },
];

describe('summarizeStages · 失败时照样保留出错之前的阶段', () => {
  it('阶段来自实时轨迹，出错那一站就地标记 failed', () => {
    const result = summarizeStages({ trail, errorStage: 'translate' });

    expect(result.stages).toEqual([
      { stage: 'load', label: '加载图片', ms: 120 },
      { stage: 'detect', label: '文本检测', ms: 340 },
      { stage: 'translate', label: '翻译为中文', ms: 1840, failed: true },
    ]);
    // 这条轨迹里没有 parallel（翻译没跑完就失败了），所以 translate 的耗时照算。
    expect(result.totalMs).toBe(2300);
  });

  it('取消走同一份轨迹口径', () => {
    const result = summarizeStages({ trail, errorStage: 'detect' });

    expect(result.stages.find((stage) => stage.stage === 'detect')?.failed).toBe(true);
  });

  it('errorStage 不在轨迹里就不硬标 —— 不许把错误标到没跑过的站上', () => {
    const result = summarizeStages({ trail, errorStage: 'typeset' });

    expect(result.stages.some((stage) => stage.failed)).toBe(false);
  });

  it('连轨迹都没有时不编造：stages 为空', () => {
    expect(summarizeStages({}).stages).toEqual([]);
  });
});

describe('summarizeStages · 成功时用 pipeline 自己的权威耗时', () => {
  it('summary 的 durationMs 取整成 ms', () => {
    const result = summarizeStages({
      summaryTimings: [{ stage: 'load', label: '加载图片', durationMs: 100.6 }],
    });

    expect(result.stages).toEqual([{ stage: 'load', label: '加载图片', ms: 101 }]);
  });

  it('给了轨迹就以轨迹为准（失败路径显式带轨迹时不回退到 summary）', () => {
    const result = summarizeStages({
      trail,
      summaryTimings: [{ stage: 'load', label: '加载图片', durationMs: 100 }],
    });

    expect(result.stages).toEqual(trail);
  });
});

describe('summarizeStages · 总耗时不吃重复计数', () => {
  it('parallel 在场时，它的子阶段不再重复计入', () => {
    const result = summarizeStages({
      trail: [
        { stage: 'detect', label: '文本检测', ms: 300 },
        { stage: 'translate', label: '翻译为中文', ms: 1700 },
        { stage: 'inpaint', label: '去字', ms: 340 },
        { stage: 'parallel', label: '并行处理(翻译 + 去字)', ms: 1700 },
        { stage: 'typeset', label: '排版和嵌字', ms: 20 },
      ],
    });

    // 300 + 1700(parallel 一次) + 20 —— translate/inpaint 已被 parallel 涵盖。
    expect(result.totalMs).toBe(2020);
  });

  it('失败在 translate 中途（没有 parallel）时，translate 的耗时照算', () => {
    const result = summarizeStages({
      trail: [
        { stage: 'detect', label: '文本检测', ms: 300 },
        { stage: 'translate', label: '翻译为中文', ms: 1700 },
      ],
      errorStage: 'translate',
    });

    expect(result.totalMs).toBe(2000);
  });
});

describe('toLines · 逐行译文以 captured 为准', () => {
  const recordWithEmptyTranslations = {
    translations: [
      { id: 'r0', sourceText: '猫', translatedText: '', order: 0, box: { x: 1, y: 2, width: 3, height: 4 } },
      { id: 'r1', sourceText: '犬', translatedText: '', order: 1, box: { x: 5, y: 6, width: 7, height: 8 } },
    ],
  } as unknown as PipelineRecord;

  it('译文取自 captured，box 按位置从 record 补上', () => {
    const lines = toLines([
      { id: 'r0', jp: '猫', zh: '猫在院子里睡觉', order: 0, direction: 'v' },
      { id: 'r1', jp: '犬', zh: '狗', order: 1 },
    ], recordWithEmptyTranslations);

    expect(lines).toEqual([
      { id: 'r0', jp: '猫', zh: '猫在院子里睡觉', order: 0, direction: 'v', box: { x: 1, y: 2, width: 3, height: 4 } },
      { id: 'r1', jp: '犬', zh: '狗', order: 1, box: { x: 5, y: 6, width: 7, height: 8 } },
    ]);
  });

  /**
   * `record.translations` 取的是 `order` 阶段（translate **之前**）的快照，
   * `translatedText` 恒为空串 —— 拿它当译文会得到一整列空字符串（踩过）。
   * 所以没有 captured 时只能"至少留下原文与位置"，不能假装有译文。
   */
  it('没有 captured 时至少留下原文与位置，不假装有译文', () => {
    const lines = toLines(undefined, recordWithEmptyTranslations);

    expect(lines.map((line) => line.jp)).toEqual(['猫', '犬']);
    expect(lines.every((line) => line.zh === '')).toBe(true);
    expect(lines[0].box).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('从 record.translations 取行时带 order', () => {
    const lines = toLines(undefined, {
      translations: [
        { id: 'r0', sourceText: '猫が庭で寝ている', translatedText: '猫在院子里睡觉', order: 0 },
      ],
    } as unknown as PipelineRecord);

    expect(lines).toEqual([
      { id: 'r0', jp: '猫が庭で寝ている', zh: '猫在院子里睡觉', order: 0 },
    ]);
  });

  it('两样都没有时返回空数组，不抛', () => {
    expect(toLines(undefined, undefined)).toEqual([]);
  });
});
