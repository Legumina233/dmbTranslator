// dmb M4 预取探针 · popup（独立扩展，2026-10-03）
// 动线：打开 popup → 向当前标签页的探针 content script 要「最新快照 + 时间线」→ 渲染。
// 不轮询：打开拉一次 + 手动「刷新」。「复制 JSON」把原始遥测拷进剪贴板，方便贴给排查。
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var refreshBtn = $('refresh');
  var copyBtn = $('copy');
  var statusEl = $('status');
  var detailEl = $('detail');
  var offlineEl = $('offline');
  var offlineReasonEl = $('offlineReason');
  var lastPayload = null;

  function setStatus(kind, text) {
    statusEl.className = 'status status-' + kind;
    statusEl.textContent = text;
  }

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

  function fmtTime(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function renderStacking(stacking) {
    if (!stacking) return;
    var o = stacking.overlay || {};
    var a = stacking.anchor || {};
    $('stOverlay').textContent = o.exists
      ? '存在（z=' + o.zIndex + '，' + o.display + '）' : '不存在';
    $('stAnchor').textContent = a.exists
      ? '存在（z=' + a.zIndex + '，' + a.display + '）' : '不存在';
    $('stAnchorContent').textContent = stacking.anchorEmpty
      ? '空壳（UI 已被卸载 → 按钮没挂，不是被盖）'
      : (a.exists ? '有内容（' + a.childCount + ' 子节点）' : '—');
    $('stOverlayRect').textContent = o.exists && o.rect
      ? ('x' + o.rect.x + ' y' + o.rect.y + ' ' + o.rect.w + '×' + o.rect.h) : '—';
    $('stAnchorRect').textContent = a.exists && a.rect
      ? ('x' + a.rect.x + ' y' + a.rect.y + ' ' + a.rect.w + '×' + a.rect.h) : '—';
    $('stVerdict').textContent = stacking.verdict || '—';
    var chainsEl = $('stChains');
    var lines = [];
    if (o.exists && o.contextChain && o.contextChain.length > 0) {
      lines.push('画框祖先上下文：' + JSON.stringify(o.contextChain));
    }
    if (a.exists && a.contextChain && a.contextChain.length > 0) {
      lines.push('按钮祖先上下文：' + JSON.stringify(a.contextChain));
    }
    if (lines.length > 0) {
      chainsEl.textContent = lines.join('\n');
      chainsEl.classList.remove('hidden');
    } else {
      chainsEl.classList.add('hidden');
    }
  }

  function render(payload) {
    lastPayload = payload;
    if (payload.error) {
      detailEl.classList.add('hidden');
      offlineEl.classList.remove('hidden');
      offlineReasonEl.textContent = '连不上探针脚本：' + payload.error +
        '（探针刚装好要先刷新页面；仅 e-hentai / exhentai 页面有探针）';
      setStatus('off', '未连接');
      copyBtn.classList.add('hidden');
      return;
    }
    if (!payload.found) {
      detailEl.classList.add('hidden');
      offlineEl.classList.remove('hidden');
      offlineReasonEl.textContent = '探针脚本已连上，但这页没读到正式扩展的预取遥测' +
        '（data-m5-chain 不存在）：正式扩展未装 / 未更新到 M4 版，或当前不是漫画阅读页。';
      setStatus('off', '未读到遥测');
      copyBtn.classList.add('hidden');
      return;
    }

    copyBtn.classList.remove('hidden');
    offlineEl.classList.add('hidden');
    detailEl.classList.remove('hidden');

    var t = payload.latest || {};
    var chain = t.chain || {};
    var dispatch = t.dispatch || {};
    var executor = t.executor || {};
    var showkeyFound = t.showkeyFound === true;
    var circuitOpen = dispatch.circuitOpen === true;
    var chainDisabled = (chain.disabledReason || '').length > 0;

    var kind = 'ok';
    var text = '预取正常（空闲）';
    if (circuitOpen) { kind = 'warn'; text = '直连已熔断（连续失败且零成功）'; }
    else if (!showkeyFound) { kind = 'warn'; text = 'showkey 未抓到 —— 直连不会发包'; }
    else if (chainDisabled) { kind = 'warn'; text = '链已停：' + chain.disabledReason; }
    else if ((executor.active || 0) > 0) { kind = 'ok'; text = '预取进行中'; }
    else if ((dispatch.ok || 0) > 0) { kind = 'ok'; text = '预取正常（空闲）'; }
    else { kind = 'warn'; text = '已连接，尚未发出请求（翻一页试试）'; }
    setStatus(kind, text);

    $('lastPage').textContent = chain.lastPageKey || '—';
    $('farthest').textContent = chain.farthestPage != null ? chain.farthestPage : '—';
    $('known').textContent = chain.knownCount != null ? chain.knownCount : '—';
    $('reqrecv').textContent = (chain.requested != null ? chain.requested : '—') + ' / ' +
      (chain.received != null ? chain.received : '—');
    $('showkey').textContent = showkeyFound ? '已抓到' : '未抓到';
    $('showkey').className = 'value' + (showkeyFound ? '' : ' warn');
    $('okfail').textContent = (dispatch.ok != null ? dispatch.ok : '—') + ' / ' +
      (dispatch.fail != null ? dispatch.fail : '—');
    $('okfail').className = 'value' + (circuitOpen ? ' warn' : '');
    $('pending').textContent = dispatch.pending != null ? dispatch.pending : '—';
    $('subact').textContent = (executor.submitted != null ? executor.submitted : '—') + ' / ' +
      (executor.active != null ? executor.active : '—');
    $('queued').textContent = Array.isArray(executor.queued) ? executor.queued.length : '—';
    $('skips').textContent = (executor.skippedBusy || 0) + ' / ' + (executor.skippedNoImage || 0) +
      ' / ' + (executor.outOfWindow || 0);

    var history = Array.isArray(payload.history) ? payload.history : [];
    $('histTotal').textContent = String(history.length);
    var tbody = $('timeline');
    tbody.textContent = '';
    var shown = history.slice(-12).reverse(); // 新 → 旧
    for (var i = 0; i < shown.length; i += 1) {
      var r = shown[i];
      var tr = document.createElement('tr');
      [fmtTime(r.t), r.requested, r.received, r.submitted, r.active].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = String(v);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    renderStacking(payload.stacking);
  }

  function refresh() {
    refreshBtn.disabled = true;
    activeTabId().then(function (tabId) {
      if (tabId == null) return { error: '拿不到当前标签页（先点到 e-hentai 页面再开 popup）' };
      return tabMessage(tabId, { type: 'm4diag-get' });
    }).then(render).finally(function () {
      refreshBtn.disabled = false;
    });
  }

  copyBtn.addEventListener('click', function () {
    if (!lastPayload || lastPayload.error) return;
    var text = JSON.stringify({
      probe: 'm4-diag 0.2.0',
      exportedAt: new Date().toISOString(),
      href: lastPayload.href,
      latest: lastPayload.latest,
      history: lastPayload.history,
      stacking: lastPayload.stacking === undefined ? null : lastPayload.stacking
    }, null, 2);
    navigator.clipboard.writeText(text).then(function () {
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制 JSON'; }, 1200);
    });
  });

  refreshBtn.addEventListener('click', refresh);
  refresh();
})();
