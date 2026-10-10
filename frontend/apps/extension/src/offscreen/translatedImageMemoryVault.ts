import { defaultTranslationCacheLimit } from '../shared/config';

/**
 * 译图缓存的**存储本体**（off-screen 文档内）—— 纯内存 Map，不落盘。
 *
 * 淘汰口径与内容脚本那层 `PhotoStateStore` 完全一致：占用按条数算（一张译图一条）、
 * 默认上限取 `defaultTranslationCacheLimit`、超出时淘汰**最久未写入**的那条，
 * 且**改小上限时立刻裁**（淘汰只在写入时发生，光把数字改小不会让存量自己缩）。
 *
 * 「最久未写入」直接用 Map 的插入序表达：`put` 先删后插、`get` 不动顺序，
 * 因此迭代顺序恒等于写入时间序 —— 不需要另记时间戳，也不需要线性扫描找最老的键。
 *
 * 它跨页面重载存活，靠的是**活在 off-screen 文档里**（那个文档不随页面导航销毁），
 * 而不是"写到了磁盘"。所以扩展重载 / 浏览器会话结束 = 天然清空。
 */
export class TranslatedImageMemoryVault {
  private readonly entries = new Map<string, Blob>();
  private maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = normalizeMaxEntries(options.maxEntries);
  }

  /** 当前条数。宿主用它决定"要不要为了保住缓存而拒绝空闲关闭"。 */
  size(): number {
    return this.entries.size;
  }

  /** 只回键，不回 Blob —— 一次全量读会把整库图片搬进调用方的堆里。 */
  listKeys(): string[] {
    return [...this.entries.keys()];
  }

  get(key: string): Blob | undefined {
    return this.entries.get(key);
  }

  /**
   * 改条数上限，并把存量**立刻**裁到新上限内。
   *
   * 与 `PhotoStateStore.setLimit` 同口径（非法值回落到默认上限）—— 因为调用方
   * `TranslatorCore.setMemoryCacheLimit()` 传来的本来就是内存层算出的生效值，
   * 两层不该各算各的。
   */
  setLimit(limit: number): number {
    this.maxEntries = normalizeMaxEntries(limit);
    this.trim();
    return this.maxEntries;
  }

  /** 同 key 覆盖（视作一次新写入），并把总量裁到上限内。 */
  put(key: string, blob: Blob): void {
    this.entries.delete(key);
    this.entries.set(key, blob);
    this.trim();
  }

  clear(): void {
    this.entries.clear();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

/** 非数 / 小于 1 都回落到默认上限；小数向下取整。 */
function normalizeMaxEntries(value: unknown): number {
  const parsed = typeof value === 'number' ? Math.trunc(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : defaultTranslationCacheLimit;
}
