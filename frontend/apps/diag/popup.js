/* popup.js —— 一键保存：本地下载一份完整 JSON + 往本机服务事件流投一份摘要 */
'use strict';

const $out = document.getElementById('out');
const $btn = document.getElementById('save');

function render(obj) {
  $out.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function postSummary(payload) {
  // 完整事件放文件里；往事件流投摘要，免得把服务端日志撑爆
  const tail = (payload.events || []).slice(-40).map((e) => ({ t: e.t, type: e.type, at: e.detail ? e.detail.at : undefined }));
  const rec = {
    kind: 'diag.dump',
    level: 'info',
    where: { repo: 'extension', module: 'diag', fn: 'popup' },
    v: 2,
    ts: new Date().toISOString().slice(0, 19),
    what: {
      tool: 'dmb-diag',
      storedEvents: payload.meta.storedEvents,
      swBornAt: payload.meta.swBornAt,
      serverProbeMs: payload.serverProbe.ms,
      serverProbeOk: payload.serverProbe.ok === true,
      translateVisibleMs: payload.derived.translateVisibleMs,
      ocrVisibleMs: payload.derived.ocrVisibleMs,
      milestones: payload.derived.milestones,
      lifecycle: payload.derived.lifecycle,
      wakeCount: (payload.wakeLog || []).length,
      // 自动探针时间线只摘摘要：时刻 + 往返 ms + 本次 SW 已存活 ms
      healthLog: (payload.healthTimeline || []).slice(-20).map((e) => ({
        t: e.t, ms: e.ms, ok: e.ok, swAliveMs: e.swAliveMs, reason: e.reason, error: e.error
      })),
      tail
    }
  };
  return fetch('http://127.0.0.1:11436/log/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [rec] })
  }).then((r) => r.text().then((t) => ({ status: r.status, body: t.slice(0, 200) })));
}

$btn.addEventListener('click', async () => {
  $btn.disabled = true;
  render('打包中…');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'diag.dump' });
    if (!res || !res.ok) throw new Error((res && res.error) || '打包失败');
    const payload = res.payload;

    // 1) 落文件
    const name = `dmb-diag-${stamp()}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: name, saveAs: false });

    // 2) 投摘要到事件流
    const posted = await postSummary(payload);

    render({
      file: name,
      storedEvents: payload.meta.storedEvents,
      serverProbeMs: payload.serverProbe.ms,
      serverProbeOk: payload.serverProbe.ok === true,
      translateVisibleMs: payload.derived.translateVisibleMs,
      ocrVisibleMs: payload.derived.ocrVisibleMs,
      milestones: payload.derived.milestones,
      lifecycle: payload.derived.lifecycle,
      探针最近: (payload.healthTimeline || []).slice(-6).map((e) => `${new Date(e.t).toLocaleTimeString()} ms=${e.ms} swAlive=${e.swAliveMs}ms`),
      postedToEventLog: posted
    });
  } catch (e) {
    render('失败：' + (e && e.message));
  } finally {
    $btn.disabled = false;
  }
});

chrome.runtime.sendMessage({ type: 'diag.status' }, (res) => {
  if (chrome.runtime.lastError || !res || !res.ok) return;
  render({
    已采集事件: res.storedEvents,
    本地服务往返: res.probe,
    页面可见翻译耗时ms: res.derived.translateVisibleMs,
    页面可见OCR耗时ms: res.derived.ocrVisibleMs,
    最近事件: res.last
  });
});
