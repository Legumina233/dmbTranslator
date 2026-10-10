import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialPhotoState } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  createUiElements,
  renderUi,
} from '../../../apps/extension/src/content/core/ui/imageControls';

class FakeElement {
  className = '';
  type = '';
  textContent = '';
  innerHTML = '';
  title = '';
  tabIndex = -1;
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  style: Record<string, string> & {
    setProperty(name: string, value: string): void;
  };

  constructor() {
    const values = Object.create(null) as Record<string, string>;
    this.style = Object.assign(values, {
      setProperty(name: string, value: string) {
        values[name] = value;
      },
    });
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5)] = value;
    }
  }

  getBoundingClientRect() {
    return {
      width: 100,
      height: 32,
      left: 0,
      right: 100,
      top: 0,
      bottom: 32,
    };
  }
}

describe('image controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders tweet-context notices on a second gray detail line', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });
    const ui = createUiElements();
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'translated';
    state.elapsedText = '耗时 12.3 秒';
    state.contextNoticeText = '未找到推文作为上下文';

    renderUi(ui, state);

    expect(ui.detailLine.textContent).toBe('耗时 12.3 秒');
    expect(ui.contextNoticeLine.textContent).toBe('未找到推文作为上下文');
    expect(ui.contextNoticeLine.className).toContain('mt-x-detail');
  });

  it('运行中（可终止）：外观保持原样，只是**可点**', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });
    const ui = createUiElements();
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'running';
    state.stageText = 'OCR 识别中…';

    renderUi(ui, state, { cancelableWhileRunning: true });

    // 用户拍板：不要改文案、不要换图标、不要把阶段文字挪到 detail 行 —— 只让它能点
    expect(ui.button.disabled).toBe(false);
    expect(ui.buttonLabel.textContent).toBe('OCR 识别中…');
    expect(ui.detailLine.textContent).toBe('');
  });

  it('运行中但还没报阶段文字：按钮仍是默认「翻译中...」，可点', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });
    const ui = createUiElements();
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'running';
    state.stageText = '';

    renderUi(ui, state, { cancelableWhileRunning: true });

    expect(ui.button.disabled).toBe(false);
    expect(ui.buttonLabel.textContent).toBe('翻译中...');
    expect(ui.detailLine.textContent).toBe('');
  });

  it('不可终止的调用方（截图 UI）：运行中保持禁用 + 显示阶段文字，按钮不说谎', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });
    const ui = createUiElements();
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'running';
    state.stageText = 'OCR 识别中…';

    renderUi(ui, state); // 不传能力 = 旧行为（禁用 + 阶段文字）

    expect(ui.button.disabled).toBe(true);
    expect(ui.buttonLabel.textContent).toBe('OCR 识别中…');
    expect(ui.detailLine.textContent).toBe('');
  });
});
