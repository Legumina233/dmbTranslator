# 贡献指南

先说清楚现状：**本项目目前由个人维护**，是 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的分叉，
尚未建立正式的贡献者许可协议（CLA）。提交 PR 即表示你同意你的贡献以本项目当前许可证
（GPL-3.0）发布。

## 代码阅读顺序

```
apps/extension/src/content/index.ts                        入口
apps/extension/src/content/core/TranslatorCore.ts          页面主流程
packages/image-pipeline/src/pipeline/orchestrator.ts       流水线阶段编排
apps/extension/src/background/localPipeline/offscreenBroker.ts  宿主生命周期
```

## 提交前先确认的三件事

1. **你的改动属于哪一侧？**
   - 浏览器扩展（检测 / 气泡 / 去字 / 排版 / 预取）—— 在 `frontend/`，也就是本目录
   - 本机 Python 服务（`../server`，OCR 与翻译）—— 在仓库根，**不在 npm 工作区里**，
     不走 `npm run check`
2. **不要顺手重构。** 这个仓库有明确的架构边界检查，跨越包边界的 import 会被拦。
3. **涉及模型资产时要格外小心。** 部分模型的许可证状态未决，详见
   `packages/model-manifest/publication-policy.json`。

## 本地环境

- Node.js 24（见 `.node-version`）；仓库用 npm workspaces
- 装依赖：`npm ci`
- 下载模型（约 206 MB，不入库）：`npm run models:download`
- 本机 OCR 服务是 Python 侧组件，扩展单独跑不起来完整链路；只改前端逻辑时不需要它

## 常用命令

```bash
npm run typecheck          # 全工作区类型检查（含 tests 与 benchmark）
npm run test               # vitest 全量
npm run check:architecture # 工作区 import 边界 + 扩展架构边界
npm run check:licenses     # 生产依赖许可证快照比对
npm run build              # 构建扩展（chromium + firefox）
npm run check              # 以上全套 + web 回归 + AMO 元数据 + web 构建
```

`npm run check` 是发布前的完整门禁。它当前在本机可能失败，原因与项目无关：
`scripts/check-release-boundaries.mjs` 用 `process.execPath` 派生 node 自身，
在某些受管环境下会 `EBUSY`。这种情况下可以分步执行上面列出的命令。

## 提交规范

沿用 Conventional Commits，与现有历史一致：

```
feat(scope): 简短说明
fix(scope): 简短说明
refactor(scope): 简短说明
docs(scope): 简短说明
```

scope 用现有约定：`ui` / `content` / `cache` / `scheduler` / `restore` / `log` /
`diag` / `probe` 等。

## 修改设置项时

扩展设置定义在 `apps/extension/src/shared/config.ts`。新增字段必须同时处理：

- 默认值对象
- `sanitize*` 归一化（旧值兼容）
- 下发到 pipeline 的字段（`packages/image-pipeline/src/index.ts` 的白名单与类型校验）
- 如有跨包传递，`packages/image-pipeline/src/protocol/index.ts` 的消息校验

漏掉任何一处都会在类型检查或运行时暴露。

「为什么是现在这个样子」记录在 [docs/DESIGN-NOTES.md](./docs/DESIGN-NOTES.md)，
包括 offscreen 生命周期、双进程拆分、日志双通道等取舍的背景。改动相关模块前建议先读。

## 隐私相关改动

涉及日志、原文 / 译文落盘的改动有额外约束：

- 事件流（通道 A，POST 到本机服务 `/log/events`）与扩展本地诊断日志（通道 B）是
  两条独立通道，不要合并
- 记录原文 / 译文的开关默认必须关闭，且受父开关约束
- 不要在页面 DOM 上写入内部状态（架构检查会拦）

## 报告问题

提 issue 时请附上：浏览器与版本、目标站点、扩展版本（弹窗标题栏可见）、
以及弹窗「导出支持包」得到的文件。
