import type { PhotoState } from '../types';
import { defaultTranslationCacheLimit } from '../../../shared/config';

export type PhotoStateUrlApi = Pick<typeof URL, 'revokeObjectURL'>;

export function createInitialPhotoState(originalUrl: string): PhotoState {
  return {
    status: 'idle',
    originalUrl,
    translatedUrl: undefined,
    debugOriginalUrl: undefined,
    debugLogData: undefined,
    showTypesetDebug: false,
    showEraseDebug: false,
    stageText: '',
    elapsedText: '',
    stageTimingCard: undefined,
    errorText: '',
    errorDetailCard: undefined,
    contextNoticeText: undefined,
  };
}

export class PhotoStateStore {
  private readonly states = new Map<string, PhotoState>();
  private readonly protectedKeys = new Map<string, number>();

  constructor(
    private cacheLimit = defaultTranslationCacheLimit,
    private readonly urlApi: PhotoStateUrlApi = URL,
  ) {}

  /**
   * 内存译图的**占用 = 条数**。本层不统计字节：blob 的字节数在内容脚本侧拿不准，
   * 而"一张译图"才是这里真正的资源单位（每张一条 blob URL，浏览器侧各持一份解码位图）。
   */
  size(): number {
    return this.states.size;
  }

  /** 当前条数上限。 */
  limit(): number {
    return this.cacheLimit;
  }

  /**
   * 改条数上限。**调小必须立刻裁** —— 淘汰只发生在写入时（`ensure`/`trim`），
   * 光把数字改小不会让存量自己缩水，所以这里改完就 `trim()`。
   */
  setLimit(limit: number): number {
    const parsed = typeof limit === 'number' ? Math.trunc(limit) : Number.NaN;
    this.cacheLimit = Number.isFinite(parsed) && parsed >= 1
      ? parsed
      : defaultTranslationCacheLimit;
    this.trim();
    return this.cacheLimit;
  }

  /** 清空全部内存译图（连 blob URL 一起撤销，避免内存泄漏）。 */
  clear(): number {
    const removed = this.states.size;
    for (const state of this.states.values()) {
      this.releaseStateUrls(state);
    }
    this.states.clear();
    this.protectedKeys.clear();
    return removed;
  }

  get(key: string): PhotoState | undefined {
    return this.states.get(key);
  }

  ensure(key: string, originalUrl: string): PhotoState {
    const existing = this.states.get(key);
    if (existing) return existing;

    const state = createInitialPhotoState(originalUrl);
    this.states.set(key, state);
    this.trim(key);
    return state;
  }

  protect(key: string): () => void {
    this.protectedKeys.set(key, (this.protectedKeys.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.protectedKeys.get(key) ?? 0;
      if (count <= 1) this.protectedKeys.delete(key);
      else this.protectedKeys.set(key, count - 1);
      this.trim();
    };
  }

  delete(key: string): void {
    const state = this.states.get(key);
    if (!state) return;
    this.releaseStateUrls(state);
    this.states.delete(key);
    this.protectedKeys.delete(key);
  }

  dispose(): void {
    this.clear();
  }

  private trim(recentKey?: string): void {
    while (this.states.size > this.cacheLimit) {
      let evictableKey: string | undefined;
      for (const key of this.states.keys()) {
        if (key === recentKey || this.protectedKeys.has(key)) continue;
        evictableKey = key;
        break;
      }
      if (!evictableKey) break;
      this.delete(evictableKey);
    }
  }

  private releaseStateUrls(state: PhotoState): void {
    if (state.translatedUrl) {
      this.urlApi.revokeObjectURL(state.translatedUrl);
      state.translatedUrl = undefined;
    }
    if (state.debugOriginalUrl) {
      this.urlApi.revokeObjectURL(state.debugOriginalUrl);
      state.debugOriginalUrl = undefined;
    }
    state.debugLogData = undefined;
    state.errorDetailCard = undefined;
  }
}
