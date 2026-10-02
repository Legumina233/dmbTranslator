# 架构决策 —— 基于 Phase 1 探针实测

> 数据来源：`dmb-probe-report.json`（2026-10-01 17:12，exhentai，6 次翻页，44 个事件）
> 探针：`probe/mainworld-probe`（MAIN world，Chrome MV3）

---

## 一、探针结论（三问全答）

| 问题 | 结论 | 证据 |
|---|---|---|
| **Q1 主世界能否拿到站点全局？** | ✅ **能** | `everSeenOnWindow` / `everSeenBare` 都含 `load_image`(function)、`apply_json_state`(function)、`api_call`(function)、`gid`(number)、`showkey`(string) |
| **Q2 能否劫持而不破坏站点？** | ✅ **能** | `wrappedOk = [api_call, load_image, apply_json_state]`；44 个事件、6 次翻页全程无 `call-error` |
| **Q3 翻页机制是否可短路？** | ✅ **基础具备** | `pushState` 6 次全部拦到（主世界 patch 有效） |

---

## 二、站点翻页机制（实测，这是最重要的产出）

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

**history 模式**：每页 `pushState → replaceState` 各一次（要 → 新地址，然后 `replaceState` 到同一地址）。
所以"翻页窗口"是真实存在的 —— 但**在主世界我们不需要自己去猜它**（见下）。

---

## 三、决策：走主世界桥 ✅

**结论：不需要写 v1 那 330 行的"自建投影 + 4 分支状态机"。**

原因：那 330 行的唯一成因是"内容脚本在隔离世界拿不到站点全局"。探针证明**加一个 `world: "MAIN"` 的 content script 就能拿到**，
于是可以直接复用站点自己的 `load_image` / `apply_json_state`，让站点按它原本的方式换图，
我们只在旁边**观察**和**缓存**。

代价从 330 行降到约 100 行（sorz 的量级）。

---

## 四、e-hentai adapter 设计（两层）

### L1a 主世界脚本 `ehentaiMainWorld.js`（不能用 `chrome.*`，只 `postMessage`）

职责只有三件：

1. **被动听 HTTP**（优先）：监听 `XMLHttpRequest` / `fetch`，抓站点自己的 `api.php` 响应
   → 零侵入拿到页 N 的 showpage JSON。**这是主路径，不依赖任何函数劫持。**
2. **主动取数**：由 N 的响应拿到 N+1 的 `{页号, imgkey}` → 自己调
   `window.api_call('{}', JSON.stringify({method:'showpage',gid,page,imgkey,showkey}), cb)` → 拿到 N+1 的响应
3. **短路**（唯一必须"劫持"的地方）：包 `load_image(页, imgkey)`，缓存命中时 →
   `pushState(url)` + `apply_json_state(cachedResp)` + **`return false`**（不调原函数、不发请求）→ 翻页零延迟

> ⚠️ **`return false` 是硬要求**：站点锚点是 `onclick="return load_image(…)" + href`，
> 只有返回 `false` 才取消默认跳转。返回 `undefined` 或抛异常都会导致**整页重载**（见 §6·补）。
>
> ⚠️ `world: "MAIN"` 需要 Chrome 111+；manifest 声明的内容脚本**不受页面 CSP 限制**。

### L1b 隔离世界 `ehentai.ts`（能读 DOM、能用 `chrome.*`）

1. 读 `img#img` 的 `src` → **这就是原图 URL**（站点自己设置的，我们不写它，所以不会破坏记账）
2. `postMessage` 桥：接收主世界的"页 key / 缓存命中 / 预取完成"事件
3. 产出 `ReadingPageReference` 交给 L2 的 `PageScheduler`
4. 渲染阅读条 / 悬浮按钮（`presentation: 'overlay-projection'` 仍保留，因为站点换图我们不改 `img.src`）

---

## 五、`pageKey` 契约（补上手册缺的那一环）

手册里 `pageKey` 被引用两处却从未定义。探针数据给出了天然答案：

```
pageKey = `${gid}-${page}`        例: "4218710-6"
```

- `gid` 从主世界全局读（`window.gid`，实测为 number）
- `page` 从 `load_image` 第 1 参数 或 `apply_json_state` 的 `p` 字段读
- **两端一致**：主世界生成、服务端只透传（`POST /ocr {pageKey}` / `POST /v1/chat/completions {pageKey}`）

该字段**必须写进数据模型真源表**，服务端与前端共用同一规则。

---

## 六、✅ showpage 响应结构（v1.2 实测确认，2026-10-01）

纯被动探针抓到 **10 条 `showpage` 响应**（`POST https://s.exhentai.org/api.php`，全部 200，各约 2.2 KB）。
字段固定 11 个：

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

1. **图片真实 URL 拿得到** —— 在 `i3` 的 `<img id="img" src="…">` 里（`src="([^"]+)"` 提取，
   `&amp;` 要还原成 `&`）。与站点实际设到 `img#img.src` 的值一致（实测完整抓到 12 个 `.webp` URL）。
2. **下一页 imgkey 拿得到** —— 在 `n` / `i3` 的 `load_image(下一页码, '下一imgkey')` 里。
   实测：页 129 的响应带 `load_image(130, '01c0b1df69')`。

### 预取流程（已被数据完全确定）

```
① 被动听站点自己的 showpage 响应（页 N）
     → 得 N 的图片 URL(i3) 和 N+1 的 {页号, imgkey}(n/i3)
② 自己调 api_call('{}', {method:"showpage", gid, page:N+1, imgkey, showkey}, cb)
     → 得 N+1 的图片 URL
③ 抓图 → OCR(manga-ocr) → 翻译(本地 LLM) → 按 pageKey 存缓存
④ 用户翻到 N+1：短路 load_image → pushState + apply_json_state(缓存响应) + return false
```

> ⚠️ **图片 URL 是签名的、带时效**（实测含 `keystamp=1790847300`，≈生成时刻）。
> 所以**不缓存 URL，只按 `pageKey` 缓存译好的图**，且预取到的图要尽快抓。

### pageKey（最终确定）

```
pageKey = `${gid}-${p}`       例: gid=4218710, p=129 → "4218710-129"
```
`gid` 读 `window.gid`（实测 number）；`p` 取 showpage 响应的 `p` 字段。前后端共用此规则，服务端只透传。

---

## 六·补 第二次探针（v1.1）暴露的新事实 ⚠️

第二次运行（`dmb-probe-report111.json`）**没拿到 showpage 响应** —— 6 次翻页里 `api_call` 一次都没触发。序列是：

```
call load_image("5","0b98c3ad02")
ERROR load_image: TypeError: Cannot read properties of undefined (reading 'length')
snapshot [document_start]        ← 整页重载
history replaceState -> /s/…-5
```

**由此得到一条对我们至关重要的设计约束：**

> 站点的翻页锚点是 `<a onclick="return load_image(1, '<imgkey>')" href="/s/…">`。
> **只有 `load_image` 返回 `false` 才会取消链接的默认跳转、走 SPA 原地换图**；
> 一旦它抛异常或返回非 `false`，浏览器就顺着 `href` **整页重载**。

→ **我们的缓存短路分支必须显式 `return false`**，否则"零延迟翻页"会变成"整页刷新"。这是 v1 那些"译完自动跳回上一页"类故障的又一个可能来源。

（该次 `load_image` 为何抛异常尚未定论；v1.2 已彻底放弃改写站点函数，改为纯被动观测，排除探针自身干扰。）

---

## 七、对手册的两处更正（实测推翻）

| 手册说法 | 实测 |
|---|---|
| v1 的 `instrumentNavigation()` 拦不到主世界 `pushState` | ✅ 部分正确，但**主世界 patch 是能拦到的** —— 探针在 MAIN world patch `history` 后拿到全部 6 次 `pushState` + 7 次 `replaceState`。所以"拦不到"是**隔离世界**的问题，不是"拦不到"本身 |
| 上游"48,300 行 / 189 文件" | ❌ 本机实测 **56,247 行 / 211 文件**（结论不变，且更该别重写） |
| "项目没有任何测试" | ❌ **干净上游自带 vitest 套件**（含 `tests/content/adapters/ehentai.test.ts`）。这条只对 v1 成立 |
