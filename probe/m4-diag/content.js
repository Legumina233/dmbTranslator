// dmb M4 预取探针 · content script（独立扩展，2026-10-03）
//
// 职责单一：读正式扩展挂在 documentElement 上的 `data-m5-chain` 遥测（JSON 字符串，
// DOM 属性是跨扩展 content script 的共同可见区），维护「最新快照 + 变化时间线」，
// 供本扩展的 popup 查询。**只读 DOM，不发请求、不改页面、不与正式扩展通信。**
//
// v0.2.0 新增「层叠体检」：用户报告"画框贴译图后翻译按钮被盖住"。画框 z-index
// 2147483000、按钮锚点 z-index 2147483001（数值上按钮应赢），两者能否直接比较取决于
// **各自祖先链上有谁创建了层叠上下文**（transform/opacity/filter/isolation/z-index+定位…）。
// 体检把两侧的上下文链、坐标矩形、存在性全部量出来，一次看清"被谁盖/还是没挂"。
(function () {
  'use strict';

  var HISTORY_LIMIT = 50;
  var OVERLAY_SELECTOR = 'img[data-mt-translated-overlay]';
  var ANCHOR_SELECTOR = '[data-mt-ehentai-anchor]';

  var state = {
    found: false,        // 本文档生命周期内是否读到过遥测
    latest: null,        // 最新一次解析出的遥测对象
    updatedAt: null,     // 最新快照的本地时间戳（ms）
    history: []          // [{t, requested, received, knownCount, ok, fail, submitted, active, showkeyFound}]
  };

  function readTelemetry() {
    var raw = null;
    try {
      raw = document.documentElement.getAttribute('data-m5-chain');
    } catch (e) {
      return; // DOM 不可达（理论不该发生）：维持现状
    }
    if (typeof raw !== 'string' || raw.length === 0) return;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return; // 半截写入：等下一次属性变化
    }
    if (!parsed || typeof parsed !== 'object') return;
    state.found = true;
    state.latest = parsed;
    state.updatedAt = Date.now();
    recordHistory(parsed);
  }

  function recordHistory(snapshot) {
    var dispatch = snapshot.dispatch || {};
    var executor = snapshot.executor || {};
    var chain = snapshot.chain || {};
    var row = {
      t: Date.now(),
      requested: num(chain.requested),
      received: num(chain.received),
      knownCount: num(chain.knownCount),
      ok: num(dispatch.ok),
      fail: num(dispatch.fail),
      submitted: num(executor.submitted),
      active: num(executor.active),
      showkeyFound: snapshot.showkeyFound === true
    };
    var prev = state.history[state.history.length - 1];
    if (prev && sameRow(prev, row)) return; // 内容没变：不记
    state.history.push(row);
    if (state.history.length > HISTORY_LIMIT) {
      state.history.splice(0, state.history.length - HISTORY_LIMIT);
    }
  }

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }

  function sameRow(a, b) {
    return a.requested === b.requested && a.received === b.received &&
      a.knownCount === b.knownCount && a.ok === b.ok && a.fail === b.fail &&
      a.submitted === b.submitted && a.active === b.active &&
      a.showkeyFound === b.showkeyFound;
  }

  // ── 层叠体检 ─────────────────────────────────────────────────────────
  // 元素向上爬到 body，收集所有"自己就创建了层叠上下文"的祖先（含自身）。
  // 两个元素的 z-index 只有在**共同层叠上下文**里才能直接比较：任何一侧被
  // 中途的上下文困住，它的高 z-index 就只在那口"锅"里有效。
  function contextChain(el) {
    var chain = [];
    var cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
      var cs = window.getComputedStyle(cur);
      var creates =
        (cs.position !== 'static' && cs.zIndex !== 'auto') ||
        parseFloat(cs.opacity) < 1 ||
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        cs.backdropFilter !== 'none' ||
        cs.perspective !== 'none' ||
        cs.isolation === 'isolate' ||
        (cs.mixBlendMode && cs.mixBlendMode !== 'normal') ||
        (cs.willChange && cs.willChange !== 'auto' && cs.willChange !== '') ||
        (cs.contain && (cs.contain.indexOf('paint') !== -1 || cs.contain.indexOf('strict') !== -1 || cs.contain.indexOf('content') !== -1));
      if (creates) {
        chain.push({
          tag: cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : ''),
          position: cs.position,
          zIndex: cs.zIndex,
          opacity: cs.opacity,
          transform: cs.transform === 'none' ? undefined : cs.transform,
          filter: cs.filter === 'none' ? undefined : cs.filter,
          isolation: cs.isolation === 'isolate' ? 'isolate' : undefined
        });
      }
      cur = cur.parentElement;
    }
    return chain;
  }

  function describeEl(el) {
    if (!el) return { exists: false };
    var cs = window.getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    var childCount = el.childNodes.length;
    return {
      exists: true,
      connected: el.isConnected,
      display: cs.display,
      visibility: cs.visibility,
      zIndex: cs.zIndex,
      position: cs.position,
      rect: {
        x: Math.round(rect.left), y: Math.round(rect.top),
        w: Math.round(rect.width), h: Math.round(rect.height)
      },
      childCount: childCount,
      contextChain: contextChain(el)
    };
  }

  function stackingAudit() {
    var overlay = document.querySelector(OVERLAY_SELECTOR);
    var anchor = document.querySelector(ANCHOR_SELECTOR);
    // 按钮内容在 anchor > ui.host 里；anchor childCount===0 说明只剩空壳（UI 被卸了）
    var audit = {
      overlay: describeEl(overlay),
      anchor: describeEl(anchor),
      anchorEmpty: Boolean(anchor) && anchor.childNodes.length === 0,
      pageKey: lastPageKey()
    };
    // 裁决：两侧都存在且都直达根上下文 → 数值大者赢；一侧被困 → 被困侧输；
    // 任何一侧不存在 → 谈不上"盖"，是挂载问题。
    if (!audit.overlay.exists || !audit.anchor.exists) {
      audit.verdict = !audit.overlay.exists
        ? '画框不存在（本页译图未贴或未到）'
        : '按钮锚点不存在（UI 未挂载）——不是"被盖"，是"没挂"';
    } else if (audit.overlay.contextChain.length === 0 && audit.anchor.contextChain.length === 0) {
      audit.verdict = '两者同处根层叠上下文：按钮 2147483001 > 画框 2147483000，按钮应可见。若仍不可见，看按钮 rect 与 display。';
    } else if (audit.anchor.contextChain.length > 0) {
      audit.verdict = '按钮祖先链存在层叠上下文创建者（见按钮 contextChain）→ 按钮被"困"在其祖先的锅里，高 z-index 只在锅里有效，画框（直达根上下文）压过整锅 → 这就是被盖的机理。';
    } else {
      audit.verdict = '画框被祖先困住而按钮直达根上下文（与报告相反）——把两侧 chain 截图给排查。';
    }
    return audit;
  }

  function lastPageKey() {
    var m = /^\/s\/[0-9a-f]+\/(\d+-\d+)/.exec(location.pathname);
    return m ? m[1] : null;
  }

  // 遥测是「事件驱动重写」的（页到达 / 收到 JSON / 熔断），属性变化 = 有新快照。
  // 用 attributeFilter 精准监听，observer 自身开销可忽略；探针测完即卸载。
  try {
    new MutationObserver(readTelemetry).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-m5-chain']
    });
  } catch (e) { /* 监听失败不致命：popup 拉取时还会现读一次 */ }

  readTelemetry(); // 注入时正式扩展可能已写过遥测（内容脚本晚于它启动）

  chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
    if (!message || message.type !== 'm4diag-get') return false;
    readTelemetry(); // 现读一次，保证拿到的是此刻最新值
    sendResponse({
      ok: true,
      type: 'm4diag-get',
      href: location.href,
      found: state.found,
      latest: state.latest,
      updatedAt: state.updatedAt,
      history: state.history,
      stacking: stackingAudit()
    });
    return true;
  });
})();
