# dmbTranslator V2

漫画网页的**就地翻译**工具。本机服务（Python）负责 OCR 与图像处理，浏览器扩展（MV3）负责页面接管、渲染与交互；翻译通道可选云端模型（Gemini 等）或本机 Ollama。

## 环境要求

| 项        | 要求                                 |
| -------- | ---------------------------------- |
| 操作系统     | Windows 10 / 11（64 位）              |
| 网络       | 首次安装需联网：拉取便携运行环境、Python 依赖、模型权重    |
| 磁盘       | 约 4 GB 可用（GPU 版 torch 单独占约 2.4 GB） |
| 浏览器      | Chrome / Edge（MV3）                 |
| 本地翻译（可选） | Ollama 及至少一个模型                     |
| 云端翻译（可选） | Gemini 等服务的 API Key                |

运行环境是隔离的：安装过程只在解压目录内建立 `.venv` 与便携 Python，不向系统 Python 安装包，也不修改 `PATH`。

## 安装前建议：先下好这三个文件

安装需要联网拉取运行环境与依赖，网络不佳时容易中断。**建议先手动下载下表三个文件，放到对应位置**，`setup.cmd` 会直接复用，不再重复下载（目录不存在时先手动建一次即可）。

| 提前下载                                                                                                                 | 放置位置                                         |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Python 3.11（免安装版）<br /><https://globalcdn.nuget.org/packages/python.3.11.9.nupkg>                                    | `.tools\cache\tmp\dmb-python-3.11.9.nupkg`   |
| Node 24（便携版）<br /><https://npmmirror.com/mirrors/node/v24.21.0/node-v24.21.0-win-x64.zip>                            | `.tools\cache\tmp\node-v24.21.0-win-x64.zip` |
| torch（GPU 版）<br /><https://mirrors.aliyun.com/pytorch-wheels/cu124/> → `torch-2.6.0+cu124-cp311-cp311-win_amd64.whl` | `.tools\`（或用 `DMB_TORCH_WHEEL` 指向该文件）        |

路径中的 `.tools\` 指**解压目录下**的 `.tools`；文件名需与上表一致。`.tools\cache\tmp\` 仅为下载缓存，可随时清理。

## 安装

1. 下载 `dmbTranslator-<版本>-win64.zip`，解压到任意目录（建议非系统盘、路径不含特殊字符）。
2. 运行该目录下的 `setup.cmd`。脚本按 `[0/6]`–`[7/7]` 依次完成：准备便携 Python → 建立 `.venv` → 安装 torch（含 CUDA）与其余依赖 → 拉取 manga-ocr 权重 → 校验并按需构建扩展 → 注册 Native Messaging 宿主 → 探测并记住 Ollama 路径。`[7/7]` 可直接回车采用自动探测结果。
3. 载入浏览器扩展。构建产物已随包提供，位于**解压目录**下的 `frontend\apps\extension\dist-chromium`：
   - 地址栏输入 `chrome://extensions`（Edge 为 `edge://extensions`）并回车；
   - 打开页面右上角的**开发者模式**；
   - 点击**加载已解压的扩展程序**，在弹出的文件夹选择框中定位到解压目录，进入 `frontend\apps\extension\`，**选中 `dist-chromium` 这个文件夹本身**（不要进入它内部再选文件）；
   - 载入成功后列表里会出现 dmbTranslator 及版本号。若提示"无法加载清单"，说明上一步选错了目录，重新选择 `dist-chromium` 即可。

## 使用

1. 启动本机服务：点击扩展图标 → **启动服务**；或运行 `scripts\start_server.cmd`（OCR 与翻译，监听 11436）。
2. 打开漫画页面，从弹窗或页面工具栏触发翻译，译文会就地覆盖到原图上。
3. 在弹窗内选择翻译通道：云端填 API Key；本地则选择 Ollama 中的模型。

### 本地模型推荐

日文漫画翻译推荐 **Sakura** 系列（面向日译中微调，输出稳定、幻觉较少）：

- 项目主页与模型说明：<https://huggingface.co/SakuraLLM>
- 取用方式：下载其 GGUF 权重交由 Ollama 加载，或直接使用社区已转换的 Ollama 模型包。
- 量化建议 Q5_K_M 及以上；14B 级模型约需 12 GB 显存，显存不足可换更小尺寸或退回 CPU 推理。

## 常见问题

- **扩展报"无法为脚本加载 content.js / 无法加载清单"**：扩展目录选错。必须指向构建产物 `frontend\apps\extension\dist-chromium`。
- **扩展能加载，但弹窗按钮无响应**：本机服务未启动或宿主未注册。点弹窗内"启动服务"，或运行 `scripts\start_server.cmd`；若仍无效，重新运行 `setup.cmd`（会重新注册宿主）。
- **OCR 报错或翻译结果空白**：先自检运行环境：`.venv\Scripts\python.exe scripts\test_ocr.py`；整体自检可用 `scripts\doctor.cmd --online`。
- **没有 NVIDIA 显卡或显存不足**：先执行 `set DMB_TORCH=cpu`，再运行 `setup.cmd`。
- **端口被占用**：启动服务前设置 `set DMB_PORT=<端口>`。
- **下载缓慢或反复中断**：按上文"安装前建议"提前下载三个文件并放到对应位置。

## 许可与来源

许可见 `LICENSE`；第三方组件、模型来源与出处说明见 `NOTICE` 与 `docs\UPSTREAM.md`。
