import type { PipelineConfig } from '@dmb/image-pipeline';
import {
  createDefaultLlmThinkingByModel,
  detectBuiltInProviderByBaseUrl,
  getDefaultModelPreset,
  isBuiltInProvider,
  isLlmProvider,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  migrateBuiltInModelPreset,
  normalizeLlmThinkingByModel,
  resolveLlmThinkingLevel,
} from '@dmb/text-translation';
import type { LlmThinkingByModel } from '@dmb/text-translation';

export type ImageEngine = 'local' | 'gemini_app';
export type GeminiAppAuthMode = 'browser_session' | 'cookies_permission';
export type GeminiAppModel = 'nano_banana_2' | 'nano_banana_pro';

export const extensionSettingsStorageKey = 'mangaTranslate.settings';
export const extensionControlStateStorageKey = 'mangaTranslate.extensionControlState';
export const extensionTranslationDefaultsStorageKey = 'mangaTranslate.translationDefaults';
export const extensionInterfacePreferencesStorageKey = 'mangaTranslate.interfacePreferences';
export const extensionProviderCredentialsStorageKey = 'mangaTranslate.providerCredentials';
export const extensionSettingsRevisionStorageKey = 'mangaTranslate.settingsRevision';

export type LlmProvider = PipelineConfig['llmProvider'];
export type LlmAuthMode = PipelineConfig['llmAuthMode'];
export type BuiltInLlmProvider = Exclude<LlmProvider, 'custom'>;
export { llmBuiltInProviderDefinitions, llmProviderOptions };
export type LlmProviderProfile = {
  apiKey: string;
  authMode: LlmAuthMode;
  modelPreset: string;
  modelCustom: string;
  useCustomModel: boolean;
  customBaseUrl: string;
};

function createDefaultProviderProfile(provider: LlmProvider): LlmProviderProfile {
  if (isBuiltInProvider(provider)) {
    return {
      apiKey: '',
      authMode: provider === 'openai' ? 'openai_oauth' : provider === 'gemini' ? 'gemini_app' : 'api_key',
      modelPreset: getDefaultModelPreset(provider),
      modelCustom: '',
      useCustomModel: false,
      customBaseUrl: '',
    };
  }
  return {
    apiKey: '',
    authMode: 'api_key',
    modelPreset: '',
    modelCustom: '',
    useCustomModel: true,
    customBaseUrl: '',
  };
}

function createDefaultLlmProfiles(): Record<LlmProvider, LlmProviderProfile> {
  return {
    deepseek: createDefaultProviderProfile('deepseek'),
    gemini: createDefaultProviderProfile('gemini'),
    glm: createDefaultProviderProfile('glm'),
    kimi: createDefaultProviderProfile('kimi'),
    minimax: createDefaultProviderProfile('minimax'),
    mimo: createDefaultProviderProfile('mimo'),
    openai: createDefaultProviderProfile('openai'),
    custom: createDefaultProviderProfile('custom'),
  };
}

/**
 * OCR 引擎。
 * · `manga_ocr_server`（默认，2026-10-04 用户拍板）：本机服务（server/ocr.py）的 manga-ocr，
 *   推理在本地 GPU 上跑；浏览器侧不加载任何 ONNX OCR 模型。
 * · `paddleocr_v6_medium`：浏览器内 ONNX（旧默认）。代码保留为备选，切回去需要模型资产随包。
 */
export type OcrEngine = 'manga_ocr_server' | 'paddleocr_v6_medium';
/** 只保留「翻译」；「原文 / 去字」两个模式已移除（去字调试走 showEraseDebug）。 */
export type ProcessMode = 'translate';

export const geminiAppModelOptions: Array<{ value: GeminiAppModel; label: string }> = [
  { value: 'nano_banana_2', label: 'Nano Banana 2' },
  { value: 'nano_banana_pro', label: 'Nano Banana Pro' },
];

export const defaultGeminiAppPromptTemplate = [
  '请使用 Nano Banana Pro 对这张漫画图片进行端到端翻译和嵌字。',
  '将所有原文翻译为{targetLang}，擦除原字，并在原位置嵌入自然的中文译文。',
  '保持原图画风、分镜、气泡、人物、背景、线稿和颜色不变。',
  '只输出完成后的译图，不要输出解释、前后对比或额外文字。',
].join('\n');

export const optimizedGeminiAppPromptTemplate = [
  '任务：使用生图工具，把这张漫画/插画页面中的所有原文翻译为{targetLang}，擦除原字，并把译文自然嵌回原位置。',
  '严格限制：只修改台词文字/音效文字以及它们所在的气泡、标牌、字幕区域。',
  '不要改变人物、表情、姿势、服装、道具、背景、分镜、线条、色彩、构图、画布尺寸和阅读顺序。',
  '不要新增、删除、替换任何非文字内容。看不清的文字请保留原状或留空，不要猜测剧情、台词、人名或音效。',
  '译文要自然、简洁、适合漫画气泡，必要时自动换行排版。',
  '输出要求：只输出完成后的译图，不要解释、不要对比图、不要额外文字。',
].join('\n');

const previousOptimizedGeminiAppPromptTemplate = [
  '任务：把这张漫画/插画页面中的所有原文翻译为{targetLang}，擦除原字，并把译文自然嵌回原位置。',
  '严格限制：只修改文字以及文字所在的气泡、标牌、字幕区域。',
  '不要改变人物、表情、姿势、服装、道具、背景、分镜、线条、色彩、构图、画布尺寸和阅读顺序。',
  '不要新增、删除、替换任何非文字内容。看不清的文字请保留原状或留空，不要猜测剧情、台词、人名或音效。',
  '译文要自然、简洁、适合漫画气泡，必要时自动换行排版。',
  '输出要求：只输出完成后的译图，不要解释、不要对比图、不要额外文字。',
].join('\n');

export type ExtensionSettings = {
  targetLang: string;
  /**
   * 译图的**条数上限**（超出就把最久未用的删掉）。
   *
   * ⚠️ 2026-10-03 起它管的是**内存**里的译图（落盘已关闭，见
   * `localPipelineClient.ts` 的 `TRANSLATION_CACHE_PERSISTENCE_ENABLED`），
   * 实际生效位置是内容脚本的 `PhotoStateStore.setLimit()`。
   * 数字口径仍是"条数"——内存层不按字节统计（一张译图一条）。
   */
  translationCacheLimit: number;
  /**
   * 向后**预载页数**（M4 预取窗口深度）：看第 N 页时后台预翻译 N+1…N+depth。
   * **0 = 关闭预载**（只译点过按钮的页）。默认 4。
   *
   * ★ 2026-10-09：本字段是「要不要预载」的**唯一表达**。此前那个独立的
   * `prefetchEnabled` 布尔开关已删除 —— 它与 `depth = 0` 数学等价（`depth = 0` 时
   * `page >= currentPage + 1 && page <= currentPage` 无解，后页自然出局），
   * 而两处 UI 各存一份它的状态、还会跟深度值打架（设成 0 后开关仍显示"开"）。
   * 老设备 storage 里的 `prefetchEnabled: false` 由 `normalizeSettings` 翻译成 `0`。
   */
  prefetchDepth: number;
  /**
   * 进入阅读页后**自动翻译当前页**（默认关）。
   * 关 = 保持"点按钮才译"；开 = 到达即译当前页（窗口下界放宽到 distance ≥ 0）。
   *
   * 与 `prefetchDepth` 是**两个正交的旋钮**：
   * - 深度 > 0 / 自动翻译关 = 翻页时后方那几页已经译好，当前页仍"点按钮才译"；
   * - 自动翻译开 / 深度 0 = 到达页立刻自译，但**不**向后跑管线（省请求、省显存）。
   */
  autoTranslateOnEnter: boolean;
  imageEngine: ImageEngine;
  geminiAppExperimentalEnabled: boolean;
  geminiAppModel: GeminiAppModel;
  geminiAppPromptTemplate: string;
  geminiAppAuthMode: GeminiAppAuthMode;
  translator: PipelineConfig['translator'];
  llmProvider: LlmProvider;
  llmProfiles: Record<LlmProvider, LlmProviderProfile>;
  llmThinkingByModel: LlmThinkingByModel;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  stageTimingCardExpanded: boolean;
  showTypesetDebug: boolean;
  /**
   * 【通道 A】本机事件日志总开关。
   *
   * 管的是：要不要把排障事件 POST 到本机服务 `/log/events`
   * （落 `logs/events/YYYY-MM-DD.events.jsonl` —— 服务端自己也往同一个文件写）。
   * 关掉时这条通道整体 no-op，**原本 sum type 约束不变**：关闭时不占 CPU / 内存。
   *
   * ★ 它**不含**原文与译文 —— 那部分另由 `logSourceText` 单独管。
   * 默认开：阶段耗时、失败原因、requestId 贯穿都靠它，是排障主力。
   */
  eventLogEnabled: boolean;
  showEraseDebug: boolean;
  disableOcrPostFilter: boolean;
  debugOptionsExpanded: boolean;
  ocrEngine: OcrEngine;
  processMode: ProcessMode;
  /**
   * 【通道 B】诊断日志总开关。
   *
   * 管的是：写扩展本地 `chrome.storage`（环形 2000 条，弹窗「下载日志」导出）。
   * **与通道 A 互不依赖** —— 它的存在价值就是"本机服务不可用时仍有证据"，
   * 错误黑匣子更是无条件记录（见 `uncaughtCapture.ts`）。
   */
  enableDebugLog: boolean;
  /**
   * 是否把**逐行日文原文 + 中文译文**写进上面两条日志。
   *
   * ★ 隐私开关，默认**关**。原文/译文属于漫画正文内容，不该在用户没有明确开过
   * 的前提下落盘 —— 服务端 `eventlog.verbose_enabled()` 默认也是关的，两边口径对齐
   * （此前扩展侧默认开，会绕过服务端那道闸门，2026-10-07 修正）。
   *
   * 前置闸门：必须**先开诊断日志**（`enableDebugLog`）才允许勾选 —— 理由是不想出现
   * "用户以为没在记日志、其实原文译文已经写进另一个文件"的状态。UI 上联动禁用，
   * 下发时再兜一层 `&&`，两条路都不会漏。
   */
  logSourceText: boolean;
};

/**
 * 译图缓存条数上限的默认值 / 取值范围。
 *
 * 译图缓存有**两层**，两层都直接 import 这个常量当各自的默认上限：
 * - `content/core/state/photoStateStore.ts`（内容脚本内存，随页面生灭）
 * - `offscreen/translatedImageMemoryVault.ts`（off-screen 文档内存，跨页面重载存活）
 *
 * 所以默认值**只有这一处**，不存在"改一层、另一层没跟"。
 * 运行时改上限同理：`TranslatorCore.setMemoryCacheLimit()` 由内存层定出生效值，
 * 再原样交给另一层，两层不会各算各的。
 */
export const defaultTranslationCacheLimit = 15;
export const minTranslationCacheLimit = 1;
export const maxTranslationCacheLimit = 1000;

/** 把任意输入钳成合法上限：非整数 → 默认，越界 → 贴边界。 */
export function normalizeTranslationCacheLimit(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) return defaultTranslationCacheLimit;
  return Math.min(maxTranslationCacheLimit, Math.max(minTranslationCacheLimit, parsed));
}

/**
 * 预载页数（预取窗口深度）的默认值与取值范围。
 * 上限 10 是风控口径：深度越大 = 每翻一页要发的 showpage 请求越多（M3b 250ms 串行泵）。
 */
export const defaultPrefetchDepth = 4;
export const minPrefetchDepth = 0;
export const maxPrefetchDepth = 10;

/** 把任意输入钳成合法预载页数：非整数 → 默认，越界 → 贴边界。0 = 关闭预载。 */
export function normalizePrefetchDepth(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) return defaultPrefetchDepth;
  return Math.min(maxPrefetchDepth, Math.max(minPrefetchDepth, parsed));
}

export const defaultExtensionSettings: ExtensionSettings = {
  targetLang: 'zh-CHS',
  translationCacheLimit: defaultTranslationCacheLimit,
  prefetchDepth: defaultPrefetchDepth,
  autoTranslateOnEnter: false,
  imageEngine: 'local',
  geminiAppExperimentalEnabled: false,
  geminiAppModel: 'nano_banana_pro',
  geminiAppPromptTemplate: optimizedGeminiAppPromptTemplate,
  geminiAppAuthMode: 'cookies_permission',
  translator: 'llm',
  llmProvider: 'deepseek',
  llmProfiles: createDefaultLlmProfiles(),
  llmThinkingByModel: createDefaultLlmThinkingByModel(),
  showElapsedTime: false,
  showStageTimingDetails: false,
  stageTimingCardExpanded: true,
  showTypesetDebug: false,
  eventLogEnabled: true,
  showEraseDebug: false,
  disableOcrPostFilter: false,
  debugOptionsExpanded: false,
  ocrEngine: 'manga_ocr_server', // 默认引擎；常量 defaultOcrEngine 在下方声明，这里用字面量避免 TDZ
    processMode: 'translate',
    enableDebugLog: false,
    // 隐私开关：出厂默认不记原文/译文。
    logSourceText: false,
};

export function targetLanguageLabel(targetLang: string): string {
  return targetLang === 'zh-CHT' ? '繁体中文' : '简体中文';
}

export function buildGeminiImagePrompt(
  settings: Pick<ExtensionSettings, 'geminiAppPromptTemplate' | 'targetLang'>,
): string {
  return settings.geminiAppPromptTemplate.replace(/\{targetLang\}/g, targetLanguageLabel(settings.targetLang));
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') {
    return fallback;
  }
  return value;
}

/** 默认 OCR 引擎：本机服务版 manga-ocr。 */
export const defaultOcrEngine: OcrEngine = 'manga_ocr_server';

/** 本机服务默认地址（OCR / 翻译都指向它；用户在「自定义 Base URL」里可改）。 */
export const defaultOcrServerBaseUrl = 'http://127.0.0.1:11436';

/**
 * OCR 服务地址 = 本机服务的**来源**（去掉 `/v1` 等路径）。
 *
 * 只有当 Base URL 指向本机（127.0.0.1 / localhost / ::1）时才按它取 origin ——
 * 否则会闯祸：默认 provider 是云端（如 https://api.deepseek.com），
 * 按"来源"派生会把 OCR 请求发到云端去（`/ocr` 根本不存在）。
 * 云端 provider 一律回落本机服务默认地址。
 */
export function resolveOcrServerBaseUrl(settings: ExtensionSettings): string {
  const raw = resolveLlmBaseUrl(settings).trim();
  if (!raw) return defaultOcrServerBaseUrl;
  try {
    const url = new URL(raw);
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(url.hostname)) {
      return defaultOcrServerBaseUrl;
    }
    return url.origin;
  } catch {
    return defaultOcrServerBaseUrl;
  }
}

function normalizeOcrEngine(value: unknown): OcrEngine {
  // 2026-10-04 拍板：默认走本机服务（server/ocr.py），浏览器侧不加载 ONNX OCR 模型。
  //
  // 旧设置里会残留旧默认值 `paddleocr_v6_medium`，而**没有任何 UI 能改它**
  // （全仓库仅此类型保留该值，作备选），原来的 `return value` 把它原样留下 ——
  // 于是新默认永远轮不到，用户看到的是"我明明切了本地 OCR，却还在跑浏览器 ONNX"。
  // 旧值一律迁移到默认；想切回 ONNX 需要模型资产随包并重新给开关。
  if (value === 'manga_ocr_server') return value;
  return defaultOcrEngine;
}

function normalizeProcessMode(_value: unknown): ProcessMode {
  return 'translate';
}

function normalizeImageEngine(): ImageEngine {
  return 'local';
}

function normalizeGeminiAppAuthMode(): GeminiAppAuthMode {
  return 'cookies_permission';
}

function normalizeGeminiAppModel(value: unknown): GeminiAppModel {
  if (
    value === 'nano_banana_2' ||
    value === 'nano-banana-2' ||
    value === 'gemini-3.1-flash-image' ||
    value === 'nano_banana_2_lite' ||
    value === 'nano-banana-2-lite' ||
    value === 'gemini-3.1-flash-lite-image'
  ) {
    return 'nano_banana_2';
  }
  if (value === 'nano_banana_pro' || value === 'nano-banana-pro' || value === 'gemini-3-pro-image') {
    return 'nano_banana_pro';
  }
  return defaultExtensionSettings.geminiAppModel;
}

export function getGeminiAppModelLabel(model: GeminiAppModel): string {
  return geminiAppModelOptions.find((option) => option.value === model)?.label ?? 'Nano Banana Pro';
}

export function resolveGeminiApiImageModel(model: GeminiAppModel): string {
  return model === 'nano_banana_2' ? 'gemini-3.1-flash-image' : 'gemini-3-pro-image';
}

function normalizeTargetLang(value: unknown): string {
  if (typeof value !== 'string') {
    return defaultExtensionSettings.targetLang;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh-cht' || normalized === 'zh_tw' || normalized === 'zh-tw' || normalized === 'zh-hant') {
    return 'zh-CHT';
  }
  if (normalized === 'zh-chs' || normalized === 'zh_cn' || normalized === 'zh-cn' || normalized === 'zh' || normalized === 'zh-hans') {
    return 'zh-CHS';
  }
  return defaultExtensionSettings.targetLang;
}

function normalizeProfileString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value.trim();
}

function normalizeGeminiAppPromptTemplate(value: unknown): string {
  const normalized = normalizeProfileString(value, optimizedGeminiAppPromptTemplate);
  if (!normalized) {
    return optimizedGeminiAppPromptTemplate;
  }
  if (normalized === defaultGeminiAppPromptTemplate) {
    return optimizedGeminiAppPromptTemplate;
  }
  if (normalized === previousOptimizedGeminiAppPromptTemplate) {
    return optimizedGeminiAppPromptTemplate;
  }
  return normalized;
}

function normalizeAuthMode(provider: LlmProvider, value: unknown): LlmAuthMode {
  if (provider === 'openai') {
    return value === 'api_key' ? 'api_key' : 'openai_oauth';
  }
  if (provider === 'gemini') {
    return value === 'api_key' ? 'api_key' : 'gemini_app';
  }
  return 'api_key';
}

function normalizeProviderProfile(
  provider: LlmProvider,
  value: unknown,
  legacy: {
    modelFromLegacy: string;
    modelPresetInput: string;
    modelCustomInput: string;
    modelToggleInput: boolean | null;
    llmCustomBaseUrl: string;
    llmApiKey: string;
    llmAuthMode: unknown;
  } | null
): LlmProviderProfile {
  const defaults = createDefaultProviderProfile(provider);
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const apiKey = normalizeProfileString(raw?.apiKey, defaults.apiKey);
  let authMode = normalizeAuthMode(provider, raw?.authMode ?? legacy?.llmAuthMode ?? defaults.authMode);
  const modelPresetInput = migrateBuiltInModelPreset(provider, normalizeProfileString(raw?.modelPreset, ''));
  const modelCustomInput = normalizeProfileString(raw?.modelCustom, '');
  const useCustomModelInput = typeof raw?.useCustomModel === 'boolean' ? raw.useCustomModel : null;
  const customBaseUrlInput = normalizeProfileString(raw?.customBaseUrl, '');
  if (
    provider === 'gemini' &&
    authMode === 'api_key' &&
    !apiKey &&
    (modelPresetInput === 'nano-banana-2' ||
      modelPresetInput === 'nano-banana-pro' ||
      legacy?.modelPresetInput === 'nano-banana-2' ||
      legacy?.modelPresetInput === 'nano-banana-pro' ||
      legacy?.modelFromLegacy === 'nano-banana-2' ||
      legacy?.modelFromLegacy === 'nano-banana-pro')
  ) {
    authMode = 'gemini_app';
  }

  if (isBuiltInProvider(provider)) {
    const modelSet = new Set(llmBuiltInProviderDefinitions[provider].models);
    const legacyModelPresetInput = migrateBuiltInModelPreset(provider, legacy?.modelPresetInput ?? '');
    const legacyModelFromLegacy = migrateBuiltInModelPreset(provider, legacy?.modelFromLegacy ?? '');
    const candidatePreset = modelSet.has(modelPresetInput)
      ? modelPresetInput
      : legacy && modelSet.has(legacyModelPresetInput)
        ? legacyModelPresetInput
        : legacy && modelSet.has(legacyModelFromLegacy)
          ? legacyModelFromLegacy
          : defaults.modelPreset;

    const useCustomModel =
      provider === 'gemini'
        ? false
        : useCustomModelInput === null ? (legacy?.modelToggleInput === true ? true : defaults.useCustomModel) : useCustomModelInput;
    let modelCustom = provider === 'gemini' ? '' : modelCustomInput || (legacy?.modelCustomInput ?? '');
    if (useCustomModel && !modelCustom && legacyModelFromLegacy && !modelSet.has(legacyModelFromLegacy)) {
      modelCustom = legacyModelFromLegacy;
    }

    return {
      apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
      authMode,
      modelPreset: candidatePreset,
      modelCustom,
      useCustomModel,
      customBaseUrl: '',
    };
  }

  return {
    apiKey: apiKey || (legacy?.llmApiKey ?? defaults.apiKey),
    authMode,
    modelPreset: '',
    modelCustom: modelCustomInput || (legacy?.modelCustomInput ?? legacy?.modelFromLegacy ?? defaults.modelCustom),
    useCustomModel: true,
    customBaseUrl: customBaseUrlInput || (legacy?.llmCustomBaseUrl ?? defaults.customBaseUrl),
  };
}

export function normalizeSettings(value: unknown): ExtensionSettings {
  if (!value || typeof value !== 'object') {
    return { ...defaultExtensionSettings };
  }
  const raw = value as Record<string, unknown>;
  const legacyGeminiAppEnabled = raw.imageEngine === 'gemini_app' && raw.geminiAppExperimentalEnabled === true;
  // 只支持大模型翻译：老存档里的 google_web 一律归一到 llm。
  const translator = 'llm' as const;
  const legacyBaseUrl = typeof raw.llmBaseUrl === 'string' ? raw.llmBaseUrl.trim() : '';
  const providerFromBaseUrl = detectBuiltInProviderByBaseUrl(legacyBaseUrl);
  const provider = raw.llmProvider === 'gemini_api'
    ? 'gemini'
    : isLlmProvider(raw.llmProvider)
      ? raw.llmProvider
      : legacyGeminiAppEnabled
        ? 'gemini'
        : providerFromBaseUrl
          ? providerFromBaseUrl
          : defaultExtensionSettings.llmProvider;

  const legacy = {
    modelFromLegacy: typeof raw.llmModel === 'string' ? raw.llmModel.trim() : '',
    modelCustomInput: typeof raw.llmModelCustom === 'string' ? raw.llmModelCustom.trim() : '',
    modelPresetInput: typeof raw.llmModelPreset === 'string' ? raw.llmModelPreset.trim() : '',
    modelToggleInput: typeof raw.llmUseCustomModel === 'boolean' ? raw.llmUseCustomModel : null,
    llmCustomBaseUrl: typeof raw.llmCustomBaseUrl === 'string' ? raw.llmCustomBaseUrl.trim() : '',
    llmApiKey: typeof raw.llmApiKey === 'string' ? raw.llmApiKey.trim() : defaultExtensionSettings.llmProfiles[provider].apiKey,
    llmAuthMode: raw.llmAuthMode,
  };
  const rawProfiles = raw.llmProfiles && typeof raw.llmProfiles === 'object' ? (raw.llmProfiles as Record<string, unknown>) : {};
  const rawGeminiProfile = rawProfiles.gemini ?? rawProfiles.gemini_api;

  const llmProfiles: Record<LlmProvider, LlmProviderProfile> = {
    deepseek: normalizeProviderProfile('deepseek', rawProfiles.deepseek, provider === 'deepseek' ? legacy : null),
    gemini: normalizeProviderProfile('gemini', rawGeminiProfile, provider === 'gemini' ? legacy : null),
    glm: normalizeProviderProfile('glm', rawProfiles.glm, provider === 'glm' ? legacy : null),
    kimi: normalizeProviderProfile('kimi', rawProfiles.kimi, provider === 'kimi' ? legacy : null),
    minimax: normalizeProviderProfile('minimax', rawProfiles.minimax, provider === 'minimax' ? legacy : null),
    mimo: normalizeProviderProfile('mimo', rawProfiles.mimo, provider === 'mimo' ? legacy : null),
    openai: normalizeProviderProfile('openai', rawProfiles.openai, provider === 'openai' ? legacy : null),
    custom: normalizeProviderProfile('custom', rawProfiles.custom, provider === 'custom' ? legacy : null),
  };
  const showElapsedTime = sanitizeBoolean(raw.showElapsedTime, defaultExtensionSettings.showElapsedTime);
  const showTypesetDebug = sanitizeBoolean(raw.showTypesetDebug, defaultExtensionSettings.showTypesetDebug);
  const eventLogEnabled = sanitizeBoolean(
    // 兼容旧键：`pageLogEnabled` 是 2026-10-07 之前的名字（语义含混，已拆成
    // `eventLogEnabled` + `logSourceText` 两个开关）。老用户显式关过 → 升级后仍关。
    raw.eventLogEnabled ?? raw.pageLogEnabled,
    defaultExtensionSettings.eventLogEnabled,
  );
  const enableDebugLog = sanitizeBoolean(raw.enableDebugLog, defaultExtensionSettings.enableDebugLog);
  // 原文/译文是隐私数据：父开关没开就一律落到 false，不认 storage 里的残留值。
  const logSourceText = enableDebugLog
    && sanitizeBoolean(raw.logSourceText, defaultExtensionSettings.logSourceText);
  const usesNanoBanana = usesNanoBananaImagePipeline({ translator, llmProvider: provider });
  const geminiAppExperimentalEnabled = sanitizeBoolean(
    raw.geminiAppExperimentalEnabled,
    defaultExtensionSettings.geminiAppExperimentalEnabled,
  );
  return {
    targetLang: normalizeTargetLang(raw.targetLang),
    translationCacheLimit: normalizeTranslationCacheLimit(raw.translationCacheLimit),
    prefetchDepth: normalizePrefetchDepth(
      // 迁移（2026-10-09）：`prefetchEnabled` 已删除，语义并入本字段（0 = 关闭预载）。
      // 老设备 storage 里若还留着 `prefetchEnabled: false`，必须翻译成 0 ——
      // 否则用户当初"关掉预载"的选择会被静默丢弃、升级后预载自己又开了。
      // （与 `pageLogEnabled → eventLogEnabled` 同一套旧键兼容口径：老的显式选择要活下来。）
      raw.prefetchEnabled === false ? 0 : raw.prefetchDepth,
    ),
    autoTranslateOnEnter: sanitizeBoolean(
      raw.autoTranslateOnEnter,
      defaultExtensionSettings.autoTranslateOnEnter,
    ),
    imageEngine: normalizeImageEngine(),
    geminiAppExperimentalEnabled,
    geminiAppModel: normalizeGeminiAppModel(raw.geminiAppModel),
    geminiAppPromptTemplate: normalizeGeminiAppPromptTemplate(raw.geminiAppPromptTemplate),
    geminiAppAuthMode: normalizeGeminiAppAuthMode(),
    translator,
    llmProvider: provider,
    llmProfiles,
    llmThinkingByModel: normalizeLlmThinkingByModel(raw.llmThinkingByModel),
    showElapsedTime,
    showStageTimingDetails:
      usesNanoBanana
        ? false
        : showElapsedTime
          ? sanitizeBoolean(raw.showStageTimingDetails, defaultExtensionSettings.showStageTimingDetails)
          : false,
    stageTimingCardExpanded: sanitizeBoolean(raw.stageTimingCardExpanded, defaultExtensionSettings.stageTimingCardExpanded),
    showTypesetDebug: usesNanoBanana ? false : showTypesetDebug,
    eventLogEnabled,
    showEraseDebug: usesNanoBanana
      ? false
      : sanitizeBoolean(raw.showEraseDebug, defaultExtensionSettings.showEraseDebug),
    disableOcrPostFilter: usesNanoBanana
      ? false
      : sanitizeBoolean(raw.disableOcrPostFilter, defaultExtensionSettings.disableOcrPostFilter),
    debugOptionsExpanded: sanitizeBoolean(raw.debugOptionsExpanded, defaultExtensionSettings.debugOptionsExpanded),
    ocrEngine: normalizeOcrEngine(raw.ocrEngine),
    processMode: normalizeProcessMode(raw.processMode),
    enableDebugLog,
    logSourceText,
  };
}

export function resolveLlmBaseUrl(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.customBaseUrl.trim();
  }
  return llmBuiltInProviderDefinitions[settings.llmProvider].baseUrl;
}

export function resolveLlmModel(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.modelCustom.trim();
  }
  if (!profile.useCustomModel) {
    return profile.modelPreset.trim();
  }
  const customModel = profile.modelCustom.trim();
  return customModel;
}

export function requiresLlmApiKey(settings: ExtensionSettings): boolean {
  const profile = settings.llmProfiles[settings.llmProvider];
  return (
    !(settings.llmProvider === 'gemini' && profile.authMode === 'gemini_app') &&
    !(settings.llmProvider === 'openai' && profile.authMode === 'openai_oauth')
  );
}

export function usesNanoBananaImagePipeline(settings: Pick<ExtensionSettings, 'translator' | 'llmProvider'>): boolean {
  return settings.translator === 'llm' && settings.llmProvider === 'gemini';
}

type GeminiImagePipelineSelection = Pick<
  ExtensionSettings,
  'translator' | 'llmProvider'
> & {
  llmProfiles: { gemini: Pick<LlmProviderProfile, 'authMode'> };
};

export function usesGeminiAppImagePipeline(settings: GeminiImagePipelineSelection): boolean {
  return usesNanoBananaImagePipeline(settings) && settings.llmProfiles.gemini.authMode === 'gemini_app';
}

export function usesGeminiApiImagePipeline(settings: GeminiImagePipelineSelection): boolean {
  return usesNanoBananaImagePipeline(settings) && settings.llmProfiles.gemini.authMode === 'api_key';
}

export function validateSettings(settings: ExtensionSettings): string | null {
  if (usesNanoBananaImagePipeline(settings)) {
    if (!settings.geminiAppPromptTemplate.trim()) {
      return 'Nano Banana 提示词不能为空';
    }
    if (usesGeminiApiImagePipeline(settings)) {
      const profile = settings.llmProfiles[settings.llmProvider];
      if (!profile.apiKey.trim()) {
        return 'Nano Banana API Key 不能为空';
      }
    }
    return null;
  }

  if (settings.translator !== 'llm') {
    return null;
  }

  const model = resolveLlmModel(settings);
  if (!model) {
    return 'LLM 模型不能为空';
  }

  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom' && !profile.customBaseUrl.trim()) {
    return '自定义提供商 Base URL 不能为空';
  }
  if (requiresLlmApiKey(settings) && !profile.apiKey.trim()) {
    return 'LLM 模式需要填写 API Key';
  }

  return null;
}

export function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    // PipelineConfig 必需字段：源语言固定 ja（设置层不再有独立字段，见 2026-10-04 清理）
    sourceLang: 'ja',
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmAuthMode: profile.authMode,
    llmBaseUrl: resolveLlmBaseUrl(settings),
    llmModel: resolveLlmModel(settings),
    llmUseCustomModel: settings.llmProvider === 'custom' || profile.useCustomModel,
    llmThinkingLevel: settings.llmProvider === 'custom' || profile.useCustomModel
      ? undefined
      : resolveLlmThinkingLevel(
          settings.llmThinkingByModel,
          settings.llmProvider,
          resolveLlmModel(settings),
        ),
    typesetDebug: settings.showTypesetDebug,
    eventLogEnabled: settings.eventLogEnabled,
    // 原文/译文出厂就得过两道闸才能落盘：用户显式勾了 `logSourceText`，
    // 且诊断日志开着。服务端落盘前还有自己的 `DMB_EVENT_LOG_VERBOSE`（默认关）——
    // 三道闸口径一致，才不会出现"服务端说不含原文、扩展侧却已经写进去"的情况。
    recordSourceText: settings.logSourceText && settings.enableDebugLog,
    eraseDebug: settings.showEraseDebug,
    collectDebugLog: settings.showTypesetDebug || settings.enableDebugLog,
    ocrEngine: settings.ocrEngine,
    ocrServerBaseUrl: settings.ocrEngine === 'manga_ocr_server'
      ? resolveOcrServerBaseUrl(settings)
      : undefined,
    ocrPostFilter: settings.disableOcrPostFilter ? 'off' : 'balanced',
    processMode: settings.processMode,
  };
}
