import { describe, expect, it } from 'vitest';
import {
  defaultPrefetchDepth,
  normalizeLastNonZeroPrefetchDepth,
  normalizeSettings,
} from '../../apps/extension/src/shared/config';

/**
 * 「预载打开时回到几」（`lastNonZeroPrefetchDepth`）的**四条不变量**（2026-10-11 用户拍板）。
 *
 * 它是为了修掉"开关显示开、深度却是 0"这类两处状态打架：把"上次是几"从两处 UI 的各自记忆
 * 提升成设置字段。要点是**语义正交** —— 它只回答"开的时候回到几"，永不表达开关状态。
 */
describe('lastNonZeroPrefetchDepth · 四条不变量', () => {
  it('① 语义正交：记忆值是 7 而深度是 0 时，开关仍显示"关"（看的是 depth）', () => {
    const settings = normalizeSettings({ prefetchDepth: 0, lastNonZeroPrefetchDepth: 7 });
    // 开关状态只由这一条决定 —— 记忆值不参与。
    expect(settings.prefetchDepth).toBe(0);
    expect(settings.prefetchDepth > 0).toBe(false);
    // 但记忆值必须原样活下来，供"再打开"时使用。
    expect(settings.lastNonZeroPrefetchDepth).toBe(7);
  });

  it('② 0 / 越界 / 非整数 / 非数字一律回落（0 非法：它不允许表达"关"）', () => {
    expect(normalizeLastNonZeroPrefetchDepth(0, 5)).toBe(5);
    expect(normalizeLastNonZeroPrefetchDepth(-1, 5)).toBe(5);
    expect(normalizeLastNonZeroPrefetchDepth(11, 5)).toBe(10); // 越界封顶到 maxPrefetchDepth
    expect(normalizeLastNonZeroPrefetchDepth(3.5, 5)).toBe(5);
    expect(normalizeLastNonZeroPrefetchDepth('8', 5)).toBe(5);
    expect(normalizeLastNonZeroPrefetchDepth(undefined, 5)).toBe(5);
    expect(normalizeLastNonZeroPrefetchDepth(8, 5)).toBe(8);
  });

  it('③ 迁移：老设备没有该字段 → 沿用当前深度；当前深度为 0 → 用默认值', () => {
    // 用户当初设的是 8 → 升级后"关掉再打开"应回到 8，而不是被重置成默认值。
    expect(normalizeSettings({ prefetchDepth: 8 }).lastNonZeroPrefetchDepth).toBe(8);
    // 当前深度是 0（关闭）→ 没有可沿用的值，落到默认。
    expect(normalizeSettings({ prefetchDepth: 0 }).lastNonZeroPrefetchDepth)
      .toBe(defaultPrefetchDepth);
    // 更老的 storage：`prefetchEnabled: false` 先被翻译成 0，于是同样落到默认。
    expect(normalizeSettings({ prefetchEnabled: false, prefetchDepth: 8 }).lastNonZeroPrefetchDepth)
      .toBe(defaultPrefetchDepth);
  });

  it('④ 关掉（0）再打开：记忆值必须原样保留（这正是本字段存在的理由）', () => {
    const opened = normalizeSettings({ prefetchDepth: 8, lastNonZeroPrefetchDepth: 8 });
    const closed = normalizeSettings({ ...opened, prefetchDepth: 0 });
    expect(closed.prefetchDepth).toBe(0);
    expect(closed.lastNonZeroPrefetchDepth).toBe(8); // ← 关掉时**不动**它
    // 再打开时，UI 用这个值回到 8（而不是默认 4）。
    expect(closed.lastNonZeroPrefetchDepth).not.toBe(defaultPrefetchDepth);
  });

  it('⑤ 写入非零深度时，记忆值被同步成它（真机 bug：弹窗那条写入路径曾绕过唯一写入点）', () => {
    // 真机场景：设置里记忆值是 4（默认），用户在**弹窗**里把深度调成 8。
    // 弹窗把整个 settings 对象写回去，里面还带着旧的 4 —— 若不在设置层纠正，
    // 关掉再打开就会跳回 4（用户实测复现）。
    const afterPopupWrite = normalizeSettings({
      prefetchDepth: 8,
      lastNonZeroPrefetchDepth: 4,
    });
    expect(afterPopupWrite.lastNonZeroPrefetchDepth).toBe(8);
    // 之后关掉：记忆值保持 8。
    const closed = normalizeSettings({ ...afterPopupWrite, prefetchDepth: 0 });
    expect(closed.lastNonZeroPrefetchDepth).toBe(8);
  });
});
