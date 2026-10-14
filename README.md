# dmbTranslator

适配E站的阅读器，通过预载实现边看边翻，实时翻译

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
setup.cmd        :: 一键安装：建 .venv → 选 torch(CUDA/CPU) → 装依赖 → 下 manga-ocr 权重 →（有 Node 时）构建扩展
scripts\doctor.cmd --online      :: 环境自检 + 查端口
scripts\start_server.cmd         :: 本机服务 11436（OCR + 翻译）
scripts\start_ollama.cmd         :: Ollama 独立服务 11437（模型控制面板）
scripts\test_ocr.cmd             :: OCR 冒烟测试
```

- `.venv` 会建在**仓库根**（独立环境，不污染系统 Python）；装完直接用上面这些脚本，不用自己另建。
- 无人值守 / 换源：`DMB_PYTHON` · `DMB_TORCH=cpu|cu124` · `DMB_SKIP_FRONTEND=1` · `DMB_HF_MIRROR_ENDPOINT`（权重，默认 hf-mirror）· **`DMB_PIP_MIRROR`**（pip 依赖，默认清华；想走官方就设 `https://pypi.org/simple`）。
- 两个服务互不依赖：关掉 OCR/翻译照样能管模型；停 ollama 会先卸掉全部驻留模型再停引擎。

> **GPU 版 torch 下载卡住怎么办**（真机遇到过：官方源无声挂死）  
> 手动下载 → 丢进 `%LOCALAPPDATA%\dmbTranslator\tools\`（或下载文件夹 / 仓库根），再重跑 `setup.cmd`，脚本会**自动优先用本地 wheel**：
>
> - 地址：<https://mirrors.aliyun.com/pytorch-wheels/cu124/>（国内镜像）
> - 文件名：`torch-2.6.0+cu124-cp311-cp311-win_amd64.whl`（约 2.4 GB）
> - 必须匹配：Python **3.11** → `cp311`；64 位 Windows → `win_amd64`；**不要** `+cpu`（那是纯 CPU 版）
> - 也可以什么都不做：`setup.cmd` 会自己用 `curl` 从上面那个镜像下载（带进度、可重试）

### 4. 网络慢 / 下载总失败？提前下好这三样

`setup.cmd` 会自己下载它们，但国内网络下可能很慢或中断。**手动下好放进指定位置，脚本就会直接用**（不会重复下载）。

| 要下什么                     | 下载地址                                                                                                                                              | 放哪儿（脚本会自动识别）                                                                         | 大小      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- |
| **Python 3.11**（免安装版，首选） | <https://globalcdn.nuget.org/packages/python.3.11.9.nupkg>                                                                                        | `<仓库>\.tools\cache\tmp\dmb-python-3.11.9.nupkg`                                      | ~17 MB  |
| Python 3.11（官方安装器，仅兜底用）  | <https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe>                                                                                | `<仓库>\.tools\cache\tmp\dmb-python-3.11.9-amd64.exe`                                  | ~25 MB  |
| **Node 24**（便携版 zip）     | <https://npmmirror.com/mirrors/node/v24.21.0/node-v24.21.0-win-x64.zip>（国内）<br /><https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip>（官方） | `<仓库>\.tools\cache\tmp\node-v24.21.0-win-x64.zip`                                    | ~30 MB  |
| **torch（GPU 版）**         | <https://mirrors.aliyun.com/pytorch-wheels/cu124/> → 选 `torch-2.6.0+cu124-cp311-cp311-win_amd64.whl`                                              | 任选其一：`<仓库>\.tools\` · `%USERPROFILE%\Downloads\` · 仓库根 · 或用 `DMB_TORCH_WHEEL` 指到任意位置 | ~2.4 GB |

- **文件名必须一致**：放到 `<仓库>\.tools\cache\tmp\` 的那三个，文件名要和上表**逐字相同**（脚本按名字找）。
- **目录不用自己建**：先跑一次 `setup.cmd`（它会创建 `.tools\cache\tmp\`，也可能已经下了一部分），再把你下好的文件丢进去重跑即可。
- **torch 的匹配要求**：Python 3.11 → `cp311`；64 位 Windows → `win_amd64`；**不要 `+cpu`**（那是纯 CPU 版）。
- 这三样之后仍可**随时删掉**（`<仓库>\.tools\cache\tmp\` 只是下载缓存）；`<仓库>\.tools\python311`、`<仓库>\.tools\node24` 才是真正在用的运行环境。

> **一个原则**：所有下载、临时文件、pip/npm 缓存都放在**项目目录** `<仓库>\.tools\` 里（不占系统盘 ✗）；不想要时整个删掉 `.tools` 即可，重跑 `setup.cmd` 会重新准备。

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

| 现象                                   | 处理                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| 弹窗里缓存显示「**未连接**」                     | 当前标签页不是阅读页（停在 `chrome://` 或新标签页时本来就这样）。打开阅读页、等两秒、重开弹窗                               |
| 弹窗那栏显示「**—**」                        | 这次请求没拿到应答（多数是那页没有内容脚本）→ 刷新页面后重开弹窗                                                   |
| 翻译没反应 / 一直排队                         | `scripts\doctor.cmd --online` 看 11436 / 11437 是否在跑；模型控制面板：<http://127.0.0.1:11437/> |
| **翻译卡很久不结束**                         | 通用模型若带"思考模式"，会先吐几千 token 的思考过程。服务端已显式关闭思考；若仍出现，换用 Sakura 系模型                        |
| `npm install` 或构建最后一步报 `EBUSY`       | 受限环境已知问题，**产物其实是好的**：用 `npm install --ignore-scripts`，并手工 `node --check <产物>.js`    |
| `setup.cmd` 首屏吐一串假的「'xxx' 不是内部或外部命令」 | 该文件必须是 **GBK 编码 + `chcp 936`**；被另存成 UTF-8 就会这样 → `git checkout -- setup.cmd`        |

日志：`logs\<模型名>\YYYY-MM-DD.log`（控制台镜像）与 **`logs/events/YYYY-MM-DD.events.jsonl`**（排障首选）。

---

## 致谢与许可

本项目**复用**上游 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的浏览器端翻译管线  
（上游代码作为子目录 `frontend/` 纳入，pin `a5af759` / v0.8.3），在它之上另做了本机服务与预取调度。

| 组件                                                                     | 用途                            | 许可              |
| ---------------------------------------------------------------------- | ----------------------------- | --------------- |
| [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) | 浏览器端翻译管线（`frontend/`）         | GPL-3.0         |
| [manga-ocr](https://github.com/kha-white/manga-ocr)                    | 本地日文 OCR（`manga-ocr/`，vendor） | MIT（随行 LICENSE） |
| [SakuraLLM](https://github.com/SakuraLLM/SakuraLLM)                    | 日中翻译模型（可选）                    | 见上游仓库           |
| [Ollama](https://ollama.com/)                                          | 本地模型运行时（可选）                   | MIT             |

完整归属与第三方声明见 [`NOTICE`](NOTICE) 与 [`LICENSE`](LICENSE)（GPL-3.0）。

---

## 更多

架构与契约、上游关系与改动登记、变更编年史（含未修复问题清单）见 [`docs/`](docs/)：  
[ARCHITECTURE.md](docs/ARCHITECTURE.md) · [UPSTREAM.md](docs/UPSTREAM.md) · [CHANGELOG.md](docs/CHANGELOG.md)。  
脚本清单见 `scripts/`；发版打包用 `frontend/scripts/package-extensions.mjs`。

> 维护者注意：`setup.cmd` **必须保持 GBK + `chcp 936`**（改成 UTF-8 会首屏假报错、中文乱码）。
