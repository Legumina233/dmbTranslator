/**
 * M3 Step 8 · PageScheduler —— 只做「优先级排序 + 并发恒 1 的派发」。
 *
 * **职责边界（照指南原文，别扩）**：
 * - 只**排序** + 派给 Arbiter；**不执行**、**不 abort**。
 *   执行与取消是仲裁器/执行层的活，Scheduler 插进去只会多一套并行状态机。
 * - **并发恒为 1**：16 GB 显存约束，同时只能有一张图在跑（`active` 永远是 0 或 1）。
 *
 * 优先级 P0–P3（**本处即权威定义**）：
 * `P0` 当前页 · `P1` N+1 · `P2` N+2 · `P3` 更远。
 *
 * **本文件零 import**：与 M1/M2 的纯逻辑模块同一风格 —— 不依赖 Arbiter 的具体实现，
 * 派发动作由调用方注入，因此可以完全离线自检"并发是不是恒 1"。
 */

export type PagePriority = 'P0' | 'P1' | 'P2' | 'P3';

/** 与当前页的距离 → 优先级。`distance` 是页距（0 = 当前页）。 */
export type SchedulerTask = {
  readonly pageKey: string;
  /** 与当前页的距离：0 = 当前页，1 = N+1，2 = N+2，3 及以上 = 更远。 */
  readonly distance: number;
};

export type ScheduledTask = SchedulerTask & { readonly priority: PagePriority };

/** 派发动作。Scheduler 只调用它，不管它内部怎么执行、也不负责取消它。 */
export type PageSchedulerDispatch = (task: ScheduledTask) => void | Promise<void>;

export type PageSchedulerOptions = {
  /**
   * 预取窗口深度：**距离大于它的任务只入队、不派发**（Step 9）。
   * 不传 = 不设门（Step 8 的行为）。设了门以后，远页会安静地排队等窗口平移过来 ——
   * 那时它往往已经命中缓存，不必白烧一次请求（这也是 M3b 风控的前置保障）。
   */
  readonly maxDistance?: number;
};

/** 预取窗口深度：N+1…N+4（指南定的四个）。 */
export const defaultPrefetchDepth = 4;

/** `retarget` 的结果。**没有任何"清了哪些缓存"的字段** —— 因为它永远不会清（见方法注释）。 */
export type RetargetOutcome = {
  /** 新窗口里、之前没排过的（需要新跑）。 */
  readonly added: readonly ScheduledTask[];
  /** 从队列里撤下的（新窗口外）。**只是离开队列**，落盘缓存一条都没动。 */
  readonly dropped: readonly ScheduledTask[];
  /** 仍在窗口内、继续排队的（距离按新当前页重算过）。 */
  readonly retained: readonly ScheduledTask[];
  /** 在飞任务是否已不属于新窗口 —— 由持有派发权的一方决定要不要取消它。 */
  readonly inFlightNowStale: boolean;
};

const priorityOrder: readonly PagePriority[] = ['P0', 'P1', 'P2', 'P3'];

export function priorityForDistance(distance: number): PagePriority {
  if (!Number.isInteger(distance) || distance < 0) {
    throw new Error(`页距必须是非负整数，收到 ${String(distance)}`);
  }
  if (distance === 0) return 'P0';
  if (distance === 1) return 'P1';
  if (distance === 2) return 'P2';
  return 'P3';
}

export class PageScheduler {
  private queue: ScheduledTask[] = [];
  private running: ScheduledTask | null = null;
  private pumpPromise: Promise<void> | null = null;
  private sequence = 0;
  private readonly enqueueOrder = new Map<string, number>();
  private maxDistance: number;

  constructor(
    private readonly dispatch: PageSchedulerDispatch,
    options: PageSchedulerOptions = {},
  ) {
    this.maxDistance = options.maxDistance ?? Number.POSITIVE_INFINITY;
  }

  /** 在飞任务数。**恒为 0 或 1** —— 这就是"并发恒 1"的可观测口径。 */
  get active(): number {
    return this.running === null ? 0 : 1;
  }

  /** 排队中的任务（按实际出队顺序）。 */
  get queued(): readonly ScheduledTask[] {
    return [...this.queue];
  }

  /**
   * 排队中**被窗口挡住**（距离大于 `maxDistance`）的任务。
   * 它们在队列里、顺序也算好了，只是现在不派发 —— "只入队不执行"。
   */
  get gated(): readonly ScheduledTask[] {
    return this.queue.filter((task) => !this.dispatchable(task));
  }

  /** 移动预取窗口（翻页/跳页时调用）。门一放宽，之前被挡住的近页自然就排上了。 */
  setMaxDistance(maxDistance: number): void {
    if (Number.isNaN(maxDistance) || maxDistance < 0) {
      throw new Error(`预取深度必须是非负数，收到 ${String(maxDistance)}`);
    }
    this.maxDistance = maxDistance;
    this.sortQueue();
    this.schedulePump();
  }

  private dispatchable(task: ScheduledTask): boolean {
    return task.distance <= this.maxDistance;
  }

  /**
   * 跳页重排（Step 10）。
   *
   * 语义（每一条都对着一个具体的老毛病）：
   * - **只动队列，绝不碰缓存。** 本文件零依赖、连缓存的类型都不认识 ——
   *   "跳页把已落盘缓存也清了"是 v1 的老毛病（不变量 I7），在这里**结构上不可能发生**。
   *   被撤下的任务只是离开队列，它们的译图仍躺在落盘缓存里，翻回去照样命中。
   * - **保留仍在窗口内的**：距离/优先级按**新**当前页重算（跳 20→80 后，81 变成 P1）。
   * - **在飞任务不自己 abort**：Step 8 定的边界是"不执行、不 abort"，所以这里只**报告**
   *   `inFlightNowStale`，由持有派发权的一方去取消（它才知道怎么取消）。
   *   调度器擅自 abort 会和执行层形成第二套取消路径 —— 那正是要避免的。
   *
   * `plan` 由调用方按新页算好传进来 ——
   * 因为"页键 ↔ 页距"的映射是站点相关的，调度器不认。
   */
  retarget(plan: readonly SchedulerTask[]): RetargetOutcome {
    const wanted = new Map<string, ScheduledTask>();
    for (const task of plan) {
      wanted.set(task.pageKey, { ...task, priority: priorityForDistance(task.distance) });
    }

    const dropped: ScheduledTask[] = [];
    const retained: ScheduledTask[] = [];
    for (const task of this.queue) {
      const updated = wanted.get(task.pageKey);
      if (updated) {
        retained.push(updated); // 距离按新当前页重算
        wanted.delete(task.pageKey);
      } else {
        dropped.push(task);
      }
    }
    const added = [...wanted.values()];
    const wantedKeys = new Set(plan.map((task) => task.pageKey));
    const inFlightNowStale = this.running !== null && !wantedKeys.has(this.running.pageKey);

    this.queue = [...retained, ...added];
    for (const task of added) this.enqueueOrder.set(task.pageKey, this.sequence++);
    for (const task of dropped) this.enqueueOrder.delete(task.pageKey);
    this.sortQueue();
    this.schedulePump();

    return { added, dropped, retained, inFlightNowStale };
  }

  /**
   * 入队。**同一 `pageKey` 只保留一条**：
   * 同一页重复入队（翻回来、窗口平移）不该排成两条挨着跑 —— 那样会白跑一次重活。
   * 重复入队时保留**更高**的优先级（离当前页更近的那次），否则"翻回来"会被旧的远距离压住。
   */
  enqueue(task: SchedulerTask): void {
    const priority = priorityForDistance(task.distance);
    const existingIndex = this.queue.findIndex((item) => item.pageKey === task.pageKey);
    if (existingIndex >= 0) {
      const existing = this.queue[existingIndex];
      if (this.rank(priority) < this.rank(existing.priority)) {
        this.queue.splice(existingIndex, 1, { ...task, priority });
        this.sortQueue();
      }
      return;
    }
    if (this.running?.pageKey === task.pageKey) return;

    this.queue.push({ ...task, priority });
    this.enqueueOrder.set(task.pageKey, this.sequence++);
    this.sortQueue();
    this.schedulePump();
  }

  /** 队列清空（不碰任何缓存 —— "跳页不得清除已落盘缓存"见 Step 10）。 */
  clearQueue(): void {
    this.queue = [];
    this.enqueueOrder.clear();
  }

  /** 等队列跑干（单测与自检用）。 */
  async drain(): Promise<void> {
    // 反复等：等待期间可能又有新任务入队（例如派发回调自己又 enqueue 了一页）。
    for (;;) {
      this.schedulePump();
      const current = this.pumpPromise;
      if (current === null) return;
      await current;
      // ⚠️ 跑干的判据是"没有**可派发**的任务了"，**不是**"队列为空" ——
      // 被窗口挡住的任务会一直留在队列里（这是正常状态），
      // 用"队列为空"判会永远等不到，直接死循环。
      if (this.running === null && !this.queue.some((task) => this.dispatchable(task))) return;
    }
  }

  private rank(priority: PagePriority): number {
    return priorityOrder.indexOf(priority);
  }

  /** 被窗口挡住的**永远排在最后**；然后是优先级；同优先级按入队先后（FIFO）。 */
  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const byGate = Number(this.dispatchable(b)) - Number(this.dispatchable(a));
      if (byGate !== 0) return byGate;
      const byPriority = this.rank(a.priority) - this.rank(b.priority);
      if (byPriority !== 0) return byPriority;
      return (this.enqueueOrder.get(a.pageKey) ?? 0) - (this.enqueueOrder.get(b.pageKey) ?? 0);
    });
  }

  /**
   * 排一次派发循环。**刻意推到微任务之后才起跑**：
   * 页面观察者通常是「当前页 + N+1…N+4」**同一批同步入队**，
   * 如果 enqueue 里立刻派发，第一件（往往是最先被发现的**最远**那页）会在其余任务入队之前
   * 就开跑 —— 优先级排序等于失效。推迟一个微任务，整批就先全部入队、排好序，再按序派发。
   */
  private schedulePump(): void {
    if (this.pumpPromise !== null) return;
    this.pumpPromise = Promise.resolve()
      .then(() => this.pump())
      .finally(() => {
        this.pumpPromise = null;
      });
  }

  /**
   * 派发循环。**并发恒 1**：`running` 非空就不再取队；派发完成后才取下一件。
   * **门只挡派发、不丢队列**：够不着的任务留在队列里等窗口平移到它（那时大概率已命中缓存）。
   * 派发抛错不阻断队列 —— 一页失败不该把后面的页一起饿死。
   */
  private async pump(): Promise<void> {
    for (;;) {
      const index = this.queue.findIndex((task) => this.dispatchable(task));
      if (index < 0) return;
      const [next] = this.queue.splice(index, 1);
      if (!next) return;
      this.enqueueOrder.delete(next.pageKey);
      this.running = next;
      try {
        await this.dispatch(next);
      } catch {
        // 派发失败只影响这一件；调度器不据此 abort 任何东西（不是它的职责）。
      } finally {
        this.running = null;
      }
    }
  }
}

