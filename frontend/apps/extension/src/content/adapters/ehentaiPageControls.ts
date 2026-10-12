/**
 * e-hentai 阅读页"翻页控件"的 DOM 适配 —— **站点知识集中在这一处**。
 *
 * ## 为什么单独成模块
 * 三条输入路径（方向键 / 网页翻页键 / 直接点图片）其实只对应**两类机制**：
 *   · 键盘 = 只有"方向"；
 *   · 点翻页键或点图片 = **带声明目标的控件**（图片只是被包在同样的控件里）。
 * 控件的"声明目标"有两种写法（实测）：
 *   · `onclick="load_image(158, 'key')"` ← **首选**（站点权威声明；href 往往只是 `#`）；
 *   · href 指向 `…/4246067-158`（完整网址或相对路径）。
 * 把"怎么读、怎么找、怎么点"收在这一个文件里，上层的队列与泵就**不需要知道站点长什么样**。
 */

/**
 * 只读 `onclick` 里的 `load_image(N)`（站点**权威声明**）；没有则 `null`。
 *
 * 与 `readDeclaredTarget` 分开暴露，是因为上层要用它判断一件关键的事：
 * **翻页后约 0~1 秒内，点"下一页"时站点仍声明着"当前页"**（陈旧窗口）——
 * 那种情况应当解读成"想往后翻一页"，而纯 href 形态没有这个语义。
 */
export function readLoadImageTarget(element: Element | null): number | null {
  const control = element?.closest?.('a, area');
  if (!control) return null;
  const onclick = control.getAttribute('onclick') ?? '';
  const matched = /load_image\(\s*(\d+)/.exec(onclick);
  return matched ? Number(matched[1]) : null;
}

/**
 * 读出元素（或其祖先控件）**声明的目标页码**；读不出返回 `null`。
 *
 * `baseHref` 只为测试方便（默认取当前地址，用来解析相对 href）。
 */
export function readDeclaredTarget(element: Element | null, baseHref?: string): number | null {
  const control = element?.closest?.('a, area');
  if (!control) return null;
  // ① 首选：站点自己在 onclick 里声明的页码。
  const byOnclick = readLoadImageTarget(element);
  if (byOnclick !== null) return byOnclick;
  // ② 退路：href 里的 `…-页码`。
  //    ★ 必须排除 `#`、`javascript:` 之类 —— 它们 `new URL(...)` 后会**解析成当前页**，
  //    于是"点了没声明的控件"会被误判成"声明当前页" → 上层会把队列清空（真机踩过）。
  const href = control.getAttribute('href');
  if (!href || !href.includes('/s/')) return null;
  try {
    const base = baseHref ?? location.href;
    const matched = /^\/s\/[0-9a-f]+\/(\d+)-(\d+)(?:[?#/]|$)/i.exec(new URL(href, base).pathname);
    return matched ? Number(matched[2]) : null;
  } catch {
    return null;
  }
}

/**
 * 按**操作**判定翻页方向 —— 只看"点的是哪个控件"，**不看它此刻声明的页码**。
 *
 * 真机实测（2026-10-11）：站点给这些控件**稳定的 id**：
 *   · `#prev` → 往后一页；· `#next` → 往前一页；
 *   · 图片上那个链接（在 `#i3` 内）→ 往前一页（点图片只能往前，用户实测）。
 * 而陈旧窗口里它们的**声明数字是乱的**（往前翻后 `#prev` 会声明 current-2；往回翻后 `#next` 会声明 current+1），
 * 所以**绝不能拿数字算方向** —— 那正是"翻回去又翻回来"的成因。
 */
export function turnDirectionOf(element: Element | null): 1 | -1 | null {
  const control = element?.closest?.('a, area') ?? null;
  if (!control) return null;
  const id = (control.id || '').toLowerCase();
  if (id === 'prev') return -1;
  if (id === 'next') return 1;
  // 点图片：站点只支持往前（`#i3` 里那个链接就是"下一页"）。
  if (control.closest?.('#i3, #img') ?? null) return 1;
  if (element?.closest?.('#i3, #img') ?? null) return 1;
  return null;
}

/** 找"某个方向"的控件（**按角色**，不看声明的页码）。用于"替用户点一下"。 */
export function findControlForDirection(direction: 1 | -1): Element | null {
  const wantedId = direction === 1 ? 'next' : 'prev';
  const byId = document.getElementById(wantedId);
  if (byId) return byId;
  let found: Element | null = null;
  document.querySelectorAll('a, area').forEach((node) => {
    if (found) return;
    if ((node.id || '').toLowerCase() === wantedId) found = node;
  });
  return found;
}

/** 找"声明目标 = 指定页"的那个控件；没有则 `null`（= 站点现在受理不了那一页）。 */
export function findControlForPage(page: number): Element | null {
  let found: Element | null = null;
  // 不要求有 href：站点的翻页控件常常只有 onclick。
  document.querySelectorAll('a, area, [onclick]').forEach((node) => {
    if (found) return;
    if (readDeclaredTarget(node) === page) found = node;
  });
  return found;
}

/** 替用户点一下那个控件（走站点自己的 onclick，不碰它的内部函数）。 */
export function clickControl(element: Element): void {
  (element as HTMLElement).click();
}
