// @vitest-environment jsdom
/**
 * 弹窗「向后预载」开关的**渲染测试**（本项目第一条弹窗渲染测试）。
 *
 * ## 为什么需要它
 * 弹窗此前是**零渲染测试**：2026-10-11 那次改动让弹窗切不到「本地模型」栏，只能靠用户真机发现。
 * 这条测试钉住的是"预载数量记忆"这件事在**界面上**的行为 —— 也就是用户实际看到/点到的东西：
 *   · 开关状态**只派生自 `prefetchDepth`**（不变量：记忆值不表达开关状态）；
 *   · 关掉再打开 → 回到**设置里的记忆值**（不是硬编码的 4）；
 *   · 记忆值缺席时退回组件内兜底（**不许崩**，这是上次事故的防线）。
 *
 * 环境：仅本文件用 jsdom（文件头 docblock），不动全局 vitest 配置。
 * 组件依赖 chrome/网络，故**先装桩、再动态 import**（保证模块求值时桩已在）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';

// ── 模块求值前先装桩 ────────────────────────────────────────────────────────
const sendMessage = vi.fn(async () => ({ ok: true }));
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    sendMessage,
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
    sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
  },
  tabs: { query: vi.fn(async () => []), sendMessage: vi.fn(async () => undefined) },
};
(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('{}', {
  status: 200,
  headers: { 'content-type': 'application/json' },
}));

const { LocalModelControl } = await import('../../apps/extension/src/popup/LocalModelControl');

type Props = {
  baseUrl: string;
  model: string;
  onPickModel: (model: string) => void;
  cacheLimit: number;
  onCacheLimitChange: (limit: number) => void;
  prefetchDepth: number;
  onPrefetchDepthChange: (depth: number) => void;
  lastNonZeroPrefetchDepth: number;
  autoTranslateOnEnter: boolean;
  onAutoTranslateOnEnterChange: (enabled: boolean) => void;
};

function renderControl(overrides: Partial<Props> = {}): { onPrefetchDepthChange: ReturnType<typeof vi.fn> } {
  const onPrefetchDepthChange = vi.fn();
  const props: Props = {
    baseUrl: '',
    model: '',
    onPickModel: vi.fn(),
    cacheLimit: 15,
    onCacheLimitChange: vi.fn(),
    prefetchDepth: 8,
    onPrefetchDepthChange,
    lastNonZeroPrefetchDepth: 8,
    autoTranslateOnEnter: false,
    onAutoTranslateOnEnterChange: vi.fn(),
    ...overrides,
  };
  render(createElement(LocalModelControl as never, props as never));
  return { onPrefetchDepthChange };
}

const switchEl = (): HTMLElement => screen.getByRole('switch', { name: '向后预载开关' });

describe('弹窗 · 向后预载开关（渲染）', () => {
  beforeEach(() => {
    cleanup();
    sendMessage.mockClear();
  });

  it('① 开关状态**只**派生自 prefetchDepth：记忆值是 7、深度是 0 → 显示"关"', () => {
    renderControl({ prefetchDepth: 0, lastNonZeroPrefetchDepth: 7 });
    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('已关闭预载')).toBeTruthy();
  });

  it('② 关掉：点一下 → 传 0（关闭）', () => {
    const { onPrefetchDepthChange } = renderControl({ prefetchDepth: 8, lastNonZeroPrefetchDepth: 8 });
    expect(switchEl().getAttribute('aria-checked')).toBe('true');

    fireEvent.click(switchEl());

    expect(onPrefetchDepthChange).toHaveBeenCalledWith(0);
  });

  it('★ ③ 再打开：回到**设置里的记忆值**（不是硬编码 4）—— 本次修的那个 bug', () => {
    const { onPrefetchDepthChange } = renderControl({ prefetchDepth: 0, lastNonZeroPrefetchDepth: 8 });
    expect(switchEl().getAttribute('aria-checked')).toBe('false');

    fireEvent.click(switchEl());

    expect(onPrefetchDepthChange).toHaveBeenCalledWith(8);
    expect(onPrefetchDepthChange).not.toHaveBeenCalledWith(4);
  });

  it('④ 记忆值缺席 → 退回组件内兜底，且**不许崩**（上次弹窗事故的防线）', () => {
    const { onPrefetchDepthChange } = renderControl({
      prefetchDepth: 0,
      lastNonZeroPrefetchDepth: undefined as unknown as number,
    });

    expect(switchEl().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(switchEl()); // 关键：这一步不许抛异常
    expect(onPrefetchDepthChange).toHaveBeenCalledTimes(1);
    expect(onPrefetchDepthChange.mock.calls[0][0]).toBeGreaterThanOrEqual(1);
  });
});
