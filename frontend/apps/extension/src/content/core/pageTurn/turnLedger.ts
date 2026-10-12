/**
 * 翻页欠账账本（**方案甲** · 2026-10-12 用户拍板）。
 *
 * ## 它存在的理由（以及它替掉了什么）
 * 之前是"逐笔扣账"：按一下记一笔，看到一次页面移动再扣一笔。于是"谁先看到这次移动"
 * 决定了账目多少 —— 真机上出现过同一次移动被 100ms 快探与每秒到达检测**各扣一次**，
 * 账提前归零，第 3 下按下的那一页**凭空消失**（用户实测"连点 3 下只翻 2 页"）。
 *
 * 现在改成**由事实算账**，只记两个事实：
 *   · 你按了几下（`presses`）；
 *   · 按第一下时在第几页（`basePage`）。
 * 欠账 = `presses − (当前页 − basePage) × 方向`。**没有任何"扣账"动作**，
 * 因此不可能重复扣、也不可能被吞掉 —— 两个观察者看到同一次移动，只是各自重算同一个差值。
 *
 * ## 这套设计顺带**删掉**了原来的那些守卫
 * 因为欠账是从"页码"这个权威事实推出来的：
 *   · 不需要判断"站点就绪了没"（点一下没用 → 页码不变 → 欠账照旧）；
 *   · 不需要判断"我那一下生效没"（生效 → 页码变了 → 差额自动变小）；
 *   · 不需要"替点进行中""证据截止""100ms 快探"这些状态。
 * 唯一的节奏参数在调用方（每 N 毫秒试一次），而它**不会造成错误**，只影响快慢。
 *
 * 纯逻辑：不碰 DOM、不碰时间，全部参数由调用方传入，便于单测。
 */

/** 往前 = +1，往后 = -1。 */
export type TurnDirection = 1 | -1;

export type TurnLedger = {
  /** 记一次"用户按了往某方向一页"。 */
  press(direction: TurnDirection, currentPage: number): void;
  /** 某方向当前欠几页（不修改任何状态）。 */
  owed(direction: TurnDirection, currentPage: number): number;
  /** 当前有欠账的方向与页数；没有则 null（顺带清理已还清的方向）。 */
  active(currentPage: number): { direction: TurnDirection; owed: number } | null;
  /** 手动清空（离开阅读页 / 用户去了别处）。 */
  clear(): void;
};

/**
 * 上限：**最多替你持有 3 页欠账**（不是"一次 burst 最多 3 页"！）。
 *
 * ★ 2026-10-12 实测更正：站点**自己**受理的那些不进这本账 —— 它跟得上你的节奏时，
 * 就是你按几下它翻几页（真机日志：5 连按 → 前 2 格是站点自己翻的、后 3 格才是这里补的）。
 * 本上限只在"你按得比站点翻得快"时才起作用。
 */
export const turnLedgerCap = 3;

export function createTurnLedger(cap = turnLedgerCap): TurnLedger {
  let direction: TurnDirection | null = null;
  let basePage = 0;
  let presses = 0;

  /** 欠账 = 按下次数 − 已按该方向走过的格数（下限 0、上限 cap）。 */
  const owedFor = (currentPage: number): number => {
    if (direction === null) return 0;
    const moved = (currentPage - basePage) * direction;
    return Math.max(0, Math.min(cap, presses - moved));
  };

  /** 还清了就把方向状态清掉 —— 下一次按下会以"当时那一页"为新基准。 */
  const forgetIfSettled = (currentPage: number): void => {
    if (direction !== null && owedFor(currentPage) === 0) {
      direction = null;
      presses = 0;
    }
  };

  return {
    press(next, currentPage) {
      forgetIfSettled(currentPage);
      if (direction === null) {
        direction = next;
        basePage = currentPage;
        presses = 1;
        return;
      }
      if (direction !== next) {
        // 方向反转：丢弃旧方向的欠账，从这一下重新开始（用户改主意了）。
        direction = next;
        basePage = currentPage;
        presses = 1;
        return;
      }
      presses = Math.min(cap, presses + 1);
    },

    owed(next, currentPage) {
      if (direction !== next) return 0;
      return owedFor(currentPage);
    },

    active(currentPage) {
      forgetIfSettled(currentPage);
      if (direction === null) return null;
      const owed = owedFor(currentPage);
      return owed > 0 ? { direction, owed } : null;
    },

    clear() {
      direction = null;
      presses = 0;
    },
  };
}
