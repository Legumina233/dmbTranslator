# 架构总览

> 本文档最后更新：2026-10-09（仓库结构整理后）
> 本文合并原 `ARCHITECTURE.md` + `PHASE1_PROBE.md` + `SERVER.md` + `REFERENCES.md`。

---

## 〇、仓库结构（单仓库）

`E:/AI/dmbTranslatorV2` 是**一个** git 仓库（GPL-3.0）：

| 路径 | 说明 |
|---|---|
| `frontend/` | **上游 fork**（`DonutShinobu/ShinobuTranslator` @ `a5af759` / v0.8.3）。原 `shinobu/` 改名而来；内嵌 `.git` 已删除（历史备份为 git bundle），现为普通子目录纳入主仓库。本产品的全部扩展改动都在这里（对账见 `docs/UPSTREAM.md`） |
| `server/` | 本机 Python 服务（OCR + 翻译，11436 / 11437） |
| `scripts/` | 启动 / 停止 / 预检 / 冒烟 / 单测脚本 |
| `manga-ocr/` | vendor 的 manga-ocr 源码（只取识别部分，靠 `sys.path` 挂载，未 pip 安装） |
| `requirements.txt` | 服务端 Python 依赖 |
| `docs/` | 本项目文档（本文件所在目录） |

> 说明：历史上曾有一版"把服务端搬到 `frontend/local/`（合并两仓库）"的方案，**已废弃**。
> 服务端就在仓库根的 `server/`，其脚本在 `scripts/`，Python 虚拟环境在 `.venv/`。

---

## 一、总体架构

```
┌─────────────────────── repo: dmbTranslatorV2（单仓库，GPL-3.0）────────────────────────────┐
│                                                                                             │
│  frontend/  ← 上游 fork（DonutShinobu/ShinobuTranslator @ a5af759 / v0.8.3）                 │
│    浏览器扩展（Chromium MV3 / Firefox MV2）                                                  │
│      content（隔离世界）  站点交互 / 显示决策 / 检测·去字·排版·气泡 / 翻页预取                 │
│      background           设置权威 + 任务编排 + 消息路由                                      │
│      offscreen            ONNX 重活（检测 / 消字 / 排版）                                     │
│      popup                设置 UI / 本地模型与缓存控制                                         │
│           │  HTTP（本机回环）                                                                 │
│           ▼                                                                                  │
│  server/  本机 Python 服务                                                                   │
│      app.py            11436   OCR（/ocr，manga-ocr，本地 GPU）+ 翻译（/v1，Sakura 适配）      │
│      ollama_server.py  11437   ollama 引擎启停 + 模型加载/卸载/状态（与 11436 零依赖）         │
│           │  HTTP                                                                            │
│           ▼                                                                                  │
│      ollama 引擎       11434   推理                                                          │
│                                                                                             │
│  manga-ocr/（vendor 源码）   scripts/（启停脚本与测试）   docs/（文档）                        │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**职责划分的来源**：MV3 内容脚本（隔离世界）/ service worker / offscreen / popup 四个上下文是**平台强制**的；
"检测/去字/排版在浏览器、OCR 与翻译在本机服务"是产品的目标架构；显存 16 GB 只能单模型驻留 →
模型控制必须独立于 OCR/翻译服务。三者共同决定了上面的形状。

**唯一真正要自己解决的问题：预取。** 其余（检测 / 分割 / 去字 / 排版 / 协议）都由上游覆盖。

---

## 二、e-hentai 站点机制（Phase 1 探针实测）

> 数据来源：`dmb-probe-report.json`（2026-10-01 17:12，exhentai，6 次翻页，44 个事件）；
> 探针 `probe/mainworld-probe`（MAIN world，Chrome MV3）。
> 探针物**验完即删、已从仓库移除**，本节引用的是当时的实测记录。

### 2.1 探针结论（三问全答）

| 问题 | 结论 | 证据 |
|---|---|---|
| **Q1 主世界能否拿到站点全局？** | ✅ **能** | `everSeenOnWindow` / `everSeenBare` 都含 `load_image`(function)、`apply_json_state`(function)、`api_call`(function)、`gid`(number)、`showkey`(string) |
| **Q2 能否劫持而不破坏站点？** | ✅ **能** | `wrappedOk = [api_call, load_image, apply_json_state]`；44 个事件、6 次翻页全程无 `call-error` |
| **Q3 翻页机制是否可短路？** | ✅ **基础具备** | `pushState` 6 次全部拦到（主世界 patch 有效） |

### 2.2 翻页机制（实测，最重要的产出）

每翻一页，站点严格走**三步**：

```
① load_image(page, imgkey)                           ← 入口（也是 <a onclick> 直接调的）
② api_call({}, {"method":"showpage","gid":…,          ← 取该页 JSON
             "page":N,"imgkey":"…","showkey":"…"},
           callback)
③ apply_json_state(responseJsonString)               ← 把 JSON 落地成 DOM
```

真实序列（gid=4218710，showkey 全程 `k67kmy7anu9` 不变）：

| 页 | load_image | showpage 请求 |
|---|---|---|
| 5 | `load_image("5","0b98c3ad02")` | `page:5, imgkey:"0b98c3ad02"` |
| 6 | `load_image("6","3c42c4af78")` | `page:6, imgkey:"3c42c4af78"` |
| 7 | `load_image("7","9bfef05380")` | `page:7, imgkey:"9bfef05380"` |
| 8 | `load_image("8","d0e67db36f")` | `page:8, imgkey:"d0e67db36f"` |
| 9 | `load_image("9","7713484651")` | `page:9, imgkey:"7713484651"` |
| 10 | `load_image("10","85ec31467f")` | `page:10, imgkey:"85ec31467f"` |

`apply_json_state` 的 payload（截断可见部分）形状：

```json
{"p":6, "s":"s/3c42c4af78/4218710-6", "n":"<div class=\"sn\"><a onclick=\"return load_image(1, 'c56823c1cb')\" href=\"https://exhentai.org/s/…"}
```

- `p` = 页号
- `s` = 该页 URL slug，**天然包含 imgkey 与页号** → `s/{imgkey}/{gid}-{page}`
- `n` = 上/下页导航 HTML

**history 模式**：每页 `pushState → replaceState` 各一次（先到新地址，然后 `replaceState` 到同一地址）。
"翻页窗口"真实存在 —— 但在主世界**不需要自己去猜它**（见 §3）。

### 2.3 showpage 响应结构（v1.2 实测确认，2026-10-01）

纯被动探针抓到 **10 条 `showpage` 响应**（`POST https://s.exhentai.org/api.php`，全部 200，各约 2.2 KB）。
字段固定 **11 个**：

| 字段 | 实测示例 | 含义 |
|---|---|---|
| `p` | `129` | **页号**（pageKey 的一半） |
| `s` | `s/3b80705104/4218710-129` | URL slug（imgkey 前 10 位 + gid + 页号） |
| `n` | `<div class="sn">…</div>` | 导航 HTML：首/上/下/末页，每项都是 `load_image(页号,'imgkey')` + `href` |
| `i` | `<div>129.png :: 1280 x 1808 :: 411.1 KiB</div>` | 图片信息文字（**不是 URL**） |
| `k` | `3b80705104` | **当前页 imgkey** |
| **`i3`** | `<a onclick="return load_image(130,'01c0b1df69')" …><img id="img" src="https://…/129.webp"></a>` | ★ **当前页 `<img id="img">` 标签本体**，内含**该页图片真实 URL** |
| `i5` / `i6` | 返回画廊链接 / 工具条 | 界面元素 |
| `si` | `L5B` | 站点代号 |
| `x` / `y` | `1280` / `1808` | 图片尺寸 |

**两条决定性结论：**

1. **图片真实 URL 拿得到** —— 在 `i3` 的 `<img id="img" src="…">` 里（用 `src="([^"]+)"` 提取，`&amp;` 要还原成 `&`）。
   与站点实际设到 `img#img.src` 的值一致（实测完整抓到 12 个 `.webp` URL）。
2. **下一页 imgkey 拿得到** —— 在 `n` / `i3` 的 `load_image(下一页码, '下一imgkey')` 里。
   实测：页 129 的响应带 `load_image(130, '01c0b1df69')`。

> ⚠️ **图片 URL 是签名的、带时效**（实测含 `keystamp=1790847300`，≈生成时刻）。
> 所以**不缓存 URL，只按 `pageKey` 缓存译好的图**，且预取到的图要尽快抓。
> 任何含图址的缓存键必然永不命中（M0 教训）。

### 2.4 `pageKey` 契约

```
pageKey = `${gid}-${page}`        例: gid=4218710, page=129 → "4218710-129"
```

- `gid` 从主世界全局读（`window.gid`，实测为 number），或从 `location.pathname` 派生（`/s/{imgkey}/{gid}-{page}`）；
- `page` 从 `load_image` 第 1 参数、`apply_json_state` 的 `p` 字段、或 showpage 响应的 `p` 字段读；
- **格式只用于扩展侧**（页身份 / 译图缓存键）。**服务端不再消费 pageKey** ——
  整页配对机制已删（见 §四·7），服务端只把它当普通请求字段忽略，不参与任何配对或校验。

该字段必须写进数据模型真源表。

### 2.5 预取流程（已被数据完全确定）

```
① 被动听站点自己的 showpage 响应（页 N）
     → 得 N 的图片 URL(i3) 和 N+1 的 {页号, imgkey}(n/i3)
② 自己调 api_call('{}', {method:"showpage", gid, page:N+1, imgkey, showkey}, cb)
     → 得 N+1 的图片 URL
③ 抓图 → OCR(manga-ocr) → 翻译(本地 LLM) → 按 pageKey 存缓存
④ 用户翻到 N+1：短路 load_image → pushState + apply_json_state(缓存响应) + return false
```

**链式约束（决定算法形状）**：要请求第 P 页**必须持有 P 的 imgkey，而 imgkey 只在前一页的 JSON 里**
→ 天然是"逐跳接龙"。窗口边缘的推进必须从"已在手的 JSON"沿链找缺口，不能凭空跳过。

**风控参数（M3b）**：showpage 请求串行泵、最小间隔 **250 ms**、窗口深度 **4**、known/pending 去重；
直连连续失败 ×3 且成功为 0 → **熔断**（本次生命周期不再发请求）；流水线翻译并发**恒 1**（16 GB 显存约束）。

### 2.6 硬约束：短路分支必须 `return false`

第二次探针（v1.1）**没拿到 showpage 响应** —— 6 次翻页里 `api_call` 一次都没触发。序列是：

```
call load_image("5","0b98c3ad02")
ERROR load_image: TypeError: Cannot read properties of undefined (reading 'length')
snapshot [document_start]        ← 整页重载
history replaceState -> /s/…-5
```

由此得到一条关键设计约束：

> 站点的翻页锚点是 `<a onclick="return load_image(1, '<imgkey>')" href="/s/…">`。
> **只有 `load_image` 返回 `false`** 才会取消链接的默认跳转、走 SPA 原地换图；
> 一旦它抛异常或返回非 `false`，浏览器就顺着 `href` **整页重载**。

→ 任何缓存短路分支都必须显式 `return false`，否则"零延迟翻页"会变成"整页刷新"。
（该次 `load_image` 为何抛异常尚未定论；v1.2 已彻底放弃改写站点函数，改为纯被动观测。）

### 2.7 对手册的两处更正（实测推翻）

| 手册说法 | 实测 |
|---|---|
| v1 的 `instrumentNavigation()` 拦不到主世界 `pushState` | ✅ 部分正确：主世界 patch **是能拦到的**（探针在 MAIN world patch `history` 后拿到全部 6 次 `pushState` + 7 次 `replaceState`）。"拦不到"是**隔离世界**的问题 |
| 上游"48,300 行 / 189 文件" | ❌ 本机实测 **56,247 行 / 211 文件**（结论不变，且更该别重写） |
| "项目没有任何测试" | ❌ **干净上游自带 vitest 套件**（含 `tests/content/adapters/ehentai.test.ts`）。这条只对 v1 成立 |

---

## 三、适配器两层设计

### 3.1 主世界桥 —— 历史决策与现状

**当时的结论（2026-10-01）**：不需要写 v1 那 330 行的"自建投影 + 4 分支状态机"。
那 330 行的唯一成因是"内容脚本在隔离世界拿不到站点全局"；探针证明**加一个 `world: "MAIN"` 的
content script 就能拿到**，于是可以直接复用站点自己的 `load_image` / `apply_json_state`。
代价从 330 行降到约 100 行（sorz 的量级）。

> **现状（2026-10-04 起）**：**没有**落地主世界脚本，`ehentaiMainWorld.js` 已不存在。
> 实际方案是**隔离世界适配器 + 直连 `api.php` 的 showpage 预取**，
> 现行实现见 `content/core/scheduler/prefetchChain.ts`、`prefetchExecutor.ts`、`showpageClient.ts`。
> §3.1 保留的是当时的决策过程。

当时设计的两层如下（保留备查）：

**L1a 主世界脚本 `ehentaiMainWorld.js`（已废弃，未落地）** —— 不能用 `chrome.*`，只 `postMessage`。职责三件：

1. **被动听 HTTP（主路径）**：监听 `XMLHttpRequest` / `fetch`，抓站点自己的 `api.php` 响应 → 零侵入拿到页 N 的 showpage JSON。不依赖任何函数劫持。
2. **主动取数**：由 N 的响应拿到 N+1 的 `{页号, imgkey}` → 调 `window.api_call('{}', JSON.stringify({method:'showpage',gid,page,imgkey,showkey}), cb)`。
3. **短路**：包 `load_image(页, imgkey)`，缓存命中时 → `pushState(url)` + `apply_json_state(cachedResp)` + `return false`。

> ⚠️ `world: "MAIN"` 需要 Chrome 111+；manifest 声明的内容脚本不受页面 CSP 限制。
> 2026-10-03 奥卡姆审查后，主世界尖刺（文件 + manifest MAIN 声明 + 第二构建入口）已删除，
> `minimum_chrome_version` 从 111 回落到 109 —— 因为站点全局经真机证实为**函数声明、不可重定义**，
> 主世界脚本无存在理由。

**L1b 隔离世界 `ehentai.ts`**（能读 DOM、能用 `chrome.*`）职责：

1. 读 `img#img` 的 `src` → **这就是原图 URL**（站点自己设置的，我们不写它，所以不会破坏记账）；
2. 桥接"页 key / 缓存命中 / 预取完成"事件；
3. 产出 `ReadingPageReference` 交给 L2 的 `PageScheduler`；
4. 渲染阅读 UI（`presentation: 'overlay-projection'`）—— 站点换图我们不改 `img.src`。

### 3.2 e-hentai adapter 现状设计

- **翻页走站点原生软导航**（`api.php?f=showpage`），零整页重载；
- **预取链**（`prefetchChain.ts`）从 showpage JSON 的 `n` / `i3` 字段链式爬；
  **showkey 从页面内联 `<script>` 文本提取**（同时认 JSON 形态 `"showkey":"…"` 与赋值形态 `showkey = '…'`）；
- **端点推导**：exhentai → `https://s.exhentai.org/api.php`；e-hentai → `https://api.e-hentai.org/api.php`；
- **请求形态**：`POST` JSON 体 `{method:'showpage', gid, page, imgkey, showkey}`、带凭据、响应 JSON 含 `p` 字段
  （归档真机已验证：dispatchOk=4 / dispatchFail=0）；
- **显示**：站点 `<img>` 的 `src` 永不被改写，译图画在**常驻画框**上（见 §四·8）。

---

## 四、服务端 `server/`

> 启动：`scripts\start_server.cmd`（默认 11436）　控制面板：<http://127.0.0.1:11436/>

### 4.1 文件职责（v1 的单文件 1543 行拆成 16 个 .py）

| 文件 | 职责 |
|---|---|
| `app.py` | 入口 + HTTP 路由（**OCR + 翻译**）。**只做 route → service**；模型/ollama 控制已拆走（见 §4.5） |
| `ollama_server.py` | ★ **独立服务（11437）**：启停 ollama 引擎 + 模型加载/卸载/状态。与 app.py 零依赖 |
| `config.py` | 不可变配置。**任何请求级数据都不许放这里** |
| `logging_.py` | 运行日志 `.log`（**控制台镜像**；M4 起 `trace.jsonl` / `image.jsonl` 已下线） |
| `eventlog.py` | 统一事件流：唯一落点、requestId 贯穿、L1 详细层开关 |
| `support.py` | `GET /support` 支持包：读最近事件 + 现场算 summary + 服务端日志尾部 |
| `glossary.py` | 术语表热重载 + Sakura user prompt 拼装 |
| `sakura.py` | ★ **Sakura 适配层**：把通用请求规范成官方训练格式 |
| `backends.py` | 后端策略对象（Sakura / Generic）+ `BackendError` |
| `translate.py` | `RequestContext` + **唯一**翻译管线 |
| `ocr.py` | manga-ocr 加载 / 单张 / 批量 / 启动预载 |
| `vram.py` | 模型解析、显存互斥、显式加载/卸载 |
| `panel.py` | 自带页面**两张**：11436 服务页（健康 + 接口索引，无模型按钮）+ 11437 模型控制页（加载/卸载按钮在这里） |
| `service_control.py` | 本机服务 / Ollama 的静默启停、端口探活、进程树收尾 |
| `native_host.py` | Native Messaging 宿主：扩展点开关时代为启停本机服务 |
| `nm_launcher.py` | 被编译成无窗口 exe 的 NM 启动器；宿主清单指向它才不经 cmd.exe |

### 4.2 HTTP 接口

**翻译 / OCR（11436）**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ocr` | `{images:[{id,data(base64),direction}]}` → `[{id,text,confidence}]` |
| POST | `/v1/chat/completions` | OpenAI 兼容。`{model, messages, stream}`（`/api/chat` 同源入口） |
| GET | `/health` | 健康检查（不触发模型加载） |
| GET | `/support` | 支持包：读最近事件 + 现场算 summary + 服务端日志尾部 |
| POST | `/log/events` | 统一事件流落盘（唯一事件落点） |
| GET | `/` | 自带说明页（`/panel`、`/index.html` 同页） |

**其余路径原样转发 Ollama 11434**（`/log/*` 是本服务命名空间：未知端点直接 404，不转发）。
`GET /v1/models` 不在本服务 —— 见下。

**模型控制（已拆到独立服务 11437，2026-10-04）**：`GET /model/status`、`POST /model/load`、
`POST /model/unload`、`POST /model/unload-all`、`POST /service/start|stop`、`GET /v1/models`
（OpenAI 格式的模型列表）、`GET /`（控制面板）。

`messages` 的 user 文本支持三种形态，`translate.classify_input` 自动分流：

| 形态 | 触发 | 走向 |
|---|---|---|
| `regions` | 含 `输入数据：[...]` | 抽 region → 只译文本 → 服务端回填 `{regions:[{id,translation,columns}]}` |
| `plain` | 含 `原文：…`（或已是 Sakura 官方句式） | 单段翻译 |
| `native` | 都不含 | 通用模型原样转发；Sakura 则交给调用方（默认透传） |

### 4.3 Sakura 适配层（`sakura.py`）—— 为什么必须有

Sakura 是按官方语料训练的**专用**翻译模型。把通用指令（"你是专业译者…请输出 JSON"）直接喂给它会
**幻觉甚至崩坏**。所以调它之前必须规范化三件事：

| # | 规范化 | 不做的后果 |
|---|---|---|
| 1 | **消息只留两条**：system=官方提示词、user=官方模板。Shinobu 带来的其它指令一律丢弃 | 模型看到"输出 JSON"之类指令 → 输出结构而非译文 |
| 2 | **user 用官方句式**：有术语表 → `根据以下术语表（可以为空）：\n原文->译文\n将下面的日文文本根据对应关系和备注翻译成中文：<正文>`；无 → `将下面的日文文本翻译成中文：<正文>` | 偏离训练分布 → 幻觉/漏译 |
| 3 | **官方生成参数**：`temperature=0.1 / top_p=0.3 / repeat_penalty=1.0` + 停止串 | 输出发散、重复、带 `<|im_end|>` 尾巴 |

**另外三条防崩守则**：
- **上下文切块**：整页多行按 `MAX_INPUT_CHARS=1200` 切块，绝不一口气塞进去；
- **不可译文本不送模型**：纯 ASCII/数字/符号直接原样返回；
- **不二次包装**：Shinobu 若已发官方句式，先剥掉前缀再包装（`translate.extract_plain_original`）。

### 4.4 显存驻留策略

Ollama 默认在最后一次调用后 **静默 5 分钟卸载**模型 —— v1 就是这样：选完模型放着不动，
5 分钟后被悄悄卸掉，下次翻译又要冷加载 3~6 s，而且"已加载/未加载"对用户完全不可见。

v2 一度改为 `keep_alive = -1`（**永不过期**），卸载只由显式 `/model/unload` 触发；
**2026-10-06 用户拍板恢复自动卸载，TTL = 15 分钟**。

- 语义：最后一次调用起算，15 分钟没有新请求 → Ollama 自动卸载该模型；
- **卸载后不需要手动加载**：下一次翻译请求会带上 `keep_alive` 并触发 Ollama 自动冷加载（约 3~6 s），
  只是那一页多等几秒，不会报错、也不用去 11437 页面点"加载"；
- 想改时长：`set DMB_KEEP_ALIVE=5m`（或 `300` / `0` 立即卸 / `-1` 永不过期）。

> 硬约束：16 GB 显存装不下两个模型。`load_model()` 会先卸载除目标外的全部驻留模型，
> 保证任意时刻只有一个模型在显存里（否则新模型只能部分 offload 到内存，速度暴跌甚至失败）。
> 实测：`load qwen3.5:4b` 时返回 `unloaded:["sakura-14b:latest"]`，驻留立刻只剩 qwen3.5:4b。
> 翻译前 `ensure_inactive_unloaded()` 会卸载其余模型。

**OCR 启动预载（v0.5.2）**：`ocr.get_ocr()` 惰性加载会把首个 `/ocr` 请求拖到 ~13 s
（实测 fetchResolved=13121 ms vs 服务端 total_ms=743 ms；热态缺口仅 2~7 ms）。
`app.py` 起 daemon 线程调 `ocr.preload_ocr()`（幂等、失败只 log），HTTP 先起来、`/health` 立刻可用。
管辖边界（用户拍板）：**只管 manga-ocr**，不碰 `vram.py`、不做任何显存清空。

### 4.5 双服务拆分（11436 / 11437，2026-10-04 用户拍板）

**为什么拆**：原先"模型加载/卸载/状态"由 dmb_server（11436）提供 —— 于是**管模型这件事被绑死在
OCR/翻译服务上**：dmb_server 一关就管不了模型，开关与卸载状态互相牵连、还会"回弹"。
现在分成两个互不依赖的进程，各自开关：

| 进程 | 端口 | 职责 | 启动方式 |
|---|---|---|---|
| `app.py`（dmb_server） | 11436 | manga-ocr（`/ocr`）+ Sakura 规范化翻译（`/v1/chat/completions`） | `scripts\start_server.cmd` |
| `ollama_server.py` | 11437 | ollama 引擎启停 + 模型状态/加载/卸载 | `scripts\start_ollama.cmd` |
| （ollama 引擎本身） | 11434 | 推理 | 由 11437 服务拉起 |

扩展「点开关」链路：Native Messaging → `service_control` → **启停 11437 这个服务**，
不再直接启停 `ollama.exe`；dmb_server 那条链路完全不变。

**关停 / 卸载的强制语义**（用户口径：不能被"进程正在跑"卡住）：

- **关闭 ollama**：`POST /service/stop`（或 `/shutdown`）→
  ① 先 `keep_alive:0` 卸载**全部驻留模型**（`vram.unload_model_forced`）→
  ② 再结束整棵进程树（`ollama app.exe` / `ollama.exe` / 模型 runner）→ ③ 确认端口关闭。
  **顺序不能反**：引擎先死就再也发不出卸载请求，显存只能被动释放，
  下次打开时那些模型还"算已加载" → 用户看到的就是"回弹"。
- **卸载单个模型**：`/model/unload` 走同一个强制路径 —— 温和请求后用 1 s 宽限期确认；
  仍在驻留（典型：正在跑推理）就**直接结束 runner 进程**，不傻等。宽限 ≠ 阻塞：最多等 1 秒。
- 启动 11437 服务时会先确保引擎在跑，并后台清掉上次残留的驻留模型（状态干净）。

**扩展侧改动**：
- OCR 引擎默认改为 `manga_ocr_server`（走 11436 的 `/ocr`，manga-ocr 本地 GPU），
  浏览器不再加载 ONNX 版 PaddleOCR；本地 provider 代码保留为备选。
  **服务不可用/报错 → 该页显式失败，绝不静默回退本地 ONNX。**
- 模型 UI 与 ollama 探活改指 11437（`localServiceClient.ollamaServiceBase`）。

### 4.6 v1 三个静默 P0 的修复对照

| P0 | v1 机制 | v2 做法 |
|---|---|---|
| **A** 日志静默丢条 6~21% | 全局 `_last_sakura_timing` 被缺 4 键的 `acc` **整体替换** → `KeyError` → 崩在写日志前 | **消灭全局变量**：计时写进 `ctx.stage`（每次请求独立对象）；纯函数 `stage_to_trace` 可单测 |
| **B** 2.5% 的"译文"其实是日文原文 | `call_sakura` 失败 `return ""` + `or x` | `Backend.translate_lines` **失败必抛 `BackendError`**；`_finalize` 断言非空；路由把错误以 502 显式返回 |
| **C** 记录永不写入 | `_send(200,…)` 排在记账之前 | **先落盘，后响应**：`app._handle_chat` 里 `eventlog.append_event(...)` → `self._send()` |

### 4.7 整页"配对"已删 + 日志并入统一事件流（2026-10-04 ~ 10-05）

原来的 `pages.py` 想把「同页 OCR + 同页翻译」合成一条 `kind=page` 记录（v1 的教训是 FIFO 猜测会错配，
所以 v2 只认显式 pageKey）。**实测：它在真机从未生效** —— 扩展两端都不带 pageKey
（翻译请求的 body 由 text-translation 包构造，包里没有 pageKey；OCR 以前是浏览器本地跑的、根本不发 `/ocr`），
真机 481 条记录全是 `none(no pageKey)`，`kind=page` 一条都没有。**整套配对机制已删除。**

**M4 又往前走了一步：归档本身也并进了统一事件流**，`image.jsonl` 与 `trace.jsonl` 不再产生：

* 各阶段耗时 → 事件流 `llm.call` / `failure` 事件的 `what.stages`；
* 原文/译文（原 `image.jsonl` 的内容）→ **L1** 的 `log.verbose` 事件，
  环境变量 `DMB_EVENT_LOG_VERBOSE=1` 才写（**默认不写** —— "默认日志不含原文"是对用户的承诺）；
* `.log` 保留，但**不再承担排障**，只当控制台镜像用；
* `pageKey` 这个标识本身保留 —— 它是扩展的页身份与译图缓存键，与本服务无关。

### 4.8 译图只存内存 + 常驻画框（2026-10-03 用户拍板）

三件事一起做，因为它们是同一个问题的三面：**翻页时"空白 → 出图"那一下**。

1. **拆掉「等原图」闸门**：删掉 `TranslatorCore.applyStateImage` 里"原图 `load`/`error` 落定前绝不贴译图"
   的规则（来自 `5eb38b2`）。前提现在不成立：画框模式下我们根本不碰站点 `<img>`，那几秒等待纯属白等。
   预解码（`new Image()` + `decode()`）保留，只是不再当闸门用。
2. **常驻画框**（`content/core/overlay/translatedImageOverlay.ts`）：站点 `<img>` 的 `src` **永不被改写**，
   译图画在自己的常驻 `<img>` 上 —— 挂 `document.body`（站点重建图片 DOM 也动不到它）、绝对定位、
   跟随 `resize` + `ResizeObserver`、`pointer-events:none`。
   站点 `SiteAdapter` 新增可选 `applyOverlayImage(target, url | null)`，`url === null` = 隐身让原图露出。
   **层级序列**：画框 `2147483000` < 浮层按钮 `2147483001`（曾删的阅读栏是 `3002`）。新浮层按此往上排。
   > `z-index` 比大小**只在同一层叠上下文里成立** —— 数字大 ≠ 赢，先看挂哪。
   > 真踩过：按钮祖先 `#i1` 有 `position:relative; z-index:1`，按钮被困在该层叠上下文里，被画框压死；
   > 修法 = 锚点改挂 `document.body`。
3. **译图落盘暂时关闭**：`localPipelineClient.ts` 单一开关 `TRANSLATION_CACHE_PERSISTENCE_ENABLED = false`
   （读一律 miss、写一律 `false`，读写两关口都在这一个常量）。缓存只活在内容脚本内存，刷新即失——刻意的。
   内存层 `PhotoStateStore` **按条数管、不按字节**，默认上限 200、UI 可调；`setLimit` 调小**立刻裁**
   （淘汰只在写入时发生）。缓存管理走 `mt:memory-cache`（popup → background → content）；
   `MemoryCacheResult.reached` 区分"没连上内容脚本"与"缓存确实是空的" —— `reached:false` 显示"未连接"，**不显示 0**。

### 4.9 OCR 置信度口径（2026-10-04 修）

真机实录：manga-ocr 的 `generation_config` 是 **`num_beams=4 / length_penalty=2.0`**（beam search）。
此时 `generate()` 的 `scores` 是「batch × beams」条分布，**无法按行归属**
（同一张图单独跑 0.2144、混在批量里变成 0.0 —— 8 个候选里找不到真值）。
所以置信度改用 HF 的 `sequences_scores`（返回序列自身的分数）反推平均每 token 负对数似然，
再映射 `1/(1+NLL)` 到 0~1：

- 长度无关（原来用"概率的几何平均"，16 字正确文本只给 0.0257，而调用方以 0.3 判"可疑" →
  **每一行都白吃一个可疑信号**）；
- 批量/单行结果一致（原来批量下恒为 0）；
- 真机值：cc-100 样例 ≈ 0.399（文本完全正确）。

> 注：`sequences_scores` 在 beam search 下带 `length_penalty` 归一，反推时必须
> `score * len ** (penalty - 1)` 才能还原平均对数概率。
> 纯函数 `confidence_from_sequence_score` 异常返回 **0.0**（不是 1.0 —— "算不出来"不许当作"最可信"）。

### 4.10 测试

| 命令 | 覆盖 | 依赖 |
|---|---|---|
| `python scripts\test_pure.py` | 纯函数单测：切段、输入抽取、Sakura 官方格式、**OCR 置信度口径**、**强制卸载语义** | 零依赖 |
| `python scripts\test_server.py` | 端到端检查：T1 健康 / T2 OCR / T3 简版翻译 / T3b requestId 回显 / T3c 事件流落盘 / T4 结构化 regions / T5 失败显式报错 | 需服务端 + Ollama |

> 两个脚本都显式绕开系统代理 —— 环境里设了 `http_proxy` 而没设 `no_proxy` 时，
> urllib 会把 `127.0.0.1` 也塞给代理，拿回一个莫名其妙的 502（踩过）。

---

## 五、依赖与参考项目

> 原手册列了 16 个项目。**结论：唯一真正要自己解决的问题是「预取」，其余全有现成依赖或已被
> ShinobuTranslator 覆盖。** 所以清单从 16 砍到 6：4 个核心依赖 + 2 份直接讲预取的参考。

### 5.1 核心依赖 —— 必装（4）

| 项目 | 链接 | 角色 | 许可证 |
|---|---|---|---|
| **ShinobuTranslator** | https://github.com/DonutShinobu/ShinobuTranslator | **项目主体**。检测 / 分割 / 去字(inpaint) / 排版 / 协议全在它这儿，浏览器端跑。已 vendor 到 `frontend/`，pin `a5af759`（v0.8.3） | GPL-3.0 |
| **manga-ocr** | https://github.com/kha-white/manga-ocr | 日文漫画 OCR 模型，替代浏览器内 ONNX OCR。已 vendor 到 `manga-ocr/` | Apache-2.0 |
| **Ollama** | https://github.com/ollama/ollama | 本地 LLM 运行时（11434）。机器上已就位 | MIT |
| **SakuraLLM** | https://github.com/SakuraLLM/SakuraLLM | 日→中轻小说/漫画翻译模型（GGUF）。已 `ollama pull`（`sakura-14b` / `sakura-14b-qwen3-v1.5`） | CC-BY-NC-SA（**非商用**） |

> GalTransl 也只在 `ollama list` 里作为一个模型用（`galtransl-4b-v4`），**不需要它的仓库**，故不列入。

### 5.2 预取参考 —— 只留这两份（2）

**这是全项目唯一没有现成实现、必须自己拿主意的部分。只需读这两份。**

| 项目 | 链接 | 抄什么 |
|---|---|---|
| **sorz 的预取 gist** ★ | https://gist.github.com/sorz/714b547ce2101866075aeeffe77675f8 | **预取机制的最小正确实现（~100 行）**。Proxy 劫持站点全局 `apply_json_state` + `load_image`；用官方 API `showpage` 取下一页 JSON；**命中缓存时直接 `pushState` + `apply_json_state(resp)` 并 `return false`** → 翻页零延迟。它 `@grant none` 跑在**页面主世界**，这是它能这么短的原因 |
| **exhentai-manga-manager-change** ★ | https://github.com/lumiamilk/exhentai-manga-manager-change | **「当前页 ±N 优先队列 + 翻译缓存」策略**。README 原文：「智能翻译队列：优先翻译当前阅读页面及其前后几页」「翻译缓存：已翻译的页面自动缓存」。后端同构（manga-image-translator + llama-server/GalTransl）。注意：它服务**本地下载库**，不是在线站点 |

### 5.3 备查 —— 需要时再看（1）

| 项目 | 链接 | 抄什么 |
|---|---|---|
| libre-manga-translator | https://github.com/mrdhnto/libre-manga-translator | 架构最接近的浏览器扩展。可参考：**串行队列防爆显存**、**Series Context**（保留最近 5 条已译气泡作跨页上下文）、**Site Rule Adapters**。⚠️ 它是**滚动式触发**，不是翻页式预取；仓库内**无任何 e-hentai 适配**。设计参考，不抄代码 |

### 5.4 已删除 —— 不再需要（10）

砍掉的原因分三类：**① 已被 ShinobuTranslator 覆盖 ② 零翻译 ③ 形态不对**。

| 项目 | 砍掉原因 |
|---|---|
| GalTransl（仓库） | 只是模型来源，模型已在 ollama 里，仓库无用 |
| manga-image-translator | 漫画翻译管线的标准内核 —— **已由 ShinobuTranslator 的 `packages/image-pipeline` 覆盖** |
| cotrans | 后端基于 manga-image-translator，同上被覆盖 |
| comic-translate | LLM prompt 组织 / 手动修框 —— 上游已有等价物；无 e-hentai 适配、无预取 |
| ehentai_reader_script | E-Hentai SPA 阅读器，**零翻译** |
| Exhentai-Enhancer | 油猴脚本，**零翻译**，只增强 MPV |
| eh-view-enhance | 多站阅读/下载，**零翻译** |
| EH-Modern-Reader / Gallery-Reader | 多模式阅读 + 预加载，**零翻译**（其"预加载"是预**下载原图**，不是预**翻译**） |
| EhSyringe | 标签/界面翻译，**不碰图片内容** |
| exhentai-manga-manager（上游） | 漫画库管理，其 fork（§5.2）才是我们要读策略的那个 |

**仍然排除**：沉浸式翻译 / AI Manga Translator / Comic Translator（商业闭源）、koharu-rs（Rust 桌面应用，形态不对）、Dango-Translator / ImageTrans（屏幕截图 OCR）、ComicRead / eHunter / nHentai Helper（零翻译）。

### 5.5 市场结论（保留原判断）

`e-hentai 站内在线阅读 + 预取下一页 + 翻译` 这个精确组合**没有任何现成开源实现**
（GitHub API 搜 `e-hentai+prefetch` 只有 1 个结果且不含翻译；`manga+translation+prefetch` 是 0 结果）。
所以预取这块要自己设计 —— 但**只需要读 §5.2 那两份**就够了。

---

## 六、Phase 1 探针方法论（保留，操作流水压缩）

> ⚠️ 探针是**历史记录**：`probe/` 目录与 `dmb-probe-report*.json` 已从仓库移除（验完即删）。
> 需要复现时从归档分支取。本节保留的是**方法论**，即"怎么采、看什么、三种结果对应什么决策"。

### 6.1 为什么必须做这个实验

e-hentai 的 MPV 阅读器翻页是**两步异步**：`pushState` 先换地址，图**之后**才换。
v1 之所以写出 330 行的"投影 + 4 分支状态机"，根因是**扩展的内容脚本跑在隔离世界（ISOLATED），
拿不到站点全局**，只能自己 fetch 下一页 HTML + 正则抠图址 + 自己盖投影。

而 sorz 那个 ~100 行的预取脚本之所以短，是因为它跑在**页面主世界（MAIN）**，可以直接用官方全局：

| 全局 | 作用 |
|---|---|
| `load_image` | 站点换图函数 |
| `apply_json_state` | 站点应用一页的 JSON 状态 |
| `api_call` | 站点 API 调用（`showpage` 取下一页） |
| `gid` / `imgkey` / `showkey` | 当前页标识，用于拼 `showpage` 请求 |

**如果主世界能拿到它们** → 我们也能写 ~100 行，省掉 330 行债。**如果拿不到** → 只能走 v1 那条老路。

### 6.2 怎么采（压缩）

1. 用**平时登录 e-hentai 的那个 Chrome 配置**加载 `probe/mainworld-probe`（开发者模式 → 加载已解压的扩展）；
2. 进 MPV 阅读器（`https://e-hentai.org/mpv/xxxxx/xxxxx`）**正常翻 3~5 页**；
3. （可选）在 `/s/` 单图页再翻 2~3 张；
4. 点工具栏图标 →「导出报告 JSON」→ `dmb-probe-report.json`。

采集数为 0 时按序排查：扩展是否真注入（Console 敲 `typeof window.load_image`）→ 是否在
`e-hentai.org` / `exhentai.org` 页 → 加载扩展后是否刷新过页面（探针在 `document_start` 注入）→
Chrome 版本（`world: "MAIN"` 需要 Chrome 111+）。

### 6.3 看什么（报告字段 → 问题）

拿到报告后看 `verdictHints` 和 `summary` 两段：

| 报告字段 | 含义 | 对应问题 |
|---|---|---|
| `everSeenOnWindow` / `everSeenBare` | 站点全局是否出现在 `window` 上（后者是裸标识符可见性） | **Q1 全局可见性** |
| `canHijack`（wrapped 列表） | 我们是否成功把 `load_image` / `apply_json_state` 换成了自己的包装 | **Q2 可否劫持** |
| `callCounts` | 翻页时这些函数被调了几次、参数长什么样 | **Q2 调用时机** |
| `instrumentNavigationWorks` | `history.pushState` 是否被我们拦到 | 验证"隔离世界 patch history 拦不到"的说法 |
| `hasSiteGlobals` | 三个关键函数里有几个是 function | 一句话结论 |

### 6.4 三种结果与对应决策

| 结果 | 判断 | 决策 |
|---|---|---|
| 三个关键函数都是 `function` 且可劫持 | **主世界桥可行** | 走主世界：Proxy + `showpage` 预取 + 缓存短路，**不写投影/状态机** |
| 只有一部分可见 / 劫持后站点报错 | **半可用（最坏情况）** | 混合：主世界只做预取取数，渲染仍走隔离世界投影 |
| 全部 `undefined` | **不可行** | 走 v1 老路：自己 fetch HTML + 自己盖投影，接受 330 行复杂度 |

**实际结果**：三个关键函数都是 function 且可劫持 → Q1/Q2/Q3 全答 ✅。
但 2026-10-03 奥卡姆审查后放弃了主世界脚本（站点全局经真机证实为函数声明、不可重定义），
改为**隔离世界适配器 + 直连 `api.php` 的 showpage 预取**（见 §3.2）。

### 6.5 诊断器设计铁律（沿用）

- **判定里不许出现时间阈值**（QUIET_MS / settled 窗一律作废）：站点静默 ≠ 状态稳定；
- 优先用被测方自己声明的权威值（showpage 响应的 `p+k` 就是图身份），别自己轮询 DOM 找"稳定帧"；
- 采样/分段判定用**位置序列**（如 7→8→7 两段 = 两次访问），不用时间间隔；
- 信号拿不到判 `inconclusive`，不许空集通过、不许时间兜底；
- 探针 UI 不许打印假 success：先查 `chrome.runtime.lastError` 并确认副作用真的发生；
- 探针「0 数据」先分清「没采到」还是「采到了但为空」；
- 一个阶段一支独立诊断器，旧冻结归档；结论先沉淀再推进。
