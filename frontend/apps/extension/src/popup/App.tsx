import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  defaultExtensionSettings,
  geminiAppModelOptions,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  optimizedGeminiAppPromptTemplate,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  usesNanoBananaImagePipeline,
  type LlmAuthMode,
  type LlmProvider,
} from '../shared/config';
import { getExtensionRuntime } from '../shared/extensionRuntime';
import {
  getLlmThinkingControl,
  llmThinkingCapabilityKey,
  resolveLlmThinkingLevel,
  type LlmThinkingLevel,
} from '@dmb/text-translation';
import { downloadJson, downloadText } from '../shared/utils';
import { SelectControl } from './SelectControl';
import {
  LOCAL_API_KEY_PLACEHOLDER,
  LOCAL_DEFAULT_BASE,
  LocalModelControl,
  isLocalBase,
} from './LocalModelControl';
import {
  clearDiagnosticLog as clearStoredDiagnosticLog,
  exportDiagnosticLog,
} from '../shared/diagnosticLogClient';
import {
  buildSupportBundle,
  fetchServerSupport,
  resolveSupportServerBase,
  supportBundleFilenamePrefix,
} from '../shared/supportBundle';
import {
  resolveProviderAuthorizationTarget,
  toExtensionSettingsProjection,
  type ExtensionControlProjection,
  type ExtensionSettingsProjection,
  type ProviderAuthorizationAction,
  type ProviderAuthorizationProjection,
  type ProviderAuthorizationTarget,
  type PublicLlmProviderProfile,
} from '../shared/extensionControl';
import {
  createExtensionControlClient,
  isExtensionSettingsConflict,
  rebaseExtensionSettingsProjection,
  type ExtensionControlClient,
} from './extensionControlClient';

type SaveStatus = {
  kind: 'idle' | 'saving' | 'success' | 'error';
  message: string;
};

type OpenAiOAuthViewState = {
  loading: boolean;
  busy: boolean;
  authenticated: boolean;
  pending: boolean;
  email?: string;
  planType?: string;
  error: string;
};

type PersistSettingsOptions = {
  silent?: boolean;
};

type SettingsUpdateOptions = {
  showSaveStatus?: boolean;
};

const IconGitHub = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.603-3.369-1.342-3.369-1.342-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
  </svg>
);

const IconLLM = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8V4H8" />
    <rect width="16" height="12" x="4" y="8" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M15 13v2" />
    <path d="M9 13v2" />
  </svg>
);

const IconDownload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </svg>
);

const IconTrash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
);

const IconDebug = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.5-3.5a6 6 0 0 1-7.9 7.9l-6.6 6.6a2.1 2.1 0 0 1-3-3l6.6-6.6a6 6 0 0 1 7.9-7.9l-3.5 3.5z" />
  </svg>
);

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 0 1-15.5 6.2" />
    <path d="M3 12A9 9 0 0 1 18.5 5.8" />
    <path d="M18 3v6h-6" />
    <path d="M6 21v-6h6" />
  </svg>
);

const IconEye = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.1 12s3.6-7 9.9-7 9.9 7 9.9 7-3.6 7-9.9 7-9.9-7-9.9-7Z" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

const IconEyeOff = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.1 12s3.6-7 9.9-7 9.9 7 9.9 7-3.6 7-9.9 7-9.9-7-9.9-7Z" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="m3 3 18 18" />
  </svg>
);

const shortcutCommandDefinitions = [
  { name: 'start-screenshot-translate', label: '截图翻译' },
  { name: 'translate-hover-target', label: '翻译悬停元素' },
] as const;

type ShortcutCommandName = typeof shortcutCommandDefinitions[number]['name'];
type ShortcutCommandInfo = {
  name?: string;
  shortcut?: string;
};
type ShortcutState = Record<ShortcutCommandName, string>;

const defaultShortcutState: ShortcutState = {
  'start-screenshot-translate': '',
  'translate-hover-target': '',
};

function ApiKeyField({
  value,
  onChange,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();
  const toggleLabel = revealed ? '隐藏 API Key' : '显示 API Key';

  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>API Key</label>
      <div className="api-key-control">
        <input
          id={inputId}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          placeholder={placeholder}
        />
        <button
          className="api-key-visibility-button"
          type="button"
          onClick={() => setRevealed((current) => !current)}
          disabled={disabled}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-controls={inputId}
          aria-pressed={revealed}
        >
          {revealed ? <IconEye /> : <IconEyeOff />}
        </button>
      </div>
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const selectedIndex = options.findIndex((o) => o.value === value);
  const count = options.length;
  return (
    <div className={`seg-control${disabled ? ' seg-disabled' : ''}`}>
      <div
        className="seg-pill"
        style={{
          width: `calc(${100 / count}% - ${6 / count}px)`,
          transform: `translateX(${selectedIndex * 100}%)`,
        }}
      />
      {options.map((option, i) => (
        <button
          key={option.value}
          type="button"
          className={`seg-option${i === selectedIndex ? ' seg-active' : ''}`}
          onClick={() => onChange(option.value)}
          disabled={disabled}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<ExtensionSettingsProjection>(
    toExtensionSettingsProjection(defaultExtensionSettings),
  );
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle', message: '' });
  const [shortcutsLoading, setShortcutsLoading] = useState(true);
  const [shortcuts, setShortcuts] = useState<ShortcutState>(defaultShortcutState);
  const [shortcutError, setShortcutError] = useState('');
  const [thinkingFillReturningToOffKey, setThinkingFillReturningToOffKey] = useState<string | null>(null);
  const [openAiStatus, setOpenAiStatus] = useState<OpenAiOAuthViewState>({
    loading: false,
    busy: false,
    authenticated: false,
    pending: false,
    error: '',
  });
  const [geminiAppStatus, setGeminiAppStatus] = useState<OpenAiOAuthViewState>({
    loading: false,
    busy: false,
    authenticated: false,
    pending: false,
    error: '',
  });
  const hasHydratedRef = useRef(false);
  const committedSettingsRef = useRef<ExtensionSettingsProjection>(
    toExtensionSettingsProjection(defaultExtensionSettings),
  );
  const settingsDirtyRef = useRef(false);
  const skipNextSettingsPersistenceRef = useRef(false);
  const nextSaveShowsStatusRef = useRef(false);
  const saveRequestIdRef = useRef(0);
  const controlClientRef = useRef<ExtensionControlClient | null>(null);
  const [apiKeyValues, setApiKeyValues] = useState<Partial<Record<LlmProvider, string>>>({});
  const [apiKeyEditVersion, setApiKeyEditVersion] = useState(0);
  const apiKeyValuesRef = useRef<Partial<Record<LlmProvider, string>>>({});
  const apiKeyDirtyRef = useRef<Partial<Record<LlmProvider, boolean>>>({});

  function getControlClient(): ExtensionControlClient {
    controlClientRef.current ??= createExtensionControlClient();
    return controlClientRef.current;
  }

  function applyAuthorizationProjection(
    projection: ProviderAuthorizationProjection,
  ): OpenAiOAuthViewState {
    return {
      loading: false,
      busy: false,
      authenticated: projection.state === 'ready',
      pending: projection.state === 'authorizing',
      email: projection.identity?.email,
      planType: projection.identity?.planType,
      error: projection.error ?? '',
    };
  }

  function applyAccessProjection(projection: ExtensionControlProjection): void {
    setOpenAiStatus(applyAuthorizationProjection(projection.access.openAiOAuth));
    setGeminiAppStatus(applyAuthorizationProjection(projection.access.geminiApp));
  }

  useEffect(() => {
    const control = getControlClient();
    const unsubscribe = control.subscribe((projection) => {
      applyAccessProjection(projection);
      if (!settingsDirtyRef.current) {
        control.adoptProjection(projection);
        committedSettingsRef.current = projection.settings;
        if (hasHydratedRef.current) {
          skipNextSettingsPersistenceRef.current = true;
        }
        setSettings(projection.settings);
      }
    });
    async function loadControlProjection(): Promise<void> {
      try {
        const projection = await control.read();
        settingsDirtyRef.current = false;
        skipNextSettingsPersistenceRef.current = false;
        committedSettingsRef.current = projection.settings;
        setSettings(projection.settings);
        applyAccessProjection(projection);
      } catch (error) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setLoading(false);
      }
    }
    void loadControlProjection();
    return unsubscribe;
  }, []);

  useEffect(() => {
    async function loadShortcuts(): Promise<void> {
      setShortcutsLoading(true);
      setShortcutError('');
      const runtime = getExtensionRuntime();
      if (!runtime) {
        setShortcutError('当前浏览器不支持读取扩展命令');
        setShortcutsLoading(false);
        return;
      }
      try {
        const commands = await runtime.getCommands() as ShortcutCommandInfo[];
        const nextShortcuts: ShortcutState = { ...defaultShortcutState };
        for (const commandDefinition of shortcutCommandDefinitions) {
          const command = commands.find((item) => item.name === commandDefinition.name);
          nextShortcuts[commandDefinition.name] = command?.shortcut ?? '';
        }
        setShortcuts(nextShortcuts);
      } catch (error) {
        setShortcutError(error instanceof Error ? error.message : String(error));
      } finally {
        setShortcutsLoading(false);
      }
    }
    void loadShortcuts();
  }, []);

  function queueSaveStatus(options: SettingsUpdateOptions = {}): void {
    settingsDirtyRef.current = true;
    nextSaveShowsStatusRef.current = nextSaveShowsStatusRef.current || options.showSaveStatus === true;
  }

  function applyNanoBananaDebugLocks(
    next: ExtensionSettingsProjection,
  ): ExtensionSettingsProjection {
    if (!usesNanoBananaImagePipeline(next)) return next;
    return {
      ...next,
      showStageTimingDetails: false,
      showTypesetDebug: false,
      showEraseDebug: false,
      disableOcrPostFilter: false,
    };
  }

  function updateField<K extends keyof ExtensionSettingsProjection>(
    key: K,
    value: ExtensionSettingsProjection[K],
    options?: SettingsUpdateOptions,
  ): void {
    queueSaveStatus(options);
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      [key]: value,
    }));
  }

  function updateElapsedTime(checked: boolean, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      showElapsedTime: checked,
      showStageTimingDetails: checked && !usesNanoBananaImagePipeline(prev) ? prev.showStageTimingDetails : false,
    }));
  }

  /**
   * 「记录原文 / 译文」是「诊断日志」的子项，依赖关系照抄「阶段明细 → 显示耗时」：
   * 父开关一关，子项**值也落到 false**（不只是界面灰掉）—— 避免"界面看着是关的、
   * 存储里还留着 true"，等下次打开父开关又悄悄生效。
   */
  function updateDebugLog(checked: boolean, options?: SettingsUpdateOptions): void {
    queueSaveStatus(options);
    setSettings((prev) => ({
      ...prev,
      enableDebugLog: checked,
      logSourceText: checked ? prev.logSourceText : false,
    }));
  }

  function updateActiveLlmProfile(
    patch: Partial<PublicLlmProviderProfile>,
    options?: SettingsUpdateOptions,
  ): void {
    queueSaveStatus(options);
    setSettings((prev) => ({
      ...prev,
      llmProfiles: {
        ...prev.llmProfiles,
        [prev.llmProvider]: {
          ...prev.llmProfiles[prev.llmProvider],
          ...patch,
        },
      },
    }));
  }

  function updateActiveApiKey(value: string): void {
    const provider = settings.llmProvider;
    apiKeyDirtyRef.current[provider] = true;
    apiKeyValuesRef.current = {
      ...apiKeyValuesRef.current,
      [provider]: value,
    };
    setStatus({ kind: 'saving', message: '正在自动保存...' });
    setApiKeyValues((current) => ({
      ...current,
      [provider]: value,
    }));
    setApiKeyEditVersion((version) => version + 1);
  }

  function updateLlmProvider(provider: LlmProvider): void {
    queueSaveStatus();
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      llmProvider: provider,
      showStageTimingDetails: usesNanoBananaImagePipeline({ translator: prev.translator, llmProvider: provider })
        ? false
        : prev.showStageTimingDetails,
    }));
  }

  /**
   * 「模型来源」开关（在线模型 / 本地模型）。
   * * 本地 → 自定义提供商 + 本机 Base URL（走 dmb 本地服务），模型名来自本地服务列表
   * * 在线 → 内置提供商（deepseek / kimi / …），模型名来自内置目录
   * 不新增存储字段：来源本身就是 provider + baseUrl 推出来的。
   */
  function switchModelSource(next: 'online' | 'local'): void {
    queueSaveStatus();
    if (next === 'local') {
      setSettings((prev) => applyNanoBananaDebugLocks({
        ...prev,
        llmProvider: 'custom',
        llmProfiles: {
          ...prev.llmProfiles,
          custom: {
            ...prev.llmProfiles.custom,
            customBaseUrl: isLocalBase(prev.llmProfiles.custom.customBaseUrl)
              ? prev.llmProfiles.custom.customBaseUrl
              : LOCAL_DEFAULT_BASE,
            // 模型名不代填：默认留空，下拉显示「请选择模型」，由用户自己挑。
            // 之前这里代填了 LOCAL_DEFAULT_MODEL，结果一进来就显示 sakura-14b，与"占位提示"的设计冲突。
          },
        },
      }));
      return;
    }
    setSettings((prev) => applyNanoBananaDebugLocks({
      ...prev,
      llmProvider: prev.llmProvider === 'custom' && isLocalBase(prev.llmProfiles.custom.customBaseUrl)
        ? defaultExtensionSettings.llmProvider
        : prev.llmProvider,
    }));
  }

  function updateUseCustomModel(checked: boolean): void {
    updateActiveLlmProfile({ useCustomModel: checked });
  }

  function updateThinkingLevel(provider: LlmProvider, model: string, level: LlmThinkingLevel): void {
    const capabilityKey = llmThinkingCapabilityKey(provider, model);
    setThinkingFillReturningToOffKey(level === 'off' ? capabilityKey : null);
    queueSaveStatus();
    setSettings((prev) => ({
      ...prev,
      llmThinkingByModel: {
        ...prev.llmThinkingByModel,
        [capabilityKey]: level,
      },
    }));
  }

  function resetGeminiAppPromptTemplate(): void {
    updateField('geminiAppPromptTemplate', optimizedGeminiAppPromptTemplate, { showSaveStatus: true });
  }

  async function runProviderAccessAction(
    target: ProviderAuthorizationTarget,
    action: ProviderAuthorizationAction,
    setViewState: Dispatch<SetStateAction<OpenAiOAuthViewState>>,
    busyField: 'loading' | 'busy',
    onSuccess?: (projection: ExtensionControlProjection) => void,
  ): Promise<void> {
    setViewState((previous) => ({
      ...previous,
      [busyField]: true,
      error: '',
    }));
    try {
      const projection = await getControlClient().performAccess(target, action);
      applyAccessProjection(projection);
      onSuccess?.(projection);
    } catch (error) {
      setViewState((previous) => ({
        ...previous,
        loading: false,
        busy: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  function refreshOpenAiOAuthStatus(): Promise<void> {
    return runProviderAccessAction('openai-oauth', 'refresh', setOpenAiStatus, 'loading');
  }

  function loginOpenAiOAuth(): Promise<void> {
    return runProviderAccessAction(
      'openai-oauth',
      'login',
      setOpenAiStatus,
      'busy',
      (projection) => setStatus({
        kind: 'success',
        message: projection.access.openAiOAuth.state === 'ready'
          ? 'OpenAI 已登录'
          : 'OpenAI 登录页已打开，请在新标签页完成授权',
      }),
    );
  }

  function logoutOpenAiOAuth(): Promise<void> {
    return runProviderAccessAction(
      'openai-oauth',
      'logout',
      setOpenAiStatus,
      'busy',
      () => setStatus({ kind: 'success', message: 'OpenAI 已退出登录' }),
    );
  }

  function refreshGeminiAppAuthStatus(): Promise<void> {
    return runProviderAccessAction('gemini-app', 'refresh', setGeminiAppStatus, 'loading');
  }

  function loginGeminiApp(): Promise<void> {
    return runProviderAccessAction(
      'gemini-app',
      'login',
      setGeminiAppStatus,
      'busy',
      (projection) => setStatus({
        kind: 'success',
        message: projection.access.geminiApp.state === 'ready'
          ? '登录状态已更新'
          : 'Gemini 登录页已打开，请在新标签页完成登录',
      }),
    );
  }

  const currentProfile = settings.llmProfiles[settings.llmProvider];
  const usesNanoBanana = usesNanoBananaImagePipeline(settings);
  const usesGeminiApp = usesGeminiAppImagePipeline(settings);
  const usesGeminiApi = usesGeminiApiImagePipeline(settings);
  const currentProviderModels =
    settings.llmProvider === 'custom' || usesGeminiApp ? [] : llmBuiltInProviderDefinitions[settings.llmProvider].models;
  const builtInCustomModelPlaceholder = currentProviderModels[0] ?? currentProfile.modelPreset;
  const currentThinkingModel =
    settings.llmProvider !== 'custom' &&
    settings.llmProvider !== 'gemini' &&
    !currentProfile.useCustomModel
      ? currentProfile.modelPreset
      : null;
  const currentThinkingControl = currentThinkingModel
    ? getLlmThinkingControl(settings.llmProvider, currentThinkingModel)
    : null;
  const currentThinkingLevel = currentThinkingModel
    ? resolveLlmThinkingLevel(
        settings.llmThinkingByModel,
        settings.llmProvider,
        currentThinkingModel,
      )
    : undefined;
  const currentThinkingCapabilityKey = currentThinkingModel
    ? llmThinkingCapabilityKey(settings.llmProvider, currentThinkingModel)
    : null;
  const currentThinkingOptionIndex = currentThinkingControl?.kind === 'slider'
    ? Math.max(
        0,
        currentThinkingControl.options.findIndex((option) => option.value === currentThinkingLevel),
      )
    : 0;
  const currentThinkingOptionProgress = currentThinkingControl?.kind === 'slider'
    && currentThinkingControl.options.length > 1
    ? (currentThinkingOptionIndex / (currentThinkingControl.options.length - 1)) * 100
    : 0;
  const currentThinkingFillHidden = currentThinkingOptionIndex === 0
    && thinkingFillReturningToOffKey !== currentThinkingCapabilityKey;
  const activeAuthorizationTarget = resolveProviderAuthorizationTarget(settings);
  const usesOpenAiOAuth = activeAuthorizationTarget === 'openai-oauth';
  const stageTimingDetailsLocked = usesNanoBanana;
  const stageTimingDetailsDisabled = loading || !settings.showElapsedTime || stageTimingDetailsLocked;
  const localDebugOptionsLocked = usesNanoBanana;
  const localDebugOptionsDisabled = loading || localDebugOptionsLocked;
  // 「记录原文 / 译文」是「诊断日志」的子项：父开关没开就不能勾（照「阶段明细 → 显示耗时」）。
  const debugLogLocked = loading || !settings.enableDebugLog;

  // 「模型来源」不新增存储字段：它就是 provider + baseUrl 的派生结果。
  // 本机 Base URL + 自定义提供商 == 本地模型；其余一律算在线模型。
  const isLocalModelSource =
    settings.llmProvider === 'custom' && isLocalBase(currentProfile.customBaseUrl);
  const modelSource: 'online' | 'local' = isLocalModelSource ? 'local' : 'online';

  // 语言固定为简体中文（「语言」那块 UI 已移除）。服务/模式已从类型上收敛成常量，
  // 不需要在这里自愈了。用 ref 保证只跑一次，避免反复写盘。
  const forcedDefaultsRef = useRef(false);
  useEffect(() => {
    if (loading || forcedDefaultsRef.current) return;
    forcedDefaultsRef.current = true;
    if (settings.targetLang !== 'zh-CHS') updateField('targetLang', 'zh-CHS');
  }, [loading, settings.targetLang]);

  // 本地模型不需要真实 Key：空着就自动填占位符，避免被"缺 Key"卡住。
  // 走 updateActiveApiKey（本地模式下 active provider 就是 custom），不手写内部状态。
  useEffect(() => {
    if (loading || !isLocalModelSource) return;
    const stored = apiKeyValues['custom'];
    if (stored !== undefined && stored.trim() !== '') return;
    updateActiveApiKey(LOCAL_API_KEY_PLACEHOLDER);
  }, [loading, isLocalModelSource, apiKeyValues]);
  const openAiStatusLabel = openAiStatus.loading
    ? '正在检查 OpenAI 登录'
    : openAiStatus.authenticated
      ? openAiStatus.email ?? '已登录 OpenAI'
      : openAiStatus.error
        ? openAiStatus.error
        : openAiStatus.pending
          ? '等待 OpenAI 授权完成'
          : '未登录 OpenAI';
  const geminiStatusLabel = geminiAppStatus.loading
    ? '正在检查'
    : geminiAppStatus.authenticated
      ? 'Gemini已登录'
      : geminiAppStatus.error
        ? geminiAppStatus.error
        : geminiAppStatus.pending
          ? '未登录'
          : '未登录';
  const extensionRuntime = getExtensionRuntime();
  const extensionVersion = extensionRuntime?.getVersion() ?? '';

  function openShortcutManager(): void {
    if (!extensionRuntime) {
      setStatus({ kind: 'error', message: '无法打开扩展命令管理页' });
      return;
    }
    void extensionRuntime.openShortcutSettings().catch((error: unknown) => {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function persistSettings(
    nextSettings: ExtensionSettingsProjection,
    options: PersistSettingsOptions = {},
  ): Promise<void> {
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    if (options.silent) {
      setStatus((prev) => (prev.kind === 'saving' || prev.kind === 'success' ? { kind: 'idle', message: '' } : prev));
    } else {
      setStatus({ kind: 'saving', message: '正在自动保存...' });
    }
    try {
      const projection = await getControlClient().replaceSettings(nextSettings);
      applyAccessProjection(projection);
      committedSettingsRef.current = projection.settings;
      if (saveRequestIdRef.current === requestId) {
        settingsDirtyRef.current = false;
        skipNextSettingsPersistenceRef.current = true;
        setSettings(projection.settings);
        if (!options.silent) {
          setStatus({ kind: 'success', message: '已自动保存' });
        }
      }
    } catch (error) {
      if (
        saveRequestIdRef.current === requestId
        && isExtensionSettingsConflict(error)
      ) {
        try {
          const latest = await getControlClient().read();
          const rebased = rebaseExtensionSettingsProjection(
            committedSettingsRef.current,
            nextSettings,
            latest.settings,
          );
          committedSettingsRef.current = latest.settings;
          applyAccessProjection(latest);
          settingsDirtyRef.current = true;
          nextSaveShowsStatusRef.current = true;
          setStatus({ kind: 'saving', message: '检测到并发修改，正在合并并重试...' });
          setSettings(rebased);
          return;
        } catch (refreshError) {
          error = refreshError;
        }
      }
      if (saveRequestIdRef.current === requestId) {
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function downloadDiagnosticLog(): Promise<void> {
    setStatus({ kind: 'saving', message: '正在准备日志...' });
    try {
      const log = await exportDiagnosticLog();
      if (log.eventCount === 0) {
        setStatus({ kind: 'error', message: '暂无可下载日志，请先开启诊断日志并执行一次翻译' });
        return;
      }
      downloadText(log.text, log.filenamePrefix);
      setStatus({ kind: 'success', message: '日志已下载' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 导出支持包：把「扩展环境 + 脱敏设置 + 本机服务事件」拼成一个 JSON 下载。
   *
   * 服务端那一半从本机 `11436/support` 取 —— popup 是扩展页面（不受页面 CSP 约束），
   * `host_permissions` 又是 `<all_urls>`，发得出去。
   * 取不到**不静默**：写进 `serverError` 并让 summary 说明，让人一眼看出
   * 「是没连上」而不是「事件确实是空的」（supportBundle 的铁律）。
   */
  async function downloadSupportBundle(): Promise<void> {
    setStatus({ kind: 'saving', message: '正在收集支持信息...' });
    let server: Awaited<ReturnType<typeof fetchServerSupport>> | null = null;
    let serverError: string | undefined;
    try {
      server = await fetchServerSupport(resolveSupportServerBase());
    } catch (error) {
      serverError = error instanceof Error ? error.message : String(error);
    }
    try {
      const bundle = buildSupportBundle({
        env: {
          extensionVersion: getExtensionRuntime()?.getVersion() ?? '',
          browser: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        // `settings` 在这里是投影（`PublicLlmProviderProfile` 已剥掉 apiKey），可安全外带。
        settings,
        server,
        ...(serverError !== undefined ? { serverError } : {}),
      });
      downloadJson(bundle, supportBundleFilenamePrefix);
      setStatus({
        kind: 'success',
        message: server ? '支持包已下载' : `支持包已下载（本机服务未取到：${serverError}）`,
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function clearDiagnosticLog(): Promise<void> {
    if (!window.confirm('确定要清空已保存的诊断日志吗？')) {
      return;
    }

    setStatus({ kind: 'saving', message: '正在清空日志...' });
    try {
      await clearStoredDiagnosticLog();
      setStatus({ kind: 'success', message: '日志已清空' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  useEffect(() => {
    if (loading || !activeAuthorizationTarget) return;
    if (activeAuthorizationTarget === 'openai-oauth') {
      void refreshOpenAiOAuthStatus();
      return;
    }
    void refreshGeminiAppAuthStatus();
  }, [loading, activeAuthorizationTarget]);

  useEffect(() => {
    if (loading || currentProfile.authMode !== 'api_key') return;
    const provider = settings.llmProvider;
    let active = true;
    void getControlClient().revealApiKey(provider)
      .then((apiKey) => {
        if (!active || apiKeyDirtyRef.current[provider]) return;
        apiKeyValuesRef.current = {
          ...apiKeyValuesRef.current,
          [provider]: apiKey,
        };
        setApiKeyValues((current) => ({ ...current, [provider]: apiKey }));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      active = false;
    };
  }, [loading, settings.llmProvider, currentProfile.authMode]);

  useEffect(() => {
    if (loading) {
      return;
    }
    if (!hasHydratedRef.current) {
      hasHydratedRef.current = true;
      return;
    }
    if (skipNextSettingsPersistenceRef.current) {
      skipNextSettingsPersistenceRef.current = false;
      return;
    }

    const showSaveStatus = nextSaveShowsStatusRef.current;
    nextSaveShowsStatusRef.current = false;
    void persistSettings(settings, { silent: !showSaveStatus });
  }, [loading, settings]);

  useEffect(() => {
    const timeoutIds = llmProviderOptions.flatMap(({ value: provider }) => {
      const apiKey = apiKeyValuesRef.current[provider];
      if (!apiKeyDirtyRef.current[provider] || apiKey === undefined) return [];
      return [window.setTimeout(() => {
        const operation = apiKey.trim().length > 0
          ? getControlClient().replaceApiKey(provider, apiKey)
          : getControlClient().clearApiKey(provider);
        void operation
          .then((projection) => {
            applyAccessProjection(projection);
            if (apiKeyValuesRef.current[provider] === apiKey) {
              apiKeyDirtyRef.current[provider] = false;
              const hasPendingSave = Object.values(apiKeyDirtyRef.current).some(Boolean);
              if (!hasPendingSave) {
                setStatus({
                  kind: 'success',
                  message: '已自动保存',
                });
              }
            }
          })
          .catch((error: unknown) => {
            setStatus({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }, 500)];
    });
    return () => {
      for (const timeoutId of timeoutIds) window.clearTimeout(timeoutId);
    };
  }, [apiKeyEditVersion]);

  return (
    <main className="popup">
      {status.message ? (
        <div className={`status-bubble status-${status.kind}`}>{status.message}</div>
      ) : null}
      <header className="popup-header">
        <div className="popup-header-brand">
          <img className="popup-header-logo" src="icons/icon128.png" alt="" aria-hidden="true" />
          <div className="popup-header-text">
            <h1>
              <img className="popup-header-wordmark" src="brand/dmb-wordmark.svg" alt="dmbTranslator" />
            </h1>
            <p className="subtitle">漫画图片翻译助手</p>
          </div>
        </div>
        <div className="popup-header-meta">
          <a
            className="popup-header-github"
            href="https://github.com/Legumina233/dmbTranslator"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
          >
            <IconGitHub />
          </a>
          {extensionVersion ? <span className="popup-header-version">v{extensionVersion}</span> : null}
        </div>
      </header>

      <div className="popup-body">
        {loading ? (
          <p className="loading-text">正在读取配置…</p>
        ) : (
          <>
            {settings.translator === 'llm' ? (
              <section className="panel panel-llm">
                <div className="panel-title panel-title-with-shortcuts">
                  <span className="panel-title-copy">
                    <IconLLM />
                    大模型配置
                  </span>
                  <button
                    className={`panel-title-shortcuts${shortcutError ? ' panel-title-shortcuts-error' : ''}`}
                    type="button"
                    onClick={openShortcutManager}
                    title={shortcutError || '打开 Chrome 扩展命令管理页'}
                    aria-label="管理扩展命令"
                  >
                    {shortcutCommandDefinitions.map((definition) => {
                      const shortcut = shortcuts[definition.name];
                      return (
                        <span className="panel-title-shortcut-row" key={definition.name}>
                          <span className="panel-title-shortcut-label">{definition.label}</span>
                          <kbd className={`panel-title-shortcut-key${!shortcutsLoading && !shortcut ? ' panel-title-shortcut-key-unbound' : ''}`}>
                            {shortcutsLoading ? '读取中' : shortcut || '未绑定'}
                          </kbd>
                        </span>
                      );
                    })}
                  </button>
                </div>

                <div className="setting-row">
                  <span className="field-label">模型来源</span>
                  <SegmentedControl
                    options={[
                      { value: 'online', label: '在线模型' },
                      { value: 'local', label: '本地模型' },
                    ]}
                    value={modelSource}
                    onChange={(value) => switchModelSource(value as 'online' | 'local')}
                    disabled={loading}
                  />
                </div>

                {modelSource === 'local' ? (
                  <>
                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input type="text" value={currentProfile.customBaseUrl} disabled />
                    </label>
                    <LocalModelControl
                      baseUrl={currentProfile.customBaseUrl}
                      model={currentProfile.modelCustom}
                      onPickModel={(nextModel) =>
                        updateActiveLlmProfile({ modelCustom: nextModel }, { showSaveStatus: true })
                      }
                      cacheLimit={settings.translationCacheLimit}
                      onCacheLimitChange={(nextLimit) =>
                        updateField('translationCacheLimit', nextLimit)
                      }
                      prefetchDepth={settings.prefetchDepth}
                      onPrefetchDepthChange={(nextDepth) =>
                        updateField('prefetchDepth', nextDepth)
                      }
                      autoTranslateOnEnter={settings.autoTranslateOnEnter}
                      onAutoTranslateOnEnterChange={(enabled) =>
                        updateField('autoTranslateOnEnter', enabled)
                      }
                    />
                  </>
                ) : (
                  <>
                <div className="field">
                  <span className="field-label">LLM 提供商</span>
                  <SelectControl
                    ariaLabel="LLM 提供商"
                    options={llmProviderOptions}
                    value={settings.llmProvider}
                    onChange={updateLlmProvider}
                    disabled={loading}
                  />
                </div>

                {settings.llmProvider === 'gemini' ? (
                  <>
                    <div className="auth-mode-field">
                      <span className="field-label">认证方式</span>
                      <SegmentedControl<LlmAuthMode>
                        options={[
                          { value: 'gemini_app', label: 'Gemini 登录' },
                          { value: 'api_key', label: 'API Key' },
                        ]}
                        value={currentProfile.authMode}
                        onChange={(value) => updateActiveLlmProfile({ authMode: value })}
                        disabled={loading}
                      />
                    </div>
                    <div className="auth-mode-field">
                      <span className="field-label">模型</span>
                      <SegmentedControl<ExtensionSettingsProjection['geminiAppModel']>
                        options={geminiAppModelOptions}
                        value={settings.geminiAppModel}
                        onChange={(value) => updateField('geminiAppModel', value)}
                        disabled={loading}
                      />
                    </div>
                    {usesGeminiApp ? (
                      <>
                        <div className="auth-status-row">
                          <span className="field-label">登录状态</span>
                          <div className="auth-status-control">
                            <div className="oauth-copy">
                              <span className={`oauth-dot${geminiAppStatus.authenticated ? ' oauth-dot-authed' : ''}`} />
                              <div className="oauth-title">{geminiStatusLabel}</div>
                            </div>
                            <button
                              className="oauth-action"
                              type="button"
                              onClick={() => {
                                void (
                                  geminiAppStatus.authenticated || geminiAppStatus.pending
                                    ? refreshGeminiAppAuthStatus()
                                    : loginGeminiApp()
                                );
                              }}
                              disabled={loading || geminiAppStatus.loading || geminiAppStatus.busy}
                            >
                              {geminiAppStatus.busy
                                ? '处理中...'
                                : geminiAppStatus.authenticated || geminiAppStatus.pending
                                  ? '检查状态'
                                  : '登录 Gemini'}
                            </button>
                          </div>
                        </div>
                      </>
                    ) : null}
                    {usesGeminiApi ? (
                      <ApiKeyField
                        key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                        value={apiKeyValues[settings.llmProvider] ?? ''}
                        onChange={updateActiveApiKey}
                        disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                        placeholder="AIza..."
                      />
                    ) : null}
                    <div className="field">
                      <span className="field-label field-label-action">
                        <span>提示词</span>
                        <button
                          className="field-label-icon-button"
                          type="button"
                          onClick={resetGeminiAppPromptTemplate}
                          disabled={loading}
                          title="重置提示词"
                          aria-label="重置提示词"
                        >
                          <IconRefresh />
                        </button>
                      </span>
                      <textarea
                        value={settings.geminiAppPromptTemplate}
                        onChange={(event) =>
                          updateField('geminiAppPromptTemplate', event.target.value, { showSaveStatus: true })
                        }
                        disabled={loading}
                        rows={5}
                      />
                    </div>
                  </>
                ) : settings.llmProvider === 'custom' ? (
                  <>
                    <label className="field">
                      <span className="field-label">Base URL</span>
                      <input
                        type="text"
                        value={currentProfile.customBaseUrl}
                        onChange={(event) =>
                          updateActiveLlmProfile({ customBaseUrl: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                    <label className="field">
                      <span className="field-label">模型名称</span>
                      <input
                        type="text"
                        value={currentProfile.modelCustom}
                        onChange={(event) =>
                          updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                        }
                        disabled={loading}
                        placeholder="例如：your-model-name"
                      />
                    </label>
                    <ApiKeyField
                      key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                      value={apiKeyValues[settings.llmProvider] ?? ''}
                      onChange={updateActiveApiKey}
                      disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                      placeholder="sk-..."
                    />
                  </>
                ) : (
                  <>
                    {settings.llmProvider === 'openai' ? (
                      <div className="auth-mode-field">
                        <span className="field-label">认证方式</span>
                        <SegmentedControl<LlmAuthMode>
                          options={[
                            { value: 'openai_oauth', label: 'OpenAI 登录' },
                            { value: 'api_key', label: 'API Key' },
                          ]}
                          value={currentProfile.authMode}
                          onChange={(value) => updateActiveLlmProfile({ authMode: value })}
                          disabled={loading}
                        />
                      </div>
                    ) : null}
                    {usesOpenAiOAuth ? (
                      <div className="auth-status-row">
                        <span className="field-label">登录状态</span>
                        <div className="auth-status-control">
                          <div className="oauth-copy">
                            <span className={`oauth-dot${openAiStatus.authenticated ? ' oauth-dot-authed' : ''}`} />
                            <div className="oauth-title">{openAiStatusLabel}</div>
                          </div>
                          <button
                            className="oauth-action"
                            type="button"
                            onClick={() => {
                              void (
                                openAiStatus.authenticated
                                  ? logoutOpenAiOAuth()
                                  : openAiStatus.pending
                                    ? refreshOpenAiOAuthStatus()
                                    : loginOpenAiOAuth()
                              );
                            }}
                            disabled={loading || openAiStatus.loading || openAiStatus.busy}
                          >
                            {openAiStatus.busy
                              ? '处理中...'
                              : openAiStatus.authenticated
                                ? '退出登录'
                                : openAiStatus.pending
                                  ? '检查状态'
                                  : '登录 OpenAI'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="field model-field">
                      <span className="field-label">模型名称</span>
                      <div className="model-control">
                        {currentProfile.useCustomModel ? (
                          <input
                            type="text"
                            value={currentProfile.modelCustom}
                            onChange={(event) =>
                              updateActiveLlmProfile({ modelCustom: event.target.value }, { showSaveStatus: true })
                            }
                            disabled={loading}
                            placeholder={builtInCustomModelPlaceholder}
                          />
                        ) : (
                          <SelectControl
                            ariaLabel="模型名称"
                            options={currentProviderModels.map((model) => ({ value: model, label: model }))}
                            value={currentProfile.modelPreset}
                            onChange={(modelPreset) => updateActiveLlmProfile({ modelPreset })}
                            disabled={loading}
                          />
                        )}
                        <label className={`custom-model-toggle${loading ? ' custom-model-toggle-disabled' : ''}`}>
                          <input
                            type="checkbox"
                            checked={currentProfile.useCustomModel}
                            onChange={(event) => updateUseCustomModel(event.target.checked)}
                            disabled={loading}
                          />
                          <span>自定义</span>
                        </label>
                      </div>
                    </div>
                    {currentThinkingModel && currentThinkingControl && currentThinkingLevel ? (
                      <div className="field thinking-field">
                        <span className="field-label">思考强度</span>
                        {currentThinkingControl.kind === 'fixed' ? (
                          <span className="thinking-fixed-notice">{currentThinkingControl.notice}</span>
                        ) : currentThinkingControl.kind === 'toggle' ? (
                          <SegmentedControl<LlmThinkingLevel>
                            options={currentThinkingControl.options}
                            value={currentThinkingLevel}
                            onChange={(level) => updateThinkingLevel(
                              settings.llmProvider,
                              currentThinkingModel,
                              level,
                            )}
                            disabled={loading}
                          />
                        ) : (
                          <div className="thinking-slider-control">
                            <div className="thinking-slider-track">
                              <div className="thinking-slider-rail" aria-hidden="true">
                                <span className="thinking-slider-fill-mask">
                                  <span
                                    className={`thinking-slider-fill${
                                      currentThinkingFillHidden
                                        ? ' thinking-slider-fill-hidden'
                                        : ''
                                    }`}
                                    style={{
                                      clipPath: `inset(0 calc(${
                                        100 - currentThinkingOptionProgress
                                      }% + ${
                                        currentThinkingOptionProgress * 0.2 - 10
                                      }px) 0 0)`,
                                    }}
                                    onTransitionEnd={(event) => {
                                      if (
                                        event.propertyName === 'clip-path'
                                        && currentThinkingOptionIndex === 0
                                        && thinkingFillReturningToOffKey === currentThinkingCapabilityKey
                                      ) {
                                        setThinkingFillReturningToOffKey(null);
                                      }
                                    }}
                                  />
                                </span>
                                <span className="thinking-slider-ticks">
                                  {currentThinkingControl.options.map((option, index) => (
                                    <span
                                      className={`thinking-slider-tick${
                                        index <= currentThinkingOptionIndex
                                          ? ' thinking-slider-tick-active'
                                          : ''
                                      }${
                                        index === currentThinkingOptionIndex
                                          ? ' thinking-slider-tick-selected'
                                          : ''
                                      }`}
                                      key={option.value}
                                      style={{
                                        left: `${(index / (currentThinkingControl.options.length - 1)) * 100}%`,
                                      }}
                                    />
                                  ))}
                                </span>
                              </div>
                              <input
                                className="thinking-slider"
                                type="range"
                                min={0}
                                max={currentThinkingControl.options.length - 1}
                                step={1}
                                value={currentThinkingOptionIndex}
                                onChange={(event) => {
                                  const option = currentThinkingControl.options[Number(event.target.value)];
                                  if (option) {
                                    updateThinkingLevel(
                                      settings.llmProvider,
                                      currentThinkingModel,
                                      option.value,
                                    );
                                  }
                                }}
                                aria-label="思考强度"
                                aria-valuetext={
                                  currentThinkingControl.options[currentThinkingOptionIndex]?.label
                                }
                                disabled={loading}
                              />
                              <span
                                className="thinking-slider-thumb"
                                style={{
                                  translate: `calc(-50% + ${currentThinkingOptionProgress}cqw - ${
                                    currentThinkingOptionProgress * 0.2
                                  }px) -50%`,
                                }}
                                aria-hidden="true"
                              />
                            </div>
                            <div className="thinking-slider-labels" aria-hidden="true">
                              {currentThinkingControl.options.map((option, index) => (
                                <span
                                  className={`thinking-slider-label${
                                    index === currentThinkingOptionIndex
                                      ? ' thinking-slider-label-active'
                                      : ''
                                  }`}
                                  key={option.value}
                                  style={{
                                    left: `${(index / (currentThinkingControl.options.length - 1)) * 100}%`,
                                  }}
                                >
                                  {option.label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : null}
                    {!usesOpenAiOAuth ? (
                      <ApiKeyField
                        key={`api-key-${settings.llmProvider}-${currentProfile.authMode}`}
                        value={apiKeyValues[settings.llmProvider] ?? ''}
                        onChange={updateActiveApiKey}
                        disabled={loading || apiKeyValues[settings.llmProvider] === undefined}
                        placeholder="sk-..."
                      />
                    ) : null}
                  </>
                )}
                  </>
                )}
              </section>
            ) : null}

            <div className="debug-footer">
              <div className="debug-compact">
                <button
                  className={`debug-toggle${settings.debugOptionsExpanded ? ' debug-toggle-open' : ''}`}
                  onClick={() => updateField('debugOptionsExpanded', !settings.debugOptionsExpanded)}
                  type="button"
                >
                  <IconDebug />
                  调试选项
                  <svg className="debug-chevron" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 1L5 5L9 1" />
                  </svg>
                </button>
                {settings.debugOptionsExpanded && (
                  <div className="debug-row">
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={settings.showElapsedTime}
                        onChange={(event) => updateElapsedTime(event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">显示耗时</span>
                    </label>
                    <label className={`checkbox-row${stageTimingDetailsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!stageTimingDetailsLocked && settings.showStageTimingDetails}
                        onChange={(event) => updateField('showStageTimingDetails', event.target.checked)}
                        disabled={stageTimingDetailsDisabled}
                      />
                      <span className="checkbox-label">阶段明细</span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.showTypesetDebug}
                        onChange={(event) => updateField('showTypesetDebug', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">排版调试</span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.showEraseDebug}
                        onChange={(event) => updateField('showEraseDebug', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">去字调试</span>
                    </label>
                    <label
                      className={`checkbox-row${loading ? ' checkbox-disabled' : ''}`}
                      title="本机事件日志：把排障事件发到本机服务，落 logs/events"
                    >
                      <input
                        type="checkbox"
                        checked={settings.eventLogEnabled}
                        onChange={(event) => updateField('eventLogEnabled', event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">
                        事件日志
                        <span className="checkbox-hint">本机服务</span>
                      </span>
                    </label>
                    <label
                      className={`checkbox-row${loading ? ' checkbox-disabled' : ''}`}
                      title="诊断日志：存扩展本地存储，弹窗「下载日志」导出"
                    >
                      <input
                        type="checkbox"
                        checked={settings.enableDebugLog}
                        onChange={(event) => updateDebugLog(event.target.checked)}
                        disabled={loading}
                      />
                      <span className="checkbox-label">
                        诊断日志
                        <span className="checkbox-hint">扩展本地</span>
                      </span>
                    </label>
                    <label
                      className={`checkbox-row checkbox-row-nested${debugLogLocked ? ' checkbox-disabled' : ''}`}
                      title="记录原文 / 译文：把逐行日文原文与中文译文写进上面的日志（隐私项，需先开诊断日志）"
                    >
                      <input
                        type="checkbox"
                        checked={settings.enableDebugLog && settings.logSourceText}
                        onChange={(event) => updateField('logSourceText', event.target.checked)}
                        disabled={loading || !settings.enableDebugLog}
                      />
                      <span className="checkbox-label">
                        记录原文译文
                        <span className="checkbox-hint">默认关</span>
                      </span>
                    </label>
                    <label className={`checkbox-row${localDebugOptionsDisabled ? ' checkbox-disabled' : ''}`}>
                      <input
                        type="checkbox"
                        checked={!localDebugOptionsLocked && settings.disableOcrPostFilter}
                        onChange={(event) => updateField('disableOcrPostFilter', event.target.checked)}
                        disabled={localDebugOptionsDisabled}
                      />
                      <span className="checkbox-label">关后处理</span>
                    </label>
                  </div>
                )}
                {settings.debugOptionsExpanded && (
                  <div className="debug-actions">
                    <button
                      className="debug-download-button"
                      type="button"
                      onClick={() => void downloadDiagnosticLog()}
                      disabled={loading || !settings.enableDebugLog}
                      title={settings.enableDebugLog ? undefined : '需先打开上面的「诊断日志」'}
                    >
                      <IconDownload />
                      下载日志
                    </button>
                    <button
                      className="debug-download-button"
                      type="button"
                      onClick={() => void downloadSupportBundle()}
                      disabled={loading}
                      title="把扩展环境、脱敏设置与本机服务的排障事件打包成一个 JSON（服务端未起时照常导出，并在包内注明）"
                    >
                      <IconDownload />
                      导出支持包
                    </button>
                    <button
                      className="debug-download-button"
                      type="button"
                      onClick={() => void clearDiagnosticLog()}
                      disabled={loading || !settings.enableDebugLog}
                      title={settings.enableDebugLog ? undefined : '需先打开上面的「诊断日志」'}
                    >
                      <IconTrash />
                      清空日志
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
