import { describe, expect, it } from 'vitest';
import {
  createTranslatedImageCache,
  planEviction,
  TRANSLATED_IMAGE_SCHEMA_VERSION,
  type TranslatedImageIndexRecord,
} from '../../apps/extension/src/offscreen/translatedImageCacheStore';
import { createInMemoryStoragePort } from '../helpers/inMemoryTranslatedImageStoragePort';

function record(key: string, seq: number, bytes = 10): TranslatedImageIndexRecord {
  return { key, bytes, seq };
}

describe('planEviction', () => {
  it('does nothing while both limits hold', () => {
    expect(planEviction([record('a', 1), record('b', 2)], 5, 1000)).toEqual([]);
  });

  it('evicts oldest first until the count limit holds', () => {
    const entries = [record('a', 1), record('b', 2), record('c', 3)];
    expect(planEviction(entries, 2, 1000)).toEqual(['a']);
    expect(planEviction(entries, 1, 1000)).toEqual(['a', 'b']);
  });

  it('evicts oldest first until the byte cap holds', () => {
    const entries = [record('a', 1, 100), record('b', 2, 100), record('c', 3, 100)];
    expect(planEviction(entries, 10, 250)).toEqual(['a']);
    expect(planEviction(entries, 10, 100)).toEqual(['a', 'b']);
  });

  it('drops a single record that alone exceeds the byte cap', () => {
    expect(planEviction([record('huge', 1, 500)], 10, 100)).toEqual(['huge']);
  });

  it('treats a zero byte record as evictable but harmless', () => {
    const entries = [record('empty', 1, 0), record('b', 2, 100)];
    expect(planEviction(entries, 10, 500)).toEqual([]);
    expect(planEviction(entries, 1, 500)).toEqual(['empty']);
  });
});

describe('createTranslatedImageCache', () => {
  it('stores, lists and reads a translated image', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 5 });
    const blob = new Blob(['translated'], { type: 'image/png' });

    await cache.put('page-1', blob);

    await expect(cache.listKeys()).resolves.toEqual(['page-1']);
    await expect(cache.get('page-1')).resolves.toBeInstanceOf(Blob);
    expect(cache.size()).toBe(1);
    // 真的写进了存储端口（不是只留在内存索引里）。
    expect(storage.peek().images).toEqual(['page-1']);
    await expect(cache.stats()).resolves.toMatchObject({ entries: 1, bytes: blob.size, limit: 5 });
  });

  it('returns undefined for a key it never stored', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port });
    await expect(cache.get('missing')).resolves.toBeUndefined();
  });

  it('evicts the oldest entry when the count limit is exceeded', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 2 });

    for (const key of ['a', 'b', 'c']) await cache.put(key, new Blob([key]));

    await expect(cache.listKeys()).resolves.toEqual(['b', 'c']);
    expect(storage.peek().images).toEqual(['b', 'c']);
  });

  it('treats rewriting a key as a fresh write (it becomes the newest)', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 2 });

    await cache.put('a', new Blob(['a']));
    await cache.put('b', new Blob(['b']));
    await cache.put('a', new Blob(['a2']));
    await cache.put('c', new Blob(['c']));

    // 'a' 因为被重写变成最新，于是这一轮被淘汰的是 'b'。
    await expect(cache.listKeys()).resolves.toEqual(['a', 'c']);
    expect(storage.peek().images).toEqual(['a', 'c']);
  });

  it('evicts down when the byte cap is exceeded', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 100, maxBytes: 250 });

    for (const key of ['a', 'b', 'c']) await cache.put(key, new Blob([key.repeat(100)]));

    await expect(cache.listKeys()).resolves.toEqual(['b', 'c']);
    await expect(cache.stats()).resolves.toMatchObject({ entries: 2, bytes: 200, maxBytes: 250 });
  });

  it('trims immediately when the limit is lowered', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 10 });

    for (const key of ['a', 'b', 'c', 'd']) await cache.put(key, new Blob([key]));
    await expect(cache.setLimit(2)).resolves.toBe(2);

    await expect(cache.listKeys()).resolves.toEqual(['c', 'd']);
    expect(cache.size()).toBe(2);
  });

  it('clears both the index and the stored blobs', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 10 });
    await cache.put('a', new Blob(['a']));

    await cache.clear();

    expect(cache.size()).toBe(0);
    await expect(cache.listKeys()).resolves.toEqual([]);
    expect(storage.peek().images).toEqual([]);
  });

  it('reads back what a previous session left behind', async () => {
    // 同一个存储端口被两个 cache 实例先后使用 —— 模拟"SW 重启后新实例"。
    const storage = createInMemoryStoragePort();
    const first = createTranslatedImageCache({ port: storage.port, limit: 10 });
    await first.put('a', new Blob(['a']));
    await first.put('b', new Blob(['b']));

    const second = createTranslatedImageCache({ port: storage.port, limit: 10 });
    await expect(second.listKeys()).resolves.toEqual(['a', 'b']);
    await expect(second.get('a')).resolves.toBeInstanceOf(Blob);
    // 新实例继续写入时序号必须接着走，不能覆盖旧记录的顺序。
    await second.put('c', new Blob(['c']));
    await expect(second.listKeys()).resolves.toEqual(['a', 'b', 'c']);
  });

  it('writes the schema version on a fresh store', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port });
    await cache.listKeys();
    expect(storage.peek().schemaVersion).toBe(TRANSLATED_IMAGE_SCHEMA_VERSION);
  });

  it('wipes everything when the stored schema version does not match', async () => {
    const storage = createInMemoryStoragePort({ schemaVersion: TRANSLATED_IMAGE_SCHEMA_VERSION - 1 });
    // 先用旧版本塞点数据（端口直接写，绕过 cache 的 schema 校验）。
    await storage.port.write({ key: 'stale', blob: new Blob(['stale']), bytes: 5, seq: 1 });

    const cache = createTranslatedImageCache({ port: storage.port });

    await expect(cache.listKeys()).resolves.toEqual([]);
    expect(storage.peek().images).toEqual([]);
    expect(storage.calls.clears).toBe(1);
    expect(storage.peek().schemaVersion).toBe(TRANSLATED_IMAGE_SCHEMA_VERSION);
  });

  it('uses the configured entry limit over the stored one when trimming on open', async () => {
    const storage = createInMemoryStoragePort();
    const wide = createTranslatedImageCache({ port: storage.port, limit: 10 });
    for (const key of ['a', 'b', 'c']) await wide.put(key, new Blob([key]));

    // 上限在别的会话里被调小过：打开时就该裁到 1。
    const narrow = createTranslatedImageCache({ port: storage.port, limit: 1 });
    await expect(narrow.listKeys()).resolves.toEqual(['c']);
  });

  it('surfaces a read failure instead of pretending the cache is empty', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port });
    storage.failNext('数据库不可用');

    await expect(cache.listKeys()).rejects.toThrow('数据库不可用');
    // 失败不能把打开过程永久钉死：下一次调用要能重新尝试。
    await expect(cache.listKeys()).resolves.toEqual([]);
  });

  it('surfaces a write failure without leaving a phantom index entry', async () => {
    const storage = createInMemoryStoragePort();
    const cache = createTranslatedImageCache({ port: storage.port, limit: 10 });
    await cache.listKeys();
    storage.failNext('磁盘写失败');

    await expect(cache.put('a', new Blob(['a']))).rejects.toThrow('磁盘写失败');
    expect(cache.size()).toBe(0);
    expect(storage.peek().images).toEqual([]);
  });

  it('propagates a missing IndexedDB instead of silently caching nothing', async () => {
    const cache = createTranslatedImageCache({ factory: null });
    await expect(cache.listKeys()).rejects.toThrow('IndexedDB 不可用');
  });
});
