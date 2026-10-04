# 服务端 v2（`server/`）说明

> 启动：`scripts\start_server.cmd`（默认 11436） 　控制面板：<http://127.0.0.1:11436/>

## 一、文件职责（v1 的单文件 1543 行拆成 10 个）

| 文件 | 职责 |
|---|---|
| `app.py` | 入口 + HTTP 路由（**OCR + 翻译**）。**只做 route → service**；模型/ollama 控制已拆走（见 §七） |
| `ollama_server.py` | ★ **独立服务（11437）**：启停 ollama 引擎 + 模型加载/卸载/状态。与 app.py 零依赖 |
| `config.py` | 不可变配置。**任何请求级数据都不许放这里** |
| `logging_.py` | 运行日志 / trace.jsonl / image.jsonl |
| `glossary.py` | 术语表热重载 + Sakura user prompt 拼装 |
| `sakura.py` | ★ **Sakura 适配层**：把通用请求规范成官方训练格式 |
| `backends.py` | 后端策略对象（Sakura / Generic）+ `BackendError` |
| `translate.py` | `RequestContext` + **唯一**翻译管线 |
| `ocr.py` | manga-ocr 加载 / 单张 / 批量 |
| `vram.py` | 模型解析、显存互斥、显式加载/卸载 |
| `panel.py` | 自带控制面板单页（加载/卸载按钮） |

## 二、Sakura 适配层（`sakura.py`）—— 为什么必须有

Sakura 是按官方语料训练的**专用**翻译模型。把通用指令（"你是专业译者…请输出 JSON"）
直接喂给它会**幻觉甚至崩坏**。所以调它之前必须规范化三件事：

| # | 规范化 | 不做的后果 |
|---|---|---|
| 1 | **消息只留两条**：system=官方提示词、user=官方模板。Shinobu 带来的其它指令一律丢弃 | 模型看到"输出 JSON"之类指令 → 输出结构而非译文 |
| 2 | **user 用官方句式**：有术语表 → `根据以下术语表（可以为空）：\n原文->译文\n将下面的日文文本根据对应关系和备注翻译成中文：<正文>`；无 → `将下面的日文文本翻译成中文：<正文>` | 偏离训练分布 → 幻觉/漏译 |
| 3 | **官方生成参数**：`temperature=0.1 / top_p=0.3 / repeat_penalty=1.0` + 停止串 | 输出发散、重复、带 `<|im_end|>` 尾巴 |

**另外两条防崩守则：**
- **上下文切块**：整页多行按 `MAX_INPUT_CHARS=1200` 切块，绝不一口气塞进去。
- **不可译文本不送模型**：纯 ASCII/数字/符号直接原样返回。
- **不二次包装**：Shinobu 若已发官方句式，先剥掉前缀再包装（`translate.extract_plain_original`）。

## 三、HTTP 接口

### 3.1 翻译 / OCR

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ocr` | `{images:[{id,data(base64),direction}]}` → `[{id,text,confidence}]` |
| POST | `/v1/chat/completions` | OpenAI 兼容。`{model, messages, stream}` |
| GET | `/v1/models` | 透传 Ollama `/api/tags`，前端下拉据此列出 |
| GET | `/health` | 健康检查（不触发模型加载） |

`messages` 的 user 文本支持三种形态，`translate.classify_input` 自动分流：

| 形态 | 触发 | 走向 |
|---|---|---|
| `regions` | 含 `输入数据：[...]` | 抽 region → 只译文本 → 服务端回填 `{regions:[{id,translation,columns}]}` |
| `plain` | 含 `原文：…`（或已是 Sakura 官方句式） | 单段翻译 |
| `native` | 都不含 | 通用模型原样转发；Sakura 则交给调用方（默认透传） |

### 3.2 模型控制（**已拆到独立服务 11437**，2026-10-04）

模型加载/卸载/状态**不再由本服务提供** —— 本服务只做 OCR + 翻译。
控制接口在 `ollama_server.py`（11437）：`GET /model/status`、`POST /model/load`、
`POST /model/unload`、`POST /model/unload-all`、`POST /service/start|stop`、`GET /`（控制面板）。
详见 §七。

> ★ **模型互斥**：16 GB 显存装不下两个模型。`load_model()` 会先卸载除目标外的全部驻留模型，
> 保证任意时刻只有一个模型在显存里（否则新模型只能部分 offload 到内存，速度暴跌甚至失败）。
> 实测：`load qwen3.5:4b` 时返回 `unloaded:["sakura-14b:latest"]`，驻留立刻只剩 qwen3.5:4b。

## 四、显存驻留策略

Ollama 默认在最后一次调用后 **静默 5 分钟卸载**模型 —— v1 就是这样：选完模型放着不动，
5 分钟后被悄悄卸掉，下次翻译又要冷加载 3~6 s，而且"已加载/未加载"对用户完全不可见。

v2 默认 `keep_alive = -1`（**永不过期**），卸载**只由显式 `/model/unload` 触发**。
想恢复自动卸载：`set DMB_KEEP_ALIVE=5m`。

> 硬约束提醒：16 GB 显存装不下两个模型。翻译前 `ensure_inactive_unloaded()` 会卸载其余模型。

## 五、v1 三个静默 P0 的修复对照

| P0 | v1 机制 | v2 做法 |
|---|---|---|
| **A** 日志静默丢条 6~21% | 全局 `_last_sakura_timing` 被缺 4 键的 `acc` **整体替换** → `KeyError` → 崩在写日志前 | **消灭全局变量**：计时写进 `ctx.stage`（每次请求独立对象）；纯函数 `ppl_geomean` / `stage_to_trace` 可单测 |
| **B** 2.5% 的"译文"其实是日文原文 | `call_sakura` 失败 `return ""` + `or x` | `Backend.translate_lines` **失败必抛 `BackendError`**；`_finalize` 断言非空；路由把错误以 502 显式返回 |
| **C** 记录永不写入 | `_send(200,…)` 排在记账之前 | **先记账，后响应**：`app._handle_chat` 里 `write_image_record()` → `trace_event()` → `self._send()` |

### 整页"配对"已删（2026-10-04 用户拍板）

原来的 `pages.py` 想把「同页 OCR + 同页翻译」合成一条 `kind=page` 记录（v1 的教训是
FIFO 猜测会错配，所以 v2 只认显式 pageKey）。**实测：它在真机从未生效** ——
扩展两端都不带 pageKey（翻译请求的 body 由 text-translation 包构造，包里没有 pageKey；
OCR 以前是浏览器本地跑的、根本不发 `/ocr`），
真机 481 条记录全是 `none(no pageKey)`，`kind=page` 一条都没有。

所以整套配对机制已删除，归档口径简化为：

* **翻译侧照旧落一条** `image.jsonl`（`translate_list` + 各阶段耗时），**没有配对、没有 pageKey**；
* **OCR 侧不再落归档**（没配对的纯噪音）；
* `pageKey` 这个标识本身保留 —— 它是扩展的页身份与译图缓存键，与本服务无关。

## 六、测试

| 命令 | 覆盖 | 依赖 |
|---|---|---|
| `python scripts\test_pure.py` | 27 项纯函数单测：切段、输入抽取、Sakura 官方格式、**OCR 置信度口径**、**强制卸载语义** | 零依赖 |
| `python scripts\test_server.py` | T1 健康 / T2 OCR / T3 简版翻译 + **翻译归档落盘** / T4 结构化 regions / T5 **失败必须显式** | 需服务端 + Ollama |

> 两个脚本都显式绕开系统代理 —— 环境里设了 `http_proxy` 而没设 `no_proxy` 时，
> urllib 会把 `127.0.0.1` 也塞给代理，拿回一个莫名其妙的 502（踩过）。


---

## 七、Ollama 与模型控制已拆成独立服务（2026-10-04 用户拍板）

### 为什么拆

原先"模型加载/卸载/状态"由 dmb_server（11436）提供 —— 于是**管模型这件事被绑死在
OCR/翻译服务上**：dmb_server 一关就管不了模型，开关与卸载状态互相牵连、还会"回弹"。
现在分成两个互不依赖的进程，各自开关：

| 进程 | 端口 | 职责 | 启动方式 |
|---|---|---|---|
| `app.py`（dmb_server） | 11436 | manga-ocr（`/ocr`）+ Sakura 规范化翻译（`/v1/chat/completions`） | `scripts\start_server.cmd` |
| `ollama_server.py` | 11437 | ollama 引擎启停 + 模型状态/加载/卸载 | `scripts\start_ollama.cmd` |
| （ollama 引擎本身） | 11434 | 推理 | 由 11437 服务拉起 |

扩展「点开关」链路：Native Messaging → `service_control` → **启停 11437 这个服务**，
不再直接启停 `ollama.exe`；dmb_server 那条链路完全不变。

### 关停/卸载的强制语义（用户口径：不能被"进程正在跑"卡住）

- **关闭 ollama**：`POST /service/stop`（或 `/shutdown`）→
  ① 先 `keep_alive:0` 卸载**全部驻留模型**（`vram.unload_model_forced`）→
  ② 再结束整棵进程树（`ollama app.exe` / `ollama.exe` / 模型 runner）→ ③ 确认端口关闭。
  **顺序不能反**：引擎先死就再也发不出卸载请求，显存只能被动释放，
  下次打开时那些模型还"算已加载" → 用户看到的就是"回弹"。
- **卸载单个模型**：`/model/unload` 走同一个强制路径 —— 温和请求后用 1s 宽限期确认；
  仍在驻留（典型：正在跑推理）就**直接结束 runner 进程**，不傻等。
  宽限 ≠ 阻塞：最多等 1 秒。
- 启动 11437 服务时会先确保引擎在跑，并后台清掉上次残留的驻留模型（状态干净）。

### 扩展侧改动

- OCR 引擎默认改为 `manga_ocr_server`（走 11436 的 `/ocr`，manga-ocr 本地 GPU），
  浏览器不再加载 ONNX 版 PaddleOCR；本地 provider 代码保留为备选。
  **服务不可用/报错 → 该页显式失败，绝不静默回退本地 ONNX。**
- 模型 UI 与 ollama 探活改指 11437（`localServiceClient.ollamaServiceBase`）。

### OCR 置信度口径（同批修）

真机实录：manga-ocr 的 `generation_config` 是 **`num_beams=4 / length_penalty=2.0`**（beam search）。
此时 `generate()` 的 `scores` 是「batch × beams」条分布，**无法按行归属**（同一张图单独跑 0.2144、
混在批量里变成 0.0 —— 8 个候选里找不到真值）。所以置信度改用 HF 的 `sequences_scores`
（返回序列自身的分数）反推平均每 token 负对数似然，再映射 `1/(1+NLL)` 到 0~1：

- 长度无关（原来用"概率的几何平均"，16 字正确文本只给 0.0257，而调用方以 0.3 判"可疑"，
  于是**每一行都白吃一个可疑信号**）；
- 批量/单行结果一致（原来批量下恒为 0）；
- 真机值：cc-100 样例 ≈ 0.399（文本完全正确）。

> 注：`sequences_scores` 在 beam search 下带 `length_penalty` 归一，反推时必须
> `score * len ** (penalty - 1)` 才能还原平均对数概率。
