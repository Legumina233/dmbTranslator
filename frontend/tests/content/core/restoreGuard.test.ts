import { describe, expect, it, vi } from 'vitest';
import type { ImageTarget } from '../../../apps/extension/src/content/core/types';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  ImageTranslationController,
} from '../../../apps/extension/src/content/core/translation/imageTranslationController';

// 到达还原的关键路径 = 内存查一次 Map（`restoreFromCache` 只读 stateStore，
// 见 imageTranslationController.ts）。落盘通道随翻译缓存层一起移除了，
// 所以这里只剩两条边界：内存直贴 / running 期间绝不覆盖。
// （原先的「后台预热查落盘」三例随之删除 —— 那条通道已不存在。）

const target: ImageTarget = {
  element: {} as HTMLImageElement,
  key: '4218710-5',
  originalUrl: 'https://exhentai.org/x/5.webp',
};

function createController() {
  const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
  const applyImage = vi.fn();
  const render = vi.fn();
  const controller = new ImageTranslationController(
    store,
    // restore 路径不碰执行仲裁器 —— 给个能过类型的最小替身
    { begin: vi.fn(), dispose: vi.fn() } as never,
    {
      resolveTarget: () => target,
      applyImage,
      render,
    },
  );
  return { controller, store, applyImage, render };
}

describe('到达还原（关键路径只有内存）', () => {
  it('内存里已有译图 → 同步直贴', () => {
    const el = { isConnected: true } as unknown as HTMLImageElement;
    const memoryTarget: ImageTarget = { element: el, key: '4218710-6', originalUrl: 'https://x/6.webp' };
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const applyImage = vi.fn();
    const render = vi.fn();
    const controller = new ImageTranslationController(
      store,
      { begin: vi.fn(), dispose: vi.fn() } as never,
      { resolveTarget: () => memoryTarget, applyImage, render },
    );
    const state = store.ensure(memoryTarget.key, memoryTarget.originalUrl);
    state.translatedUrl = URL.createObjectURL(new Blob(['translated']));

    controller.restoreFromCache(memoryTarget);
    expect(applyImage).toHaveBeenCalledTimes(1);
  });

  it('内存里没有译图 → 什么都不做（只贴不译的边界）', () => {
    const { controller, applyImage } = createController();
    controller.restoreFromCache(target);
    expect(applyImage).not.toHaveBeenCalled();
  });

  it('running 期间 → 还原不覆盖（用户已点翻译，管线在跑）', () => {
    const { controller, store, applyImage } = createController();
    const state = store.ensure(target.key, target.originalUrl);
    state.status = 'running';
    controller.restoreFromCache(target);
    expect(applyImage).not.toHaveBeenCalled();
  });
});
