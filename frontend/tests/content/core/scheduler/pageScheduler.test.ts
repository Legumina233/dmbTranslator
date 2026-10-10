import { describe, expect, it } from 'vitest';
import {
  PageScheduler,
  priorityForDistance,
  type ScheduledTask,
} from '../../../../apps/extension/src/content/core/scheduler/pageScheduler';

/** 制造一点真实异步，好让"并发恒 1"能被观测到（同步派发看不出交叠）。 */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('priorityForDistance', () => {
  it('P0–P3 映射与 NAMING §5 一致', () => {
    expect(priorityForDistance(0)).toBe('P0');
    expect(priorityForDistance(1)).toBe('P1');
    expect(priorityForDistance(2)).toBe('P2');
    expect(priorityForDistance(3)).toBe('P3');
    expect(priorityForDistance(99)).toBe('P3');
  });

  it('非法页距当场抛错，不静默归到 P3', () => {
    expect(() => priorityForDistance(-1)).toThrow(/非负整数/);
    expect(() => priorityForDistance(1.5)).toThrow(/非负整数/);
  });
});

describe('PageScheduler · 排序', () => {
  it('按优先级出队：P0 先于 P1 先于 P3（即使 P3 先入队）', async () => {
    const seen: string[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task.pageKey); });
    scheduler.enqueue({ pageKey: 'far', distance: 3 });
    scheduler.enqueue({ pageKey: 'next', distance: 1 });
    scheduler.enqueue({ pageKey: 'current', distance: 0 });
    await scheduler.drain();
    expect(seen).toEqual(['current', 'next', 'far']);
  });

  it('同优先级按入队先后（FIFO），顺序可预测', async () => {
    const seen: string[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task.pageKey); });
    scheduler.enqueue({ pageKey: 'n1', distance: 1 });
    scheduler.enqueue({ pageKey: 'n2', distance: 1 });
    scheduler.enqueue({ pageKey: 'n3', distance: 1 });
    await scheduler.drain();
    expect(seen).toEqual(['n1', 'n2', 'n3']);
  });

  it('同一页重复入队只保留一条，且取更高的优先级', async () => {
    const seen: string[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task.pageKey); });
    scheduler.enqueue({ pageKey: 'p', distance: 3 });
    scheduler.enqueue({ pageKey: 'p', distance: 0 }); // 翻回来了
    await scheduler.drain();
    expect(seen).toEqual(['p']);
    expect(scheduler.queued).toHaveLength(0);
  });

  it('在飞的那一页再次入队不会排成第二条', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const scheduler = new PageScheduler(async (task) => {
      seen.push(task.pageKey);
      await new Promise<void>((resolve) => { release = resolve; });
    });
    scheduler.enqueue({ pageKey: 'p', distance: 0 });
    await tick();
    expect(scheduler.active).toBe(1);
    scheduler.enqueue({ pageKey: 'p', distance: 0 });
    release?.();
    await scheduler.drain();
    expect(seen).toEqual(['p']);
  });
});

describe('PageScheduler · 并发恒 1（Step 8 的自动验与停止条件）', () => {
  it('派发 5 件，并发峰值恒为 1', async () => {
    let concurrent = 0;
    let peak = 0;
    const scheduler = new PageScheduler(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await tick();
      concurrent -= 1;
    });
    for (let i = 0; i < 5; i += 1) scheduler.enqueue({ pageKey: `p${i}`, distance: i });
    await scheduler.drain();
    expect(peak).toBe(1);
  });

  it('派发期间 active 恒为 0 或 1，从不为 2', async () => {
    const samples: number[] = [];
    const scheduler = new PageScheduler(async () => {
      samples.push(scheduler.active);
      await tick();
      samples.push(scheduler.active);
    });
    scheduler.enqueue({ pageKey: 'a', distance: 0 });
    scheduler.enqueue({ pageKey: 'b', distance: 1 });
    await scheduler.drain();
    expect(samples.every((value) => value === 0 || value === 1)).toBe(true);
    expect(scheduler.active).toBe(0);
  });

  it('派发抛错不饿死后面的页（一页失败不该连坐）', async () => {
    const seen: string[] = [];
    const scheduler = new PageScheduler((task) => {
      seen.push(task.pageKey);
      if (task.pageKey === 'bad') throw new Error('炸了');
    });
    scheduler.enqueue({ pageKey: 'bad', distance: 0 });
    scheduler.enqueue({ pageKey: 'good', distance: 1 });
    await scheduler.drain();
    expect(seen).toEqual(['bad', 'good']);
  });
});

describe('PageScheduler · 职责边界', () => {
  it('只排序和派发：不碰缓存，clearQueue 不产生任何副作用', async () => {
    const seen: ScheduledTask[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task); });
    scheduler.enqueue({ pageKey: 'a', distance: 3 });
    scheduler.enqueue({ pageKey: 'b', distance: 3 });
    // 队列里两件都还没派发时清空 → 一件都不该跑
    const queuedBefore = scheduler.queued.length;
    expect(queuedBefore).toBeGreaterThan(0);
    scheduler.clearQueue();
    await scheduler.drain();
    expect(seen).toEqual([]);
    expect(scheduler.active).toBe(0);
  });

  it('派发出去的 task 带优先级，便于执行层记录', async () => {
    const seen: ScheduledTask[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task); });
    scheduler.enqueue({ pageKey: 'a', distance: 2 });
    await scheduler.drain();
    expect(seen[0]).toEqual({ pageKey: 'a', distance: 2, priority: 'P2' });
  });
});
