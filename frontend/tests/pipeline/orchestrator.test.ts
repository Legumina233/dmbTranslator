import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from '../../packages/image-pipeline/src/runtime/platform';
import type { PipelineConfig, PipelineProgress, TextRegion } from '../../packages/image-pipeline/src/types';
import type { ModelRuntime } from '@dmb/model-runtime';
import type { TextTranslator } from '@dmb/text-translation';
import { createImagePipeline } from '../../packages/image-pipeline/src';

const pipelineMocks = vi.hoisted(() => ({
  fileToImage: vi.fn(),
  imageToCanvas: vi.fn(),
  detectTextRegionsWithMask: vi.fn(),
  materializePrecomputedDetection: vi.fn(),
  runOcr: vi.fn(),
  preparePaddleOcrRuntime: vi.fn(),
  warmupPaddleOcrRuntime: vi.fn(),
  runTranslate: vi.fn(),
  runInpaint: vi.fn(),
  drawTypeset: vi.fn(),
  drawRegions: vi.fn(),
  mergeTextLines: vi.fn(),
  refineTextMask: vi.fn(),
  sortRegionsForRender: vi.fn(),
  detectBubbles: vi.fn(),
  matchRegionsToBubbles: vi.fn(),
  getModelSession: vi.fn(),
  browserPlatform: {
    createCanvas: vi.fn(),
    createImage: vi.fn(),
    loadImage: vi.fn(),
    createImageData: vi.fn(),
    registerFont: vi.fn(),
    waitForFonts: vi.fn(),
    encodeCanvasToPng: vi.fn(),
  },
}));

vi.mock('../../packages/image-pipeline/src/pipeline/image', () => ({
  fileToImage: pipelineMocks.fileToImage,
  imageToCanvas: pipelineMocks.imageToCanvas,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/detect', () => ({
  detectTextRegionsWithMask: pipelineMocks.detectTextRegionsWithMask,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/detect/precomputedDetection', () => ({
  materializePrecomputedDetection: pipelineMocks.materializePrecomputedDetection,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/ocr', () => ({
  runOcr: pipelineMocks.runOcr,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/ocr/paddleocrProvider', () => ({
  preparePaddleOcrRuntime: pipelineMocks.preparePaddleOcrRuntime,
  warmupPaddleOcrRuntime: pipelineMocks.warmupPaddleOcrRuntime,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/translate', () => ({
  runTranslate: pipelineMocks.runTranslate,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/inpaint', () => ({
  runInpaint: pipelineMocks.runInpaint,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/typeset', () => ({
  drawTypeset: pipelineMocks.drawTypeset,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/visualize', () => ({
  drawRegions: pipelineMocks.drawRegions,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/textlineMerge', () => ({
  mergeTextLines: pipelineMocks.mergeTextLines,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/maskRefinement', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/image-pipeline/src/pipeline/maskRefinement')>(),
  refineTextMask: pipelineMocks.refineTextMask,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/readingOrder', () => ({
  sortRegionsForRender: pipelineMocks.sortRegionsForRender,
}));
vi.mock('../../packages/image-pipeline/src/pipeline/bubbleDetect', () => ({
  detectBubbles: pipelineMocks.detectBubbles,
  matchRegionsToBubbles: pipelineMocks.matchRegionsToBubbles,
}));
vi.mock('../../packages/model-runtime/src/runtime/modelRegistry', () => ({
  getModelSession: pipelineMocks.getModelSession,
}));

import { PipelineStageError, runPipeline } from '../../packages/image-pipeline/src/pipeline/orchestrator';
import { MaskRefinementImageError } from '../../packages/image-pipeline/src/pipeline/maskRefinement';

function createCanvas(width = 100, height = 200): PipelineCanvas {
  return {
    width,
    height,
    getContext: () => null,
    toDataURL: () => 'data:image/png;base64,test',
    convertToBlob: async () => new Blob(['png'], { type: 'image/png' }),
  };
}

const image: PipelineImage = {
  src: 'fixture.png',
  naturalWidth: 100,
  naturalHeight: 200,
  onload: null,
  onerror: null,
};
const originalCanvas = createCanvas();
const detectionMaskCanvas = createCanvas(25, 50);
const visualizedCanvas = createCanvas();
const refinedMaskCanvas = createCanvas();
const cleanedCanvas = createCanvas();
const typesetCanvas = createCanvas();

const detectedRegion: TextRegion = {
  id: 'region-1',
  box: { x: 10, y: 20, width: 30, height: 80 },
  direction: 'v',
  sourceText: '',
  translatedText: '',
};
const ocrRegion: TextRegion = {
  ...detectedRegion,
  sourceText: 'こんにちは',
};
const translatedRegion: TextRegion = {
  ...ocrRegion,
  translatedText: '你好',
};

const baseConfig: PipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CHS',
  translator: 'llm',
  llmProvider: 'deepseek',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://api.deepseek.com',
  llmModel: 'deepseek-v4-flash',
  typesetDebug: false,
  eraseDebug: false,
  collectDebugLog: false,
  ocrEngine: 'paddleocr_v6_medium',
  ocrPostFilter: 'off',
  processMode: 'translate',
};

const modelRuntime: ModelRuntime = {
  readModel: vi.fn(),
  getSession: pipelineMocks.getModelSession,
  run: vi.fn(),
  runImage: vi.fn(),
  readTextResource: vi.fn(),
  releaseSession: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined),
};

const textTranslator: TextTranslator = {
  translateRegions: pipelineMocks.runTranslate,
};

const runtimeOptions = {
  modelRuntime,
  textTranslator,
  platform: pipelineMocks.browserPlatform as PlatformProvider,
  detectionFallbackStrategy: { kind: 'heuristic-only' } as const,
};

function createFile(): File {
  return new File(['fixture'], 'fixture.png', { type: 'image/png' });
}

function uniqueConsecutiveStages(progress: PipelineProgress[]): string[] {
  return progress
    .map((item) => item.stage)
    .filter((stage, index, stages) => index === 0 || stage !== stages[index - 1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  pipelineMocks.browserPlatform.encodeCanvasToPng.mockResolvedValue(
    new Blob(['platform-png'], { type: 'image/png' }),
  );
  const sessionHandle = { provider: 'wasm' as const };
  pipelineMocks.fileToImage.mockResolvedValue(image);
  pipelineMocks.imageToCanvas.mockReturnValue(originalCanvas);
  pipelineMocks.detectTextRegionsWithMask.mockResolvedValue({
    regions: [detectedRegion],
    rawMaskCanvas: detectionMaskCanvas,
    actualProvider: 'wasm',
  });
  pipelineMocks.materializePrecomputedDetection.mockResolvedValue({
    regions: [detectedRegion],
    rawMaskCanvas: detectionMaskCanvas,
    engine: 'onnx',
  });
  pipelineMocks.runOcr.mockResolvedValue({
    regions: [ocrRegion],
    debug: null,
    actualProvider: 'wasm',
  });
  pipelineMocks.preparePaddleOcrRuntime.mockResolvedValue({
    modelName: 'paddleocr_v6_medium_rec',
    sessionHandle,
  });
  pipelineMocks.warmupPaddleOcrRuntime.mockResolvedValue({
    modelName: 'paddleocr_v6_medium_rec',
    provider: 'wasm',
    inputDims: [1, 3, 48, 320],
    runMs: 1,
  });
  pipelineMocks.runTranslate.mockResolvedValue({
    regions: [translatedRegion],
    translationDebug: { llmFallbackUsed: false },
  });
  pipelineMocks.runInpaint.mockResolvedValue({
    canvas: cleanedCanvas,
    actualProvider: 'wasm',
  });
  pipelineMocks.drawTypeset.mockResolvedValue({
    canvas: typesetCanvas,
    debugLog: null,
  });
  pipelineMocks.drawRegions.mockReturnValue(visualizedCanvas);
  pipelineMocks.mergeTextLines.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.refineTextMask.mockReturnValue({ refinedMaskCanvas });
  pipelineMocks.sortRegionsForRender.mockImplementation((regions: TextRegion[]) => regions);
  pipelineMocks.detectBubbles.mockResolvedValue({ bubbles: [] });
  pipelineMocks.matchRegionsToBubbles.mockReturnValue({
    unmatchedCount: 0,
    unmatchedRegionIds: [],
  });
  pipelineMocks.getModelSession.mockResolvedValue(sessionHandle);
  pipelineMocks.browserPlatform.createCanvas.mockImplementation(createCanvas);
  pipelineMocks.browserPlatform.waitForFonts.mockResolvedValue(undefined);

  const runtimeFlags = globalThis as typeof globalThis & {
    __dmbPaddleOcrRuntimeProbe?: unknown;
    __dmbPaddleOcrRuntimeProbeSchedule?: unknown;
    __dmbInpaintRuntimeProbeSchedule?: unknown;
    __dmbBubbleRuntimeProbeSchedule?: unknown;
  };
  delete runtimeFlags.__dmbPaddleOcrRuntimeProbe;
  delete runtimeFlags.__dmbPaddleOcrRuntimeProbeSchedule;
  delete runtimeFlags.__dmbInpaintRuntimeProbeSchedule;
  delete runtimeFlags.__dmbBubbleRuntimeProbeSchedule;
});

describe('runPipeline', () => {
  it('reuses a precomputed detection instead of invoking the detector again', async () => {
    const precomputedDetection = {
      width: 100,
      height: 200,
      packedMask: new Blob([new Uint8Array(2_500)], { type: 'application/octet-stream' }),
      regions: [detectedRegion],
    };

    await runPipeline(
      createFile(),
      baseConfig,
      () => {},
      { ...runtimeOptions, precomputedDetection },
    );

    expect(pipelineMocks.materializePrecomputedDetection).toHaveBeenCalledWith(
      precomputedDetection,
      image,
      pipelineMocks.browserPlatform,
    );
    expect(pipelineMocks.detectTextRegionsWithMask).not.toHaveBeenCalled();
  });

  it('preserves the full translate-stage order and returns typeset output', async () => {
    const progress: PipelineProgress[] = [];

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      runtimeOptions,
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
      'parallel',
      // 翻译完成时会单独发一条 `translate`（M1 修：在此之前只有 stageTimings、
      // 没有任何 progress 事件，导致五态 trace 的 translation 站永远记不上）。
      // 后面那条 `parallel` 是去字那一侧稍后补报的 —— 两者并行，交叠是事实。
      // 五态映射里 `parallel` 不记站，所以这个交叠不影响 ocr → translation → typeset 的顺序。
      'translate',
      'parallel',
      'typeset',
      'done',
    ]);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'preload_inpaint',
      'merge',
      'order',
      'translate',
      'mask_refine',
      'inpaint',
      'parallel',
      'typeset',
    ]);
    expect(artifacts.detectedRegions).toEqual([translatedRegion]);
    expect(artifacts.resultCanvas).toBe(typesetCanvas);
    expect(pipelineMocks.runTranslate).toHaveBeenCalledOnce();
    expect(pipelineMocks.drawTypeset).toHaveBeenCalledOnce();
  });

  it('starts mask refinement without waiting for the translation to resolve', async () => {
    // 回归护栏：2026-10-09 曾为「只抹有译文的气泡」把 eraseTask 改成 `await translateTask`，
    // 结果 mask_refine + inpaint 的 ~0.9s 从「被翻译掩盖」变成「纯追加」，
    // 进度还会在翻译全程卡在「去字待执行」。这里钉住"去字不等翻译"。
    let releaseTranslate!: () => void;
    const translateGate = new Promise<void>((resolve) => {
      releaseTranslate = resolve;
    });
    let translateSettled = false;
    pipelineMocks.runTranslate.mockImplementation(async () => {
      await translateGate;
      translateSettled = true;
      return { regions: [translatedRegion], translationDebug: { llmFallbackUsed: false } };
    });

    const pipelinePromise = runPipeline(createFile(), baseConfig, () => {}, runtimeOptions);

    await vi.waitFor(() => expect(pipelineMocks.refineTextMask).toHaveBeenCalled());
    // 遮罩已经开算，而译文还没回来 —— 这才是并行。
    expect(translateSettled).toBe(false);
    expect(pipelineMocks.refineTextMask).toHaveBeenCalledTimes(1);

    releaseTranslate();
    await pipelinePromise;
    expect(pipelineMocks.runInpaint).toHaveBeenCalledOnce();
    // 遮罩只算一次（不再有回补步）。
    expect(pipelineMocks.refineTextMask).toHaveBeenCalledTimes(1);
  });

  it('skips translation and typesetting when erase debug is on', async () => {
    // 「原文 / 去字」两个模式已移除；跳过翻译的唯一路径现在是 eraseDebug（去字调试）。
    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, eraseDebug: true },
      () => {},
      runtimeOptions,
    );

    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();
    expect(artifacts.detectedRegions).toEqual([ocrRegion]);
    expect(artifacts.resultCanvas).toBe(cleanedCanvas);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).not.toContain('typeset');
  });

  it('renders the erase debug canvas when mask debug layers are available', async () => {
    // 覆盖 eraseDebug + 有 debugLayers 的分支：结果应是去字调试画布，
    // 既不是去字底图，也不该走排版。
    const debugLayers = {
      refinedMask: new Uint8Array([1]),
      perRegionDilated: new Uint8Array([1]),
      globalDilated: new Uint8Array([1]),
      scaledWidth: 25,
      scaledHeight: 50,
    };
    pipelineMocks.refineTextMask.mockImplementationOnce(() => ({ refinedMaskCanvas, debugLayers }));

    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, eraseDebug: true },
      () => {},
      runtimeOptions,
    );

    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();
    expect(artifacts.resultCanvas).not.toBe(cleanedCanvas);
    expect(artifacts.resultCanvas).not.toBe(typesetCanvas);
  });

  it('stops after order, skips inpaint preload, and preserves independent stage snapshots', async () => {
    const progress: PipelineProgress[] = [];
    const stageRegion: TextRegion = {
      ...ocrRegion,
      box: { ...ocrRegion.box },
    };
    const bubbleMask = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      data: new Uint8Array([1]),
    };
    pipelineMocks.runOcr.mockResolvedValueOnce({
      regions: [stageRegion],
      debug: null,
      actualProvider: 'wasm',
    });
    pipelineMocks.mergeTextLines.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].sourceText = 'merged';
      return regions;
    });
    pipelineMocks.detectBubbles.mockResolvedValueOnce({
      bubbles: [{}],
      actualProvider: 'wasm',
    });
    pipelineMocks.matchRegionsToBubbles.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].bubbleBox = { x: 1, y: 2, width: 3, height: 4 };
      regions[0].bubbleMask = bubbleMask;
      return { unmatchedCount: 0, unmatchedRegionIds: [] };
    });
    pipelineMocks.sortRegionsForRender.mockImplementationOnce((regions: TextRegion[]) => {
      regions[0].fontSize = 42;
      return regions;
    });
    (
      globalThis as typeof globalThis & {
        __dmbInpaintRuntimeProbeSchedule?: 'after-detect';
      }
    ).__dmbInpaintRuntimeProbeSchedule = 'after-detect';

    const artifacts = await runPipeline(
      createFile(),
      { ...baseConfig, eraseDebug: true },
      (item) => progress.push(item),
      { ...runtimeOptions, stopAfter: 'order' },
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
      'done',
    ]);
    expect(artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
    ]);
    expect(artifacts.runtimeStages.map((stage) => stage.model)).not.toContain('inpaint');
    expect(pipelineMocks.getModelSession.mock.calls.some(([model]) => model === 'inpaint')).toBe(false);
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.refineTextMask).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();

    expect(artifacts.stageRegions.detected[0]).toEqual(detectedRegion);
    expect(artifacts.stageRegions.detected[0]).not.toBe(detectedRegion);
    expect(artifacts.stageRegions.ocr[0].sourceText).toBe('こんにちは');
    expect(artifacts.stageRegions.merged[0]).toMatchObject({
      sourceText: 'merged',
    });
    expect(artifacts.stageRegions.merged[0].bubbleBox).toBeUndefined();
    expect(artifacts.stageRegions.merged[0].fontSize).toBeUndefined();
    expect(artifacts.stageRegions.ordered[0].bubbleBox).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    expect(artifacts.stageRegions.ordered[0].fontSize).toBe(42);
    expect(artifacts.stageRegions.merged[0]).not.toBe(artifacts.stageRegions.ordered[0]);
    expect(artifacts.stageRegions.ordered[0].bubbleMask).toBeUndefined();
    artifacts.stageRegions.merged[0].box.x = 999;
    expect(artifacts.stageRegions.ordered[0].box.x).not.toBe(999);
  });

  it('completes a no-text detection with original artifacts and no later stages', async () => {
    const progress: PipelineProgress[] = [];
    const runtimeFlags = globalThis as typeof globalThis & {
      __dmbPaddleOcrRuntimeProbeSchedule?: 'after-detect';
      __dmbInpaintRuntimeProbeSchedule?: 'after-detect';
      __dmbBubbleRuntimeProbeSchedule?: 'after-detect';
    };
    runtimeFlags.__dmbPaddleOcrRuntimeProbeSchedule = 'after-detect';
    runtimeFlags.__dmbInpaintRuntimeProbeSchedule = 'after-detect';
    runtimeFlags.__dmbBubbleRuntimeProbeSchedule = 'after-detect';
    pipelineMocks.detectTextRegionsWithMask.mockResolvedValueOnce({
      regions: [],
      rawMaskCanvas: null,
      engine: 'onnx',
      actualProvider: 'wasm',
    });

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      runtimeOptions,
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'done',
    ]);
    expect(artifacts.stageRegions).toEqual({
      detected: [],
      ocr: [],
      merged: [],
      ordered: [],
    });
    expect(artifacts.cleanedCanvas).toBe(originalCanvas);
    expect(artifacts.resultCanvas).toBe(originalCanvas);
    expect(pipelineMocks.preparePaddleOcrRuntime).not.toHaveBeenCalled();
    expect(pipelineMocks.getModelSession.mock.calls.map(([model]) => model)).toEqual(['detector']);
    expect(pipelineMocks.detectBubbles).not.toHaveBeenCalled();
    expect(pipelineMocks.runOcr).not.toHaveBeenCalled();
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();
  });

  it('publishes a no-text detection as a successful no-translatable-text result', async () => {
    pipelineMocks.detectTextRegionsWithMask.mockResolvedValueOnce({
      regions: [],
      rawMaskCanvas: null,
      engine: 'onnx',
      actualProvider: 'wasm',
    });
    const pipeline = createImagePipeline({
      platform: pipelineMocks.browserPlatform as PlatformProvider,
      modelRuntime,
      detectionFallbackStrategy: { kind: 'heuristic-only' },
    });

    const result = await pipeline.run({
      source: createFile(),
      config: baseConfig,
      workingCopy: { strategy: 'source-native' },
    }, { textTranslator }).result;

    expect(result).toMatchObject({
      status: 'no-translatable-text',
      record: {
        ocr: [],
        translations: [],
      },
    });
    expect(result.image).toBeInstanceOf(Blob);
    expect(await result.image.text()).toBe('platform-png');
    expect(pipelineMocks.browserPlatform.encodeCanvasToPng).toHaveBeenCalledWith(
      originalCanvas,
    );
    await pipeline.dispose();
  });

  it('completes with the original image when OCR rejects every detected region', async () => {
    const progress: PipelineProgress[] = [];
    pipelineMocks.runOcr.mockResolvedValueOnce({
      regions: [],
      debug: null,
      actualProvider: 'webgpu',
    });

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      runtimeOptions,
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'done',
    ]);
    expect(artifacts.stageRegions).toEqual({
      detected: [detectedRegion],
      ocr: [],
      merged: [],
      ordered: [],
    });
    expect(artifacts.detectedRegions).toEqual([]);
    expect(artifacts.cleanedCanvas).toBe(originalCanvas);
    expect(artifacts.resultCanvas).toBe(originalCanvas);
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
    expect(pipelineMocks.drawTypeset).not.toHaveBeenCalled();
  });

  it('publishes an all-rejected OCR result as successful no-translatable-text', async () => {
    pipelineMocks.runOcr.mockResolvedValueOnce({
      regions: [],
      debug: null,
      actualProvider: 'webgpu',
    });
    const pipeline = createImagePipeline({
      platform: pipelineMocks.browserPlatform as PlatformProvider,
      modelRuntime,
      detectionFallbackStrategy: { kind: 'heuristic-only' },
    });

    const result = await pipeline.run({
      source: createFile(),
      config: baseConfig,
      workingCopy: { strategy: 'source-native' },
    }, { textTranslator }).result;

    expect(result).toMatchObject({
      status: 'no-translatable-text',
      record: {
        ocr: [],
        translations: [],
      },
    });
    expect(await result.image.text()).toBe('platform-png');
    expect(pipelineMocks.browserPlatform.encodeCanvasToPng).toHaveBeenCalledWith(
      originalCanvas,
    );
    await pipeline.dispose();
  });

  it('treats punctuation-only OCR as no-translatable-text before mask refinement', async () => {
    const progress: PipelineProgress[] = [];
    pipelineMocks.runOcr.mockResolvedValueOnce({
      regions: [{
        ...ocrRegion,
        sourceText: ' • • • ●',
      }],
      debug: null,
      actualProvider: 'webgpu',
    });

    const artifacts = await runPipeline(
      createFile(),
      baseConfig,
      (item) => progress.push(item),
      runtimeOptions,
    );

    expect(uniqueConsecutiveStages(progress)).toEqual([
      'load',
      'preload',
      'detect',
      'bubble',
      'ocr',
      'merge',
      'order',
      'done',
    ]);
    expect(artifacts.stageRegions.ordered).toEqual([]);
    expect(artifacts.detectedRegions).toEqual([]);
    expect(artifacts.resultCanvas).toBe(originalCanvas);
    expect(pipelineMocks.runTranslate).not.toHaveBeenCalled();
    expect(pipelineMocks.refineTextMask).not.toHaveBeenCalled();
    expect(pipelineMocks.runInpaint).not.toHaveBeenCalled();
  });

  it('classifies an unrefinable image mask as an image-local failure', async () => {
    pipelineMocks.refineTextMask.mockImplementationOnce(() => {
      throw new MaskRefinementImageError(
        'Mask refinement 未分配到有效连通域，已禁用文本框遮罩回退',
      );
    });

    const error = await runPipeline(
      createFile(),
      { ...baseConfig, eraseDebug: true },
      () => {},
      runtimeOptions,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PipelineStageError);
    expect(error).toMatchObject({
      stage: 'mask_refine',
      failure: {
        stage: 'mask_refine',
        scope: 'image',
      },
    });
  });

  it('attaches completed intermediate artifacts to stage errors', async () => {
    pipelineMocks.detectTextRegionsWithMask.mockRejectedValueOnce(new Error('detector unavailable'));

    const error = await runPipeline(createFile(), baseConfig, () => {}, runtimeOptions).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(PipelineStageError);
    const stageError = error as PipelineStageError;
    expect(stageError).toMatchObject({
      name: 'PipelineStageError',
      code: 'PIPELINE_STAGE_FAILED',
      stage: 'detect',
      stageLabel: '文本检测',
      message: '文本检测失败: detector unavailable',
      failure: {
        code: 'PIPELINE_STAGE_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.stage',
        diagnostics: { name: 'PipelineStageError' },
      },
    });
    expect(stageError.cause).toMatchObject({ message: 'detector unavailable' });
    expect(stageError.artifacts).toMatchObject({
      original: image,
      detectedRegions: [],
      detectionCanvas: originalCanvas,
      cleanedCanvas: originalCanvas,
      resultCanvas: originalCanvas,
    });
    expect(stageError.artifacts.stageTimings.map((timing) => timing.stage)).toEqual([
      'load',
      'preload',
    ]);
  });
});
