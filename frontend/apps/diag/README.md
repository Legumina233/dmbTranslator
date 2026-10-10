# DMB 翻译计时诊断（独立小扩展）

只读诊断工具，**不修改、不依赖主扩展**（`apps/extension`）。用来回答一个问题：
「页面上看到的翻译耗时 15 秒，到底花在请求发出去之前还是服务端？」

## 安装

1. `chrome://extensions` 打开右上角「开发者模式」
2. 「加载已解压的扩展」→ 选本目录 `apps/diag/`
3. 之后每次改了这里的文件，回到 `chrome://extensions` 点刷新即可

## 用

1. 正常用主扩展翻几页图（想测多慢就照常翻，别刻意快/慢）
2. 点扩展图标 → 点「保存并上传」
3. 产物两处：
   - 下载目录里的 `dmb-diag-YYYYMMDD-HHmm.json`（完整事件，包含每一条带时间戳）
   - `E:/AI/dmbtranslatorV2/logs/events/2026-10-06.events.jsonl` 里多一条 `kind:"diag.dump"` 的摘要事件

## 它记什么

| 事件 | 含义 |
|---|---|
| `doc.start` | 内容脚本注入时刻（= 页面级的时间原点） |
| `stage.text` | 页面上出现某个阶段文字的时刻（文本检测 / 气泡 / OCR / 翻译待执行 / 翻译中 / 翻译完成）|
| `image.blob` | 页面上第一次出现 `blob:` 图片 = **肉眼看到的译文出来** |
| `lifecycle.*` | 页面 freeze / resume / visibilitychange / pagehide / 是否被 discard |
| `page.fetch` | 页面自己直连 11436 的往返（主扩展目前不走这条路，留着当观测点）|
| `meta.serverProbe` | 点导出那一下，SW 去打 `/health` 的往返耗时（**本地服务基线**）|
| `sw.probe` | 每 30 秒自动打一次 `/health`：**时刻 / 往返 ms / 本次 SW 已存活 ms** |

算出来的两个关键数：

- `translateVisibleMs` = `翻译待执行/翻译中` → `image.blob`：**页面上看到的翻译耗时**
- `ocrVisibleMs` = `OCR` → `翻译待执行`

拿这两个数去和服务端日志里的 `llm.call.total_ms` 一比：

- 若 `translateVisibleMs ≈ 15000` 而 `total_ms ≈ 1000` → 15 秒花在「请求还没发出去」
- 若两者接近 → 15 秒就是服务端在跑，往 `sakura_generate_ms` / ollama 那边查

## 生命周期那几条的用处

如果慢的那几页在日志里都夹着 `lifecycle.freeze` / `visibility.hidden`，
说明是 Chrome 把标签页冻结了、请求在冻结期间被挂住 —— 那就是机器/浏览器侧的原因，
跟扩展代码无关，关掉 Chrome 的标签页冻结即可。

## `sw.probe` 时间线怎么读（这次主要靠它）

`sw.probe` 是**诊断扩展自己的 SW** 每 30 秒打出去的 `/health`，和主扩展那条路完全无关。
它在 dump 里是 `payload.healthTimeline`，事件流里是 `what.healthLog`。三种结果三种结论：

| 现象 | 结论 |
|---|---|
| probe 全程稳定在几十 ms，但 `translateVisibleMs` 仍是 15 秒 | 扩展→本机服务的通道是好的，15 秒**卡在主扩展自己内部**（发请求之前那段）。去看流水线组装 / offscreen 宿主重连 |
| probe 也随时间一起变慢 | 慢在机器或本机服务本身，与扩展无关 |
| probe 的 ms 忽大忽小、`swAliveMs` 频繁从 0 重新算 | 扩展的 SW 一直在冷启动，是 MV3 短命 SW 的正常现象，但说明它撑不住 |

## 导出后给我看什么

1. **下载目录**里的 `dmb-diag-YYYYMMDD-HHmm.json` —— 完整，带每一条原始时间戳
2. **`logs/events/<日期>.events.jsonl`** 最后一条 `kind:"diag.dump"` —— 已经自动投进去了，我直接就能读

如果两个都拿不到，至少把 popup 上显示的那几行数字（已采集事件 / 本地服务往返 / 可见翻译耗时 / 探针最近）截图给我也行。

## 卸载

删掉这个目录就行，主扩展一点关系没有：

```bash
rm -rf apps/diag
```
