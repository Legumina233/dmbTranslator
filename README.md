# dmbTranslator

在 e-hentai / ex-hentai 上读日文漫画：**翻到哪一页，就已经译好哪一页**。

检测 / 去字 / 排版 / 嵌字跑在浏览器（扩展），OCR 与翻译跑在**你自己电脑上**（manga-ocr + Ollama）——
图片和译文不出本机。也可以改用云端整图翻译（Nano Banana / Gemini），那就完全不需要本机服务。

当前版本 **v0.6.4** · 许可 **GPL-3.0**

---

## 特性

- **翻页即已译好**：看第 N 页时，后台把 N+1…N+4 提前译好，翻过去就是译文。
- **三种翻页方式都支持连翻**：方向键 / 网页自带的翻页键 / 点图片；快速连点 3 下就连走 3 页（上限 3 页）。
- **贴图时机以站点为准**：只在你真的翻到那一页之后才贴译文，不会"先贴错页再跳回"。
- **译图缓存**：译好的图存在本机（默认上限 15 张），刷新/重开浏览器都在，随时可一键清空。
- **两种翻译路线**：本机（离线、免费、有显卡更佳）或云端（不用装本机服务，需要 API Key）。

---

## 安装

### 1. 装扩展

**方式 A：用 Release 里的包（推荐）**

1. 到 [Releases](../../releases) 下载 `dmbTranslator-chromium-v*.zip`；
2. **解压到一个固定目录**（以后更新就覆盖它，别换地方）；
3. `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选中解压目录。

**方式 B：自己构建**（需要 Node 24）

```cmd
cd frontend
npm install
npm run build:extension:chromium      :: 产物在 apps\extension\dist-chromium
```

Firefox：`npm run build:extension:firefox`，再在 `about:debugging#/runtime/this-firefox` 里临时载入产物目录的 `manifest.json`。

### 2. 装本机服务（只用云端路线可跳过）

需要 **Python 3.11**。

```cmd
scripts\setup.cmd        :: 一键安装：建 .venv → 选 torch(CUDA/CPU) → 装依赖 → 下 manga-ocr 权重 →（有 Node 时）构建扩展
scripts\doctor.cmd --online      :: 环境自检 + 查端口
scripts\start_server.cmd         :: 本机服务 11436（OCR + 翻译）
scripts\start_ollama.cmd         :: Ollama 独立服务 11437（模型控制面板）
scripts\test_ocr.cmd             :: OCR 冒烟测试
```

- `.venv` 会建在**仓库根**（独立环境，不污染系统 Python）；装完直接用上面这些脚本，不用自己另建。
- 无人值守：`DMB_PYTHON` / `DMB_TORCH=cpu|cu124` / `DMB_SKIP_FRONTEND=1` / `DMB_HF_MIRROR_ENDPOINT`。
- 两个服务互不依赖：关掉 OCR/翻译照样能管模型；停 ollama 会先卸掉全部驻留模型再停引擎。

### 3. 获取模型（本机路线）

仓库自带 Modelfile（见 `server\modelfiles\`），按注释 `ollama create` 即可。
Sakura 系列权重来源：

- Hugging Face：[SakuraLLM/Sakura-14B-Qwen2.5-v1.0](https://huggingface.co/SakuraLLM/Sakura-14B-Qwen2.5-v1.0)（[GGUF 量化版](https://huggingface.co/SakuraLLM/Sakura-14B-Qwen2.5-v1.0-GGUF) · [exl2 版](https://huggingface.co/SakuraLLM/Sakura-14B-Qwen2.5-v1.0-exl2)）
- 项目主页：[github.com/SakuraLLM/SakuraLLM](https://github.com/SakuraLLM/SakuraLLM)（适配轻小说 / Galgame 的日中翻译大模型）

> **Sakura 会走专用管线**：服务端按官方训练格式规范化（官方提示词 + 生成参数 + 术语表），
> 这样它才不会幻觉/崩坏。**其它通用模型（qwen 等）与在线 API 走普通翻译管线**，不要混用。

---

## 用法

1. 确认本机服务在跑（`scripts\doctor.cmd --online` 能看到 11436 / 11437；云端路线可跳过）；
2. 打开阅读页 → **右下角**两个开关：「向后预载 N 页」（关掉再打开会回到上次设的值）与「进入自动翻译」；
3. 翻页随便用：`→` / 网页翻页键 / 点图片；快速连点会连翻；
4. 点工具栏图标打开弹窗：选翻译路线与模型、看/改**译图缓存**、改预载与自动翻译、导出诊断日志。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| 弹窗里缓存显示「**未连接**」 | 当前标签页不是阅读页（停在 `chrome://` 或新标签页时本来就这样）。打开阅读页、等两秒、重开弹窗 |
| 弹窗那栏显示「**—**」 | 这次请求没拿到应答（多数是那页没有内容脚本）→ 刷新页面后重开弹窗 |
| 翻译没反应 / 一直排队 | `scripts\doctor.cmd --online` 看 11436 / 11437 是否在跑；模型控制面板：<http://127.0.0.1:11437/> |
| **翻译卡很久不结束** | 通用模型若带"思考模式"，会先吐几千 token 的思考过程。服务端已显式关闭思考；若仍出现，换用 Sakura 系模型 |
| `npm install` 或构建最后一步报 `EBUSY` | 受限环境已知问题，**产物其实是好的**：用 `npm install --ignore-scripts`，并手工 `node --check <产物>.js` |
| `setup.cmd` 首屏吐一串假的「'xxx' 不是内部或外部命令」 | 该文件必须是 **GBK 编码 + `chcp 936`**；被另存成 UTF-8 就会这样 → `git checkout -- scripts/setup.cmd` |

日志：`logs\<模型名>\YYYY-MM-DD.log`（控制台镜像）与 **`logs/events/YYYY-MM-DD.events.jsonl`**（排障首选）。

---

## 致谢与许可

本项目**复用**上游 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的浏览器端翻译管线
（上游代码作为子目录 `frontend/` 纳入，pin `a5af759` / v0.8.3），在它之上另做了本机服务与预取调度。

| 组件 | 用途 | 许可 |
|---|---|---|
| [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) | 浏览器端翻译管线（`frontend/`） | GPL-3.0 |
| [manga-ocr](https://github.com/kha-white/manga-ocr) | 本地日文 OCR（`manga-ocr/`，vendor） | MIT（随行 LICENSE） |
| [SakuraLLM](https://github.com/SakuraLLM/SakuraLLM) | 日中翻译模型（可选） | 见上游仓库 |
| [Ollama](https://ollama.com/) | 本地模型运行时（可选） | MIT |

完整归属与第三方声明见 [`NOTICE`](NOTICE) 与 [`LICENSE`](LICENSE)（GPL-3.0）。

---

## 更多

架构与契约、上游关系与改动登记、变更编年史（含未修复问题清单）见 [`docs/`](docs/)：
[ARCHITECTURE.md](docs/ARCHITECTURE.md) · [UPSTREAM.md](docs/UPSTREAM.md) · [CHANGELOG.md](docs/CHANGELOG.md)。
脚本清单见 `scripts/`；发版打包用 `frontend/scripts/package-extensions.mjs`。

> 维护者注意：`scripts\setup.cmd` **必须保持 GBK + `chcp 936`**（改成 UTF-8 会首屏假报错、中文乱码）。
