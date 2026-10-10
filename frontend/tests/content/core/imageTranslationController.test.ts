import { describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '@dmb/image-pipeline';
import type { LocalPipelineResult } from '@dmb/image-pipeline/protocol';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import type {
  ImageTarget,
  ImageTranslationContextResolution,
} from '../../../apps/extension/src/content/core/types';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  createImageTranslationExecutionModule,
  type ImageTranslationExecutionDependencies,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import {
  ImageTranslationController,
} from '../../../apps/extension/src/content/core/translation/imageTranslationController';
import type { ProgressJankMonitor } from '../../../apps/extension/src/content/core/progressJank';
import { prepareExecutionFromSettings } from './executionPreparation';

function localResult(translationDebug: LocalPipelineResult['summary']['translationDebug'] = null): LocalPipelineResult {
  return {
    status: 'completed',
    result: new Blob(['translated'], { type: 'image/png' }),
    summary: {
      image: { width: 100, height: 200 },
      detectedRegionCount: 1,
      stageTimings: [],
      runtimeStages: [],
      translationDebug,
      ocrDebug: null,
      ocrPostFilterDebug: null,
      typesetDebug: null,
    },
    record: {
      schemaVersion: 2,
      workingCopy: {
        width: 100,
        height: 200,
        spec: { strategy: 'source-native' },
        sourceToWorkingCopy: { kind: 'identity' },
      },
      ocr: [],
      translations: [],
    },
  };
}

function createHarness(options: {
  resolveTranslationContext?: (target: ImageTarget) => ImageTranslationContextResolution;
  resolveTarget?: (key: string) => ImageTarget | undefined;
  dependencies?: ImageTranslationExecutionDependencies;
} = {}) {
  const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
  const sourceBlob = new Blob(['source'], { type: 'image/png' });
  const downloadImage = vi.fn(async () => ({
    file: new File([sourceBlob], 'source.png', { type: sourceBlob.type }),
    blob: sourceBlob,
  }));
  const runLocalPipeline = vi.fn(async () => localResult());
  const executionModule = createImageTranslationExecutionModule({
    prepareExecution: prepareExecutionFromSettings(),
    downloadImage,
    runLocalPipeline,
    ...options.dependencies,
  });
  const executionArbiter = createImageTranslationExecutionArbiter(executionModule);
  const applyImage = vi.fn();
  const render = vi.fn();
  const target: ImageTarget = {
    element: {} as HTMLImageElement,
    key: 'image-1',
    originalUrl: 'https://example.com/image.jpg',
  };
  const monitor = {
    measureUiRender(callback: () => void) {
      callback();
    },
    setStage() {},
  } as unknown as ProgressJankMonitor;
  const controller = new ImageTranslationController(
    store,
    executionArbiter,
    {
      resolveTarget: options.resolveTarget ?? (() => target),
      resolveTranslationContext: options.resolveTranslationContext,
      applyImage,
      render,
    },
    {
      createJankMonitor: () => monitor,
      finishJankMonitor: vi.fn(),
    },
  );
  return {
    store,
    executionModule,
    executionArbiter,
    downloadImage,
    runLocalPipeline,
    applyImage,
    render,
    controller,
    target,
  };
}

describe('ImageTranslationController', () => {
  it('运行中再点一下 = 终止当前翻译（不再开新任务，也不凭空重渲染）', async () => {
    const harness = createHarness();
    harness.store.ensure(harness.target.key, harness.target.originalUrl).status = 'running';
    const start = vi.spyOn(harness.executionModule, 'start');
    const cancel = vi.spyOn(harness.controller, 'cancel');

    await harness.controller.handleTranslateClick(harness.target);

    expect(start).not.toHaveBeenCalled();
    // 终止走既有取消通道；重渲染由取消投影的 notify() 负责（此处状态仍是 running，
    // 主动 render 只会再画一次"终止翻译"，所以刻意不 render）。
    expect(cancel).toHaveBeenCalledWith(harness.target.key, '用户点了终止翻译');
    expect(harness.render).not.toHaveBeenCalled();
  });

  it('toggles an existing translation without starting another task', async () => {
    const harness = createHarness();
    const state = harness.store.ensure(harness.target.key, harness.target.originalUrl);
    state.translatedUrl = 'blob:translated';
    state.status = 'translated';
    const start = vi.spyOn(harness.executionModule, 'start');

    await harness.controller.handleTranslateClick(harness.target);

    expect(state).toMatchObject({ status: 'showingOriginal' });
    expect(start).not.toHaveBeenCalled();
    expect(harness.applyImage).toHaveBeenCalledWith(harness.target, state);
  });

  it('projects a settings failure into an actionable error state', async () => {
    const harness = createHarness({
      dependencies: {
        prepareExecution: async () => {
          throw new Error('provider failed');
        },
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'error',
      errorText: 'provider failed',
      stageText: '',
    });
    expect(harness.render).toHaveBeenCalled();
  });

  it('captures tweet context synchronously when the click starts', async () => {
    const resolveTranslationContext = vi.fn(() => ({ status: 'empty' as const }));
    let rejectSettings!: (reason: Error) => void;
    const harness = createHarness({
      resolveTranslationContext,
      dependencies: {
        prepareExecution: () => new Promise((_resolve, reject) => {
          rejectSettings = reject;
        }),
      },
    });

    const click = harness.controller.handleTranslateClick(harness.target);

    expect(resolveTranslationContext).toHaveBeenCalledWith(harness.target);
    await vi.waitFor(() => expect(rejectSettings).toBeTypeOf('function'));
    rejectSettings(new Error('stop after capture'));
    await click;
  });

  it('starts a remote-image task with the element referrer policy', async () => {
    const harness = createHarness();
    harness.target.element = { referrerPolicy: 'origin' } as HTMLImageElement;

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.downloadImage).toHaveBeenCalledWith(
      {
        kind: 'remote-image',
        url: harness.target.originalUrl,
        referrerPolicy: 'origin',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.store.get(harness.target.key)?.status).toBe('translated');
    expect(harness.applyImage).toHaveBeenCalledOnce();
  });

  it('cancels its active task when the execution owner is disposed', async () => {
    let pipelineSignal: AbortSignal | undefined;
    const harness = createHarness({
      dependencies: {
        runLocalPipeline: (_file, _config, _onProgress, options) => {
          pipelineSignal = options?.signal;
          return new Promise(() => undefined);
        },
      },
    });
    const click = harness.controller.handleTranslateClick(harness.target);
    await vi.waitFor(() => expect(pipelineSignal).toBeDefined());

    harness.controller.dispose();
    await click;

    expect(pipelineSignal?.aborted).toBe(true);
    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'idle',
      errorText: '',
    });
  });

  it('keeps running when another explicit owner starts', async () => {
    let pipelineSignal: AbortSignal | undefined;
    let completePipeline!: (value: ReturnType<typeof localResult>) => void;
    const harness = createHarness({
      dependencies: {
        runLocalPipeline: (_file, _config, _onProgress, options) => {
          pipelineSignal = options?.signal;
          return new Promise((resolve) => {
            completePipeline = resolve;
          });
        },
      },
    });
    const click = harness.controller.handleTranslateClick(harness.target);
    await vi.waitFor(() => expect(pipelineSignal).toBeDefined());

    const replacement = harness.executionArbiter.begin();
    expect(pipelineSignal?.aborted).toBe(false);

    completePipeline(localResult());
    await click;

    expect(pipelineSignal?.aborted).toBe(false);
    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'translated',
      errorText: '',
    });
    replacement.end();
  });

  it('passes captured tweet context into the local LLM pipeline', async () => {
    const context = {
      source: 'x_tweet' as const,
      currentTweetText: '当前推文正文',
      quotedTweetText: '引用推文正文',
    };
    let receivedConfig: PipelineConfig | undefined;
    const harness = createHarness({
      resolveTranslationContext: () => ({ status: 'available', context }),
      dependencies: {
        prepareExecution: prepareExecutionFromSettings({
          ...defaultExtensionSettings,
          translator: 'llm',
          llmProfiles: {
            ...defaultExtensionSettings.llmProfiles,
            deepseek: {
              ...defaultExtensionSettings.llmProfiles.deepseek,
              apiKey: 'sk-test',
            },
          },
        }),
        runLocalPipeline: async (_file, config) => {
          receivedConfig = config;
          return localResult({ llmBatchRequestedRegionCount: 1 });
        },
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(receivedConfig).toMatchObject({ translationContext: context });
  });

  it.each([
    {
      name: 'missing tweet context',
      contextResolution: { status: 'unavailable' } as const,
      translationDebug: { llmBatchRequestedRegionCount: 1 },
      expectedNotice: '未找到推文作为上下文',
    },
    {
      name: 'tweet context length fallback',
      contextResolution: {
        status: 'available',
        context: { source: 'x_tweet', currentTweetText: '当前推文正文' },
      } as const,
      translationDebug: {
        llmBatchRequestedRegionCount: 1,
        tweetContextLengthFallback: true,
      },
      expectedNotice: '推文上下文过长，已改为无上下文翻译',
    },
    {
      name: 'tweet DOM extraction failure',
      contextResolution: new Error('tweet DOM changed'),
      translationDebug: { llmBatchRequestedRegionCount: 1 },
      expectedNotice: '未找到推文作为上下文',
    },
  ])('stores a non-blocking notice after successful LLM translation with $name', async ({
    contextResolution,
    translationDebug,
    expectedNotice,
  }) => {
    const harness = createHarness({
      resolveTranslationContext: () => {
        if (contextResolution instanceof Error) throw contextResolution;
        return contextResolution;
      },
      dependencies: {
        prepareExecution: prepareExecutionFromSettings({
          ...defaultExtensionSettings,
          translator: 'llm',
          llmProfiles: {
            ...defaultExtensionSettings.llmProfiles,
            deepseek: {
              ...defaultExtensionSettings.llmProfiles.deepseek,
              apiKey: 'sk-test',
            },
          },
        }),
        runLocalPipeline: async () => localResult(translationDebug),
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'translated',
      contextNoticeText: expectedNotice,
    });
  });

  describe('translateInBackground · M4 Step 14b/14c（预取派发口 + 到达恢复钉子）', () => {
    it('14b 预取派发：走同一条管线（remote-image 源），完成写入内存层', async () => {
      const harness = createHarness({
        resolveTarget: () => undefined, // 预取的典型场景：该页还没翻到、目标未挂载
      });

      await harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');

      expect(harness.downloadImage).toHaveBeenCalledWith(
        { kind: 'remote-image', url: 'https://x/6.webp' },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      const state = harness.store.get('4218710-6');
      expect(state).toMatchObject({ status: 'translated' });
      expect(state?.translatedUrl).toBeTypeOf('string');
      // 目标未挂载 → 完成时不强求贴图，只更新内存层（等到达还原走内存直贴）
      expect(harness.applyImage).not.toHaveBeenCalled();
      expect(harness.render).toHaveBeenCalled(); // 但状态变化照常广播
    });

    it('14c① 页面到达时预取仍在跑：完成即贴（resolveTarget 命中挂载目标）', async () => {
      let mounted = false;
      let completePipeline!: () => void;
      const harness = createHarness({
        resolveTarget: () => (mounted ? harness.target : undefined),
        dependencies: {
          runLocalPipeline: () => new Promise((resolve) => {
            completePipeline = () => resolve(localResult());
          }),
        },
      });

      const done = harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');
      await vi.waitFor(() => expect(completePipeline).toBeTypeOf('function'));
      expect(harness.applyImage).not.toHaveBeenCalled(); // 该页还没到达

      mounted = true; // 用户翻到该页：恢复路径把画框挂上，target 变为可解析
      completePipeline();
      await done;

      expect(harness.applyImage).toHaveBeenCalledOnce(); // 完成即贴，不等用户再点
      expect(harness.store.get('4218710-6')).toMatchObject({ status: 'translated' });
    });

    it('14c② 页面到达时预取已完成：内存直贴依据成立（有译图），重复派发是空操作', async () => {
      const harness = createHarness({
        resolveTarget: () => undefined,
      });
      await harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');

      // 到达还原的判定依据：内存层有译图 → 恢复路径直接贴，绝不再进管线。
      // （isKeyBusy 的语义是"在跑或已有译图"，完成后恒 true —— 执行器靠它去重。）
      expect(harness.store.get('4218710-6')?.translatedUrl).toBeTypeOf('string');
      expect(harness.controller.isKeyBusy('4218710-6')).toBe(true);
      const start = vi.spyOn(harness.executionModule, 'start');
      await harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');
      expect(start).not.toHaveBeenCalled(); // 执行器漏判再派发也不重跑
    });

    it('14c③ 预取在跑时 isKeyBusy=true —— 执行器据此跳过，绝不对同一页开两条管线', async () => {
      let completePipeline!: () => void;
      const harness = createHarness({
        dependencies: {
          runLocalPipeline: () => new Promise((resolve) => {
            completePipeline = () => resolve(localResult());
          }),
        },
      });

      const done = harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');
      await vi.waitFor(() => expect(completePipeline).toBeTypeOf('function'));
      expect(harness.controller.isKeyBusy('4218710-6')).toBe(true);

      const start = vi.spyOn(harness.executionModule, 'start');
      await harness.controller.translateInBackground('4218710-6', 'https://x/6.webp');
      expect(start).not.toHaveBeenCalled();

      completePipeline();
      await done;
    });

    /**
     * ★ 用户问的那个具体场景（2026-10-03）：
     * **翻页过快 —— 下一页还没预翻译完，用户已经跳过去了。**
     *
     * 期望行为（不是重新发起一次翻译）：
     * ① 到达该页时**接管**正在跑的那条任务 —— 不重发、不开第二条管线；
     * ② 先显示原图（挂载时内存里还没有译图）；
     * ③ 那条正在跑的任务完成 → 自动贴上译图（画框）。
     *
     * 这条把三段行为串成一个故事钉死：如果哪天有人把"到达时接在跑任务"改坏了
     * （比如到达就 abort 重发），这里会立刻红。
     */
    it('★ 翻页过快：到达时翻译仍在跑 → 接管（不重发），任务完成即自动贴上译图', async () => {
      let mounted = false;
      let completePipeline!: () => void;
      const harness = createHarness({
        resolveTarget: (_key) => (mounted ? harness.target : undefined),
        dependencies: {
          runLocalPipeline: () => new Promise((resolve) => {
            completePipeline = () => resolve(localResult());
          }),
        },
      });
      const key = '4218710-6';

      // ① 预取先开工（用户还在第 5 页，目标未挂载）
      const prefetchDone = harness.controller.translateInBackground(key, 'https://x/6.webp');
      await vi.waitFor(() => expect(completePipeline).toBeTypeOf('function'));
      expect(harness.store.get(key)?.status).toBe('running');
      const startSpy = vi.spyOn(harness.executionModule, 'start');

      // ② 用户翻页过快，到达该页 —— 到达路径：内存里没有译图、但状态是 running
      mounted = true;
      const state = harness.store.ensure(key, 'https://x/6.webp');
      harness.controller.restoreFromCache(harness.target);
      // 没译图可贴 → 保持原图；且**绝不重发**（没新开管线）
      expect(harness.applyImage).not.toHaveBeenCalled();
      expect(startSpy).not.toHaveBeenCalled();
      expect(state.status).toBe('running'); // 还是那条在跑的任务

      // ③ 那条任务完成 → 自动贴图（用户不用再点按钮）
      completePipeline();
      await prefetchDone;

      expect(harness.applyImage).toHaveBeenCalledOnce();
      expect(harness.applyImage).toHaveBeenCalledWith(harness.target, expect.anything());
      expect(harness.store.get(key)).toMatchObject({ status: 'translated' });
      expect(startSpy).not.toHaveBeenCalled(); // 全程只有最初那一条管线
    });

    it('★ 翻页过快（反向）：到达时那页已译完 → 内存直贴，且不重发', async () => {
      // 用与 target 同一个 key，才构成"到达的正是那一页"。
      const harness = createHarness({
        resolveTarget: () => harness.target,
      });
      const key = harness.target.key; // 'image-1'

      await harness.controller.translateInBackground(key, 'https://x/6.webp');
      expect(harness.store.get(key)?.translatedUrl).toBeTypeOf('string');
      const startSpy = vi.spyOn(harness.executionModule, 'start');
      harness.applyImage.mockClear();

      harness.controller.restoreFromCache(harness.target);

      expect(harness.applyImage).toHaveBeenCalledWith(harness.target, expect.anything());
      expect(startSpy).not.toHaveBeenCalled();
    });
  });
});
