# 我需要你提供 / 决定的东西

> 目的：凡是**我做不到或只有你能做**的，都在这里列清楚。你照着做完，把结果给我即可。
> 更新：2026-10-01

---

## A. 必须由你在浏览器里跑的实验（我做不了）

### ~~A1. Phase 1 探针~~ ✅ 已完成（2026-10-01）

**结论：主世界桥可行** —— `load_image` / `apply_json_state` / `api_call` 全部可见且成功劫持，
翻页三步链路已完整录下。详见 `docs/ARCHITECTURE.md`。
**影响：不需要写 v1 那 330 行的投影 + 状态机。**

### ~~A2. 探针 v1.2~~ ✅ 已完成（2026-10-01 17:28）

**全部拿到了**：10 条 `showpage` 响应 + 12 个真实图片 URL。
图片 URL 在响应的 `i3` 字段（`<img id="img" src="…">`），下一页 imgkey 在 `n`/`i3` 的 `load_image(页号,'imgkey')` 里。
**预取链路已被数据完全确定，可以开写了。** 详见 `docs/ARCHITECTURE.md` §6。

### ~~A2b. 探针 v1.2（初版）~~ —— 已升级，无需再跑

**背景**：v1.1 那次没抓到 `showpage` 响应（`load_image` 抛异常 → 页面整页重载了）。
**v1.2 已改成纯被动**：不再改写站点任何函数，只监听 `XMLHttpRequest` / `fetch`，
所以**不可能再干扰站点行为**。

**怎么做**（约 1 分钟）：

1. `chrome://extensions` → "dmb probe (Phase 1)" → 点 **重新加载**（版本变 **1.2.0**）
2. 打开阅读页后，先 **Ctrl+Shift+R 硬刷新一次**，等图**完全显示出来**
3. 再**用页面上/键盘的"下一页"正常翻 3~5 页**
4. 点扩展图标 → **导出报告 JSON**（文件名自己起个新的，别覆盖旧的）
5. 发我

> **这次一定会抓到**：`showpage` 的请求 URL + 完整响应 JSON、`img#img.src` 的变化序列、
> 以及 `gid`/`showkey`/`imgkey` 的**实际值**。

**顺带告诉我一句**：翻页时页面是**原地换图**（不闪、不重载），还是**整页刷新**了？这直接印证上面那条 `return false` 的结论。

### ~~A3. 停掉 v1 服务~~ ✅ 你已完成

---

## B. 需要你做的环境动作（一条命令的事）

### B1. Node 24
上游 `shinobu/package.json` 的 `engines` 要求 **Node ^24**，你机器上是 **22.22.2**。
我已用 22 开始 `npm install`（多数情况只是 EBADENGINE 警告能装完）。若安装或构建报错，请装 Node 24。

### B2. 停掉 v1 服务
`11436` 端口现在被 **v1 的 dmb_server 占用**（预检报 WARN）。启动 v2 之前跑一次：

```cmd
E:\AI\dmbTranslator\scripts\stop_all.cmd
```

（Ollama 11434 保持运行，不用动。）

---

## C. 需要你拍板的两个技术决策

### C1. Python 环境：复用 v1 的 conda 环境，还是新建？

| 方案 | 说明 | 代价 |
|---|---|---|
| **A. 复用 `E:\AI\dmbTranslator\.conda`**（推荐，暂定） | 里面已有 py3.11 / torch 2.5.1+cu121 / CUDA 可用 / transformers 4.46.3 / PIL。**已经实测能跑 OCR + 翻译** | 与 v1 共享环境（但 v1 代码我们不看） |
| B. 新建独立 venv | 干净隔离 | 要重下 torch+cuda，约 **5.6 GB** |

**当前默认走 A**。要改成 B 跟我说。

### C2. `server/` 由我重写，还是先复用 v1 的 `dmb_server.py` 跑通再说？

- **复用 v1 的**：立刻能跑通端到端，但带着那 3 个静默 P0（日志丢条 / 原文冒充译文 / 全局变量）
- **直接重写 v2**（推荐）：按职责拆 9 个文件 + 消灭 P0 + `RequestContext`，但要多花时间

**当前默认走"直接重写 v2"**（因为你说了不管原项目）。若要先用旧的跑通，跟我说。

---

## D. 我**已经自己搞定**的（你不用管）

| 项 | 状态 |
|---|---|
| 创建 `E:\AI\dmbTranslatorV2` + `git init` | ✅ |
| 干净 clone 上游 ShinobuTranslator @ `a5af759` | ✅ 已固定 pin |
| vendor manga-ocr 源码 | ✅ |
| 搬入上游 4 个 ONNX 资产（detector/inpaint/bubble/PP-OCRv6，共 195 MB，字节数与 `models.json` 声明一致） | ✅ 从 v1 副本搬的，省你一次下载 |
| 环境预检脚本 `scripts/preflight.cmd` | ✅ 已跑通 |
| OCR + 翻译冒烟测试 `scripts/test_ocr.cmd`（自生成日文测试图，无需素材） | ✅ 已跑通 |
| 参考清单从 16 个精简到 6 个（`docs/REFERENCES.md`） | ✅ |
| Phase 1 探针扩展 `probe/mainworld-probe/` | ✅ |
| `npm install`（后台进行中） | ⏳ |

---

## E. 一句话总结：你现在只需要做两件事

1. **停掉 v1 服务**（`E:\AI\dmbTranslator\scripts\stop_all.cmd`）—— 10 秒
2. **跑 Phase 1 探针并把 `dmb-probe-report.json` 发我** —— 5 分钟（见 A1）

其余的我已经准备好了。C1/C2 若认可默认方案，也不用回复。
