// dmb M5 翻页闪屏诊断 —— popup：一键汇聚 + 一键落盘
// 动线与 m1/m3 探针一致：点「保存到电脑」→ 落 <下载>/dmb-probe/，文件名带时间戳。
(function () {
  'use strict';
  var headline = document.getElementById('headline');
  var out = document.getElementById('out');
  var saveBtn = document.getElementById('save');

  function activeTabId() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve(tabs && tabs[0] ? tabs[0].id : null);
      });
    });
  }
  function tabMessage(tabId, message) {
    return new Promise(function (resolve) {
      chrome.tabs.sendMessage(tabId, message, function (res) {
        var err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null;
        resolve(err ? { error: err } : (res || { error: '空响应' }));
      });
    });
  }
  function bgMessage(message) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(message, function (res) {
        var err = chrome.runtime.lastError ? String(chrome.runtime.lastError.message) : null;
        resolve(err ? { error: err } : (res || { error: '空响应' }));
      });
    });
  }

  function gather() {
    return activeTabId().then(function (tabId) {
      if (tabId == null) throw new Error('拿不到当前 tab（先点到 e-hentai 页面再开 popup）');
      return Promise.all([
        tabMessage(tabId, { type: 'm5flash-snapshot' }),
        tabMessage(tabId, { type: 'm5flash-dump' }),
        bgMessage({ type: 'm5flash-requests', since: 0 })
      ]);
    }).then(function (trio) {
      var page = trio[0], dump = trio[1], net = trio[2];
      if (page.error) throw new Error(page.error + '（探针刚装好要先刷新页面）');
      var events = (dump && dump.events) ? dump.events : page.events;
      var requests = net.requests || [];
      var report = {
        probe: 'm5-flashdiag 0.1.0',
        exportedAt: new Date().toISOString(),
        href: page.href,
        loadSeq: page.loadSeq,
        visitId: (dump && dump.dumps && dump.dumps.visitId) || null,
        production: page.production || {},
        dumps: (dump && dump.dumps) || null,
        events: events,
        requests: requests,
        segments: self.m5flash.segmentByActions(events, requests)
      };
      return { report: report, text: self.m5flash.render(report) };
    });
  }

  function refresh() {
    gather().then(function (r) {
      headline.textContent = '采集正常（点保存即可）';
      out.textContent = r.text;
    }).catch(function (e) {
      headline.textContent = '读取失败';
      out.textContent = String(e.message || e);
      out.className = 'err';
    });
  }

  saveBtn.addEventListener('click', function () {
    gather().then(function (r) {
      var blob = new Blob([JSON.stringify(r.report, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var filename = self.m5flash.filenameFor(new URL(r.report.href).hostname, Date.now());
      chrome.downloads.download({ url: url, filename: filename, saveAs: false }, function () {
        headline.textContent = '已保存：' + filename;
        URL.revokeObjectURL(url);
      });
    }).catch(function (e) {
      headline.textContent = '保存失败';
      out.textContent = String(e.message || e);
      out.className = 'err';
    });
  });

  refresh();
})();
