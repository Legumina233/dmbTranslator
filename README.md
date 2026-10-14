# dmbTranslator V2

> 🚀 面向e-hentai/exhentai网页的 AI 就地翻译工具
>
> OCR + 图像处理 + LLM 翻译 + 浏览器扩展，让漫画无需下载即可直接在网页上阅读译文。

![License](https://img.shields.io/badge/license-GPL--3.0-blue.svg)

---

## ✨ 特性

- 🌐 **网页就地翻译** — 无需下载漫画，直接在支持的网站中翻译并显示译文
- 🔍 **漫画 OCR** — 自动识别漫画文本并进行处理
- 🤖 **多种 LLM 翻译** — 支持在线 LLM 与本地 Ollama
- 🏠 **本地模型** — 支持 GGUF / Sakura 等模型，可使用 Ollama 本地翻译
- ⚡ **连续阅读优化** — 支持缓存、预取和后台预热，减少翻页等待
- 🧩 **Chrome / Edge 扩展** — 通过浏览器扩展直接操作漫画网页

---

## 📦 环境要求

| 项目       | 要求                                   |
| -------- | ------------------------------------ |
| 系统 / 浏览器 | Windows 10 / 11（64 位）· Chrome / Edge |
| 磁盘       | 约 4 GB 以上（GPU 版 torch 另占约 2.4 GB）    |
| GPU（可选）  | 推荐 NVIDIA 显卡与兼容 CUDA；无独显可用 CPU 模式    |
| 安装程序自动准备 | 便携 Python 与 Node.js                  |
| 可选组件     | Ollama（本地模型）· 云端 LLM API Key（在线模型）   |

安装环境是隔离的：程序会在自身目录内创建 `.venv` 与便携运行环境，不向系统 Python 安装依赖，也不修改系统 `PATH`。

---

## 🚀 快速开始

### 1. 下载

从 Releases 下载：

```text
dmbTranslator-<version>-win64.zip
```

解压到任意目录。

---

### 2. 安装

两条路线任选其一，安装程序会自动完成所有环境准备；之后的步骤完全相同。

#### 路线 A · Release 包（推荐）

解压后运行：

```bat
setup.cmd
```

安装程序会自动完成：

- 准备便携 Python 与 Node.js，并创建隔离的 `.venv`（不向系统 Python 安装依赖，也不改系统 `PATH`）
- 安装 Python 依赖与 PyTorch / CUDA
- 下载 Manga OCR 权重（约 400 MB）
- 下载浏览器侧模型（约 200 MB，来自本仓库 Release，逐项校验 SHA-256）
- 校验扩展产物 —— 本包已带预构建扩展，**无需构建**
- 注册 Native Messaging Host，并检测 Ollama

#### 路线 B · 源码 / 克隆

使用 `dmbTranslator-<version>-src.zip`，或 `git clone` 本仓库，然后运行同一个 `setup.cmd`。

与路线 A 的唯一区别：包里没有预构建扩展，安装程序会自动准备便携 Node.js 并**现场构建扩展**（首次约 3~8 分钟）。

### 3. 安装浏览器扩展

在浏览器导航栏输入：

**Chrome**

```text
chrome://extensions
```

**Edge**

```text
edge://extensions
```

然后：

1. 开启「开发者模式」
2. 点击「加载已解压的扩展程序」
3. 进入：

```text
frontend/apps/extension/dist-chromium
```

1. 选择 `dist-chromium` 文件夹

---

### 4. 启动本地服务

从扩展的弹窗中启动本地服务与ollama服务，也可以通过如下命令启动：

```bat
scripts\start_server.cmd
scripts\start_ollama.cmd
```

### 5. 开始翻译

打开支持的漫画网页。

点击 dmbTranslator 扩展图标，或者使用页面工具栏触发翻译。

译文会就地显示在漫画页面上。

---

## 🤖 翻译模型

在扩展弹窗中的「模型来源」里二选一：

- **在线模型** —— 填 Provider、模型与 API Key；适合不想本地跑大模型、显存不足，或想用云端更强模型。
- **本地模型** —— 需先装 [Ollama](https://ollama.com/download)，再在「本地模型」里选择模型；扩展可查看 / 加载 / 卸载模型并显示驻留状态，避免多模型争用显存。

### 日文漫画推荐

日文漫画推荐 **Sakura 系列**（日译中微调，输出稳定、幻觉较少）：<https://huggingface.co/SakuraLLM>

用 GGUF + Ollama 加载，量化建议 **Q5_K_M 及以上**；14B 约需 12 GB 显存，显存不足就换更小尺寸或更低量化，或退回 CPU 推理。

---

## 📥 网络较慢怎么办？

首次安装需要下载 Python、Node.js、PyTorch、Manga OCR 权重与依赖。可以先手动下载下面三项，放进指定位置后 `setup.cmd` 会直接复用，不再重复下载：

- **Python 3.11（免安装版）** → `.tools\cache\tmp\dmb-python-3.11.9.nupkg`  
  <https://globalcdn.nuget.org/packages/python.3.11.9.nupkg>
- **Node 24（便携版）** → `.tools\cache\tmp\node-v24.21.0-win-x64.zip`  
  <https://npmmirror.com/mirrors/node/v24.21.0/node-v24.21.0-win-x64.zip>
- **torch（GPU 版）** → `.tools\`（或设 `DMB_TORCH_WHEEL` 指向该文件）  
  <https://mirrors.aliyun.com/pytorch-wheels/cu124/> 里选 `torch-2.6.0+cu124-cp311-cp311-win_amd64.whl`

文件名需与上面一致；`.tools\cache\tmp\` 仅为下载缓存，可随时清理。

---

## 🛠️ 项目结构

前端浏览器扩展负责网页交互与译文展示，本地服务负责 OCR、图像处理、翻译和模型管理。

```text
dmbTranslator/
├── frontend/          # 浏览器扩展及前端代码
├── server/            # 本机 Python 服务
├── manga-ocr/         # Manga OCR 相关代码 / 模型
├── scripts/           # 安装、启动、诊断脚本
├── docs/              # 项目文档（面向用户）
├── dev/               # 开发者文档与工具（不随发行包分发）
├── frontend/tests/    # 测试（在 frontend 内）
├── setup.cmd          # Windows 安装脚本
├── requirements.txt   # Python 依赖
├── LICENSE
└── NOTICE
```

---

## 🧩 技术基础

dmbTranslator V2 基于：

- Chrome / Edge Manifest V3
- TypeScript
- Python
- Manga OCR
- PyTorch
- Ollama
- LLM Translation
- 图像处理 Pipeline

项目大量复用了并改造了：

**ShinobuTranslator**

上游版本、修改范围、归属关系以及许可证要求请参阅：

- `docs/UPSTREAM.md`
- `NOTICE`
- `LICENSE`

---

## 🔐 隐私

使用本地 Ollama 模式时，翻译请求可以在本机完成，无需配置云端 LLM API Key。

使用在线模型时，相关文本 / 图像处理数据可能会发送给所选择的第三方模型服务。

请根据所使用的模型 Provider 的隐私政策自行判断。

---

## 📄 License

本项目使用：

**GPL-3.0**

详见：

```text
LICENSE
NOTICE
docs/UPSTREAM.md
```