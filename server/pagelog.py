# -*- coding: utf-8 -*-
"""整页日志 —— 每个"翻译任务"一条记录（含各阶段耗时 + 逐行原文/译文 + 画廊第几页）。

## 为什么是"扩展组装一条、POST 过来"，而不是服务端从 /ocr + /v1 两次请求里拼

原先那套"整页配对"（`pages.py`）就是干这个的，它在真机上从未生效：配对要求两个请求
都带 pageKey，而扩展的翻译请求从构造起就不带。**一次 POST 一条完整记录 = 零配对、单一数据源**，
而且"这页是画廊第几页"只有扩展知道（页身份来自 `location.pathname`）。

## 记录单位（用户口径 2026-10-04）

**发生一次大模型翻译就记一条** —— 不管是用户手点的还是预取自动跑的。
失败与取消也记（否则"没有记录"与"成功"分不清）。

## 落盘

    logs/pages/YYYY-MM-DD.pages.jsonl     一天一个文件，一行一条 JSON
    关掉：环境变量 DMB_PAGE_LOG=0（只看不写）

记录体由调用方给（扩展侧组装），本模块只做**最小形状校验 + 追加写**，
不解析业务字段 —— 那些字段会演进，过早校验只会变成负担。
"""
import json
import os
import threading
import time

from config import LOG_ROOT

PAGE_LOG_DIR = os.path.join(LOG_ROOT, "pages")
_LOCK = threading.Lock()

_REQUIRED_KEYS = ("pageKey", "status")


def enabled():
    """DMB_PAGE_LOG=0 时整体关闭（只看不写）。"""
    return os.environ.get("DMB_PAGE_LOG", "1") != "0"


def page_log_path(day=None):
    return os.path.join(PAGE_LOG_DIR, "{}.pages.jsonl".format(day or time.strftime("%Y-%m-%d")))


def validate(rec):
    """最小形状校验。返回 (ok, error)。**只挡明显不属于本日志的东西**。"""
    if not isinstance(rec, dict):
        return False, "记录必须是 JSON 对象"
    for key in _REQUIRED_KEYS:
        if not rec.get(key):
            return False, "缺少必填字段: {}".format(key)
    if rec.get("schema") not in (None, 1):
        return False, "未知 schema: {!r}".format(rec.get("schema"))
    return True, None


def append_page_record(rec):
    """追加一条整页记录。返回 (ok, detail)。

    · 关闭时返回 ok=True 且说明"已关闭"，让调用方不必区分（不写盘不算失败）。
    · 写盘失败**如实返回 False**（记录不该静默丢）。
    """
    if not enabled():
        return True, "整页日志已关闭（DMB_PAGE_LOG=0）"
    ok, err = validate(rec)
    if not ok:
        return False, err
    out = dict(rec)
    out.setdefault("schema", 1)
    out.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
    try:
        os.makedirs(PAGE_LOG_DIR, exist_ok=True)
        line = json.dumps(out, ensure_ascii=False)
        with _LOCK:
            with open(page_log_path(), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        return True, page_log_path()
    except Exception as e:
        return False, "写入失败: {}: {}".format(type(e).__name__, e)
