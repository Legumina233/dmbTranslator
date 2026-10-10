/* content.js —— 页面侧采集（只读，不改主扩展任何东西）
 *
 * 只做三件事：
 *   1) 抓页面上的「阶段文字」首次出现时刻（文本检测 / 气泡 / OCR / 翻译待执行 / 翻译中 / 翻译完成）
 *   2) 抓「译文图（blob: 的 img）」第一次出现的时刻 —— 这就是页面上肉眼看到的翻译完成
 *   3) 抓页面生命周期：freeze / resume / visibilitychange / pagehide / 是否曾被 discard
 *
 * 三者相减，就是「页面上看到的翻译耗时」。它和主扩展自己报的
 * `page.completed.stages.translate` 是同一件事的独立复现（双测量），
 * 用来交叉验证服务端自报的 llm.total_ms 对不对得上。
 *
 * 时间戳一律用 Date.now()（绝对毫秒），跨 context 可直接相减。
 */
(function () {
  'use strict';

  var KEYWORDS = [
    '加载图片', '加载检测模型', '文本检测', '气泡检测',
    'OCR', '日文识别', '合并文本行', '文本顺序排序',
    '翻译待执行', '去字待执行', '翻译中', '翻译完成',
    '排版和嵌字', '译文'
  ];

  var seen = Object.create(null);   // keyword -> ts
  var events = [];                  // 环形缓冲，最多 1500 条
  var MAX = 1500;
  var seq = 0;

  function push(type, detail) {
    events.push({ t: Date.now(), type: type, detail: detail, v: 1 });
    if (events.length > MAX) events.splice(0, events.length - MAX);
  }

  function mark(keyword, ts) {
    if (seen[keyword]) return;
    seen[keyword] = ts || Date.now();
    push('stage.text', { keyword: keyword, at: seen[keyword] });
  }

  function scanText() {
    var root = document.body || document.documentElement;
    if (!root) return;
    // 只用 textContent：innerText 会强制同步重排，exhentai 这种大图墙每 800ms 来一次
    // 等于给被测页面自己灌卡顿，会把「慢」的源头搅浑
    var text;
    try {
      text = root.textContent || '';
    } catch (e) {
      push('stage.scan.error', { message: String(e && e.message) });
      return;
    }
    for (var i = 0; i < KEYWORDS.length; i += 1) {
      if (text.indexOf(KEYWORDS[i]) !== -1) mark(KEYWORDS[i]);
    }
  }

  function watchBlobImage() {
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i += 1) {
      var src = imgs[i].getAttribute('src') || '';
      if (src.indexOf('blob:') === 0) {
        if (!seen.__blob) {
          seen.__blob = Date.now();
          push('image.blob', { at: seen.__blob });
        }
        return;
      }
    }
  }

  // ---- 采集入口 ----
  push('doc.start', { url: location.href, title: document.title, visibility: document.visibilityState });

  document.addEventListener('visibilitychange', function () {
    push('lifecycle.visibility', { state: document.visibilityState });
  });
  document.addEventListener('freeze', function () { push('lifecycle.freeze', { state: document.visibilityState }); });
  document.addEventListener('resume', function () { push('lifecycle.resume', { state: document.visibilityState }); });
  window.addEventListener('pagehide', function () { push('lifecycle.pagehide', {}) ; });

  // 页面被丢弃时 Chrome 只留一个 wasDiscarded 标记，进不来脚本，交给 SW 在 dump 里报
  push('page.discardFlag', { wasDiscarded: !!document.wasDiscarded });

  // 文本阶段：MutationObserver + 去抖，别在猛改 DOM 时把主线程打满
  var pending = false;
  var observer = null;
  function onMutation() {
    if (pending) return;
    pending = true;
    setTimeout(function () {
      pending = false;
      try {
        scanText();
        watchBlobImage();
      } catch (e) {
        push('observer.error', { message: String(e && e.message) });
      }
    }, 150);
  }

  try {
    observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement || document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style', 'data-status', 'data-stage', 'data-icon']
    });
    onMutation();
  } catch (e) {
    push('observer.error', { message: 'MutationObserver 不可用: ' + (e && e.message) });
  }

  // 兜底轮询：有些状态不进 DOM、只在内存里，MutationObserver 抓不到
  var timer = setInterval(function () {
    try {
      scanText();
      watchBlobImage();
    } catch (e) { /* 兜底里别抛 */ }
  }, 800);

  // ---- 页面自己有没有直连本机服务（目前主扩展没有，留个观测点）----
  try {
    var rawFetch = window.fetch;
    if (rawFetch) {
      window.fetch = function (input, init) {
        var url = (input && (input.url || String(input))) || '';
        if (url.indexOf('11436') !== -1) {
          var t0 = Date.now();
          return rawFetch.call(window, input, init).then(function (r) {
            push('page.fetch', { url: url.slice(0, 80), ms: Date.now() - t0, ok: r.ok });
            return r;
          }, function (e) {
            push('page.fetch', { url: url.slice(0, 80), ms: Date.now() - t0, error: String(e) });
            throw e;
          });
        }
        return rawFetch.call(window, input, init);
      };
    }
  } catch (e) { /* 打不动就算了 */ }

  // ---- 批量上报给后台 SW ----
  function flush() {
    if (!events.length) return;
    var batch = events.splice(0, events.length);
    try {
      chrome.runtime.sendMessage({ type: 'diag.push', events: batch }, function (res) {
        if (chrome.runtime.lastError) return;
        if (res && res.ok === false) push('push.failed', res.detail);
      });
    } catch (e) { /* 页面关了就直接丢，SW 里有缓冲 */ }
  }

  setInterval(flush, 3000);
  window.addEventListener('beforeunload', flush);
  window.addEventListener('pagehide', flush);
})();
