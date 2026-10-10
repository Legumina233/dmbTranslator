import { describe, expect, it, vi } from 'vitest';
import { createTranslatedImageOverlay } from '../../../../apps/extension/src/content/core/overlay/translatedImageOverlay';
import type { ImageTarget } from '../../../../apps/extension/src/content/core/types';

/**
 * 测试环境是 **node**（没有 jsdom），所以这里用最小假 DOM 驱动画框。
 * 只桩画框真正用到的那几个面：`createElement('img')` / `body.appendChild` /
 * `getBoundingClientRect` / `isConnected` / `offsetParent` / `addEventListener`。
 *
 * 刻意不桩 `ResizeObserver` —— 假 window 上没有它，正好顺带验证"没有 ResizeObserver 也能跑"。
 */

type Rect = { left: number; top: number; width: number; height: number };

function createFakeImageElement(rect: Rect): Record<string, unknown> {
  const style: Record<string, string> = { cssText: '' };
  return {
    src: '',
    alt: '',
    style,
    dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string): void {
      (this.attributes as Record<string, string>)[name] = value;
    },
    getBoundingClientRect: (): Rect => rect,
    offsetParent: null,
    isConnected: true,
  };
}

function createFakeDom(rect: Rect) {
  const appended: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  const listeners: Record<string, Array<() => void>> = {};

  const body = {
    appendChild(node: Record<string, unknown>): Record<string, unknown> {
      appended.push(node);
      return node;
    },
  };

  const document = {
    body,
    createElement(tag: string): Record<string, unknown> {
      const element = createFakeImageElement(rect);
      (element as { tag?: string }).tag = tag;
      (element as { remove?: () => void }).remove = () => {
        removed.push(element);
      };
      return element;
    },
  };

  const window = {
    scrollX: 0,
    scrollY: 0,
    addEventListener(type: string, listener: () => void): void {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener(type: string, listener: () => void): void {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
    },
  };

  return { document, window, appended, removed, listeners };
}

function createTarget(rect: Rect): ImageTarget {
  const element = createFakeImageElement(rect);
  return {
    element: element as unknown as HTMLImageElement,
    key: 'gid-8',
    originalUrl: 'https://example.com/original.jpg',
  };
}

describe('translatedImageOverlay', () => {
  it('现身时把译图挂到自己的画框上，并按站点图那块位置对位', () => {
    const dom = createFakeDom({ left: 10, top: 20, width: 300, height: 400 });
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget({ left: 10, top: 20, width: 300, height: 400 });

    overlay.show(target, 'blob:translated-8');

    expect(dom.appended).toHaveLength(1);
    const layer = dom.appended[0] as { src: string; style: Record<string, string> };
    expect(layer.src).toBe('blob:translated-8');
    expect(layer.style.display).toBe('block');
    expect(layer.style.left).toBe('10px');
    expect(layer.style.top).toBe('20px');
    expect(layer.style.width).toBe('300px');
    expect(layer.style.height).toBe('400px');
    expect(overlay.visible()).toBe(true);
  });

  it('隐身只改 display，不销毁画框 —— 常驻的意义就在这', () => {
    const dom = createFakeDom({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget({ left: 0, top: 0, width: 100, height: 100 });

    overlay.show(target, 'blob:one');
    overlay.hide();

    const layer = dom.appended[0] as { style: Record<string, string> };
    expect(layer.style.display).toBe('none');
    expect(overlay.visible()).toBe(false);
    expect(dom.removed).toHaveLength(0);
  });

  it('站点把那张 img 换掉后（isConnected=false）自动隐身，不会留一张错图在屏上', () => {
    const dom = createFakeDom({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget({ left: 0, top: 0, width: 100, height: 100 });

    overlay.show(target, 'blob:one');
    (target.element as unknown as { isConnected: boolean }).isConnected = false;

    overlay.sync();

    expect(overlay.visible()).toBe(false);
  });

  it('url 为空时 show 等同隐身，绝不拿空串去设 src', () => {
    const dom = createFakeDom({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget({ left: 0, top: 0, width: 100, height: 100 });

    overlay.show(target, '');

    expect(dom.appended).toHaveLength(0);
    expect(overlay.visible()).toBe(false);
  });

  it('dispose 摘掉画框并解绑 resize 监听', () => {
    const dom = createFakeDom({ left: 0, top: 0, width: 100, height: 100 });
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget({ left: 0, top: 0, width: 100, height: 100 });

    overlay.show(target, 'blob:one');
    expect(dom.listeners.resize).toHaveLength(1);

    overlay.dispose();

    expect(dom.removed).toHaveLength(1);
    expect(dom.listeners.resize).toHaveLength(0);
    expect(overlay.visible()).toBe(false);
  });

  it('窗口尺寸变化时重新对位（不重建画框）', () => {
    const rect = { left: 0, top: 0, width: 100, height: 100 };
    const dom = createFakeDom(rect);
    const overlay = createTranslatedImageOverlay({
      document: dom.document as unknown as Document,
      window: dom.window as unknown as Window,
    });
    const target = createTarget(rect);
    overlay.show(target, 'blob:one');
    const layer = dom.appended[0] as { style: Record<string, string> };

    rect.width = 640;
    dom.listeners.resize?.[0]?.();

    expect(layer.style.width).toBe('640px');
    expect(dom.appended).toHaveLength(1);
    expect(vi.isMockFunction(overlay.show)).toBe(false);
  });
});
