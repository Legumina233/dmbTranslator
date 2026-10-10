import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `@dmb/*` 是 workspace 内包，其 `exports` **直接指向 `src/*.ts`**（不经构建产物）。
  // vitest 默认会把这些依赖交给 Node 原生加载，而 Node 不认 .ts → 报
  // `Cannot find package '@dmb/model-runtime'`（看着像缺依赖，其实是被绕过了解析）。
  // 用 `ssr.noExternal` 把它们拉进 Vite 自己的 transform 管线，才是对的解法。
  // 不修的话，tests/pipeline/orchestrator.test.ts 等 7 个文件在 import 阶段就死掉
  // （显示 0 test），核心编排逻辑等于零覆盖。
  ssr: {
    noExternal: [/^@dmb\//],
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
