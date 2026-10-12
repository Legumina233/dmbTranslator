import { createTurnLedger, type TurnDirection, type TurnLedger } from './turnLedger';

/**
 * 翻页驱动器（**方案甲** · 2026-10-12）—— 把"采集意图 → 补交付"这段接线从 `content/index.ts`
 * 里抽出来，使它**可以被测试**（那个文件无法单独 import，之前的接线 bug 全都没法被自动化拦住）。
 *
 * ## 设计：纯"被调用"，自己不碰定时器
 * 调用方（内容脚本）负责节奏：欠账 > 0 时按固定间隔调 `tick()`，欠账归零就停表。
 * 这样本模块**不接触时间**，测试里可以一格一格手工推进 —— 这正是能钉住 bug 的关键。
 *
 * ## 它替掉的旧机制
 * 详情见 `turnLedger.ts`；一句话：旧实现"逐笔扣账 + 就绪判据 + 证据截止 + in-flight 标记"，
 * 真机上出现同一次移动被扣两次（第 3 下凭空消失）、认不出按钮就整下丢弃等一串问题。
 *
 * ## 关于"我们自己点的那一下"
 * `tick()` 里的点击会真的触发 DOM click 事件 → 会被内容脚本的采集器看到。
 * 所以驱动器把它包起来并置位一个标记，采集器用 `consumeOwnClick()` 问一句：
 * "刚才这一下是我自己点的吗？" —— 是就跳过（否则会把替点算成用户的按下，账越滚越多）。
 */
export type TurnDriverEvent =
  | { type: 'pressed'; direction: TurnDirection; kind: 'keyboard' | 'click'; owed: number; page: number }
  | { type: 'driven'; direction: TurnDirection; owed: number; page: number }
  | { type: 'settled'; page: number | null };

export type TurnDriver = {
  ledger: TurnLedger;
  /** 记一次用户操作，返回记完之后的欠账（0 = 无需驱动）。 */
  press(direction: TurnDirection, kind: 'keyboard' | 'click'): number;
  /** 尝试交付一格，返回本次调用后的欠账（0 = 调用方可以停表）。 */
  tick(): number;
  /** 只在 `tick()` 触发的 click 事件**同步期间**返回 true。 */
  consumeOwnClick(): boolean;
};

export function createTurnDriver(deps: {
  /** 当前页码；非阅读页返回 null（此时清空欠账）。 */
  readPage: () => number | null;
  /** 找某方向的控件（按角色，不看声明的页码）。 */
  findControl: (direction: TurnDirection) => Element | null;
  /** 点那个控件（走站点自己的 onclick）。 */
  clickControl: (control: Element) => void;
  onEvent?: (event: TurnDriverEvent) => void;
}): TurnDriver {
  const ledger = createTurnLedger();
  let ownClick = false;

  return {
    ledger,

    press(direction, kind) {
      const page = deps.readPage();
      if (page === null) return 0;
      ledger.press(direction, page);
      const active = ledger.active(page);
      const owed = active === null ? 0 : active.owed;
      deps.onEvent?.({ type: 'pressed', direction, kind, owed, page });
      return owed;
    },

    tick() {
      const page = deps.readPage();
      if (page === null) {
        ledger.clear();
        deps.onEvent?.({ type: 'settled', page: null });
        return 0;
      }
      const active = ledger.active(page);
      if (active === null) {
        deps.onEvent?.({ type: 'settled', page });
        return 0;
      }
      const control = deps.findControl(active.direction);
      if (control !== null) {
        deps.onEvent?.({ type: 'driven', direction: active.direction, owed: active.owed, page });
        ownClick = true;
        try {
          deps.clickControl(control);
        } finally {
          ownClick = false;
        }
      }
      // ★ 必须**重新读页**：`clickControl` 可能已经让页码前进了一格。
      //   （用开头捕获的旧页码复算 → 欠账看起来没变 —— 集成测试就是这么把它抓出来的。）
      const after = deps.readPage();
      return after === null ? 0 : owedAfter(ledger, after);
    },

    consumeOwnClick() {
      return ownClick;
    },
  };
}

/** 复算一次欠账（`clickControl` 之后页码可能已经变了）。 */
function owedAfter(ledger: TurnLedger, page: number): number {
  const active = ledger.active(page);
  return active === null ? 0 : active.owed;
}
