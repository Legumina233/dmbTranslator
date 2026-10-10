import { describe, expect, it } from 'vitest';
import {
  isImageVaultClientMessage,
  isImageVaultHostMessage,
  isImageVaultTerminalMessage,
  type ImageVaultHostMessage,
} from '../../apps/extension/src/shared/imageVaultProtocol';

describe('image vault protocol validators', () => {
  it('accepts every client message shape', () => {
    expect(isImageVaultClientMessage({ type: 'vault-list', requestId: 'r1' })).toBe(true);
    expect(isImageVaultClientMessage({ type: 'vault-get', requestId: 'r1', key: 'k' })).toBe(true);
    expect(isImageVaultClientMessage({
      type: 'vault-put',
      requestId: 'r1',
      key: 'k',
      contentType: 'image/png',
      meta: { chunkCount: 1, totalChars: 4 },
    })).toBe(true);
    expect(isImageVaultClientMessage({
      type: 'vault-put-chunk',
      requestId: 'r1',
      index: 0,
      data: 'AQ==',
    })).toBe(true);
    expect(isImageVaultClientMessage({ type: 'vault-put-complete', requestId: 'r1' })).toBe(true);
    expect(isImageVaultClientMessage({ type: 'vault-set-limit', requestId: 'r1', limit: 7 })).toBe(true);
    expect(isImageVaultClientMessage({ type: 'vault-clear', requestId: 'r1' })).toBe(true);
  });

  it('rejects client messages without a requestId or with a bad payload', () => {
    expect(isImageVaultClientMessage({ type: 'vault-list' })).toBe(false);
    expect(isImageVaultClientMessage({ type: 'vault-list', requestId: '' })).toBe(false);
    // key 必须是**非空**字符串：空 key 会让"取一张图"变成"取整个库"的语义空洞。
    expect(isImageVaultClientMessage({ type: 'vault-get', requestId: 'r1', key: '' })).toBe(false);
    // 分块元数据必须自洽（totalChars ≤ chunkCount × 单块上限且零值成对出现）。
    expect(isImageVaultClientMessage({
      type: 'vault-put',
      requestId: 'r1',
      key: 'k',
      contentType: 'image/png',
      meta: { chunkCount: 0, totalChars: 4 },
    })).toBe(false);
    expect(isImageVaultClientMessage({
      type: 'vault-put-chunk',
      requestId: 'r1',
      index: -1,
      data: 'AQ==',
    })).toBe(false);
    // 上限必须是 ≥1 的整数：0 / 负数 / 小数都是"清空缓存"或"语义不明"，不该被接受。
    expect(isImageVaultClientMessage({ type: 'vault-set-limit', requestId: 'r1', limit: 0 })).toBe(false);
    expect(isImageVaultClientMessage({ type: 'vault-set-limit', requestId: 'r1', limit: -5 })).toBe(false);
    expect(isImageVaultClientMessage({ type: 'vault-set-limit', requestId: 'r1', limit: 1.5 })).toBe(false);
    expect(isImageVaultClientMessage({ type: 'vault-set-limit', requestId: 'r1' })).toBe(false);
    expect(isImageVaultClientMessage({ type: 'vault-nope', requestId: 'r1' })).toBe(false);
  });

  it('accepts every host message shape', () => {
    expect(isImageVaultHostMessage({ type: 'vault-keys', requestId: 'r1', keys: ['a', 'b'] })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-image', requestId: 'r1', found: false })).toBe(true);
    expect(isImageVaultHostMessage({
      type: 'vault-image',
      requestId: 'r1',
      found: true,
      contentType: 'image/png',
      meta: { chunkCount: 1, totalChars: 4 },
    })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-image-chunk', requestId: 'r1', index: 0, data: 'AQ==' })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-image-complete', requestId: 'r1' })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-stored', requestId: 'r1' })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-limit-set', requestId: 'r1' })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-cleared', requestId: 'r1' })).toBe(true);
    expect(isImageVaultHostMessage({ type: 'vault-failed', requestId: 'r1', message: '坏' })).toBe(true);
  });

  it('rejects malformed host messages', () => {
    expect(isImageVaultHostMessage({ type: 'vault-keys', requestId: 'r1', keys: [1] })).toBe(false);
    expect(isImageVaultHostMessage({ type: 'vault-image', requestId: 'r1', found: 'yes' })).toBe(false);
    expect(isImageVaultHostMessage({ type: 'vault-image', requestId: 'r1', found: true })).toBe(false);
    expect(isImageVaultHostMessage({ type: 'vault-stored' })).toBe(false);
  });

  it('treats exactly the documented messages as terminal', () => {
    // 终态集合是"中间层什么时候可以回收来源映射"的唯一依据，漏一个就会漏一条 pending。
    const terminal: ImageVaultHostMessage[] = [
      { type: 'vault-keys', requestId: 'r1', keys: [] },
      { type: 'vault-image', requestId: 'r1', found: false },
      { type: 'vault-image-complete', requestId: 'r1' },
      { type: 'vault-stored', requestId: 'r1' },
      { type: 'vault-limit-set', requestId: 'r1' },
      { type: 'vault-cleared', requestId: 'r1' },
      { type: 'vault-failed', requestId: 'r1', message: 'x' },
    ];
    for (const message of terminal) {
      expect(isImageVaultTerminalMessage(message)).toBe(true);
    }
    expect(isImageVaultTerminalMessage({
      type: 'vault-image',
      requestId: 'r1',
      found: true,
      contentType: 'image/png',
      meta: { chunkCount: 1, totalChars: 4 },
    })).toBe(false);
    expect(isImageVaultTerminalMessage({ type: 'vault-image-chunk', requestId: 'r1', index: 0, data: 'AQ==' })).toBe(false);
  });
});
