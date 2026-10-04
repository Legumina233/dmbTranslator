# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 日志与追踪。

铁律（来自 v1 的三个静默 P0）：
  * 先落盘，后响应 —— 绝不允许"响应已发出、处理线程才崩，记录永不写入"。
  * 每条记录都要能指认【是哪一次请求】—— 所以 model 一律显式传入，不读任何全局变量。

目录结构（工程根/logs）：
  logs/<模型名>/YYYY-MM-DD.log          服务器运行日志（人类可读）
  logs/<模型名>/YYYY-MM-DD.trace.jsonl  分阶段耗时追踪
  logs/<模型名>/YYYY-MM-DD.image.jsonl  翻译侧归档（一条请求 = 一条；整页"配对"已删，
                                        见 docs/SERVER.md §七）
"""
import datetime
import json
import os
import threading

from config import LOG_ROOT, TRACE_ENABLED, model_base

_io_lock = threading.Lock()


def safe_dir_name(name):
    """qwen3.5:4b -> qwen3.5-4b；sakura-14b:latest -> sakura-14b-latest。

    注意 `:latest` 不会被去掉 —— 它是真实模型名的一部分（Ollama 里 sakura-14b
    与 sakura-14b:latest 是同一个，但名字带不带 tag 会影响目录归属，保持一致更好排查）。
    没有模型名的启动期日志归到 `_server`，与按模型分目录的记录区分开。
    """
    s = (name or "_server").replace(":", "-").replace("/", "-").replace("\\", "-")
    s = "".join(c for c in s if c.isalnum() or c in "-._")
    return s or "_server"


def daily_log_path(kind, model=None):
    """kind ∈ {log, trace, image}。跨零点运行会在写入时重新计算，自动切到新文件。"""
    d = os.path.join(LOG_ROOT, safe_dir_name(model or "unknown"))
    today = datetime.date.today().isoformat()
    if kind == "log":
        return os.path.join(d, "{}.log".format(today))
    return os.path.join(d, "{}.{}.jsonl".format(today, kind))


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
        _append_line(daily_log_path("log", model), line)
    except Exception:
        pass
    return line


def trace_event(ev, model=None):
    """分阶段耗时追踪。失败绝不影响主流程。"""
    if not TRACE_ENABLED:
        return
    try:
        rec = dict(ev)
        rec.setdefault("ts", datetime.datetime.now().isoformat(timespec="seconds"))
        rec.setdefault("model", model or ev.get("model"))
        _append_line(daily_log_path("trace", model), json.dumps(rec, ensure_ascii=False))
    except Exception as e:
        try:
            print("!! trace_event 写入失败（忽略）: {}".format(e), flush=True)
        except Exception:
            pass


def write_image_record(rec, model=None):
    """整页级记录：一张图片 = 一条。返回 True/False 供调用方断言。"""
    try:
        r = dict(rec)
        r.setdefault("ts", datetime.datetime.now().isoformat(timespec="seconds"))
        r.setdefault("model", model or r.get("model"))
        _append_line(daily_log_path("image", model), json.dumps(r, ensure_ascii=False))
        return True
    except Exception as e:
        try:
            print("!! write_image_record 写入失败: {}".format(e), flush=True)
        except Exception:
            pass
        return False
