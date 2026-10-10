import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canEnterStage,
  isTerminalStage,
  PagePipelineContext,
  PIPELINE_STAGE_ORDER,
  PipelineContextError,
  type PipelineStage,
  type PipelineStageOutcome,
} from '../../../../apps/extension/src/content/core/state/pipelineContext';

/** 按给定顺序把每站走完（enter + leave），默认全 READY。 */
function walk(
  stages: readonly PipelineStage[],
  outcome: PipelineStageOutcome = 'READY',
): PagePipelineContext {
  const ctx = new PagePipelineContext();
  for (const stage of stages) {
    ctx.enter(stage);
    ctx.leave(outcome);
  }
  return ctx;
}

describe('PagePipelineContext 合法迁移', () => {
  it('五态按真实管线顺序走完并全部 READY', () => {
    const ctx = walk(PIPELINE_STAGE_ORDER);

    const { history } = ctx.snapshot();
    expect(history.map((entry) => entry.stage)).toEqual([...PIPELINE_STAGE_ORDER]);
    expect(history.map((entry) => entry.outcome)).toEqual([
      'READY',
      'READY',
      'READY',
      'READY',
      'READY',
    ]);
  });

  it('leave 之后立刻 enter 后继阶段是允许的', () => {
    const ctx = walk(['image']);
    expect(ctx.stage).toBeNull();
    expect(() => ctx.enter('ocr')).not.toThrow();
  });

  it('终态可以是 FAILED 或 CANCELLED，stage 仍正确记录', () => {
    const ctx = walk(['image', 'ocr'], 'CANCELLED');

    expect(ctx.snapshot().history.map((e) => [e.stage, e.outcome])).toEqual([
      ['image', 'CANCELLED'],
      ['ocr', 'CANCELLED'],
    ]);
  });

  it('单站写 CANCELLED 不污染后续阶段', () => {
    const ctx = new PagePipelineContext();
    ctx.enter('image');
    ctx.leave('CANCELLED');
    ctx.enter('ocr');
    ctx.leave();
    expect(ctx.snapshot().history.map((e) => [e.stage, e.outcome])).toEqual([
      ['image', 'CANCELLED'],
      ['ocr', 'READY'],
    ]);
  });

  it('reset 之后可以重新开一条管线', () => {
    const ctx = walk(['image', 'ocr']);
    expect(ctx.snapshot().history).toHaveLength(2);

    ctx.reset();
    expect(ctx.snapshot()).toEqual({ stage: null, history: [] });
    expect(() => {
      ctx.enter('image');
      ctx.leave();
      ctx.enter('ocr');
      ctx.leave();
    }).not.toThrow();
    expect(ctx.snapshot().history).toHaveLength(2);
    expect(ctx.snapshot().history[1].seq).toBe(2);
  });

  it('快照是副本，外部改不动内部历史', () => {
    const ctx = walk(['image']);
    const snapshot = ctx.snapshot();
    (snapshot.history as unknown as { length: number }).length = 0;
    expect(ctx.snapshot().history).toHaveLength(1);
    expect(ctx.record).toHaveLength(1);
  });

  it('progress 记录推进位置，与是否正在跑无关', () => {
    const ctx = walk(['image']);
    expect(ctx.progress).toBe('image');
    expect(ctx.stage).toBeNull();
  });
});

describe('PagePipelineContext 非法迁移必须被拒', () => {
  const expectReject = (code: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(PipelineContextError);
      expect((error as PipelineContextError).code).toBe(code);
      return;
    }
    throw new Error('非法迁移竟然被放行了');
  };

  it('还没开始就写终态 → stage-not-entered', () => {
    const ctx = new PagePipelineContext();
    expectReject('stage-not-entered', () => ctx.leave());
  });

  it('还没开始就跳到非首个阶段 → stage-out-of-order', () => {
    const ctx = new PagePipelineContext();
    expectReject('stage-out-of-order', () => ctx.enter('ocr'));
  });

  it('跳级进入（image 直接到 translation）→ stage-out-of-order', () => {
    const ctx = new PagePipelineContext();
    expectReject('stage-out-of-order', () => ctx.enter('translation'));
  });

  it('重进当前正在进行的阶段 → stage-out-of-order', () => {
    const ctx = walk(['image']);
    expectReject('stage-out-of-order', () => ctx.enter('image'));
  });

  it('回退到已离开的上一阶段 → stage-out-of-order', () => {
    const ctx = walk(['image', 'ocr']);
    expectReject('stage-out-of-order', () => ctx.enter('image'));
  });

  it('同一阶段写两次终态 → stage-already-left', () => {
    const ctx = walk(['image']);
    expectReject('stage-already-left', () => ctx.leave('READY'));
  });
});

describe('canEnterStage / isTerminalStage', () => {
  it('只允许顺序 +1，且起点必须是首个阶段', () => {
    expect(canEnterStage(null, 'image')).toBe(true);
    expect(canEnterStage(null, 'ocr')).toBe(false);
    expect(canEnterStage('image', 'ocr')).toBe(true);
    expect(canEnterStage('image', 'translation')).toBe(false);
    expect(canEnterStage('image', 'image')).toBe(false);
    expect(canEnterStage('ocr', 'image')).toBe(false);
  });

  it('只有 render 是终局阶段', () => {
    expect(PIPELINE_STAGE_ORDER.filter(isTerminalStage)).toEqual(['render']);
  });
});

describe('架构边界：状态机不反向写 UI 投影', () => {
  it('pipelineContext.ts 不得反向引用 UI 投影层', () => {
    const file = resolve(
      __dirname,
      '../../../../apps/extension/src/content/core/state/pipelineContext.ts',
    );
    const source = readFileSync(file, 'utf8');
    // 只验 import 语句本身：文件头注释里提到那两个模块名不算越界，
    // 真越界一定是一条真的 import。
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ].map((match) => match[1]);
    expect(specifiers).toEqual([]);
  });
});
