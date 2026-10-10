/* sw.js —— 后台 service worker：缓冲页面事件、量本地服务基线、按 popup 要求打包导出 */
'use strict';

const KEY = 'diag.events';
const MAX = 4000;
const wakes = [];          // 本次 SW 启动后的唤醒记录（只看诊断扩展自己的，用来看 SW 生命周期）
let swBorn = Date.now();
let wakeTimer = null;

function nowISO() {
  return new Date(swBorn).toISOString();
}

function recordWake(reason) {
  wakes.push({ at: Date.now(), reason: reason });
  if (wakes.length > 200) wakes.shift();
  // SW 里起定时器没意义（一 idle 就被回收）；只留当下这条，必要时在 dump 里带出去
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { /* no-op，仅占一个句柄避免立刻被回收 */ }, 5000);
}

async function readAll() {
  const buf = await chrome.storage.session.get(KEY);
  return buf[KEY] || [];
}

async function append(events) {
  const all = await readAll();
  for (const e of events) if (e) all.push(e);
  const tail = all.length > MAX ? all.slice(all.length - MAX) : all;
  await chrome.storage.session.set({ [KEY]: tail });
  return tail.length;
}

/** 从事件序列里算出「页面看到的」几个关键耗时 */
function derive(events) {
  const at = {};
  for (const e of events) {
    if (e.type === 'stage.text') at[e.detail && e.detail.keyword] = e.detail && e.detail.at;
    if (e.type === 'image.blob') at.__blob = e.detail && e.detail.at;
  }
  const span = (a, b) => (a != null && b != null && a >= 0 && b >= a) ? (b - a) : null;
  const firstText = at['文本检测'] != null ? at['文本检测']
    : (at['气泡检测'] != null ? at['气泡检测'] : (at['OCR'] != null ? at['OCR'] : null));
  return {
    translateVisibleMs: span(at['翻译待执行'] != null ? at['翻译待执行'] : at['翻译中'], at.__blob),
    ocrVisibleMs: span(at['OCR'] != null ? at['OCR'] : firstText, at['翻译待执行'] != null ? at['翻译待执行'] : at['翻译中']),
    milestones: at,
    // 注意：'lifecycle.*' 是字面量，match 不到任何真实 type，必须用前缀匹配
    lifecycle: events
      .filter((e) => typeof e.type === 'string' && e.type.indexOf('lifecycle.') === 0)
      .map((e) => ({ type: e.type, at: e.t, detail: e.detail }))
  };
}

/**
 * 每 30s 从「诊断扩展自己的 SW」探一次本地服务，把往返耗时与本次 SW 存活时长记成
 * `sw.probe` 事件。这是独立于主扩展的第三方观测，价值在于交叉验证：
 *   - 若 probe 全程稳定（几十 ms）而翻译仍慢 10s+  → 排除「扩展侧 SW 冷启动慢」，
 *     慢在别处（主扩展 offscreen 冻结 / Chrome 对那张卡的处理）；
 *   - 若 probe 也随时间一起变慢                    → 慢在机器或本机服务本身，与扩展无关；
 *   - 若 probe 的 ms 时大时小、且 swAliveMs 频繁从头算 → SW 一直在冷启动。
 */
const PROBE_EVENT = 'sw.probe';

async function probeHealth(reason) {
  const born = swBorn;
  let rec;
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch('http://127.0.0.1:11436/health', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    rec = { t: t0, type: PROBE_EVENT, reason, ms: Date.now() - t0, ok: res.ok, swAliveMs: Date.now() - born };
  } catch (e) {
    rec = { t: t0, type: PROBE_EVENT, reason, ms: null, error: String(e), swAliveMs: Date.now() - born };
  }
  append([rec]);
  return rec;
}

try {
  if (chrome.alarms && chrome.alarms.create) {
    chrome.alarms.create('diag.probe', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (!a || a.name !== 'diag.probe') return;
      probeHealth('alarm');
    });
  }
} catch (e) { /* alarms 起不来不影响手动导出 */ }

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  recordWake(msg && msg.type);

  if (msg && msg.type === 'diag.push') {
    append(msg.events || []).then((total) => respond({ ok: true, total }));
    return true;
  }

  if (msg && (msg.type === 'diag.status' || msg.type === 'diag.dump')) {
    (async () => {
      const all = await readAll();
      const derived = derive(all);
      // 本地服务基线：从 SW 这里量一次往返，和主扩展的路径性质相同（都从扩展发）
      let probe = null;
      try {
        const t0 = Date.now();
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch('http://127.0.0.1:11436/health', { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(timer);
        probe = { ms: Date.now() - t0, ok: res.ok, status: res.status };
      } catch (e) {
        probe = { ms: null, error: String(e) };
      }
      const payload = {
        meta: {
          tool: 'dmb-diag',
          version: chrome.runtime.getManifest().version,
          swBornAt: swBorn,
          swBornISO: nowISO(),
          storedEvents: all.length,
          browser: navigator.userAgent.slice(0, 160)
        },
        serverProbe: probe,
        derived,
        wakeLog: wakes.slice(-20),
        // 自动探针时间线（最多最近 60 次 / 30 分钟一针），用来判「慢」到底在谁身上
        healthTimeline: all.filter((e) => e.type === PROBE_EVENT).slice(-60),
        events: all
      };
      if (msg.type === 'diag.status') {
        respond({
          ok: true,
          storedEvents: all.length,
          probe,
          derived,
          last: all.slice(-12).map((e) => ({ t: e.t, type: e.type, detail: e.detail }))
        });
      } else {
        respond({ ok: true, payload });
      }
    })();
    return true;
  }

  respond({ ok: false, error: 'unknown' });
  return false;
});
