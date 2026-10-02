# -*- coding: utf-8 -*-
"""整页记录配对 —— 显式 pageKey 取代 v1 的 FIFO 猜测。

v1 靠一个 `_page_buffer` 的先进先出顺序去猜"这次 OCR 和这次翻译是不是同一页"，
在并发下必然错配。v2 只认 pageKey：

  POST /ocr                  { images:[...], pageKey? }        → attach_ocr
  POST /v1/chat/completions  { model, messages, pageKey? }     → complete

* pageKey 缺失时 **不做任何配对猜测** —— 分别落两条记录并在 notes 里写明。
  宁可记两条，也不允许把 A 页的 OCR 配到 B 页的翻译上。
"""
import datetime
import threading
import uuid

from logging_ import write_image_record
from config import model_base

MAX_AGE_S = 300


class PageStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._pages = {}          # pageKey -> {"ocr": rec, "translate": rec, "t0": ts}

    # ---- 写入 ----
    def attach_ocr(self, page_key, rec):
        """记下一次 OCR。page_key 为空 → 直接单独落盘（不配对）。"""
        if not page_key:
            rec = dict(rec)
            rec["pageKey"] = None
            rec["pairing"] = "none(no pageKey)"
            self._sink(rec)
            return None
        with self._lock:
            slot = self._pages.setdefault(page_key, {"t0": datetime.datetime.now().timestamp()})
            slot["ocr"] = rec
            merged = self._merge_locked(page_key, slot)
        if merged:
            self._sink(merged)
        self.flush_stale()
        return page_key

    def complete(self, page_key, rec):
        """记下一次翻译。凑齐 OCR + 翻译 → flush 一条 `kind=page` 记录。

        翻译到了但 OCR 没到（理论上不该发生：Shinobu 先发 /ocr 再发 /v1）→
        落一条 `kind=partial / pairing=translate-only`。**宁可记一条"独腿"记录，
        也不许拿别的页的 OCR 来配对** —— 这就是 v1 FIFO 会犯的错。
        """
        if not page_key:
            rec = dict(rec)
            rec["pageKey"] = None
            rec["pairing"] = "none(no pageKey)"
            self._sink(rec)
            return None
        merged, orphan = None, None
        with self._lock:
            slot = self._pages.setdefault(page_key, {"t0": datetime.datetime.now().timestamp()})
            slot["translate"] = rec
            merged = self._merge_locked(page_key, slot)
            if merged is None and not slot.get("ocr"):
                orphan = {
                    "kind": "partial",
                    "pageKey": page_key,
                    "model": rec.get("model"),
                    "ocr": None,
                    "translate": rec,
                    "pairing": "translate-only(no ocr)",
                }
                self._pages.pop(page_key, None)
        if merged:
            self._sink(merged)
        elif orphan:
            self._sink(orphan)
        self.flush_stale()
        return page_key

    # ---- 内部 ----
    def _merge_locked(self, page_key, slot):
        """OCR 与翻译都到齐 → 合成一条并移除；否则 None。"""
        ocr, tr = slot.get("ocr"), slot.get("translate")
        if not ocr or not tr:
            return None
        self._pages.pop(page_key, None)
        out = {
            "kind": "page",
            "pageKey": page_key,
            "model": tr.get("model"),
            "ocr": ocr,
            "translate": tr,
        }
        return out

    def _sink(self, rec):
        write_image_record(rec, model=rec.get("model"))

    def flush_stale(self, max_age_s=MAX_AGE_S):
        """超时只到一半（缺 OCR 或缺翻译）的残留单独落盘，避免永久积压。"""
        now = datetime.datetime.now().timestamp()
        stale = []
        with self._lock:
            for k, slot in list(self._pages.items()):
                if now - slot.get("t0", now) > max_age_s:
                    stale.append((k, self._pages.pop(k)))
        for k, slot in stale:
            rec = {
                "kind": "partial",
                "pageKey": k,
                "model": (slot.get("translate") or {}).get("model"),
                "ocr": slot.get("ocr"),
                "translate": slot.get("translate"),
                "pairing": "incomplete(timeout)",
            }
            self._sink(rec)


PAGES = PageStore()


def new_key():
    """给确实没有 pageKey 的场景生成一个一次性 id（不参与配对）。"""
    return "anon-" + uuid.uuid4().hex[:12]
