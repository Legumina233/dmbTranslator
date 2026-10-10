import { describe, expect, it } from 'vitest';
import { createEventLog, createRequestId, type DmbEvent } from '../../apps/extension/src/shared/eventLog';

/** 收集出口 + 可控时钟 + 可控定时器，全部注入，零真实异步。 */
function harness(options: Partial<Parameters<typeof createEventLog>[0]> = {}) {
  const batches: DmbEvent[][] = [];
  const timers: Array<() => void> = [];
  let clock = 1_700_000_000_000;
  const log = createEventLog({
    sessionId: 's-test',
    capacity: 8,
    batchSize: 4,
    flushIntervalMs: 500,
    now: () => clock,
    schedule: (fn) => { timers.push(fn); },
    sink: (events) => { batches.push([...events]); },
    ...options,
  });
  return { log, batches, fire: () => { const t = timers.shift(); if (t) t(); }, timers };
}

function input(kind: string, level: DmbEvent['level'] = 'info') {
  return { level, kind, what: { a: 1 } };
}

describe('统一事件流 eventLog（M0）', () => {
  it('补 schema 字段：v=2 / seq 递增 / sessionId / ts 为 ISO', () => {
    const { log } = harness();
    log.emit(input('page.completed'));
    log.emit(input('failure'));
    const snap = log.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0].v).toBe(2);
    expect(snap[0].sessionId).toBe('s-test');
    expect(snap[0].seq).toBe(1);
    expect(snap[1].seq).toBe(2);
    expect(snap[0].ts).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('emit 是同步 O(1)：不发网络、不做序列化（ts 只在导出时才转 ISO）', () => {
    const { log, batches } = harness({ batchSize: 100 });
    log.emit(input('page.completed'));
    // 没到批量阈值也没到定时器 → 出口一次都没被调用
    expect(batches).toHaveLength(0);
    // 但事件已经在缓冲里，且此时仍未被序列化（snapshot 才转）
    expect(log.stats().pending).toBe(1);
    expect(log.snapshot()[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('满 batchSize 立刻冲一批；剩余继续排队等定时器', () => {
    const { log, batches, fire } = harness({ batchSize: 4, capacity: 32 });
    for (let i = 0; i < 5; i += 1) log.emit(input(`k${i}`));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(4);
    expect(log.stats().pending).toBe(1);
    fire();
    expect(batches[1]).toHaveLength(1);
  });

  it('定时器路径：只发一批就够时不再多排（避免空转）', () => {
    const { log, batches, fire, timers } = harness({ batchSize: 4, capacity: 32 });
    log.emit(input('a'));
    expect(timers).toHaveLength(1);
    fire();
    expect(batches[0]).toHaveLength(1);
    // 缓冲已空 → 不再 arm 下一个定时器
    expect(timers).toHaveLength(0);
  });

  it('缓冲满：丢最旧的并计 dropped（丢事件可以，卡住翻译不行）', () => {
    const { log } = harness({ capacity: 3, batchSize: 100 });
    for (let i = 0; i < 5; i += 1) log.emit(input(`k${i}`));
    const stats = log.stats();
    expect(stats.pending).toBe(3);
    expect(stats.dropped).toBe(2);
    expect(stats.emitted).toBe(5);
    // 留下的是最近的 3 条
    expect(log.snapshot().map((e) => e.kind)).toEqual(['k2', 'k3', 'k4']);
  });

  it('关闭时整套 no-op：emit 不计数、不排定时器', () => {
    const { log, batches, timers } = harness({ enabled: false });
    log.emit(input('page.completed'));
    log.flush();
    expect(log.stats()).toMatchObject({ emitted: 0, pending: 0, flushed: 0 });
    expect(batches).toHaveLength(0);
    expect(timers).toHaveLength(0);
  });

  it('L1 门控：verbose 关闭时 debug 级事件不进缓冲', () => {
    const { log } = harness({ verbose: false });
    log.emit(input('log.verbose', 'debug'));
    expect(log.stats().emitted).toBe(0);
    log.setVerbose(true);
    log.emit(input('log.verbose', 'debug'));
    expect(log.stats().emitted).toBe(1);
  });

  it('出口抛错不影响主流程（日志是旁路）', () => {
    const log = createEventLog({
      sessionId: 's', batchSize: 1,
      sink: () => { throw new Error('网络炸了'); },
    });
    expect(() => { log.emit(input('x')); log.flush(); }).not.toThrow();
    expect(log.stats().flushed).toBe(1);
  });

  it('requestId 形如 q-<base36 时间>-<随机>', () => {
    const id = createRequestId();
    expect(id).toMatch(/^q-[0-9a-z]+-[0-9a-z]+$/);
    expect(createRequestId()).not.toBe(createRequestId());
  });
});
