# 设计笔记

本文记录「为什么是现在这个样子」，面向维护者，不是使用说明。
使用与安装见 [README](../README.md)，贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

---

## 品牌名与内部标识

本仓库分叉自上游 ShinobuTranslator，产品名已统一为 dmbTranslator。改名范围与边界：

- **已改**：npm 包 scope（`@dmb/*`）、产品文案、文件名前缀、构建/环境变量、调试用的
  window 全局（`__dmbBenchmark__` 等）、运行时探针开关（`__dmbPaddleOcr*`）。
- **刻意保留**：`README` / `NOTICE` / `CONTRIBUTING` / `PRIVACY_POLICY` 里的 fork 归属声明，
  以及指向上游的真实地址（模型 Release、Chrome 商店 slug、Cloudflare R2 bucket
  `shinobu-models`、Pages 域名）。这些不是"我们还没改完"，改了反而是错的。
- **刻意不改**：浏览器持久化标识 —— IndexedDB 库名 `shinobu-local-history` 与
  OPFS 根目录 `shinobu-translator`。改名会让老用户已有的本地历史与已下载模型
  变成孤立数据，收益只是内部字符串好看。代码里有注释标明原因。
- **已改且带兼容**：项目包格式 `shinobu-project` → `dmb-project`（导入两种都认，
  导出一律新名）；记住的 API Key 前缀 `shinobu:remembered-provider-key:v1:` →
  `dmb:...`（首次读到旧值时自动迁移到新 key）。

## 运行上下文

| 上下文 | 职责 |
| --- | --- |
| content script | 站点适配、界面、预取调度、发起翻译任务 |
| service worker | 消息路由、设置权威、LLM 代理、offscreen 宿主管理 |
| offscreen document | 运行 ONNX 图片流水线 |
| ONNX Web Worker | 模型推理（Comlink 桥接） |
| popup | 设置界面、本机服务状态 |
| 本机 Python 服务 | 11436（OCR + 翻译）、11437（Ollama 引擎与显存） |

| 阶段 | 运行位置 |
| --- | --- |
| 文字检测、气泡检测、擦除、排版嵌字 | 浏览器内 ONNX（WASM / WebNN） |
| OCR | 本机服务 11436 的 manga-ocr |
| 翻译 | 云端 LLM（OpenAI 兼容端点）或本机 Ollama |

设置只有**一份权威副本**，由 service worker 持有；popup 通过 Port 订阅推送，不轮询。

## 为什么必须有 offscreen document

MV3 的 service worker 没有 DOM、不能创建 Web Worker，而图片流水线全套依赖
canvas / Image / FontFace；扩展页 CSP 只允许 `worker-src 'self'`，因此只有扩展同源
文档能直接加载 ONNX Worker。三条约束叠加，offscreen 是唯一可行形态，不是设计偏好。

## 为什么 offscreen 宿主生命周期这么复杂

service worker 空闲约 30 秒会被挂起，模块级状态全部丢失，而 offscreen 文档可能仍存活
并持有失效的 Port。broker 因此做了：懒创建、并发合并、10 秒超时、一次性重建、
空闲 5 分钟先卸模型再关文档。删掉任何一环都会表现为**随机卡住或显存泄漏** ——
这类问题在开发环境很难复现，改动此处需格外谨慎。

## 为什么本机服务拆成两个进程

早期 OCR 与模型控制耦合在一个进程：OCR 一关就管不了模型，开关与卸载状态互相牵连。
拆成 11436（OCR + 翻译）与 11437（Ollama 引擎与显存）后两者互不依赖。

## 为什么译图缓存只在内存

译图是 blob URL，跨会话复用价值有限，而落盘会带来配额占用与失效管理的成本。
代价是刷新页面即失效。

## 为什么预取与手动翻译共用一条管线

两者都走 `ImageTranslationController`，只差一个 `trigger` 字段。
为预取另开一套实现是常见错误，这里避免了。

## 为什么 5 个阅读器引擎不能合并

对应 5 个平台的 5 种私有协议：BINB 需要 descramble、PUBLUS 有 V1 协议、
GigaViewer 有 TTB 分页、Comici 与 Clip Studio Reader 各有自己的结构。
这是真实站点多样性，不是投机抽象。

## 为什么日志是两条通道且不合并

- 事件流经 HTTP 写本机服务，**服务不可用时整条失效**
- 诊断日志写扩展本地存储，**永远可用**

错误黑匣子（未捕获异常）无条件记在本地 —— 它存在的意义就是「服务挂了的时候仍有证据」。
合并会让它在最需要的时候失效。

## 为什么「记录原文 / 译文」必须是独立开关且默认关闭

服务端 `eventlog.py` 的 `append_event()` 只校验 `kind` 就落盘，不看 verbose 标志；
`verbose_enabled()` 唯一调用点只管服务端自身事件。这意味着扩展侧若默认开启记录，
会**绕过服务端的隐私闸门**。

实测确认过：`logs/events/*.events.jsonl` 曾出现 627 次含逐行原文与译文的 `lines` 字段。
因此改为默认关闭、且必须父开关打开才可勾选。

## 已移除的能力（变更历史，非当前状态）

以下能力曾经存在，**当前代码已不支持**，列在这里仅为避免有人按旧文档寻找：

- 谷歌翻译（`google_web`）—— 已整体移除，翻译只有大模型一条路
- 处理模式「仅去字」「排版原文」—— 只剩「翻译」
- 浏览器内 PaddleOCR 作为可选 OCR 引擎 —— 引擎选择被归一化固定为 `manga_ocr_server`

## 已知未定位的问题

- **单页翻译耗时约 15–20 秒，服务端自报仅 2–5 秒**。开销在扩展侧，
  尚未定位到确定根因，不要凭直觉归因为某个具体阶段。
- **`bubble.onnx` 与 `aot_inpaint_512.onnx` 的许可证状态未决**
  （前者模型页标 Apache-2.0 而 ONNX 元数据标 Ultralytics AGPL-3.0，
  后者缺可复现的导出记录）。详见 `packages/model-manifest/publication-policy.json` 与
  [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。
- **`PP-OCRv6_medium_rec.onnx`（76 MB）仍会被下载并打进产物**，但当前配置下不会加载。
  清理它需要同时改模型清单、下载脚本与产物检查，属于未完成的收敛工作。
