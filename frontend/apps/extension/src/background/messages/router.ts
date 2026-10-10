import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import type { ExtensionControlCommand, ExtensionControlResult } from '../../shared/extensionControl';
import type {
  RuntimeMessage,
  RuntimeResponse,
} from '../../shared/messages';
import type { ImageDownloadRequest } from '../images/imageDownloader';
import type { ReaderResourceRequest } from '../readers/readerResourceFetcher';
import { emitBackgroundFailure } from '../diagnostics/backgroundEventLog';
import { toErrorMessage } from '../../shared/utils';

type MessageOf<T extends RuntimeMessage['type']> = Extract<RuntimeMessage, { type: T }>;
type SuccessOf<T extends RuntimeResponse['type']> = Extract<RuntimeResponse, { ok: true; type: T }>;
type PayloadOf<T extends RuntimeResponse['type']> = Omit<SuccessOf<T>, 'ok' | 'type'>;

export type BackgroundServices = {
  settings: {
    get(): Promise<import('../../shared/config').ExtensionSettings>;
  };
  extensionControl: {
    handle(
      command: ExtensionControlCommand,
      sender: ExtensionMessageSender,
    ): Promise<ExtensionControlResult>;
  };
  diagnostics: {
    record(event: MessageOf<'mt:diagnostic-log-event'>['event']): Promise<void>;
    export(): Promise<PayloadOf<'mt:diagnostic-log-export'>['log']>;
    clear(): Promise<void>;
  };
  /**
   * M2b · 内容脚本交上来的事件流。**只收不记**：真正落盘由 background 侧出口做
   * （出口实现只能有一处，否则又会分叉）。返回实际收下的条数。
   */
  eventLog: {
    push(events: MessageOf<'mt:event-log'>['events']): Promise<number>;
  };
  images: {
    download(
      request: ImageDownloadRequest,
      sender: ExtensionMessageSender,
      contentSessionId?: string,
    ): Promise<PayloadOf<'mt:download-image'>>;
    capture(sender: ExtensionMessageSender): Promise<PayloadOf<'mt:capture-visible-tab'>>;
  };
  readers: {
    fetch(request: ReaderResourceRequest): Promise<PayloadOf<'mt:fetch-reader-resource'>>;
  };
  memoryCache: {
    maintain(
      message: MessageOf<'mt:memory-cache'>,
      sender: ExtensionMessageSender,
    ): Promise<PayloadOf<'mt:memory-cache'>>;
  };
  prefetchConfig: {
    /** 把预取设置转发给当前标签页的内容脚本（内容脚本拿不到 settings）。 */
    push(message: MessageOf<'mt:prefetch-config'>, sender: ExtensionMessageSender): Promise<void>;
    /** 页面开关的读 + 写：带字段则写 settings 并回推，始终回当前值。 */
    sync(
      message: MessageOf<'mt:prefetch-config-sync'>,
      sender: ExtensionMessageSender,
    ): Promise<PayloadOf<'mt:prefetch-config-sync'>>;
  };
  providers: {
    llm(message: MessageOf<'mt:llm-chat-completions'>): Promise<SuccessOf<'mt:llm-chat-completions'>>;
    geminiAppImage(message: MessageOf<'mt:gemini-app-image-translate'>): Promise<SuccessOf<'mt:gemini-app-image-translate'>>;
    geminiApiImage(message: MessageOf<'mt:gemini-api-image-translate'>): Promise<SuccessOf<'mt:gemini-api-image-translate'>>;
  };
};

export async function routeBackgroundMessage(
  message: RuntimeMessage,
  sender: ExtensionMessageSender,
  services: BackgroundServices,
): Promise<RuntimeResponse> {
  /**
   * M2 · failure 第一公民的**兜底网**：整个路由包一层。
   *
   * 逐条消息加 try/catch 必然漏（以后新增消息类型谁还记得加），包一层后
   * "抛出"与"上报"绑在一起 —— 新增抛出点自动被覆盖。
   *
   * 例外：`mt:download-image` 自己有**第一现场**上报（imageDownloader 的 `onFailure`，
   * 带结构化的候选 host / 尝试明细 / 耗时），这里不再重复记一条只能看到字符串的。
   */
  try {
    return await dispatchBackgroundMessage(message, sender, services);
  } catch (error) {
    if (message.type !== 'mt:download-image') {
      emitBackgroundFailure({
        message: toErrorMessage(error),
        stage: 'background',
        module: 'background/messages/router',
        fn: 'routeBackgroundMessage',
        ...(error instanceof Error && error.name ? { type: error.name } : {}),
        what: { messageType: message.type },
      });
    }
    throw error;
  }
}

async function dispatchBackgroundMessage(
  message: RuntimeMessage,
  sender: ExtensionMessageSender,
  services: BackgroundServices,
): Promise<RuntimeResponse> {
  if (message.type === 'mt:diagnostic-log-event') {
    try {
      const settings = await services.settings.get();
      if (settings.enableDebugLog) await services.diagnostics.record(message.event);
    } catch {
      // Diagnostic writes are best-effort and must not affect callers.
    }
    return { ok: true, type: 'mt:diagnostic-log-event' };
  }
  if (message.type === 'mt:event-log') {
    return {
      ok: true,
      type: 'mt:event-log',
      accepted: await services.eventLog.push(message.events),
    };
  }
  if (message.type === 'mt:diagnostic-log-export') {
    return {
      ok: true,
      type: 'mt:diagnostic-log-export',
      log: await services.diagnostics.export(),
    };
  }
  if (message.type === 'mt:diagnostic-log-clear') {
    await services.diagnostics.clear();
    return { ok: true, type: 'mt:diagnostic-log-clear' };
  }
  if (message.type === 'mt:memory-cache') {
    return {
      ok: true,
      type: 'mt:memory-cache',
      ...await services.memoryCache.maintain(message, sender),
    };
  }
  if (message.type === 'mt:prefetch-config') {
    await services.prefetchConfig.push(message, sender);
    return { ok: true, type: 'mt:prefetch-config' };
  }
  if (message.type === 'mt:prefetch-config-sync') {
    return {
      ok: true,
      type: 'mt:prefetch-config-sync',
      ...await services.prefetchConfig.sync(message, sender),
    };
  }
  if (message.type === 'mt:extension-control') {
    return {
      ok: true,
      type: 'mt:extension-control',
      result: await services.extensionControl.handle(message.command, sender),
    };
  }
  if (message.type === 'mt:download-image') {
    const request: ImageDownloadRequest = {
      imageUrl: message.imageUrl,
      ...(message.referrerPolicy !== undefined
        ? { referrerPolicy: message.referrerPolicy }
        : {}),
      ...(message.allowedBaseUrl !== undefined
        ? { allowedBaseUrl: message.allowedBaseUrl }
        : {}),
      // 旁路日志身份（M2）：随下载请求一路带到抛出点。
      ...(message.pageKey !== undefined ? { pageKey: message.pageKey } : {}),
      ...(message.runId !== undefined ? { runId: message.runId } : {}),
    };
    return {
      ok: true,
      type: 'mt:download-image',
      ...await services.images.download(request, sender, message.contentSessionId),
    };
  }
  if (message.type === 'mt:fetch-reader-resource') {
    return {
      ok: true,
      type: 'mt:fetch-reader-resource',
      ...await services.readers.fetch({
        url: message.url,
        allowedBaseUrl: message.allowedBaseUrl,
      }),
    };
  }
  if (message.type === 'mt:capture-visible-tab') {
    return { ok: true, type: 'mt:capture-visible-tab', ...await services.images.capture(sender) };
  }
  if (message.type === 'mt:llm-chat-completions') {
    return services.providers.llm(message);
  }
  if (message.type === 'mt:gemini-app-image-translate') {
    return services.providers.geminiAppImage(message);
  }
  if (message.type === 'mt:gemini-api-image-translate') {
    return services.providers.geminiApiImage(message);
  }
  return { ok: false, type: message.type, error: '不支持的消息类型' };
}
