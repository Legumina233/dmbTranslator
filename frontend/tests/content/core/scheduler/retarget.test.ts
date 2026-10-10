import { describe, expect, it } from 'vitest';
import {
  PageScheduler,
  priorityForDistance,
  type ScheduledTask,
} from '../../../../apps/extension/src/content/core/scheduler/pageScheduler';

const GID = 4218710;
const keyOf = (page: number): string => `${GID}-${page}`;
const resolvePageKey = (index: number): string | null =>
  index >= 1 && index <= 120 ? keyOf(index) : null;

/**
 * 测试内最小 plan 构造：当前页（距离 0）+ 往后 depth 页。
 * （生产侧原先那个规划函数无调用方、已删；这里只为本用例造输入。）
 */
function planFrom(currentIndex: number, depth = 4): ScheduledTask[] {
  // priority 由距离推导（与生产侧同一函数，不自己编一个值）
  const tasks: ScheduledTask[] = [
    { pageKey: keyOf(currentIndex), distance: 0, priority: priorityForDistance(0) },
  ];
  for (let distance = 1; distance <= depth; distance += 1) {
    const key = resolvePageKey(currentIndex + distance);
    if (key !== null) tasks.push({ pageKey: key, distance, priority: priorityForDistance(distance) });
  }
  return tasks;
}

/** 跳页：从 from 跳到 to，按新窗口重排。 */
function jumpTo(
  scheduler: PageScheduler,
  to: number,
  depth = 4,
): ReturnType<PageScheduler['retarget']> {
  return scheduler.retarget(planFrom(to, depth));
}

describe('Step 10 · 跳页重排', () => {
  it('★ 跳 20 → 80 之后，撤下的页（21/22/23）确实离开队列', () => {
    const scheduler = new PageScheduler(() => undefined, { maxDistance: 4 });
    for (const task of planFrom(20)) {
      scheduler.enqueue(task);
    }

    const outcome = jumpTo(scheduler, 80);

    // 队列层面：21/22/23 确实被撤下了（它们离新当前页很远）
    expect(outcome.dropped.map((task) => task.pageKey)).toEqual(
      expect.arrayContaining([keyOf(21), keyOf(22), keyOf(23)]),
    );
  });

  it('新窗口按新当前页排：跳 20→80 后入队 80…84', () => {
    const scheduler = new PageScheduler(() => undefined, { maxDistance: 4 });
    for (const task of planFrom(20)) {
      scheduler.enqueue(task);
    }
    jumpTo(scheduler, 80);
    expect(scheduler.queued.map((task) => task.pageKey)).toEqual([
      keyOf(80), keyOf(81), keyOf(82), keyOf(83), keyOf(84),
    ]);
  });

  it('窗口重叠时保留旧任务并按新页距重算优先级（不重复入队）', () => {
    const scheduler = new PageScheduler(() => undefined, { maxDistance: 4 });
    for (const task of planFrom(20)) {
      scheduler.enqueue(task); // 20,21,22,23,24
    }
    // 只往前挪 2 页：22/23/24 仍在新窗口内
    const outcome = jumpTo(scheduler, 22);

    expect(outcome.dropped.map((task) => task.pageKey)).toEqual([keyOf(20), keyOf(21)]);
    expect(outcome.added.map((task) => task.pageKey)).toEqual([keyOf(25), keyOf(26)]);
    // 每个 key 只出现一次
    const keys = scheduler.queued.map((task) => task.pageKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([keyOf(22), keyOf(23), keyOf(24), keyOf(25), keyOf(26)]);
  });

  it('在飞任务不属于新窗口时**只报告**、不自己 abort（取消是派发方的职责）', async () => {
    // 只让**第一件**卡住（模拟"在飞"）；后续任务立刻返回，
    // 否则 release 之后新入队的任务会一起卡死，drain 永远等不到。
    let release!: () => void;
    let firstDispatch = true;
    const scheduler = new PageScheduler(async () => {
      if (!firstDispatch) return;
      firstDispatch = false;
      await new Promise<void>((resolve) => { release = resolve; });
    }, { maxDistance: 4 });
    scheduler.enqueue({ pageKey: keyOf(20), distance: 0 });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(scheduler.active).toBe(1);

    const staleOutcome = jumpTo(scheduler, 80);
    expect(staleOutcome.inFlightNowStale).toBe(true);
    // 调度器没有能力也没有资格取消它 —— 在飞的仍是第 20 页
    expect(scheduler.active).toBe(1);

    release?.();
    await scheduler.drain();
    expect(scheduler.active).toBe(0);
  });

  it('在飞任务仍在新窗口内时不报 stale（别误伤）', async () => {
    let release!: () => void;
    let firstDispatch = true;
    const scheduler = new PageScheduler(async () => {
      if (!firstDispatch) return;
      firstDispatch = false;
      await new Promise<void>((resolve) => { release = resolve; });
    }, { maxDistance: 4 });
    scheduler.enqueue({ pageKey: keyOf(22), distance: 2 });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const outcome = jumpTo(scheduler, 22); // 22 就是新当前页，仍在窗口内
    expect(outcome.inFlightNowStale).toBe(false);
    release?.();
    await scheduler.drain();
  });

  it('重排后并发仍恒 1，且被撤下的任务不会再跑', async () => {
    const ran: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const scheduler = new PageScheduler(async (task) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      ran.push(task.pageKey);
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      concurrent -= 1;
    }, { maxDistance: 4 });

    for (const task of planFrom(20)) {
      scheduler.enqueue(task);
    }
    scheduler.retarget(planFrom(80));
    await scheduler.drain();

    expect(peak).toBe(1);
    // 新窗口里的都跑了
    for (const page of [80, 81, 82, 83, 84]) expect(ran).toContain(keyOf(page));
  });

  it('重排不产生任何"清缓存"副作用（调度器连缓存类型都不认识）', () => {
    const seen: ScheduledTask[] = [];
    const scheduler = new PageScheduler((task) => { seen.push(task); }, { maxDistance: 4 });
    scheduler.enqueue({ pageKey: keyOf(30), distance: 3 });
    const outcome = jumpTo(scheduler, 90);
    // 结果里只有队列的三个视角，没有任何与缓存有关的字段
    expect(Object.keys(outcome).sort()).toEqual(
      ['added', 'dropped', 'inFlightNowStale', 'retained'],
    );
  });
});
