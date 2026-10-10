import type { ImageTarget, SiteAdapter } from '../core/types';
import { createTranslatedImageOverlay } from '../core/overlay/translatedImageOverlay';
import type { TranslatedImageOverlay } from '../core/overlay/translatedImageOverlay';

type ImageCandidate = {
  id?: string;
  src: string;
  currentSrc?: string;
  naturalWidth: number;
  naturalHeight: number;
  clientWidth: number;
  clientHeight: number;
};

const anchorAttr = 'data-mt-ehentai-anchor';
/** 锚点（按钮容器）距图片右上角的内边距，与 v0.1.x 的视觉位置一致。 */
const anchorInsetPx = 12;
const minMainImageArea = 200 * 200;

/**
 * 浮层按钮的层级必须**高于**常驻画框（画框是 `2147483000`）。
 *
 * 【2026-10-03 真机层叠体检坐实】光数字大没用：z-index 比大小只在**同一层叠上下文**里成立。
 * 旧版把锚点挂进站点容器（#i3/#i2/#i1），而 e-hentai 给 #i1 设了 `position:relative;
 * z-index:1` —— 它创建了层叠上下文，按钮的 2147483001 被困在那口"锅"里，整口锅在根上下文
 * 只有 z=1，被挂 body 直达根上下文的画框（2147483000）整个压住 → 译图一现身按钮就消失。
 *
 * 修复：锚点改挂 `document.body`，与画框同台（同在根上下文），2147483001 > 2147483000
 * 才真正生效。
 *
 * 【2026-10-04】定位从「跟随图片矩形」改为「`position:fixed` 贴视口右下角」（用户要求），
 * 于是不再需要 offsetParent 换算、ResizeObserver 与 window resize 重算。
 */
const anchorZIndex = '2147483001';

let overlay: TranslatedImageOverlay | null = null;

/** 常驻画框按进程懒建一次：跨翻页不销毁，站点重建图片 DOM 也动不到它。 */
function translatedOverlay(): TranslatedImageOverlay | null {
  if (overlay !== null) return overlay;
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  overlay = createTranslatedImageOverlay({ document, window });
  return overlay;
}

export function isEhentaiImagePage(hostname: string, pathname: string): boolean {
  return (hostname === 'e-hentai.org' || hostname === 'exhentai.org') && pathname.startsWith('/s/');
}

function imageSource(image: Pick<ImageCandidate, 'currentSrc' | 'src'>): string {
  return image.currentSrc || image.src;
}

function visibleArea(image: Pick<ImageCandidate, 'clientWidth' | 'clientHeight' | 'naturalWidth' | 'naturalHeight'>): number {
  const width = image.clientWidth || image.naturalWidth;
  const height = image.clientHeight || image.naturalHeight;
  return width * height;
}

export function pickEhentaiMainImage<T extends ImageCandidate>(images: T[]): T | null {
  const byId = images.find((image) => image.id === 'img' && imageSource(image));
  if (byId) {
    return byId;
  }

  let best: T | null = null;
  let bestArea = 0;
  for (const image of images) {
    if (!imageSource(image)) {
      continue;
    }
    const area = visibleArea(image);
    if (area < minMainImageArea || area <= bestArea) {
      continue;
    }
    best = image;
    bestArea = area;
  }
  return best;
}

/**
 * Page identity for e-hentai image viewer pages.
 *
 * The viewer URL embeds the page identity itself: `/s/{imgkey}/{gid}-{page}`.
 * The image URL must never participate: e-hentai serves images from rotating CDN
 * hosts with time-signed `keystamp` query params, so folding it into the key makes
 * the identity drift and every cache lookup miss.
 */
export type EhentaiPageIdentity = {
  gid: number;
  page: number;
};

const ehentaiPagePathPattern = /^\/s\/[^/]+\/(\d+)-(\d+)\/?$/;

export function parseEhentaiPageIdentity(pathname: string): EhentaiPageIdentity | null {
  const match = ehentaiPagePathPattern.exec(String(pathname ?? ''));
  if (!match) {
    return null;
  }
  const gid = Number(match[1]);
  const page = Number(match[2]);
  if (!Number.isFinite(gid) || !Number.isFinite(page)) {
    return null;
  }
  return { gid, page };
}

export function ehentaiPageKey(identity: EhentaiPageIdentity): string {
  return `${identity.gid}-${identity.page}`;
}

function findMainImage(): HTMLImageElement | null {
  const images = Array.from(document.images);
  return pickEhentaiMainImage(images);
}

// ── 浮层按钮锚点（body 直挂）──
// 进程单例：跨翻页不销毁（站点重建图片 DOM 也动不到挂在 body 上的它），
// 翻页时 sync() 重新调 `createUiAnchor(新 target)` → 复用同一锚点、只换绑定目标。
// 前提：e-hentai 阅读页单图（`findImages()` 返回 0 或 1 个 target），单例够用。
type AnchorBinding = {
  anchor: HTMLElement;
  target: ImageTarget;
};

let anchorBinding: AnchorBinding | null = null;

function createAnchorElement(): HTMLElement {
  const anchor = document.createElement('div');
  anchor.setAttribute(anchorAttr, '');
  anchor.dataset.theme = 'dark';
  // 【2026-10-04 用户要求】按钮固定贴浏览器视口右下角：不跟随图片、不受滚动影响。
  // 右下角那块还叠着预载开关（见 content/index.ts 的 `prefetchToggleBottomPx`，
  // 用 anchorInsetPx 推出"让开按钮"的高度），两者共用同一套内缩常量，改一处记得看另一处。
  anchor.style.cssText = [
    'position:fixed',
    `right:${anchorInsetPx}px`,
    `bottom:${anchorInsetPx}px`,
    `z-index:${anchorZIndex}`,
  ].join(';');
  document.body.appendChild(anchor);
  return anchor;
}

export const ehentaiAdapter: SiteAdapter = {
  match() {
    return isEhentaiImagePage(location.hostname, location.pathname);
  },

  findImages() {
    const image = findMainImage();
    const originalUrl = image ? imageSource(image) : '';
    if (!image || !originalUrl) {
      return [];
    }
    // 身份只从 pathname 派生：图址每次请求都带新的 keystamp 签名，
    // 一旦掺进 key，同页两次访问必然撞不上（M0 实测坐实）。
    const identity = parseEhentaiPageIdentity(location.pathname);
    if (!identity) {
      return [];
    }
    return [{ element: image, key: ehentaiPageKey(identity), originalUrl }];
  },

  createUiAnchor(target: ImageTarget) {
    // 复用：锚点已连着文档 → 只换绑定目标（位置是 fixed，不用重算）。
    if (anchorBinding !== null && anchorBinding.anchor.isConnected) {
      anchorBinding.target = target;
      return anchorBinding.anchor;
    }

    // 重建：锚点没了（首次 / 被站点脚本扒走 / 测试重置模块）。
    const anchor = createAnchorElement();
    anchorBinding = { anchor, target };
    return anchor;
  },

  applyImage(target: ImageTarget, url: string) {
    target.element.src = url;
  },

  /**
   * 常驻画框：**绝不改写站点 `<img>` 的 src**。
   * - 有译图 → 画框在站点图那块位置上显示译图（原图请求照发，我们不等它）；
   * - 没译图 / 原文模式 → 画框隐身，露出站点原图。
   */
  applyOverlayImage(target: ImageTarget, url: string | null) {
    const layer = translatedOverlay();
    if (layer === null) return;
    if (url === null) {
      layer.hide();
      return;
    }
    layer.show(target, url);
  },

  observe(onChange: () => void) {
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList')) {
        onChange();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  },
};
