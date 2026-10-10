/**
 * 翻页重载观测器 · 页面侧探针（只读，不改页面任何行为）。
 *
 * 它要回答的唯一问题：**这个文档是什么时候被"真正建起来"的，以及它什么时候被换掉的。**
 *
 * 为什么盯 `doc.start`：主扩展的事件流里没有"内容脚本注入"这一条，
 * 所以"缓存突然全没了"只能靠 sessionId 反推。这里的 `doc.start` 就是那个注入点
 * —— 一个文档只会注入一次；每多一条 `doc.start`，就是页面被整份换掉了一次，
 * 主扩展的 PhotoStateStore 也就跟着换了个新的空实例（缓存 = 全丢）。
 *
 * 上报走 `chrome.runtime.sendMessage`，落盘在 background 的 `chrome.storage.session`
 * （会话级，MV3 的 service worker 随时会被回收，内存数组靠不住）。
 */

(function observeNavigation() {
  if (window.__navObserverInstalled) return;
  window.__navObserverInstalled = true;

  var docId = '';
  try {
    docId = Math.random().toString(36).slice(2, 10);
  } catch (e) {
    docId = 'na';
  }

  // navigation timing 是这一侧唯一能区分「浏览器重载」与「站点跳转」的官方口径：
  //   reload     = 浏览器重新加载（含 tab discard 之后的自动恢复）
  //   navigate   = 普通导航（点链接、地址栏、跳转）
  //   back_forward = 前进/后退
  //   prerender  = 预渲染
  var navEntries = [];
  try {
    navEntries = performance.getEntriesByType('navigation') || [];
  } catch (e) {
    navEntries = [];
  }
  var firstNav = navEntries.length > 0 ? navEntries[0] : null;

  var meta = {
    docId: docId,
    url: location.href,
    host: location.host,
    navType: firstNav && firstNav.type ? firstNav.type : 'unknown',
    navCount: navEntries.length,
    loaderType: firstNav && firstNav.loaderType ? firstNav.loaderType : null,
    startedAt: Date.now()
  };

  var pageNum = (function () {
    var m = /-(\d+)\/?$/.exec(location.pathname);
    return m ? m[1] : null;
  })();

  function push(kind, extra) {
    var ev = {
      kind: kind,
      at: Date.now(),
      docId: meta.docId,
      url: location.href,
      host: meta.host,
      pageNo: pageNum,
      navType: meta.navType,
      navCount: meta.navCount
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) ev[k] = extra[k];
      }
    }
    try {
      void chrome.runtime.sendMessage({ type: 'navObserve', event: ev });
    } catch (e) {
      // 扩展上下文失效（页面卸载 / 扩展重载）时静默 —— 观测失败不该影响阅读。
    }
  }

  // ── 第 1 条：文档建立 = 内容脚本注入 = 主扩展缓存归零 ────────────────
  // 带上 referrer：如果是同站跳来的，这里就是"上一页"的 URL。
  push('doc.start', {
    referrer: document.referrer || null,
    // 本次导航的完整属性（新文档侧）。`type` 只区分 navigate/reload/back_forward，
    // 更细的"是谁发起的"要看下面 `nav.request`（Navigation API）。
    navEntry: firstNav
      ? {
          type: firstNav.type || null,
          redirectCount: typeof firstNav.redirectCount === 'number' ? firstNav.redirectCount : null,
          transferSize: typeof firstNav.transferSize === 'number' ? firstNav.transferSize : null,
          duration: typeof firstNav.duration === 'number' ? Math.round(firstNav.duration) : null,
        }
      : null,
  });

  // ── ★ 导航发起瞬间：这是唯一能回答"页面为什么换了"的地方 ──────────────
  // Navigation API 的 `navigate` 事件在**即将被换掉的那个文档**里触发，
  // `event.userInitiated` 直接说明这次导航是不是用户操作引起的 ——
  // 这是区分"用户点了/按了"和"脚本自己跳"的**官方判据**，不用再靠推测。
  // 注意它只在导航**发起时**触发：如果页面是被别的机制换掉的（崩溃、被丢弃），
  // 这里不会有记录，那本身也是一种结论。
  try {
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', function (e) {
        push('nav.request', {
          navigationType: e.navigationType || null, // push / replace / traverse / reload
          userInitiated: e.userInitiated === true,  // ★ 用户操作引起的？
          canIntercept: e.canIntercept === true,
          hashChange: e.hashChange === true,
          formSubmitted: Boolean(e.formData),
          downloadRequest: typeof e.downloadRequest === 'string' ? e.downloadRequest : null,
          destinationUrl: e.destination ? e.destination.url : null,
          fromUrl: location.href,
        });
      });
    } else {
      push('nav.api.unavailable');
    }
  } catch (e) {
    push('nav.api.throw', { error: String(e) });
  }

  // ── 文档生命终点 ──────────────────────────────────────────────────
  window.addEventListener('pagehide', function (e) {
    push('pagehide', { persisted: e.persisted === true });
  });
  window.addEventListener('unload', function () {
    push('unload');
  });

  // ── 可见性：用来分辨"页面还在前台"还是"被切到后台"（后台才可能被回收）──
  document.addEventListener('visibilitychange', function () {
    push('visibility', { hidden: document.hidden === true });
  });

  // ── 软导航兜底：地址栏变了但文档没换（pushState），只记不判定 ──────────
  // e-hentai 阅读页每页一个 /s/<tok>/<gid>-<page> 的 URL，翻页到底是
  // 「新文档」还是「改写 URL」，得靠 URL 变化 + 是否再次 doc.start Joint 判断。
  var lastPath = location.pathname + location.search;
  window.addEventListener('popstate', function () {
    push('popstate', { url: location.href });
  });
  setInterval(function () {
    var now = location.pathname + location.search;
    if (now !== lastPath) {
      lastPath = now;
      push('url.changed', { url: location.href });
    }
  }, 250);

  // ── 心跳：证明"这个文档还活着"，也是算存活时长的分母 ────────────────
  // 只在页面可见时发，避免后台标签刷屏。
  setInterval(function () {
    if (document.hidden) return;
    push('alive');
  }, 10000);
})();
