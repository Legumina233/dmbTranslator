import { resolve } from 'node:path';
import { build } from 'vite';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

const extensionRoot = resolve(import.meta.dirname, '..');
const outputDir = resolve(process.cwd(), readRequiredOption('--out-dir'));

// 只打一个内容脚本入口：隔离世界的 content.js。
// 曾还有主世界的 ehentaiMainWorld.js（world:"MAIN"）—— 随主世界观察尖刺一并删除
// （奥卡姆审查：生产端零消费者）。恢复前请看 docs/UPSTREAM.md。
const contentEntries = [
  {
    entry: 'src/content/index.ts',
    globalName: 'DmbTranslatorContent',
    fileName: () => 'content.js',
  },
];

for (const { entry, globalName, fileName } of contentEntries) {
  await build({
    configFile: false,
    root: extensionRoot,
    publicDir: false,
    build: {
      outDir: outputDir,
      emptyOutDir: false,
      lib: {
        entry: resolve(extensionRoot, entry),
        formats: ['iife'],
        name: globalName,
        fileName,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
}
