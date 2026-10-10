# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 支持包（M3 · 日志体系重构）。

设计见 `docs/CHANGELOG.md` §二。

★ 为什么支持包由**服务端**出，而不是扩展自己攒：
  扩展侧的事件缓冲是"过路"的 —— 满 32 条或 500ms 就 flush 走，job 结束还会强制 flush，
  所以任何时刻去内存里取，拿到的通常都是空的。事件真正的家是服务端的
  `logs/events/YYYY-MM-DD.events.jsonl`。让扩展去攒，等于攒一个空壳。

★ 铁律：
  1. **只导出，不改写入路径** —— 本模块只读。
  2. **人可读的 `summary` 与机读的 `events` 同源**：summary 由 events 现场算出，
     不另开一套统计，避免"结论与证据不一致"。
  3. 体量有上限（`limit`），超出只留最近的一批，并在 `window.truncated` 里如实标注 ——
     不许给人一个看着完整、其实被截断还没说的文件。
"""
import json
import os
import time

import eventlog
from config import LOG_ROOT

DEFAULT_EVENT_LIMIT = 500
DEFAULT_TAIL_LINES = 80
# 跨零点运行/隔夜排查：只看今天会漏掉"昨晚失败今早来导出"的场景。
DEFAULT_DAYS = 2


def _candidate_days(days):
    """最近 `days` 天的日期串（从旧到新）。"""
    out = []
    stamp = time.time()
    for offset in range(days - 1, -1, -1):
        out.append(time.strftime("%Y-%m-%d", time.localtime(stamp - offset * 86400)))
    return out


def read_recent_events(limit=DEFAULT_EVENT_LIMIT, days=DEFAULT_DAYS):
    """读最近 `limit` 条事件（跨天，从旧到新）。返回 (events, meta)。

    `meta` 里如实记录读了哪些文件、总共多少行、是否截断 ——
    "没采到"与"采到了但为空"必须能分开（诊断器铁律）。
    """
    events = []
    files = []
    total_lines = 0
    for day in _candidate_days(days):
        path = eventlog.event_log_path(day)
        files.append(path)
        if not os.path.exists(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                lines = [line.strip() for line in f if line.strip()]
        except Exception as e:
            events.append({"kind": "support.read-error", "level": "error",
                           "where": {"repo": "server", "module": "support",
                                     "fn": "read_recent_events"},
                           "err": {"type": type(e).__name__, "message": str(e)},
                           "what": {"path": path}})
            continue
        total_lines += len(lines)
        for line in lines:
            try:
                events.append(json.loads(line))
            except Exception:
                # 坏行不丢：留一条"这一行没解析出来"的证据，否则排查时看到的是"事件少了几条"。
                events.append({"kind": "support.bad-line", "level": "warn",
                               "where": {"repo": "server", "module": "support",
                                         "fn": "read_recent_events"},
                               "what": {"path": path, "raw": line[:200]}})
    truncated = len(events) > limit
    if truncated:
        events = events[-limit:]
    return events, {
        "files": files,
        "totalLines": total_lines,
        "returned": len(events),
        "truncated": truncated,
        "days": days,
    }


def _failure_key(event):
    """失败归类的键：`模块/错误码`，都没有就退回 kind。

    用错误码而不是整句 message 归类：message 里带 host/耗时，同一类错会长出几十个 key，
    Top N 就失去意义。
    """
    err = event.get("err") or {}
    module = (event.get("where") or {}).get("module") or "?"
    code = err.get("code") or err.get("type")
    if code:
        return "{}/{}".format(module, code)
    return "{}/{}".format(module, event.get("kind") or "?")


def build_summary(events):
    """从事件现场算出人可读结论（设计 §4.2 的 `summary`）。"""
    by_kind = {}
    by_level = {}
    failures = []
    page_state = {}
    runs = {}

    for event in events:
        kind = event.get("kind") or "?"
        by_kind[kind] = by_kind.get(kind, 0) + 1
        level = event.get("level") or "?"
        by_level[level] = by_level.get(level, 0) + 1

        if kind == "failure":
            failures.append(event)

        page_key = event.get("pageKey")
        if page_key:
            status = "started"
            if kind == "page.completed":
                status = (event.get("what") or {}).get("status") or "completed"
            elif kind == "failure":
                status = "failed"
            page_state[page_key] = {"status": status, "ts": event.get("ts")}

        run_id = event.get("runId")
        if run_id:
            run = runs.setdefault(run_id, {"runId": run_id, "firstTs": event.get("ts"),
                                           "lastTs": event.get("ts"), "events": 0,
                                           "failures": 0})
            run["events"] += 1
            run["lastTs"] = event.get("ts")
            if kind == "failure":
                run["failures"] += 1

    top_counter = {}
    for failure in failures:
        key = _failure_key(failure)
        entry = top_counter.setdefault(key, {"key": key, "count": 0, "sample": None,
                                             "lastTs": None})
        entry["count"] += 1
        entry["lastTs"] = failure.get("ts")
        if entry["sample"] is None:
            err = failure.get("err") or {}
            entry["sample"] = (err.get("message") or "")[:300]

    pages = sorted(page_state.items(), key=lambda kv: (kv[1].get("ts") or ""))
    recent_runs = sorted(runs.values(), key=lambda r: (r.get("lastTs") or ""))

    return {
        "total": len(events),
        "counts": {"byKind": by_kind, "byLevel": by_level},
        "failures": {
            "total": len(failures),
            "top": sorted(top_counter.values(), key=lambda e: -e["count"])[:10],
        },
        "pages": {
            "tracked": len(pages),
            "failed": sum(1 for _, v in pages if v.get("status") == "failed"),
            "recent": [{"pageKey": k, **v} for k, v in pages[-10:]],
        },
        "runs": {
            "tracked": len(runs),
            "recent": recent_runs[-10:],
        },
    }


def read_server_tail(lines=DEFAULT_TAIL_LINES):
    """服务端人类可读日志的尾部（`logs/unknown/<今天>.log`）。

    只取 `unknown` 目录：那是**启动期与无模型归属**的日志（`logging_.daily_log_path`
    在没传 model 时就落这里）。按模型分目录的那些是"某次翻译"的运行日志，
    量更大也更碎，不混进支持包 —— 排障要看结论请用事件流。

    历史注意：这里以前还会先找 `logs/_server/`，但那个目录**从未被任何代码创建过**
    （`safe_dir_name` 的默认值早已是 `unknown`），所以那一跳是纯历史残留，已删。
    """
    path = os.path.join(LOG_ROOT, "unknown", "{}.log".format(time.strftime("%Y-%m-%d")))
    if not os.path.exists(path):
        return {"path": None, "lines": [], "error": "日志文件不存在"}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = [line.rstrip("\n") for line in f if line.strip()]
    except Exception as e:
        return {"path": path, "lines": [], "error": "{}: {}".format(type(e).__name__, e)}
    return {"path": path, "lines": content[-lines:], "error": None}


def build_support_payload(health=None, limit=DEFAULT_EVENT_LIMIT,
                          tail_lines=DEFAULT_TAIL_LINES, days=DEFAULT_DAYS,
                          exporter=None):
    """组装支持包（不含扩展侧的 env/settings —— 那两段由扩展补）。"""
    events, window = read_recent_events(limit=limit, days=days)
    summary = build_summary(events)
    return {
        "v": 2,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "exporter": exporter or {"repo": "server", "commit": None},
        "window": window,
        "summary": summary,
        "events": events,
        "server": {
            "health": health or {},
            "tail": read_server_tail(tail_lines),
            "eventLogPath": eventlog.event_log_path(),
            "eventLogEnabled": eventlog.enabled(),
        },
        "privacy": {
            "containsOriginalText": any(
                (e.get("level") == "debug") or str(e.get("kind", "")).endswith(".text")
                for e in events
            ),
            "redacted": ["settings.*key", "url.query", "event.attempts[].dnrError?"],
            "note": "默认不含漫画原文/译文；原文只在用户显式打开详细层时出现。",
        },
    }
