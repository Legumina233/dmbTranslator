import type { ImageTarget } from '../types';

/**
 * 常驻译图画框（2026-10-03 用户拍板）。
 *
 * **它解决的是"翻页闪一下"**：站点翻页时会把它那张 `<img>` 清空重建，元素一旦"空"过
 * 就必然有一段空白；而站点那张图还要走网络下载，等待期间也是空白。
 *
 * 所以这里**不再改写站点 `<img>` 的 src**（那正是 v0.1.4 "先空白再出图"的机理），
 * 改为在我们自己的一张常驻 `<img>` 上画译图：
 * - 画框挂 `document.body`，**不挂在站点容器里** → 站点重建图片 DOM 也动不到它；
 * - 画框**永远只显示译图**，没有译图就隐身让原图露出来（原文模式 = 隐身）；
 * - `pointer-events:none` → 站点"点图片翻下一页"的交互照旧可用；
 * - **不省原本的请求**：站点自己的原图请求照发不误，我们只是不等它。
 *
 * 调用方（`TranslatorCore.applyStateImage`）负责先解码再交给画框，
 * 所以画框现身那一帧就是画好的图。
 */

/** 画框层级：压过站点内容，但**低于**我们的浮层按钮（见 `ehentaiAdapter.createUiAnchor`）。 */
const overlayZIndex = '2147483000';
// 比较成立的前提（2026-10-03 真机层叠体检坐实）：画框与按钮锚点**都挂 body、同在根层叠
// 上下文**。按钮若挂回站点容器（#i1 有 position:relative;z-index:1 会创建层叠上下文），
// 它的高 z-index 被困在容器里，整锅只有 z=1，画框就把按钮连锅端了。

export type TranslatedImageOverlay = {
  /** 在 `target` 那块位置上显示 `url`（译图 blob 地址）。 */
  show(target: ImageTarget, url: string): void;
  /** 隐身：露出底下的站点原图。 */
  hide(): void;
  /** 重新对位（尺寸/布局变了时）。目标已脱离文档则自动隐身。 */
  sync(): void;
  visible(): boolean;
  dispose(): void;
};

export type TranslatedImageOverlayHost = {
  readonly document: Document;
  readonly window: Window;
};

export function createTranslatedImageOverlay(host: TranslatedImageOverlayHost): TranslatedImageOverlay {
  const { document: doc, window: win } = host;

  let element: HTMLImageElement | null = null;
  let target: ImageTarget | null = null;
  let src = '';
  let shown = false;
  let resizeObserver: { observe(el: Element): void; disconnect(): void } | null = null;

  const onWindowResize = (): void => {
    position();
  };

  function ensureElement(): HTMLImageElement | null {
    if (element !== null) return element;
    const parent = doc.body ?? doc.documentElement;
    if (!parent) return null;
    const img = doc.createElement('img');
    img.setAttribute('aria-hidden', 'true');
    img.alt = '';
    img.style.cssText = [
      'position:absolute',
      'display:none',
      `z-index:${overlayZIndex}`,
      'pointer-events:none',
      'object-fit:fill',
      'background:transparent',
      'border:0',
      'margin:0',
      'padding:0',
    ].join(';');
    img.dataset.mtTranslatedOverlay = '';
    parent.appendChild(img);
    element = img;
    win.addEventListener('resize', onWindowResize);
    return img;
  }

  function position(): void {
    const img = element;
    const current = target;
    if (img === null || current === null) return;
    const rect = current.element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    // 绝对定位的坐标原点 = 包含块的 padding box；用 offsetParent 的矩形换算，
    // 不假设 body 一定在文档原点（有 margin / border 时也不会偏）。
    const parentRect = (img.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    const left = parentRect ? rect.left - parentRect.left : rect.left + win.scrollX;
    const top = parentRect ? rect.top - parentRect.top : rect.top + win.scrollY;
    img.style.left = `${Math.round(left)}px`;
    img.style.top = `${Math.round(top)}px`;
    img.style.width = `${Math.round(rect.width)}px`;
    img.style.height = `${Math.round(rect.height)}px`;
  }

  function observeTarget(next: ImageTarget): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    const observerCtor = (win as unknown as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }).ResizeObserver;
    if (typeof observerCtor === 'function') {
      try {
        const observer = new observerCtor(() => position());
        observer.observe(next.element);
        resizeObserver = observer;
      } catch {
        resizeObserver = null;
      }
    }
  }

  return {
    show(nextTarget: ImageTarget, url: string): void {
      // 先判空再建元素：别为了"隐身"白造一个空 `<img>` 挂到页面上。
      if (!url) {
        this.hide();
        return;
      }
      const img = ensureElement();
      if (img === null) {
        this.hide();
        return;
      }
      if (target !== nextTarget) {
        target = nextTarget;
        observeTarget(nextTarget);
      }
      if (src !== url) {
        src = url;
        img.src = url;
      }
      img.style.display = 'block';
      shown = true;
      position();
    },

    hide(): void {
      shown = false;
      if (element !== null) {
        element.style.display = 'none';
      }
    },

    sync(): void {
      if (!shown || target === null) return;
      if (!target.element.isConnected) {
        this.hide();
        return;
      }
      position();
    },

    visible(): boolean {
      return shown;
    },

    dispose(): void {
      shown = false;
      target = null;
      src = '';
      resizeObserver?.disconnect();
      resizeObserver = null;
      win.removeEventListener('resize', onWindowResize);
      element?.remove();
      element = null;
    },
  };
}
