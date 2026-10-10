# 变更与决策编年史（CHANGELOG）

> 本文档最后更新：2026-10-09（仓库结构整理后）
> 本文合并原 `交接手册-2026-10-03.md` + `日志体系重构设计-2026-10-05.md` + 三份
> `项目完结代码审计报告-*.md` + `预取优先-施工修订二.md`。
> 每条写清"**做了什么 + 为什么 + 用户拍板的点**"。⚠️ §三·2 的**未修复问题清单**是本文最重要的一段。

---

## 一、时间线（Phase 0 → v0.5.4）

> 全程为**单仓库**：扩展在 `frontend/`，服务端在 `server/`。
> 时间线中的 `shinobu <hash>` 是当时扩展侧（现 `frontend/`）的提交（历史已备份为 bundle，见 `docs/UPSTREAM.md`）。

### Phase 0 · 地基（2026-10-01）

`git init`、`.gitignore`、上游 pin、目录骨架；干净 clone `DonutShinobu/ShinobuTranslator` @ `a5af759`（v0.8.3）；
vendor `manga-ocr`；搬入上游 ONNX 资产（detector / inpaint / bubble / PP-OCRv6）。
**拍板**：上游代码放子目录、本产品全部扩展改动落在这一个 fork 里。

### Phase 1 · 探针定案（2026-10-01）

采到 `dmb-probe-report.json`（17:12，exhentai，6 次翻页，44 个事件），**三问全答**：
主世界能拿到站点全局 ✅、能劫持而不破坏站点 ✅、翻页可短路 ✅。产出 `pageKey` 契约与
showpage 响应结构（详见 `docs/ARCHITECTURE.md` §二）。**探针物验完即删**。
**拍板**：不写 v1 那 330 行的"投影 + 4 分支状态机"。

### 服务端 v2 + 首个里程碑

`server/` 落地（单文件 1543 行拆成 16 个 `.py`）；单图页 `/s/` 悬浮按钮翻译跑通。
修掉 v1 三个静默 P0（日志丢条 / 译文其实是原文 / 记录不写入），做法：消灭全局变量、
失败必抛 `BackendError`、先落盘后响应。

### M0 ~ M3（tag v0.1.1 ~ v0.1.4，2026-10-02）

| 里程碑 | tag | 内容 |
|---|---|---|
| M0 | v0.1.1 | 归档 M0 诊断器 + 交付 M0 页身份探针 + 补齐架构文档 |
| M1 | v0.1.2 | 探针 v2 + 扩展收口修复 + Gate-M1 真机通过 |
| M2 | v0.1.3 | `CacheManager` + 版本化 key + 落盘 + 自动还原 |
| M3 | v0.1.4 | `PageScheduler` + M3 专用探针 |

然后 `v0.1.4.1`（2026-10-03，扩展稳定基线快照）。

### 回退 + 奥卡姆审查（2026-10-03 凌晨）→ v0.1.4.100

**用户要的版本 = 外层 `5372955` / shinobu `91949a5`（03:00 稳定基线），不是 `v0.1.4.1`**
（`v0.1.4.1` 指向的 `076056a`(03:18) 比基线更新）。旧状态全部保全到 `archive/*` 分支。
在该基线上独立复核出 **3 项零消费者代码并删除**（shinobu `10edd48`）：
M0 主世界观察尖刺（文件 + manifest MAIN 声明 + 第二构建入口）、
`minimum_chrome_version` 111 → 109、productionCanary 断言 `'erase'` → `'translate'`。
→ **chromium 与 firefox 的 content_scripts 恢复一致**；全仓 170 文件 / 1403 条全绿；
`ehentaiMainWorld.js` 不再产出。

> **纪律（本轮学费换来，用户拍板）**：① 先插桩测量、再动代码；② 一次只改一处、每步真机验证；
> ③ 主世界只做被动观察，**任何站点函数调用/劫持前先 `toString()` 读源码**；
> ④ 每个新机制必须带一键开关和探针判定口径。
> **真机确认**：`91949a5` = 稳定基线；翻页路径最终形态 = 原生行为 + 内存查 Map → 原图画完 →
> 译图已解码 → 一帧换上（唯一出口 `TranslatorCore.applyStateImage`）。

### v0.1.4.101（2026-10-03）—— 译图缓存条数上限 + 一键清空

弹窗「加载/卸载模型」下方加「译图缓存」行：可设本地最多存几张（设 3 → 写第 4 张时淘汰最久未用），
并有删除全部按钮。落点自底向上五层：设置层 `translationCacheLimit`（默认 200、钳 1..1000）→
存储契约加 `clear()`/`trim()` → 协议加 `cache-clear`/`cache-trim` → offscreen `pipelineHost` →
background `offscreenBroker` + `mt:translation-cache` + 弹窗 `TranslationCacheControl`。

> **为什么清空不能由弹窗直接删 IndexedDB**：库在 offscreen 文档的扩展 origin 下
>（内容脚本里开库会落到站点 origin，会被站点清掉），弹窗读不到也删不掉 —— 必须回到宿主那里做。
> **UI 修订踩坑**：输入框被全局规则 `.panel input[type='number'] { width:100% }`（0-2-1）压过
> 单类名 `.cache-limit-input`（0-1-0）→ 用 `.panel input[type='number'].cache-limit-input`（0-3-1）压回 64px，不引 `!important`。
> **留白**：IndexedDB 适配层的 `clear`/`trim` 无离线测试（仓库无 `fake-indexeddb`），靠真机验。

### v0.2.0（2026-10-03）—— 常驻画框 + 内存译图

**拍板**：三件事一起做（同一个问题的三面 = 翻页"空白→出图"那一下）。
① 拆掉「等原图 load/error 落定」闸门；② 常驻画框 `translatedImageOverlay.ts`（挂 body、绝对定位、
`ResizeObserver` 跟随、`pointer-events:none`、`z=2147483000`，站点 `applyOverlayImage(target, url|null)`）；
③ 译图落盘关闭（`TRANSLATION_CACHE_PERSISTENCE_ENABLED=false`，读写两关口一个常量）。
内存层 `PhotoStateStore` 按条数管（默认 200）；通道 `mt:memory-cache`（popup→background→content），
`reached:false` 显示"未连接"、绝不显示 0。

### M4 施工（2026-10-03，shinobu `0b0214a`）

- **14a**：`prefetchChain` / `showpageClient` / `prefetchExecutor`（均零 import）。直连 api.php；
  showkey 从**内联 `<script>`** 提取（JSON/赋值双形态）；`p` 字段定页键；
  熔断 = 连败×3 且成功 0（成功过一次永不熔断）。
- **14b**：`translateInBackground(key,url)` 返回**任务完成 Promise**（永不 reject）——
  `PageScheduler` 并发恒 1 靠 `await` 它成立，即发即忘会连发整队。
- **14c**：到达恢复（钉子测试：完成即贴 / 内存直贴）。
- **真机**：直连 10/10 全中、showkey 一加载即抓到、active 恒 ≤1。
- **M4 诊断面板回退（16:0x）**：做进了正式 popup → 用户要的是**独立探针扩展** → `git checkout -- .` 整体回退。
  **教训：探针/诊断的惯例 = 独立目录独立扩展（`probe/`），不碰正式版。**
- **按钮 z-index bug（16:5x，shinobu `4b4b49c`）**：按钮祖先 `#i1` 是 `position:relative; z-index:1`，
  按钮被困在该层叠上下文里被画框压死 → **锚点改挂 `document.body`**（与画框同台）+ transform 自定位。

→ **v0.3.0（17:3x）**：M4 完成态定版。

### 设置栈 + M6 阅读栏（`1414eac`）→ v0.4.0

- **设置栈**：`prefetchDepth`（0–10，默认 4，**0=关闭**不是非法值）+ `autoTranslateOnEnter`（默认**关**，
  保留"点按钮才译"现状）+ popup UI + 推送链（popup → `mt:prefetch-config` → background → content
  `applyPrefetchConfig` **同步**调 `chain.setDepth` + `executor.setDepth`，只改一边 = 白花请求）。
  语义澄清：药丸开关**只管当前页**（下界 0/1）；预载 N+1…N+depth 由「预载数量」独立控制。
- **M6 阅读栏**（右下角 «‹N/M›» + showpageNav 解析相邻/首末页，`z-index 2147483002`）。
- **M6 整体移除（`3466fc3`，-799 行）**：用户质疑「不能输页码跳转，和原生导航有何区别」→
  核查发现 `navigate = location.href` 实为**整页重载**（注释自称软导航是错的），会清空内存译图缓存；
  且跳转范围与站点原生 `.sn` 重复。**用户裁定整个砍掉**，相比 v0.3.0 只留设置栈（`onMaybeNavigated` 观察器保留）。

**同批**：错误黑匣子（`8a43a67`）：用户报「后台一直报错但功能正常」。独立探针读不到别家报错
（扩展报错按扩展隔离）→ SW 内置黑匣子 `background/diagnostics/uncaughtCapture.ts`：
全局 `error` + `unhandledrejection` 钩子 → 签名 2s 聚合（repeatCount）→ stack 截 6000 字 →
无条件写 logStore 环形缓冲（2000 条），弹窗「下载日志」导出，**不受 `enableDebugLog` 开关限制**。
以及静默退场防护（`ad489c4`）：定性为 **"Extension context invalidated."**（扩展重载后旧 content script 残留，
`chrome.runtime` 失效）—— **固有现象，非 bug**；防护 = 捕获后静默退场（content 注销 listener + disconnect observer；
offscreen `disposed=true` 不再重连）。

> **偏移取证教训**：报错偏移 `index2.js:8:30947/:8:30694` 重载前后一字不差 → 一度误判"旧代码残留"，
> 实际是改的代码编进了另一个 chunk。**偏移取证前必须先验证该文件这次是否真的变了。**

### v0.4.1（2026-10-04）—— 后台报错清零

承接 v0.4.0 遗留第 1 项。用户真机确认：重启不报、进画廊不报、翻译不报。
**根因**：报错精确落在 `port.onDisconnect.addListener(...)` 这个**注册语句本身** ——
上下文失效后连 `port.onDisconnect` 的**属性访问**都会抛，抛出点在 `addListener(...)` 这层，
写在回调**内部**的 try/catch 接不到。
**修法（共享守卫，可复用）**：`shared/extensionRuntime.ts` 新增
`guardExtensionListener(listener)`（回调层，只吞 invalidated）+ `guardRegistration(register)`
（**注册层**，包在 `addListener(...)` 外面）。接线 background 三处 `onConnect` +
内容脚本 `localPipelineClient.ts` 4 组端口监听器；测试 11 条。
**ORT 日志降噪**：`ort.env.logLevel` 只管 JS 侧，压不住 `[W:onnxruntime:, session_state.cc:1367]`（C++ 侧）→
正解是会话选项 `logSeverityLevel: 3`（常量 `ORT_LOG_SEVERITY_LEVEL`，4 处建会话点已接线）；
去掉 `ort.env.webgpu.powerPreference`（Windows 上 Chrome 忽略并打提示，crbug 369219127）。
**同批（并行会话）**：`f0f59b0` 意图即换图（点击/方向键瞬间内存译图直上画框，省 ~0.5–1s）、
`7c4f0ca` 全局原图/译图显示模式（切一次所有页生效，多图上下文保持每图独立）。
**仍未覆盖（已知）**：`runtime.connect()` 调用（localPipelineClient 3 处）、`background/index.ts` onMessage ×2、
`firefoxPipelineHostLifecycle`、popup/extensionControlClient、lifecycleSelfTest —— 同机理，等真机再报再补。

### v0.4.2（2026-10-04）—— 右下角控制区 + 预取链边缘推进

- **UI**：翻译按钮从"跟随图片矩形"改为 `position:fixed` 贴**视口右下角**（用户要求）——
  改 fixed 后 offsetParent 换算、ResizeObserver、window resize 重算整套作废，删 ~1400 字符；
  `AnchorBinding` 收敛为 `{anchor, target}`。右下角预载开关指向弹窗「进入自动翻译」**同一设置项**
  （状态直接写在按钮上：关 →「关闭」/ 开 →「已预载 x/N」/ 预载数量为 0 →「预载数量为 0」）。
  新增设置通道 `mt:prefetch-config-sync`（不带字段 = 只读；带字段 = 写 settings 并回推
  `mt:prefetch-config`，**不能推 -sync** 否则两边互推死循环）。
- **M4 预取真根因**：计数停在 2/3 不动。根因 = 链是**逐跳接龙**的（请求第 P 页必须持有 P 的 imgkey，
  而 imgkey 只在**前一页** JSON 里），而 `onPageArrived` 里"到达页数据已在手就原地返回"→
  **每翻一页窗口尾部就永久缺一页**。修法 `advanceToWindowEdge()`：到达时从当前页沿**已在手**的 JSON
  逐跳找缺口，遇到第一个未请求页就派发，随后停（零定时器、零多余请求）。测试 7 条。
  失败补救：`showpageClient` 加 15s 硬超时 + `onDispatchFailed`；链 `notifyDispatchFailed`
  把该页从去重集放出并**自动补发一次**；出窗失败不追、成功后迟到失败不计。
- **被裁掉的"诊断装置"**（`2e9136a`，净删 136 行）：缺口原因分类、末页截断分母、`advancing` 标志、
  `requested` 提前计数 —— 都不是需求，且这类观测装置要在"活还在路上"的瞬间判断状态，**天然有竞态**。
  **纪律**：为一个 bug 加的观测代码，bug 修完后要主动清算。

### v0.4.3（2026-10-04）—— OCR 换 manga-ocr、ollama 拆独立服务、删配对

**架构对账版**：把 README 早写明的目标架构真正落地。

- **OCR 改走 `server/` 的 manga-ocr**：新增 `serverMangaOcrProvider`（整行 crop → data URL →
  `POST {base}/ocr` → 按 id 映射回区域；`requiresModelRuntime:false`）。`settings.ocrEngine` 默认改
  `manga_ocr_server`；本地 PaddleOCR provider 保留为备选。**失败显式报错，绝不静默回退本地 ONNX**。
  orchestrator OCR 运行时预热按引擎门控（走服务端就一个会话都不建，原来无条件加载 ~76MB 权重）。
  坑：`ocrServerBaseUrl` 只能从**回环地址**派生（否则会把 OCR 请求发到 `https://api.deepseek.com/ocr`）。
- **ollama 与模型控制拆成独立服务（`server/ollama_server.py`，11437）**：三个进程互不依赖
  （app.py 11436 / ollama_server.py 11437 / ollama 引擎 11434）。`app.py` 删掉全部 `/model/*` 路由
  与启动清显存；扩展模型 UI 与 ollama 探活改指 11437；Native Messaging `target=ollama` 改指该服务；
  关停走它自己的优雅通道 `POST /shutdown`；新脚本 `start_ollama.cmd`/`stop_ollama.cmd`；面板拆两张。
- **删掉整页"配对"机制 + 停写 OCR 归档**（`16b5d5f`，净删 222 行）：实测真机从未生效
  （10-03 211 条 + 10-04 260 条全是 `pairing:none(no pageKey)`）。**翻译侧照旧落一条**，
  OCR 侧不再落归档；`pageKey` 标识保留（扩展页身份与译图缓存键）。
- **UI 三处（用户真机反馈驱动）**：① 两个服务开关不再互相阻塞（`busy` 从 `ServiceKind|null` 改集合
  `busyKinds.has(...)`，单值下两路同操作会互相覆盖）；② 翻译进行中可点 = **终止当前翻译**
  （`cancelableWhileRunning` 能力开关：翻译按钮传 true、**截图 UI 不传**——它的中止只覆盖"任务尚未启动"）；
  **真凶**是 CSS `.mt-x-control[data-status='running'] { pointer-events: none }` 在挡，只去掉 `disabled` 是白改；
  ③ 预载开关关闭文案 `关闭` → `预载关闭`。
- **顺带修真缺陷：OCR 置信度口径**（见 `docs/ARCHITECTURE.md` §4.9）。
- **仍未覆盖**：PP-OCRv6 识别模型（76MB）仍在产物里（被 `models.json`/`models.sha256`/`build-for-amo.mjs` 钉住，
  下架属独立发布变更）；取消翻译时若已有 `/ocr` 请求在飞，会自然跑完再被丢弃（不影响正确性）；
  `binbContent` 像素矩阵还原测试**偶发失败**（单独复跑必过）。

### v0.5.0（2026-10-04）—— 审计收尾版（三轮审计 + 受控清尾）

**不是功能版**。三轮审计（全项目 / 奥卡姆减法 / 从零设计对照）得出同一结论——**架构不需要重写**，
自造复杂度是可枚举的一小簇，本版按其清单清掉了一部分。

**删掉的东西**（每项先 grep 核实无生产调用方）：`scheduler/hostThrottle.ts`（+测试 142 行，完整限流器
**从未接线**）、`cacheManager.ts` 的 `PageCacheManager`（四层内存缓存**从未装配**；保留 `buildPageCacheKey`）、
`pageScheduler.ts` 的 `planPrefetchWindow`/`planCurrentAndPrefetch`（只有测试引用）、
`screenshotOverlay.ts` 的 `freezeScreenshotResultOverlayPosition`（全仓零调用）、
`PhotoState.mode` 字段（+8 处写入，与 `status` 一一对应，纯冗余镜像）、`settings.sourceLang`。
**测试处理**（不牺牲有效覆盖）：`cacheManager.test.ts` 改成只测活函数；`retarget.test.ts` 改用内联
`planFrom()`，保留对 `PageScheduler.retarget` 的全部覆盖；`prefetchWindow.test.ts` 随死函数删除。

**显示模式收敛的真实语义（别误读）**：**没有**删掉"页级显示状态"这个概念 —— 它承载 **per-image 语义**
（twitter 轮播等多图上下文每图独立切换），被 `twitter.test.ts` 钉住。删掉的是它的**重复存储** `PhotoState.mode`；
页级判断现在只读 `status`，全局仍只有**一个** `displayMode`。

**明确不删的**（有真实消费者）：本地 PaddleOCR（ONNX）第二实现（`apps/web` 硬编码 `ocrEngine:'paddleocr_v6_medium'`、
benchmark 默认走它、多个测试钉死模型集合 —— 下架要连同 web 侧引擎/探针/发布元数据/76MB 资产一起做，属独立发布变更）；
`settings.imageEngine`/`geminiAppExperimentalEnabled` + 三个恒常量 `normalize*` 壳（是 **legacy Gemini-app 迁移的输入**，
`config.test.ts:406-414` 断言 `'gemini_app'` → `'local'` 迁移）；`UrlTarget`（`@deprecated`，pixiv 适配器仍在合法使用）。

**顺手修掉的三处 correctness**（都是前几轮改动留下）：① `scripts/test_server.py` T4 引用已删的 `PAGE_KEY`
→ NameError 被 except 吞成 `[FAIL]`（而文档还宣称 6/6）；已移除该参数并让异常输出带类型名。
② `server/ocr.py` `_pad_token_id` 定义两次（第一份永不可达）→ 删一份。
③ `server/ocr.py` `_conf_from_scores` 异常 `return 1.0` → 改 0.0（**原语义等于"算不出来就当最可信"，会关掉低置信告警**）。

**验证**：全量 **173 文件 / 1495 全绿**；`typecheck:extension` 0 错；架构绿；
产物 `node --check` 全过；全仓搜索被删符号零残留；纯净态对照证明未引入新错误。

### v0.5.1（2026-10-05）—— 整页日志落地 + 真机暴露的三处修复

服务端侧（`server/pagelog.py`、`POST /log/page`、`X-DMB-Timing` 响应头）随 `bd35bd7` 落地。
**一套记录**：一条记录 = 一页（15 段耗时 + 逐行原文/译文 + 画廊第几页 + 服务端自报 OCR/LLM 耗时），
落盘 `logs/pages/YYYY-MM-DD.pages.jsonl`。开关「整页日志」`settings.pageLogEnabled`（默认开），
**关闭时探针整体退化成 no-op**。**为什么必须由扩展组装**：阶段耗时与逐行文本只有扩展知道，
服务端耗时由服务端回传 —— 两边合一，一条记录一次 POST，**零配对**。

**真机暴露的三处（都是日志自身坏了，翻译一直正常）**：
① 失败/取消只剩一条 error → `stageTimings` 是局部数组、抛异常即丢 → 改用 `progress.report(stage)` 实时流累积，
出错站优先取错误自带的 `stage`；
② `zh` 一整列空串 → `PipelineRecord.translations` 取的是 translate **之前**的快照 → 从
`translateRegions` 返回值摘译文；
③ `total_ms` 虚高 70%（5124 vs 实际 2995）→ `parallel` 是**容器阶段**，其耗时已含
`translate`/`mask_refine`/`inpaint`，逐项求和算了两遍 → 只在 `parallel` 在场时排除那三个子阶段。

**OCR 引擎：没有 UI 的"显式选择"是伪命题**：`paddleocr_v6_medium` 是旧默认、会留在老用户设置里，
而全仓库**没有任何 UI 能改它** → 新默认永不生效。现在只认 `manga_ocr_server`，其余一律迁移。
**纪律：改设置默认值时，必须同步迁移旧值。**

**性能数据结论（23 页真实记录，服务端 OCR）**：真实每页耗时**中位 2995 ms**；阶段占比翻译 ~64%、
OCR 418 ms、文本检测 380 ms、顺序排序 141 ms；`preload`/`preload_inpaint`/`ocr_postfilter` 恒为 0；
**每输出 token 中位 31.7 ms（区间 28.2~37.8，±15%）**（翻译耗时 = 这一页要生成的译文多，不是卡顿）；
换 OCR 引擎对总耗时几乎无影响（ONNX 3004 ms vs 服务端 2995 ms）；首帧冷启动 ~31 s；
**约 9% 的页会触发服务端「批量行数不匹配 → 回退逐条翻译」**（`server/backends.py:206`），
该页耗时变 3~5 倍，且 `input_chars`/`prompt_tokens` 是**累计值**（排查时别误读成"注入了上下文"）。

### v0.5.2（2026-10-05）—— OCR 模型启动预载 + 双开关

`ocr.py` 新增 `preload_ocr()`（复用 `get_ocr()`、幂等、失败只 log）；`app.py` `main()` 起 daemon 线程预载
（HTTP 先起来、`/health` 立刻可用）。**管辖边界（用户拍板）**：只管 manga-ocr —— 不碰 `vram.py`、
不做任何显存清空；LLM「同时只能跑一个 / 切模型要卸载」归 11437。
同期新增「日志体系重构设计」稿（见 §二）与预载/自动翻译双开关。

### v0.5.3（2026-10-06）—— 日志体系落地 + keep_alive 15m + 清死资产

- **日志体系**：新增 `server/eventlog.py`（唯一事件流落盘）、`server/support.py`（支持包导出）；
  移除 `server/pagelog.py`（已被 eventlog 取代）；`app.py`/`backends.py`/`logging_.py`/`ocr.py`/`sakura.py` 接入统一日志。
- **显存驻留**：`config.py` `DMB_KEEP_ALIVE` 默认 `-1` → `"15m"`（**恢复空闲自动卸载**；卸载后下次翻译自动冷加载 ~3~6s，无需手动）。
- **清理**：死资产（`manga-ocr/assets` 示例图与词表 18 个）、一次性探针（`probe/{m4-diag,m5-flashdiag,mainworld-probe}` 18 个）、
  `preview/local-model-control.html`、`docs/NEED_FROM_USER.md`。

### v0.5.4（2026-10-08）—— 合并前清理

- **移除硬编码路径**（5 处，指向本机 `E://AI//dmbTranslator//.conda`，是解释器查找的第三级兜底候选）：
  `scripts/start_server.cmd`/`start_ollama.cmd`/`stop_ollama.cmd`/`test_ocr.cmd`/`install_native_host.py`/`test_ocr.py`
  —— 删掉后仍有 `DMB_PYTHON` → `server/.venv` → `py` → `python` 四层兜底。
- **安全脱敏**：`docs/预取优先-施工修订二.md` 里记录探针结果时写下了真实的 e-hentai showkey 值，
  已脱敏为 `<redacted>`。**showkey 等同访问权限密钥，该 key 建议作废。** 复查全仓库已无疑似凭据值。
- 补开源合规文件。

### 仓库结构整理（2026-10-09）

`shinobu/` → `frontend/`，内嵌 `.git` 删除（历史备份为 bundle）；服务端固定在仓库根 `server/`；
"合并两仓库到 `frontend/local/`"的方案**已废弃**。文档三合一（本文 + `ARCHITECTURE.md` + `UPSTREAM.md`）。

### 弹窗「向后预载」开关恢复（2026-10-09）

**回归**：早先按「删掉冗余字段 `prefetchEnabled`」精简时，把 popup 里绑它的「向后预载」药丸开关
一起删了 —— 弹窗只剩「进入自动翻译」一个开关，"预载"退化成一个纯数字框，
**两个功能不再各有一个开关**（用户两次反馈："预载按钮没了" / "又变成耦合的了"）。
用户 2026-10-05 的原始约定是 **预载 / 自动翻译双开关**（见 v0.5.2）。

**修法**：恢复「向后预载」开关，但**不把 `prefetchEnabled` 字段加回来**（它与 `depth = 0`
数学等价，加回来就要重新面对"开关显示开、深度却是 0"的两处状态打架）。改为一行的
「向后预载」= 药丸开关 + 页数输入 + 状态文字，开关状态**派生自 `prefetchDepth`**：

| 元素 | 管什么 | 边界 |
| --- | --- | --- |
| 「向后预载」开关 + 页数 | 窗口**上界** | 后页 N+1…N+depth |
| 「进入自动翻译」开关 | 窗口**下界** | 当前页 N |

- 开关显示 `depth > 0` = 开、`depth === 0` = 关（唯一真相源，不可能自相矛盾）；
- 关 → `0`；开 → 回到**本次弹窗打开期间记下的最后非零深度**（组件内 `useRef`，**不落 storage**），
  没有记忆则用默认值 `defaultPrefetchDepth`；
- 页面右下角那个快捷按钮看不到数值，仍固定"开 = 恢复默认深度"—— 差异只在"看不看得见数值"；
- 数据层、消息层、执行器**一行未动**（`prefetchDepth` 仍是"关预载"的唯一表达）。

**验证**：`typecheck:extension` 通过；全量单测 **1530 通过**
（另有 `tests/release/storePublishingWorkflow.test.ts` 因工作副本里没有 `.github/workflows/release.yml`
失败，与本次改动无关）；`build:extension:chromium` 重建产物并确认
`向后预载` / `向后预载开关` / `进入自动翻译` 均在包内、旧文案「预载数量」已消失、固定扩展 ID
`nlfpkgiknddjehbagelkpblkgfcgpmhb` 未变。

### 去字串行回归 —— 已回退（2026-10-09）

下午为「未返回译文的气泡保留原图」把 `eraseTask` 改成先 `await translateTask`，
翻译与去字由并行变串行：每页多花 **~0.93 s**（`mask_refine` + `inpaint` 从「被翻译掩盖」
变成「纯追加」），且进度全程挂在「去字待执行」（`parallelEraseStatus` 停在 `pending` 推不动）。
**当晚已退回原版的并行实现**（`Promise.all([translateTask, eraseTask])`）。

期间试过「并行 + `restoreUncoveredRegions` 事后回补」，**已撤销**。撤销依据（实测）：
模型漏行时服务端会整批作废并改走逐条（`送入 4 / 返回 3 → 降级 1 块 → 4 次单条`），
**错位名单不会到达前端**；而回补只能处理「某气泡译文字段为空」，在正常路径上不成立。
代价却是「凡有原文就抹」＋回补整套逻辑，故整体回退到原版。

### 译图缓存改为 off-screen 内存 vault + IndexedDB 实现整体删除（2026-10-10）

**问题（Bug1）**：e-hentai 阅读页翻页是**整页重载**，旧文档一销毁就走
`pagehide(persisted=false)` → `TranslatorCore.stop()` → 内存译图清零 —— 翻回已译页得把十几秒的管线重跑一遍。

**方案演进**：先做过一版 IndexedDB 落盘缓存（按页面源隔离、`savedAt` 索引淘汰）；
**用户拍板改为不落盘** —— 跨文档存活靠"换一个能跨文档活着的内存"，不是"写到磁盘"。

**落点（新增 5 + 修改 5）**

| 位置 | 内容 |
|---|---|
| `shared/imageVaultProtocol.ts` | 跨进程协议：端口名 `mt:image-vault-client` / `mt:image-vault-host`、消息联合、两处校验、终态判定 |
| `offscreen/translatedImageMemoryVault.ts` | 存储本体：纯内存 `Map`，默认上限取 `defaultTranslationCacheLimit` |
| `offscreen/imageVaultHost.ts` | off-screen 侧协议宿主（缓存实例由外部注入） |
| `background/imageVault/imageVaultBroker.ts` | 路由 `requestId → 来源端口`；被 `PipelineHostBroker` **委托**接管端口（broker 是端口命名空间唯一所有者） |
| `content/core/state/offscreenTranslatedImageVault.ts` | 内容脚本侧后端 + `TranslatedImageVaultPort` 契约；一次请求一条端口、20 s 超时、**一律不抛** |
| `offscreen/pipelineHost.ts` | 新增 `keepAliveWhenIdle` 闸门：缓存非空时**只释放模型/Worker、不请求关闭文档** |
| `background/localPipeline/offscreenBroker.ts` | 新增 `registerPortHandler` 委托口；**真正派发任务时清掉 `pendingIdleClose`** |

**清除条件 = ①超上限 LRU（默认 15）+ ③仅手动「删除全部」+ ⑤会话结束 / 扩展重载天然。**
**键加 `location.origin::` 前缀**：off-screen 是扩展源、所有站点共用一个缓存，不加前缀两个站点撞同一个
`gid-page` 会互相串图；副作用是「删除全部」= 全站点清空。
**Firefox 没有 off-screen 文档** → 整条链路快速降级成"无缓存"（行为 = 加缓存之前）。

**顺带修掉的真 bug**：宿主空闲 5 min 报 `idle-close`（当时恰好有 client）→ broker 记成"任务完就关" →
这张图译完写进缓存 → 任务释放 → **文档被关、刚攒的缓存一起没**。修法：真正派发任务时清掉该标记，
宿主下次空闲会自己重新判断。

**2026-10-10 同日第二轮：按「从头写会写成什么样」重写**

- **IndexedDB 实现整体删除**：`content/core/state/translatedImageVault.ts`、其测试、
  以及为它手写的 `tests/content/core/state/fakeIndexedDb.ts`（其中通用的 `flushAsync`
  迁到 `tests/content/core/flushAsync.ts` 保留）。
- **淘汰口径回归 Map 插入序**：`savedAt` 字段 + 每次写入 O(n) 扫最老键，是从 IDB 版
  （要 `savedAt` 索引做游标删）继承来的化石。`put` 先删后插、`get` 不动顺序 ⇒ 迭代序恒等于
  写入时间序，删掉时间戳与扫描即可 —— 且**恰好与同层的 `PhotoStateStore.trim()` 同口径**。
- 删掉从未被使用的 `createRequestId` 测试注入项、`limit()` 访问器、两个无人引用的 Options 类型、
  客户端里一行包一层的 `post()` 包装；broker 的 `Set<HostWaiter>`（`ensureHost` 单飞 ⇒ 同时最多
  一个等待者）收敛为单个等待者字段。
- 注释里所有"与旧的 IndexedDB 版对比"的措辞一并清掉（历史留在本文件里就够）。

**验证**：`typecheck:extension` 通过；vault 相关 11 文件 **102/102 通过**；
全量 **1561 通过 / 1 失败**（`tests/content/readerEngines/binbContent.test.ts` 一条 5 s 超时，
单独跑 2.4 s 通过 —— 并发环境抖动；另有 `tests/release/storePublishingWorkflow.test.ts`
因工作副本没有 `.github/workflows/release.yml` 报 ENOENT，均与本次无关）；
`check:architecture` 通过；`dist-chromium` 已重建。

**2026-10-10 同日第三轮：改上限这件事落到两层，默认值一起收敛（用户拍板）**

用户原话：**「把修改上限落到两层，同时把默认的缓存数量改为 15，默认预载数量改为 4 —— 像这种东西
都以功能目的本身触发，既然用户需要改这种东西肯定是一起改，而不是改一层另一层不动」**。

- **默认上限 200 → 15**，且成为**唯一真源**：`shared/config.ts` 的 `defaultTranslationCacheLimit`
  —— 内容层 `PhotoStateStore` 与 off-screen 层 `TranslatedImageMemoryVault` 都直接 import 它，
  不存在"改一层、另一层没跟"。
- **运行期改上限也落到两层**：协议加 `vault-set-limit` / `vault-limit-set`；vault 的上限从
  `readonly` 改为可变并新增 `setLimit()`（**调小立刻裁**）；`TranslatorCore.setMemoryCacheLimit()`
  的写法是**先由内存层 `stateStore.setLimit()` 定出生效值**（非法输入由它回落到默认），
  再把这个值**原样**交给 `vault.setLimit()` —— 两层不会各算各的。
- 链路本身没变（弹窗 → `mt:memory-cache` → background → 活动标签页的内容脚本），
  变的只是**内容脚本这一端从"只改内存层"变成"两层同改"**。
- `defaultPrefetchDepth` **核查后确认两处（`shared/config.ts`、`content/scheduler/pageScheduler.ts`）
  原本就是 4，未动**。
- 顺带清掉弹窗里三处已过时的注释（"缓存只活在内容脚本里"、"刷新页面即失"、"把 200 改成 3"）。

**验证**：`typecheck:extension` 通过；`typecheck:tests` 与改动前**同样的 10 条既有错误**、无新增；
相关 7 文件 **87/87 通过**；`check:architecture` 通过。

**留白（如实记）**
- off-screen 文档"能不能真的活过页面重载 + 空闲 5 min"需真机验，单测覆盖不到浏览器进程生命周期。
- 上述删除顺带作废 v0.1.4.101 的「留白：IndexedDB 适配层 `clear`/`trim` 无离线测试」。
- ✅ 原留白「vault 上限固定、不接弹窗设置」**已作废** —— 见上「同日第三轮」。

---

## 二、日志体系重构（设计 2026-10-05 → M0–M4 落地）

> 触发：开源后别人遇到问题，只给我们一份东西，我们就能定位。现状达不到 —— 8 个出口、各写各的 schema。

### 2.1 设计目标（1 + 1 收敛）

```
        一条事件流（统一 schema，两仓库同源）  ──▶  一个出口（支持包，一键导出）
```

- **目标**：① 用户侧成本 ≈ 0（一次点击拿到可提交材料）；② 拿到就能回答四件事（**哪一跳、什么错、什么环境、能否复现**）；
  ③ 扩展与本机服务**口径一致**（同一 schema + 同一贯穿 ID）；④ 隐私可承诺：**默认日志不含漫画原文/译文**。
- **非目标**：不做 APM / 远端上报（**永不外发**）；不做性能剖析门户（jank 并入事件流）。
- **分层**：**L0**（环境快照、设置脱敏快照、**所有失败**、阶段耗时、计数、版本）**常开**；
  **L1**（逐行原文/译文、图片字节与尺寸、DOM 细节、服务端日志全文）**默认关/打码**，勾选才含。**已拍板。**
- **出口形态**：**单文件 JSON** `dmb-support-<ISO>.json`（`v`/`env`/`settings`/`summary`/`events`/`server`/`privacy`），
  可直接贴进 issue（丢弃 zip 的理由：issue 里只能贴文本）。
- **上报方式**：**批量异步，绝不进关键路径**（用户口径"不影响翻译任务速度"）。`emit()` 同步 O(1) 只 push 对象；
  满 32 条或 500 ms flush 一次，`fetch(..., {keepalive:true})` fire-and-forget、**永不 await**；
  缓冲上限 512 条、满了丢最旧并给 `dropped` 计数（**丢事件可以，卡住翻译不行**）；开关关闭时整套退化成 no-op。

### 2.2 统一 schema（两仓库同源）

```jsonc
{
  "v": 2, "ts": "…", "seq": 1287, "sessionId": "s-…", "runId": "r-…",
  "pageKey": "3193401-94", "requestId": "q-…",            // ★ 跨进程贯穿 ID
  "level": "error", "kind": "failure",
  "where": { "repo": "extension", "module": "imageDownloader", "fn": "downloadSerialized" },
  "what":  { "stage": "fetch", "host": "…hath.network", "refererApplied": true },
  "err":   { "type": "TypeError", "message": "Failed to fetch", "code": "IMAGE_FETCH_FAILED" },
  "dur_ms": 14572
}
```

`what` 自由但需登记；脱敏规则沿用（密钥键名 → `[REDACTED]`、URL 只留 origin+pathname、base64/blob 打码）；
`v` 只增，读取端忽略未知字段。

### 2.3 requestId 贯通

**M1 实际做法（与设计的一处偏差，记录在案）**：由**服务端**生成并回显
（`eventlog.resolve_request_id()`：请求头带了就沿用，没带就生成，`X-DMB-Request-Id` 回显），
扩展侧拿到后记进 `page.completed` 的 `what.requestIds`。
**理由**：扩展若"主动生成"得改 `packages/image-pipeline` 里的 OCR provider —— 那是对上游的接触点，
按 `docs/UPSTREAM.md` 纪律应尽量少动。**效果一样**（两侧一定存在同一个 ID）。客户端主动生成留到 M2 再评估。
**已落地三个出口**：`POST /ocr` → `timing.requestId` + 响应头 + `ocr.call` 事件；
`POST /v1/chat/completions` → `dmb_timing.requestId` + 响应头 + `llm.call`/`failure` 事件；
`POST /log/events` → 事件缺 `requestId` 时用本次请求 ID 兜底。

### 2.4 事件清单（kind 登记）

| kind | 层 | 关键 `what` 字段 | 说明 |
|---|---|---|---|
| `env.startup` | L0 | 扩展版本/commit、浏览器与 UA、模型名、OCR 引擎、keep_alive、显存 | 进程启动一条 |
| `service.status` | L0 | 端口、在不在跑、探活耗时 | 11436 / 11437 / ollama |
| `page.start` | L0 | pageKey、trigger（user/prefetch）、depth | 一次翻译开始 |
| `stage` | L0 | stage、dur_ms | 13 个阶段 |
| **`failure`** | **L0** | stage、code、retryable、cause、attempt | ★ **所有出口都必须发** |
| `image.download` | L0 | host、refererApplied、bytes、contentType、attempt、dur_ms | 补齐静默区 |
| `ocr.call` | L0 | lines、total_ms、infer_ms、engine | |
| `llm.call` | L0 | model、tokens、stages | |
| `prefetch.chain` | L0 | knownCount、requested、failed、farthestPage | 取代 `data-m5-chain` |
| `page.completed` | L0/L1 | status、total_ms、stages[]、errorStage；**L1 才含 lines[]** | 取代整页日志独立系统 |
| `ui.jank` | L0 | 长任务/worker 时间轴 | 取代 `console.info('[shinobu:jank]')` |
| `log.verbose` | L1 | 原文文本、字节、DOM 细节 | 只在 L1 开时产生 |

**失败成为第一公民（治本条款）**：**任何"要抛异常/要返回失败"的出口，必须先发一条 `kind:"failure"` 事件。**
覆盖范围（现状全部或部分缺失）：图片字节下载、DNR 规则安装、消息通道、OCR、翻译、排版、还原。

### 2.5 迁移步骤落地状态

| 步 | 内容 | 状态 |
|---|---|---|
| **M0** | 立 schema 与事件 sink；新代码走新通道，旧的暂时并存 | ✅ |
| **M1** | `requestId` 贯通（服务端生成并回显） | ✅ |
| **M2** | `failure` 覆盖 background 全部抛出点（尤其 imageDownloader） | ✅ |
| **M2b** | content 侧接入（新增 `mt:event-log` 消息通道） | ✅ |
| **M3** | 支持包一键导出（env / settings / events / server / privacy） | ✅（真机 2026-10-05 17:32） |
| **M4** | 逐个下线旧出口：DOM 遥测 → console → 服务端三件套 → `/log/page` | ✅ 四步全落地，护栏 §10 三条齐 |

**M2 为什么先做**：94 页那类错误的病根是**结构性静默** —— 原图字节下载失败抛在 `executeLocalPipeline`
**之前**，offscreen 的 pipelineHost 根本没跑到，整页日志只记终态，于是三家日志 0 命中。
两条互补上报路径（刻意不重复）：`imageDownloader.onFailure`（**第一现场**，结构化：
`imageHost`/逐候选 `attempts[]`/`attemptCount`/`dur_ms`）+ `routeBackgroundMessage` 兜底（**网**，任何消息类型的抛出点）；
兜底**排除 `mt:download-image`**（已有第一现场，重复日志会稀释信号）。两处都是**包一层**（不是在每个 `throw` 前逐个加）。

**M2b 内容脚本为什么发不出 HTTP**：它的 `fetch` 受页面 CSP（`connect-src`）约束，到不了 `127.0.0.1:11436`；
只有 background/offscreen 用扩展自己的 CSP 才发得出去 → 新增 `mt:event-log`（content → background），
**出口实现仍然只有一处**。内容侧本地编号（`v/ts/seq/sessionId`）交给 background 之前**剥掉**，
由 background 统一打点（否则两个 `sessionId` 打架）。首个接入点：`imageTranslationExecution.ts` 的
**准备阶段失败**（`IMAGE_TRANSLATION_SETTINGS_INVALID`，offscreen 根本不知道）。

**M3 分工**：事件那一半由**服务端**出（`server/support.py` + `GET /support`），扩展只补自己才知道的两段
（`env` + `settings` 脱敏投影 → 拼上服务端那半 → `downloadJson`）。
理由：扩展侧事件缓冲是**过路**的（满 32 条/flush/job 结束就 flush 走），事件的真正家是
`logs/events/YYYY-MM-DD.events.jsonl`；让扩展去攒，等于攒一个空壳。
**三条纪律**：①「没采到」≠「采到了但为空」（服务端不可达写 `server: null` + `serverError`，**绝不给空壳**）；
② `summary` 与 `events` 同源（失败按 `模块/错误码` 归类，不按整句 message）；③ 截断如实标注（`window.truncated`）。

### 2.6 ⚠️ 已修缺陷：事件流曾会把日志发到云端

做 M3 时回头核 `resolveEventLogBase`，发现它只做 `new URL(llmBaseUrl).origin` 而**没有 loopback 校验** ——
而 `llmBaseUrl` 在云端模式下正是 `https://api.openai.com/v1`。后果：每次 flush 都会把带失败详情、文件路径、
主机名的事件 **POST 到第三方**，且 sink 吞错、**全程静默**，与"日志永不外发"直接冲突。
**已修**（`shared/eventLogSink.ts`）：两条推导路径都**必须落在 loopback**（`127.0.0.1`/`localhost`/`[::1]`），
否则返回 undefined，事件流整体关成 no-op —— **宁可没有日志，也不外发一个字节**。
顺带修好**整页日志**的同类外发。护栏：`tests/shared/eventLogSink.test.ts` 有专门用例守着。

### 2.7 M4 四步（下线旧出口）

1. **DOM 遥测收口**：三处**无条件**写 DOM 的遥测（`data-m5-chain`/`data-m5-restore`/`data-m1-trace`）
   改走 `publishDomTelemetry(...)`，新增 `shared/domTelemetry.ts` + 设置项 **`telemetryDomEnabled`（默认关）**。
   通道搭已有的 `mt:prefetch-config`（没新开消息）。两个容易反的点：`telemetryDomEnabled` 与 `prefetchEnabled`
   **缺字段语义相反**（前者可选、后者必填，标准 =「缺字段时的行为必须等于用户期望的安全默认」）；
   关闭时**连 `JSON.stringify` 都不发生**（有用例 `spyOn(JSON,'stringify')` 守着）。
2. **裸 `console.*` 收口（应用层）**：`photoStateProjection.ts` 的 `[shinobu:jank]` → `ui.jank` 事件；
   `cardState.ts` 的保存失败 warn → `failure`（`UI_PREFERENCE_PERSIST_FAILED`）；`pageLog.ts` 3 处
   `console.debug` 随下线消失 → **console 白名单现在为空**。
   > `photoStateProjection` 那处原是同份数据两处输出、控制台那半**不上报**（导出支持包时看不见）。
   > **边界**：规则只管辖 `apps/extension/src/`（`scripts/dev.mjs` 是 Node 命令行工具，控制台本来就是它的输出）；
   > **`packages/*` 的约 20 处不在管辖内**（见 §五遗留）。
3. **服务端三件套合并**：`<模型>/*.trace.jsonl` → 事件流 `what.stages`；`*.image.jsonl` → L1 `log.verbose`；
   `*.log` **保留**为控制台镜像。`logging_.py` 删掉 `trace_event`/`write_image_record`，`config.py` 删 `TRACE_ENABLED`
   —— **不是"把两个文件改成写事件流"，是删掉半条链路**。
4. **整页日志 + `/log/page` 下线**：**把口径搬走再拆**（不是删掉）——
   `total_ms` 只在 `parallel` 在场时跳过子阶段 → `offscreen/pipelineTelemetry.ts` 的 `summarizeStages()`；
   失败/取消只认**实时轨迹**；`errorStage` 命中轨迹才标 `failed`；逐行译文权威来源是 `captured`（`toLines()`）。
   `pageLog.ts`/`pagelog.py`/`POST /log/page` 全删；`pageLogEnabled` 字段**保留但语义迁移**为 L1 开关
   （决定要不要附带原文，弹窗文案改「日志含原文/译文（详细层）」——保留字段名是不做一次牵动老用户 storage 的迁移）。
   **采集点闸门也得跟着搬**：`markStage` 门控由 `pageLogEnabled`（L1）改为**事件流的闸门**（`eventLogEnabled`）。
   **顺带修**：`/log/page` 删掉后会掉进 passthrough 返回 **502**（看似"服务挂了"）→ 现在 `/log/*` 在 GET/POST
   两端都直接返回 **404 + 明确说明**（"M4 起只有 `/log/events`"）。

**M4 护栏齐了**（`check-extension-architecture.mjs` 三条，**每条都做了反向验证**）：
① 禁裸 `console.*`；② 禁 `dataset.m*` 遥测（只认 `m<数字>`，不误伤 `data-mt-ehentai-anchor`）；
③ 禁第二个日志端点（只允许 `/log/events`）。

---

## 三、三份审计报告的结论

> 三轮审计（2026-10-04）：**全项目审计**（结构 / 技术债 / 文档漂移）→ **奥卡姆减法**（能不能用更少的
> 代码/状态/分支/抽象做同样的事）→ **从零设计对照**（先忘掉现有实现、只用"需求 + 约束"重新设计再逐项对照）。
> 三轮均**未修改任何代码**；结论一致：**架构不需要重写**。以下条目已对照 v0.5.4 代码树核实状态。

### 3.1 已修复项（v0.5.0 ~ v0.5.4 已处理）

| 编号 | 问题 | 处置 |
|---|---|---|
| P0-2 | `mt:translation-cache` 整条磁盘缓存维护通道**运行时不可达**（无发送方 + 总开关 false） | ✅ 已删（`shared/messages.ts` / `router.ts` / `offscreenBroker` 两套路由表 / `translationCacheDb.ts` 均不存在） |
| P0-3 | 四处死代码：`HostThrottle` / `PageCacheManager` / `planPrefetchWindow`+`planCurrentAndPrefetch` / `freezeScreenshotResultOverlayPosition` | ✅ 已删（`scheduler/hostThrottle.ts`、`cache/` 目录、`ui/screenshotOverlay.ts` 相关函数均不存在） |
| P0-4 | `scripts/test_server.py:177` T4 引用未定义常量 `PAGE_KEY` → NameError 被 except 吞成 `[FAIL]`，而文档宣称 6/6 | ✅ 已移除该参数 + 异常输出带类型名 |
| P0-5 | `server/ocr.py` `_pad_token_id` 定义两次；`_conf_from_scores` 异常 `return 1.0`（"算不出来就当最可信"） | ✅ 重复定义已删；异常返回改 **0.0** |
| P1-2 | `background` 反向 import `content/core`（`buildPageCacheKey` 越界，架构脚本查不出） | ✅ `cacheManager.ts` 整体删除、该 import 消失 |
| — | `settings.sourceLang` 死字段 | ✅ 已删 |
| — | `PhotoState.mode` 冗余存储（与 `status` 一一对应） | ✅ 已删，页级判断改读 `status` |
| — | `probe/`（三个探针，README 自述验完即删）、根目录 `dmb-probe-report*.json`、`docs/NEED_FROM_USER.md` | ✅ 已删（v0.5.3） |
| — | `server/backends.py` 的 `STAGE_KEYS`/`TOKEN_KEYS`/`ppl_geomean` 死代码 | ✅ 已删 |
| — | `resolveAssetUrl`（全仓零调用） | ✅ 已删 |
| P1-3 | 文档与实现大面积不一致（README 说 11436 能管模型 / `shinobu/` "一行不改"；SERVER.md 接口表/文件数；UPSTREAM_PATCHES 自相矛盾；ARCHITECTURE pageKey 段；ROLLBACK-NOTE 分支） | ✅ 大部分经 v0.5.0 文档对齐 + 本次三份文档合并处理（残留见 §3.2-3） |

### 3.2 ⚠️ 未修复问题清单（逐条保留）

> 下表是**当前代码树（v0.5.4）仍未修复**的问题，逐条含原审计编号、问题描述、涉及文件。
> 编号沿用第一阶段报告的 `P0/P1/P2` 与第二/三阶段报告的 `C`/`§` 编号（重叠项已合并去重）。

| # | 编号 | 问题（含具体文件） | 类别 |
|---|---|---|---|
| 1 | **P0-1（残留）** | 显示模式仍非单一来源：`readingModeController.ts:54,209,247` 自持一份 `globalTranslateMode`（与全局 `displayMode` 并存）。`PhotoState.mode` 已删，但"阅读模式复用同一全局量"未做 → 仍存在"漏写一处写点 → 某页切换不跟随"的偶发 bug 温床 | 结构 / 隐藏 bug |
| 2 | **P1-1** | 预取链条三套推进机制 + 四个并存状态：`content/core/scheduler/prefetchChain.ts`（`windowAnchorPage` 锚点 / `advanceToWindowEdge` 边缘推进 / `notifyDispatchFailed` 失败补发；`known`/`requestedOrKnown`/`dispatchedParams`/`autoRetryCount`）+ `prefetchExecutor.ts`（`distanceLowerBound()` 布尔定窗口下界）。**审计建议：认账、不重构**（被真机问题逼出来、当前能用、注释完整），只做两件低风险事：文件头画决策流程图 + 抽"当前页是否算入窗口"具名函数 | 已知最难点（**明确保留**） |
| 3 | ~~**P1-3（残留）**~~ **已修** | 文档漂移残留：~~README 目录表仍写 `shinobu/`、起步命令仍 `cd shinobu && npm install`、`README.md:29` "一行不改"叙述；`docs/` 内旧文档尚未全部归档~~ → **2026-10-09 仓库结构整理一次性处理**：`shinobu/` 改名 `frontend/`、README 重写、docs 11 份归档为 3 份。**残留未修**：服务端端口在 TS 与 Python 多处各写一份（见本表 #17） | 文档 / 一致性 |
| 4 | **P1-4** | 三个大文件是"入口+状态+消息路由"混合体：`offscreen/pipelineHost.ts`(982) / `background/localPipeline/offscreenBroker.ts`(930) / `content/index.ts`(703)；次一级 `ui/styles.ts`(997) / `screenshotOverlay.ts`(870) / `localPipelineClient.ts`(675) / `readingModeController.ts`(584)。审计只建议拆出 `content/index.ts` 的"预载开关 UI"（模块级 `prefetchToggleDepth` 等 + 1s 定时器） | 结构 |
| 5 | **P2-1** | 重复实现清单：`isRecord` 各自定义 **24~26 处**（`background/utils.ts:1` 已有导出实现）；环回地址校验**3 套且口径不一致**（`shared/config.ts:254` 只认 `127.0.0.1` / `popup/LocalModelControl.tsx:87` / `packages/shared-config/src/index.ts:298-305` 认整段 `127.0.0.0/8` + 裸 `::1`）；quad/box 互转 2 套；`clamp` 5 个同义实现；本机端口/URL `127.0.0.1:11436` 4 处硬编码（`shared/config.ts:283`、`localServiceClient.ts:31,77`、`popup/LocalModelControl.tsx:72`）。**口径不一本身就是 bug 温床** | 重复 / 隐患 |
| 6 | **P2-2** | 结构性重复：`content/core/translation/localPipelineClient.ts` 的 `runLocalPipeline` 与 `runLocalDetectionProbe` 各维护约 180 行近乎逐行的 Port 建连/分发/超时/清理（清理块重复在 `:113,282,543,637`）；`screenshotController.ts` 两个约 200 行函数复制 cleanup/render/runPipeline 三段；`photoStateProjection.ts:65,211,236,247` 四处各自重置相近字段（可并成 `resetToIdle(state)`） | 结构 / 局部重构 |
| 7 | **C2 / §2-1** | **配置校验写了两套**，校验同一份 `PipelineConfig`：`packages/image-pipeline/src/index.ts` 的 `validateConfig`+`hasOnlyKeys`（115 行）与 `packages/image-pipeline/src/protocol/index.ts` 的 `isValidPipelineConfig`（~60 行）。加一个字段要改两处（上轮加 `ocrServerBaseUrl` 实证同时改了两处）→ 建议合成一份 parser | 结构 / 长期税 |
| 8 | **C4 / §3-3** | **缓存条数上限 4 个持有者**：`settings.translationCacheLimit`（权威）→ `pipelineHost.translationCacheLimit`（收到）→ `…ConfiguredLimit`（已生效）→ `PhotoStateStore.cacheLimit`（内容脚本）。跨进程镜像不可避免，但可少两层 | 状态 / 镜像 |
| 9 | **C5 / §3-5** | **弹窗状态**：`popup/LocalModelControl.tsx` 3 个自定义 hook（各 2-3 `useState`）+ 组件 3 态 + **两个 3s 轮询定时器** + `intent` 与真实 `running` 双轨。审计称"补丁叠补丁最直观的一处"→ 建议收敛成一个"本地服务状态"对象 + 一个轮询 | 状态 / 补丁叠补丁 |
| 10 | **C3 / B1** | **本地 ONNX OCR 第二实现未删**：`paddleocrProvider.ts` + 预处理/解码 + 相关测试 + `PP-OCRv6_medium_rec.onnx`（76MB）+ manifest 条目（~1,100 行）。当前口径是"失败显式报错、不回退"且默认已不是它 → **第二实现永远不会被自动使用**（"半保留"状态）。删它需同批清 `models.json`/`models.sha256`/AMO 校验，属**独立发布变更** | 半保留 / 发布决策 |
| 11 | **§2-6** | `TranslatorCore.ts:353` 附近 `decode().then(go).catch(go)` + `setTimeout(go,500)` **三重兜底**，可简化为"decode 或超时"二选一（少一条竞态） | 简化 |
| 12 | **§2-10** | `pipelineHost.ts` 同时持 `translationCacheLimit` 与 `translationCacheConfiguredLimit`（"期望值"与"已生效值"）→ 可一个字段 + 读 store 自己的 limit | 状态 / 镜像 |
| 13 | **§1 A-15** | `canShowDebugDownload = false` 死分支：`content/core/ui/imageControls.ts:258-260`（恒假 + 按钮常隐） | 死代码 |
| 14 | **§1 A-14** | 未使用 CSS 类 `.field-row` / `.settings-stack` / `.option-panel` / `.status-warning`（约 30 行）：`popup/styles.css:301,780,786,1642` | 死代码 |
| 15 | **§1 A-12** | 前端 `OLLAMA_PORT = 11434`（零引用）：`shared/localServiceClient.ts:22` | 死代码 |
| 16 | **§5-6** | `UrlTarget`（标注 `@deprecated` 却仍被 pixiv 适配器合法使用）—— 迁移未完成 | 历史包袱 |
| 17 | **§5-4** | **服务端端口双真源**：`server/config.py:20-27`（`DEFAULT_PORT=11436` / `DEFAULT_OLLAMA_SERVICE_PORT=11437`）vs `server/service_control.py:36-38`（`DEFAULT_SERVER_PORT=11436` / `OLLAMA_PORT=11434` / `OLLAMA_SERVICE_PORT=11437`）—— 改端口要改 4-5 处 | 漂移隐患 |
| 18 | **§6** | **测试的假安全感 / 缺测试**：全工作区 `npm run typecheck` 剩 2 条**既有**测试错误；`ollama_server.py`（双服务架构的一半）、`service_control` 的优雅关停顺序（"先卸模型再停引擎"只靠注释保护）、`ocr._conf_from_scores` 的**逐行对齐层** —— **都没有自动化测试** | 缺护栏 |
| 19 | **§6-7** | `binbContent` 的"像素矩阵还原"测试**偶发失败**（单独复跑必过）—— 已知 flake，周期性浪费排查时间 | 已知 flake |
| 20 | **日志体系·未做** | `packages/*/src` 的约 **20 处** `console.warn`（全在降级/回退路径：WebGPU→WASM、ONNX→heuristic、CUDA→CPU…）。正确归宿是让库暴露 **logger 注入点**（同 `setPerfTraceSink` 模式），涉及 4 个包与上游接触点纪律，**单独一步**。在此之前护栏的 console 规则对 `packages/` **空缺** | 日志收口未完成 |
| 21 | **日志体系·待定** | 事件流 `enabled` 目前 = "有本机服务地址" → **纯云端用户没有出口、一条都没有**。M3 支持包导出需要一个**不依赖服务端的本地缓冲**，否则这类用户无法提交日志 | 覆盖缺口 |

> **明确"已登记但不算未修复"**（审计结论 = 保留 / 非 bug，避免后人误当问题去"修"）：
> - `prefetchChain` 三机制合并、`pipelineHost`/`offscreenBroker` 按行数拆小、把 `arbiter` 换成 signal
>   —— **"纸面更美、实际更险"**；
> - `server/` 两个 Handler 的 `_cors/_send/_send_json/_passthrough` 样板（两个服务**故意解耦**，"再加第三个服务时再抽"）；
> - `vram.py` 六层卸载函数、`ocr.py` 批量→逐张多层回退（每层为真实故障加的）；
> - `router.ts` 的 `MessageOf/SuccessOf/PayloadOf` 类型体操（换编译期消息契约一致）；
> - 上游兼容层（三代设置存档、prompt 模板迁移、`recoverPipelineRecord` 旧 schema）—— **产品要求，不是技术债**；
> - `apps/web/**`（上游另一个 app，不随本产品发布）—— 属"上游资产"，删它会破坏与上游对账；
> - `settings.imageEngine`/`geminiAppExperimentalEnabled` + 三个恒常量 `normalize*` 壳（legacy Gemini-app 迁移输入）。

### 3.3 奥卡姆减法审计：A/B/C 档 + 「20% 减法测试」

**计量口径**：产品代码 = `apps/extension/src`(32,747) + `packages/*/src`(26,912) ≈ **59,659 行**
（不含 `apps/web`、`tests`、产物）。

- **A 档（真无损，逐一 grep 核实无生产调用方）**：产品代码 **~610 行（1.0%）**；
  含测试与仓库杂物共 ~2,280 行（全仓约 3%）。
  > **关键算术：不损失任何功能的前提下，最多只能减掉 1%（产品）/ 3%（全仓）。
  > 这不是保守 —— 是"真正没人调用"的代码本来就只有这么多。**
- **B 档（需产品决策）**：① 本地 ONNX OCR 备选（~1,100 行 + 76MB）；② 调试/诊断面（~2,500-3,000 行，
  **你实际在用，不建议砍**）；③ `apps/web/**`（5,000+，**上游资产，不建议动**）。
  **只有第 1 项既不需要产品让步又能省体量** → 累计 ~1,700 行 ≈ 2.9%。
- **C 档（明确不能删，曾疑为死代码、核实后是活的）**：Gemini / Nano Banana 整条图像翻译通道
  （`imageTranslationExecution.ts:440-465` 按 `preparation.provider` 分流）、`restrictedResourceUrl`/`referrerPolicy`/`buildFlags`、
  `nm_launcher.py`/`native_host.py`/`panel.py` 两张面板、`ImageTranslationExecutionActivity` 三个撤销方法（合理分解）。

**「20% 减法测试」结论**：在不砍功能、不砍上游代码、不砍测试的前提下，**20-30% 做不到；诚实上限是 3%**。

| 档 | 可减 | 占比 | 是否"无损" |
|---|---|---|---|
| A 真无损 | ~610 行 | **1.0%** | 完全无损 |
| A + B1（本地 ONNX OCR 备选） | ~1,700 行 | **2.9%** | 无损于当前行为（备选本就不自动生效） |
| 再往上只能靠删调试面/`apps/web`/排版检测引擎/测试 | 3,000-15,000 行 | 5%-25% | **会砍掉功能或上游资产** |

若被强制要求减 20%（≈11,900 行）而"功能完全不变"，唯一"合规"方案是删 `apps/web`（5,000+）与剥离
`packages/image-pipeline` 的上游能力 —— **但那是"把别人的代码从仓库里移走"，不是真的简化，而且会破坏与上游对账的能力。不建议。**

### 3.4 从零设计对照：D1–D10 / C1–C5 / 是否重写

**从零设计 10 个决定（D1-D10），其中 7 个与现状一致**：
D1 上下文与职责（一致）；D2 页身份与缓存（一致，`pageKey = ${gid}-${page}`、版本化键、内存优先不落盘）；
D3 预取（**不同**：纸面主张"单一队列 + 每次重算 `wanted`"）；D4 显示（**不同**：全局枚举 + 页级 `translatedUrl`）；
D5 配置（一致，但内容脚本侧不许留副本）；D6 配置校验（**不同**：一个 parser）；
D7 取消（**不同**：每任务一个 AbortSignal，但现状的 arbiter 还承担 trace 与去重 → "现状不亏"）；
D8 服务层（基本一致）；D9 OCR（**不同**：一个引擎）；D10 复用上游（一致）。

**应该改变的五处（C1-C5，全部局部、有界）**：C1 显示模式三来源→全局唯一；C2 配置校验两份→一份 parser；
C3 OCR 两实现→一个；C4 缓存上限 4 持有者→1 权威 + 1 生效值；C5 弹窗状态/轮询收敛。
加上"删掉四处死抽象与死通道"这类清尾。

**当前实现中值得保留的部分（即使和从零设计不同）**：① 常驻画框（不改站点 `<img>` src）；
② 预取链"从在手 JSON 逐跳找缺口"的算法（imgkey 只能在前一页 JSON 里的约束下的正确算法）；
③ 内存优先不落盘 + `PhotoStateStore` 的 limit/protect；④ 失败语义（OCR/翻译失败必须显式报错、绝不静默回退）；
⑤ Windows 进程陷阱的沉淀（`CREATE_NEW_PROCESS_GROUP`/隐藏控制台/DETACHED、托盘版 `ollama app.exe` 会拉起
`ollama.exe`（两个都要杀）、中文 Windows 子进程编码、必须注入 `OLLAMA_MODELS`）；
⑥ 上游机制复用；⑦ arbiter/activity 那层；⑧ 双服务拆分。

**是否需要大规模重写？—— 不需要。** ① 真正的复杂度在领域，不在结构；② 从零设计与现状重合度很高
（10 个决定 7 个一致，重合的恰是架构骨架）；③ 护栏与测试（175 测试文件 + 架构边界脚本 + 真机验证链路）
是可复用资产；④ 痛点是"清尾"而不是"骨架"（自造复杂度约 1,300-1,500 行 + 6 处状态/抽象，局部重构能拿到全部收益）。

**第一阶段报告的"最终结论"三问（保留）**：有没有"屎上雕花"？—— 没有大面积的；
历史上有过"为观测一个 bug 而长出诊断装置"的时期，但那批已在 2026-10-04 用奥卡姆剃刀撤掉（净删 136 行）。
有没有补丁叠补丁？—— 有，但可枚举、集中在两处（`prefetchChain`、显示模式），不是全项目性的。
有没有明显过度设计？—— 个别（4 个死抽象 + 4 个恒常量 `normalize*` + 死的 `mt:translation-cache` 通道）；
其余抽象（arbiter/model-runtime/provider 注册表/消息契约）都有真实多实现或测试替换价值。

---

## 四、预取预翻译：目标口径定稿 + M4/M5/M6 结论

> 来源：`预取优先-施工修订二.md`（2026-10-03 14:42 用户拍板，**已定**）。
> 承接"预取优先-路线修订一"与施工指南 §11；冲突处以修订二为准。**决策人：用户。**

### 4.1 目标口径（取代一切旧表述）

| 需求 | 状态 |
|---|---|
| **翻回已译页零闪**（无空白、无日文原图） | ✅ **v0.2.0 已解决并定版**（拆闸门 + 常驻画框贴内存译图）。不再是 M4 的目标 |
| **预载预翻译**（看第 N 页时后台把 N+1…N+4 译好，翻到时直接看结果） | ⬅️ **M4 唯一目标** |
| 翻页零 api.php / 不闪原图（C1 短路） | 维持冻结 = 可选 Step 19；其"根治闪原图"的价值已被 v0.2.0 画框覆盖，剩余价值只剩"省请求" |

**用户原话**：「现在要去做主世界的目的，一定是**预载预翻译**为基础，而不是 0 闪……重点一定要放在
**如何预载下一页以及预载原图的译图**上面。」

### 4.2 手册 §11 五处实现前提的修订（2026-10-03 下午的回退 + v0.2.0 两波变更后）

1. **Step 14a 捕获源：主世界 → 内联脚本**。当前基线零主世界（`10edd48` 删除，当时零消费者）。
   showkey 从页面**内联 `<script>` 文本提取**（真机探针实录坐实 showkey 以 JSON 字面量内嵌）；
   端点推导（exhentai `https://s.exhentai.org/api.php` / e-hentai `https://api.e-hentai.org/api.php`）；
   请求形态照归档真机已验证实现（dispatchOk=4 / dispatchFail=0）原样移植。
   **备选（本批不启用）**：background `webRequest` 被动捕获 requestBody（需加 `webRequest` 权限），
   仅当真机证明内联提取失败（遥测 `showkeyFound:false`）时再上。
   随之取消：`m4json:<pageKey>` 持久化 → showpage JSON 只入**内存 Map**。
2. **Step 14b 产物落点：落盘 → 内存**。译图落盘已关（`TRANSLATION_CACHE_PERSISTENCE_ENABLED=false`）；
   预取产物 = `PhotoStateStore` **内存层**（每页一条，上限默认 200、UI 可调）。预取写、到达读，天然闭环。
3. **取图通道：小实验降级为真机验的一部分**。管线 `remote-image` 源由 background 下载
   （`host_permissions: <all_urls>` 已具备，`imageDownloader` 处理 referrer），与手点翻译同一条路。
4. **Step 14c 到达还原：降级为测试钉死**。v0.2.0 删除式简化后，restore = 纯内存同步查、无守卫；
   旧缺口在内存直查口径下**结构上不存在**。本步只做**测试钉死**两场景：① 到达时预取在跑 → 完成即贴（含画框）；
   ② 到达时预取已完成 → 内存直贴。bfcache `pageshow` 补 sync 已在 v0.2.0 基线里（保留）。
5. **DoD 措辞升级（画框版）**：**目标** = 翻到已预取的页 → **画框直接贴译图，原图不出场**；
   **底线**（验收仍按这条算 PASS）= 短暂原图后立即变译图、翻译零等待、无整页刷新。
   "零 api.php + 不闪原图"移出必验收。

### 4.3 M5 / M6 结论

- **M5b 跳页价值质疑**：跳页场景下页表增量 ≈ 0（showpage 的 `n` 字段永远够链式爬）→
  **跳页 UI 优先，Step 15 全量页表降级为可选增强**。
- **Step 17**：取消「桩译图端到端」前提（真实闭环先通），直接对真实缓存接线。
- **Step 18**：按新 DoD 验收；"去桩"缩为"预取执行器接线核对"。
- **M6 阅读栏**：做过（`1414eac`）又**整体移除**（`3466fc3`，-799 行）—— 原因见 §一·v0.4.0。
  **现状 = 相比 v0.3.0（`4b4b49c`）只保留 §6.1 设置栈与 §6.3 接管语义钉子；翻页导航一律用站点原生按钮。**

### 4.4 风控与停止条件（不变，重申）

- showpage 请求：串行泵、最小间隔 250ms（M3b 参数）、窗口深度 4、known/pending 去重；
- 翻译任务：调度器并发恒 1（16GB 显存约束）；
- 直连连续失败 ×3 且成功为 0 → **熔断**（本次文档生命周期不再发请求），遥测可见原因；
- 真机停止条件：出现一次 `Excessive request rate` → 停（调间隔）；行为与未装扩展不一致 → 停；
- **kill switch**：`content/index.ts` 的 `PREFETCH_ENABLED = false` 一键归零。

### 4.5 Gate-M4 真机验清单（保留）

14a + 14b + 14c 真机通过 + 连续快翻 10 页零风控（兑现 Gate-M3 拖欠项）→ **用户发话**才打 `v0.2.0-m4`：
① 刷新扩展 → 正常阅读（行为必须与没装预取时一致）；② Console 看 `document.documentElement.dataset.m5Chain`：
`dispatch.ok` 随翻页增长、`showkeyFound:true`、`executor.submitted > 0`；③ 在第 N 页等几秒 → 翻到 N+1：
目标=直接译图、底线=原图后立即译图、无整页刷新；④ 连续快翻 10 页无 `Excessive request rate`；
⑤ 弹窗「内存译图缓存」条数随预取增长。

### 4.6 「刻意不做（留待用户拍板）」记录

- **当前页自动翻译（P0）**：本轮只做**预载下一页**，当前页保持「点按钮才译」。
  要开自动译当前页，把执行器的窗口下界从 `distance ≥ 1` 放宽到 `≥ 0` 即可（一处常量）。
  → 后由设置栈的 `autoTranslateOnEnter` 兑现（默认关）。
- **M5b 全量页表**（见 §4.3）。
- **`data-m5-chain` 等 DOM 遥测**：当时无开关零消费者，最终在日志体系 M4 收口为 `telemetryDomEnabled`（默认关）。

---

## 五、遗留事项与已知环境坑

### 5.1 遗留事项（按优先级，已按 v0.5.4 状态更新）

**待用户实验 / 拍板**：
1. **偏移取证清场实验**（v0.4.1 后基本关闭，保留方法）：刷新所有打开过的 e-hentai 页 + 清 console + 重载扩展；
   若再报错且偏移 ≠ 30947/30694 → 新代码线索。
2. **预取撞车对照实验**：popup 预载数量设 0，对比手感。证实撞车后设计「预取让位/抢占」再实施（**本轮未动代码**）。
   > "变慢感"主嫌疑 = 手动翻译撞上在跑的预取任务（并发 1 不可抢占，最多等 ~7s）；管线单图正常区间 **2.3–7.3s**。
3. `data-m1-trace` 曾有"无开关零消费者"问题 → 已在日志体系收口（`telemetryDomEnabled`）。
4. `PageCacheManager` → 已删（v0.5.0）。

**已知留白 / 未覆盖**：
5. **PP-OCRv6 识别模型（76MB）仍在产物里**（被 release 元数据与 AMO 校验钉住，下架属独立发布变更）。
   → 见 §3.2-10。
6. **取消翻译时若已有 `/ocr` 请求在飞**，它会自然跑完再被丢弃（本地管线已中止），不影响正确性。
7. **内容脚本拿不到 settings** → 新开页面用默认缓存上限 200，弹窗打开时才把设置里的上限**推一次**给当前标签页。
8. **清空后当前页会重新 `ensure` 出一条空状态**，条数显示 1（那是"槽位"，不是译图）。
9. **画框用假 DOM 做单测**（测试环境是 node，无 jsdom）；真实浏览器下的对位/层级/缩放需真机验。
10. **IndexedDB 适配层的 `clear`/`trim` 无离线测试**（仓库无 `fake-indexeddb`）—— 策略层已由内存参照实现钉死，IDB 那侧靠真机验。

**可选优化候选（未实施）**：黑匣子心跳事件（证明构建已加载）、content/offscreen 黑匣子扩展、
offscreen broker host-ready 生成校验（防旧文档复用）、COEP manifest（WASM 多线程，有风险）、预取让位/抢占。

### 5.2 环境坑速查（Windows 本机）

- **cwd 每次命令后漂回 WorkBuddy 目录** → 命令一律 `cd /e/AI/dmbTranslatorV2/frontend && ...` 前缀，写在同一条命令里。
- 构建用 npm workspace 脚本：`npm run build:chromium:bundle --workspace=@dmb/extension`
  （firefox 同理 `build:firefox:bundle`；根目录没有裸的 firefox 脚本名）。vite 直接调用会 `MODULE_NOT_FOUND`（hoisted 到根 node_modules）。
- vitest node 环境 `globalThis` **无 addEventListener** → 测试先装收集器再 install。
- npx 在错误工作目录会拉 vitest@5 **假跑**（No test files found）→ 跑测试先确认 PWD。
- `check-release-boundaries.mjs` 的 `EBUSY` 时有时无；复现时改用 `build:firefox:bundle` + 产物哈希对比 + `node --check`。
- **`spawnSync node.exe EBUSY`**：`esbuild` 安装期自检与 `check-release-boundaries.mjs` 收尾语法检查都会 spawn `node` 子进程，
  受限沙箱/非交互环境里会 `EBUSY`（`npm install`/`build` 最后一步失败，**但产物其实是好的**）。
  绕过：`npm install --ignore-scripts` + 手动 `./node_modules/@esbuild/win32-x64/esbuild.exe --version`（应输出 0.25.12）+
  构建后手动 `node --check <产物>`。
- 真机日志在 `logs/`（`logs/<模型名>/YYYY-MM-DD.log` 控制台镜像 + `logs/events/YYYY-MM-DD.events.jsonl` 统一事件流）；
  离线验证工具：`probe/m0-pagekey/tools/selftest.cjs` 与 `replay.cjs`（探针目录已随 v0.5.3 清理，需要时从归档分支取）。
- minified 产物 `grep -c` 按行计恒 1，验标记用 `grep -o | wc -l`。
- MV3 探针 manifest 必须声明 `background.service_worker`，漏了 = 全链静默失效而 popup 照报成功。
- MV3 权限：无 `tabs` 权限时 `chrome.tabs.query` 照样返回 tab 但 `tab.url` 是 undefined，别用 url 判定。
- **UI 惯例**：popup 给 input 定宽必须带 `.panel` 前缀抬特异性，否则全局规则必赢（真踩过）；
  给弹窗加东西默认一行收纳，别做全宽按钮；`reached:false` = 未连接，绝不显示 0。
- **`const send = runtime.sendMessage; send(...)` 这种 detached 调用在 Chrome 会 `Illegal invocation`** —— 走仓库已有的 `sendRuntimeMessage`。

### 5.3 推进纪律（用户定，优先级最高）

**目的是完成项目要求，不是把现在的 bug 修好。** FAIL 先三分定性：
① 真机业务事实（动产品代码）；② 测量/工具误差（登记归档不修）；③ 本项目本就要修的目标本身（按里程碑推进）。
**严禁因为诊断器报 FAIL 就回去改诊断器。**
