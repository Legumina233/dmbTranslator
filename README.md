# dmbTranslator

在 e-hentai / ex-hentai 上读日文漫画：**翻到哪一页，就已经译好哪一页**。

检测 / 去字 / 排版 / 嵌字跑在浏览器（复用上游 ShinobuTranslator 的管线），OCR 与翻译跑在本机
（manga-ocr + Ollama）。产品上真正要自己解决的问题只有一个：**预取**——让翻页时页已译好。

```
浏览器（扩展，代码在 frontend/）── 检测 / 去字 / 排版 / 嵌字 ──┐
                                                              │
        ┌─────────────────────────────────────────────────────▼──────────────────────────┐
        │  server/app.py          本机服务 11436（OCR + 翻译）                            │
        │    /ocr   manga-ocr                ← 本地 GPU                                  │
        │    /v1    Sakura 适配 → Ollama 11434                                           │
        └────────────────────────────────────────────────────────────────────────────────┘
        ┌────────────────────────────────────────────────────────────────────────────────┐
        │  server/ollama_server.py   Ollama 独立服务 11437                                │
        │    启停 ollama 引擎 + 模型加载 / 卸载 / 状态（与上一行零依赖）                   │
        └────────────────────────────────────────────────────────────────────────────────┘
```

> **两个服务互不依赖**：关掉 OCR / 翻译服务照样能管模型；关 ollama 会先卸全部驻留模型再停引擎
> （顺序反了会"回弹"）。扩展的 OCR 默认走 `/ocr` 的 manga-ocr，浏览器侧不再加载 ONNX 版 PaddleOCR。
> 详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 这个项目与上游是什么关系

本项目**复用**上游 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的浏览器端
翻译管线（检测 / 去字 / 排版 / 协议），在它之上**另做**了一层本机服务与预取调度。

- 上游代码 `@ a5af759`（v0.8.3）作为**子目录 `frontend/`** 纳入本仓库，与其余部分一起以 **GPL-3.0** 发布；
- 上游的接口（`SiteAdapter`、管线阶段、消息协议）被当作**稳定契约**使用，而不是把整个上游当成项目骨架；
- 本项目的原创部分是本机服务（`server/`，19 个文件 / 16 个 Python 模块）与约 20 个新增前端模块（预取链、调度器、事件流、支持包等）。

对上游的**每一处改动**都登记在 [`docs/UPSTREAM.md`](docs/UPSTREAM.md)，其中包括上游 pin、GPL 义务、
归属边界，以及与上游对账的可执行步骤。上游完整 git 历史（含本项目在其上的开发提交）另存为 git bundle 归档。

---

## 目录

| 路径 | 说明 |
| --- | --- |
| `frontend/` | 上游 ShinobuTranslator 复用目录（`@ a5af759` / v0.8.3）。npm workspace 根；扩展源码在 `frontend/apps/extension`，可复用包在 `frontend/packages` |
| `server/` | 本机服务（原创，19 文件 / 16 个 `.py`）：`app.py`（OCR + 翻译，11436）+ `ollama_server.py`（ollama 与模型控制，11437）+ `modelfiles/` |
| `requirements.txt` | 本机服务依赖清单。torch 由安装脚本按 GPU/CPU 单独装好；装依赖时直接 `pip install -r requirements.txt`（`torch>=2.0` 已满足不会被降级，加 `--no-deps` 反而会漏掉 transformers 的传递依赖） |
| `.upstream@a5af759` | 上游 pin 标记：仓库名 + commit + 版本 + 归档日期；`scripts/preflight.py` 会拿它校验 `frontend/` 是否对得上 |
| `manga-ocr/` | vendor 的 manga-ocr 源码（只取识别部分，靠 `sys.path` 挂载，未 pip 安装） |
| `scripts/` | 安装 / 启动 / 停止 / 自检 / 冒烟 / 单测脚本（详见下方「脚本一览」） |
| `docs/` | [`ARCHITECTURE.md`](docs/ARCHITECTURE.md)（架构与契约）、[`UPSTREAM.md`](docs/UPSTREAM.md)（上游关系与改动登记）、[`CHANGELOG.md`](docs/CHANGELOG.md)（变更编年史与审计结论） |
| `tests/fixtures/` | 服务端端到端脚本（`scripts/test_server.py`）用的夹具图片 |
| `logs/` | 运行日志：`logs/<模型名>/YYYY-MM-DD.log`（控制台镜像）+ **统一事件流** `logs/events/YYYY-MM-DD.events.jsonl`（排障首选） |
| `models/` · `run/` | 模型权重与运行时状态，不入库（`logs/` · `.cache/` · `.venv/` 同样不入库） |

---

## 安装

### 面向使用者

1. 前往 [Releases](../../releases) 下载对应浏览器的压缩包（`dmbTranslator-chromium-v*.zip` / `dmbTranslator-firefox-v*.zip`）
2. 解压到本地文件夹
3. Chrome / Edge：扩展管理页 → 打开「开发者模式」→「加载已解压的扩展程序」
   Firefox 140+：`about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选解压目录里的 `manifest.json`

本分叉没有上架商店，只能手动加载或从 Release 解压。

> 想立刻能用且**不需要本机服务**，可以走云端整图翻译路线（Nano Banana / Gemini）。
> 想用本地流水线，则要按下面的「从源码运行」起本机服务。

### 从源码运行

**① 一键安装**（Windows。可重复执行 —— 已完成的步骤会自动跳过，不会重复下载）

```cmd
scripts\setup.cmd
```

按顺序跑 5 步：

| 步 | 做什么 | 跳过条件 |
| --- | --- | --- |
| 1/5 | 在**仓库根**建 `.venv`（独立环境，不污染系统 Python） | 已存在 |
| 2/5 | 装 torch —— **交互式选 CUDA 版 / CPU 版** | `.venv\.gpu` 标记存在 |
| 3/5 | `pip install -r requirements.txt`（不加 `--no-deps`） | — |
| 4/5 | 预下 manga-ocr 权重（约 400 MB，走 `hf-mirror.com`） | 权重目录已存在 |
| 5/5 | 可选装前端依赖（需 Node） | 无 npm，或设了 `DMB_SKIP_FRONTEND` |

无人值守可用环境变量：`DMB_PYTHON`（指定建 venv 的解释器）、`DMB_TORCH=cpu|cu124`、
`DMB_SKIP_FRONTEND=1`、`DMB_HF_MIRROR_ENDPOINT`（默认 `https://hf-mirror.com`）。

> **`.venv` 固定建在仓库根**，`scripts\start_server.cmd` 等启动脚本按同一位置查找 ——
> 装完之后直接用那些脚本即可，**不要再自己另建 venv**。

**② 自检 + 起服务**

```cmd
scripts\doctor.cmd --online      :: 环境自检（--online 顺带查端口与在跑的服务）
scripts\start_server.cmd         :: 本机服务 11436（OCR + 翻译）
scripts\start_ollama.cmd         :: Ollama 独立服务 11437（模型控制面板）
scripts\test_ocr.cmd             :: 冒烟测试（需 11436 已启动）
```

想走「本地模型」翻译路线，本机还需有 Ollama 与模型：

```cmd
ollama pull sakura-14b
ollama pull qwen3.5:4b
```

（自定义 Modelfile 见 `server\modelfiles\`。）

**③ 构建扩展**（需 Node 24；上游 `engines` 要求 `^24`，Node 22 能装但有 `EBADENGINE` 警告）

```cmd
cd frontend
npm install
npm run typecheck:extension
npm run build:extension:chromium     :: 或 build:extension:firefox
```

**④ 打发布包**（产出 `dmbTranslator-<target>-v<version>.zip` + `SHA256SUMS.txt`）

```cmd
cd frontend
node scripts/package-extensions.mjs --chromium apps/extension/dist-chromium ^
                                    --firefox  apps/extension/dist-firefox  ^
                                    --artifacts artifacts
```

**⑤ 让扩展能「点按钮」起停本机服务**（可选，装一次）

```cmd
python scripts\install_native_host.py
```

**不需要手工抄扩展 ID** —— 脚本会读 `frontend/apps/extension/dist-chromium/manifest.json` 里的
`key`（固定公钥）反推出 ID，再写用户级注册表项
（`HKCU\...\NativeMessagingHosts\com.dmb.translator`，不需要管理员）。

之所以能这样，是因为 `frontend/apps/extension/manifest.ts` 给 chromium 分支钉了一把**固定公钥**：
Chrome 对没有 `key` 的未打包扩展，会拿**加载目录的绝对路径**做哈希当 ID —— 目录一挪、
换台机器、别人 clone 到别的路径，ID 全都不一样，宿主立刻失效并报
`Access to the specified native messaging host is forbidden`。钉了 `key` 之后
ID = SHA-256(公钥 DER) 前 16 字节映射 a-p，**与路径和机器无关**
（本仓库恒为 `nlfpkgiknddjehbagelkpblkgfcgpmhb`）。
私钥存在仓库外，不入库；只在自签 `.crx` 或首次上架 CWS 要用同一把 key 时才需要。

参数：`--dist <构建产物 manifest.json>` 指定非默认产物；`--force-launcher` 强制用 PyInstaller
重编 exe（默认 `run\nm_host_launcher.exe` 存在就复用）；`--remove` 卸载宿主。

> 首次钉 `key` 后扩展 ID 会变一次：去 `chrome://extensions` 把旧条目**移除**，再重新
> 「加载已解压的扩展程序」指向 `dist-chromium`。

`scripts\preflight.cmd`（20 项环境预检，含 ONNX 模型资产校验与 GPU 显存检查）仍然可用；
它假设的目录结构与当前仓库一致。

### 脚本一览

| 脚本 | 用途 |
| --- | --- |
| `scripts\setup.cmd` | 一键安装（上面 ①） |
| `scripts\doctor.cmd` | 环境自检；`--online` 加查端口与在跑的服务 |
| `scripts\start_server.cmd` / `stop_server.cmd` | 起停本机服务 11436 |
| `scripts\start_ollama.cmd` / `stop_ollama.cmd` | 起停 Ollama 独立服务 11437（停止会先卸全部驻留模型） |
| `scripts\test_ocr.cmd` | OCR 冒烟测试 |
| `scripts\preflight.cmd` | 20 项环境预检（`--deep` 加做模型 sha256 校验） |
| `scripts\install_native_host.py` | 注册 Native Messaging 宿主（上面 ⑤）；ID 自动反推，无需手工配 |
| `scripts\test_pure.py` | 服务端纯函数单测（36 项，不需要 torch/服务在跑） |
| `scripts\test_server.py` | 服务端端到端 7 项检查（**需 11436 + Ollama 在跑**） |

---

## 模型控制面板

服务端自带一个页面，**不用等扩展 UI**：

```
scripts\start_ollama.cmd
→ 打开 http://127.0.0.1:11437/
```

可**显式加载 / 卸载**模型，显示驻留明细与显存占用、启停 ollama 引擎。
（11436 那个页面只管 OCR / 翻译服务的健康检查与接口索引 —— 模型控制已随 v0.4.3 拆到 11437。）

> **驻留策略**：当前 `keep_alive = 15m`。最后一次调用后 15 分钟无请求，Ollama 自动卸载模型；
> **之后翻译无需手动加载**，请求会自动冷加载（约 3~6 s）。
> 改时长：`set DMB_KEEP_ALIVE=5m`（`300` / `0` 立即卸 / `-1` 永不过期）。

---

## 已验证

| 项 | 结果 |
|---|---|
| 本机服务环境自检 `scripts/doctor.py` | ✅ 覆盖 Python 版本 / 虚拟环境 / OCR 依赖 / 模型权重 / 服务端口 |
| `npm run typecheck:extension` | ✅ 通过 |
| `npm run build:extension:chromium` | ✅ vite 打包成功，产物齐（`content` 320K / `onnxWorker` 830K / `popup` 189K / `chunks` 410K；`models` 197M + `ort` 26M + `fonts` 13M 随包，整目录 237M）。最后一步 `check-release-boundaries.mjs` 在受限环境会踩下面的 `EBUSY`，手工 `node --check` 补过全部入口 |
| 服务端纯函数单测 `scripts/test_pure.py` | ✅ 36/36（`Ran 36 tests ... OK`，其中 3 项按环境 skip） |
| 服务端端到端 `scripts/test_server.py` | 7 项检查（T1 健康 / T2 OCR / T3 简版翻译 / T3b requestId 回显 / T3c 事件流落盘 / T4 结构化 regions / T5 失败显式报错）；**需服务端 + Ollama 在跑** |
| 模型加载 / 卸载接口 | ✅ 卸载→`(无)`；加载→5.7s、8290 MB 驻留 |

---

## 已知环境问题

**`spawnSync node.exe EBUSY`**：`esbuild` 的安装期自检、以及 `check-release-boundaries.mjs`
的收尾语法检查都会 spawn 一个 `node` 子进程。在**受限沙箱 / 非交互**环境里这个 spawn 会报 `EBUSY`，
导致 `npm install` 或 `build` 最后一步失败 —— **但产物其实是好的**。

```bash
# 装依赖时跳过脚本，再手动确认 esbuild 可用（二进制本身没问题）
npm install --ignore-scripts
./node_modules/@esbuild/win32-x64/esbuild.exe --version   # 应输出 0.25.12

# 构建后手动补做脚本本该做的语法检查
node --check apps/extension/dist-chromium/content.js
node --check apps/extension/dist-chromium/background-chromium.js
node --check apps/extension/dist-chromium/onnxWorker.js
```

在**你自己的普通终端**里一般不会遇到这个问题。更多环境坑与历史决策见
[`docs/CHANGELOG.md`](docs/CHANGELOG.md)。

**`scripts\setup.cmd` 存的是 GBK，不要另存为 UTF-8**：cmd.exe 解析批处理时按 **OEM 代码页**
（中文 Windows = 936）读字节。文件编码与它不一致时，行偏移会错位、从行中间切入，**首屏吐出一串
假的 `'xxx' 不是内部或外部命令`**，中文也跟着乱码。

实测（同一份内容、只换编码与 `chcp`，控制台起始 CP=936）：

| `setup.cmd` 编码 + 内部 `chcp` | 假报错 | 中文显示 |
| --- | --- | --- |
| **GBK + `chcp 936`（现状）** | **0 条** | **正常** |
| UTF-8 + `chcp 65001` | 9 ~ 10 条 | 乱码 |
| GBK + `chcp 65001` | 0 条 | 乱码（编码与 chcp 不匹配） |

所以 `setup.cmd` 单独存为 **GBK** 并把 `chcp` 固定为 **936**，文件头也写了这条警告 —— 改回 UTF-8 就会复发。
（其余 `.cmd` 的中文量小，冷启动未复现该问题，仍保持 UTF-8 + `chcp 65001`。）

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 架构总览、e-hentai 站点翻页机制与实测结论、`pageKey` 契约、预取流程、服务端接口与显存策略、依赖清单 |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | 上游 pin 与 GPL 义务、**如何对账**、归属边界（哪些复用 / 哪些改造 / 哪些新增）、对上游的全部改动登记 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Phase 0 → v0.5.4 变更与决策编年史、日志体系设计、三轮代码审计结论（含**未修复问题清单**）、环境坑速查 |
| [`LICENSE`](LICENSE) · [`NOTICE`](NOTICE) | GPL-3.0 全文；版权归属与第三方组件声明 |
