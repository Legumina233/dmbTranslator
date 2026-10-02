// m5-flashdiag 探针自检（离线，node tools/selftest.cjs）
// 纪律：自检 + 反向验证 —— 破坏输入 → 必须红或如实降级，不许静默通过。
'use strict';
const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS', name); }
  catch (e) { failures += 1; console.log('  FAIL', name, '——', e.message); }
}
function expect(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }

// 载入 core.js（挂到 self 上 —— node 里用全局对象顶替）
global.self = global;
require(path.join(__dirname, '..', 'core.js'));
const core = global.self.m5flash;

console.log('== filenameFor ==');
check('正常主机名 → dmb-probe 子目录 + 时间戳', () => {
  const f = core.filenameFor('exhentai.org', Date.UTC(2026, 9, 3, 12, 0, 0));
  expect(f.startsWith('dmb-probe/m5-flashdiag-exhentai.org-'), f);
  expect(f.endsWith('.json'), f);
});
check('反向：恶意主机名字符被剥离（不许产生路径穿越）', () => {
  const f = core.filenameFor('../../evil host', Date.UTC(2026, 9, 3));
  expect(!f.includes('..') && !f.includes(' ') && f.includes('evilhost'), f);
  expect(f.startsWith('dmb-probe/m5-flashdiag-'), f);
});
check('反向：空主机名不抛错', () => {
  const f = core.filenameFor('', Date.UTC(2026, 9, 3));
  expect(f.includes('unknown'), f);
});

console.log('== segmentByActions ==');
check('按动作切段：段内聚合 api 页号 / 位移 / img 变化', () => {
  const events = [
    { kind: 'probe-ready', ts: 1000 },
    { kind: 'user-key', ts: 2000, key: 'ArrowRight' },
    { kind: 'fn-call', ts: 2050, fn: 'apply_json_state' },
    { kind: 'layout-shift', ts: 2100, value: 0.5, hadRecentInput: true },
    { kind: 'img-src', ts: 2200, from: 'a', to: 'b' },
    { kind: 'user-key', ts: 5000, key: 'ArrowRight' },
    { kind: 'layout-shift', ts: 5200, value: 0.1, hadRecentInput: false },
    { kind: 'img-src', ts: 5300, from: 'b', to: 'c' }
  ];
  const requests = [
    { ts: 2060, page: 6, url: 'https://s.exhentai.org/api.php' },
    { ts: 2400, page: 7, url: 'https://s.exhentai.org/api.php' },
    { ts: 2401, page: 8, url: 'https://s.exhentai.org/api.php' }
  ];
  const segs = core.segmentByActions(events, requests);
  expect(segs.length === 2, '应有两段：' + segs.length);
  expect(segs[0].apiPages.includes(6) && segs[0].apiPages.includes(7) && segs[0].apiPages.includes(8), JSON.stringify(segs[0].apiPages));
  expect(segs[0].shiftCount === 1 && segs[0].shiftWithInput === 1, JSON.stringify(segs[0]));
  expect(segs[1].imgChanges === 1, JSON.stringify(segs[1]));
});
check('反向：空事件 / 空请求 → 空段，不抛错', () => {
  const segs = core.segmentByActions([], []);
  expect(Array.isArray(segs) && segs.length === 0, '应为空数组');
});
check('反向：畸形事件（缺 kind/ts）不抛错', () => {
  const segs = core.segmentByActions([null, {}, { kind: 'user-key' }, { ts: 1 }], [{}, null]);
  expect(Array.isArray(segs), '应返回数组');
});

console.log('== render ==');
check('render 输出含 visitId / 站点函数计数', () => {
  const text = core.render({
    visitId: 'abc', loadSeq: 2,
    events: [{ kind: 'fn-call', fn: 'load_image' }, { kind: 'fn-call', fn: 'load_image' }],
    segments: []
  });
  expect(text.includes('visitId=abc'), text);
  expect(text.includes('load_image'), text);
});
check('反向：空报告 render 不抛错', () => {
  const text = core.render({});
  expect(typeof text === 'string' && text.length > 0, '应有输出');
});

console.log('== 产物语法（node --check 全部探针 JS）==');
check('四个 JS 文件语法通过', () => {
  const dir = path.join(__dirname, '..');
  ['content-main.js', 'content-isolated.js', 'background.js', 'popup.js', 'core.js'].forEach((f) => {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    new Function(code.replace(/^\/\*[\s\S]*?\*\//, '')); // 粗语法校验（不执行）
  });
});

console.log(failures === 0 ? '\n自检全绿' : `\n${failures} 项 FAIL`);
process.exit(failures === 0 ? 0 : 1);
