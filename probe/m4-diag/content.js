// dmb M4 预取探针 · content script（独立扩展，2026-10-03）
//
// 职责单一：读正式扩展挂在 documentElement 上的 `data-m5-chain` 遥测（JSON 字符串，
// DOM 属性是跨扩展 content script 的共同可见区），维护「最新快照 + 变化时间线」，
// 供本扩展的 popup 查询。**只读 DOM，不发请求、不改页面、不与正式扩展通信。**
//
// 口径（沿用正式扩展侧约定）：
// - 没读过遥测（found=false）= 正式扩展的预取块没在这页跑（非阅读页 / 扩展未装/未更新）
//   —— **不许把「没采到」伪装成「全 0」**。
// - 历史是「快照差异序列」：遥测每次重写都记一行（内容没变的跳过），
//   看数字爬升轨迹（requested/received/submitted/active）就能判断链路动没动。
(function () {
  'use strict';

  var HISTORY_LIMIT = 50;

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
      history: state.history
    });
    return true;
  });
})();
