// dmb M5 翻页闪屏诊断 —— background：api.php 全流量环带（含 POST body）
//
// webRequest 能看到**所有**发起方的 api.php 请求：站点自己翻页的、生产扩展预取链直连的 ——
// 按 body 里的 page 号 + 时间轴区分。只记录、不 block、不改写。
(function () {
  'use strict';

  var MAX = 400;
  var requests = []; // { ts, tabId, url, method, page, bodySnippet }

  function pageFromApiBody(body) {
    try {
      var parsed = JSON.parse(body);
      return (parsed && typeof parsed.page === 'number') ? parsed.page : null;
    } catch (e) { return null; }
  }

  function onBeforeRequest(details) {
    var isApi = String(details.url || '').indexOf('api.php') >= 0;
    var rec = {
      ts: Date.now(),
      tabId: details.tabId,
      url: String(details.url || ''),
      method: String(details.method || ''),
      page: null
    };
    if (isApi && details.requestBody) {
      var raw = '';
      try {
        if (details.requestBody.raw && details.requestBody.raw[0]) {
          raw = new TextDecoder().decode(details.requestBody.raw[0]);
        } else if (details.requestBody.formData) {
          raw = JSON.stringify(details.requestBody.formData);
        }
      } catch (e) { raw = ''; }
      rec.page = pageFromApiBody(raw);
      rec.bodySnippet = raw.slice(0, 200);
    }
    requests.push(rec);
    if (requests.length > MAX) requests.shift();
  }

  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ['*://*.exhentai.org/*', '*://*.e-hentai.org/*', '*://*.ehgt.org/*', '*://*.hath.network/*'] },
    ['requestBody']
  );

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'm5flash-requests') {
      var since = typeof msg.since === 'number' ? msg.since : 0;
      sendResponse({ ok: true, requests: requests.filter(function (r) { return r.ts >= since; }) });
    }
    return false;
  });
})();
