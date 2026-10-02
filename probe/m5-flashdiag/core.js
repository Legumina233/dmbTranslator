// dmb M5 翻页闪屏诊断 —— 纯函数（popup 与 tools/selftest.cjs 共用）
// 判定与格式化集中在这里，离线可测（自检 + 反向验证见 tools/selftest.cjs）。
(function (root) {
  'use strict';

  /** 生成落盘文件名：<下载>/dmb-probe/m5-flashdiag-<host>-<ts>.json */
  function filenameFor(host, ts) {
    // 净化：只留字母数字点横线；连续点收敛成一个；首尾点剥掉 —— 不给路径穿越留门
    var safeHost = String(host || 'unknown')
      .replace(/[^a-z0-9.-]/gi, '')
      .replace(/\.+/g, '.')
      .replace(/^\.+|\.+$/g, '');
    if (!safeHost) safeHost = 'unknown';
    return 'dmb-probe/m5-flashdiag-' + safeHost + '-' + new Date(ts).toISOString().replace(/[:.]/g, '-') + '.json';
  }

  /**
   * 把 api.php 请求流分段：请求 body 带 page 号 ——
   * 用户当前页 N 时出现的 page=N+1..N+4 请求 = 生产扩展预取链；
   * page=翻页目标 = 站点自己的翻页请求。
   */
  function classifyRequests(requests) {
    var siteFlips = [];
    var prefetch = [];
    var other = [];
    (requests || []).forEach(function (r) {
      if (typeof r.page === 'number') { prefetch.push(r); return; } // 有 body 且带 page：回放形态（站点/预取都走这里，交给时间轴分析）
    });
    // 注：站点与预取的请求形态相同，单条无法归属 —— 交给 segmentByPage（下面的分段逻辑）
    return { siteFlips: siteFlips, prefetch: prefetch, other: other };
  }

  /**
   * 按用户动作分段（key/click 事件切段）：每段内列出 api.php 请求的 page 序列与 layout-shift。
   * 段内出现「目标页之外」的请求 = 预取链在动；layout-shift 出现在无 img-src 变化的时段 = 闪屏证据。
   */
  function segmentByActions(events, requests) {
    var validEvents = (events || []).filter(function (e) { return e && typeof e.ts === 'number' && typeof e.kind === 'string'; });
    var validRequests = (requests || []).filter(function (r) { return r && typeof r.ts === 'number'; });
    var actions = validEvents.filter(function (e) { return e.kind === 'user-key' || e.kind === 'user-click'; });
    var segments = actions.map(function (a, i) {
      var next = actions[i + 1];
      var from = a.ts;
      var to = next ? next.ts : (a.ts + 15000);
      var inSeg = validRequests.filter(function (r) { return r.ts >= from && r.ts <= to; });
      var shifts = validEvents.filter(function (e) {
        return e.kind === 'layout-shift' && e.ts >= from && e.ts <= to;
      });
      var imgChanges = validEvents.filter(function (e) {
        return e.kind === 'img-src' && e.ts >= from && e.ts <= to;
      });
      return {
        action: a.kind + ':' + (a.key || a.target || '?') + '@' + a.ts,
        apiPages: inSeg.map(function (r) { return r.page; }),
        shiftCount: shifts.length,
        shiftValue: shifts.reduce(function (acc, s) { return acc + (s.value || 0); }, 0),
        shiftWithInput: shifts.filter(function (s) { return s.hadRecentInput; }).length,
        imgChanges: imgChanges.length
      };
    });
    return segments;
  }

  /** 渲染人读摘要（popup headline 下方的正文）。 */
  function render(report) {
    var lines = [];
    lines.push('visitId=' + (report.visitId || '?') + ' loadSeq=' + (report.loadSeq || '?') + ' 事件=' + (report.events ? report.events.length : 0));
    var segs = report.segments || [];
    segs.forEach(function (s) {
      lines.push(s.action + '  api页=' + JSON.stringify(s.apiPages) + '  位移=' + s.shiftCount + '(含输入' + s.shiftWithInput + ',Σ' + s.shiftValue.toFixed(4) + ')  img变化=' + s.imgChanges);
    });
    var fnCalls = {};
    (report.events || []).forEach(function (e) {
      if (e && e.kind === 'fn-call' && e.fn) fnCalls[e.fn] = (fnCalls[e.fn] || 0) + 1;
    });
    lines.push('站点函数调用：' + JSON.stringify(fnCalls));
    return lines.join('\n');
  }

  root.m5flash = {
    filenameFor: filenameFor,
    classifyRequests: classifyRequests,
    segmentByActions: segmentByActions,
    render: render
  };
})(typeof self !== 'undefined' ? self : this);
