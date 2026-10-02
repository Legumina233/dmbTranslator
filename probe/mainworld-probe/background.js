// dmb probe — service worker。收集记录 + 一键导出 JSON。
const KEY = 'dmb_probe_events';
const MAX = 3000;

let queue = Promise.resolve();

async function append(rec) {
  const cur = (await chrome.storage.session.get(KEY))[KEY] || [];
  cur.push(rec);
  if (cur.length > MAX) cur.splice(0, cur.length - MAX);
  await chrome.storage.session.set({ [KEY]: cur });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'record') {
    queue = queue.then(() => append(Object.assign({}, msg.data, {
      tabId: sender.tab ? sender.tab.id : -1,
      frameId: sender.frameId
    }))).catch(() => {});
    return;
  }
  if (msg.type === 'count') {
    chrome.storage.session.get(KEY).then(o => sendResponse({ count: (o[KEY] || []).length }));
    return true;
  }
  if (msg.type === 'clear') {
    chrome.storage.session.set({ [KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'export') {
    (async () => {
      const events = (await chrome.storage.session.get(KEY))[KEY] || [];
      const report = summarize(events);
      const json = JSON.stringify(report, null, 2);
      const b64 = btoa(unescape(encodeURIComponent(json)));
      await chrome.downloads.download({
        url: 'data:application/json;base64,' + b64,
        filename: 'dmb-probe-report.json',
        saveAs: true
      });
      sendResponse({ ok: true, events: events.length });
    })();
    return true;
  }
});

function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function summarize(events) {
  const http = events.filter(e => e.kind === 'xhr' || e.kind === 'fetch');
  const imgSrcs = events.filter(e => e.kind === 'img-src');
  const globals = events.filter(e => e.kind === 'globals');
  const readies = events.filter(e => e.kind === 'ready');
  const errors = events.filter(e => e.kind === 'hook-error');
  const lastUrl = events.length ? events[events.length - 1].url : null;

  // 解析每个 showpage 响应，抽出关键字段
  const showpage = http.map(h => {
    const p = h.payload || {};
    const parsed = tryParse(p.resp);
    let keys = null, gdata = null;
    if (parsed && typeof parsed === 'object') {
      keys = Object.keys(parsed);
      // 猜图片 URL 字段
      const cand = {};
      keys.forEach(k => {
        const v = parsed[k];
        if (typeof v === 'string' && /^https?:\/\//.test(v)) cand[k] = v.slice(0, 300);
      });
      gdata = cand;
    }
    return {
      kind: h.kind, url: p.url, status: p.status,
      respLen: (p.resp || '').length,
      jsonKeys: keys,
      urlLikeValues: gdata,
      respRaw: p.resp
    };
  });

  // imgkey 演进
  const imgSrcList = imgSrcs.map(i => (i.payload || {}).src).filter(Boolean);

  // 最终全局值
  let finalGlobals = null;
  globals.forEach(g => { finalGlobals = (g.payload || {}).values || finalGlobals; });
  readies.forEach(r => { if (r.payload && r.payload.globals) finalGlobals = r.payload.globals; });

  return {
    probe: 'dmb-phase1-mainworld',
    probeVersion: '1.2.0',
    mode: 'passive',
    exportedAt: new Date().toISOString(),
    lastUrl,
    summary: {
      totalEvents: events.length,
      httpIntercepted: http.length,
      showpageResponses: showpage.filter(s => /showpage|api\.php/i.test(s.url || '')).length,
      imgSrcChanges: imgSrcList.length,
      finalGlobals,
      hookErrors: errors.map(e => e.payload)
    },
    verdictHints: {
      sawShowpageResponse: showpage.some(s => s.respLen > 50),
      imageUrlInResponse: showpage.some(s => s.urlLikeValues && Object.keys(s.urlLikeValues).length > 0)
    },
    showpage,
    imgSrcList,
    globals: globals.slice(-200),
    readies,
    rawTail: events.slice(-120)
  };
}
