import {
  dmbBake,
  dmbRender,
  dmbRenderDebug,
  dmbRenderFixtureDebug,
} from '@dmb/image-pipeline/benchmark';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createBenchmarkModelRuntime } from './modelRuntime';

const modelRuntime = createBenchmarkModelRuntime();
import type {
  BakeResult,
  DmbBakeOptions,
  RenderDebugResult,
  RenderFixtureRegion,
  OcrRecognizeOutput,
  PipelineImage,
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  TextRegion,
} from '@dmb/image-pipeline/benchmark';

export type DmbBenchmarkApi = {
  inspectDetectorSession(): Promise<{
    provider: string;
    inputNames: string[];
    outputNames: string[];
  }>;
  bake(dataUrl: string, options?: DmbBakeOptions): Promise<BakeResult>;
  render(dataUrl: string): Promise<string>;
  renderDebug(dataUrl: string): Promise<RenderDebugResult>;
  renderFixtureDebug(
    dataUrl: string,
    regions: RenderFixtureRegion[],
  ): Promise<RenderDebugResult>;
  runPipeline(
    file: File,
    config: PipelineConfig,
    onProgress: (progress: PipelineProgress) => void,
    options?: { signal?: AbortSignal; stopAfter?: 'order' },
  ): Promise<PipelineArtifacts>;
  recognizeOcrRegions(
    image: PipelineImage,
    regions: TextRegion[],
    providerName?: string,
  ): Promise<OcrRecognizeOutput>;
};

export type DmbBenchmarkWindow = typeof window & {
  __dmbBenchmark__?: DmbBenchmarkApi;
};

const benchmarkApi: DmbBenchmarkApi = {
  inspectDetectorSession: async () => {
    const handle = await modelRuntime.getSession('detector');
    return {
      provider: handle.provider,
      inputNames: [...handle.inputNames],
      outputNames: [...handle.outputNames],
    };
  },
  bake: (dataUrl, options) => dmbBake(dataUrl, browserPipelinePlatform, modelRuntime, options),
  render: (dataUrl) => dmbRender(dataUrl, browserPipelinePlatform, modelRuntime),
  renderDebug: (dataUrl) => dmbRenderDebug(dataUrl, browserPipelinePlatform, modelRuntime),
  renderFixtureDebug: (dataUrl, regions) => (
    dmbRenderFixtureDebug(dataUrl, regions, browserPipelinePlatform, modelRuntime)
  ),
  runPipeline: async (file, config, onProgress, options) => {
    const { runPipeline } = await import('@dmb/image-pipeline/benchmark');
    return runPipeline(file, config, onProgress, {
      ...options,
      platform: browserPipelinePlatform,
      modelRuntime,
      detectionFallbackStrategy: { kind: 'heuristic-only' },
    });
  },
  recognizeOcrRegions: async (image, regions, providerName = 'paddleocr_v6_medium') => {
    const { getOcrProvider } = await import('@dmb/image-pipeline/benchmark');
    const provider = getOcrProvider(providerName);
    if (!provider) {
      throw new Error(`OCR 引擎未注册: ${providerName}`);
    }
    return provider.recognize(image, regions, browserPipelinePlatform, modelRuntime);
  },
};

(window as DmbBenchmarkWindow).__dmbBenchmark__ = benchmarkApi;
