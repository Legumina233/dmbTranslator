# -*- coding: utf-8 -*-
"""唯一的翻译管线 + RequestContext。

v1 的 `_handle_chat` 是一个 2×2 矩阵（后端 × 输入形态）被写成 4 段复制，
其中两段逐行相同，尾部六步在四处重复 → 于是"改一处忘三处"。
v2 把它收敛成 **一条** 管线：

    shape  = classify_input(messages)      # 'regions' | 'plain' | 'native'
    items  = extract_items(messages, shape)
    zh     = BACKENDS[ctx.backend].translate_lines([jp for _, jp in items], ctx)
    result = TranslateResult(content=..., regions=build_regions(items, zh))

任何请求级数据都挂在 ctx 上（显式传参），**不读全局变量**。
"""
import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from backends import BACKENDS, BackendError, stage_to_trace
from logging_ import log


@dataclass
class RequestContext:
    """一次请求的全部身份与计量。持有 model/backend/page_key/计时/计数。"""
    model: str
    backend: str
    page_key: Optional[str] = None
    t_start: float = field(default_factory=time.time)
    unload_ms: int = 0
    stage: Dict[str, Any] = field(default_factory=dict)
    notes: str = ""

    def elapsed_ms(self) -> int:
        return int(round((time.time() - self.t_start) * 1000))

    def trace_stages(self) -> Dict[str, Any]:
        return stage_to_trace(self.stage)


@dataclass
class TranslateResult:
    content: str
    mode: str
    region_count: int
    translate_list: List[Dict[str, Any]]


class PipelineError(Exception):
    """管线无法处理该输入（调用方应决定是否回退透传）。"""


# ── 输入解析 ──────────────────────────────────────────────

def get_text(content):
    """messages[].content 可能是 str，也可能是 [{type,text}] 数组。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict) and c.get("type") == "text":
                parts.append(c.get("text") or "")
        return "".join(parts)
    return ""


def user_text_of(messages):
    out = ""
    for m in messages or []:
        if m.get("role") == "user":
            out = get_text(m.get("content"))
    return out


def extract_regions(text):
    """从 Shinobu 的结构化 prompt 里抽出 `输入数据：[...]` 的 region 列表。"""
    if not text:
        return None
    idx = text.find("输入数据：")
    if idx < 0:
        idx = text.find("输入数据:")
    if idx >= 0:
        tail = text[idx + len("输入数据："):].strip()
        try:
            obj = json.loads(tail, strict=False)   # textWithBreaks 含真实换行
            if isinstance(obj, list):
                return obj
        except Exception:
            pass
    s, e = text.find("["), text.rfind("]")
    if s >= 0 and e > s:
        try:
            obj = json.loads(text[s:e + 1], strict=False)
            if isinstance(obj, list):
                return obj
        except Exception:
            pass
    return None


# Sakura 官方 user 句式的固定尾句（v1.0 / v1.5 两版）
SAKURA_USER_MARKERS = (
    "将下面的日文文本根据对应关系和备注翻译成中文：",
    "将下面的日文文本翻译成中文：",
    "翻译成中文：",
)


def extract_plain_original(text):
    """简版模式：抽出待译日文。

    三种来源，按优先级：
      1. Shinobu 简版        `原文：<日文>`
      2. 已经是 Sakura 官方句式 `…翻译成中文：<日文>`  → 剥掉官方前缀，避免二次包装
      3. 都没有 → None（交给调用方判定是否透传）
    """
    if not text:
        return None
    for marker in ("原文：", "原文:"):
        idx = text.rfind(marker)
        if idx >= 0:
            return text[idx + len(marker):].strip()
    for marker in SAKURA_USER_MARKERS:
        idx = text.rfind(marker)
        if idx >= 0:
            tail = text[idx + len(marker):].strip()
            if tail:
                return tail
    return None


def classify_input(messages):
    """→ (shape, payload)。四种复制分支在这里收敛成一个判断。"""
    text = user_text_of(messages)
    if text:
        regions = extract_regions(text)
        if regions is not None:
            return "regions", regions
        orig = extract_plain_original(text)
        if orig:
            return "plain", orig
    return "native", text


def region_source_text(r):
    src = r.get("sourceText") or {}
    return (src.get("plainText") or src.get("textWithBreaks") or r.get("text") or "").strip()


def extract_items(regions):
    """→ [(region, jp)]，跳过空文本的 region。"""
    items = []
    for r in regions or []:
        jp = region_source_text(r)
        if jp:
            items.append((r, jp))
    return items


# ── 输出拼装 ──────────────────────────────────────────────

def split_segments(text, n):
    """把译文切成不超过 n 段，优先按换行/标点断开。"""
    if not text:
        return []
    if not n or n <= 1:
        return [text]
    parts = [p.strip() for p in text.split("\n") if p.strip()]
    if len(parts) < 2:
        import re
        parts = [p.strip() for p in re.split(r"(?<=[。！？、，…])", text) if p.strip()]
    if not parts:
        return [text]
    if len(parts) <= n:
        return parts
    total = sum(len(p) for p in parts)
    target = total / float(n)
    out, cur = [], ""
    for p in parts:
        cur += p
        if len(cur) >= target and len(out) < n - 1:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    while len(out) > n:
        out[-2] = out[-2] + out[-1]
        out.pop()
    return out


def build_regions(items, translations):
    """把译文回填成 Shinobu 要的 regions 结构。"""
    out = []
    for (r, jp), zh in zip(items, translations):
        rid = r.get("id")
        direction = r.get("direction")
        raw_n = r.get("targetColumns") if direction == "v" else r.get("targetLines")
        try:
            n = int(raw_n) if raw_n else 1
        except Exception:
            n = 1
        cols = split_segments(zh, n)
        log("  id={} | 原文: {} | 译文: {} | columns={}".format(rid, jp, zh, cols),
            model=r.get("_model"))
        out.append({"id": rid, "translation": zh, "columns": cols})
    return out


# ── 唯一管线 ─────────────────────────────────────────────

def handle_translate(ctx, messages):
    """唯一的翻译管线。返回 TranslateResult；无法处理则抛 PipelineError。"""
    shape, payload = classify_input(messages)
    backend = BACKENDS.get(ctx.backend)
    if backend is None:
        raise PipelineError("未知后端: {}".format(ctx.backend))

    if shape == "regions":
        items = extract_items(payload)
        missing = [r.get("id") for r in payload if not region_source_text(r)]
        log("=" * 60, model=ctx.model)
        log("结构化模式 (backend={})，region 数: {}（空文本 {}）".format(
            ctx.backend, len(payload), len(missing)), model=ctx.model)
        translations = backend.translate_lines([jp for _, jp in items], ctx)
        regions = build_regions(items, translations)
        ctx.notes = "结构化模式"
        return TranslateResult(
            content=json.dumps({"regions": regions}, ensure_ascii=False),
            mode="structured",
            region_count=len(regions),
            translate_list=[{"id": r.get("id"), "jp": jp, "zh": zh}
                            for (r, jp), zh in zip(items, translations)],
        )

    if shape == "plain":
        log("=" * 60, model=ctx.model)
        log("简版模式，原文: {}".format(payload.replace("\n", "\\n")), model=ctx.model)
        zh = backend.translate_lines([payload], ctx)[0]
        log("  译文: {}".format(zh), model=ctx.model)
        ctx.notes = "简版模式"
        return TranslateResult(content=zh, mode="plain", region_count=1,
                               translate_list=[{"id": None, "jp": payload, "zh": zh}])

    # native：没有可识别的结构。通用模型可原样转发；Sakura 无能为力 → 交给调用方定夺。
    if ctx.backend == "generic":
        text = BACKENDS["generic"].chat(messages, ctx)
        ctx.notes = "native 非结构化模式"
        return TranslateResult(content=text, mode="native", region_count=len(messages),
                               translate_list=[{"id": None, "jp": None, "zh": text}])
    raise PipelineError("Sakura 后端收到无可识别结构的输入（缺少『输入数据：』/『原文：』）")


# ── 整页记录载荷 ──────────────────────────────────────────

def assemble_translate_payload(ctx, translate_list):
    """把 ctx 的计量整理成整页记录的翻译侧载荷。"""
    st = ctx.stage
    total = ctx.elapsed_ms()
    load = st.get("load_ms", 0) or 0
    prefill = st.get("prompt_eval_ms", 0) or 0
    generate = st.get("eval_ms", 0) or 0
    infer = prefill + generate
    return {
        "translate_list": translate_list,
        "model_load_ms": load,
        "model_prefill_ms": prefill,
        "model_generate_ms": generate,
        "model_infer_ms": infer,
        "unload_other_ms": ctx.unload_ms or 0,
        "translate_total_ms": total,
        "translate_overhead_ms": max(0, total - (ctx.unload_ms or 0) - load - infer),
        "prompt_tokens": st.get("prompt_tokens", 0),
        "output_tokens": st.get("output_tokens", 0),
        "model": ctx.model,
        "notes": ctx.notes,
    }


__all__ = [
    "RequestContext", "TranslateResult", "PipelineError",
    "classify_input", "extract_items", "build_regions", "split_segments",
    "handle_translate", "assemble_translate_payload", "user_text_of", "get_text",
    "BackendError",
]
