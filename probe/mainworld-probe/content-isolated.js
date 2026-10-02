// dmb probe — ISOLATED world。把主世界的记录转给 background。
(function () {
  'use strict';
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__dmb) return;
    if (ev.source !== window) return;
    try {
      chrome.runtime.sendMessage({ type: 'record', data: {
        kind: d.type, payload: d.payload, ts: d.ts, url: d.url,
        frame: location.href === (d.url || '') ? 'top' : 'sub'
      } });
    } catch (e) {}
  });
})();
