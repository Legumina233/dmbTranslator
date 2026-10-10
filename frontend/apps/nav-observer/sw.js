/**
 * 翻页重载观测器 · 后台（MV3 service worker）。
 *
 * 职责单一条：把 content 侧上报的事件攒在 `chrome.storage.session` 里，
 * 供 popup 读取 / 导出。
 *
 * 为什么用 storage.session 而不是内存数组：MV3 的 service worker 随时被回收，
 * 内存数组活不过一次闲置；storage.session 是**会话级**的，service worker 重启后仍在，
 * 关掉浏览器就清空 —— 正好是"一次阅读会话"的尺度。
 */

'use strict';

var KEY = 'navEvents';
var MAX_EVENTS = 2000;

chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.type === 'navObserve' && msg.event) {
    // 补一个 tabId：多标签同时开着时，事件会混在一条时间线上，
    // 没有这个字段就分不清"哪个页面"发生了重建。
    var tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    var event = msg.event;
    event.tabId = tabId;
    if (sender && sender.tab && typeof sender.tab.url === 'string') {
      event.tabUrl = sender.tab.url;
    }
    void append(event).then(function () {
      reply({ ok: true });
    }, function () {
      reply({ ok: false });
    });
    // 异步 reply：告诉 Chrome 我们会回。
    return true;
  }

  if (msg.type === 'navGet') {
    void readAll().then(function (list) {
      reply({ ok: true, events: list });
    }, function (err) {
      reply({ ok: false, error: String(err) });
    });
    return true;
  }

  if (msg.type === 'navClear') {
    void chrome.storage.session.set({}).then(function () {
      reply({ ok: true, removed: true });
    }, function (err) {
      reply({ ok: false, error: String(err) });
    });
    return true;
  }

  return undefined;
});

function readAll() {
  return new Promise(function (resolve, reject) {
    chrome.storage.session.get(KEY, function (bag) {
      var err = chrome.runtime.lastError;
      if (err && err.message) return reject(err.message);
      resolve(Array.isArray(bag[KEY]) ? bag[KEY] : []);
    });
  });
}

function append(event) {
  return readAll().then(function (list) {
    list.push(event);
    if (list.length > MAX_EVENTS) list = list.slice(list.length - MAX_EVENTS);
    return new Promise(function (resolve, reject) {
      chrome.storage.session.set({ [KEY]: list }, function () {
        var err = chrome.runtime.lastError;
        if (err && err.message) reject(err.message);
        else resolve();
      });
    });
  });
}
