import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getExtensionRuntime,
  guardExtensionListener,
  guardRegistration,
  isExtensionContextInvalidated,
  type ExtensionBrowserApi,
} from '../../apps/extension/src/shared/extensionRuntime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExtensionRuntime', () => {
  it('normalizes callback-style Chromium messages and runtime errors', async () => {
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getManifest: () => ({ version: '1.2.3' }),
        sendMessage: (_message: unknown, callback?: (value: unknown) => void) => {
          callback?.({ ok: true });
        },
      },
    };
    vi.stubGlobal('chrome', api);

    const runtime = getExtensionRuntime();
    await expect(runtime?.sendMessage({ type: 'ping' })).resolves.toEqual({ ok: true });
    expect(runtime?.getURL('worker.js')).toBe('chrome-extension://test/worker.js');
    expect(runtime?.getVersion()).toBe('1.2.3');

    api.runtime!.lastError = { message: 'port closed' };
    await expect(runtime?.sendMessage({ type: 'ping' })).rejects.toThrow('port closed');
  });

  it('normalizes Firefox Promise APIs and uses its shortcut capability', async () => {
    const openShortcutSettings = vi.fn(async () => undefined);
    const createTab = vi.fn(async () => ({}));
    const api = {
      runtime: {
        getURL: (path: string) => `moz-extension://test/${path}`,
        sendMessage: vi.fn(async () => ({ ok: true })),
      },
      commands: { openShortcutSettings },
      tabs: { create: createTab },
    } satisfies ExtensionBrowserApi;
    vi.stubGlobal('browser', api);

    const runtime = getExtensionRuntime();
    await expect(runtime?.sendMessage({ type: 'ping' })).resolves.toEqual({ ok: true });
    await runtime?.openShortcutSettings();
    expect(openShortcutSettings).toHaveBeenCalledOnce();
    expect(createTab).not.toHaveBeenCalled();
  });

  it('keeps the Chromium internal shortcut URL inside the adapter', async () => {
    const createTab = vi.fn((
      _properties: { url?: string; active?: boolean },
      callback?: (tab: { id?: number }) => void,
    ) => callback?.({ id: 1 }));
    const api = { runtime: {}, tabs: { create: createTab } } satisfies ExtensionBrowserApi;
    vi.stubGlobal('chrome', api);

    await getExtensionRuntime()?.openShortcutSettings();
    expect(createTab).toHaveBeenCalledWith(
      { url: 'chrome://extensions/shortcuts', active: true },
      expect.any(Function),
    );
  });
});

describe('isExtensionContextInvalidated', () => {
  it('识别 Chrome 重载后的 context invalidated 错误', () => {
    expect(isExtensionContextInvalidated(new Error('Extension context invalidated.'))).toBe(true);
  });

  it('普通错误、非 Error 值 → false', () => {
    expect(isExtensionContextInvalidated(new Error('网络超时'))).toBe(false);
    expect(isExtensionContextInvalidated(new TypeError('undefined is not a function'))).toBe(false);
    expect(isExtensionContextInvalidated('Extension context invalidated.')).toBe(false);
    expect(isExtensionContextInvalidated(null)).toBe(false);
    expect(isExtensionContextInvalidated(undefined)).toBe(false);
  });
});

describe('guardExtensionListener', () => {
  it('回调里的 context invalidated 静默吞掉，不再飞成 Error in event handler', () => {
    const listener = guardExtensionListener((_port: unknown) => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => listener({ name: 'x' })).not.toThrow();
  });

  it('其余错误照常抛出，不掩盖真问题', () => {
    const listener = guardExtensionListener(() => {
      throw new TypeError('boom');
    });
    expect(() => listener()).toThrow(TypeError);
  });

  it('正常回调照原样执行并透传参数', () => {
    const seen: string[] = [];
    const listener = guardExtensionListener((value: string) => {
      seen.push(value);
    });
    listener('a');
    listener('b');
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('guardRegistration', () => {
  it('注册成功返回 true', () => {
    const addListener = vi.fn();
    expect(guardRegistration(() => addListener(() => {}))).toBe(true);
    expect(addListener).toHaveBeenCalledTimes(1);
  });

  it('注册时抛 context invalidated（连 port.onDisconnect 属性访问都会抛）→ 返回 false 且不外抛', () => {
    const deadPort = {
      get onDisconnect(): { addListener: (listener: () => void) => void } {
        throw new Error('Extension context invalidated.');
      },
    };
    expect(guardRegistration(() => deadPort.onDisconnect.addListener(() => {}))).toBe(false);
  });

  it('注册时的其他错误照常抛出', () => {
    expect(() => guardRegistration(() => {
      throw new Error('端口名冲突');
    })).toThrow('端口名冲突');
  });
});
