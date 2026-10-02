# 对上游 ShinobuTranslator 的改动记录

> 上游 pin：`DonutShinobu/ShinobuTranslator` @ `a5af759`（v0.8.3），放在 `shinobu/`。
> `shinobu/` 自带 `.git`，**对账命令**（必须带 `--ignore-cr-at-eol`，否则 CRLF 会让 200+ 文件全是误报）：
>
> ```
> git -C shinobu diff --ignore-cr-at-eol --stat
> git -C shinobu status --porcelain
> ```
>
> 原则（来自手册 §4.2）：**改动只允许落在少数几个"接触点"，不许到处撒。**

---

## 当前改动面（2026-10-01）

```
 apps/extension/src/popup/App.tsx                   | 496 ++++---------
 apps/extension/src/shared/config.ts                |  13 +-
 packages/image-pipeline/src/index.ts               |  14 +-
 packages/image-pipeline/src/pipeline/orchestrator.ts |  27 +-
 packages/image-pipeline/src/protocol/index.ts      |   4 +-
 packages/shared-config/src/index.ts                |   5 +-
 packages/text-translation/src/contracts.ts         |  11 +-
 packages/text-translation/src/translator.ts        | 218 ++++-----
 packages/text-translation/src/translators/transport.ts | 23 +-
 apps/web/src/{App.tsx, runtime/productionCanary.ts, runtime/webPipelineConfig.ts} | 14 +-
 benchmark/perf/src/run-browser-*.ts (4 个)          |  31 +-
 tests/**（11 个文件）                                |  66 +-
 已删除: packages/text-translation/src/translators/googleWeb.ts (66 行)
 新增:   apps/extension/src/popup/LocalModelControl.tsx
         apps/extension/src/popup/SelectControl.tsx   ← 从 App.tsx 抽出复用
```

净变化 **+301 / −617**（净减 316 行；`package-lock.json` 的无关 churn 已回退）。
`.upstream@a5af759` pin 标记已移出 `shinobu/`，放在项目根。

### P3 · 删除谷歌翻译（整体移除）

| 层 | 改动 |
|---|---|
| 实现 | **删除** `packages/text-translation/src/translators/googleWeb.ts` |
| 传输 | `transport.ts`：去掉 import、`translatePlain` 的两个实现、相关类型再导出 |
| 契约 | `contracts.ts`：删 `PlainTranslationTransportRequest` 与 `translatePlain` 接口；`translator` 收敛为 `'llm'` |
| 翻译器 | `translator.ts`：删 `config.translator === 'google_web'` 分支 |
| 管线 | `image-pipeline/src/index.ts`（类型 + 校验）、`protocol/index.ts`（校验） |
| 扩展 | `shared/config.ts`：默认值 + 归一化（老存档里的 `google_web` 一律归一为 `llm`） |

### P4 · 收敛 `processMode`（「原文 / 去字」两个模式）

| 层 | 改动 |
|---|---|
| 类型 | `shared-config`、`image-pipeline`、扩展 `config.ts`：`ProcessMode` 收敛为 `'translate'` |
| 校验 | `image-pipeline/src/index.ts` + `protocol/index.ts`：只接受 `'translate'` |
| 编排器 | `orchestrator.ts`：删 `processMode === 'erase'` 分支；`shouldSkipTranslate` 改为只看 `config.eraseDebug` |
| 清理 | 随之不再被读取的 `eraseDebugCanvas` 一并删除 |

> ★ **`eraseDebug`（去字调试）完整保留** —— 它本来就是独立配置项（扩展里「去字调试」勾选框），
> 而且是现在**唯一**能跳过翻译的路径。原来靠 `processMode='erase'` 的那条路，
> 现在等价地走 `eraseDebug: true`（编排器里已统一）。

**连带修复**：`apps/web` 的合成自检原先用 `processMode:'erase'` 跳过翻译，
现改为 `toWebPipelineConfig(settings, { eraseDebug: true })`（该函数新增了一个可选的 overrides 参数）。

### P1 · `apps/extension/src/popup/LocalModelControl.tsx`（**新增**）

本地服务（Ollama）模型控制块：模型下拉 + 连接/驻留状态 + **加载/卸载按钮** + "一键填入本地配置"。
调用本地服务的 `/model/status`、`/model/load`、`/model/unload`、`/v1/models`。

解决两个实际痛点：
1. 以前只能"点开始翻译"顺带把模型加载起来，**模型是否已加载对用户不可见**；
2. Ollama 默认静默 5 分钟卸载模型，用户不知道下次翻译为什么又慢了。

### P2 · `apps/extension/src/popup/App.tsx`

**① 删掉三块没用的 UI**

| 删除 | 原内容 | 替代 |
|---|---|---|
| 「翻译设置」整节 | 服务（谷歌翻译 / 大模型） | 固定 `translator='llm'` |
| 同上 | 语言（简体中文 / 繁体中文） | 固定 `targetLang='zh-CHS'` |
| 「模式」整节 | 翻译 / 原文 / 去字 | 固定 `processMode='translate'` |

固定项由一段**自愈 effect** 兜底（老存档里可能是别的值，装载后自动改一次，用 ref 保证只跑一次）。
删掉的 `IconTranslate` / `IconMode` / `showLocalPipelineOptions` 一并清理，避免 `noUnusedLocals` 报错。

> 快捷命令提示（截图翻译 `Alt+Q` / 翻译悬停元素 `Alt+W`）原来挂在「翻译设置」标题上，
> 已**移到「大模型配置」标题**，功能不丢。

**② 「大模型配置」新增「模型来源」分段开关**

```
模型来源   [ 在线模型 | 本地模型 ]

在线模型 →  LLM 提供商（deepseek / kimi / mimo / openai / gemini / …）+ 模型 + 认证 + API Key
本地模型 →  Base URL（只读）+ 模型名称（只读）+ 本地模型控制（下拉 / 状态 / 加载 / 卸载）
            API Key 自动填占位符「local」，不发往任何云端
```

> ★ **「模型来源」不新增存储字段** —— 它是 `llmProvider === 'custom' && isLocalBase(customBaseUrl)`
> 的派生结果（手册 §3.4：派生的一律不存）。切到本地 = 写 `llmProvider='custom'` + 本机 Base URL；
> 切回在线 = 恢复到一个内置提供商（取内置目录第一项，即 `deepseek`）。

**没有改** `packages/` 下任何文件。**没有改** manifest（`host_permissions` 本就是 `<all_urls>`，
popup 直接 fetch `http://127.0.0.1:11436` 合法）。

### P5 · 只读审查后的修复轮

对 P2–P4 做了一轮严格代码审查，修掉的问题（按严重度）：

| 级别 | 问题 | 处理 |
|---|---|---|
| 阻塞 | `benchmark/perf/run-browser-paddle-profile.ts` 仍传 `translator: "google_web"`（裸字面量，tsc 查不出）→ 运行期被 `isValidPipelineConfig` 拒 | 改 `"llm"` |
| 阻塞 | `App.tsx` 里 `LocalModelControl` 被渲染两次（旧插入未清理），"在线模型 + 自定义提供商"下冒出本地模型块 | 删除重复渲染 |
| 重要 | `translator.ts` 收窄后 `if (config.translator === 'llm')` 恒真，尾部回退循环不可达 | 去外壳 + 删死尾（294→282 行） |
| 重要 | `orchestrator.ts` 把 `eraseDebug` 的底图从原图改成去字图、并跳过排版 —— 属超范围重写 | 定案为单一路径，底图取原图；`buildEraseDebugCanvas` 只为一个调用方的 `baseCanvas` 死参数一并删除；**补测试**覆盖 `eraseDebug + debugLayers` |
| 重要 | `package-lock.json` 的 `libc` 字段被 npm 重写（无关变更） | 回退 |
| 重要 | `webConfig.test.ts` 把输入 `'erase'` 改成 `'translate'`，丢掉了真实迁移断言 | 输入恢复 `'erase'`，断言归一为 `'translate'` |
| 次要 | `Object.keys(llmBuiltInProviderDefinitions)[0]` 依赖对象顺序 | 改用 `defaultExtensionSettings.llmProvider` |
| 次要 | `toWebPipelineConfig` 为单一调用方新增 `overrides` 形参 | 删除该形参，canary 改为 `{ ...toWebPipelineConfig(settings), eraseDebug: true }` |
| 次要 | `LocalModelControl` 全内联样式 + 自写原生 `<select>` | **把 `SelectControl` 从 App.tsx 抽成 `popup/SelectControl.tsx` 并复用**，样式改用 `styles.css` 的 `.setting-row / .field-label / .auth-status-row / .oauth-*` |
| 次要 | 占位符 API Key 手写三处内部状态 | 改为复用 `updateActiveApiKey()` |
| 次要 | `readOnly disabled` 冗余、本地分支缺"未选择"提示 | 去掉 `readOnly`；下拉首项改为 **「请选择模型」** 占位提示 |
| — | `.upstream@a5af759` 让上游工作区常驻脏状态 | 移到项目根 |

**审查中被我自己推翻的一条不成立结论**：曾认为新增 `useEffect` 位置偏离文件 hook 约定 —— 实为误判，`App.tsx:1062` 本就有 effect 夹在 handler 之间，该文件允许就近放置。已撤回。

**刻意不做（附理由）**：
- **不删 `translator` 字段**。它仍是持久化设置 + 诊断记录 + 协议的一部分；删字段是设置 schema 迁移，需动 ~15 个 fixture，
  并会级联改动 `Pick<>` 签名与调用点。现状保留字段 + 保留其守卫是自洽的最小态（只删了唯一一个"守卫后面挂着不可达代码"的）。
- **不删 `App.tsx` 里 `{settings.translator === 'llm' ? …}` 包裹层**。同上，与保留字段自洽；删它要连带 470 行去缩进，收益为负。

**默认值策略**：不预设任何"看起来能用"的配置。本地侧 `customBaseUrl` / `modelCustom` 留空、下拉显示「请选择模型」；
在线侧沿用上游默认（deepseek + 预设模型 + 空 Key），由 `validateSettings`（`translationConfiguration.ts:98` 消费）给出
「LLM 模式需要填写 API Key」等提示。

## 使用方式

1. `chrome://extensions` → 加载已解压的扩展程序 → `shinobu/apps/extension/dist-chromium`
2. 打开 popup → 「大模型配置」→ **模型来源** 选 **本地模型**
3. Base URL / 模型名称只读显示，下面就是模型下拉 + **加载模型 / 卸载模型** + 驻留显存
4. 切到 **在线模型** 则回到原来的提供商 / 模型 / API Key 配置

> ⚠️ 加载模型时会**先自动卸载其它驻留模型**（16 GB 显存装不下两个），
> 保证任意时刻只有一个模型在显存里。返回的 `unloaded` 字段会说明卸掉了谁。

## 待办（尚未接入的接触点）

| # | 接触点 | 内容 |
|---|---|---|
| ① | `packages/image-pipeline` 的 `OcrProvider` | `mangaocrProvider`（v1 已写好，待搬入）+ 5 处枚举 |
| ② | `SiteAdapter` 的阅读方法 | e-hentai 主世界桥（Phase 5，探针已定案） |
| ③ | 设置模型 | `AppSettings` 收敛为判别联合；`targetLang` 固定 `zh-CHS` |
| — | 删除谷歌翻译 | 约 80 行（手册 §2.2） |
