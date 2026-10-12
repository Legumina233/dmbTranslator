import { describe, expect, it } from 'vitest';
import { resolveSiteTranslationPage } from '../../../apps/extension/src/content/adapters/ehentaiPageTarget';

/**
 * 毛病 A 的判据：**只贴站点已经翻到的那一页**。
 *
 * 它钉住的是一条曾经被违反过的规则：2026-10-11 之前，扩展按键/点击的**瞬间**就按 ±1 预测
 * 下一页并贴图，而 e-hentai 一次只受理一格（连点第二下 `accepted=False`）—— 结果屏幕上出现
 * "站点没去的那一页"的译图，等原图加载完又跳回来。
 *
 * ⚠️ 老实说：这是**纯函数级**的保护，能钉住"判据本身"；真正拦住"有人又把预测加回调用点"
 * 需要给内容脚本搭 DOM 集成环境（那是一件独立的活，尚未做）。
 */
describe('resolveSiteTranslationPage · 只贴站点已经翻到的那一页', () => {
  it('网址与页身份一致 → 可以贴（返回页码）', () => {
    expect(resolveSiteTranslationPage({
      pathname: '/s/abc123def/4246067-15',
      pageKey: '4246067-15',
    })).toBe(15);
  });

  it('★ 预测页：网址还停在第 15 页，却要贴第 16 页 → 拦住（返回 null）', () => {
    expect(resolveSiteTranslationPage({
      pathname: '/s/abc123def/4246067-15',
      pageKey: '4246067-16',
    })).toBeNull();
  });

  it('非阅读页（画廊页等）→ 不介入', () => {
    expect(resolveSiteTranslationPage({
      pathname: '/g/4246067/abc123def/',
      pageKey: '4246067-15',
    })).toBeNull();
  });

  it('同一页码但 gid 不同 → 也不贴（页身份必须完全一致）', () => {
    expect(resolveSiteTranslationPage({
      pathname: '/s/abc123def/4246067-15',
      pageKey: '9999999-15',
    })).toBeNull();
  });

  it('网址后半段被重写、页码没变（站点常态）→ 贴的还是当前页，属正确行为', () => {
    // 实测存在 "from=12 to=12" 这种事件：URL 变了但页码没变。这里不该被误判成"翻页"。
    expect(resolveSiteTranslationPage({
      pathname: '/s/REWRITTENKEY/4246067-15',
      pageKey: '4246067-15',
    })).toBe(15);
  });

  it('网址畸形 / 不是阅读页格式 → 不贴', () => {
    expect(resolveSiteTranslationPage({ pathname: '/', pageKey: '4246067-15' })).toBeNull();
    expect(resolveSiteTranslationPage({ pathname: '', pageKey: '4246067-15' })).toBeNull();
  });
});
