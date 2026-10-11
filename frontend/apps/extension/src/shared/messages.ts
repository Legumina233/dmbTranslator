import type { DiagnosticLogEvent, DiagnosticLogTextExport } from '@dmb/diagnostics';
import type { StageTiming } from '@dmb/image-pipeline/benchmark';
import type { LlmAuthMode, LlmProvider } from '@dmb/text-translation';
import { requireExtensionRuntime } from './extensionRuntime';
import { isLlmThinkingLevel } from '@dmb/text-translation';
import type { LlmThinkingLevel } from '@dmb/text-translation';
import { isReferrerPolicy } from './referrerPolicy';
import {
  parseCredentiallessHttpsUrl,
  parseRestrictedResourceBaseUrl,
} from './restrictedResourceUrl';
import { toErrorMessage } from './utils';
import { isContentSessionId } from './contentSession';
import type { DmbEventInput } from './eventLog';
import type {
  ExtensionControlCommand,
  ExtensionControlResult,
  WholeImageExecutionPreparation,
} from './extensionControl';

export type ExtensionControlRuntimeMessage = {
  type: 'mt:extension-control';
  command: ExtensionControlCommand;
};

export type DownloadImageMessage = {
  type: 'mt:download-image';
  imageUrl: string;
  referrerPolicy?: ReferrerPolicy;
  contentSessionId?: string;
  allowedBaseUrl?: string;
  /**
   * 旁路日志用（M2）：页身份与诊断 runId。
   * 下载失败抛在 pipeline 之外，带上这两项才能在事件流里对上"是哪一页、哪一次运行"。
   */
  pageKey?: string;
  runId?: string;
};

export type FetchReaderResourceMessage = {
  type: 'mt:fetch-reader-resource';
  url: string;
  allowedBaseUrl: string;
};

export type CaptureVisibleTabMessage = {
  type: 'mt:capture-visible-tab';
};

export type LlmChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmChatCompletionRequestBody = {
  model: string;
  messages: LlmChatMessage[];
  response_format?: {
    type: 'json_object' | 'text';
  };
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  reasoning_split?: boolean;
  thinking?: {
    type: 'disabled' | 'enabled' | 'adaptive';
  };
};

export type LlmChatCompletionsProxyConfig = {
  provider: LlmProvider;
  authMode: LlmAuthMode;
  baseUrl: string;
  useCustomModel?: boolean;
  thinkingLevel?: LlmThinkingLevel;
};

export type LlmChatCompletionsMessage = {
  type: 'mt:llm-chat-completions';
  body: LlmChatCompletionRequestBody;
  proxyConfig?: LlmChatCompletionsProxyConfig;
  diagnosticRunId?: string;
};

type ImageTranslateMessageImage = {
  base64: string;
  contentType: string;
  filename: string;
};

export type GeminiAppImageTranslateMessage = {
  type: 'mt:gemini-app-image-translate';
  image: ImageTranslateMessageImage;
  preparation: Extract<WholeImageExecutionPreparation, { provider: 'gemini-app' }>;
  diagnosticRunId?: string;
  contentSessionId?: string;
};

export type GeminiApiImageTranslateMessage = {
  type: 'mt:gemini-api-image-translate';
  image: ImageTranslateMessageImage;
  preparation: Extract<WholeImageExecutionPreparation, { provider: 'gemini-api' }>;
  diagnosticRunId?: string;
  contentSessionId?: string;
};

export type CloudImageTranslateMetadata = {
  modelLabel: string;
  imageUrl?: string;
  stageTimings: StageTiming[];
};

export type GeminiAppImageTranslateMetadata = CloudImageTranslateMetadata;

export type GeminiApiImageTranslateMetadata = CloudImageTranslateMetadata;

export type CloudImageTranslateSuccess = {
  base64: string;
  contentType: string;
  metadata: CloudImageTranslateMetadata;
};

export type CloudImageTranslateRequest = {
  image: {
    base64: string;
    contentType: string;
    filename: string;
  };
};

/** Sent from background to content script when user clicks "翻译图片" in context menu. */
export type ContextMenuTranslateMessage = {
  type: 'mt:context-menu-translate';
};

/** Sent from background to content script when user clicks "截图翻译" in context menu. */
export type StartScreenshotTranslateMessage = {
  type: 'mt:start-screenshot-translate';
};

/** Sent from background to content script when user presses the hover-target translation shortcut. */
export type ShortcutTranslateHoverMessage = {
  type: 'mt:shortcut-translate-hover';
};

/**
 * M2b · 内容脚本把事件流交给 background 上报。
 *
 * ★ 为什么必须绕这一道：content script 的 `fetch` 受**页面 CSP**约束，
 * 到不了 `http://127.0.0.1:11436`；background / offscreen 用的是扩展自己的 CSP，才发得出去。
 * 所以内容侧只负责"攒 + 交给 background"，出口实现仍然只有一处。
 */
export type EventLogPushMessage = {
  type: 'mt:event-log';
  /** 一批待上报事件，schema 见 `shared/eventLog.ts`（`v=2`）。空数组是合法 no-op。 */
  events: DmbEventInput[];
};

export type DiagnosticLogEventMessage = {
  type: 'mt:diagnostic-log-event';
  event: DiagnosticLogEvent;
};

export type DiagnosticLogExportMessage = {
  type: 'mt:diagnostic-log-export';
};

export type DiagnosticLogClearMessage = {
  type: 'mt:diagnostic-log-clear';
};

/**
 * 弹窗读写**内容脚本内存里的译图缓存**（2026-10-03 用户拍板：译图落盘暂时关闭，
 * 缓存只活在内存里，所以缓存管理必须打到页面上那个内容脚本，而不是后台/落盘库）。
 */
export type MemoryCacheAction = 'status' | 'clear' | 'limit';

export type MemoryCacheMessage = {
  type: 'mt:memory-cache';
  action: MemoryCacheAction;
  /** `limit` 动作的目标条数上限。 */
  limit?: number;
};

export type MemoryCacheResult = {
  /** 内容脚本**本文档**内存里当前几条译图。随页面文档生灭 —— 刷新页面必归零。 */
  size: number;
  /**
   * **off-screen 文档里那份缓存**（真正的「译图缓存」）当前的条数。
   *
   * 为什么要单列：缓存分两层，`size` 是短命的那层（`PhotoStateStore`，随页面文档生灭），
   * 而跨页面重载存活、能攒到上限的是 off-screen 里这一份。弹窗显示"有几张"必须读它，
   * 否则一刷新数字就归零，用户会以为缓存被清空了。
   */
  vaultSize: number;
  /** 当前条数上限。 */
  limit: number;
  /** 本次清掉的条数（clear 才有值）。 */
  cleared: number;
  /**
   * **是否真的连上了页面的内容脚本**。`false` = 当前标签页没注入/不是目标站点，
   * 此时 `size` 无意义 —— 弹窗必须显示"—"而不是 0，否则会把"没采到"伪装成"空的"。
   */
  reached: boolean;
  /**
   * `reached:false` 时**为什么没连上**，会原样显示在弹窗那一行。
   *
   * 存在理由：定位不到标签 / `sendMessage` 失败 / 回复格式不对，是三件完全不同的事，
   * 原先都只写 `reached:false` → UI 一律「未连接」→ 用户看不出"有缓存却读不到"断在哪。
   * 这个字段只用于显示，**不参与任何逻辑判断**。
   */
  failure?: string;
};

/**
 * 弹窗把**预取设置**推给内容脚本（预载页数 + 进入自动翻译）。
 * 与 `mt:memory-cache` 同一理由：内容脚本拿不到 settings，只能由弹窗推。
 * 单向即可（不需要回执数据），后台收到后转发到当前标签页。
 *
 * ★ 2026-10-09：原来的第三个字段 `prefetchEnabled` 已删除 —— 语义并入
 * `prefetchDepth`（0 = 关闭预载）。校验只认已知字段，所以旧版弹窗多推一个
 * 已删除的字段不会让消息失效；新版弹窗推给旧版内容脚本才会缺字段，
 * 而扩展是整体升级的，不存在这种混用。
 */
export type PrefetchConfigMessage = {
  type: 'mt:prefetch-config';
  /** 向后预载页数（**0 = 关闭预载**）。 */
  prefetchDepth: number;
  /** 进入阅读页是否自动翻译当前页（与预载深度是**正交**的两个旋钮）。 */
  autoTranslateOnEnter: boolean;
};

/**
 * 内容脚本 ↔ 后台：预取设置的**读 + 写**（页面右下角的预载开关用）。
 *
 * 弹窗那条 `mt:prefetch-config` 是**单向推送**（弹窗 → 内容脚本）。页面上的开关还需要两件事：
 * ① 初次挂载能读到当前设置（用户不打开弹窗直接翻页时，内容脚本根本不知道当前值）；
 * ② 改动要写回 settings（否则开关只是本地状态：刷新即丢、弹窗里显示的也对不上）。
 *
 * 约定：带字段 = 写入并回推各标签页；无论写不写，都回当前值。
 */
export type PrefetchConfigSyncMessage = {
  type: 'mt:prefetch-config-sync';
  prefetchDepth?: number;
  autoTranslateOnEnter?: boolean;
};

export type RuntimeMessage =
  | ExtensionControlRuntimeMessage
  | DownloadImageMessage
  | FetchReaderResourceMessage
  | CaptureVisibleTabMessage
  | LlmChatCompletionsMessage
  | GeminiAppImageTranslateMessage
  | GeminiApiImageTranslateMessage
  | DiagnosticLogEventMessage
  | EventLogPushMessage
  | DiagnosticLogExportMessage
  | DiagnosticLogClearMessage
  | MemoryCacheMessage
  | PrefetchConfigMessage
  | PrefetchConfigSyncMessage
  | ContextMenuTranslateMessage
  | StartScreenshotTranslateMessage
  | ShortcutTranslateHoverMessage;

export type RuntimeSuccessResponse =
  | {
      ok: true;
      type: 'mt:extension-control';
      result: ExtensionControlResult;
    }
  | {
      ok: true;
      type: 'mt:download-image';
      base64: string;
      contentType: string;
      sourceUrl: string;
    }
  | {
      ok: true;
      type: 'mt:fetch-reader-resource';
      text: string;
      contentType: string;
      sourceUrl: string;
    }
  | {
      ok: true;
      type: 'mt:capture-visible-tab';
      base64: string;
      contentType: string;
      sourceUrl: string;
    }
  | {
      ok: true;
      type: 'mt:llm-chat-completions';
      data: unknown;
    }
  | {
      ok: true;
      type: 'mt:gemini-app-image-translate';
      base64: string;
      contentType: string;
      metadata: GeminiAppImageTranslateMetadata;
    }
  | {
      ok: true;
      type: 'mt:gemini-api-image-translate';
      base64: string;
      contentType: string;
      metadata: GeminiApiImageTranslateMetadata;
    }
  | {
      ok: true;
      type: 'mt:context-menu-translate';
    }
  | {
      ok: true;
      type: 'mt:start-screenshot-translate';
    }
  | {
      ok: true;
      type: 'mt:shortcut-translate-hover';
    }
  | {
      ok: true;
      type: 'mt:diagnostic-log-event';
    }
  | {
      ok: true;
      type: 'mt:event-log';
      /** 实际收下的条数（校验未过的会被跳过，调用方据此自查）。 */
      accepted: number;
    }
  | {
      ok: true;
      type: 'mt:diagnostic-log-export';
      log: DiagnosticLogTextExport;
    }
  | {
      ok: true;
      type: 'mt:diagnostic-log-clear';
    }
  | {
      ok: true;
      type: 'mt:memory-cache';
      cache: MemoryCacheResult;
    }
  | {
      ok: true;
      type: 'mt:prefetch-config';
    }
  | {
      ok: true;
      type: 'mt:prefetch-config-sync';
      prefetchDepth: number;
      autoTranslateOnEnter: boolean;
    };

export type RuntimeErrorDetail = {
  title: string;
  content: string;
};

export type RuntimeErrorCode =
  | 'llm_thinking_config'
  | 'extension_settings_conflict';

export type RuntimeErrorResponse = {
  ok: false;
  type: RuntimeMessage['type'];
  error: string;
  errorCode?: RuntimeErrorCode;
  status?: number;
  retryAfterMs?: number;
  retryable?: boolean;
  errorDetail?: RuntimeErrorDetail;
};

export type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isDownloadImageMessage(value: Record<string, unknown>): value is DownloadImageMessage {
  if (value.type !== 'mt:download-image' || typeof value.imageUrl !== 'string') {
    return false;
  }
  try {
    const imageUrl = new URL(value.imageUrl);
    if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') {
      return false;
    }
  } catch {
    return false;
  }
  return (value.referrerPolicy === undefined || isReferrerPolicy(value.referrerPolicy))
    && (
      value.allowedBaseUrl === undefined
      || (typeof value.allowedBaseUrl === 'string'
        && Boolean(parseRestrictedResourceBaseUrl(value.allowedBaseUrl)))
    )
    && (value.contentSessionId === undefined || isContentSessionId(value.contentSessionId));
}

function isFetchReaderResourceMessage(
  value: Record<string, unknown>,
): value is FetchReaderResourceMessage {
  return value.type === 'mt:fetch-reader-resource'
    && typeof value.url === 'string'
    && Boolean(parseCredentiallessHttpsUrl(value.url))
    && typeof value.allowedBaseUrl === 'string'
    && Boolean(parseRestrictedResourceBaseUrl(value.allowedBaseUrl));
}

export function getRuntimeErrorCode(error: unknown): RuntimeErrorCode | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  if (
    error.errorCode === 'llm_thinking_config'
    || error.errorCode === 'extension_settings_conflict'
  ) {
    return error.errorCode;
  }
  return error.code === 'TRANSLATION_CONFIGURATION_CONFLICT'
    ? 'extension_settings_conflict'
    : undefined;
}

export function getRuntimeTransportMetadata(error: unknown): {
  status?: number;
  retryAfterMs?: number;
  retryable?: boolean;
} {
  if (!isRecord(error)) return {};
  const metadata: {
    status?: number;
    retryAfterMs?: number;
    retryable?: boolean;
  } = {};
  if (typeof error.status === 'number' && Number.isFinite(error.status)) {
    metadata.status = error.status;
  }
  if (
    typeof error.retryAfterMs === 'number'
    && Number.isFinite(error.retryAfterMs)
    && error.retryAfterMs >= 0
  ) {
    metadata.retryAfterMs = error.retryAfterMs;
  }
  if (error.retryable === true || error instanceof TypeError) {
    metadata.retryable = true;
  }
  return metadata;
}

function isLlmProvider(value: unknown): value is LlmProvider {
  return (
    value === 'deepseek' ||
    value === 'gemini' ||
    value === 'glm' ||
    value === 'kimi' ||
    value === 'minimax' ||
    value === 'mimo' ||
    value === 'openai' ||
    value === 'custom'
  );
}

function isLlmAuthMode(value: unknown): value is LlmAuthMode {
  return value === 'api_key' || value === 'openai_oauth' || value === 'gemini_app';
}

function isExtensionControlRuntimeMessage(
  value: Record<string, unknown>,
): value is ExtensionControlRuntimeMessage {
  if (value.type !== 'mt:extension-control' || !isRecord(value.command)) {
    return false;
  }
  const command = value.command;
  if (command.kind === 'read' || command.kind === 'prepare-execution') return true;
  if (command.kind === 'replace-settings') {
    return isRecord(command.settings) && typeof command.expectedRevision === 'number';
  }
  if (command.kind === 'update-interface-preferences') {
    return isRecord(command.preferences);
  }
  if (command.kind === 'replace-api-key') {
    return isLlmProvider(command.provider) && typeof command.apiKey === 'string';
  }
  if (command.kind === 'clear-api-key') {
    return isLlmProvider(command.provider);
  }
  if (command.kind === 'reveal-api-key') {
    return isLlmProvider(command.provider);
  }
  return command.kind === 'perform-access'
    && (command.target === 'openai-oauth' || command.target === 'gemini-app')
    && (
      command.action === 'refresh'
      || command.action === 'login'
      || command.action === 'logout'
    );
}

function isLlmChatCompletionsMessage(value: Record<string, unknown>): value is LlmChatCompletionsMessage {
  if (value.type !== 'mt:llm-chat-completions' || !isRecord(value.body)) {
    return false;
  }
  const proxyConfig = value.proxyConfig;
  if (
    proxyConfig !== undefined &&
    (!isRecord(proxyConfig) ||
      !isLlmProvider(proxyConfig.provider) ||
      !isLlmAuthMode(proxyConfig.authMode) ||
      typeof proxyConfig.baseUrl !== 'string' ||
      (proxyConfig.useCustomModel !== undefined && typeof proxyConfig.useCustomModel !== 'boolean') ||
      (proxyConfig.thinkingLevel !== undefined && !isLlmThinkingLevel(proxyConfig.thinkingLevel)))
  ) {
    return false;
  }
  return (
    typeof value.body.model === 'string' &&
    Array.isArray(value.body.messages) &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string')
  );
}

function isGeminiAppImageTranslateMessage(value: Record<string, unknown>): value is GeminiAppImageTranslateMessage {
  if (
    value.type !== 'mt:gemini-app-image-translate'
    || !isRecord(value.image)
    || !isRecord(value.preparation)
  ) {
    return false;
  }
  const preparation = value.preparation;
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    preparation.provider === 'gemini-app' &&
    (preparation.model === 'nano_banana_2' || preparation.model === 'nano_banana_pro') &&
    typeof preparation.modelLabel === 'string' &&
    typeof preparation.prompt === 'string' &&
    (preparation.authMode === 'browser_session' || preparation.authMode === 'cookies_permission') &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string') &&
    (value.contentSessionId === undefined || isContentSessionId(value.contentSessionId))
  );
}

function isGeminiApiImageTranslateMessage(value: Record<string, unknown>): value is GeminiApiImageTranslateMessage {
  if (
    value.type !== 'mt:gemini-api-image-translate'
    || !isRecord(value.image)
    || !isRecord(value.preparation)
  ) {
    return false;
  }
  const preparation = value.preparation;
  return (
    typeof value.image.base64 === 'string' &&
    typeof value.image.contentType === 'string' &&
    typeof value.image.filename === 'string' &&
    preparation.provider === 'gemini-api' &&
    typeof preparation.model === 'string' &&
    typeof preparation.modelLabel === 'string' &&
    typeof preparation.prompt === 'string' &&
    typeof preparation.baseUrl === 'string' &&
    (value.diagnosticRunId === undefined || typeof value.diagnosticRunId === 'string') &&
    (value.contentSessionId === undefined || isContentSessionId(value.contentSessionId))
  );
}

function isMemoryCacheMessage(value: Record<string, unknown>): value is MemoryCacheMessage {
  if (value.type !== 'mt:memory-cache') return false;
  if (value.action !== 'status' && value.action !== 'clear' && value.action !== 'limit') {
    return false;
  }
  return value.limit === undefined
    || (Number.isInteger(value.limit) && (value.limit as number) >= 1);
}

function isPrefetchConfigMessage(value: Record<string, unknown>): value is PrefetchConfigMessage {
  if (value.type !== 'mt:prefetch-config') return false;
  // 两个字段都**必填**：消息是弹窗单向推的，缺了它会让内容脚本落回默认值，
  // 用户刚在弹窗里改的设置会被悄悄抹掉。
  // 校验只认**已知字段**，多余字段一律忽略：旧版弹窗多推一个已删除的
  // `prefetchEnabled` 也不会让整条消息失效（2026-10-05 清掉 DOM 遥测后就是这么处理的）。
  return Number.isInteger(value.prefetchDepth)
    && (value.prefetchDepth as number) >= 0
    && typeof value.autoTranslateOnEnter === 'boolean';
}

function isPrefetchConfigSyncMessage(value: Record<string, unknown>): value is PrefetchConfigSyncMessage {
  if (value.type !== 'mt:prefetch-config-sync') return false;
  const depthOk = value.prefetchDepth === undefined
    || (Number.isInteger(value.prefetchDepth) && (value.prefetchDepth as number) >= 0);
  const autoOk = value.autoTranslateOnEnter === undefined
    || typeof value.autoTranslateOnEnter === 'boolean';
  return depthOk && autoOk;
}

function isDiagnosticLogEventMessage(value: Record<string, unknown>): value is DiagnosticLogEventMessage {
  if (value.type !== 'mt:diagnostic-log-event' || !isRecord(value.event)) {
    return false;
  }
  const event = value.event;
  return (
    typeof event.id === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.level === 'string' &&
    typeof event.category === 'string' &&
    isRecord(event.source) &&
    typeof event.source.context === 'string' &&
    typeof event.message === 'string'
  );
}

/**
 * 只校验"是不是一批事件"，不逐字段深挖。
 *
 * 理由：事件 schema 由 `shared/eventLog.ts` 与设计文档 §5 唯一约定，
 * 这里再抄一遍字段清单只会产生第二份会过期的真相。真正的把关在**服务端**
 * （`eventlog.validate`）与产出端（`emit` 的入参类型）。这里拦的是"根本不是事件数组"。
 */
function isEventLogPushMessage(value: Record<string, unknown>): value is EventLogPushMessage {
  if (value.type !== 'mt:event-log' || !Array.isArray(value.events)) {
    return false;
  }
  return value.events.every(
    (event) => isRecord(event) && typeof event.kind === 'string' && event.kind.length > 0,
  );
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  return (
    isExtensionControlRuntimeMessage(value) ||
    isDownloadImageMessage(value) ||
    isFetchReaderResourceMessage(value) ||
    type === 'mt:capture-visible-tab' ||
    type === 'mt:diagnostic-log-export' ||
    type === 'mt:diagnostic-log-clear' ||
    isMemoryCacheMessage(value) ||
    isPrefetchConfigMessage(value) ||
    isPrefetchConfigSyncMessage(value) ||
    type === 'mt:context-menu-translate' ||
    type === 'mt:start-screenshot-translate' ||
    type === 'mt:shortcut-translate-hover' ||
    isGeminiAppImageTranslateMessage(value) ||
    isGeminiApiImageTranslateMessage(value) ||
    isDiagnosticLogEventMessage(value) ||
    isEventLogPushMessage(value) ||
    isLlmChatCompletionsMessage(value)
  );
}

export function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const runtime = requireExtensionRuntime();
  return runtime.sendMessage<RuntimeResponse>(message).then((response) => {
      if (!response || typeof response !== 'object') {
        throw new Error('扩展消息返回为空');
      }
      return response;
  }).catch((error: unknown) => {
    throw new Error(`扩展通信失败: ${toErrorMessage(error)}`);
  });
}
