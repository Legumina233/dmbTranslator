# Phase 1 探针 —— 决定 e-hentai adapter 的写法

> ⚠️ 这是**历史记录**（当时的操作说明）：`probe/` 目录与 `dmb-probe-report*.json` 已从仓库移除（验完即删），
> 需要复现时从归档分支取。

> 这是全项目**唯一一个我无法自己做、且结论会改变代码结构**的实验。
> 预计 5 分钟。做完把 `dmb-probe-report.json` 发我即可。

---

## 一、为什么必须做

e-hentai 的 MPV 阅读器翻页是**两步异步**：`pushState` 先换地址，图**之后**才换。
v1 之所以写出 330 行的"投影 + 4 分支状态机"，根因是**扩展的内容脚本跑在隔离世界（ISOLATED），
拿不到站点全局**，只能自己 fetch 下一页 HTML + 正则抠图址 + 自己盖投影。

而 sorz 那个 ~100 行的预取脚本之所以短，是因为它跑在**页面主世界（MAIN）**，
可以直接用官方全局：

| 全局 | 作用 |
|---|---|
| `load_image` | 站点换图函数 |
| `apply_json_state` | 站点应用一页的 JSON 状态 |
| `api_call` | 站点 API 调用（`showpage` 取下一页） |
| `gid` / `imgkey` / `showkey` | 当前页标识，用于拼 `showpage` 请求 |

**如果主世界能拿到它们** → 我们也能写 ~100 行，省掉 330 行债。
**如果拿不到** → 只能走 v1 那条老路。

---

## 二、怎么做（照抄）

### 步骤 1：加载探针扩展

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择目录：`E:\AI\dmbTranslatorV2\probe\mainworld-probe`
5. 扩展列表里应出现 **"dmb probe (Phase 1)"**

> 用你**平时登录 e-hentai 的那个 Chrome 配置**，不要用新配置（否则没有登录态）。

### 步骤 2：走一遍正常阅读流程（关键，别跳）

1. 打开任意一个 e-hentai 画廊页面（`https://e-hentai.org/g/xxxxx/xxxxx`）
2. **点进 MPV 阅读器**（`https://e-hentai.org/mpv/xxxxx/xxxxx`）
3. 在 MPV 里**正常翻几页**（点下一页，翻 3~5 页）
4. 每翻一页，探针都会记录 `load_image` / `apply_json_state` 的调用

### 步骤 3：在 `/s/` 单图页也走一遍（可选但推荐）

1. 打开任意 `https://e-hentai.org/s/xxxxx/xxxxx-1` 单图页
2. 点右侧的下一页按钮翻 2~3 张

### 步骤 4：导出报告

1. 点击浏览器工具栏上的 **"dmb probe"** 图标
2. 面板会显示"已采集事件：N"（N 应该 > 0；若是 0，说明脚本没注入，见第四节）
3. 点 **"导出报告 JSON"**
4. 弹出保存框 → 保存 `dmb-probe-report.json`
5. **把这个文件发给我**

---

## 三、报告里的什么在回答什么

我拿到报告后看的是 `verdictHints` 和 `summary` 两段：

| 报告字段 | 含义 | 对应问题 |
|---|---|---|
| `everSeenOnWindow` / `everSeenBare` | 站点全局是否出现在 `window` 上（后者是裸标识符可见性） | **Q1 全局可见性** |
| `canHijack`（wrapped 列表） | 我们是否成功把 `load_image` / `apply_json_state` 换成了自己的包装 | **Q2 可否劫持** |
| `callCounts` | 翻页时这些函数被调了几次、参数长什么样 | **Q2 调用时机** |
| `instrumentNavigationWorks` | `history.pushState` 是否被我们拦到 | 验证手册那条"隔离世界 patch history 拦不到"的说法 |
| `hasSiteGlobals` | 三个关键函数里有几个是 function | 一句话结论 |

### 三种结果与对应决策

| 结果 | 判断 | 决策 |
|---|---|---|
| 三个关键函数都是 `function` 且可劫持 | **主世界桥可行** | 走主世界：Proxy + `showpage` 预取 + 缓存短路，**不写投影/状态机** |
| 只有一部分可见 / 劫持后站点报错 | **半可用（最坏情况）** | 混合：主世界只做预取取数，渲染仍走隔离世界投影 |
| 全部 `undefined` | **不可行** | 走 v1 老路：自己 fetch HTML + 自己盖投影，接受 330 行复杂度 |

---

## 四、采集数为 0 怎么办

按顺序排查：

1. **扩展是否真的注入了**：在 MPV 页面按 `F12` 开控制台，看有没有报错；
   在 Console 里敲 `typeof window.load_image` 看返回什么。
2. **是否在正确的页面**：探针只注入 `e-hentai.org` / `exhentai.org`。前缀不对不注入。
3. **是否加载后没刷新**：扩展在页面加载前注入（`document_start`），
   加载扩展后**已经打开的页面需要刷新一次**。
4. **Chrome 版本**：`world: "MAIN"` 需要 **Chrome 111+**。太老则不会注入主世界脚本。

> 独立于探针，你可以在 MPV 页面控制台**手动**敲这几行、把结果截图给我也行：
> ```js
> ['load_image','apply_json_state','api_call','gid','imgkey','showkey']
>   .map(n => n + '=' + typeof window[n]).join('\n')
> ```

---

## 五、做完之后

- ✅ 报告到手 → 我据此写出 `docs/ARCHITECTURE.md` 里 e-hentai adapter 的最终写法，进入 Phase 2/3
- ✅ 探针用 `probe/` 目录装，**验完即删**，不进主代码
- ⚠️ 在报告出来之前，我**不会**动 e-hentai adapter（避免白写 330 行）
