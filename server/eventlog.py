# -*- coding: utf-8 -*-
"""统一事件流（M0）—— 日志体系重构后的**唯一事件落点**。

## 为什么要有它

重构前两边各有 4 个出口、各写各的 schema（扩展：诊断流 / 整页日志 / DOM dataset /
console；服务端：.log / .trace.jsonl / .image.jsonl / pages.jsonl），拿到日志也对不上号。
重构后收敛成 **1 条事件流 + 1 个出口**（`docs/日志体系重构设计-2026-10-05.md`）：
扩展与服务端写**同一份 schema（v=2）**，靠 `requestId` 串成一条时间线。

## 落盘

    logs/events/YYYY-MM-DD.events.jsonl    一天一个文件，一行一条 JSON
    关掉：环境变量 DMB_EVENT_LOG=0
    L1 详细层（含原文/译文）：DMB_EVENT_LOG_VERBOSE=1，**默认关**

## 与整页日志的关系（M4 起：**它已下线**）

M0 阶段两者并存（旧通道一个都不动）；**M4 起整页日志独立系统已拆除**：
`server/pagelog.py`、`POST /log/page`、扩展侧的 `buildPageLogRecord` / `postPageLog` 全部移除，
它的记录口径原样搬进了 `page.completed` / `failure` 事件
（`stages` / `total_ms` / L1 才有的 `lines`）。所以现在**同一件事只记一处**。

## 校验口径

**只做最小形状校验**，不解析业务字段 —— `what` 会随版本演进，过早校验只会变成负担。
未知字段**原样透传**；读取端忽略不认识的字段（`v` 只增不减）。
"""
import json
import os
import threading
import time

from config import LOG_ROOT

EVENT_LOG_DIR = os.path.join(LOG_ROOT, "events")
_LOCK = threading.Lock()

# 最小必填：能回答"什么事件、什么时候、从哪来"即可，其余交给调用方。
_REQUIRED_KEYS = ("kind",)


def enabled():
    """DMB_EVENT_LOG=0 时整体关闭（只看不写）。"""
    return os.environ.get("DMB_EVENT_LOG", "1") != "0"


def verbose_enabled():
    """L1 详细层：**默认关**（设计 §4.1 / §5）。

    凡是要写**漫画原文/译文**的事件（`log.verbose`）都必须先过这道闸 ——
    「默认日志不含原文」是对用户的承诺，用户才敢把日志发出去。
    只有排「翻译质量差」（Q4）时才临时打开：`DMB_EVENT_LOG_VERBOSE=1`。
    """
    return os.environ.get("DMB_EVENT_LOG_VERBOSE", "0") == "1"


def event_log_path(day=None):
    return os.path.join(EVENT_LOG_DIR, "{}.events.jsonl".format(day or time.strftime("%Y-%m-%d")))


REQUEST_ID_HEADER = "X-DMB-Request-Id"


def new_request_id():
    """生成 requestId（`q-<时间>-<随机>`，与扩展侧 `createRequestId()` 同形态）。"""
    import random
    return "q-{}-{}".format(int(time.time() * 1000).__format__("x"),
                            random.randrange(0, 36 ** 8).__format__("x").zfill(7))


def resolve_request_id(headers):
    """**谁发起谁生成，服务端兜底并回显**（设计 §6）。

    · 请求头带了 `X-DMB-Request-Id` → 沿用（扩展侧已生成）；
    · 没带 → 服务端生成一个。两种情况都**写进响应头**，客户端拿到就能记进自己的事件。
    这样两侧日志一定存在同一个 ID 可以对上 —— 重构前缺的就是这一条。
    """
    try:
        incoming = (headers.get(REQUEST_ID_HEADER) or "").strip()
    except Exception:
        incoming = ""
    return incoming or new_request_id()


def validate(rec):
    """最小形状校验。返回 (ok, error)。"""
    if not isinstance(rec, dict):
        return False, "事件必须是 JSON 对象"
    for key in _REQUIRED_KEYS:
        if not rec.get(key):
            return False, "缺少必填字段: {}".format(key)
    return True, None


def append_event(rec):
    """追加一条事件。返回 (ok, detail)。

    · 关闭时返回 ok=True 且说明"已关闭"（不写盘不算失败）。
    · 写盘失败**如实返回 False**（记录不该静默丢）。
    """
    if not enabled():
        return True, "事件流已关闭（DMB_EVENT_LOG=0）"
    ok, err = validate(rec)
    if not ok:
        return False, err
    out = dict(rec)
    out.setdefault("v", 2)
    out.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
    try:
        os.makedirs(EVENT_LOG_DIR, exist_ok=True)
        line = json.dumps(out, ensure_ascii=False)
        with _LOCK:
            with open(event_log_path(), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True, event_log_path()
    except Exception as e:
        return False, "写入失败: {}: {}".format(type(e).__name__, e)


def append_events(payload):
    """批量追加。返回 (ok, detail, written)。

    接受两种形态：
      · {"events": [ ... ]}          —— 扩展侧批量 flush 的默认形态
      · [ ... ] / { ...单条事件... } —— 兼容直接投递

    **逐条校验、逐条写**：一条坏事件不该让整批消失（那正是"静默丢"的一种）。
    """
    if isinstance(payload, dict) and isinstance(payload.get("events"), list):
        items = payload["events"]
    elif isinstance(payload, list):
        items = payload
    else:
        items = [payload]

    written = 0
    failures = []
    for rec in items:
        ok, detail = append_event(rec)
        if ok:
            # 关闭时也算"处理过"，但不计入 written（确实没写盘）
            if "已关闭" not in str(detail):
                written += 1
        else:
            failures.append(str(detail))
    if failures:
        return False, "部分事件写入失败: " + "；".join(failures[:3]), written
    return True, event_log_path(), written
