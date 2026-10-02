# probe/m5-flashdiag —— 翻页闪屏诊断探针（2026-10-03）

> **一阶段一支全新探针**（用户纪律）。只观测、不拦截、不改站点行为。
> 目的：定位「切页时闪一下」的根因 —— 2026-10-03 首轮真机验（验一）发现：v3 的闪空页/NaN/尺寸跳变消失，
> 但切页出现新的「闪一下」（不装扩展与 0.1.x 时代均无此现象）。头号嫌疑是当时还在调站点 `api_call` 的预取链
> （已撤销，改隔离世界直连）；本探针负责**用证据定案**：直连版还有没有闪、若有，闪从哪来。

## 采集五路证据（一键全带走，用户零 F12 操作）

| 路 | 内容 | 回答什么 |
|---|---|---|
| 站点函数调用 | `load_image` / `apply_json_state` / `api_call` / `update_window_extents` / `scrollTo` 每次调用（赋值透传包装，**行为零改变**） | 站点内部时序；`apply_json_state` 实参类型（对象/字符串）= v2/v3 根因定案 |
| img#img src 变化 | MutationObserver 记 from→to 时间轴 | 图片何时换、换几次 |
| **layout-shift** | PerformanceObserver，带 value 与来源节点 | **闪屏的量化证据**（闪 = 位移条目） |
| api.php 全流量 | background webRequest（含 POST body 的 page 号），站点与生产预取链的请求都在 | 谁在什么时候要了哪一页 |
| F12 取证 | `load_image.toString()` / `update_window_extents.toString()` / `api_call.toString()` / `#i1` 形态 / img 父节点 | 站点源码（原需手动 Console 的全部指令已集成） |

另带生产扩展遥测（`data-m5-chain`：requested/received/dispatchOk/dispatchFail/endpointSource）。

## 用户操作（约 2 分钟）

1. `chrome://extensions` → 加载已解压 → 选 `probe/m5-flashdiag`
2. 打开 e-hentai/exhentai 阅读页，**正常翻 5 页左右**（闪一下该发生就让它发生）
3. 点探针图标 → 看一眼摘要 → 点「**保存到电脑**」→ 完事
   （落 `Downloads\dmb-probe\m5-flashdiag-<域名>-<时间>.json`，我直接读）

**注意**：探针装好后页面要刷新一次；换页继续有效（软导航不需要刷新）。

## 判读口径（我读文件时看什么）

- `segments[]`：每个用户动作一段 —— 段内 `apiPages` 出现「目标页之外的页号」= 预取链在动；
- `shiftCount/shiftValue`：>0 = 有视觉位移；`hadRecentInput=true` 的位移紧贴翻页动作 = 疑似闪屏时刻；
- `fnCalls`：`apply_json_state` 被调用次数应 = 站点自然翻页次数；异常多 = 有东西在调站点函数；
- `dumps.load_image / apply_json_state 实参类型`：v2/v3 根因定案。

## 自检

```
node tools/selftest.cjs
```

覆盖：文件名净化（路径穿越反向验证）、动作分段（正/反例）、render、全部 JS 语法。
