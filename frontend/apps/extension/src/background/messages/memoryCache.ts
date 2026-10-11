import { getExtensionApi } from '../../shared/extensionRuntime';
import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import type { MemoryCacheMessage, MemoryCacheResult } from '../../shared/messages';

/**
 * 把弹窗的**内存译图缓存**读写转发到当前标签页的内容脚本。
 *
 * 为什么必须转发：2026-10-03 起译图落盘关闭，译图只活在内容脚本进程里的
 * `PhotoStateStore`，后台/落盘库根本看不到它 —— 所以操作只能打到页面那一侧。
 *
 * 两条 MV3 事实（踩过）：
 * - 没有 `tabs` 权限时 `chrome.tabs.query` 照样返回 tab，但 **`tab.url` 是 `undefined`**
 *   （`tab.id` 不需要权限，需要权限的是 url）→ 这里只用 `id`，绝不拿 url 做判定。
 * - 内容脚本没注入（停在 `chrome://` 扩展页 / 不是目标站点）时 `sendMessage` 会抛，
 *   这时必须如实回 `reached:false` —— **不许回 `size:0` 把"没连上"伪装成"缓存是空的"**。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function unreachable(): MemoryCacheResult {
  return { size: 0, vaultSize: 0, limit: 0, cleared: 0, reached: false };
}

/**
 * 找到**发起消息的那个窗口里的活动标签页**（弹窗 → 它所在窗口的活动标签页）。
 *
 * 两条 MV3 事实（踩过）：
 * - `tabs.query` 的类型只认 `{active, windowId}`（没有 `currentWindow`），windowId 从 sender 取；
 * - 没有 `tabs` 权限时 `tab.url` 是 `undefined`（`id` 不需要权限、`url` 需要）→ 只用 `id`。
 *
 * 找不到（没权限 / 查询抛错）→ `undefined`。
 */
export function resolveActiveTabId(sender: ExtensionMessageSender): Promise<number | undefined> {
  const chromeApi = getExtensionApi();
  const tabs = chromeApi?.tabs;
  const runtime = chromeApi?.runtime;
  if (!tabs?.query || !tabs?.sendMessage) return Promise.resolve(undefined);

  const query = tabs.query;
  const windowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;
  return new Promise<number | undefined>((resolve) => {
    try {
      query({ active: true, ...(windowId !== undefined ? { windowId } : {}) }, (list) => {
        const lastError = runtime?.lastError;
        if (lastError?.message) {
          resolve(undefined);
          return;
        }
        const first = Array.isArray(list) ? list[0] : undefined;
        resolve(typeof first?.id === 'number' ? first.id : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export async function maintainMemoryCache(
  message: MemoryCacheMessage,
  sender: ExtensionMessageSender,
): Promise<MemoryCacheResult> {
  const chromeApi = getExtensionApi();
  const tabs = chromeApi?.tabs;
  if (!tabs?.query || !tabs?.sendMessage) return unreachable();

  const tabId = await resolveActiveTabId(sender);
  if (tabId === undefined) return unreachable();

  try {
    const response: unknown = await tabs.sendMessage(tabId, message);
    if (!isRecord(response) || response.ok !== true || !isRecord(response.cache)) {
      return unreachable();
    }
    const cache = response.cache;
    return {
      size: numberOr(cache.size, 0),
      // off-screen 那层的条数：弹窗显示"有几张"读的是它（内容脚本那层刷新即归零）。
      vaultSize: numberOr(cache.vaultSize, 0),
      limit: numberOr(cache.limit, 0),
      cleared: numberOr(cache.cleared, 0),
      reached: true,
    };
  } catch {
    // 内容脚本未注入 / 页面不匹配：如实报"没连上"
    return unreachable();
  }
}
