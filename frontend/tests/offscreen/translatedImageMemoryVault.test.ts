import { describe, expect, it } from 'vitest';
import { TranslatedImageMemoryVault } from '../../apps/extension/src/offscreen/translatedImageMemoryVault';
import { defaultTranslationCacheLimit } from '../../apps/extension/src/shared/config';

function blobOf(text: string): Blob {
  return new Blob([text], { type: 'image/png' });
}

describe('TranslatedImageMemoryVault', () => {
  it('stores, reads back and lists keys without touching blobs on list', () => {
    const vault = new TranslatedImageMemoryVault();
    const blob = blobOf('a');

    vault.put('k1', blob);

    expect(vault.size()).toBe(1);
    expect(vault.get('k1')).toBe(blob);
    // listKeys 只回键：一次全量读会把整库图片搬进调用方的堆里。
    expect(vault.listKeys()).toEqual(['k1']);
    expect(vault.get('missing')).toBeUndefined();
  });

  it('overwrites the same key instead of growing', () => {
    const vault = new TranslatedImageMemoryVault();
    const first = blobOf('first');
    const second = blobOf('second');

    vault.put('k1', first);
    vault.put('k1', second);

    expect(vault.size()).toBe(1);
    expect(vault.get('k1')).toBe(second);
  });

  it('evicts the oldest write once the entry limit is exceeded', () => {
    const vault = new TranslatedImageMemoryVault({ maxEntries: 2 });
    vault.put('oldest', blobOf('1'));
    vault.put('middle', blobOf('2'));
    vault.put('newest', blobOf('3'));

    expect(vault.size()).toBe(2);
    expect(vault.listKeys()).toEqual(['middle', 'newest']);
    expect(vault.get('oldest')).toBeUndefined();
  });

  it('treats a rewrite as a fresh write for eviction order', () => {
    const vault = new TranslatedImageMemoryVault({ maxEntries: 2 });
    vault.put('a', blobOf('a'));
    vault.put('b', blobOf('b'));
    // 重写 a：现在"最久未写入"的是 b，不是 a。
    vault.put('a', blobOf('a2'));
    vault.put('c', blobOf('c'));

    expect(vault.listKeys()).toEqual(['a', 'c']);
  });

  it('normalizes a nonsensical limit instead of honouring it', () => {
    // 0 非法 → 回落到**共享默认上限**（若真按 0 算，写一次就会被自己淘汰光）。
    const zero = new TranslatedImageMemoryVault({ maxEntries: 0 });
    for (let index = 0; index <= defaultTranslationCacheLimit; index += 1) {
      zero.put(`k${index}`, blobOf('x'));
    }
    expect(zero.size()).toBe(defaultTranslationCacheLimit);

    // 小数向下取整。
    const fractional = new TranslatedImageMemoryVault({ maxEntries: 2.7 });
    fractional.put('a', blobOf('a'));
    fractional.put('b', blobOf('b'));
    fractional.put('c', blobOf('c'));
    expect(fractional.listKeys()).toEqual(['b', 'c']);
  });

  it('honours a new limit right away, evicting down to it', () => {
    const vault = new TranslatedImageMemoryVault({ maxEntries: 5 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) vault.put(key, blobOf(key));

    // 调小 = 立刻裁，而不是等下一次写入才慢慢缩。
    expect(vault.setLimit(2)).toBe(2);
    expect(vault.size()).toBe(2);
    expect(vault.listKeys()).toEqual(['d', 'e']);
  });

  it('ignores a nonsensical setLimit and keeps the current ceiling', () => {
    const vault = new TranslatedImageMemoryVault({ maxEntries: 3 });
    vault.put('a', blobOf('a'));

    expect(vault.setLimit(0)).toBe(defaultTranslationCacheLimit);
    expect(vault.setLimit(Number.NaN)).toBe(defaultTranslationCacheLimit);
    expect(vault.setLimit(-1)).toBe(defaultTranslationCacheLimit);
  });

  it('clears the whole store', () => {
    const vault = new TranslatedImageMemoryVault();
    vault.put('k1', blobOf('1'));
    vault.put('k2', blobOf('2'));

    vault.clear();

    expect(vault.size()).toBe(0);
    expect(vault.listKeys()).toEqual([]);
  });
});
