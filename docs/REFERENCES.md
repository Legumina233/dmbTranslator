# 参考项目清单（已精简）

> 原手册列了 16 个项目。**结论：唯一真正要自己解决的问题是「预取」，其余全有现成依赖或已被 ShinobuTranslator 覆盖。**
> 所以清单从 16 砍到 6：4 个核心依赖 + 2 份直接讲预取的参考。

---

## 一、核心依赖 —— 必装（4）

| 项目 | 链接 | 角色 | 许可证 |
|---|---|---|---|
| **ShinobuTranslator** | https://github.com/DonutShinobu/ShinobuTranslator | **项目主体**。检测 / 分割 / 去字(inpaint) / 排版 / 协议全在它这儿，浏览器端跑。已 vendor 到 `shinobu/`，pin `a5af759`（v0.8.3） | GPL-3.0 |
| **manga-ocr** | https://github.com/kha-white/manga-ocr | 日文漫画 OCR 模型，替代浏览器内 ONNX OCR。已 vendor 到 `manga-ocr/` | Apache-2.0 |
| **Ollama** | https://github.com/ollama/ollama | 本地 LLM 运行时（11434）。机器上已就位 | MIT |
| **SakuraLLM** | https://github.com/SakuraLLM/SakuraLLM | 日→中轻小说/漫画翻译模型（GGUF）。已 `ollama pull`（`sakura-14b` / `sakura-14b-qwen3-v1.5`） | CC-BY-NC-SA（**非商用**） |

> GalTransl 也只在 `ollama list` 里作为一个模型用（`galtransl-4b-v4`），**不需要它的仓库**，故不列入。

---

## 二、预取参考 —— 只留这两份（2）

**这是全项目唯一没有现成实现、必须自己拿主意的部分。只需读这两份。**

| 项目 | 链接 | 抄什么 |
|---|---|---|
| **sorz 的预取 gist** ★ | https://gist.github.com/sorz/714b547ce2101866075aeeffe77675f8 | **预取机制的最小正确实现（~100 行）**。Proxy 劫持站点全局 `apply_json_state` + `load_image`；用官方 API `showpage` 取下一页 JSON；**命中缓存时直接 `pushState` + `apply_json_state(resp)` 并 `return false`** → 翻页零延迟。它 `@grant none` 跑在**页面主世界**，这是它能这么短的原因 |
| **exhentai-manga-manager-change** ★ | https://github.com/lumiamilk/exhentai-manga-manager-change | **「当前页 ±N 优先队列 + 翻译缓存」策略**。README 原文：「智能翻译队列：优先翻译当前阅读页面及其前后几页」「翻译缓存：已翻译的页面自动缓存」。后端同构（manga-image-translator + llama-server/GalTransl）。注意：它服务**本地下载库**，不是在线站点 |

---

## 三、备查 —— 需要时再看（1）

| 项目 | 链接 | 抄什么 |
|---|---|---|
| libre-manga-translator | https://github.com/mrdhnto/libre-manga-translator | 架构最接近的浏览器扩展。可参考：**串行队列防爆显存**、**Series Context**（保留最近 5 条已译气泡作跨页上下文）、**Site Rule Adapters**。⚠️ 它是**滚动式触发**，不是翻页式预取；仓库内**无任何 e-hentai 适配**。设计参考，不抄代码 |

---

## 四、已删除 —— 不再需要（10）

砍掉的原因分三类：**① 已被 ShinobuTranslator 覆盖 ② 零翻译 ③ 形态不对**。

| 项目 | 砍掉原因 |
|---|---|
| GalTransl（仓库） | 只是模型来源，模型已在 ollama 里，仓库无用 |
| manga-image-translator | 漫画翻译管线的标准内核 —— **已由 ShinobuTranslator 的 `packages/image-pipeline` 覆盖** |
| cotrans | 后端基于 manga-image-translator，同上被覆盖 |
| comic-translate | LLM prompt 组织 / 手动修框 —— 上游已有等价物；无 e-hentai 适配、无预取 |
| ehentai_reader_script | E-Hentai SPA 阅读器，**零翻译** |
| Exhentai-Enhancer | 油猴脚本，**零翻译**，只增强 MPV |
| eh-view-enhance | 多站阅读/下载，**零翻译** |
| EH-Modern-Reader / Gallery-Reader | 多模式阅读 + 预加载，**零翻译**（注意：它的"预加载"是预**下载原图**，不是预**翻译**，与本项目目标不同） |
| EhSyringe | 标签/界面翻译，**不碰图片内容** |
| exhentai-manga-manager（上游） | 漫画库管理，其 fork（上面第 2 节）才是我们要读策略的那个 |

**仍然排除**：沉浸式翻译 / AI Manga Translator / Comic Translator（商业闭源）、koharu-rs（Rust 桌面应用，形态不对）、Dango-Translator / ImageTrans（屏幕截图 OCR）、ComicRead / eHunter / nHentai Helper（零翻译）。

---

## 五、市场结论（保留原判断）

`e-hentai 站内在线阅读 + 预取下一页 + 翻译` 这个精确组合**没有任何现成开源实现**
（GitHub API 搜 `e-hentai+prefetch` 只有 1 个结果且不含翻译；`manga+translation+prefetch` 是 0 结果）。
所以预取这块要自己设计 —— 但**只需要读上面第二节那两份**就够了。
