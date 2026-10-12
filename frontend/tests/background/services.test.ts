import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionControlStateStorageKey,
  extensionInterfacePreferencesStorageKey,
  extensionProviderCredentialsStorageKey,
  extensionSettingsRevisionStorageKey,
  extensionTranslationDefaultsStorageKey,
  defaultExtensionSettings,
  extensionSettingsStorageKey,
  defaultPrefetchDepth,
  maxPrefetchDepth,
  minPrefetchDepth,
} from '../../apps/extension/src/shared/config';

// 预取设置的默认值（2026-10-09 起只剩"预载页数 + 进入自动翻译"两项）。
const defaultAutoTranslateOnEnter = defaultExtensionSettings.autoTranslateOnEnter;
import {
  syncPrefetchConfig,
} from '../../apps/extension/src/background/messages/prefetchConfig';
import type { ExtensionMessageSender } from '../../apps/extension/src/shared/extensionRuntime';
import {
  getSettings,
  getSettingsState,
  setSettings,
  setSettingsState,
} from '../../apps/extension/src/background/settings/settingsStore';
import {
  parseImageDataUrl,
} from '../../apps/extension/src/background/images/imageService';
import {
  openAiOAuthInstallationIdStorageKey,
  openAiOAuthLastErrorStorageKey,
  openAiOAuthPendingStorageKey,
  openAiOAuthStorageKey,
} from '../../apps/extension/src/background/openai/oauthService';
import {
  registerMenusAndCommands,
  startScreenshotTranslateCommand,
  translateHoverTargetCommand,
  translateImageMenuId,
  translateScreenshotMenuId,
} from '../../apps/extension/src/background/menus/registerMenus';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background stable identifiers', () => {
  it('preserves storage, menu, and command identifiers', () => {
    expect({
      openAiOAuthStorageKey,
      openAiOAuthPendingStorageKey,
      openAiOAuthLastErrorStorageKey,
      openAiOAuthInstallationIdStorageKey,
      translateImageMenuId,
      translateScreenshotMenuId,
      startScreenshotTranslateCommand,
      translateHoverTargetCommand,
    }).toEqual({
      openAiOAuthStorageKey: 'mangaTranslate.openaiOAuth',
      openAiOAuthPendingStorageKey: 'mangaTranslate.openaiOAuthPending',
      openAiOAuthLastErrorStorageKey: 'mangaTranslate.openaiOAuthLastError',
      openAiOAuthInstallationIdStorageKey: 'mangaTranslate.openaiOAuthInstallationId',
      translateImageMenuId: 'translate-image',
      translateScreenshotMenuId: 'translate-screenshot',
      startScreenshotTranslateCommand: 'start-screenshot-translate',
      translateHoverTargetCommand: 'translate-hover-target',
    });
  });

  it('registers menus and forwards menu/command actions with stable messages', async () => {
    const create = vi.fn();
    const sendMessage = vi.fn(async () => undefined);
    let onInstalled: (() => void) | undefined;
    let onClicked: ((info: { menuItemId?: string | number }, tab?: { id?: number }) => void) | undefined;
    let onCommand: ((command: string, tab?: { id?: number }) => void) | undefined;
    vi.stubGlobal('chrome', {
      runtime: {
        onInstalled: {
          addListener(listener: typeof onInstalled) {
            onInstalled = listener;
          },
        },
      },
      tabs: { sendMessage },
      contextMenus: {
        create,
        removeAll(callback?: () => void) {
          callback?.();
        },
        onClicked: {
          addListener(listener: typeof onClicked) {
            onClicked = listener;
          },
        },
      },
      commands: {
        onCommand: {
          addListener(listener: typeof onCommand) {
            onCommand = listener;
          },
        },
      },
    });

    registerMenusAndCommands();

    expect(create).not.toHaveBeenCalled();
    onInstalled?.();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: translateImageMenuId }));
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: translateScreenshotMenuId }));

    onClicked?.({ menuItemId: translateImageMenuId }, { id: 7 });
    onClicked?.({ menuItemId: translateScreenshotMenuId }, { id: 8 });
    onCommand?.(startScreenshotTranslateCommand, { id: 9 });
    onCommand?.(translateHoverTargetCommand, { id: 10 });
    await Promise.resolve();

    expect(sendMessage.mock.calls).toEqual([
      [7, { type: 'mt:context-menu-translate' }],
      [8, { type: 'mt:start-screenshot-translate' }],
      [9, { type: 'mt:start-screenshot-translate' }],
      [10, { type: 'mt:shortcut-translate-hover' }],
    ]);
  });
});

describe('settings store', () => {
  it('migrates legacy settings into one atomic control record with separate sections', async () => {
    const legacySettings = {
      ...defaultExtensionSettings,
      targetLang: 'zh-CHT' as const,
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'secret-key',
        },
      },
    };
    const storage: Record<string, unknown> = {
      [extensionSettingsStorageKey]: legacySettings,
    };
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get(keys: string, callback: (items: Record<string, unknown>) => void) {
            callback({ [keys]: storage[keys] });
          },
          set(items: Record<string, unknown>, callback: () => void) {
            Object.assign(storage, items);
            callback();
          },
          remove(keys: string | string[], callback: () => void) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
            callback();
          },
        },
      },
    });

    await expect(getSettings()).resolves.toEqual(legacySettings);
    expect(storage[extensionSettingsStorageKey]).toBeUndefined();
    const controlHead = storage[extensionControlStateStorageKey] as {
      schemaVersion: number;
      revision: number;
      generation: string;
    };
    expect(controlHead).toMatchObject({ schemaVersion: 1, revision: 0 });
    const translation = storage[`${extensionTranslationDefaultsStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, unknown>;
    };
    const credentials = storage[`${extensionProviderCredentialsStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, string>;
    };
    const preferences = storage[`${extensionInterfacePreferencesStorageKey}.${controlHead.generation}`] as {
      schemaVersion: number;
      value: Record<string, unknown>;
    };
    expect(translation.schemaVersion).toBe(1);
    expect(JSON.stringify(translation.value)).not.toContain('secret-key');
    expect(credentials).toEqual({ schemaVersion: 1, value: { deepseek: 'secret-key' } });
    expect(preferences.value).toMatchObject({
      showElapsedTime: false,
      stageTimingCardExpanded: true,
    });
    expect(storage[extensionTranslationDefaultsStorageKey]).toBeUndefined();
    expect(storage[extensionProviderCredentialsStorageKey]).toBeUndefined();
    expect(storage[extensionInterfacePreferencesStorageKey]).toBeUndefined();
    expect(storage[extensionSettingsRevisionStorageKey]).toBeUndefined();

    const nextSettings = { ...defaultExtensionSettings, targetLang: 'zh-CHT' as const };
    await expect(setSettings(nextSettings)).resolves.toEqual(nextSettings);
    const nextHead = storage[extensionControlStateStorageKey] as typeof controlHead;
    expect(nextHead).toMatchObject({ revision: 0 });
    expect(storage[`${extensionTranslationDefaultsStorageKey}.${nextHead.generation}`]).toMatchObject({
      schemaVersion: 1,
      value: { targetLang: 'zh-CHT' },
    });

    await setSettingsState({ settings: nextSettings, revision: 9 });
    await expect(getSettingsState()).resolves.toEqual({ settings: nextSettings, revision: 9 });
    expect(storage[extensionControlStateStorageKey]).toMatchObject({ revision: 9 });
  });
});

describe('image service', () => {
  it('parses screenshot data URLs', () => {
    expect(parseImageDataUrl('data:image/png;base64,aW1hZ2U=')).toEqual({
      contentType: 'image/png',
      base64: 'aW1hZ2U=',
    });
    expect(() => parseImageDataUrl('https://example.com/image.png')).toThrow('截图数据格式无效');
  });
});

/**
 * 页面右下角的预载开关靠 `mt:prefetch-config-sync` 读/写设置 —— 内容脚本拿不到 settings，
 * 光有弹窗那条单向推送（`mt:prefetch-config`）的话，开关既读不到当前值也写不回去。
 * 这里钉死三条边界：只读不回推 / 写入后回推的是 `mt:prefetch-config`（不是 -sync，否则互推死循环）
 * / 越界页数按 normalizePrefetchDepth 收敛。
 */
describe('prefetch config sync（页面右下角开关 → 设置）', () => {
  const sender: ExtensionMessageSender = { tab: { id: 7, windowId: 1 } };

  function stubChrome(): { pushed: Array<{ tabId: number; message: unknown }> } {
    const storage: Record<string, unknown> = {};
    const pushed: Array<{ tabId: number; message: unknown }> = [];
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get(keys: string[], callback: (items: Record<string, unknown>) => void) {
            callback({ [keys[0]!]: storage[keys[0]!] });
          },
          set(items: Record<string, unknown>, callback: () => void) {
            Object.assign(storage, items);
            callback();
          },
          remove(keys: string[], callback: () => void) {
            for (const key of keys) delete storage[key];
            callback();
          },
        },
      },
      tabs: {
        query(_q: unknown, callback: (list: unknown) => void) {
          callback([{ id: 7 }]);
        },
        sendMessage(tabId: number, message: unknown) {
          pushed.push({ tabId, message });
          return Promise.resolve({ ok: true });
        },
      },
    });
    return { pushed };
  }

  it('不带字段 = 纯读：回默认值，不回推页面', async () => {
    const { pushed } = stubChrome();

    // 2026-10-09：`prefetchEnabled` 删除后只剩这两个字段；
    // 「要不要预载」现在由 prefetchDepth 表达（0 = 关闭预载）。
    // 2026-10-11：多了「打开时回到几」（`lastNonZeroPrefetchDepth`）——
    // 它与开关**正交**：纯读也要回当前值（页面开关靠它决定"关掉再打开回到几"）。
    await expect(syncPrefetchConfig({ type: 'mt:prefetch-config-sync' }, sender)).resolves.toEqual({
      prefetchDepth: defaultPrefetchDepth,
      autoTranslateOnEnter: defaultAutoTranslateOnEnter,
      lastNonZeroPrefetchDepth: defaultPrefetchDepth,
    });
    expect(pushed).toHaveLength(0);
  });

  it('带字段 = 写入 settings 并回推当前标签页（推 mt:prefetch-config，不是 -sync）', async () => {
    const { pushed } = stubChrome();

    await expect(syncPrefetchConfig(
      { type: 'mt:prefetch-config-sync', autoTranslateOnEnter: true },
      sender,
    )).resolves.toMatchObject({ autoTranslateOnEnter: true });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      tabId: 7,
      message: { type: 'mt:prefetch-config', autoTranslateOnEnter: true },
    });
  });

  it('只写预载页数时，自动翻译保持原值（两个旋钮互不携带）', async () => {
    const { pushed } = stubChrome();

    // 自封闭：先显式把自动翻译置 true（settingsStore 是模块级 stub，会跨用例留状态）。
    await syncPrefetchConfig(
      { type: 'mt:prefetch-config-sync', autoTranslateOnEnter: true },
      sender,
    );
    const result = await syncPrefetchConfig(
      // 0 = 关闭预载 —— 2026-10-09 起这是"关预载"的唯一表达（原先是 prefetchEnabled: false）。
      { type: 'mt:prefetch-config-sync', prefetchDepth: 0 },
      sender,
    );
    expect(result.prefetchDepth).toBe(0);
    expect(result.autoTranslateOnEnter).toBe(true);
    // 回推的消息必须带上被写的那个（缺字段 = 内容脚本落回默认值，用户会以为"改了没用"）。
    expect(pushed.at(-1)?.message).toMatchObject({ prefetchDepth: 0 });
  });

  it('页数越界按 normalizePrefetchDepth 收敛，不把脏值存进 settings', async () => {
    stubChrome();

    const tooHigh = await syncPrefetchConfig(
      { type: 'mt:prefetch-config-sync', prefetchDepth: 9999 },
      sender,
    );
    expect(tooHigh.prefetchDepth).toBe(maxPrefetchDepth);

    const tooLow = await syncPrefetchConfig(
      { type: 'mt:prefetch-config-sync', prefetchDepth: -5 },
      sender,
    );
    expect(tooLow.prefetchDepth).toBe(minPrefetchDepth);
  });
});
