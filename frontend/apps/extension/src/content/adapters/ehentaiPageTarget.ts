import { ehentaiPageKey, parseEhentaiPageIdentity } from './ehentai';

/**
 * 毛病 A 的判据（纯函数，便于测试）：**该不该贴这一页的译图**。
 *
 * ## 规则只有一条
 * **只贴站点已经翻到的那一页** —— 也就是网址里的页码必须和"要贴的页身份"完全一致。
 *
 * ## 为什么需要它（真机 2026-10-11）
 * 以前这里是"意图即换图"：按键/点击的**瞬间**就按 ±1 预测下一页并贴图。但 e-hentai 一次只受理
 * 一格（快速连点第二下被忽略，日志 `accepted=False`），于是屏幕上先出现"站点没去的那一页"的译图；
 * 等站点原图加载完（+1.1~2.4s），同步逻辑又按**真实页**贴回 → 用户看到的"跳回上一页"。
 *
 * ## 返回
 * - `number`：可以贴这一页（站点确实在这一页）。
 * - `null`：**不贴**。三种情形：不是阅读页 / 页身份与网址不符（= 预测页）/ 网址畸形。
 *
 * 注意"网址变了、页码没变"（站点有时会重写 URL 的另一段）：那种情况本函数照常返回当前页码
 * —— 因为它贴的**还是当前页**，不是"新的一页"，属正确行为。
 */
export function resolveSiteTranslationPage(input: {
  /** 当前网址（`location.pathname`）。 */
  pathname: string;
  /** 准备贴的那一页的页身份（`${gid}-${page}`）。 */
  pageKey: string;
}): number | null {
  const identity = parseEhentaiPageIdentity(input.pathname);
  if (!identity) return null; // 非阅读页（画廊页等）：不介入
  if (ehentaiPageKey(identity) !== input.pageKey) return null; // 站点没在这一页 → 不贴（预测页拦在这）
  return identity.page;
}
