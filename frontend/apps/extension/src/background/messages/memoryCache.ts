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
 *
 * ★ 2026-10-12 真机修 bug（用户报"重载/重开浏览器后弹窗永远显示未连接"）：
 *   原来只取 `tabs.query({active:true})` 的 **`list[0]`**。弹窗发消息时 `sender.tab` 是
 *   `undefined` → 查询退化成"**所有窗口**的活动标签页"，而 Chrome **不保证** `list[0]`
 *   是弹窗所在窗口的那个 → 拿到别的窗口的标签页 → 那页没有内容脚本 → `sendMessage` 抛
 *   → 回 `reached:false`。它与页面状态无关，所以**刷新页面/重开浏览器都治不好**。
 *   现在改成：**枚举候选、逐个试，第一个答上来的就用**（页面侧一切正常时必然能命中）。
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

type TabLike = { id?: number; windowId?: number };

/**
 * 找到**候选标签页**（把"最可能是弹窗所在窗口"的排在前面）。
 *
 * ★ 为什么不返回单个 id：`tabs.query({active:true})` 会把**每个窗口**的活动标签页都列出来，
 *   而顺序是 Chrome 的实现细节。所以调用方必须**逐个试**，不能赌第一个。
 *
 * `sender.tab` 存在时（消息来自某个标签页）优先它所在窗口。
 * 找不到（没权限 / 查询抛错）→ 空数组。
 */
export async function resolveActiveTabIds(sender: ExtensionMessageSender): Promise<number[]> {
  const chromeApi = getExtensionApi();
  const tabs = chromeApi?.tabs;
  const runtime = chromeApi?.runtime;
  if (!tabs?.query) return [];

  const query = tabs.query;
  const senderWindowId = typeof sender.tab?.windowId === 'number' ? sender.tab.windowId : undefined;

  const raw = await new Promise<unknown>((resolve) => {
    try {
      query({ active: true }, (list) => {
        const lastError = runtime?.lastError;
        if (lastError?.message) {
          resolve([]);
          return;
        }
        resolve(list);
      });
    } catch {
      resolve([]);
    }
  });

  const list = (Array.isArray(raw) ? raw : []) as TabLike[];
  const sameWindow: number[] = [];
  const others: number[] = [];
  for (const tab of list) {
    if (typeof tab?.id !== 'number') continue;
    if (senderWindowId !== undefined && tab.windowId === senderWindowId) sameWindow.push(tab.id);
    else others.push(tab.id);
  }
  return [...sameWindow, ...others];
}

/** 兼容旧调用点（推送预取设置用）：候选里的第一个。 */
export async function resolveActiveTabId(sender: ExtensionMessageSender): Promise<number | undefined> {
  return (await resolveActiveTabIds(sender))[0];
}

export async function maintainMemoryCache(
  message: MemoryCacheMessage,
  sender: ExtensionMessageSender,
): Promise<MemoryCacheResult> {
  const chromeApi = getExtensionApi();
  const tabs = chromeApi?.tabs;
  if (!tabs?.query || !tabs?.sendMessage) return unreachable();

  const tabIds = await resolveActiveTabIds(sender);
  for (const tabId of tabIds) {
    try {
      const response: unknown = await tabs.sendMessage(tabId, message);
      if (!isRecord(response) || response.ok !== true || !isRecord(response.cache)) {
        continue; // 这个标签页答得不对（或没内容脚本）→ 试下一个候选
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
      // 这个标签页没有内容脚本（停在 chrome:// / 非目标站点）→ 试下一个候选
    }
  }

  // 所有候选都没答上来：如实报"没连上"，**不许**伪装成"缓存是空的"。
  return unreachable();
}
