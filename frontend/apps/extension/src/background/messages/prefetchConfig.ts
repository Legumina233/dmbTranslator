import { getExtensionApi } from '../../shared/extensionRuntime';
import type { ExtensionMessageSender } from '../../shared/extensionRuntime';
import type { PrefetchConfigMessage, PrefetchConfigSyncMessage } from '../../shared/messages';
import { normalizeLastNonZeroPrefetchDepth, normalizePrefetchDepth } from '../../shared/config';
import { getSettings, setSettings } from '../settings/settingsStore';
import { resolveActiveTabIds } from './memoryCache';

/**
 * 把弹窗的**预取设置**（预载页数 + 进入自动翻译）转发到当前标签页的内容脚本。
 *
 * 为什么必须转发（同 `mt:memory-cache`）：内容脚本拿不到 settings（settings 只在
 * 背景/弹窗侧），预取执行器的 depth / autoTranslateOnEnter 是
 * **运行在内容脚本里**的，
 * 只能靠推消息让它改。不推的话用户改完设置要等下次刷新页面才生效 —— 会被当成"改了没用"。
 *
 * 单向即可（不需要回执数据）：内容脚本没注入时静默失败，设置本身已落 storage，
 * 页面下次打开会带上；**不把"没推成功"伪装成"推成功了"**（弹窗侧不显示成功文案）。
 */
export async function pushPrefetchConfig(
  message: PrefetchConfigMessage,
  sender: ExtensionMessageSender,
): Promise<void> {
  const chromeApi = getExtensionApi();
  const tabs = chromeApi?.tabs;
  if (!tabs?.query || !tabs?.sendMessage) return;

  const tabIds = await resolveActiveTabIds(sender);
  for (const tabId of tabIds) {
    try {
      await tabs.sendMessage(tabId, message);
      return; // 推成功一次就够（推送不需要回执）
    } catch {
      // 这个标签页没有内容脚本 → 试下一个候选（2026-10-12 修：多窗口下不再赌 list[0]）
    }
  }
}

/**
 * 页面右下角预载 / 自动翻译两个开关的**读 + 写**（内容脚本 → 后台）。
 *
 * 内容脚本拿不到 settings，页面开关要改设置只能走这里：
 * ① 带字段 = 写进 settings（唯一真相源），再复用 `pushPrefetchConfig` 回推当前标签页，
 *    让**正在跑的**执行器立刻按新值干活（否则要等下次刷新）；
 * ② 无论写不写，都回当前值 —— 内容脚本靠它初始化开关状态。
 *
 * 字段都可选：只读（一个都不带）时单纯回当前值，不产生任何写。
 * ★ 2026-10-09：`prefetchEnabled` 已删除，语义并入 `prefetchDepth`（0 = 关闭预载）。
 *   这里**不**为它做兼容读取 —— 与 `normalizeSettings` 的旧键迁移不同：
 *   storage 是持久数据、跨版本存活，而消息只在同版本的 content↔background 之间走，
 *   扩展整体升级，旧内容脚本在后台更新后立刻因 context invalidated 退场。
 */
export async function syncPrefetchConfig(
  message: PrefetchConfigSyncMessage,
  sender: ExtensionMessageSender,
): Promise<{ prefetchDepth: number; autoTranslateOnEnter: boolean; lastNonZeroPrefetchDepth: number }> {
  const current = await getSettings();
  const wantsWrite = message.prefetchDepth !== undefined
    || message.autoTranslateOnEnter !== undefined
    || message.lastNonZeroPrefetchDepth !== undefined;

  if (!wantsWrite) {
    return {
      prefetchDepth: current.prefetchDepth,
      autoTranslateOnEnter: current.autoTranslateOnEnter,
      lastNonZeroPrefetchDepth: current.lastNonZeroPrefetchDepth,
    };
  }

  const nextDepth = message.prefetchDepth === undefined
    ? current.prefetchDepth
    : normalizePrefetchDepth(message.prefetchDepth);
  const nextAuto = message.autoTranslateOnEnter ?? current.autoTranslateOnEnter;
  // ★ 「预载打开时回到几」的**唯一写入点**（不变量 3）：
  //   · 消息里显式带了它（1 起）→ 用它；
  //   · 否则**只有**把深度设成**非零合法值**时才更新这层记忆；
  //   · 设成 0（= 关闭）时**不动它** —— 这正是"关掉再打开回到原来的数"成立的原因。
  //   本字段**从不参与开关判断**（开关只看 `prefetchDepth > 0`）。
  const nextLastNonZero = message.lastNonZeroPrefetchDepth !== undefined
    ? normalizeLastNonZeroPrefetchDepth(
      message.lastNonZeroPrefetchDepth,
      current.lastNonZeroPrefetchDepth,
    )
    : nextDepth > 0
      ? nextDepth
      : current.lastNonZeroPrefetchDepth;

  const saved = await setSettings({
    ...current,
    prefetchDepth: nextDepth,
    autoTranslateOnEnter: nextAuto,
    lastNonZeroPrefetchDepth: nextLastNonZero,
  });

  await pushPrefetchConfig(
    {
      type: 'mt:prefetch-config',
      prefetchDepth: saved.prefetchDepth,
      autoTranslateOnEnter: saved.autoTranslateOnEnter,
      lastNonZeroPrefetchDepth: saved.lastNonZeroPrefetchDepth,
    },
    sender,
  );

  return {
    prefetchDepth: saved.prefetchDepth,
    autoTranslateOnEnter: saved.autoTranslateOnEnter,
    lastNonZeroPrefetchDepth: saved.lastNonZeroPrefetchDepth,
  };
}