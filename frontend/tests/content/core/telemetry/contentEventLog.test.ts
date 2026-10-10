import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeMessage = vi.fn(async (_message: unknown) => ({
  ok: true as const,
  type: 'mt:event-log' as const,
  accepted: 1,
}));
vi.mock('../../../../apps/extension/src/shared/messages', () => ({
  sendRuntimeMessage: (message: unknown) => sendRuntimeMessage(message),
}));

type PushedMessage = { type: string; events: Array<Record<string, unknown>> };

/** 取最近一次交给 background 的消息（`sendRuntimeMessage` 的唯一调用）。 */
function lastPushedMessage(): PushedMessage {
  const call = sendRuntimeMessage.mock.calls.at(-1);
  if (!call) throw new Error('expected sendRuntimeMessage to have been called');
  return call[0] as unknown as PushedMessage;
}

const {
  emitContentFailure,
  flushContentEventLog,
} = await import('../../../../apps/extension/src/content/core/telemetry/contentEventLog');

beforeEach(() => {
  sendRuntimeMessage.mockClear();
});

/**
 * M2b · 内容侧失败必须能出得去。
 *
 * 内容脚本发不出 HTTP（页面 CSP 拦 `connect-src`），所以它的 sink 是
 * `sendRuntimeMessage({type:'mt:event-log'})` —— 这条断言守的就是这条唯一通道。
 */
describe('content event log', () => {
  it('sends a failure event to background', () => {
    emitContentFailure({
      message: '设置无效：未选择模型',
      stage: 'prepare',
      module: 'content/core/translation/imageTranslationExecution',
      fn: 'prepareExecution',
      pageKey: '1234567-94',
      code: 'IMAGE_TRANSLATION_SETTINGS_INVALID',
      retryable: false,
    });
    flushContentEventLog();

    expect(sendRuntimeMessage).toHaveBeenCalledTimes(1);
    const message = lastPushedMessage();
    expect(message.type).toBe('mt:event-log');
    expect(message.events).toHaveLength(1);
    expect(message.events[0]).toMatchObject({
      kind: 'failure',
      level: 'error',
      pageKey: '1234567-94',
      where: {
        repo: 'extension',
        module: 'content/core/translation/imageTranslationExecution',
        fn: 'prepareExecution',
      },
      what: { stage: 'prepare', retryable: false },
      err: {
        code: 'IMAGE_TRANSLATION_SETTINGS_INVALID',
        message: '设置无效：未选择模型',
      },
    });
  });

  /**
   * 本地编号（v/ts/seq/sessionId）必须在交给 background 之前剥掉 ——
   * 否则两边各打一套编号，事件流里会出现两个 sessionId 打架。
   */
  it('strips local sequencing fields before handing off', () => {
    emitContentFailure({ message: 'boom', stage: 'prepare', module: 'm' });
    flushContentEventLog();

    const message = lastPushedMessage();
    const event = message.events[0];
    expect(event).not.toHaveProperty('v');
    expect(event).not.toHaveProperty('ts');
    expect(event).not.toHaveProperty('seq');
    expect(event).not.toHaveProperty('sessionId');
  });

  /** 内容脚本可能已失效（页面卸载 / 扩展更新）：旁路失败不许把主流程带崩。 */
  it('swallows transport failures', async () => {
    sendRuntimeMessage.mockRejectedValueOnce(new Error('extension context invalidated'));

    expect(() => {
      emitContentFailure({ message: 'boom', stage: 'prepare', module: 'm' });
      flushContentEventLog();
    }).not.toThrow();
    await Promise.resolve();
  });
});
