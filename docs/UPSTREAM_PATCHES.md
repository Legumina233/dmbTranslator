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

---

## 2026-10-03 · 删除式简化（回退到 v0.1.4 基线后的第一笔，用户拍板）

> 原则转向：**不再往翻页路径上加东西，改为删**。闪屏的根源 = 翻页路径上叠的机制太多
> （M3 桩探针 + 还原守卫协议 + 落盘读取挡在关键路径上）。

| 删除 | 内容 |
|---|---|
| M3 桩探针接线 | `index.ts` 探针块（72 行）+ `core/scheduler/prefetchWindowProbe.ts`（225 行）+ 其测试（135 行）；注意用户 localStorage 的 `mt-prefetch-probe` 残留已无效果 |
| 还原守卫协议 | `cacheRestoreAttempted` + `releaseRestoreGuard` + sync 卸载释放 + pageshow 释放 → 一个 `cacheWarmStarted` Set 替代 |
| 翻页关键路径上的落盘读取 | `restoreFromCache` 变同步：只查内存 Map；落盘（IndexedDB）改**后台预热**（每会话每页一次，命中后经 applyStateImage 贴图——原图先画、译图后到） |

**翻页路径最终形态**：原生行为 + 内存查一次 Map → 原图画完 → 译图已解码 → 一帧换上。
贴图时机（等原图落定 + decode）唯一出口 = `TranslatorCore.applyStateImage`。
shinobu 提交 `91949a5`（分支 m3-baseline）。

### ✅ 用户真机确认（2026-10-03 深夜）：`91949a5` 状态 = 稳定基线

翻页体验恢复正常（"基本正常"）。此状态锁定为重做预载翻译的起点：
**翻页路径 = 原生行为 + 内存查 Map → 原图画完 → 译图已解码 → 一帧换上**。
重做预载时的纪律（本轮学费换来的）：
① 先插桩测量、再动代码；② 一次只改一处、每步真机验证；③ 主世界只做被动观察，
**任何站点函数调用/劫持前先 toString() 读源码**；④ 每个新机制必须带一键开关和探针判定口径。

### 2026-10-03 · 回退到「03:00 基线」+ 该基线上的奥卡姆审查（shinobu 10edd48）

**回退目标（用户指定「凌晨 3 点 01 分左右提交」）**：外层 `5372955`（10-03 03:00:45，
标题即「用户确认 91949a5 = 稳定基线」）；shinobu `91949a5`（10-03 02:56）。
**注意**：`v0.1.4.1` 指向的 `076056a`（03:18）比该基线**更新** —— 用户要的是基线本身，不是它。

回退前状态全部保全到分支（什么都不丢）：
shinobu `archive/occam-076056a`、`wip/prefetch-runner`；外层 `archive/round3-occam`、`m4-docs-archive`。

**该基线上独立复核出的 3 项多余（逐项自有论证，非照抄）**：

| 项 | 论证 | 连带效果 |
|---|---|---|
| 删 M0 主世界观察尖刺（文件 + manifest MAIN 声明 + 构建第二入口） | 其 postMessage 在正式扩展里**零消费者**；e-hentai 站点全局经真机证实为函数声明、不可重定义 → 主世界脚本无存在理由 | chromium 与 firefox 的 content_scripts 恢复一致（此前 chromium 多挂一条） |
| `minimum_chrome_version` 111 → 109 | 111 是为 MAIN world 抬的，脚本已删就该回落 | 修掉 manifest.test 既有红（断言 109） |
| productionCanary 断言 `'erase'` → `'translate'` + `eraseDebug` | P4 收敛后 processMode 只剩 translate；canary 源码注释已写明「原 processMode='erase' 已移除」—— 是**测试落后于契约**，非产品回归 | 修掉 productionCanary 既有红 |

**全仓 170 文件 / 1403 条全绿**；typecheck 0 错误；架构绿；产物重建（`ehentaiMainWorld.js` 不再产出）。

### 2026-10-03 · 译图缓存「条数上限 + 一键清空」（v0.1.4.100 之后的第一个特性）

**需求**：弹窗「加载模型 / 卸载模型」两个按钮下方加一行「译图缓存」——
能设置本地最多存几张译图（设 3 → 写第 4 张时把最久未用那张删掉），并且有一个删除全部缓存的按钮。

**落点（自底向上五层，每层只加它该加的）**

| 层 | 改动 |
|---|---|
| 设置层 `shared/config.ts` | 新增 `translationCacheLimit`（默认 200、钳在 1..1000，`normalizeTranslationCacheLimit`）。**默认与 `content/core/cache/translationCacheStore.ts` 的 `defaultTranslationCacheLimit` 必须同数**，有测试钉住（两边只改一边就会出现"设置写 200、实际按另一个数淘汰"） |
| 存储契约 `translationCacheStore.ts` | `TranslationCacheStore` 加 `clear()` 与 `trim()`；内存实现与 IndexedDB 实现各补一份。**`trim()` 的存在理由**：淘汰只在 `put` 时发生，上限被调小时**存量不会自己缩** —— 不裁一次的话"设成 3 张"要等译满第 4 张才生效 |
| 协议 `packages/image-pipeline/src/protocol` | 客户端消息加 `cache-clear` / `cache-trim`，`cache-write` 带 `cacheLimit`；宿主消息加 `cache-cleared` / `cache-trimmed`；两处判定函数同步（不同步 = 消息被静默丢弃、功能看着"没接上"却零报错） |
| offscreen 宿主 `pipelineHost.ts` | `translationCacheLimit` 可变，**变了就重建落盘存储**；处理两个新消息 |
| background `offscreenBroker` | `resolveClientCacheMessage()` 在转发时注入 `cacheLimit`（settings 只在 background）；新增 `clearTranslationCache()` / `trimTranslationCache()`，用**自己的 requestId + Promise 等待表**拿结果（不是走内容脚本那条 Port 路由），宿主断开时立刻 reject —— 绝不让按钮一直转圈 |
| 后台消息 / 弹窗 | 新增 `mt:translation-cache`（action = trim / clear）走 `routeBackgroundMessage`；弹窗 `LocalModelControl` 下方新增 `TranslationCacheControl`（数字输入用草稿态，失焦或回车才提交；显示"当前 N 张"；「删除全部译图」按钮） |

**为什么清空不能直接由弹窗删 IndexedDB**：库在 offscreen 文档的扩展 origin 下
（内容脚本里开库会落到站点 origin，会被站点清掉），弹窗读不到也删不掉 —— 必须回到宿主那里做。

**验证**：170 文件 / **1411 条全绿**（新增 8 条：上限钳制 3 条 + 存储 clear/trim 3 条 + 路由 1 条 + 「上限 3 写第 4 张」1 条）；
typecheck 仅剩 4 条**既有**测试类型错误（`pageScheduler` ×1、`retarget` ×2、`pipelineContext` ×1 —— 干净树上同样红，属测量/工具层，登记不修）；
架构绿；chromium 与 firefox 产物均已重建并核对标记。

**已知留白（如实记）**：IndexedDB 适配层的 `clear` / `trim` 没有离线测试（仓库无 `fake-indexeddb` 依赖），
策略层已由内存参照实现钉死，IDB 那一侧靠真机验。

**UI 修订（用户真机反馈，同日）**：第一版把「删除全部译图」做成了独占一行的全宽按钮，太占地。
改为一行收纳：`译图缓存 [64px 数字框] 张 | 现存 N 张 | [删除全部]`（行内小按钮，悬停才变红——
清空是破坏性操作，红色要出现在"手指已经伸过去"的那一刻）；操作结果反馈只在有话要说时出现。

**UI 修订 2（同日）**：输入框仍被撑满整行 —— 根因是全局规则
`.panel input[type='number'] { width: 100% }`（特异性 0-2-1）压过了单类名 `.cache-limit-input`（0-1-0）。
用 `.panel input[type='number'].cache-limit-input`（0-3-1）压回 64px，不引 `!important`。
shinobu `f4c5b9c`。
