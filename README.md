# dmbTranslator · 使用手册

在 e-hentai / ex-hentai 上读日文漫画：**翻到哪一页，就已经译好哪一页**。

检测 / 去字 / 排版 / 嵌字跑在浏览器（扩展），OCR 与翻译跑在**你自己电脑上**
（manga-ocr + Ollama）—— 图片和译文不出本机。当前版本 **v0.6.4**。

---

## 1. 这个软件能做什么

| 能力 | 说明 |
|---|---|
| **翻页即已译好**（预载） | 看第 N 页时，后台把 N+1…N+4 提前译好；翻过去就是译文，不用等 |
| **三种翻页方式都支持连翻** | 方向键 / 网页自带的翻页键 / 直接点图片。快速连点 3 下就会连走 3 页（上限 3 页） |
| **贴图以站点为准** | 只在你**真的翻到**那一页之后才贴译文，不会出现"先贴错页、随后跳回" |
| **两种翻译路线** | ① **本机**：manga-ocr + Ollama（离线、免费、需要显卡更佳）；② **云端整图**：Nano Banana / Gemini（不用装本机服务） |
| **预载数量记忆** | 关掉预载再打开，回到你上次设的页数（例如 8），不会被重置成 4 |
| **译图缓存** | 译好的图存在本机（默认上限 15 张），刷新/重开浏览器都还在；随时可一键清空 |

---

## 2. 需要什么

| 项 | 要求 | 必需吗 |
|---|---|---|
| 浏览器 | Chrome / Edge（Chromium 版扩展） | ✅ 必需 |
| 本机服务 | **Python 3.11**（3.10 / 3.12 未验证） | 想用**本机**翻译才需要 |
| Node.js | **24**（仅"自己构建扩展"时需要；用 Release 里打好的包则不需要） | 可选 |
| Ollama | 任意近期版本 + 模型（见 3.3） | 想用**本机**翻译才需要 |
| 显卡 | NVIDIA（有则 OCR 快 10 倍以上；没有也能跑 CPU 版） | 可选 |

> 只想要"能用"、不想装 Python：可以走 **云端整图翻译**（扩展里选 Nano Banana / Gemini 并填 API Key），
> 本机服务可以不装。

---

## 3. 安装

### 3.1 装扩展（两种方式，选一种）

**方式 A：用 Release 里打好的包（推荐，最省事）**

1. 到 [Releases](../../releases) 下载 `dmbTranslator-chromium-v*.zip`；
2. **解压到一个固定目录**（以后更新就覆盖这个目录 —— 别每次换地方，否则扩展 ID 会变）；
3. 打开 `chrome://extensions` → 右上角打开「**开发者模式**」→「**加载已解压的扩展程序**」→ 选中刚才解压的目录；
4. 装载后，扩展图标应出现在工具栏，`chrome://extensions` 里能看到它。

**方式 B：自己构建（需要 Node 24）**

```cmd
cd frontend
npm install
npm run typecheck:extension
npm run build:extension:chromium      :: 产物在 apps\extension\dist-chromium
```

然后按上面第 3 步加载 `frontend\apps\extension\dist-chromium`。

> Firefox 用户：`npm run build:extension:firefox`，再在 `about:debugging#/runtime/this-firefox`
> 里「临时载入附加组件」选产物目录的 `manifest.json`。

### 3.2 装本机服务（想用本机翻译才需要）

**① 一键安装**（Windows；可重复执行，已完成的步骤会自动跳过、不会重复下载）

```cmd
scripts\setup.cmd
```

它按顺序做 5 步：

| 步 | 做什么 | 何时跳过 |
|---|---|---|
| 1/5 | 在**仓库根**建 `.venv`（独立环境，不污染系统 Python） | `.venv` 已存在 |
| 2/5 | 装 torch —— **交互式选 CUDA 版 / CPU 版** | `.venv\.gpu` 标记已存在 |
| 3/5 | `pip install -r requirements.txt` | — |
| 4/5 | 预下 manga-ocr 权重（约 400 MB，走 `hf-mirror.com`） | 权重目录已存在 |
| 5/5 | 可选装前端依赖（需要 Node） | 没有 npm，或设了 `DMB_SKIP_FRONTEND` |

无人值守可用环境变量：`DMB_PYTHON`（指定建 venv 的 python）、`DMB_TORCH=cpu|cu124`、
`DMB_SKIP_FRONTEND=1`、`DMB_HF_MIRROR_ENDPOINT`（默认 `https://hf-mirror.com`）。

> ⚠️ **`.venv` 固定建在仓库根**，`scripts\start_server.cmd` 等启动脚本按同一位置查找 ——
> 装完直接用那些脚本，**不要再自己另建 venv**。

**② 自检并启动**

```cmd
scripts\doctor.cmd --online      :: 环境自检（--online 顺带查端口与在跑的服务）
scripts\start_server.cmd         :: 本机服务 11436（OCR + 翻译）
scripts\start_ollama.cmd         :: Ollama 独立服务 11437（模型控制面板）
scripts\test_ocr.cmd             :: OCR 冒烟测试（需 11436 已启动）
```

两个服务**互不依赖**：关掉 OCR/翻译照样能管模型；停 ollama 会先卸掉全部驻留模型再停引擎。

### 3.3 下载翻译模型（本机路线的最后一步）

```cmd
ollama pull sakura-14b        :: 日→中 翻译
ollama pull qwen3.5:4b        :: 备用/通用
```

自定义 Modelfile 见 `server\modelfiles\`。

### 3.4（可选）让扩展能点按钮起停服务

```cmd
python scripts\install_native_host.py
```

装一次即可，不需要手工配置。
`--remove` 卸载。

---

## 4. 日常使用

1. 确认本机服务在跑（任务栏/`scripts\doctor.cmd --online` 能看到 11436、11437）；
2. 打开 e-hentai/ex-hentai 的阅读页；
3. **右下角**会出现两个开关：
   - 「**向后预载 N 页**」—— 决定提前译几页（0 = 关闭）；关掉再打开会回到你上次设的页数；
   - 「**进入自动翻译**」—— 进入新页是否自动翻译当前页；
4. 只想看当前页时，直接点页面上的**翻译按钮**即可；
5. 翻页随便用：`→` / 网页翻页键 / 点图片都行，**快速连点会连翻**（最多替你排 3 页）。

**弹窗里能做的事**（点工具栏图标）：

| 位置 | 用途 |
|---|---|
| 翻译路线 / 模型 | 选本机（Ollama）或云端（Nano Banana / Gemini，需 API Key） |
| 译图缓存 `N / 上限 张` | 看当前存了几张、改上限、**删除全部** |
| 向后预载 / 进入自动翻译 | 与页面右下角两个开关是同一份设置 |
| 「下载日志」 | 出问题时导出一份诊断日志给维护者 |

> 缓存行为：译图存在**本机落盘层**（默认上限 15 张，超出按写入先后丢弃最老的）。
> 刷新页面不影响它；「删除全部」会连落盘层一起清空。

---

## 5. 更新版本

1. 关掉扩展页面，把新包**解压覆盖到原来那个固定目录**；
2. `chrome://extensions` → 找到本扩展 → 点「🔄 **重新加载**」；
3. 本机服务若也有更新：`git pull`（或重新解压），然后重跑 `scripts\setup.cmd`（已完成步骤会自动跳过）。

> **始终用同一个目录**：扩展 ID 与"设置/缓存归属"都跟着它。换目录会导致 ID 变化、设置看起来"丢了"。

---

## 6. 出问题先看这里

| 现象 | 处理 |
|---|---|
| 弹窗里译图缓存显示「**未连接**」 | 说明这一次没读到页面侧的缓存。**先确认当前标签页是阅读页**（停在 `chrome://` 或新标签页时本来就该显示它），再打开一个阅读页、等两秒重开弹窗。若阅读页上也一直如此，请导出日志给维护者 |
| 弹窗里那栏显示「**—**」 | 请求没拿到应答（多数是当时那页没有内容脚本）。刷新页面后重开弹窗 |
| 翻译没反应 / 一直排队 | 看 `scripts\doctor.cmd --online`：11436 与 11437 是否在跑；Ollama 里模型是否已加载（`http://127.0.0.1:11437/` 有模型控制面板） |
| 改了预载页数但当前页面没变 | 点一次弹窗里的值让设置推给页面；仍无效就刷新页面 |
| `npm install` 或构建最后一步报 `EBUSY` | 受限环境下的已知问题，**产物其实是好的**。用 `npm install --ignore-scripts`，并手工补做语法检查：`node --check apps/extension/dist-chromium/content.js` |
| `scripts\setup.cmd` 首屏冒出一串假的「'xxx' 不是内部或外部命令」 | 该文件必须是 **GBK 编码 + `chcp 936`**；被另存成 UTF-8 就会这样（`git checkout -- scripts/setup.cmd` 恢复即可） |

**日志在哪**：`logs\<模型名>\YYYY-MM-DD.log`（控制台镜像）与
**`logs/events/YYYY-MM-DD.events.jsonl`**（统一事件流，排障首选）。

---

## 7. 目录一览

| 路径 | 说明 |
|---|---|
| `frontend/` | 扩展源码（上游 ShinobuTranslator `@ a5af759` / v0.8.3 作为子目录纳入）。产物在 `frontend/apps/extension/dist-chromium` |
| `server/` | 本机服务：`app.py`（OCR + 翻译，11436）、`ollama_server.py`（模型控制，11437） |
| `scripts/` | 安装 / 启动 / 停止 / 自检 / 冒烟 / 单测脚本（见 3.2 与 8） |
| `manga-ocr/` | vendor 的 manga-ocr 源码（只取识别部分） |
| `models/` · `run/` | 模型权重与运行时状态，**不入库** |
| `logs/` · `.cache/` · `.venv/` | 同样不入库 |
| `docs/` | [`ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`UPSTREAM.md`](docs/UPSTREAM.md)、[`CHANGELOG.md`](docs/CHANGELOG.md) |

---

## 8. 开发者：脚本与发布

| 脚本 | 用途 |
|---|---|
| `scripts\setup.cmd` | 一键安装（见 3.2） |
| `scripts\doctor.cmd` | 环境自检；`--online` 加查端口与在跑的服务 |
| `scripts\start_server.cmd` / `stop_server.cmd` | 起停本机服务 11436 |
| `scripts\start_ollama.cmd` / `stop_ollama.cmd` | 起停 Ollama 服务 11437（停止会先卸全部驻留模型） |
| `scripts\test_ocr.cmd` | OCR 冒烟测试 |
| `scripts\preflight.cmd` | 20 项环境预检（`--deep` 加做模型 sha256 校验） |
| `scripts\install_native_host.py` | 注册 Native Messaging 宿主（见 3.4） |
| `scripts\test_pure.py` / `test_server.py` | 服务端纯函数单测（36 项）/ 端到端 7 项 |

**测试与构建**（仓库根的 `frontend/`）：

```cmd
cd frontend
npm run typecheck:extension          :: 类型检查
npx vitest run                       :: 前端全量测试（186 文件 / 1607 用例）
npm run build:extension:chromium     :: 构建扩展（vite + content + worker + 发布边界检查）
```

**打发布包**（产出 `dmbTranslator-<target>-v<version>.zip` + `SHA256SUMS.txt`）：

```cmd
cd frontend
node scripts/package-extensions.mjs --chromium apps/extension/dist-chromium ^
                                    --firefox  apps/extension/dist-firefox  ^
                                    --artifacts artifacts
```

> **发版时只需上传扩展产物 ZIP**：GitHub 会自动为每个 Release 附带 Source code (zip / tar.gz)，Source code 由 GitHub 自动附带（服务党用源码包跑 scripts\setup.cmd）。

**版本号在哪**：`frontend/apps/extension/package.json` 的 `version`（构建时注入 manifest）。
当前 v0.6.4。

**维护者注意（改这些地方前先读）**：

- `scripts\setup.cmd` **必须保持 GBK 编码 + `chcp 936`** —— 改成 UTF-8 会让它首屏吐一串假报错、中文乱码；
- 本仓库与上游的关系、GPL 义务与"如何对账"见 [`docs/UPSTREAM.md`](docs/UPSTREAM.md)；
- 变更编年史（含未修复问题清单与环境坑速查）见 [`docs/CHANGELOG.md`](docs/CHANGELOG.md)。

---

## 9. 许可

本项目复用上游 [ShinobuTranslator](https://github.com/DonutShinobu/ShinobuTranslator) 的浏览器端管线，
整体以 **GPL-3.0** 发布；版权归属与第三方组件声明见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
