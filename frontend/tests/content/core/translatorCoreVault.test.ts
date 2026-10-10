import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { twitterAdapter } from '../../../apps/extension/src/content/adapters/twitter';
import { TranslatorCore } from '../../../apps/extension/src/content/core/TranslatorCore';
import type { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import type { TranslatedImageVaultPort } from '../../../apps/extension/src/content/core/state/offscreenTranslatedImageVault';
import type {
  ImageTranslationCallbacks,
  ImageTranslationController,
} from '../../../apps/extension/src/content/core/translation/imageTranslationController';
import type { ImageTarget, SiteAdapter } from '../../../apps/extension/src/content/core/types';
import { defaultTranslationCacheLimit } from '../../../apps/extension/src/shared/config';
import { flushAsync } from './flushAsync';

/**
 * Bug1 缓存保全的接线测试。
 *
 * 场景：e-hentai 阅读页整页重载 → 旧文档 `stop()` 把内存译图清零 →
 * 新文档 `hydrateVault()` 从缓存读回 → 该页被挂载时贴回译图。
 *
 * 这里用 twitter 适配器而不是 e-hentai：本文件要验的是**持久层接线**，
 * 与适配器无关；e-hentai 的画框模式要真 DOM，跑在 node 环境里只会引入噪声。
 */

const uiMocks = vi.hoisted(() => ({
  createUiElements: vi.fn(() => {
    const host = {
      isConnected: false,
      remove: vi.fn(),
    };
    host.remove.mockImplementation(() => {
      host.isConnected = false;
    });
    return {
      host,
      button: { addEventListener: vi.fn() },
      stageTimingCardToggleButton: { addEventListener: vi.fn() },
      errorDetailCardToggleButton: { addEventListener: vi.fn() },
    };
  }),
  injectStyles: vi.fn(),
  renderUi: vi.fn(),
}));

vi.mock('../../../apps/extension/src/content/core/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../apps/extension/src/content/core/ui')>(),
  ...uiMocks,
}));

const pageKey = '123456-7';
const pageUrl = 'https://example.com/123456-7.png';

function emptyVault(overrides: Partial<TranslatedImageVaultPort> = {}): TranslatedImageVaultPort {
  return {
    loadKeys: async () => [],
    get: async () => undefined,
    put: async () => undefined,
    setLimit: async () => undefined,
    clear: async () => undefined,
    ...overrides,
  };
}

function createHarness(vault: TranslatedImageVaultPort) {
  const target: ImageTarget = {
    element: {} as HTMLImageElement,
    key: pageKey,
    originalUrl: pageUrl,
  };
  const applyImage = vi.fn();
  const adapter: SiteAdapter = {
    ...twitterAdapter,
    findImages: () => [target],
    createUiAnchor: () => ({
      appendChild(host: { isConnected: boolean }) {
        host.isConnected = true;
      },
    }) as unknown as HTMLElement,
    applyImage,
    observe: () => () => undefined,
  };
  const core = new TranslatorCore(adapter, undefined, vault);
  const stateStore = Reflect.get(core, 'stateStore') as PhotoStateStore;

  return {
    core,
    stateStore,
    applyImage,
    hydrate: () => Reflect.get(core, 'hydrateVault').call(core) as Promise<void>,
    sync: () => { Reflect.get(core, 'sync').call(core); },
  };
}

beforeEach(() => {
  // `sync()` 防抖与 `hydrateVault` 的补拍都走 `window.setTimeout`，node 环境没有 window。
  vi.stubGlobal('window', {
    setTimeout: (handler: () => void, timeout?: number) =>
      setTimeout(handler, timeout) as unknown as number,
    clearTimeout: (handle?: number) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TranslatorCore translated image vault', () => {
  it('restores a translated image from the vault when the page is mounted again', async () => {
    const blob = new Blob(['translated'], { type: 'image/png' });
    const harness = createHarness(emptyVault({
      loadKeys: async () => [pageKey],
      get: async () => blob,
    }));

    await harness.hydrate();
    harness.sync();
    await flushAsync();

    const state = harness.stateStore.get(pageKey);
    expect(state?.status).toBe('translated');
    expect(state?.translatedUrl).toMatch(/^blob:/);
    expect(harness.applyImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^blob:/),
    );
    harness.core.stop();
  });

  it('reads only the keys while hydrating, never the images', async () => {
    const get = vi.fn(async () => undefined);
    const harness = createHarness(emptyVault({ loadKeys: async () => [pageKey], get }));

    await harness.hydrate();

    // Blob 推迟到该页真被挂载时再取 —— 一次 getAll() 会把整库图片读进内存。
    expect(get).not.toHaveBeenCalled();
    harness.core.stop();
  });

  it('keeps the image the current document has already translated', async () => {
    const blob = new Blob(['stale'], { type: 'image/png' });
    const harness = createHarness(emptyVault({
      loadKeys: async () => [pageKey],
      get: async () => blob,
    }));
    await harness.hydrate();

    // 本次文档刚译好：内存里的这张永远比库里的新。
    harness.stateStore.ensure(pageKey, pageUrl).translatedUrl = 'blob:fresh';

    harness.sync();
    await flushAsync();

    expect(harness.stateStore.get(pageKey)?.translatedUrl).toBe('blob:fresh');
    harness.core.stop();
  });

  it('mounts the page normally when the vault cannot be read', async () => {
    const harness = createHarness(emptyVault({
      loadKeys: async () => { throw new Error('库损坏'); },
    }));

    await harness.hydrate();
    harness.sync();
    await flushAsync();

    expect(harness.stateStore.get(pageKey)?.status).toBe('idle');
    harness.core.stop();
  });

  it('does not restore anything once the document has been stopped', async () => {
    const blob = new Blob(['translated'], { type: 'image/png' });
    const harness = createHarness(emptyVault({
      loadKeys: async () => [pageKey],
      get: async () => blob,
    }));
    Reflect.set(harness.core, 'stopped', true);

    await harness.hydrate();
    harness.sync();
    await flushAsync();

    expect(harness.stateStore.get(pageKey)?.translatedUrl).toBeUndefined();
    harness.core.stop();
  });

  it('persists a freshly translated image through the controller', async () => {
    const put = vi.fn(async () => undefined);
    const harness = createHarness(emptyVault({ put }));
    const controller = Reflect.get(
      harness.core,
      'imageTranslationController',
    ) as ImageTranslationController;
    const callbacks = Reflect.get(controller, 'callbacks') as ImageTranslationCallbacks;
    const blob = new Blob(['translated'], { type: 'image/png' });

    callbacks.persistTranslatedImage?.(pageKey, blob);
    await flushAsync();

    expect(put).toHaveBeenCalledWith(pageKey, blob);
    harness.core.stop();
  });

  it('clears the vault together with the memory cache', () => {
    const clear = vi.fn(async () => undefined);
    const harness = createHarness(emptyVault({ clear }));

    harness.core.clearMemoryCache();

    // 只清内存的话，重载一次"清掉"的译图又从库里回来了。
    expect(clear).toHaveBeenCalledTimes(1);
    harness.core.stop();
  });

  it('pushes a limit change into the vault as well as the memory store', () => {
    const setLimit = vi.fn(async () => undefined);
    const harness = createHarness(emptyVault({ setLimit }));

    harness.core.setMemoryCacheLimit(7);

    // 只改一层的话，弹窗上的数字就管不住真正占内存的那一份（vault 才跨页面重载活着）。
    expect(harness.stateStore.limit()).toBe(7);
    expect(setLimit).toHaveBeenCalledTimes(1);
    expect(setLimit).toHaveBeenCalledWith(7);
    harness.core.stop();
  });

  it('hands the vault the value the memory store actually settled on', () => {
    const setLimit = vi.fn(async () => undefined);
    const harness = createHarness(emptyVault({ setLimit }));

    // 0 是非法上限 → 内存层回落到默认。vault 必须拿到**同一个**回落值，两层不各算各的。
    harness.core.setMemoryCacheLimit(0);

    expect(harness.stateStore.limit()).toBe(defaultTranslationCacheLimit);
    expect(setLimit).toHaveBeenCalledWith(defaultTranslationCacheLimit);
    harness.core.stop();
  });
});
