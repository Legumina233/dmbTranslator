import { getExtensionApi } from './extensionRuntime';

/**
 * 本机服务的「状态查询」与「启停操作」走两条完全不同的路 —— 这是有意为之：
 *
 * · 状态查询：**HTTP 探活**。GET dmb_server 的 /health、GET Ollama **独立服务**的 /health，
 *   能响应就是在跑。不经过任何本机进程 → **不会弹终端窗口**，可以放心高频轮询。
 *   （之前状态也走 Native Messaging，结果扩展每 3s 轮询一次 = Chrome 每 3s 拉起一次宿主
 *    = 每 3s 弹一个控制台又关掉，用户看到的就是"终端不断开关"。）
 *
 * · 启停操作：**Native Messaging**。浏览器扩展不能启动本机进程，
 *   "点一下就启动"唯一可行的机制就是让浏览器按需拉起宿主（server/native_host.py）。
 *   只在用户点开关时调用，所以窗口只闪一下（且发生在用户主动操作时）。
 *
 * 宿主要装一次：scripts/install_native_host.py
 */

export const NATIVE_HOST_NAME = 'com.dmb.translator';
export const HOST_INSTALL_HINT = '宿主未安装（先运行 scripts/install_native_host.py）';

/** Ollama 引擎固定端口（只有 ollama 服务自己用；扩展不直接探它） */
export const OLLAMA_PORT = 11434;

/**
 * ★ Ollama 独立服务端口（2026-10-04 拆分出来的那个服务）。
 * 模型加载/卸载/状态与 ollama 启停都归它，与 dmb_server（OCR/翻译）各自开关、互不依赖。
 */
export const OLLAMA_SERVICE_PORT = 11437;

/** 由 dmb_server 的地址推出 Ollama 独立服务地址（同主机、固定端口）。 */
export function ollamaServiceBase(serverBase = 'http://127.0.0.1:11436'): string {
  try {
    const url = new URL(serverBase);
    url.port = String(OLLAMA_SERVICE_PORT);
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
  } catch {
    return `http://127.0.0.1:${OLLAMA_SERVICE_PORT}`;
  }
}

export type ServiceState = {
  running: boolean;
};

export type LocalServicesState = {
  server: ServiceState;
  ollama: ServiceState;
};

export type ServiceKind = 'server' | 'ollama';

export type LocalServiceResult = {
  state: LocalServicesState | null;
  /** 启停失败的原因（宿主在但操作没成功 / 宿主没装），UI 负责展示 */
  error: string | null;
};

/** 探活：能拿到 HTTP 响应就算在跑。短暂超时即可，别拖慢 UI。 */
async function probe(url: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 查两个服务在不在跑。**纯 HTTP，不弹任何窗口**，轮询随便用。
 * `serverBase` 形如 http://127.0.0.1:11436（由当前 Base URL 推出）。
 */
export async function readLocalServices(
  serverBase = 'http://127.0.0.1:11436',
): Promise<LocalServicesState> {
  // ollama 这一项探的是**独立服务**（11437），不是引擎端口 11434：
  // 它就是扩展里那个 Ollama 开关的本体（引擎由它拉起/收掉）。
  const [server, ollama] = await Promise.all([
    probe(`${serverBase}/health`),
    probe(`${ollamaServiceBase(serverBase)}/health`),
  ]);
  return {
    server: { running: server },
    ollama: { running: ollama },
  };
}

function sendNative<T>(message: Record<string, unknown>): Promise<T> {
  const api = getExtensionApi();
  const send = api?.runtime?.sendNativeMessage;
  if (!send) {
    return Promise.reject(new Error(HOST_INSTALL_HINT));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const callback = (response: unknown) => {
      // chromium 的错误走 runtime.lastError，必须在回调里同步读取
      const lastError = api.runtime?.lastError;
      if (lastError?.message) {
        settle(() => reject(new Error(lastError.message as string)));
        return;
      }
      settle(() => resolve(response as T));
    };
    const maybePromise = send(NATIVE_HOST_NAME, message, callback) as Promise<unknown> | void;
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      (maybePromise as Promise<unknown>).then(
        (value) => settle(() => resolve(value as T)),
        (error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))),
      );
    }
  });
}

function toRunning(raw: unknown): boolean {
  return (raw as Record<string, unknown> | null | undefined)?.running === true;
}

/** 开/关某个本机服务（走 NM，用户点开关时才调用）。失败时带 error 供 UI 展示。 */
export async function setServiceEnabled(
  kind: ServiceKind,
  enabled: boolean,
): Promise<LocalServiceResult> {
  try {
    const reply = await sendNative<Record<string, unknown>>({
      action: 'setEnabled',
      target: kind,
      enabled,
    });
    if (!reply?.ok) {
      return { state: null, error: String(reply?.error ?? '宿主返回异常') };
    }
    const error = typeof reply.error === 'string' && reply.error ? reply.error : null;
    const state: LocalServicesState = {
      server: { running: toRunning(reply.server) },
      ollama: { running: toRunning(reply.ollama) },
    };
    return { state, error };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const hint = /host/i.test(message) ? `${message} —— ${HOST_INSTALL_HINT}` : message;
    return { state: null, error: hint };
  }
}
