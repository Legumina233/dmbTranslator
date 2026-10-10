import { describe, expect, it, vi } from 'vitest';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import { defaultTranslationCacheLimit } from '../../../apps/extension/src/shared/config';

describe('PhotoStateStore', () => {
  it('reuses state for the same key and keeps the original state identity', () => {
    const store = new PhotoStateStore();
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    const second = store.ensure('image-1', 'https://example.com/changed.jpg');

    expect(second).toBe(first);
    expect(second.originalUrl).toBe('https://example.com/one.jpg');
  });

  it('evicts the oldest state and revokes every owned object URL', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const oldest = store.ensure('image-1', 'https://example.com/one.jpg');
    oldest.translatedUrl = 'blob:translated-1';
    oldest.debugOriginalUrl = 'blob:debug-1';
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('image-1')).toBeUndefined();
    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-1'],
    ]);
  });

  it('releases URLs exactly once when deleting and disposing states', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(200, { revokeObjectURL });
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    first.translatedUrl = 'blob:translated-1';
    const second = store.ensure('image-2', 'https://example.com/two.jpg');
    second.debugOriginalUrl = 'blob:debug-2';

    store.delete('image-1');
    store.delete('image-1');
    store.dispose();

    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-2'],
    ]);
    expect(store.get('image-2')).toBeUndefined();
  });

  it('does not evict protected active states until they are released', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const active = store.ensure('active', 'https://example.com/active.jpg');
    active.translatedUrl = 'blob:active';
    const release = store.protect('active');
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('active')).toBe(active);
    expect(store.get('image-2')).toBeUndefined();
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:active');

    release();
    store.ensure('image-4', 'https://example.com/four.jpg');

    expect(store.get('active')).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:active');
  });

  it('占用按条数计：size 是条目数，limit 是条数上限', () => {
    const store = new PhotoStateStore(5);
    expect(store.size()).toBe(0);
    expect(store.limit()).toBe(5);

    store.ensure('image-1', 'https://example.com/one.jpg');
    store.ensure('image-2', 'https://example.com/two.jpg');

    expect(store.size()).toBe(2);
  });

  it('setLimit 调小时立刻裁存量 —— 淘汰只在写入时发生，光改数字不会自己缩', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(200, { revokeObjectURL });
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    first.translatedUrl = 'blob:one';
    store.ensure('image-2', 'https://example.com/two.jpg');
    store.ensure('image-3', 'https://example.com/three.jpg');
    expect(store.size()).toBe(3);

    expect(store.setLimit(2)).toBe(2);

    expect(store.size()).toBe(2);
    expect(store.get('image-1')).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:one');
  });

  it('setLimit 收到非法值回落到默认上限，不会把上限设成 0 或负数', () => {
    // 故意拿 200 建库：非法值必须回落到**共享默认值**，而不是"构造函数当初传的那个数"。
    const store = new PhotoStateStore(200);
    expect(store.setLimit(0)).toBe(defaultTranslationCacheLimit);
    expect(store.setLimit(-5)).toBe(defaultTranslationCacheLimit);
    expect(store.setLimit(Number.NaN)).toBe(defaultTranslationCacheLimit);
    expect(store.setLimit(7)).toBe(7);
  });

  it('clear 清空全部并把 blob URL 全部撤销', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(200, { revokeObjectURL });
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    first.translatedUrl = 'blob:one';
    const second = store.ensure('image-2', 'https://example.com/two.jpg');
    second.translatedUrl = 'blob:two';

    expect(store.clear()).toBe(2);

    expect(store.size()).toBe(0);
    expect(store.get('image-1')).toBeUndefined();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:one'], ['blob:two']]);
  });
});
