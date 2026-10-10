type ExtensionContextMenuContext =
  | 'all'
  | 'page'
  | 'frame'
  | 'selection'
  | 'link'
  | 'editable'
  | 'image'
  | 'video'
  | 'audio';

export type ExtensionCommand = {
  name?: string;
  description?: string;
  shortcut?: string;
};

export type ExtensionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

export type ExtensionMessageSender = {
  documentId?: string;
  documentUrl?: string;
  frameId?: number;
  origin?: string;
  url?: string;
  tab?: {
    id?: number;
    windowId?: number;
    url?: string;
  };
};

export type ExtensionPort = {
  name: string;
  sender?: ExtensionMessageSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: {
    addListener: (listener: (message: unknown, port: ExtensionPort) => void) => void;
    removeListener?: (listener: (message: unknown, port: ExtensionPort) => void) => void;
  };
  onDisconnect: {
    addListener: (listener: (port: ExtensionPort) => void) => void;
    removeListener?: (listener: (port: ExtensionPort) => void) => void;
  };
};

export type ExtensionDnrRuleUpdate = {
  removeRuleIds: number[];
  addRules: Array<Record<string, unknown>>;
};

export type ExtensionWebRequestHeadersDetails = {
  documentId?: string;
  frameId?: number;
  tabId: number;
  url: string;
  responseHeaders?: Array<{
    name: string;
    value?: string;
  }>;
};

export type ExtensionPermissionRequest = {
  permissions?: string[];
  origins?: string[];
  data_collection?: string[];
};

export type ExtensionBrowserApi = {
  runtime?: {
    id?: string;
    getManifest?: () => { version?: string; manifest_version?: number };
    getURL?: (path: string) => string;
    connect?: (connectInfo?: { name?: string }) => ExtensionPort;
    getContexts?: (filter: {
      contextTypes?: Array<'OFFSCREEN_DOCUMENT' | 'BACKGROUND' | 'TAB' | 'POPUP'>;
      documentUrls?: string[];
    }) => Promise<Array<{
      contextType: string;
      documentId?: string;
      documentUrl?: string;
    }>>;
    sendMessage?: (
      message: unknown,
      callback?: (response: unknown) => void,
    ) => Promise<unknown> | void;
    /** 与本机宿主（server/native_host.py）单次通信：发一条消息、收一条回复、宿主自动退出 */
    sendNativeMessage?: (
      hostName: string,
      message: unknown,
      callback?: (response: unknown) => void,
    ) => Promise<unknown> | void;
    onConnect?: {
      addListener: (listener: (port: ExtensionPort) => void) => void;
    };
    onMessage?: {
      addListener: (
        listener: (
          message: unknown,
          sender: ExtensionMessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ) => void;
      removeListener: (
        listener: (
          message: unknown,
          sender: ExtensionMessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ) => void;
    };
    onInstalled?: {
      addListener: (listener: () => void) => void;
    };
    lastError?: { message?: string };
  };
  offscreen?: {
    createDocument?: (options: {
      url: string;
      reasons: Array<'WORKERS'>;
      justification: string;
    }) => Promise<void>;
    closeDocument?: () => Promise<void>;
  };
  permissions?: {
    contains?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
    request?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
    remove?: (
      request: ExtensionPermissionRequest,
      callback?: (result: boolean) => void,
    ) => Promise<boolean> | void;
    onAdded?: {
      addListener: (listener: (permissions: ExtensionPermissionRequest) => void) => void;
    };
    onRemoved?: {
      addListener: (listener: (permissions: ExtensionPermissionRequest) => void) => void;
    };
  };
  storage?: {
    local?: {
      get?: (keys: string | string[] | Record<string, unknown>, callback: (items: Record<string, unknown>) => void) => void;
      set?: (items: Record<string, unknown>, callback: () => void) => void;
      remove?: (keys: string | string[], callback: () => void) => void;
    };
    session?: {
      get?: (keys: string | string[] | Record<string, unknown>) => Promise<Record<string, unknown>>;
      set?: (items: Record<string, unknown>) => Promise<void>;
      remove?: (keys: string | string[]) => Promise<void>;
    };
  };
  tabs?: {
    query?: (
      queryInfo: { active?: boolean; windowId?: number },
      callback: (tabs: Array<{ id?: number }>) => void,
    ) => void;
    sendMessage?: (tabId: number, message: unknown) => Promise<unknown>;
    captureVisibleTab?: (
      windowId: number | undefined,
      options: { format: 'png' | 'jpeg' },
      callback: (dataUrl?: string) => void,
    ) => void;
    create?: (
      createProperties: { url?: string; active?: boolean },
      callback?: (tab: { id?: number }) => void,
    ) => Promise<{ id?: number }> | void;
    remove?: (tabId: number, callback?: () => void) => Promise<void> | void;
    onUpdated?: {
      addListener: (
        listener: (
          tabId: number,
          changeInfo: { url?: string; status?: 'loading' | 'complete' },
          tab: { url?: string },
        ) => void,
      ) => void;
    };
    onRemoved?: {
      addListener: (listener: (tabId: number, removeInfo: unknown) => void) => void;
    };
  };
  contextMenus?: {
    create?: (
      createProperties: {
        id: string;
        title: string;
        contexts?: ExtensionContextMenuContext[];
      },
      callback?: () => void,
    ) => string | number | void;
    removeAll?: (callback?: () => void) => Promise<void> | void;
    onClicked?: {
      addListener: (
        listener: (
          info: { menuItemId?: string | number },
          tab?: { id?: number },
        ) => void,
      ) => void;
    };
  };
  commands?: {
    getAll?: (callback?: (commands: ExtensionCommand[]) => void) => Promise<ExtensionCommand[]> | void;
    openShortcutSettings?: () => Promise<void>;
    onCommand?: {
      addListener: (listener: (command: string, tab?: { id?: number }) => void) => void;
    };
  };
  declarativeNetRequest?: {
    updateDynamicRules?: (options: ExtensionDnrRuleUpdate) => Promise<void>;
    updateSessionRules?: (options: ExtensionDnrRuleUpdate) => Promise<void>;
  };
  webRequest?: {
    onHeadersReceived?: {
      addListener: (
        listener: (details: ExtensionWebRequestHeadersDetails) => void,
        filter: { urls: string[]; types?: Array<'main_frame' | 'sub_frame'> },
        extraInfoSpec?: Array<'responseHeaders' | 'extraHeaders'>,
      ) => void;
    };
  };
  cookies?: {
    getAll?: (
      details: { url?: string; domain?: string; name?: string },
      callback?: (cookies: ExtensionCookie[]) => void,
    ) => Promise<ExtensionCookie[]> | void;
    onChanged?: {
      addListener: (listener: (changeInfo: { cookie: ExtensionCookie }) => void) => void;
    };
  };
  action?: {
    /** 按本地服务开关状态切换工具栏图标（见 shared/toolbarIcon.ts）。 */
    setIcon?: (details: {
      path?: Record<string, string>;
      imageData?: unknown;
    }) => Promise<void> | void;
  };
};

type ExtensionNamespace = typeof globalThis & {
  browser?: ExtensionBrowserApi;
  chrome?: ExtensionBrowserApi;
};

function resolveExtensionApi(): ExtensionBrowserApi | null {
  const scope = globalThis as ExtensionNamespace;
  // Firefox exposes the callback-compatible `chrome` namespace as well. Prefer it
  // so legacy APIs such as storage/cookies use one contract in both targets.
  return scope.chrome ?? scope.browser ?? null;
}

function usesPromiseNamespace(api: ExtensionBrowserApi): boolean {
  return (globalThis as ExtensionNamespace).browser === api;
}

export interface ExtensionRuntime {
  readonly api: ExtensionBrowserApi;
  getURL(path: string): string;
  getVersion(): string;
  connect(name: string): ExtensionPort;
  sendMessage<TResponse>(message: unknown): Promise<TResponse>;
  getLastErrorMessage(): string | undefined;
  getCommands(): Promise<ExtensionCommand[]>;
  openShortcutSettings(): Promise<void>;
}

function createExtensionRuntime(api: ExtensionBrowserApi): ExtensionRuntime {
  return {
    api,
    getURL(path) {
      const url = api.runtime?.getURL?.(path);
      if (!url) throw new Error('当前环境不支持扩展资源 URL');
      return url;
    },
    getVersion() {
      return api.runtime?.getManifest?.().version ?? '';
    },
    connect(name) {
      const port = api.runtime?.connect?.({ name });
      if (!port) throw new Error('当前环境不支持扩展 Port');
      return port;
    },
    sendMessage<TResponse>(message: unknown): Promise<TResponse> {
      const sendMessage = api.runtime?.sendMessage;
      if (!sendMessage) return Promise.reject(new Error('当前环境不支持扩展消息'));
      if (usesPromiseNamespace(api)) {
        return Promise.resolve(sendMessage(message) as Promise<unknown>) as Promise<TResponse>;
      }
      return new Promise<TResponse>((resolve, reject) => {
        sendMessage(message, (response) => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) {
            reject(new Error(runtimeError));
            return;
          }
          resolve(response as TResponse);
        });
      });
    },
    getLastErrorMessage() {
      return api.runtime?.lastError?.message;
    },
    getCommands() {
      const getAll = api.commands?.getAll;
      if (!getAll) return Promise.resolve([]);
      if (usesPromiseNamespace(api)) {
        return Promise.resolve(getAll() as Promise<ExtensionCommand[]>);
      }
      return new Promise((resolve, reject) => {
        getAll((commands) => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) reject(new Error(runtimeError));
          else resolve(commands);
        });
      });
    },
    async openShortcutSettings() {
      if (api.commands?.openShortcutSettings) {
        await api.commands.openShortcutSettings();
        return;
      }
      const createTab = api.tabs?.create;
      if (!createTab) throw new Error('当前浏览器不支持打开快捷键设置');
      if (usesPromiseNamespace(api)) {
        await createTab({ url: 'chrome://extensions/shortcuts', active: true });
        return;
      }
      await new Promise<void>((resolve, reject) => {
        createTab({ url: 'chrome://extensions/shortcuts', active: true }, () => {
          const runtimeError = api.runtime?.lastError?.message;
          if (runtimeError) reject(new Error(runtimeError));
          else resolve();
        });
      });
    },
  };
}

export function getExtensionRuntime(): ExtensionRuntime | null {
  const api = resolveExtensionApi();
  return api ? createExtensionRuntime(api) : null;
}

export function getExtensionAssetRuntime(): ExtensionRuntime | null {
  const runtime = getExtensionRuntime();
  return typeof runtime?.api.runtime?.getURL === 'function' ? runtime : null;
}

export function requireExtensionRuntime(): ExtensionRuntime {
  const runtime = getExtensionRuntime();
  if (!runtime) throw new Error('当前环境不支持浏览器扩展 API');
  return runtime;
}

export function getExtensionApi(): ExtensionBrowserApi | null {
  return getExtensionRuntime()?.api ?? null;
}

export function requireExtensionApi(): ExtensionBrowserApi {
  return requireExtensionRuntime().api;
}

/**
 * 判定一个错误是否为「扩展上下文已失效」—— 扩展被重载/更新后，残留的旧上下文
 * （旧 content script / 旧 offscreen 文档）调任何 chrome API 都会抛
 * `Extension context invalidated.`。
 *
 * 捕获到它时的正确做法是**静默退场**（注销监听、断开 observer、不再重连），
 * 而不是把控制台刷成错误海 —— 功能本身没坏，是新实例已经接管；残留上下文的
 * 使命到重载那一刻就结束了。
 */
export function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('Extension context invalidated');
}

/**
 * 包一层事件回调：回调里抛出的「上下文失效」静默吞掉，其余错误照常抛（不掩盖真问题）。
 *
 * 扩展重载 / 被卸载后，残留的旧上下文里任何 chrome.* 调用都会抛
 * "Extension context invalidated"，Chrome 会把它刷成 "Error in event handler"。
 * 这不是代码 bug，也没法在业务层预防，只能识别后静默退场。
 */
export function guardExtensionListener<A extends unknown[]>(
  listener: (...args: A) => void,
): (...args: A) => void {
  return (...args: A): void => {
    try {
      listener(...args);
    } catch (error) {
      if (!isExtensionContextInvalidated(error)) {
        throw error;
      }
    }
  };
}

/**
 * 把「注册监听器」这个动作本身包起来 —— **关键：保护必须在注册语句外侧**。
 *
 * 失效上下文里连 `port.onDisconnect` 这种**属性访问**都会抛，抛出点在
 * `addListener(...)` 这一层；写在回调**内部**的 try/catch 接不到，因为回调压根没被注册上。
 * （真机踩过：contentSessionLifecycle 的断开回调里早有 try/catch，报错照样飞出来。）
 *
 * 返回 false = 上下文已失效、没注册上；true = 注册成功。
 */
export function guardRegistration(register: () => void): boolean {
  try {
    register();
    return true;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      return false;
    }
    throw error;
  }
}
