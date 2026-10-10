# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 日志与追踪。

铁律（来自 v1 的三个静默 P0）：
  * 先落盘，后响应 —— 绝不允许"响应已发出、处理线程才崩，记录永不写入"。
  * 每条记录都要能指认【是哪一次请求】—— 所以 model 一律显式传入，不读任何全局变量。

目录结构（工程根/logs）：
  logs/<模型名>/YYYY-MM-DD.log          服务器运行日志（人类可读）
  logs/unknown/YYYY-MM-DD.log           无模型归属（启动期 / 未指定 model 的调用）

★ M4 起 `.trace.jsonl` 与 `.image.jsonl` **已下线**，信息并入统一事件流
  （`docs/CHANGELOG.md` §二）：
    * 分阶段耗时 → `llm.call` / `failure` 事件的 `what.stages`；
    * 原文/译文归档 → L1 详细层的 `log.verbose` 事件（默认不写）。
  本模块因此只剩"人类可读 `.log`"一件事，它的定位是**控制台镜像**：
  开发时 tail 着看，**不再承担排障** —— 排障一律看事件流与支持包。
"""
import datetime
import os
import threading

from config import LOG_ROOT

_io_lock = threading.Lock()


def safe_dir_name(name):
    """qwen3.5:4b -> qwen3.5-4b；sakura-14b:latest -> sakura-14b-latest。

    注意 `:latest` 不会被去掉 —— 它是真实模型名的一部分（Ollama 里 sakura-14b
    与 sakura-14b:latest 是同一个，但名字带不带 tag 会影响目录归属，保持一致更好排查）。
    没有模型名的启动期日志归 `unknown`（**只能有这一个名字** —— 它必须与
    `support.read_server_tail` 读取的目录一致；历史上这里叫过 `_server`，那个名字
    其实从未被创建过）。
    """
    s = (name or "unknown").replace(":", "-").replace("/", "-").replace("\\", "-")
    s = "".join(c for c in s if c.isalnum() or c in "-._")
    return s or "unknown"


def daily_log_path(model=None):
    """人类可读 `.log` 的当日路径。

    `kind` 参数（v1 时代的 `log` / `trace` / `image` 三出口）已随 M4 下线取消：
    本模块现在只写 `.log`，另外两个出口的落点统一事件流。
    跨零点运行会在写入时重新计算，自动切到新文件。
    """
    d = os.path.join(LOG_ROOT, safe_dir_name(model or "unknown"))
    return os.path.join(d, "{}.log".format(datetime.date.today().isoformat()))


def _append_line(path, line):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _io_lock:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def log(msg, model=None):
    """人类可读日志。model 只用于决定子目录，缺省不算错。"""
    line = "{} {}".format(datetime.datetime.now().strftime("%H:%M:%S"), msg)
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        _append_line(daily_log_path(model), line)
    except Exception:
        pass
    return line
