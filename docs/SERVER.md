# 服务端 v2（`server/`）说明

> 启动：`scripts\start_server.cmd`（默认 11436） 　控制面板：<http://127.0.0.1:11436/>

## 一、文件职责（v1 的单文件 1543 行拆成 10 个）

| 文件 | 职责 |
|---|---|
| `app.py` | 入口 + HTTP 路由。**只做 route → service** |
| `config.py` | 不可变配置。**任何请求级数据都不许放这里** |
| `logging_.py` | 运行日志 / trace.jsonl / image.jsonl |
| `glossary.py` | 术语表热重载 + Sakura user prompt 拼装 |
| `sakura.py` | ★ **Sakura 适配层**：把通用请求规范成官方训练格式 |
| `backends.py` | 后端策略对象（Sakura / Generic）+ `BackendError` |
| `translate.py` | `RequestContext` + **唯一**翻译管线 |
| `pages.py` | 整页记录配对（**显式 pageKey**，不再是 FIFO） |
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
| POST | `/ocr` | `{images:[{id,data(base64),direction}], pageKey?}` → `[{id,text,confidence}]` |
| POST | `/v1/chat/completions` | OpenAI 兼容。`{model, messages, stream, pageKey?}` |
| GET | `/v1/models` | 透传 Ollama `/api/tags`，前端下拉据此列出 |
| GET | `/health` | 健康检查（不触发模型加载） |

`messages` 的 user 文本支持三种形态，`translate.classify_input` 自动分流：

| 形态 | 触发 | 走向 |
|---|---|---|
| `regions` | 含 `输入数据：[...]` | 抽 region → 只译文本 → 服务端回填 `{regions:[{id,translation,columns}]}` |
| `plain` | 含 `原文：…`（或已是 Sakura 官方句式） | 单段翻译 |
| `native` | 都不含 | 通用模型原样转发；Sakura 则交给调用方（默认透传） |

### 3.2 模型控制（解决"必须点开始翻译才加载"）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制面板（加载/卸载按钮、驻留明细、显存占用） |
| GET | `/model/status` | `{keep_alive, auto_unload, installed:[{name,loaded}], loaded:[…size_vram…]}` |
| POST | `/model/load` | `{model}` → 显式加载进显存。**加载前自动卸载其它驻留模型**；返回 `{ms, detail, unloaded:[…]}` |
| POST | `/model/unload` | `{model}` → 卸载 |
| POST | `/model/unload-all` | 卸载全部驻留模型 |

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
| **C** 记录永不写入 | `_send(200,…)` 排在记账之前 | **先记账，后响应**：`app._handle_chat` 里 `PAGES.complete()` → `trace_event()` → `self._send()` |

另外把 v1 的 **FIFO 配对**换成**显式 pageKey**（`pages.py`）：
* 同 key 的 OCR + 翻译 → 合成一条 `kind=page`
* 翻译到了但 OCR 没到 → 落 `kind=partial / pairing=translate-only`，**绝不拿别的页的 OCR 硬配**
* 超时只到一半 → 落 `kind=partial / pairing=incomplete(timeout)`

## 六、测试

| 命令 | 覆盖 | 依赖 |
|---|---|---|
| `python scripts\test_pure.py` | 20 项纯函数单测：切段、输入抽取、Sakura 官方格式、**pageKey 配对四条不变量** | 零依赖 |
| `python scripts\test_server.py` | T1 健康 / T2 OCR / T3 简版翻译 + **配对落盘** / T4 结构化 regions / T5 **失败必须显式** | 需服务端 + Ollama |

> 两个脚本都显式绕开系统代理 —— 环境里设了 `http_proxy` 而没设 `no_proxy` 时，
> urllib 会把 `127.0.0.1` 也塞给代理，拿回一个莫名其妙的 502（踩过）。
