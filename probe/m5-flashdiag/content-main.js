// dmb M5 翻页闪屏诊断 —— 主世界采集（world: MAIN, document_start）
//
// 只观测，不拦截。所有包装都是**赋值透传**（站点全局是函数声明 = writable:true，
// 赋值合法；defineProperty 重定义已被真机证伪，这里绝不用）——记录后原样调用原函数。
// 采集五路证据：
//   A. 站点翻页函数的每次调用（load_image / apply_json_state / api_call / update_window_extents /
//      window.scrollTo）—— apply_json_state 的实参类型（对象/字符串）同时定案 v2/v3 根因；
//   B. img#img 的 src 变化序列（MutationObserver）；
//   C. layout-shift / longtask（闪屏的量化证据）；
//   D. 用户动作（keydown/click，供分段）；
//   E. F12 取证（load_image 等源码、i1/img DOM 形态）——按需拉取，一键落盘时自动带上。
// 全部事件经 postMessage 交给隔离世界桥（content-isolated.js），popup 汇聚落盘。
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  var MAX = 1500;
  var events = [];
  var visitId = Math.random().toString(36).slice(2);

  function push(kind, data) {
    events.push(Object.assign({ kind: kind, ts: Date.now() }, data || {}));
    if (events.length > MAX) events.shift();
  }

  function shortStack() {
    try {
      var lines = String(new Error().stack || '').split('\n');
      return lines.slice(2, 6).map(function (l) { return l.trim().slice(0, 160); }).join(' | ');
    } catch (e) { return ''; }
  }

  // ── A. 赋值透传包装（晚挂：站点全局在 window load 才存在 —— M0 实测）──
  function summarizeArgs(args) {
    try {
      return Array.prototype.map.call(args, function (a) {
        if (a === null) return 'null';
        var t = typeof a;
        if (t === 'string') {
          if (a.length > 120) return 'string(' + a.length + '):' + a.slice(0, 120);
          return 'string:' + a;
        }
        if (t === 'object') {
          var page = (typeof a.p === 'number') ? a.p : null;
          return 'object' + (page !== null ? ('{p:' + page + ',x:' + String(a.x) + '}') : '{}');
        }
        return t + ':' + String(a).slice(0, 60);
      });
    } catch (e) { return ['<summarize-failed>']; }
  }

  function wrapOnce(name, recordArgs) {
    var current = window[name];
    if (typeof current !== 'function') return false;
    // 已是我们的包装（挂了标记）就不重复包
    if (current.__m5flashWrapped) return true;
    var native = current;
    var wrapped = function () {
      push('fn-call', { fn: name, args: recordArgs ? summarizeArgs(arguments) : undefined, stack: shortStack() });
      return native.apply(this, arguments);
    };
    wrapped.__m5flashWrapped = true;
    wrapped.__m5flashNative = native; // 取证 dump 要的是包装前的真身源码
    try { native.__m5flashWrapped = true; } catch (e) { /* 只读也不影响 */ }
    window[name] = wrapped; // 赋值包装：函数声明全局 writable:true，合法（sorz 同款原理）
    return true;
  }

  var WRAP_TARGETS = ['load_image', 'apply_json_state', 'api_call', 'update_window_extents'];
  function tryWrapAll() {
    for (var i = 0; i < WRAP_TARGETS.length; i++) wrapOnce(WRAP_TARGETS[i], true);
    wrapOnce('scrollTo', false);
  }
  tryWrapAll(); // document_start 时多半还不存在 —— load 后与轮询兜底再试
  window.addEventListener('load', tryWrapAll);
  var pollCount = 0;
  var pollTimer = window.setInterval(function () {
    tryWrapAll();
    if (++pollCount >= 150) window.clearInterval(pollTimer); // 15s 兜底，超时如实放弃（只是少记调用）
  }, 100);

  // ── B. img#img src 变化 ──
  function currentImgInfo() {
    var img = document.getElementById('img');
    return { src: img ? String(img.currentSrc || img.src || '') : '', present: !!img };
  }
  var lastImgSrc = '';
  var mo = new MutationObserver(function (mutations) {
    // 生产扩展的还原耗时遥测（data-m5-restore）—— 每次更新记一条（还原慢段定位的关键证据）
    mutations.forEach(function (m) {
      if (m.type === 'attributes' && m.attributeName === 'data-m5-restore') {
        push('restore-timing', { raw: document.documentElement.dataset.m5Restore || '' });
      }
    });
    var info = currentImgInfo();
    if (info.src && info.src !== lastImgSrc) {
      push('img-src', { from: lastImgSrc.slice(0, 140), to: info.src.slice(0, 140) });
      lastImgSrc = info.src;
    }
  });
  function startMo() {
    if (document.documentElement) {
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-m5-restore', 'data-m5-chain']
      });
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        mo.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-m5-restore', 'data-m5-chain']
        });
      }, { once: true });
    }
  }
  startMo();

  // ── C. layout-shift / longtask（闪屏量化）──
  try {
    var po = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (en) {
        if (en.entryType === 'layout-shift') {
          var sources = [];
          try {
            (en.sources || []).forEach(function (s) {
              var node = s.node;
              sources.push(node ? ((node.id ? '#' + node.id : '') || node.nodeName || '?') : '?');
            });
          } catch (e) { /* sources 不可用就不记 */ }
          push('layout-shift', { value: Number(en.value.toFixed(4)), hadRecentInput: !!en.hadRecentInput, sources: sources.slice(0, 4) });
        } else if (en.entryType === 'longtask') {
          push('longtask', { ms: Math.round(en.duration) });
        }
      });
    });
    po.observe({ entryTypes: ['layout-shift', 'longtask'] });
  } catch (e) {
    push('probe-note', { note: 'PerformanceObserver 不可用：' + String(e) });
  }

  // ── D. 用户动作（分段用）──
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      push('user-key', { key: ev.key });
    }
  }, true);
  window.addEventListener('click', function (ev) {
    var t = ev.target;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '?';
    if (tag === 'img' || tag === 'a') push('user-click', { target: tag, x: Math.round(ev.clientX || 0) });
  }, true);

  // ── E. F12 取证（拉取式：popup 一键落盘时自动执行）──
  function nativeSrc(name) {
    try {
      var f = window[name];
      if (typeof f !== 'function') return '<' + typeof f + '>';
      if (f.__m5flashNative && typeof f.__m5flashNative.toString === 'function') f = f.__m5flashNative;
      return f.toString();
    } catch (e) { return '<err:' + String(e) + '>'; }
  }

  function collectDumps() {
    var i1 = document.getElementById('i1');
    var img = document.getElementById('img');
    var dumps = { visitId: visitId };
    dumps.load_image = nativeSrc('load_image');
    dumps.apply_json_state = nativeSrc('apply_json_state');
    dumps.update_window_extents = nativeSrc('update_window_extents');
    dumps.api_call = nativeSrc('api_call');
    try { dumps.i1OuterHTML = i1 ? i1.outerHTML.slice(0, 400) : '<no #i1>'; } catch (e) { dumps.i1OuterHTML = '<err>'; }
    try { dumps.imgParentTag = img && img.parentElement ? img.parentElement.tagName : '<no img/parent>'; } catch (e) { dumps.imgParentTag = '<err>'; }
    try { dumps.imgSrcNow = img ? String(img.currentSrc || img.src || '') : ''; } catch (e) { dumps.imgSrcNow = ''; }
    try { dumps.globals = ['load_image', 'apply_json_state', 'api_call', 'gid', 'showkey', 'update_window_extents'].map(function (n) { return n + '=' + typeof window[n]; }).join(', '); } catch (e) { dumps.globals = '<err>'; }
    return dumps;
  }

  // ── 与隔离世界桥的通信 ──
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__m5flashReq !== true) return;
    try {
      window.postMessage({
        __m5flashData: true,
        visitId: visitId,
        events: events.slice(),
        dumps: collectDumps()
      }, '*');
    } catch (e) { /* 上报失败只能放弃 */ }
  });
  push('probe-ready', { visitId: visitId });
})();
