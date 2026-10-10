import {
  resolveLlmBaseUrl,
} from "../../shared/config";
import type { ExtensionSettings } from "../../shared/config";
import {
  classifyLlmFetchError,
  sanitizeDiagnosticUrl,
  toDiagnosticError,
} from '@dmb/diagnostics';
import type {
  LlmChatCompletionsProxyConfig,
  RuntimeMessage,
  RuntimeResponse,
} from "../../shared/messages";
import {
  AUTHENTICATION_INFO_PERMISSION,
  createExtensionPermissions,
} from '../../shared/extensionPermissions';
import {
  recordBackgroundDiagnosticLog,
  toImageTranslateDiagnosticData,
} from "../diagnostics/logStore";
import { geminiAppUrl } from "../gemini/authService";
import { runGeminiApiImageTranslate } from "../geminiApiImageClient";
import {
  getGeminiAppRawResponse,
  runGeminiAppImageTranslate,
} from "../geminiAppClient";
import {
  LlmChatCompletionHttpError,
  LlmChatCompletionParseError,
  proxyApiKeyChatCompletions,
  resolveLlmChatCompletionsEndpoint,
} from "../llmProxy";
import {
  openAiCodexResponsesEndpoint,
  proxyOpenAiChatCompletions,
} from "../openai/responsesProxy";
import { getSettings } from "../settings/settingsStore";

type LlmChatMessage = Extract<RuntimeMessage, { type: "mt:llm-chat-completions" }>;
type GeminiAppImageMessage = Extract<RuntimeMessage, { type: "mt:gemini-app-image-translate" }>;
type GeminiApiImageMessage = Extract<RuntimeMessage, { type: "mt:gemini-api-image-translate" }>;
type LlmChatResponse = Extract<RuntimeResponse, { ok: true; type: "mt:llm-chat-completions" }>;
type GeminiAppImageResponse = Extract<RuntimeResponse, { ok: true; type: "mt:gemini-app-image-translate" }>;
type GeminiApiImageResponse = Extract<RuntimeResponse, { ok: true; type: "mt:gemini-api-image-translate" }>;

function resolveLlmProxyConfig(
  settings: ExtensionSettings,
  proxyConfig: LlmChatCompletionsProxyConfig | undefined,
): LlmChatCompletionsProxyConfig {
  if (proxyConfig) {
    return proxyConfig;
  }
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    provider: settings.llmProvider,
    authMode: profile.authMode,
    baseUrl: resolveLlmBaseUrl(settings),
  };
}

function getLlmProxyEndpoint(proxyConfig: LlmChatCompletionsProxyConfig): string {
  if (proxyConfig.provider === 'openai' && proxyConfig.authMode === 'openai_oauth') {
    return openAiCodexResponsesEndpoint;
  }
  return resolveLlmChatCompletionsEndpoint(proxyConfig.baseUrl);
}

/**
 * 诊断日志入库前先把大文本压扁。
 *
 * ★ 为什么必须在**入库前**压，而不是靠导出时截断：日志库每追加一条都要读写
 * 一次持久化（见 `logStore.ts`），完整 prompt + 完整响应原样入库会让单条涨到
 * 几十 KB，库一大每次追加就跟着变慢 —— 实测开调试日志时，翻译请求在 background
 * 里多花的时间从 38 ms 一路涨到 6.7 s，几乎全是这笔读写开销。
 * 定位问题只需要结构和长度，不需要逐字原文。
 */
const diagnosticTextLimit = 200;

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateDiagnosticText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= diagnosticTextLimit) return value;
  return `${value.slice(0, diagnosticTextLimit)}…[+${value.length - diagnosticTextLimit} 字符]`;
}

/** 只保留请求结构与长度：角色、每条消息多长、前若干字符预览。 */
function summarizeRequestBody(body: unknown): unknown {
  if (!isRecordLike(body)) return body;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages) return body;
  return {
    ...body,
    messages: messages.map((message) => (
      isRecordLike(message)
        ? { ...message, content: truncateDiagnosticText(message.content) }
        : message
    )),
  };
}

/** 同上：响应里的译文按文本截断，保留结构（id / 用量 / finish_reason）供排查。 */
function summarizeResponseData(data: unknown): unknown {
  if (!isRecordLike(data)) return data;
  const choices = Array.isArray(data.choices) ? data.choices : undefined;
  if (!choices) return data;
  return {
    ...data,
    choices: choices.map((choice) => {
      if (!isRecordLike(choice)) return choice;
      const message = isRecordLike(choice.message) ? choice.message : undefined;
      return {
        ...choice,
        text: truncateDiagnosticText(choice.text),
        message: message
          ? { ...message, content: truncateDiagnosticText(message.content) }
          : choice.message,
      };
    }),
  };
}

function getLlmProxyErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof LlmChatCompletionHttpError) {
    return {
      status: error.status,
      statusText: error.statusText,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  if (error instanceof LlmChatCompletionParseError) {
    return {
      status: error.status,
      contentType: error.contentType,
      responseText: error.responseText,
    };
  }
  return {};
}

export async function handleLlmChatCompletions(message: LlmChatMessage): Promise<LlmChatResponse> {
  const settings = await getSettings();
  const proxyConfig = resolveLlmProxyConfig(settings, message.proxyConfig);
  await createExtensionPermissions().assertGranted(AUTHENTICATION_INFO_PERMISSION);
  const startedAt = Date.now();
  const baseLogData = {
    provider: proxyConfig.provider,
    authMode: proxyConfig.authMode,
    endpoint: sanitizeDiagnosticUrl(getLlmProxyEndpoint(proxyConfig)),
    model: message.body.model,
    messageCount: message.body.messages.length,
    responseFormat: message.body.response_format?.type ?? 'default',
    requestBody: summarizeRequestBody(message.body),
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await recordBackgroundDiagnosticLog(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'background/index.ts' },
    message: `${proxyConfig.provider} LLM 代理请求开始`,
    data: baseLogData,
  });
  try {
    const data = proxyConfig.provider === 'openai' && proxyConfig.authMode === 'openai_oauth'
      ? await proxyOpenAiChatCompletions(message.body, proxyConfig)
      : await proxyApiKeyChatCompletions(settings, proxyConfig, message.body);
    // ★ 完成日志**不 await**：它正排在翻译结果返回的关键路径上，库一大就能吃掉
    //   几秒（实测这条 await 就是「开调试日志后每页多花 6~7 秒」的主要来源之一）。
    //   诊断写入本来就是 best-effort —— `logStore` 的注释写死了「不得影响 API
    //   请求」，所以这里把 durationMs 先算好，写日志丢后台即可。
    void recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'background/index.ts' },
      message: `${proxyConfig.provider} LLM 代理请求完成`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        responseData: summarizeResponseData(data),
      },
    });
    return {
      ok: true,
      type: 'mt:llm-chat-completions',
      data,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(
      error,
      error instanceof LlmChatCompletionHttpError ? error.status : undefined,
    );
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'background/index.ts' },
      message: `${proxyConfig.provider} LLM 代理请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
        ...getLlmProxyErrorData(error),
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

export async function handleGeminiAppImageTranslate(message: GeminiAppImageMessage): Promise<GeminiAppImageResponse> {
  const settings = await getSettings();
  await createExtensionPermissions().assertGranted(AUTHENTICATION_INFO_PERMISSION);
  const startedAt = Date.now();
  const baseLogData = {
    provider: 'gemini',
    authMode: 'gemini_app',
    endpoint: sanitizeDiagnosticUrl(geminiAppUrl),
    modelLabel: message.preparation.modelLabel,
    image: toImageTranslateDiagnosticData(message.image),
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await recordBackgroundDiagnosticLog(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'geminiAppClient.ts' },
    message: 'Gemini App 全图翻译请求开始',
    data: baseLogData,
  });
  try {
    const translated = await runGeminiAppImageTranslate({
      imageBase64: message.image.base64,
      contentType: message.image.contentType,
      filename: message.image.filename,
      preparation: message.preparation,
      contentSessionId: message.contentSessionId,
    });
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiAppClient.ts' },
      message: 'Gemini App 全图翻译请求完成',
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        output: {
          contentType: translated.contentType,
          base64Length: translated.base64.length,
        },
        metadata: {
          ...translated.metadata,
          imageUrl: translated.metadata.imageUrl ? sanitizeDiagnosticUrl(translated.metadata.imageUrl) : undefined,
        },
      },
    });
    return {
      ok: true,
      type: 'mt:gemini-app-image-translate',
      ...translated,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(error);
    const rawResponse = getGeminiAppRawResponse(error);
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiAppClient.ts' },
      message: `Gemini App 全图翻译请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
        rawResponse: rawResponse ?? undefined,
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}

export async function handleGeminiApiImageTranslate(
  message: GeminiApiImageMessage,
  apiKey: string,
): Promise<GeminiApiImageResponse> {
  const settings = await getSettings();
  await createExtensionPermissions().assertGranted(AUTHENTICATION_INFO_PERMISSION);
  const startedAt = Date.now();
  const model = message.preparation.model;
  const endpoint = `${message.preparation.baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:generateContent`;
  const baseLogData = {
    provider: 'gemini',
    authMode: 'api_key',
    endpoint: sanitizeDiagnosticUrl(endpoint),
    model,
    modelLabel: message.preparation.modelLabel,
    image: toImageTranslateDiagnosticData(message.image),
    backgroundDirectFetch: true,
    contentDirectFetch: false,
  };
  await recordBackgroundDiagnosticLog(settings, {
    runId: message.diagnosticRunId,
    level: 'info',
    category: 'llm.api',
    source: { context: 'background', module: 'geminiApiImageClient.ts' },
    message: 'Gemini API 全图翻译请求开始',
    data: baseLogData,
  });
  try {
    const translated = await runGeminiApiImageTranslate({
      imageBase64: message.image.base64,
      contentType: message.image.contentType,
      filename: message.image.filename,
      preparation: message.preparation,
      apiKey,
      contentSessionId: message.contentSessionId,
    });
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'info',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiApiImageClient.ts' },
      message: 'Gemini API 全图翻译请求完成',
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        output: {
          contentType: translated.contentType,
          base64Length: translated.base64.length,
        },
        metadata: translated.metadata,
      },
    });
    return {
      ok: true,
      type: 'mt:gemini-api-image-translate',
      ...translated,
    };
  } catch (error) {
    const classification = classifyLlmFetchError(error);
    await recordBackgroundDiagnosticLog(settings, {
      runId: message.diagnosticRunId,
      level: 'error',
      category: 'llm.api',
      source: { context: 'background', module: 'geminiApiImageClient.ts' },
      message: `Gemini API 全图翻译请求失败：${classification.reason}`,
      data: {
        ...baseLogData,
        durationMs: Date.now() - startedAt,
        classification,
      },
      error: toDiagnosticError(error),
    });
    throw error;
  }
}
