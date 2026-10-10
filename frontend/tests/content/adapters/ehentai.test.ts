import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ehentaiPageKey,
  isEhentaiImagePage,
  parseEhentaiPageIdentity,
  pickEhentaiMainImage,
} from '../../../apps/extension/src/content/adapters/ehentai';
import type { ImageTarget } from '../../../apps/extension/src/content/core/types';

describe('ehentai adapter helpers', () => {
  it('matches image viewer pages on e-hentai and exhentai only', () => {
    expect(isEhentaiImagePage('e-hentai.org', '/s/be754cde63/3833082-4')).toBe(true);
    expect(isEhentaiImagePage('exhentai.org', '/s/be754cde63/3833082-4')).toBe(true);
    expect(isEhentaiImagePage('e-hentai.org', '/g/3833082/example')).toBe(false);
    expect(isEhentaiImagePage('example.com', '/s/be754cde63/3833082-4')).toBe(false);
  });

  it('prefers the #img viewer image over navigation icons', () => {
    const main = {
      id: 'img',
      src: 'https://example.test/main.webp',
      currentSrc: '',
      naturalWidth: 1280,
      naturalHeight: 1808,
      clientWidth: 1280,
      clientHeight: 1808,
    };

    expect(pickEhentaiMainImage([
      {
        id: '',
        src: 'https://ehgt.org/g/f.png',
        currentSrc: '',
        naturalWidth: 30,
        naturalHeight: 30,
        clientWidth: 34,
        clientHeight: 30,
      },
      main,
    ])).toBe(main);
  });

  it('falls back to the largest visible image and builds stable keys', () => {
    const main = {
      id: '',
      src: 'https://hath.network/003.webp',
      currentSrc: '',
      naturalWidth: 1280,
      naturalHeight: 1808,
      clientWidth: 1280,
      clientHeight: 1808,
    };

    expect(pickEhentaiMainImage([
      {
        id: '',
        src: 'https://ehgt.org/g/n.png',
        currentSrc: '',
        naturalWidth: 30,
        naturalHeight: 30,
        clientWidth: 34,
        clientHeight: 30,
      },
      main,
    ])).toBe(main);
  });
});

describe('ehentai page identity (M0)', () => {
  const realViewerPaths = [
    '/s/c56823c1cb/4218710-1',
    '/s/e6541d89bb/4218710-4',
    '/s/0b98c3ad02/4218710-5',
    '/s/3c42c4af78/4218710-6',
    '/s/9bfef05380/4218710-7',
    '/s/d0e67db36f/4218710-8',
    '/s/7713484651/4218710-9',
    '/s/85ec31467f/4218710-10',
  ];

  it('parses the gid and page out of every real viewer path', () => {
    expect(realViewerPaths.map(parseEhentaiPageIdentity)).toEqual([
      { gid: 4218710, page: 1 },
      { gid: 4218710, page: 4 },
      { gid: 4218710, page: 5 },
      { gid: 4218710, page: 6 },
      { gid: 4218710, page: 7 },
      { gid: 4218710, page: 8 },
      { gid: 4218710, page: 9 },
      { gid: 4218710, page: 10 },
    ]);
  });

  it('keeps the key stable across different imgkeys for the same page', () => {
    const first = parseEhentaiPageIdentity('/s/0b98c3ad02/4218710-5');
    const second = parseEhentaiPageIdentity('/s/9bfef05380/4218710-5');
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(ehentaiPageKey(first!)).toBe('4218710-5');
    expect(ehentaiPageKey(second!)).toBe(ehentaiPageKey(first!));
  });

  it('never collides across pages of the same gallery', () => {
    const keys = realViewerPaths.map((path) => {
      const identity = parseEhentaiPageIdentity(path);
      return identity ? ehentaiPageKey(identity) : null;
    });
    expect(keys).not.toContain(null);
    expect(new Set(keys).size).toBe(realViewerPaths.length);
  });

  it('reflects the pageKey contract shared with the server', () => {
    const identity = parseEhentaiPageIdentity('/s/be754cde63/3833082-4');
    expect(identity).toEqual({ gid: 3833082, page: 4 });
    expect(ehentaiPageKey(identity!)).toBe(`${3833082}-${4}`);
  });

  it('rejects non viewer paths instead of guessing', () => {
    expect(parseEhentaiPageIdentity('/g/3833082/example')).toBeNull();
    expect(parseEhentaiPageIdentity('/s/be754cde63/')).toBeNull();
    expect(parseEhentaiPageIdentity('/')).toBeNull();
    expect(parseEhentaiPageIdentity('')).toBeNull();
  });

  it('tolerates a trailing slash on viewer paths', () => {
    expect(ehentaiPageKey(parseEhentaiPageIdentity('/s/0b98c3ad02/4218710-5/')!)).toBe('4218710-5');
  });
});

/**
 * 浮层按钮锚点（2026-10-03「按钮被译图盖住」修复的回归护栏）。
 *
 * 机理：按钮 z=2147483001 > 画框 z=2147483000 只在**同一层叠上下文**里成立。旧版把锚点
 * 挂进站点容器（#i1 有 position:relative;z-index:1 → 创建层叠上下文），按钮被困在锅里，
 * 整锅在根上下文只有 z=1，被挂 body 的画框整个压住。修复 = 锚点挂 body，与画框同台。
 * 这里锁定三件事：挂 body（不是站点容器）、翻页复用同一锚点并重定位、锚点丢了能重建。
 */
describe('ehentaiAdapter.createUiAnchor (body 直挂)', () => {
  type FakeRect = { left: number; top: number; right: number; width: number; height: number };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function makeElement(rect: FakeRect) {
    const el: {
      attrs: Record<string, string>;
      dataset: Record<string, string>;
      style: { cssText: string; left: string; top: string };
      isConnected: boolean;
      offsetParent: unknown;
      parent: unknown;
      children: unknown[];
      setAttribute: (name: string, value: string) => void;
      getBoundingClientRect: () => FakeRect;
      appendChild: (child: ReturnType<typeof makeElement>) => unknown;
    } = {
      attrs: {},
      dataset: {},
      style: { cssText: '', left: '', top: '' },
      isConnected: false,
      offsetParent: null,
      parent: null,
      children: [],
      setAttribute(name, value) {
        el.attrs[name] = value;
      },
      getBoundingClientRect: () => ({ ...rect }),
      appendChild(child) {
        child.parent = el;
        child.isConnected = el.isConnected;
        child.offsetParent = el;
        el.children.push(child);
        return child;
      },
    };
    return el;
  }

  /** 站点图 target：isConnected=true（positionAnchor 的守卫依赖它）。 */
  function makeTarget(key: string, rect: FakeRect): ImageTarget {
    const element = makeElement(rect);
    element.isConnected = true;
    return {
      key,
      element: element as unknown as HTMLImageElement,
      originalUrl: 'https://example.test/original.webp',
    } as unknown as ImageTarget;
  }

  /** 最小假 DOM：只覆盖 createUiAnchor 的触面。锚点 offsetParent = body（原点 0,0）。 */
  function stubDom(imageRect: FakeRect) {
    const body = makeElement({ left: 0, top: 0, right: 0, width: 0, height: 0 });
    body.isConnected = true;
    const resizeListeners: Array<() => void> = [];
    const documentStub = {
      body,
      createElement: () => makeElement({ left: 0, top: 0, right: 0, width: 0, height: 0 }),
    };
    const windowStub = {
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'resize') resizeListeners.push(cb);
      },
      removeEventListener: () => {},
      scrollX: 0,
      scrollY: 0,
    };
    vi.stubGlobal('document', documentStub);
    vi.stubGlobal('window', windowStub);
    return { body, resizeListeners, target: makeTarget('4218710-5', imageRect) };
  }

  it('mounts the anchor on document.body with an explicit root-context z-index', async () => {
    const { body, target } = stubDom({ left: 100, top: 50, right: 900, width: 800, height: 1200 });
    const { ehentaiAdapter } = await import(
      '../../../apps/extension/src/content/adapters/ehentai'
    );

    const anchor = ehentaiAdapter.createUiAnchor(target) as unknown as ReturnType<typeof makeElement>;

    expect(anchor.attrs['data-mt-ehentai-anchor']).toBe('');
    expect(anchor.style.cssText).toContain('z-index:2147483001');
    // 直挂 body：整条祖先链没有站点容器，按钮的 z-index 才能在根上下文与画框同台比较。
    expect(body.children).toContain(anchor);
    // 【2026-10-04】固定贴视口右下角：不再跟随图片矩形，也不再有 transform 内缩。
    expect(anchor.style.cssText).toContain('position:fixed');
    expect(anchor.style.cssText).toContain('right:12px');
    expect(anchor.style.cssText).toContain('bottom:12px');
    expect(anchor.style.cssText).not.toContain('transform');
  });

  it('reuses the same anchor across page turns (fixed 定位，换图不重挂也不重算)', async () => {
    const { body, target } = stubDom({ left: 100, top: 50, right: 900, width: 800, height: 1200 });
    const { ehentaiAdapter } = await import(
      '../../../apps/extension/src/content/adapters/ehentai'
    );

    const first = ehentaiAdapter.createUiAnchor(target) as unknown as ReturnType<typeof makeElement>;

    const nextTarget = makeTarget('4218710-6', { left: 40, top: 80, right: 500, width: 460, height: 690 });
    const second = ehentaiAdapter.createUiAnchor(nextTarget) as unknown as ReturnType<typeof makeElement>;

    expect(second).toBe(first); // 翻页复用同一锚点，不重挂
    expect(body.children).toContain(second);
    expect(body.children).toHaveLength(1); // 不留旧锚点残骸
    // fixed 定位：换到新图后位置不变（本来就贴视口，不跟图片矩形走）
    expect(second.style.cssText).toContain('position:fixed');
    expect(second.style.cssText).not.toContain('left:'); // 不再按图片矩形写 left/top
  });

  it('rebuilds the anchor when it was removed from the document', async () => {
    const { body, target } = stubDom({ left: 100, top: 50, right: 900, width: 800, height: 1200 });
    const { ehentaiAdapter } = await import(
      '../../../apps/extension/src/content/adapters/ehentai'
    );

    const first = ehentaiAdapter.createUiAnchor(target) as unknown as ReturnType<typeof makeElement>;
    first.isConnected = false; // 模拟锚点被外部移除
    const second = ehentaiAdapter.createUiAnchor(target) as unknown as ReturnType<typeof makeElement>;

    expect(second).not.toBe(first);
    expect(body.children).toContain(second);
    expect(second.style.cssText).toContain('position:fixed');
  });

  it('skips positioning when the target image is detached or zero-sized', async () => {
    const { target } = stubDom({ left: 0, top: 0, right: 0, width: 0, height: 0 });
    const { ehentaiAdapter } = await import(
      '../../../apps/extension/src/content/adapters/ehentai'
    );

    const anchor = ehentaiAdapter.createUiAnchor(target) as unknown as ReturnType<typeof makeElement>;

    // 零尺寸矩形：没定位依据就不动 left/top（与画框 rect.width<=0 即 return 的口径一致）。
    expect(anchor.style.left).toBe('');
    expect(anchor.style.top).toBe('');
  });
});
