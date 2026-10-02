// dmb probe — MAIN world (v1.2) —— 纯被动观测，不改写任何站点函数。
// v1.2 变更：v1.1 里 load_image 出现异常（疑似页面状态导致），故彻底放弃"劫持"，
//            改为监听 XHR / fetch + MutationObserver，零侵入地抓 showpage 响应与图片 URL。
// 目的：① showpage 响应里有没有图片真实 URL ② 下一页 imgkey 从哪来。验完即删。
(function () {
  'use strict';
  var PROBE_KEYS = ['gid', 'pagecount', 'imgkey', 'showkey', 'nexturl', 'server', '_gid',
                    'load_image', 'apply_json_state', 'api_call'];
  var LIMIT = 8000;
  var startTs = Date.now();
  var lastImg = '';
  var lastGlobals = '';

  function send(type, payload) {
    try {
      window.postMessage({ __dmb: true, type: type, payload: payload, ts: Date.now(), url: location.href }, '*');
    } catch (e) {}
  }
  function clip(s) { s = String(s == null ? '' : s); return s.length > LIMIT ? s.slice(0, LIMIT) + '…[cut]' : s; }
  function interested(url) { return /api\.php|showpage|method=/i.test(String(url || '')); }

  // ── 1) XHR 被动监听（不改行为）─────────────────
  try {
    var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__dmb_url = u; this.__dmb_method = m; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var self = this;
      try {
        self.addEventListener('load', function () {
          try {
            if (!interested(self.__dmb_url)) return;
            send('xhr', { url: String(self.__dmb_url), method: self.__dmb_method,
                          status: self.status, resp: clip(self.responseText) });
          } catch (e) {}
        });
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) { send('hook-error', { target: 'xhr', error: String(e) }); }

  // ── 2) fetch 被动监听 ─────────────────────────
  try {
    var OF = window.fetch;
    if (typeof OF === 'function') {
      window.fetch = function (input) {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var p = OF.apply(this, arguments);
        try {
          if (interested(url)) {
            p.then(function (r) {
              try { r.clone().text().then(function (t) { send('fetch', { url: String(url), resp: clip(t) }); }).catch(function () {}); } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return p;
      };
    }
  } catch (e) { send('hook-error', { target: 'fetch', error: String(e) }); }

  // ── 3) 图片元素 src 变化（被动）────────────────
  function imgSrc() {
    try {
      var el = document.querySelector('#img') || document.querySelector('img#img') ||
               document.querySelector('#i1') || document.querySelector('.gm img') ||
               document.querySelector('img[id^="i"]');
      return el ? (el.currentSrc || el.getAttribute('src') || null) : null;
    } catch (e) { return '<err>'; }
  }

  // ── 4) 全局值快照（读值，不只读类型）──────────
  function globals() {
    var o = {};
    ['gid', 'pagecount', 'imgkey', 'showkey', 'nexturl', 'server', '_gid'].forEach(function (n) {
      try { var v = window[n]; if (v !== undefined) o[n] = (typeof v === 'string' ? v.slice(0, 120) : v); } catch (e) {}
    });
    ['load_image', 'apply_json_state', 'api_call'].forEach(function (n) {
      try { o[n] = typeof window[n]; } catch (e) {}
    });
    return o;
  }

  var ticks = 0;
  var iv = setInterval(function () {
    ticks++;
    var s = imgSrc();
    if (s && s !== lastImg) { lastImg = s; send('img-src', { src: s, t: Date.now() - startTs }); }
    var g = JSON.stringify(globals());
    if (g !== lastGlobals) { lastGlobals = g; send('globals', { values: JSON.parse(g), t: Date.now() - startTs }); }
    if (ticks > 600) clearInterval(iv); // 5 分钟
  }, 500);

  send('ready', { probeVersion: '1.2.0', mode: 'passive', url: location.href });
  document.addEventListener('DOMContentLoaded', function () {
    send('ready', { probeVersion: '1.2.0', mode: 'passive', url: location.href, at: 'DOMContentLoaded' });
  });
  window.addEventListener('load', function () {
    send('ready', { probeVersion: '1.2.0', mode: 'passive', url: location.href, at: 'load', globals: globals() });
  });

  window.addEventListener('message', function (ev) {
    if (!ev.data || !ev.data.__dmb_cmd) return;
    if (ev.data.__dmb_cmd === 'snapshot') {
      send('img-src', { src: imgSrc(), t: Date.now() - startTs, onDemand: true });
      lastGlobals = '';
    }
  });
})();
