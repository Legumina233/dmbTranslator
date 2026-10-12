import { describe, expect, it } from 'vitest';
import {
  readDeclaredTarget,
  readLoadImageTarget,
} from '../../../apps/extension/src/content/adapters/ehentaiPageControls';

/**
 * 站点"翻页控件"的声明目标怎么读。
 *
 * 真机实测的两种形态（2026-10-11）：
 *  · `onclick="load_image(158, 'key')"` ← 首选（href 往往只是 `#`）；
 *  · href 指向 `…/4246067-158`（完整网址）。
 * 读不出来的情形必须返回 `null` —— 上层据此"什么都不做"，**绝不清空队列**。
 */

/** 极简假元素：只桩 readDeclaredTarget 用到的那几个面。 */
function fakeElement(
  attributes: Record<string, string>,
  ancestor: Record<string, string> | null = attributes,
): Element {
  const self = {
    closest: (selector: string) => (selector === 'a, area' && ancestor !== null ? self : null),
    getAttribute: (name: string) => (ancestor ?? {})[name] ?? null,
  };
  void attributes;
  return self as unknown as Element;
}

const base = 'https://e-hentai.org/s/abc123def/4246067-158';

describe('readDeclaredTarget · 读翻页控件声明的目标页码', () => {
  it('onclick 里有 load_image(N) → 取 N（首选，站点权威声明）', () => {
    expect(readDeclaredTarget(fakeElement({
      href: '#',
      onclick: "return load_image(159, 'a1b2c3d4e5');",
    }), base)).toBe(159);
  });

  it('没有 onclick 时退回 href（完整网址）', () => {
    expect(readDeclaredTarget(fakeElement({
      href: 'https://e-hentai.org/s/abc123def/4246067-160',
    }), base)).toBe(160);
  });

  it('href 只是 `#`（站点常见）→ 读不出，返回 null', () => {
    expect(readDeclaredTarget(fakeElement({ href: '#' }), base)).toBeNull();
  });

  it('两者都没有 → 返回 null', () => {
    expect(readDeclaredTarget(fakeElement({}), base)).toBeNull();
  });

  it('点到的不是控件（祖先里没有 a/area）→ 返回 null', () => {
    expect(readDeclaredTarget(fakeElement({ href: '#' }, null), base)).toBeNull();
  });

  it('元素为 null → 返回 null（调用方什么都不做）', () => {
    expect(readDeclaredTarget(null, base)).toBeNull();
  });

  it('onclick 与 href 同时存在且冲突 → **以 onclick 为准**', () => {
    expect(readDeclaredTarget(fakeElement({
      onclick: 'load_image(161)',
      href: 'https://e-hentai.org/s/abc123def/4246067-999',
    }), base)).toBe(161);
  });
});

describe('readLoadImageTarget · 只读站点 onclick 的权威声明', () => {
  it('有 load_image(N) → N（上层据此识别"陈旧的下一页控件"）', () => {
    expect(readLoadImageTarget(fakeElement({ onclick: "return load_image(158, 'k');" }))).toBe(158);
  });

  it('只有 href、没有 onclick → null（纯 href 形态没有"陈旧声明"这个语义）', () => {
    expect(readLoadImageTarget(fakeElement({ href: 'https://e-hentai.org/s/abc/4246067-159' }))).toBeNull();
  });
});
