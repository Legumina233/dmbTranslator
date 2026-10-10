import {
  isValidChunkMeta,
  type LocalPipelineChunkMeta,
} from '@dmb/image-pipeline/protocol';

/**
 * 译图**内存**缓存的跨进程协议：content ↔ background ↔ offscreen。
 *
 * ## 为什么要有它
 * 内容脚本的内存活不过一次文档销毁：e-hentai 阅读页翻页 / 站点自身整页重载都会走
 * `pagehide(persisted=false)` → `TranslatorCore.stop()` → 内存译图清零。把译图放进
 * **offscreen 文档**（扩展源、不随页面导航生灭）后，翻回已译页仍是瞬时命中。
 *
 * ## 为什么不落盘
 * 用户口径（2026-10-10）：译图只在内存里，刷新不丢靠的是"换一个能跨文档活着的内存"，
 * 不是"写到磁盘"。所以这里是纯内存 Map，扩展重载 / 浏览器会话结束天然清空。
 *
 * ## 为什么是分块协议
 * 扩展 Port 走 JSON 序列化，Blob 过不去，只能 base64。一张译图 base64 后可达数 MB，
 * 与本地流水线回传译图同量级，所以沿用同一套分块口径（`splitBase64Chunks` /
 * `Base64ChunkAssembler`，单块 4 MiB 字符）。
 */

export const IMAGE_VAULT_CLIENT_PORT = 'mt:image-vault-client';
export const IMAGE_VAULT_HOST_PORT = 'mt:image-vault-host';

/** 译图分块元数据 —— 与本地流水线的 chunk meta 同一形状（复用同一套校验）。 */
export type ImageVaultChunkMeta = LocalPipelineChunkMeta;

/**
 * 内容脚本 → 译图缓存宿主（经 background 转发）。
 *
 * 一次请求由 `requestId` 贯穿：`vault-put` 后跟 N 个 `vault-put-chunk` 与一个
 * `vault-put-complete`；其余四条（`vault-list` / `vault-get` / `vault-set-limit` /
 * `vault-clear`）都是单发单收。宿主按 `requestId` 回执。
 */
export type ImageVaultClientMessage =
  | { type: 'vault-list'; requestId: string }
  | { type: 'vault-get'; requestId: string; key: string }
  | {
      type: 'vault-put';
      requestId: string;
      key: string;
      contentType: string;
      meta: ImageVaultChunkMeta;
    }
  | { type: 'vault-put-chunk'; requestId: string; index: number; data: string }
  | { type: 'vault-put-complete'; requestId: string }
  | { type: 'vault-set-limit'; requestId: string; limit: number }
  | { type: 'vault-clear'; requestId: string };

/**
 * 译图缓存宿主 → 内容脚本。
 *
 * 终态（收到即结束该 requestId）：`vault-keys` / `vault-image`(found=false) /
 * `vault-image-complete` / `vault-stored` / `vault-limit-set` / `vault-cleared` / `vault-failed`。
 */
export type ImageVaultHostMessage =
  | { type: 'vault-keys'; requestId: string; keys: string[] }
  | { type: 'vault-image'; requestId: string; found: false }
  | {
      type: 'vault-image';
      requestId: string;
      found: true;
      contentType: string;
      meta: ImageVaultChunkMeta;
    }
  | { type: 'vault-image-chunk'; requestId: string; index: number; data: string }
  | { type: 'vault-image-complete'; requestId: string }
  | { type: 'vault-stored'; requestId: string }
  | { type: 'vault-limit-set'; requestId: string }
  | { type: 'vault-cleared'; requestId: string }
  | { type: 'vault-failed'; requestId: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRequestId(value: Record<string, unknown>): value is Record<string, unknown> & {
  requestId: string;
} {
  return typeof value.requestId === 'string' && value.requestId.length > 0;
}

function isChunkIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isCacheLimit(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

export function isImageVaultClientMessage(
  value: unknown,
): value is ImageVaultClientMessage {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  switch (value.type) {
    case 'vault-list':
    case 'vault-put-complete':
    case 'vault-clear':
      return true;
    case 'vault-get':
      return typeof value.key === 'string' && value.key.length > 0;
    case 'vault-set-limit':
      return isCacheLimit(value.limit);
    case 'vault-put':
      return typeof value.key === 'string'
        && value.key.length > 0
        && typeof value.contentType === 'string'
        && isValidChunkMeta(value.meta);
    case 'vault-put-chunk':
      return isChunkIndex(value.index) && typeof value.data === 'string';
    default:
      return false;
  }
}

export function isImageVaultHostMessage(
  value: unknown,
): value is ImageVaultHostMessage {
  if (!isRecord(value) || !hasRequestId(value)) return false;
  switch (value.type) {
    case 'vault-image-complete':
    case 'vault-stored':
    case 'vault-limit-set':
    case 'vault-cleared':
      return true;
    case 'vault-keys':
      return Array.isArray(value.keys)
        && value.keys.every((key) => typeof key === 'string');
    case 'vault-image':
      if (value.found === false) return true;
      return value.found === true
        && typeof value.contentType === 'string'
        && isValidChunkMeta(value.meta);
    case 'vault-image-chunk':
      return isChunkIndex(value.index) && typeof value.data === 'string';
    case 'vault-failed':
      return typeof value.message === 'string';
    default:
      return false;
  }
}

/**
 * 终态消息 —— 收到它就说明这个 `requestId` 结束了，中间层可以回收来源映射。
 *
 * 放在协议里而不是中间层自己判：终态集合是这个协议的属性，
 * 散落一份到 background 只会让"新增一条终态"变成两处修改。
 */
export function isImageVaultTerminalMessage(value: ImageVaultHostMessage): boolean {
  switch (value.type) {
    case 'vault-keys':
    case 'vault-image-complete':
    case 'vault-stored':
    case 'vault-limit-set':
    case 'vault-cleared':
    case 'vault-failed':
      return true;
    case 'vault-image':
      return value.found === false;
    default:
      return false;
  }
}
