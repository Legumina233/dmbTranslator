import { describe, expect, it, vi } from 'vitest';
import { createInitialPhotoState } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  applyImageTranslationProgress,
  applyImageTranslationFailure,
  applyImageTranslationResult,
  resetPhotoStateForImageTranslation,
  startPhotoStateImageTranslation,
} from '../../../apps/extension/src/content/core/translation/photoStateProjection';
import type { LocalPipelineImageTranslationResult } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { WholeImageTranslationError } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionModule } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import type { ProgressJankMonitor } from '../../../apps/extension/src/content/core/progressJank';
import { prepareExecutionFromSettings } from './executionPreparation';

function localExecutionResult(): LocalPipelineImageTranslationResult {
  return {
    kind: 'local-pipeline',
    status: 'completed',
    image: new Blob(['translated'], { type: 'image/png' }),
    debug: new Blob(['debug'], { type: 'image/png' }),
    source: {
      file: new File(['source'], 'source.png', { type: 'image/png' }),
      blob: new Blob(['source'], { type: 'image/png' }),
    },
    elapsedMs: 25,
    display: {
      showElapsedTime: true,
      showStageTimingDetails: true,
      showRuntimeStages: true,
      stageTimingCardExpanded: false,
      showTypesetDebug: true,
      showEraseDebug: true,
    },
    summary: {
      image: { width: 100, height: 200 },
      detectedRegionCount: 1,
      stageTimings: [{ stage: 'detect', label: '文本检测', durationMs: 10 }],
      runtimeStages: [],
      translationDebug: null,
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

describe('photo state projection', () => {
  it('projects execution progress and result without exposing PhotoState to execution', () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    state.status = 'error';
    state.errorText = 'failed';
    state.translatedUrl = 'blob:previous';
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:translated')
      .mockReturnValueOnce('blob:debug');
    const revokeObjectURL = vi.fn();

    resetPhotoStateForImageTranslation(state);
    applyImageTranslationProgress(state, {
      phase: 'executing',
      execution: {
        kind: 'local-pipeline',
        progress: {
          stage: 'detect',
          operation: 'detect-text',
          detail: '文本检测',
        },
      },
    });
    expect(state.stageText).toBe('文本检测中');

    const outcome = applyImageTranslationResult(state, localExecutionResult(), {
      includeElapsedText: true,
      urlApi: { createObjectURL, revokeObjectURL },
    });

    expect(outcome.translationDebug).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:previous');
    expect(state).toMatchObject({
      status: 'translated',
      translatedUrl: 'blob:translated',
      debugOriginalUrl: 'blob:debug',
      showTypesetDebug: true,
      showEraseDebug: true,
      stageText: '',
      errorText: '',
    });
    expect(state.stageTimingCard?.stages[0]?.stage).toBe('detect');
  });

  it('projects whole-image provider details without leaking them into PhotoState', () => {
    const state = createInitialPhotoState('https://example.com/source.png');

    applyImageTranslationFailure(
      state,
      new WholeImageTranslationError('generation failed', {
        title: 'Gemini reply',
        content: 'policy blocked',
      }),
    );

    expect(state).toMatchObject({
      status: 'error',
      errorText: 'generation failed',
      errorDetailCard: {
        title: 'Gemini reply',
        content: 'policy blocked',
        expanded: false,
      },
    });
  });

  it('returns a cancelled projection to an idle, retryable state', async () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecutionFromSettings(),
      runLocalPipeline: () => new Promise(() => undefined),
    });
    const task = startPhotoStateImageTranslation({
      executionModule: module,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['source'], 'source.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
    });
    await Promise.resolve();

    task.cancel('closed');

    await expect(task.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(state).toMatchObject({
      status: 'idle',
      stageText: '',
      errorText: '',
    });
  });

  it('does not let ending one owner cancel another projection for the same state', async () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecutionFromSettings(),
      runLocalPipeline: () => new Promise(() => undefined),
    });
    const arbiter = createImageTranslationExecutionArbiter(module);
    const firstActivity = arbiter.begin();
    const first = startPhotoStateImageTranslation({
      executionModule: firstActivity,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['first'], 'first.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
    });
    await Promise.resolve();

    const secondActivity = arbiter.begin();
    const second = startPhotoStateImageTranslation({
      executionModule: secondActivity,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['second'], 'second.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
    });

    expect(first.signal.aborted).toBe(false);
    firstActivity.end('first activity cleanup');
    await expect(first.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(state.status).toBe('running');

    secondActivity.end('test cleanup');
    await expect(second.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
  });

  it('uses the execution diagnostic run id when a projected task fails', async () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const monitor = {} as ProgressJankMonitor;
    const finishJankMonitor = vi.fn();
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecutionFromSettings({
        ...defaultExtensionSettings,
        enableDebugLog: true,
      }),
      createDiagnosticRunId: () => 'run-test',
      runLocalPipeline: async () => {
        throw new Error('pipeline failed');
      },
    });
    const task = startPhotoStateImageTranslation({
      executionModule: module,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['source'], 'source.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
      jankMonitor: monitor,
      finishJankMonitor,
    });

    await expect(task.result).rejects.toMatchObject({ diagnosticRunId: 'run-test' });
    expect(finishJankMonitor).toHaveBeenCalledWith(monitor, 'run-test');
  });

  // ── 译图落库钩子（Bug1 缓存保全）────────────────────────────────────────────
  // 持久层需要 Blob，但拿不到 key，也没法回头 fetch(blobUrl)
  // （内容脚本的 fetch 以扩展源发出，blob URL 跨源大概率被拒）。
  // 所以由投影层在**写 translatedUrl 的同时**把 result.image 直接交出去。

  it('hands the translated blob to the persistence hook', () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const onImageTranslated = vi.fn();
    const execution = localExecutionResult();

    applyImageTranslationResult(state, execution, {
      includeElapsedText: false,
      urlApi: {
        createObjectURL: vi.fn()
          .mockReturnValueOnce('blob:translated')
          .mockReturnValueOnce('blob:debug'),
        revokeObjectURL: vi.fn(),
      },
      onImageTranslated,
    });

    expect(onImageTranslated).toHaveBeenCalledTimes(1);
    expect(onImageTranslated).toHaveBeenCalledWith(execution.image);
  });

  it('keeps the translation result intact when the persistence hook throws', () => {
    const state = createInitialPhotoState('https://example.com/source.png');

    applyImageTranslationResult(state, localExecutionResult(), {
      includeElapsedText: false,
      urlApi: {
        createObjectURL: vi.fn()
          .mockReturnValueOnce('blob:translated')
          .mockReturnValueOnce('blob:debug'),
        revokeObjectURL: vi.fn(),
      },
      onImageTranslated: () => { throw new Error('译图缓存写入失败'); },
    });

    // 写缓存是顺手做的好事，它炸了不能让页面上那张图跟着遭殃。
    expect(state.status).toBe('translated');
    expect(state.translatedUrl).toBe('blob:translated');
    expect(state.errorText).toBe('');
  });

  it('does not require the persistence hook', () => {
    const state = createInitialPhotoState('https://example.com/source.png');

    applyImageTranslationResult(state, localExecutionResult(), {
      includeElapsedText: false,
      urlApi: {
        createObjectURL: vi.fn()
          .mockReturnValueOnce('blob:translated')
          .mockReturnValueOnce('blob:debug'),
        revokeObjectURL: vi.fn(),
      },
    });

    expect(state.status).toBe('translated');
  });
});
