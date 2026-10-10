/**
 * 翻页重载观测器 · 弹窗。
 *
 * 三件事：看现状、复制一段**给人（AI）直接读**的现场摘要、导出原始 JSON。
 *
 * 「复制现场」是主要交付面 —— 出问题后不用先找文件，粘一段文本就能定性：
 * 文档被换了几次、间隔多少、是 reload 还是 navigate、有哪几次空档。
 */

'use strict';

var $ = function (id) { return document.getElementById(id); };
var hintTimer = null;

function hint(text) {
  $('hint').textContent = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(function () { $('hint').textContent = ''; }, 4000);
}

function call(msg) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(msg, function (res) {
      var err = chrome.runtime.lastError;
      if (err && err.message) return reject(new Error(err.message));
      resolve(res || {});
    });
  });
}

function fmt(ms) {
  var d = new Date(ms);
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  var ss = String(d.getSeconds()).padStart(2, '0');
  var mmm = String(d.getMilliseconds()).padStart(3, '0');
  return hh + ':' + mm + ':' + ss + '.' + mmm;
}

function dur(ms) {
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + (s % 60) + 's';
}

function shortUrl(u) {
  if (!u) return '';
  var s = String(u).replace(/^https?:\/\//, '');
  if (s.length > 42) s = s.slice(0, 42) + '…';
  return s;
}

/** 关键事件才进列表；alive 心跳用于算存活时长，不入列表。 */
var KEY_KINDS = [
  'doc.start',
  'nav.request',
  'nav.api.unavailable',
  'pagehide',
  'unload',
  'visibility',
  'url.changed',
  'popstate',
];

/** 把一条事件的"附加信息"写成一行短文字。 */
function extraOf(e) {
  if (e.kind === 'pagehide') return e.persisted ? 'persisted' : '!persisted';
  if (e.kind === 'visibility') return e.hidden ? 'hidden' : 'visible';
  if (e.kind === 'nav.request') {
    // ★ 这一行是判据：userInitiated=false 就是"没人操作，脚本自己跳的"。
    return (e.userInitiated ? '★用户发起' : '脚本发起') +
      (e.navigationType ? '/' + e.navigationType : '') +
      (e.destinationUrl ? ' → ' + shortUrl(e.destinationUrl) : '');
  }
  if (e.kind === 'doc.start' && e.referrer) return 'referrer=' + shortUrl(e.referrer);
  if (e.tabId != null) return 'tab' + e.tabId;
  return '';
}

function analysis(events) {
  var docStarts = events.filter(function (e) { return e.kind === 'doc.start'; });
  var gaps = [];
  for (var i = 1; i < docStarts.length; i++) {
    gaps.push({ from: docStarts[i - 1], to: docStarts[i], ms: docStarts[i].at - docStarts[i - 1].at });
  }
  var maxGap = gaps.reduce(function (a, g) { return g.ms > (a ? a.ms : 0) ? g : a; }, null);
  var navTypes = {};
  docStarts.forEach(function (e) {
    var t = e.navType || 'unknown';
    navTypes[t] = (navTypes[t] || 0) + 1;
  });
  var last = events.length > 0 ? events[events.length - 1] : null;
  return {
    docStarts: docStarts,
    gaps: gaps,
    maxGap: maxGap,
    navTypes: navTypes,
    unloadCount: events.filter(function (e) { return e.kind === 'pagehide' || e.kind === 'unload'; }).length,
    firstAt: events.length > 0 ? events[0].at : null,
    lastAt: last ? last.at : null,
    now: Date.now()
  };
}

function render(events) {
  var a = analysis(events);
  var lastDoc = a.docStarts.length > 0 ? a.docStarts[a.docStarts.length - 1] : null;

  $('s-doc').textContent = a.docStarts.length;
  $('s-gap').textContent = a.maxGap ? dur(a.maxGap.ms) : '–';
  $('s-alive').textContent = lastDoc ? dur(a.now - lastDoc.at) : '–';

  var list = $('list');
  list.innerHTML = '';
  var shown = events.filter(function (e) { return KEY_KINDS.indexOf(e.kind) >= 0; });
  if (shown.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没有观测到任何事件 —— 去 exhentai 翻几页再回来。';
    list.appendChild(empty);
    $('s-doc').textContent = '0';
    $('s-gap').textContent = '–';
    $('s-alive').textContent = '–';
    return;
  }

  var frag = document.createDocumentFragment();
  shown.forEach(function (e) {
    var row = document.createElement('div');
    row.className = 'row' + (e.kind === 'doc.start' ? ' newdoc' : '');
    var extra = extraOf(e);
    row.innerHTML =
      '<span class="at">' + fmt(e.at) + '</span>' +
      '<span class="kind">' + e.kind + '</span>' +
      '<span class="navtype">' + (e.navType || '') + '</span>' +
      '<span class="url">' + shortUrl(e.url) + (extra ? ' <b>(' + extra + ')</b>' : '') + '</span>';
    frag.appendChild(row);
  });
  list.appendChild(frag);
}

function textReport(raw) {
  var events = sortByTime(raw);
  var a = analysis(events);
  var lines = [];
  lines.push('nav-observer 现场摘要');
  lines.push('生成于 ' + fmt(Date.now()));
  lines.push('范围 ' + (a.firstAt ? fmt(a.firstAt) : '–') + ' -> ' + (a.lastAt ? fmt(a.lastAt) : '–') +
    '   事件 ' + events.length + ' 条');
  lines.push('');
  lines.push('文档次数 ' + a.docStarts.length +
    '   卸载事件 ' + a.unloadCount +
    '   最长空档 ' + (a.maxGap ? dur(a.maxGap.ms) : '–'));
  var navText = Object.keys(a.navTypes).map(function (k) { return k + '=' + a.navTypes[k]; }).join(' ');
  lines.push('导航类型分布 ' + (navText || '–'));
  lines.push('');

  lines.push('— 文档时间线 —');
  a.docStarts.forEach(function (e, i) {
    var aliveSince = i === 0 ? a.firstAt : a.docStarts[i - 1].at;
    lines.push('[' + fmt(e.at) + '] 文档#' + (i + 1) +
      '  nav=' + (e.navType || 'unknown') +
      '  navCount=' + e.navCount +
      '  页=' + (e.pageNo == null ? '?' : e.pageNo) +
      '  存活' + dur(e.at - aliveSince) +
      '  ' + shortUrl(e.url));
  });

  var bigGaps = a.gaps.filter(function (g) { return g.ms > 20000; });
  if (bigGaps.length > 0) {
    lines.push('');
    lines.push('— 大于 20s 的空档（文档被换掉之间的窗口）—');
    bigGaps.forEach(function (g) {
      lines.push('[' + fmt(g.from.at) + '] -> [' + fmt(g.to.at) + ']  间隔 ' + dur(g.ms) +
        '  上一下载 ' + shortUrl(g.from.url) + '  新文档 ' + shortUrl(g.to.url));
    });
  } else {
    lines.push('');
    lines.push('— 大于 20s 的空档：无（文档换得很密）—');
  }

  // 导航请求单独拎出来 —— 这是"页面为什么被换掉"的唯一直接证据。
  var navReqs = events.filter(function (e) { return e.kind === 'nav.request'; });
  lines.push('');
  if (navReqs.length > 0) {
    lines.push('— 导航发起记录（谁让页面换掉的）—');
    navReqs.forEach(function (e) {
      lines.push('[' + fmt(e.at) + '] ' + (e.userInitiated ? '★ 用户发起' : '⚙ 脚本发起') +
        '  type=' + (e.navigationType || '?') +
        '  ' + shortUrl(e.fromUrl || e.url) + ' → ' + shortUrl(e.destinationUrl));
    });
  } else {
    lines.push('— 导航发起记录：无（页面不是被导航换掉的，或 Navigation API 不可用）—');
  }

  lines.push('');
  lines.push('— 事件明细（关键项）—');
  events.filter(function (e) { return KEY_KINDS.indexOf(e.kind) >= 0; }).forEach(function (e) {
    var extra = extraOf(e);
    lines.push('[' + fmt(e.at) + '] ' + e.kind + '  nav=' + (e.navType || 'unknown') +
      '  ' + shortUrl(e.url) + (extra ? '  (' + extra + ')' : '') +
      (e.tabId != null ? '  [tab' + e.tabId + ']' : ''));
  });

  return lines.join('\n');
}

/**
 * 按 `at` 升序稳定排序。
 * 为什么必须排：MV3 里消息不一定按发生顺序到达 —— 旧文档的 `pagehide` 完全可能
 * 比新文档的 `doc.start` 后到（两者几乎同时发生，谁先被 service worker 捞到是随机的）。
 * 不排就会算出负的"存活时长"和错位的空档。
 */
function sortByTime(events) {
  return events.slice().sort(function (a, b) {
    return (a.at || 0) - (b.at || 0);
  });
}

function load() {
  return call({ type: 'navGet' }).then(function (res) {
    var events = sortByTime((res && res.events) || []);
    render(events);
    return events;
  });
}

function download(name, text) {
  var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

$('btn-copy').addEventListener('click', function () {
  load().then(function (events) {
    var text = textReport(events);
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); hint('已复制现场摘要'); }
      catch (e) { hint('复制失败，改用导出 JSON'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { hint('已复制现场摘要，粘给分析即可'); }, fallback);
    } else {
      fallback();
    }
  }).catch(function (err) { hint('读取失败：' + err.message); });
});

$('btn-save').addEventListener('click', function () {
  load().then(function (events) {
    var a = analysis(events);
    var payload = {
      schema: 'nav-observer/1',
      generatedAt: new Date().toISOString(),
      generatedAtMs: Date.now(),
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      summary: {
        eventCount: events.length,
        docStartCount: a.docStarts.length,
        unloadCount: a.unloadCount,
        maxGapMs: a.maxGap ? a.maxGap.ms : null,
        maxGapFrom: a.maxGap ? fmt(a.maxGap.from.at) : null,
        maxGapTo: a.maxGap ? fmt(a.maxGap.to.at) : null,
        navTypes: a.navTypes,
        firstAt: a.firstAt,
        lastAt: a.lastAt
      },
      events: events
    };
    var stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    download('nav-observer-' + stamp + '.json', JSON.stringify(payload, null, 2));
    hint('已导出 JSON（' + events.length + ' 条）');
  }).catch(function (err) { hint('导出失败：' + err.message); });
});

$('btn-clear').addEventListener('click', function () {
  call({ type: 'navClear' }).then(function () {
    hint('已清空');
    return load();
  }).catch(function (err) { hint('清空失败：' + err.message); });
});

load().catch(function (err) { hint('初始化失败：' + err.message); });
