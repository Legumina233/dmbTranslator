# 对上游 ShinobuTranslator 的改动记录与归属边界

> 本文档最后更新：2026-10-09（仓库结构整理后）
> 本文合并原 `UPSTREAM_PATCHES.md` 全部内容 + 新增"归属声明"与"可执行对账方法"。

---

## 〇、上游是谁 / pin 到什么 / 许可证义务

- **上游**：`DonutShinobu/ShinobuTranslator`（https://github.com/DonutShinobu/ShinobuTranslator）。
- **pin**：commit **`a5af759`**（v0.8.3）。pin 标记文件 `.upstream@a5af759` 放在**项目根**（`E:/AI/dmbTranslatorV2/`）。
- **落在哪**：上游 fork 现在位于 `frontend/`（原 `shinobu/` 改名而来）。
  它的内嵌 `.git` 已被删除，作为普通子目录纳入主仓库 —— **历史备份为 git bundle**（见 §二）。
- **许可证**：上游为 **GPL-3.0**。fork 与派生物同为 GPL-3.0。义务：
  1. **保留版权声明与许可证全文**（`frontend/LICENSE`、`frontend/NOTICE` 原样保留；仓库根 `LICENSE` 为 GPL-3.0）；
  2. **标注修改** —— 本文件即该标注（逐接触点登记，见 §三、§四、§五）；
  3. 分发时提供完整对应源码（本仓库即对应源码）。
- **原则（来自手册 §4.2）**：**改动只允许落在少数几个"接触点"，不许到处撒。**

---

## 一、当前改动面

### 1.1 快照（2026-10-01，当时 shinobu 自带 `.git`）

> ⚠️ 这是 **2026-10-01 当时的快照**，此后累计了 M0–M4 等大量改动。此处保留以存史。

```
 apps/extension/src/popup/App.tsx                   | 496 ++++---------
 apps/extension/src/shared/config.ts                |  13 +-
 packages/image-pipeline/src/index.ts               |  14 +-
 packages/image-pipeline/src/pipeline/orchestrator.ts |  27 +-
 packages/image-pipeline/src/protocol/index.ts      |   4 +-
 packages/shared-config/src/index.ts                |   5 +-
 packages/text-translation/src/contracts.ts         |  11 +-
 packages/text-translation/src/translator.ts       | 218 ++++-----
 packages/text-translation/src/translators/transport.ts | 23 +-
 apps/web/src/{App.tsx, runtime/productionCanary.ts, runtime/webPipelineConfig.ts} | 14 +-
 benchmark/perf/src/run-browser-*.ts (4 个)          |  31 +-
 tests/**（11 个文件）                                |  66 +-
 已删除: packages/text-translation/src/translators/googleWeb.ts (66 行)
 新增:   apps/extension/src/popup/LocalModelControl.tsx
         apps/extension/src/popup/SelectControl.tsx   ← 从 App.tsx 抽出复用
```

净变化 **+301 / −617**（净减 316 行；`package-lock.json` 的无关 churn 已回退）。

### 1.2 相对基线（`a5af759`）的累计改动（截至 v0.5.4）

```
112 files changed, 7116 insertions(+), 1128 deletions(-)
```

分布：`apps/extension/src` **126 个文件里改动 71 个**；`packages/` **101 个文件里改动 32 个**。

---

## 二、如何对账（可执行的正确版本）

### 2.1 为什么不能再用原来的命令

原文档写的是 `git -C shinobu diff --ignore-cr-at-eol --stat`（在 fork 自带的 `.git` 里比工作树与 pin 基线）。
**`frontend/.git` 已删除** —— 现在不能再对 `frontend/` 跑任何 git 命令。正确做法是：
**先恢复一份带 `.git` 的上游参考树（bundle 或重新 clone），再把当前 `frontend/` 叠上去对账。**

### 2.2 恢复上游参考基线（二选一）

```bash
# 方式 A（推荐）：从备份 bundle 恢复 —— 含 --all 的 648 个提交 / 8 分支 / 34 tag
#   bundle 位置：E:/AI/backups/dmbTranslatorV2-shinobu-full-20261009.bundle（81 MB）
git clone E:/AI/backups/dmbTranslatorV2-shinobu-full-20261009.bundle upstream-ref

# 方式 B：从上游 GitHub 重新 clone 一份
git clone https://github.com/DonutShinobu/ShinobuTranslator upstream-ref

# 二者都切到 pin
git -C upstream-ref checkout a5af759
```

> ⚠️ 不要 `git clone` 到仓库内部（避免被主仓库扫描）；放同级目录即可。

### 2.3 与工作区对账（等价于原 `git -C shinobu diff`）

```bash
cd upstream-ref

# 1) 以 pin 为基线建临时分支
git checkout -B _audit a5af759

# 2) 清空工作树里"受版本控制"的基线文件，再把当前 frontend/ 内容盖进来
git ls-files -z | xargs -0 rm -f
cp -a ../dmbTranslatorV2/frontend/. .

# 3) 排除机器产物（node_modules / dist / 缓存，不属源码对账范围）
rm -rf node_modules apps/extension/dist-chromium apps/extension/dist-firefox
find . -type d -name node_modules -prune -exec rm -rf {} +

# 4) 对账 —— ★ 必须带 --ignore-cr-at-eol，否则 CRLF 会让 200+ 文件全是误报
git add -A
git diff --ignore-cr-at-eol --stat a5af759          # 改动面统计
git diff --ignore-cr-at-eol --name-status a5af759   # 逐文件状态（A/M/D，替代原 status --porcelain）
```

> 若只需"累计 diff"（不关心工作区未提交状态），也可直接从 bundle 里比两个 ref：
> `git -C upstream-ref diff --ignore-cr-at-eol --stat a5af759 <你的分支/tag>`。

### 2.4 bundle 说明

- 路径：`E:/AI/backups/dmbTranslatorV2-shinobu-full-20261009.bundle`
- 大小：81 MB；内容：`--all`（648 个提交 / 8 分支 / 34 tag）。
- 用途：`frontend/.git` 删除前的**完整历史备份** —— 既是对账基线来源，也是本 fork 历史的唯一留存。

---

## 三、归属声明（哪些是上游的，哪些是我们的）

本项目在"**尽量不改上游**"的前提下做了三件事：**原样复用上游机制、在少数接触点改造、纯新增自有能力**。
边界如下（数据截至 v0.5.4，相对基线 `a5af759`：`112 files changed, 7116 insertions(+), 1128 deletions(-)`）。

**一、上游原样复用（未改或几乎未改）**
`frontend/packages/` 与 `apps/extension/src` 的绝大多数文件未动 —— `packages/` 101 个文件里只动了 32 个，
`apps/extension/src` 126 个文件里只动了 71 个。整块沿用的能力包括：**图像管线**（检测 / 气泡 / 消字 / 排版，
`packages/image-pipeline`，其中排版引擎是硬活）、**站点适配器**（ehentai / pixiv / twitter）、
**readerEngine 注册表**（20 余个）、**OCR provider 注册表**、**消息契约类型**
（`MessageOf/SuccessOf/PayloadOf`）、`ModelRuntime` / `PipelineHostLifecycle` 的多实现骨架、上游 vitest 套件。
`apps/web/**` 是上游另一个 app，不随本产品发布，**原样保留**（删它会破坏与上游对账的能力）。

**二、接触点改造（改了，但集中在少数几处）**
都登记在 §四（P1–P5）与 §五：`popup/App.tsx`（删除式简化 + 模型来源开关）、
`shared/config.ts`（新设置项 + 死字段清理）、`text-translation`（**整体删除谷歌翻译**、收敛 `processMode`）、
`image-pipeline`（`orchestrator` 分支收敛、OCR 接入服务端 provider、接口/协议校验同步）、
`benchmark/perf` 与 `tests/**`（跟进契约变更）。改造纪律：**每处都写清"为什么"，并尽量把改动压回最少文件。**

**三、纯新增（上游没有、本项目自建）**
共 **20 个新文件**：`background/diagnostics/backgroundEventLog.ts`、`background/diagnostics/uncaughtCapture.ts`、
`background/messages/memoryCache.ts`、`background/messages/prefetchConfig.ts`、
`content/core/overlay/translatedImageOverlay.ts`、`content/core/scheduler/pageScheduler.ts`、
`content/core/scheduler/prefetchChain.ts`、`content/core/scheduler/prefetchExecutor.ts`、
`content/core/scheduler/showpageClient.ts`、`content/core/state/pipelineContext.ts`、
`content/core/telemetry/contentEventLog.ts`、`offscreen/pipelineTelemetry.ts`、
`popup/LocalModelControl.tsx`、`popup/SelectControl.tsx`、`shared/eventLog.ts`、`shared/eventLogSink.ts`、
`shared/localServiceClient.ts`、`shared/supportBundle.ts`、`shared/toolbarIcon.ts`、
`packages/image-pipeline/src/pipeline/ocr/serverMangaOcrProvider.ts`。
其中 **e-hentai 预取链**（`prefetchChain`/`showpageClient`/`prefetchExecutor`）是**唯一"另起一套"且确属核心需求**的能力
—— 上游没有对应实现。此外，**本机服务 `server/` 的 21 个文件全部原创**（不属于上游 fork，是独立子目录）。

> 一句话：**骨架是上游的，改造集中在少数接触点，新增集中在"预取 + 日志 + 本机服务"三条线上。**

---

## 四、接触点登记（P1–P5）

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
> 而且是现在**唯一**能跳过翻译的路径。原来靠 `processMode='erase'` 的那条路，现在等价地走 `eraseDebug: true`。

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

> ★ 原写的「**没有改** `packages/` 下任何文件。**没有改** manifest」**只针对 P2/P4 那一轮**：
> P4 自身确实没动 `packages/`、没动 manifest。但 P3 起就已改过 `packages/`（见 §1.1），
> manifest 后来也改了 —— 扩展加了 `nativeMessaging` 权限（`apps/extension/manifest.ts`）；
> `host_permissions` 本就是 `<all_urls>`，popup 直接 fetch `http://127.0.0.1:11436` 合法。

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

**审查中被我自己推翻的一条不成立结论**：曾认为新增 `useEffect` 位置偏离文件 hook 约定 —— 实为误判，
`App.tsx:1062` 本就有 effect 夹在 handler 之间，该文件允许就近放置。已撤回。

**刻意不做（附理由）**：
- **不删 `translator` 字段**。它仍是持久化设置 + 诊断记录 + 协议的一部分；删字段是设置 schema 迁移，需动 ~15 个 fixture，
  并会级联改动 `Pick<>` 签名与调用点。现状保留字段 + 保留其守卫是自洽的最小态。
- **不删 `App.tsx` 里 `{settings.translator === 'llm' ? …}` 包裹层**。同上，与保留字段自洽；删它要连带 470 行去缩进，收益为负。

**默认值策略**：不预设任何"看起来能用"的配置。本地侧 `customBaseUrl` / `modelCustom` 留空、下拉显示「请选择模型」；
在线侧沿用上游默认（deepseek + 预设模型 + 空 Key），由 `validateSettings`（`translationConfiguration.ts:98` 消费）给出
「LLM 模式需要填写 API Key」等提示。

### 使用方式

1. `chrome://extensions` → 加载已解压的扩展程序 → `frontend/apps/extension/dist-chromium`
2. 打开 popup → 「大模型配置」→ **模型来源** 选 **本地模型**
3. Base URL / 模型名称只读显示，下面就是模型下拉 + **加载模型 / 卸载模型** + 驻留显存
4. 切到 **在线模型** 则回到原来的提供商 / 模型 / API Key 配置

> ⚠️ 加载模型时会**先自动卸载其它驻留模型**（16 GB 显存装不下两个），
> 保证任意时刻只有一个模型在显存里。返回的 `unloaded` 字段会说明卸掉了谁。

### 待办（尚未接入的接触点）

| # | 接触点 | 内容 |
|---|---|---|
| ① | `packages/image-pipeline` 的 `OcrProvider` | `mangaocrProvider`（v1 已写好，待搬入）+ 5 处枚举 |
| ② | `SiteAdapter` 的阅读方法 | e-hentai 主世界桥（Phase 5，探针已定案） |
| ③ | 设置模型 | `AppSettings` 收敛为判别联合；`targetLang` 固定 `zh-CHS` |
| — | 删除谷歌翻译 | 约 80 行（手册 §2.2）—— 已完成（P3） |

---

## 五、2026-10-03 起的简化与特性记录（逐条登记）

### 5.1 删除式简化（回退到 v0.1.4 基线后的第一笔，用户拍板）

> 原则转向：**不再往翻页路径上加东西，改为删**。闪屏的根源 = 翻页路径上叠的机制太多
> （M3 桩探针 + 还原守卫协议 + 落盘读取挡在关键路径上）。

| 删除 | 内容 |
|---|---|
| M3 桩探针接线 | `index.ts` 探针块（72 行）+ `core/scheduler/prefetchWindowProbe.ts`（225 行）+ 其测试（135 行）；注意用户 localStorage 的 `mt-prefetch-probe` 残留已无效果 |
| 还原守卫协议 | `cacheRestoreAttempted` + `releaseRestoreGuard` + sync 卸载释放 + pageshow 释放 → 一个 `cacheWarmStarted` Set 替代 |
| 翻页关键路径上的落盘读取 | `restoreFromCache` 变同步：只查内存 Map；落盘（IndexedDB）改**后台预热**（每会话每页一次，命中后经 `applyStateImage` 贴图 —— 原图先画、译图后到） |

**翻页路径最终形态**：原生行为 + 内存查一次 Map → 原图画完 → 译图已解码 → 一帧换上。
贴图时机（等原图落定 + decode）唯一出口 = `TranslatorCore.applyStateImage`。

### 5.2 ✅ 用户真机确认（2026-10-03 深夜）：`91949a5` 状态 = 稳定基线

翻页体验恢复正常（"基本正常"）。此状态锁定为重做预载翻译的起点。
**重做预载时的纪律（本轮学费换来的）**：① 先插桩测量、再动代码；② 一次只改一处、每步真机验证；
③ 主世界只做被动观察，**任何站点函数调用/劫持前先 `toString()` 读源码**；④ 每个新机制必须带一键开关和探针判定口径。

### 5.3 回退到「03:00 基线」+ 该基线上的奥卡姆审查

**回退目标（用户指定「凌晨 3 点 01 分左右提交」）**：外层 `5372955`（10-03 03:00:45，
标题即「用户确认 91949a5 = 稳定基线」）；扩展侧 `91949a5`（10-03 02:56）。
**注意**：`v0.1.4.1` 指向的 `076056a`（03:18）比该基线**更新** —— 用户要的是基线本身，不是它。

回退前状态全部保全到分支（什么都不丢）：`archive/occam-076056a`、`wip/prefetch-runner`、
`archive/round3-occam`、`m4-docs-archive`。

**该基线上独立复核出的 3 项多余（逐项自有论证，非照抄）**：

| 项 | 论证 | 连带效果 |
|---|---|---|
| 删 M0 主世界观察尖刺（文件 + manifest MAIN 声明 + 构建第二入口） | 其 postMessage 在正式扩展里**零消费者**；e-hentai 站点全局经真机证实为函数声明、不可重定义 → 主世界脚本无存在理由 | chromium 与 firefox 的 content_scripts 恢复一致 |
| `minimum_chrome_version` 111 → 109 | 111 是为 MAIN world 抬的，脚本已删就该回落 | 修掉 manifest.test 既有红（断言 109） |
| productionCanary 断言 `'erase'` → `'translate'` + `eraseDebug` | P4 收敛后 processMode 只剩 translate | 修掉 productionCanary 既有红 |

**全仓 170 文件 / 1403 条全绿**；typecheck 0 错误；架构绿；产物重建（`ehentaiMainWorld.js` 不再产出）。

### 5.4 译图缓存「条数上限 + 一键清空」

**需求**：弹窗「加载模型 / 卸载模型」两个按钮下方加一行「译图缓存」——
能设置本地最多存几张译图（设 3 → 写第 4 张时把最久未用那张删掉），并且有一个删除全部缓存的按钮。

**落点（自底向上五层，每层只加它该加的）**

| 层 | 改动 |
|---|---|
| 设置层 `shared/config.ts` | 新增 `translationCacheLimit`（默认 200、钳在 1..1000，`normalizeTranslationCacheLimit`）。**默认与 `content/core/cache/translationCacheStore.ts` 的 `defaultTranslationCacheLimit` 必须同数**，有测试钉住 |
| 存储契约 `translationCacheStore.ts` | `TranslationCacheStore` 加 `clear()` 与 `trim()`；内存实现与 IndexedDB 实现各补一份。**`trim()` 的存在理由**：淘汰只在 `put` 时发生，上限被调小时**存量不会自己缩** |
| 协议 `packages/image-pipeline/src/protocol` | 客户端消息加 `cache-clear` / `cache-trim`，`cache-write` 带 `cacheLimit`；宿主消息加 `cache-cleared` / `cache-trimmed`；两处判定函数同步（不同步 = 消息被静默丢弃） |
| offscreen 宿主 `pipelineHost.ts` | `translationCacheLimit` 可变，**变了就重建落盘存储**；处理两个新消息 |
| background `offscreenBroker` | `resolveClientCacheMessage()` 转发时注入 `cacheLimit`；新增 `clearTranslationCache()` / `trimTranslationCache()`，用**自己的 requestId + Promise 等待表**拿结果，宿主断开时立刻 reject |
| 后台消息 / 弹窗 | 新增 `mt:translation-cache`（action = trim / clear）；弹窗新增 `TranslationCacheControl` |

**为什么清空不能直接由弹窗删 IndexedDB**：库在 offscreen 文档的扩展 origin 下
（内容脚本里开库会落到站点 origin，会被站点清掉），弹窗读不到也删不掉 —— 必须回到宿主那里做。

**已知留白（如实记）**：IndexedDB 适配层的 `clear` / `trim` 没有离线测试（仓库无 `fake-indexeddb` 依赖），
策略层已由内存参照实现钉死，IDB 那一侧靠真机验。

**UI 修订（用户真机反馈，同日）**：第一版把「删除全部译图」做成了独占一行的全宽按钮，太占地。
改为一行收纳：`译图缓存 [64px 数字框] 张 | 现存 N 张 | [删除全部]`（行内小按钮，悬停才变红；
清空是破坏性操作，红色要出现在"手指已经伸过去"的那一刻）。

**UI 修订 2（同日）**：输入框仍被撑满整行 —— 根因是全局规则
`.panel input[type='number'] { width: 100% }`（特异性 0-2-1）压过了单类名 `.cache-limit-input`（0-1-0）。
用 `.panel input[type='number'].cache-limit-input`（0-3-1）压回 64px，不引 `!important`。

> 注：该「磁盘缓存」链路（`mt:translation-cache`）在 v0.5.0 审计中判定**运行时不可达**（无发送方 + 开关 false），
> **已删除**；上表保留为历史记录。现行缓存走内存层 `PhotoStateStore` + `mt:memory-cache`（见 §5.5）。

### 5.5 译图只存内存 + 常驻画框（2026-10-03，用户拍板）

三件事一起做，因为它们是同一个问题的三面：**翻页时"空白 → 出图"那一下**。

**1. 拆掉「等原图」闸门**

被删掉的规则来自 **`5eb38b2`（2026-10-03 02:39）**：`TranslatorCore.applyStateImage` 里
「原图 `load`/`error` 落定前绝不贴译图」。它当时的理由成立 —— 改写站点 `<img>` 的 `src`
会顶掉正在加载的原图，于是"先空白再出图"（v0.1.4 起翻回已译页必闪的机理）。
**前提现在不成立了**：画框模式下我们根本不碰站点 `<img>`；预解码（`new Image()` + `decode()`）保留，
只是不再当闸门用。

**2. 常驻画框（新增 `content/core/overlay/translatedImageOverlay.ts`）**

站点 `<img>` 的 `src` **永不被改写**。译图画在我们自己的一张常驻 `<img>` 上：

- 挂在 `document.body`，**不挂站点容器** → 站点重建图片 DOM 也动不到它（这是"常驻"的全部意义）；
- 绝对定位，位置按站点图 `getBoundingClientRect()` 换算（用 `offsetParent` 的矩形做原点，
  不假设 body 在文档原点），跟随 `resize` + `ResizeObserver`；
- `pointer-events:none` → 站点"点图片翻下一页"的交互照旧；
- **不省原本的请求**：站点自己的原图请求照发不误，我们只是不等它（省请求是 M4 的事）；
- 站点 `SiteAdapter` 新增可选 `applyOverlayImage(target, url | null)`，`url === null` = 隐身让原图露出。
  存在此方法即视为已接管贴图，不再走改 `src` 那条路（其它站点行为不变）。
- 浮层按钮层级从 `z-index:20` 提到 `2147483001` —— 画框是 `2147483000` 且盖住整张图，
  不抬按钮就会被画框盖住。

**3. 译图落盘暂时关闭**

`localPipelineClient.ts` 加单一开关 `TRANSLATION_CACHE_PERSISTENCE_ENABLED = false`：
**读一律 miss、写一律 `false`**。读写两个关口都在这一处，恢复只改这一个常量。
动机：最初要的只是"翻回去不用重译"，不是"重启浏览器后还在"；落盘那条跨进程链路
（内容脚本 → 后台 → offscreen → IndexedDB）在翻页时反而是负担。

**因此缓存管理改走另一条路**：弹窗 → 后台 → `chrome.tabs.sendMessage` → 内容脚本，
新增 `mt:memory-cache`（`status` / `limit` / `clear`）直接操作 `PhotoStateStore`。
`MemoryCacheResult.reached` 用来区分"没连上内容脚本"和"缓存确实是空的" —— 弹窗在 `reached:false` 时显示"未连接"，**不显示 0**。

**内存层的占用口径**：`PhotoStateStore` **按条数管，不按字节**（一张译图一条，每张一条 blob URL + 一份解码位图）。
新增 `size()` / `limit()` / `setLimit()` / `clear()`；`setLimit` 调小**立刻裁**（淘汰只在写入时发生）。
UI 的"译图缓存 N 张"现在管的是**内存条数**，显示 `现存 / 上限`。

**已知留白（如实记）**：
- 画框用**假 DOM** 做单测（测试环境是 node，无 jsdom）；真实浏览器下的对位/层级/缩放需真机验。
- 新开的页面用的是默认上限 200，弹窗打开时会把设置里的上限**推一次**给当前标签页（内容脚本拿不到 settings）。
- 清空后当前页会重新 `ensure` 出一条空状态，条数显示 1（那是"槽位"，不是译图）。

### 5.6 新增自有能力（纯新增，登记）

- **e-hentai 预取链**：`content/core/scheduler/{prefetchChain,showpageClient,prefetchExecutor}.ts`
  —— 本项目唯一"另起一套"的核心能力（上游无对应实现）。
- **常驻画框**：`content/core/overlay/translatedImageOverlay.ts`。
- **诊断/日志**：`background/diagnostics/{uncaughtCapture,backgroundEventLog}.ts`、
  `content/core/telemetry/contentEventLog.ts`、`offscreen/pipelineTelemetry.ts`、
  `shared/{eventLog,eventLogSink,supportBundle}.ts` —— 详见 `docs/CHANGELOG.md` §二。
- **本机服务**：`server/` 全部 21 个文件（不属上游 fork）。
