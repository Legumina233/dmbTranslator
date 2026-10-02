# -*- coding: utf-8 -*-
"""模型控制面板（单页，由本服务自带）。

目的：**不等扩展 UI**，先把"加载 / 卸载模型"这件事做成可点的按钮。
打开 http://127.0.0.1:<port>/ 即可。

同时解决两个 v1 的老毛病：
  * 模型是否已加载对用户不可见 → 这里显示驻留明细与占用显存
  * 只能靠"点开始翻译"顺带加载 → 这里可以**显式**加载/卸载
"""

CONTROL_PANEL_HTML = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dmbTranslator v2 · 模型控制</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 24px; background: #f6f6f4; color: #22221f; }
  h1 { font-size: 16px; font-weight: 500; margin: 0 0 4px; }
  .sub { color: #77776f; font-size: 12px; margin-bottom: 18px; }
  .card { background: #fff; border: 1px solid #e3e3dd; border-radius: 12px;
          padding: 16px; margin-bottom: 14px; max-width: 720px; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0;
         border-bottom: 1px solid #f1f1ec; }
  .row:last-child { border-bottom: none; }
  .name { flex: 1; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
  .on  { background: #e1f5ee; color: #0f6e56; }
  .off { background: #f1efe8; color: #5f5e5a; }
  button { font: inherit; padding: 5px 12px; border-radius: 8px; cursor: pointer;
           border: 1px solid #cfcfc7; background: #fff; }
  button:hover:not(:disabled) { border-color: #88887f; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .prim { background: #22221f; color: #fff; border-color: #22221f; }
  .kpi { display: flex; gap: 28px; margin-bottom: 6px; }
  .kpi div span { display: block; font-size: 11px; color: #88887f; }
  .kpi div b { font-weight: 500; font-size: 15px; }
  #msg { color: #55554f; font-size: 12px; min-height: 18px; margin-top: 6px; }
  .warn { color: #854f0b; }
</style></head><body>
<h1>dmbTranslator v2 · 模型控制</h1>
<div class="sub">本地服务 <span id="base"></span> · <a href="/health">/health</a> · <a href="/v1/models">/v1/models</a></div>

<div class="card">
  <div class="kpi">
    <div><span>驻留显存合计</span><b id="vram">-</b></div>
    <div><span>keep_alive</span><b id="ka">-</b></div>
    <div><span>自动卸载</span><b id="auto">-</b></div>
  </div>
  <div id="msg"></div>
  <button id="unloadAll" style="margin-top:10px">卸载全部驻留模型</button>
</div>

<div class="card" id="list"><div class="sub">加载中…</div></div>

<script>
const $ = (id) => document.getElementById(id);
document.getElementById('base').textContent = location.origin;

function fmtMB(n) {
  n = Number(n || 0);
  return n ? (n / 1048576).toFixed(0) + ' MB' : '0 MB';
}

async function api(path, body) {
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(body) } : { method: 'GET' };
  const r = await fetch(path, opt);
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
  return j;
}

function say(t, cls) { const m = $('msg'); m.textContent = t || ''; m.className = cls || ''; }

let busy = false;
async function refresh() {
  let st;
  try { st = await api('/model/status'); }
  catch (e) { $('list').innerHTML = '<div class="sub">读取失败: ' + e.message + '</div>'; return; }
  $('vram').textContent = fmtMB(st.loaded_total_vram);
  $('ka').textContent = String(st.keep_alive);
  $('auto').innerHTML = st.auto_unload
    ? '<span class="warn">开（会被静默卸载）</span>' : '关（只由你手动卸载）';

  const box = $('list');
  box.innerHTML = '';
  if (!st.installed.length) { box.innerHTML = '<div class="sub">没有已安装的模型</div>'; return; }
  for (const m of st.installed) {
    const row = document.createElement('div'); row.className = 'row';
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = m.name;
    const tg = document.createElement('span');
    tg.className = 'tag ' + (m.loaded ? 'on' : 'off');
    tg.textContent = m.loaded ? '已加载' : '未加载';
    const bLoad = document.createElement('button');
    bLoad.textContent = '加载'; bLoad.className = 'prim'; bLoad.disabled = m.loaded || busy;
    bLoad.onclick = () => act('/model/load', m.name, '加载');
    const bUn = document.createElement('button');
    bUn.textContent = '卸载'; bUn.disabled = !m.loaded || busy;
    bUn.onclick = () => act('/model/unload', m.name, '卸载');
    row.append(nm, tg, bLoad, bUn); box.appendChild(row);
  }
}

async function act(path, model, verb) {
  busy = true; await refresh();
  say(verb + '中: ' + model + ' …');
  const t0 = performance.now();
  try {
    const r = await api(path, { model });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    say(verb + '完成: ' + model + '（' + dt + 's）' + (r && r.detail ? ' · ' + r.detail : ''));
  } catch (e) { say(verb + '失败: ' + e.message, 'warn'); }
  busy = false; await refresh();
}

async function unloadAll() {
  busy = true; await refresh(); say('卸载全部中 …');
  try { await api('/model/unload-all', {}); say('已卸载全部'); }
  catch (e) { say('失败: ' + e.message, 'warn'); }
  busy = false; await refresh();
}

document.getElementById('unloadAll').onclick = unloadAll;

refresh();
setInterval(() => { if (!busy) refresh(); }, 4000);
</script></body></html>
"""
