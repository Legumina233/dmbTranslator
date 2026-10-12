import { describe, expect, it } from 'vitest';
import { createTurnLedger, turnLedgerCap } from '../../../../apps/extension/src/content/core/pageTurn/turnLedger';

/**
 * 方案甲（由事实算账）的核心不变量。
 *
 * 这套设计的价值就是"**账不可能算错**"：没有扣账动作，欠账永远等于
 * `按下次数 − 该方向实际走过的格数`。下面第 ① 与 ⑤ 条正是真机踩过的两个坑。
 */
describe('turnLedger · 由事实算账（方案甲）', () => {
  it('① 页码没动（点击被站点忽略）→ 欠账**不变**（这是旧实现丢账的地方）', () => {
    const ledger = createTurnLedger();
    ledger.press(1, 25);
    ledger.press(1, 25);
    ledger.press(1, 25);
    // 站点一下都没受理（页码始终 25）→ 三笔欠账都还在。
    expect(ledger.owed(1, 25)).toBe(3);
    expect(ledger.active(25)).toEqual({ direction: 1, owed: 3 });
  });

  it('② 页面真的走了一格 → 欠账自动少一（不需要任何"扣账"动作）', () => {
    const ledger = createTurnLedger();
    ledger.press(1, 25);
    ledger.press(1, 25);
    expect(ledger.owed(1, 26)).toBe(1);
    // ★ 关键：同一个新页码再看一次，结果一样 —— 重复观察**不会**重复扣账。
    expect(ledger.owed(1, 26)).toBe(1);
    expect(ledger.owed(1, 27)).toBe(0);
  });

  it('③ 还清后自动清零；下一次按下以"当时那一页"为新基准', () => {
    const ledger = createTurnLedger();
    ledger.press(1, 25);
    expect(ledger.active(26)).toBeNull(); // 已交付 → 清掉方向状态
    ledger.press(1, 26);
    expect(ledger.owed(1, 26)).toBe(1);
  });

  it('④ 上限 3：连按 5 下最多也只交付 3 页', () => {
    const ledger = createTurnLedger();
    for (let i = 0; i < 5; i += 1) ledger.press(1, 25);
    expect(ledger.owed(1, 25)).toBe(turnLedgerCap);
  });

  it('⑤ 方向反转：丢弃旧方向的欠账，从这一下重新开始（真机"往回又自己往前"的防线）', () => {
    const ledger = createTurnLedger();
    ledger.press(1, 25);
    ledger.press(1, 25);
    expect(ledger.owed(1, 25)).toBe(2);
    ledger.press(-1, 25); // 用户改主意，往回
    expect(ledger.owed(1, 25)).toBe(0);
    expect(ledger.active(25)).toEqual({ direction: -1, owed: 1 });
    expect(ledger.owed(-1, 24)).toBe(0); // 往回走一格 → 交付完成
  });

  it('⑥ 没按过 / 清了之后：欠账 0、无活动方向', () => {
    const ledger = createTurnLedger();
    expect(ledger.active(30)).toBeNull();
    ledger.press(1, 30);
    ledger.clear();
    expect(ledger.owed(1, 30)).toBe(0);
    expect(ledger.active(30)).toBeNull();
  });

  it('⑦ 用户自己往回翻（页码倒退）不会把向前的欠账"还掉"成负数', () => {
    const ledger = createTurnLedger();
    ledger.press(1, 25);
    // 页码倒退到 24：欠账被夹在上限内，不会变成负数或无限增长。
    expect(ledger.owed(1, 24)).toBeLessThanOrEqual(turnLedgerCap);
    expect(ledger.owed(1, 24)).toBeGreaterThanOrEqual(0);
  });
});
