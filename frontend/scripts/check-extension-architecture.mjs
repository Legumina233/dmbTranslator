import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const scanRoots = [resolve(root, 'apps/extension')];
const sourceExtensions = /\.(?:ts|tsx|js|mjs|html)$/;
const runtimeAdapter = 'apps/extension/src/shared/extensionRuntime.ts';
const schemeAllowlist = new Set([
  runtimeAdapter,
  'apps/extension/src/shared/diagnosticLogClient.ts',
]);
const buildAdapterAllowlist = new Set([
  'apps/extension/manifest.ts',
  'apps/extension/vite.config.ts',
]);

/**
 * 把注释内容擦成等长空白（保留换行与字符数），供正则匹配前预处理。
 *
 * 起因：先前直接对原始源码跑 `chrome.` 等正则，把注释里出现的
 * `chrome.runtime.sendNativeMessage`、`cannot touch chrome.*` 等字样误判为
 * 真实调用（3 条预存违规全部是误伤），导致 `check:architecture` 恒红。
 * 擦除而不是「加白名单绕过」，是为了让检查继续对新增代码生效；
 * 等长替换则保证下面的行号仍然对得上。
 */
function blankComments(source) {
  const chars = Array.from(source);
  const masked = new Array(chars.length).fill(' ');
  const length = chars.length;
  let i = 0;
  while (i < length) {
    const char = chars[i];
    const next = chars[i + 1];
    if (char === '\n') {
      masked[i] = '\n';
      i += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < length && chars[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] !== '\n') masked[i] = ' ';
        i += 1;
      }
      if (i < length) {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      masked[i] = char;
      i += 1;
      while (i < length && chars[i] !== char) {
        if (chars[i] === '\\') {
          masked[i] = chars[i];
          i += 1;
          if (i < length) {
            masked[i] = chars[i];
            i += 1;
          }
          continue;
        }
        masked[i] = chars[i];
        i += 1;
      }
      if (i < length) {
        masked[i] = char;
        i += 1;
      }
      continue;
    }
    masked[i] = char;
    i += 1;
  }
  return masked.join('');
}

function collectFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules'
      || entry.name === 'prototypes'
      || entry.name === 'dist'
      || entry.name.startsWith('dist-')
    ) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collectFiles(path, result);
    else if (entry.isFile() && sourceExtensions.test(entry.name)) result.push(path);
  }
  return result;
}

const failures = [];
for (const path of scanRoots.flatMap((directory) => collectFiles(directory))) {
  const repoPath = relative(root, path).replaceAll('\\', '/');
  const source = blankComments(readFileSync(path, 'utf8'));
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/\b(?:chrome|browser)\s*\./.test(line) && repoPath !== runtimeAdapter) {
      failures.push(`${repoPath}:${index + 1} uses a raw browser namespace`);
    }
    if (/(?:shared\/chrome|ChromeLike|getChromeApi)/.test(line)) {
      failures.push(`${repoPath}:${index + 1} uses the removed Chrome-specific seam`);
    }
    if (/(?:chrome:\/\/|about:addons)/.test(line) && repoPath !== runtimeAdapter) {
      failures.push(`${repoPath}:${index + 1} embeds a browser-internal URL outside the runtime adapter`);
    }
    if (/(?:chrome-extension:|moz-extension:)/.test(line) && !schemeAllowlist.has(repoPath)) {
      failures.push(`${repoPath}:${index + 1} branches on an extension scheme outside the trust adapters`);
    }
    if (/\b(?:isFirefox|isChromium|browserTarget|extensionTarget)\b/.test(line)
      && !buildAdapterAllowlist.has(repoPath)) {
      failures.push(`${repoPath}:${index + 1} contains target detection outside a build adapter`);
    }
  }
}

if (failures.length) {
  throw new Error(`Extension architecture boundary violations:\n${failures.join('\n')}`);
}
console.log('Extension architecture boundaries verified.');
