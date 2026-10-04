# dmbTranslator v2

在 e-hentai / ex-hentai 上读日文漫画：**翻到哪一页，就已经译好哪一页**。
检测/去字/排版跑在浏览器（ShinobuTranslator 上游），OCR 与翻译跑在本地
（manga-ocr + Ollama）。**唯一真正要自己解决的问题：预取。**

```
浏览器(ShinobuTranslator 扩展) ──检测/去字/排版/气泡──┐
                                                   │
                    ┌──────────────────────────────▼───────────────────────────┐
                    │  server/app.py   本地服务 11436（OCR + 翻译）             │
                    │    /ocr  manga-ocr              ← 本地 GPU               │
                    │    /v1   Sakura 适配 → Ollama 11434                      │
                    └──────────────────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────────────────┐
                    │  server/ollama_server.py   Ollama 独立服务 11437          │
                    │    启停 ollama 引擎 + 模型加载/卸载/状态（与上一行零依赖） │
                    └──────────────────────────────────────────────────────────┘
```

> **两个服务互不依赖**（2026-10-04）：关掉 OCR/翻译服务照样能管模型；关 ollama 会
> 先卸全部驻留模型再停引擎（顺序反了会"回弹"）。扩展的 OCR 默认走 `/ocr` 的 manga-ocr，
> 浏览器侧不再加载 ONNX 版 PaddleOCR。详见 `docs/SERVER.md` §七。

## 目录

| 路径 | 说明 |
| --- | --- |
| `shinobu/` | **上游 fork**（DonutShinobu/ShinobuTranslator @ `a5af759` / v0.8.3 起）。自带 `.git`；本产品的全部改动都在这里（见 `docs/UPSTREAM_PATCHES.md`），与上游对账时用它 pin 的基线 diff |
| `manga-ocr/` | vendor 的 manga-ocr 源码（只取识别部分，靠 `sys.path` 挂载，未 pip 安装） |
| `server/` | 本地服务：`app.py`（OCR + 翻译，11436）+ `ollama_server.py`（ollama 与模型控制，11437） |
| `scripts/` | 启动 / 停止 / 预检 / 冒烟 / 单测脚本 |
| `probe/` | Phase 1 决定性实验用的浏览器探针（临时，验完即删） |
| `docs/` | 交接手册（含 v0.4.x 各版附节）、`SERVER.md`、`ARCHITECTURE.md`、`UPSTREAM_PATCHES.md`、三份阶段审计报告等 |
| `logs/` | 运行日志，按 `<模型名>/YYYY-MM-DD.*` |

## 当前进度

- [x] Phase 0 地基：`git init`、`.gitignore`、上游 pin、目录骨架
- [x] 上游 ShinobuTranslator 干净 clone @ `a5af759`
- [x] vendor manga-ocr、搬入上游 ONNX 资产（detector/inpaint/bubble/PP-OCRv6）
- [x] **Phase 1 探针**（已定案，见 `docs/PHASE1_PROBE.md` 与 `docs/ARCHITECTURE.md` 的 pageKey 契约）
- [x] 服务端 v2 + 单图页 `/s/` 悬浮按钮翻译跑通（首个里程碑）
- [x] M4 预取链 + 常驻画框 + 双服务（OCR/翻译 11436 ／ ollama 控制 11437）
- [x] OCR 改走本机服务 manga-ocr（浏览器侧不再加载 ONNX OCR）
- [x] 三轮代码审计 + 受控清尾（见 `docs/项目完结代码审计报告-*.md`）

## 起步

```cmd
:: 1) 环境预检（一键）
scripts\preflight.cmd

:: 2) 装依赖（上游 engines 要求 Node 24；Node 22 可装但有 EBADENGINE 警告）
cd shinobu && npm install

:: 3) 构建扩展
npm run typecheck:extension
npm run build:extension:chromium

:: 4) OCR 冒烟测试（需要一个在跑的服务端）
scripts\test_ocr.cmd
```

细节见 `docs/`。

## 已验证（2026-10-01）

| 项 | 结果 |
|---|---|
| 环境预检 `scripts/preflight.py` | ✅ FAIL=0（22 项） |
| `npm run typecheck:extension` | ✅ 通过 |
| `npm run build:extension:chromium` | ✅ vite 打包成功，产物齐（content 288K / onnxWorker 812K / popup 173K / models 随包） |
| 服务端纯函数单测 `scripts/test_pure.py` | ✅ **27/27** |
| 服务端端到端 `scripts/test_server.py` | 5 条路径（OCR / 翻译 / 归档落盘 / 结构化 regions / 失败显式报错）；**需服务端 + Ollama 在跑**，跑之前先 `scripts\start_server.cmd` |
| 模型加载/卸载接口 | ✅ 卸载→`(无)`；加载→5.7s、`keep_alive=-1`、8290 MB 驻留 |

## 模型控制面板

服务端自带一个页面（**不用等扩展 UI**）：

```
scripts\start_ollama.cmd
→ 打开 http://127.0.0.1:11437/
```

可**显式加载/卸载**模型，并显示驻留明细与显存占用、启停 ollama 引擎。
（11436 那个页面只管 OCR / 翻译服务的健康检查与接口索引 —— 模型控制已随 v0.4.3 拆到 11437。）

> **驻留策略已改**：Ollama 默认静默 5 分钟卸载模型，v2 默认 `keep_alive=-1`（永不过期），
> 卸载只由 `/model/unload` 触发。要恢复自动卸载：`set DMB_KEEP_ALIVE=5m`。
> 详见 `docs/SERVER.md`。

## 已知环境问题

**`spawnSync node.exe EBUSY`**：`esbuild` 的安装期自检、以及 `check-release-boundaries.mjs`
的收尾语法检查都会 spawn 一个 `node` 子进程。在**受限沙箱/非交互**环境里这个 spawn 会报 `EBUSY`，
导致 `npm install` 或 `build` 最后一步失败 —— **但产物其实是好的**。

验证/绕过方式：

```bash
# 装依赖时跳过脚本，再手动确认 esbuild 可用（二进制本身没问题）
npm install --ignore-scripts
./node_modules/@esbuild/win32-x64/esbuild.exe --version   # 应输出 0.25.12

# 构建后手动补做脚本本该做的语法检查
node --check apps/extension/dist-chromium/content.js
node --check apps/extension/dist-chromium/background-chromium.js
node --check apps/extension/dist-chromium/onnxWorker.js
```

在**你自己的普通终端**里一般不会遇到这个问题。
