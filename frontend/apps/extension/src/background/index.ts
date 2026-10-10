import { getExtensionApi } from '../shared/extensionRuntime';
import type { ExtensionMessageSender } from '../shared/extensionRuntime';
import {
  getRuntimeErrorCode,
  getRuntimeTransportMetadata,
  isRuntimeMessage,
  type RuntimeMessage,
  type RuntimeResponse,
} from '../shared/messages';
import { toErrorMessage } from '../shared/utils';
import {
  cancelQueuedGeminiAppImageTranslations,
  getGeminiAppRawResponse,
} from './geminiAppClient';
import { cancelQueuedGeminiApiImageTranslations } from './geminiApiImageClient';
import {
  getSettings,
  getSettingsState,
  setSettingsState,
} from './settings/settingsStore';
import {
  clearDiagnosticLog,
  exportDiagnosticLog,
  recordDiagnosticLogEvent,
} from './diagnostics/logStore';
import { installUncaughtErrorCapture } from './diagnostics/uncaughtCapture';
import {
  configureBackgroundEventLog,
  emitBackgroundEvent,
  emitBackgroundFailure,
} from './diagnostics/backgroundEventLog';
import {
  captureVisibleTab,
} from './images/imageService';
import { createImageDownloader } from './images/imageDownloader';
import { createReaderResourceFetcher } from './readers/readerResourceFetcher';
import { registerMenusAndCommands } from './menus/registerMenus';
import {
  getOpenAiOAuthStatus,
  handleOpenAiOAuthCallbackUrl,
  handleOpenAiOAuthTabRemoved,
  loginOpenAiOAuth,
  logoutOpenAiOAuth,
} from './openai/oauthService';
import { loginGeminiApp, readGeminiAppAuthStatus } from './gemini/authService';
import {
  handleGeminiApiImageTranslate,
  handleGeminiAppImageTranslate,
  handleLlmChatCompletions,
} from './providers/providerService';
import { routeBackgroundMessage } from './messages/router';
import { maintainMemoryCache } from './messages/memoryCache';
import { pushPrefetchConfig, syncPrefetchConfig } from './messages/prefetchConfig';
import type { BackgroundServices } from './messages/router';
import { registerPipelineHostBroker } from './localPipeline/offscreenBroker';
import type { PipelineHostBroker } from './localPipeline/offscreenBroker';
import { ImageVaultBroker } from './imageVault/imageVaultBroker';
import { ChromiumPipelineHostLifecycle } from './localPipeline/pipelineHostLifecycle';
import type { PipelineHostLifecycle } from './localPipeline/pipelineHostLifecycle';
import { isPipelineLifecycleTestBuild } from '../shared/buildFlags';
import { resolveLlmBaseUrl } from '../shared/config';
import { createDiagnosticLogEmitter } from '../shared/diagnosticLogClient';
import { createExtensionSettingsRepository } from './extensionControl/settingsRepository';
import { createTranslationConfigurationModule } from './extensionControl/translationConfiguration';
import { createProviderAccessModule } from './extensionControl/providerAccess';
import { createExtensionControlModule } from './extensionControl/extensionControl';
import { registerExtensionControlPort } from './extensionControl/extensionControlPort';
import { isTrustedPopupSender } from './extensionControl/credentialDisclosurePolicy';
import { registerContentSessionLifecycle } from './contentSessionLifecycle';

/**
 * M2 · 下载失败的旁路出口。
 *
 * 这里只做"报告 → 事件流"的转接，**不改下载逻辑**：imageDownloader 抛什么照抛，
 * 只是在抛出之前把结构化明细（host / 候选尝试 / 耗时）送进统一事件流。
 * 94 页那类错误以前完全隐身（抛在 pipeline 之外，整页日志只记终态），现在必有一条 failure。
 */
const imageDownloader = createImageDownloader({
  onFailure: (report) => {
    emitBackgroundFailure({
      message: report.reason,
      stage: 'load',
      module: 'background/images/imageDownloader',
      fn: 'downloadSerialized',
      runId: report.runId,
      pageKey: report.pageKey,
      code: 'IMAGE_TRANSLATION_SOURCE_ACQUISITION_FAILED',
      type: 'ImageDownloadError',
      retryable: true,
      durMs: report.durationMs,
      what: {
        imageHost: report.hostname,
        imageUrl: report.imageUrl,
        attemptCount: report.attemptCount,
        attempts: report.attempts,
      },
    });
  },
});
const readerResourceFetcher = createReaderResourceFetcher();
const settingsRepository = createExtensionSettingsRepository({
  readState: getSettingsState,
  writeState: async (state) => {
    await setSettingsState(state);
  },
});
const translationConfiguration = createTranslationConfigurationModule(settingsRepository);
const providerAccess = createProviderAccessModule(settingsRepository, {
  openAi: {
    status: getOpenAiOAuthStatus,
    login: loginOpenAiOAuth,
    logout: logoutOpenAiOAuth,
  },
  gemini: {
    status: readGeminiAppAuthStatus,
    login: loginGeminiApp,
  },
});
const extensionControl = createExtensionControlModule(
  translationConfiguration,
  providerAccess,
);
const services: BackgroundServices = {
  settings: {
    get: getSettings,
  },
  extensionControl: {
    handle(command, sender) {
      const popupUrl = getExtensionApi()?.runtime?.getURL?.('popup.html') ?? '';
      return extensionControl.handle(command, {
        canRevealApiKeys: isTrustedPopupSender(sender, popupUrl),
      });
    },
  },
  diagnostics: {
    record: recordDiagnosticLogEvent,
    export: exportDiagnosticLog,
    clear: clearDiagnosticLog,
  },
  /**
   * M2b · 收下内容脚本交上来的事件，转进统一事件流。
   *
   * 出口仍然只有一处（本模块的 backgroundEventLog）：内容侧只负责"攒 + 交"。
   * 未 configure（没有本机服务地址）时 `emitBackgroundEvent` 本身就是 no-op，
   * 这里照常返回条数 —— 上报是旁路，不该让调用方因为"发不出去"而改变行为。
   */
  eventLog: {
    async push(events) {
      let accepted = 0;
      for (const event of events) {
        if (!event || typeof event.kind !== 'string' || event.kind.length === 0) continue;
        emitBackgroundEvent(event);
        accepted += 1;
      }
      return accepted;
    },
  },
  images: {
    download: imageDownloader.download,
    capture: captureVisibleTab,
  },
  readers: {
    fetch: readerResourceFetcher.fetch,
  },
  memoryCache: {
    // 译图只活在内容脚本内存里（落盘已关闭）→ 转发到当前标签页去执行。
    async maintain(message, sender) {
      return { cache: await maintainMemoryCache(message, sender) };
    },
  },
  prefetchConfig: {
    // 预取设置（预载页数 + 进入自动翻译）跑在内容脚本里 → 推给当前标签页。
    async push(message, sender) {
      await pushPrefetchConfig(message, sender);
    },
    // 页面右下角开关：带字段则写 settings 并回推，始终回当前值。
    async sync(message, sender) {
      return syncPrefetchConfig(message, sender);
    },
  },
  providers: {
    llm: handleLlmChatCompletions,
    geminiAppImage: handleGeminiAppImageTranslate,
    geminiApiImage: async (message) => handleGeminiApiImageTranslate(
      message,
      await providerAccess.requireApiKey('gemini'),
    ),
  },
};


let initialized = false;
let pipelineHostBroker: PipelineHostBroker | null = null;

const pipelineHostBrokerDiagnostics = createDiagnosticLogEmitter(async (event) => {
  try {
    const settings = await getSettings();
    if (settings.enableDebugLog) await recordDiagnosticLogEvent(event);
    return true;
  } catch {
    return false;
  }
});

export async function dispatchBackgroundMessage(
  message: RuntimeMessage,
  sender: ExtensionMessageSender = {},
): Promise<RuntimeResponse> {
  try {
    return await routeBackgroundMessage(message, sender, services);
  } catch (error) {
    const geminiRawResponse = getGeminiAppRawResponse(error);
    const errorCode = getRuntimeErrorCode(error);
    const transportMetadata = getRuntimeTransportMetadata(error);
    return {
      ok: false,
      type: message.type,
      error: toErrorMessage(error),
      ...(errorCode ? { errorCode } : {}),
      ...transportMetadata,
      ...(geminiRawResponse !== null
        ? {
            errorDetail: {
              title: 'Gemini 实际回复',
              content: geminiRawResponse,
            },
          }
        : {}),
    } satisfies RuntimeResponse;
  }
}

export function initializeBackground(lifecycle: PipelineHostLifecycle): void {
  if (initialized) return;
  // 错误黑匣子最先挂：后续初始化/事件监听里的未捕获异常都要能落进诊断日志。
  installUncaughtErrorCapture();
  const chromeApi = getExtensionApi();
  if (!chromeApi?.runtime?.onMessage?.addListener) {
    return;
  }
  initialized = true;

  pipelineHostBroker = registerPipelineHostBroker(
    chromeApi,
    lifecycle,
    pipelineHostBrokerDiagnostics,
  );
  // 译图缓存走的是同一份 off-screen 文档，但端口由它自己的 broker 管。
  // 它**不能**自己监听 `onConnect`：broker 是端口命名空间的所有者，不认得的端口会当场断开。
  // lifecycle 固定用 Chromium 的：这里要的是"把 offscreen.html 拉起来"，与当前构建目标无关
  // （Firefox 没有 off-screen 文档，会立刻失败 → 缓存降级为无，行为等同加缓存之前）。
  const imageVaultBroker = new ImageVaultBroker(new ChromiumPipelineHostLifecycle(chromeApi));
  pipelineHostBroker.registerPortHandler((port) => imageVaultBroker.handlePort(port));
  registerExtensionControlPort(chromeApi, extensionControl);
  registerContentSessionLifecycle(chromeApi, (contentSessionId) => {
    imageDownloader.cancelPendingForSession(contentSessionId);
    cancelQueuedGeminiAppImageTranslations(contentSessionId);
    cancelQueuedGeminiApiImageTranslations(contentSessionId);
  });

  if (isPipelineLifecycleTestBuild()) {
    chromeApi.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (
        !message
        || typeof message !== 'object'
        || (message as { type?: unknown }).type !== 'mt:pipeline-host-test-snapshot'
      ) {
        return false;
      }
      sendResponse({
        ok: true,
        type: 'mt:pipeline-host-test-snapshot',
        snapshot: pipelineHostBroker?.getLifecycleSnapshot() ?? null,
      });
      return false;
    });
    void import('./localPipeline/lifecycleSelfTest')
      .then(({ runPipelineHostLifecycleSelfTest }) => (
        pipelineHostBroker
          ? runPipelineHostLifecycleSelfTest(pipelineHostBroker)
          : undefined
      ));
  }

  chromeApi.runtime.onMessage.addListener((message: unknown, sender: ExtensionMessageSender, sendResponse: (response: unknown) => void) => {
    if (!isRuntimeMessage(message)) {
      return false;
    }

    void dispatchBackgroundMessage(message, sender)
      .then((response) => {
        sendResponse(response);
      });
    return true;
  });

  chromeApi.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.url === 'string') {
      void handleOpenAiOAuthCallbackUrl(tabId, changeInfo.url)
        .then((changed) => changed
          ? extensionControl.refreshProviderAccess('openai-oauth')
          : undefined);
    }
    const tabUrl = changeInfo.url ?? tab.url ?? '';
    if (changeInfo.status === 'complete' && tabUrl.startsWith('https://gemini.google.com/')) {
      void extensionControl.refreshProviderAccess('gemini-app');
    }
  });

  chromeApi.tabs?.onRemoved?.addListener((tabId) => {
    void handleOpenAiOAuthTabRemoved(tabId)
      .then((changed) => changed
        ? extensionControl.refreshProviderAccess('openai-oauth')
        : undefined);
  });

  chromeApi.cookies?.onChanged?.addListener(({ cookie }) => {
    if (cookie.domain.includes('google.com')) {
      void extensionControl.refreshProviderAccess('gemini-app');
    }
  });

  chromeApi.permissions?.onAdded?.addListener(() => {
    void extensionControl.refreshProviderAccess();
  });

  chromeApi.permissions?.onRemoved?.addListener(() => {
    void extensionControl.refreshProviderAccess();
  });

  // M2 · 事件流出口：地址只从"翻译服务地址"推导（不看 OCR 引擎设置 —— 踩过：
  // 挂在 OCR 引擎条件下时，用户换引擎后整条日志旁路静默失效）。
  void getSettings()
    .then((settings) => {
      configureBackgroundEventLog({
        llmBaseUrl: resolveLlmBaseUrl(settings),
        enabled: settings.eventLogEnabled,
        // 与 offscreen 同一个口径：逐行原文/译文单独一道闸，默认不开。
        verbose: settings.logSourceText && settings.enableDebugLog,
      });
    })
    .catch(() => undefined);

  registerMenusAndCommands();
}
