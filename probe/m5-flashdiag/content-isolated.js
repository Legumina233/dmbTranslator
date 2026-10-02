// dmb M5 翻页闪屏诊断 —— 隔离世界桥 + popup 消息接口
//
// 职责单一：① 收主世界（content-main.js）的事件流并缓存；② 记录本页加载序号（区分整页重载/软导航）
// 与生产扩展的遥测属性（data-m5-chain / data-m3-prefetch）；③ 应答 popup 的快照/取证请求。
// 只观测，不拦截。
(function () {
  'use strict';

  var LOAD_SEQ_KEY = 'm5flash-load-seq';
  var loadSeq = 0;
  try {
    loadSeq = Number(sessionStorage.getItem(LOAD_SEQ_KEY) || '0') + 1;
    sessionStorage.setItem(LOAD_SEQ_KEY, String(loadSeq));
  } catch (e) {
    loadSeq = -1; // sessionStorage 不可用 → 如实标注
  }

  var snapshot = {
    events: [],
    dumps: null,
    capturedAt: null
  };

  // 主世界事件流进桥
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__m5flashData !== true) return;
    snapshot.events = d.events || [];
    snapshot.dumps = d.dumps || null;
    snapshot.capturedAt = Date.now();
  });

  // 向主世界要一次「当前快照 + 取证 dump」；主世界异步回帖，用 pending 回调接住
  var pendingDump = null;
  function requestMainWorldSnapshot() {
    return new Promise(function (resolve) {
      pendingDump = resolve;
      window.postMessage({ __m5flashReq: true }, '*');
      // 兜底：主世界 1.5s 没回也放行（如实标注）
      window.setTimeout(function () {
        if (pendingDump) { pendingDump = null; resolve(null); }
      }, 1500);
    });
  }
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__m5flashData !== true || !pendingDump) return;
    var cb = pendingDump;
    pendingDump = null;
    cb({ events: d.events || [], dumps: d.dumps || null });
  });

  function productionTelemetry() {
    var out = {};
    try {
      var root = document.documentElement;
      if (root && root.dataset) {
        if (root.dataset.m5Chain) out.m5Chain = root.dataset.m5Chain;
        if (root.dataset.m5Restore) out.m5Restore = root.dataset.m5Restore;
        if (root.dataset.m3Prefetch) out.m3Prefetch = root.dataset.m3Prefetch;
      }
    } catch (e) { out.error = String(e); }
    return out;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'm5flash-snapshot') {
      // 同步部分先回；取证 dump 由 popup 用第二条消息拉（保持通道简单）
      sendResponse({
        ok: true,
        loadSeq: loadSeq,
        href: String(location.href || ''),
        capturedAt: snapshot.capturedAt,
        eventCount: snapshot.events.length,
        events: snapshot.events,
        production: productionTelemetry()
      });
      return false;
    }
    if (msg.type === 'm5flash-dump') {
      requestMainWorldSnapshot().then(function (res) {
        sendResponse(res ? { ok: true, dumps: res.dumps, events: res.events } : { ok: false, error: '主世界 1.5s 未响应（可能不在 e-hentai 页或未刷新）' });
      });
      return true; // 异步应答
    }
    return false;
  });
})();
