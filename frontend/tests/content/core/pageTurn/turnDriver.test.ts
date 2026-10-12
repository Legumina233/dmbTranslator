// @vitest-environment jsdom
/**
 * **内容脚本接线的集成测试**（项目第一条）—— 用 jsdom 假造一个阅读页，把
 * "采集器判方向（适配器）+ 驱动器 + 账本"三者串起来跑。
 *
 * 为什么要这一条：这两天修的所有 bug（同一次移动被扣两次 → 第 3 下凭空消失；
 * 认不出按钮 → 整下丢弃；往回翻又自己往前跳）**全都出在接线层**，而在此之前
 * 接线层零覆盖、只能靠真机踩。这里把每条都钉死。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTurnDriver } from '../../../../apps/extension/src/content/core/pageTurn/turnDriver';
import { findControlForDirection, turnDirectionOf } from '../../../../apps/extension/src/content/adapters/ehentaiPageControls';

/** 假造站点导航条：`#prev` / `#next` / 图片容器 `#i3` 里的链接（点图 = 往前）。 */
function buildFakePage(): void {
  document.body.innerHTML = `
    <div id="sn">
      <a id="prev"></a>
      <a id="next"></a>
    </div>
    <div id="i3"><a id="imgLink"></a></div>
    <div id="background"></div>
  `;
}

/** 假造"站点"：忙的时候忽略点击（真机的陈旧窗口），空闲时才翻页。 */
function buildFakeSite(startPage: number): {
  page: () => number;
  setBusy: (busy: boolean) => void;
  clicks: () => number;
} {
  let page = startPage;
  let busy = true;
  let clicks = 0;
  const prev = document.getElementById('prev') as HTMLElement;
  const next = document.getElementById('next') as HTMLElement;
  const imgLink = document.getElementById('imgLink') as HTMLElement;
  const advance = (delta: number): void => {
    clicks += 1;
    if (busy) return; // ← 站点忙：忽略这一下（页码不动）
    page += delta;
  };
  next.onclick = () => advance(1);
  imgLink.onclick = () => advance(1);
  prev.onclick = () => advance(-1);
  return {
    page: () => page,
    setBusy: (value: boolean) => { busy = value; },
    clicks: () => clicks,
  };
}

function makeDriver(site: { page: () => number }): ReturnType<typeof createTurnDriver> {
  return createTurnDriver({
    readPage: () => site.page(),
    findControl: (direction) => findControlForDirection(direction),
    clickControl: (control) => (control as HTMLElement).click(),
  });
}

describe('内容脚本接线 · 翻页驱动器（jsdom 集成）', () => {
  beforeEach(() => {
    buildFakePage();
  });

  it('① 连按 3 下、站点一开始全部忽略 → 账不丢；站点一空闲就连补 3 格（真机那个 bug）', () => {
    const site = buildFakeSite(25);
    const driver = makeDriver(site);

    expect(driver.press(1, 'keyboard')).toBe(1);
    expect(driver.press(1, 'keyboard')).toBe(2);
    expect(driver.press(1, 'keyboard')).toBe(3);

    // 站点忙：点了也不动 → 欠账**原样保留**（旧实现在这里把账扣没了）
    expect(driver.tick()).toBe(3);
    expect(driver.tick()).toBe(3);
    expect(site.page()).toBe(25);

    site.setBusy(false); // 站点空闲了
    expect(driver.tick()).toBe(2);
    expect(site.page()).toBe(26);
    expect(driver.tick()).toBe(1);
    expect(driver.tick()).toBe(0);
    expect(site.page()).toBe(28);

    // 欠账清零后驱动不再动手（不多翻）
    expect(driver.tick()).toBe(0);
    expect(site.page()).toBe(28);
  });

  it('② 上限 3：连按 5 下最多交付 3 格', () => {
    const site = buildFakeSite(30);
    const driver = makeDriver(site);
    for (let i = 0; i < 5; i += 1) driver.press(1, 'keyboard');
    expect(driver.ledger.owed(1, 30)).toBe(3);

    site.setBusy(false);
    driver.tick();
    driver.tick();
    driver.tick();
    expect(site.page()).toBe(33);
    driver.tick();
    expect(site.page()).toBe(33); // 第 4 格不存在
  });

  it('③ 往回翻同样成立（方向反转会丢弃旧方向，不会"往回又自己往前"）', () => {
    const site = buildFakeSite(40);
    const driver = makeDriver(site);
    driver.press(1, 'keyboard');
    driver.press(1, 'keyboard');
    expect(driver.ledger.owed(1, 40)).toBe(2);

    driver.press(-1, 'keyboard'); // 用户改主意
    expect(driver.ledger.owed(1, 40)).toBe(0);

    site.setBusy(false);
    driver.tick();
    expect(site.page()).toBe(39);
    expect(driver.tick()).toBe(0);
    expect(site.page()).toBe(39);
  });

  it('④ 我们自己替点的那一下会被标记出来（否则会被算成用户的按下，账越滚越多）', () => {
    const site = buildFakeSite(50);
    const seen: boolean[] = [];
    const driver = createTurnDriver({
      readPage: () => site.page(),
      findControl: (direction) => findControlForDirection(direction),
      clickControl: (control) => {
        seen.push(driver.consumeOwnClick()); // 点击事件同步期间问一句
        (control as HTMLElement).click();
      },
    });
    site.setBusy(false);
    driver.press(1, 'keyboard');
    driver.tick();

    expect(seen).toEqual([true]); // 替点被标记
    expect(driver.consumeOwnClick()).toBe(false); // 事件之外不再是"自己点的"
  });

  it('⑤ 方向按**操作**判定：`#next`/图片链接 = 往前、`#prev` = 往后、点背景 = 认不出（什么也不做）', () => {
    // `#next` 与 `#prev` 的 id 就是角色的稳定判据（站点会改写它们的号码，但 id 不变）
    expect(turnDirectionOf(document.getElementById('next'))).toBe(1);
    expect(turnDirectionOf(document.getElementById('prev'))).toBe(-1);
    // 图片容器里的链接 = 往前（站点不支持点图后退）
    expect(turnDirectionOf(document.getElementById('imgLink'))).toBe(1);
    // 点背景/别处 → 认不出 → null（什么都不做，也绝不清空欠账）
    expect(turnDirectionOf(document.getElementById('background'))).toBeNull();
    expect(turnDirectionOf(document.body)).toBeNull();
    expect(turnDirectionOf(null)).toBeNull();
  });

  it('⑥ 非阅读页（读不到页码）→ 清空欠账、绝不动手', () => {
    const site = buildFakeSite(60);
    const driver = makeDriver(site);
    driver.press(1, 'keyboard');
    expect(driver.ledger.owed(1, 60)).toBe(1);

    const gallery = createTurnDriver({
      readPage: () => null, // 画廊页
      findControl: (direction) => findControlForDirection(direction),
      clickControl: (control) => (control as HTMLElement).click(),
    });
    expect(gallery.tick()).toBe(0);
    expect(gallery.consumeOwnClick()).toBe(false);
  });
});
