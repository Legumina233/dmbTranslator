import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ImageTranslationExecutionModule,
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionRequest,
  ImageTranslationExecutionResult,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import {
  createImageTranslationExecutionArbiter,
  PipelineOcrStub,
  pipelineStageFromProgress,
  type ImageTranslationExecutionActivity,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import {
  PagePipelineContext,
  PIPELINE_STAGE_ORDER,
} from '../../../apps/extension/src/content/core/state/pipelineContext';

const source = {
  file: new File(['source'], 'source.png', { type: 'image/png' }),
  blob: new Blob(['source'], { type: 'image/png' }),
};

const request: ImageTranslationExecutionRequest = { source: { kind: 'prepared-file', file: source.file } };

/**
 * 真机流水线的进度序列（packages/image-pipeline 实测 stage 名）：
 * preparing/prepare-execution → preparing/acquire-source → preparing/source-ready
 * → executing(local-pipeline) runtime-prepare, detect, ocr, translate, typeset, parallel, finalize
 * 每个 progress 事件都多报一次，用来验证重复事件不会被记成多站。
 */
function realOrderProgressEvents(): ImageTranslationExecutionProgress[] {
  return [
    { phase: 'preparing', operation: 'prepare-execution' },
    { phase: 'preparing', operation: 'acquire-source' },
    { phase: 'preparing', operation: 'source-ready', source },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'runtime-prepare', operation: 'boot' } } },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'detect', operation: 'detect' } } },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'ocr', operation: 'recognize' } } },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'ocr', operation: 'recognize', completed: 1, total: 4 } } },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'translate', operation: 'translate-batch' } } },
    { phase: 'executing', execution: { kind: 'local-pipeline', progress: { stage: 'typeset', operation: 'typeset' } } },
    { phase: 'finalizing', operation: 'collect-artifacts' },
  ];
}

function reportingExecutionModule(
  events: readonly ImageTranslationExecutionProgress[],
): {
  module: ImageTranslationExecutionModule;
  report(progress: ImageTranslationExecutionProgress): void;
} {
  const listeners = new Set<(progress: ImageTranslationExecutionProgress) => void>();
  return {
    module: {
      start() {
        return {
          result: new Promise<ImageTranslationExecutionResult>(() => undefined),
          signal: new AbortController().signal,
          cancel: () => undefined,
          progress(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      },
    },
    report(progress) {
      for (const listener of listeners) listener(progress);
    },
  };
  void events;
}

describe('pipelineStageFromProgress 映射', () => {
  it('只认真机能对上的边界事件', () => {
    expect(pipelineStageFromProgress({ phase: 'preparing', operation: 'prepare-execution' })).toBeNull();
    expect(pipelineStageFromProgress({ phase: 'preparing', operation: 'acquire-source' })?.stage).toBe('image');
    expect(
      pipelineStageFromProgress({ phase: 'preparing', operation: 'source-ready', source })?.stage,
    ).toBe('image');
    expect(
      pipelineStageFromProgress({
        phase: 'executing',
        execution: { kind: 'local-pipeline', progress: { stage: 'ocr', operation: 'x' } },
      })?.stage,
    ).toBe('ocr');
    expect(
      pipelineStageFromProgress({
        phase: 'executing',
        execution: { kind: 'local-pipeline', progress: { stage: 'translate', operation: 'x' } },
      })?.stage,
    ).toBe('translation');
    expect(
      pipelineStageFromProgress({
        phase: 'executing',
        execution: { kind: 'local-pipeline', progress: { stage: 'typeset', operation: 'x' } },
      })?.stage,
    ).toBe('typeset');
    expect(pipelineStageFromProgress({ phase: 'finalizing', operation: 'collect-artifacts' })?.stage).toBe('render');
  });
});

/** 执行任务的 progress 订阅是异步挂上的，发事件前先让微任务跑完。 */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

type StartableActivity = ImageTranslationExecutionActivity & {
  start(request: ImageTranslationExecutionRequest): { result: Promise<unknown> };
};

async function startAndReport(
  arbiter: ReturnType<typeof createImageTranslationExecutionArbiter>,
  report: (progress: ImageTranslationExecutionProgress) => void,
  events: readonly ImageTranslationExecutionProgress[],
): Promise<void> {
  const activity = arbiter.begin() as StartableActivity;
  void activity.start(request).result.catch(() => undefined);
  await flush();
  for (const event of events) report(event);
}

describe('trace 通过 DOM 属性下沉给探针', () => {
  it('每记一格就刷新 data-m1-trace，探针读得到完整五态', async () => {
    const attributes = new Map<string, string>();
    const original = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    };
    try {
      const pipeline = new PagePipelineContext();
      const { module, report } = reportingExecutionModule(realOrderProgressEvents());
      const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
      await startAndReport(arbiter, report, realOrderProgressEvents());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = attributes.get('data-m1-trace');
      expect(raw).toBeTruthy();
      expect((JSON.parse(raw as string) as { history: { stage: string }[] }).history
        .map((entry) => entry.stage)).toEqual([...PIPELINE_STAGE_ORDER]);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });

  it('pinning 到 document 不存在时不炸（worker / 测试环境）', async () => {
    const original = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      const pipeline = new PagePipelineContext();
      const { module, report } = reportingExecutionModule(realOrderProgressEvents());
      const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
      await startAndReport(arbiter, report, realOrderProgressEvents());
      expect(pipeline.snapshot().history).toHaveLength(5);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });
});

describe('仲裁器把五态写进 PipelineContext', () => {
  it('真机顺序跑出 image → ocr → translation → typeset → render', async () => {
    const pipeline = new PagePipelineContext();
    const { module, report } = reportingExecutionModule(realOrderProgressEvents());
    const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
    await startAndReport(arbiter, report, realOrderProgressEvents());

    expect(pipeline.snapshot().history.map((entry) => entry.stage)).toEqual([
      'image',
      'ocr',
      'translation',
      'typeset',
      'render',
    ]);
    expect(pipeline.snapshot().history.map((entry) => entry.outcome)).toEqual([
      'READY',
      'READY',
      'READY',
      'READY',
      'READY',
    ]);
  });

  it('五个阶段都写完，不早不晚', async () => {
    const pipeline = new PagePipelineContext();
    const { module, report } = reportingExecutionModule(realOrderProgressEvents());
    const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
    await startAndReport(arbiter, report, realOrderProgressEvents());

    expect(pipeline.snapshot().history.map((entry) => entry.stage)).toEqual([...PIPELINE_STAGE_ORDER]);
  });

  it('桩 OCR 每页恰好触发一次', async () => {
    const stub = new PipelineOcrStub();
    const { module, report } = reportingExecutionModule(realOrderProgressEvents());
    const arbiter = createImageTranslationExecutionArbiter(module, {
      createOcrStub: () => stub,
    });
    await startAndReport(arbiter, report, realOrderProgressEvents());

    expect(stub.callCount).toBe(1);
  });

  it('顺序对不上时停在缺的那一站（这就是 Step 5 的停止信号）', async () => {
    const pipeline = new PagePipelineContext();
    const { module, report } = reportingExecutionModule([]);
    const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
    const activity = arbiter.begin() as StartableActivity;
    void activity.start(request).result.catch(() => undefined);
    await flush();

    // 真实流水线的 typeset 早于 translate 到达：trace 只能记到 image
    report({ phase: 'preparing', operation: 'acquire-source' });
    report({ phase: 'preparing', operation: 'source-ready', source });
    report({
      phase: 'executing',
      execution: { kind: 'local-pipeline', progress: { stage: 'typeset', operation: 'typeset' } },
    });

    expect(pipeline.snapshot().history.map((entry) => entry.stage)).toEqual(['image']);
  });

  it('仲裁器没给 pipeline 时也能正常工作（向后兼容）', async () => {
    const { module, report } = reportingExecutionModule(realOrderProgressEvents());
    const arbiter = createImageTranslationExecutionArbiter(module);
    const activity = arbiter.begin() as StartableActivity;
    void activity.start(request).result.catch(() => undefined);
    await flush();
    expect(() => {
      for (const event of realOrderProgressEvents()) report(event);
    }).not.toThrow();
  });
});

/**
 * M1 五态契约：映射「消费」的 stage 名，必须真有「发射」点。
 *
 * 为什么要有这组：五态映射（pipelineStageFromProgress）建立在一个前提上 ——
 * "管线会发 `stage:'translate'` 这样的边界事件"。2026-10-02 在真机上才发现
 * 这个前提是错的：orchestrator 的翻译完成点**一个 progress 事件都没发**，
 * 而 runOperation 那条 `stage:'translate'` 只在**失败重试**分支里才发。
 * 于是 translation 这一站健康路径上永远记不上，trace 会退化成
 * `image→ocr→typeset→render` 的跳站。
 *
 * 前面那组用例没拦住它，是因为它们的进度序列是**手写的**
 * （`realOrderProgressEvents()` 直接写了 translate）—— 拿"假设的协议"造数据，
 * 自然证明不了"协议与实现一致"。这里改成**从实现里读**发射点，再跟消费点对账。
 */
describe('M1 五态契约：映射消费的 stage 名必须有真实发射点', () => {
  const ORCHESTRATOR = resolve(
    __dirname,
    '../../../packages/image-pipeline/src/pipeline/orchestrator.ts',
  );
  const ARBITER = resolve(
    __dirname,
    '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter.ts',
  );

  /** 管线真实会发的 stage 名，**按源码出现顺序**（= 执行顺序）。 */
  function emittedStages(): string[] {
    return [
      ...readFileSync(ORCHESTRATOR, 'utf8').matchAll(/report\(onProgress,\s*"([a-z_]+)"/g),
    ].map((match) => match[1]);
  }

  /** 五态映射愿意消费的「执行链 stage 名」——直接从 switch 的 case 里读。 */
  function consumedStages(): string[] {
    const source = readFileSync(ARBITER, 'utf8');
    // 仓库里这两个文件是 CRLF 的：找函数结尾必须容忍 \r?\n，写死 \n 会找不到。
    const body = /export function pipelineStageFromProgress[\s\S]*?\r?\n\}/.exec(source)?.[0] ?? '';
    expect(body.length).toBeGreaterThan(0);
    return [...body.matchAll(/case '([a-z_]+)':/g)].map((match) => match[1]);
  }

  it('每个被消费的 stage 名都能在管线里找到发射点', () => {
    const emitted = new Set(emittedStages());
    const consumed = consumedStages();
    expect(consumed.length).toBeGreaterThan(0);
    for (const stage of consumed) {
      expect(
        emitted.has(stage),
        `五态映射消费了 "${stage}"，但管线从没发过这个 stage 名 —— trace 会跳站`,
      ).toBe(true);
    }
  });

  it('真实发射顺序过滤出被消费的名字后，正好是五态中间三站的顺序', () => {
    const consumed = new Set(consumedStages());
    expect(emittedStages().filter((stage) => consumed.has(stage))).toEqual([
      'ocr',
      'translate',
      'typeset',
    ]);
  });

  it('拿真实发射顺序当事件流跑一遍，trace 得到完整五态', async () => {
    const events: ImageTranslationExecutionProgress[] = [
      { phase: 'preparing', operation: 'acquire-source' },
      ...emittedStages().map((stage): ImageTranslationExecutionProgress => ({
        phase: 'executing',
        execution: { kind: 'local-pipeline', progress: { stage, operation: stage } },
      })),
      { phase: 'finalizing', operation: 'collect-artifacts' },
    ];
    const pipeline = new PagePipelineContext();
    const { module, report } = reportingExecutionModule(events);
    const arbiter = createImageTranslationExecutionArbiter(module, { pipeline });
    await startAndReport(arbiter, report, events);
    expect(pipeline.snapshot().history.map((entry) => entry.stage)).toEqual([
      ...PIPELINE_STAGE_ORDER,
    ]);
  });
});
