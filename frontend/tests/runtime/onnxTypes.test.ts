import { describe, expect, it } from 'vitest';
import { isContextLostError, isDeadSessionError, isDeadSessionRuntimeError } from '../../packages/model-runtime/src/runtime/onnxTypes';

describe('isContextLostError', () => {
  it('匹配 WebGPU / WebNN 的上下文丢失', () => {
    expect(isContextLostError('The context is lost')).toBe(true);
    expect(isContextLostError('MLGraphBuilder InvalidStateError')).toBe(true);
    expect(isContextLostError('A valid external Instance reference no longer exists.')).toBe(false);
  });
});

describe('isDeadSessionError', () => {
  it('把 ORT WebGPU 的外部实例失效判成会话已废', () => {
    // 真机实测的报错原文：device/context 掉线后 session.run() 抛的就是这句
    expect(isDeadSessionError('A valid external Instance reference no longer exists.')).toBe(true);
  });

  it('覆盖 device lost 与 context lost', () => {
    expect(isDeadSessionError('Device is lost')).toBe(true);
    expect(isDeadSessionError('device lost')).toBe(true);
    expect(isDeadSessionError('The context is lost')).toBe(true);
  });

  it('不把输入数据类错误误判成会话已废', () => {
    // 误判会导致每次都重建会话，白扔一次模型加载
    expect(isDeadSessionError('Invalid tensor dims')).toBe(false);
    expect(isDeadSessionError('Session 创建超时')).toBe(false);
    expect(isDeadSessionError('')).toBe(false);
  });
});

describe('isDeadSessionRuntimeError', () => {
  it('接受 Error 对象与字符串', () => {
    expect(isDeadSessionRuntimeError(new Error('A valid external Instance reference no longer exists.'))).toBe(true);
    expect(isDeadSessionRuntimeError('Invalid tensor dims')).toBe(false);
  });
});
