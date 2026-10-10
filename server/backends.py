# -*- coding: utf-8 -*-
"""翻译后端（策略对象）。

铁律（v1 的 P0-A / P0-B）：
  * **禁止用全局变量传请求级数据** —— 计时一律写进本次请求的 ctx.stage。
  * **禁止用 dict 整体替换共享状态**。
  * **失败必须显式表达** —— 绝不允许 `or 原文` 这种"悄悄把日文当译文返回"。
    任何拿不到有效译文的路径都必须抛 BackendError。
"""
import json
import time
import urllib.error
import urllib.request

import sakura
from config import (BATCH_TRANSLATE, DEBUG_DUMP, QWEN_LINES_SYSTEM,
                    UPSTREAM, keep_alive)
from logging_ import log

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class BackendError(Exception):
    """翻译后端的显式失败。绝不允许被静默吞掉。"""


def _acc(stage, part):
    for k, v in part.items():
        stage[k] = stage.get(k, 0) + (v or 0)


def _ollama_chat(model, messages, ctx, timeout=600, options=None, stop=None):
    """非流式调用 Ollama /api/chat。

    刻意用 stream=False：Ollama 的流式格式可能是 SSE 也可能是 NDJSON（v1 实测），
    两种都要兼容很脆。而非流式的回包在 **顶层** 就带全部分阶段耗时
    （prompt_eval_duration / eval_duration / load_duration，单位纳秒），
    拿到的信息与流式完全相同，却少了一整类兼容问题。
    """
    payload = {"model": model, "messages": messages, "stream": False,
               # 关掉 Ollama 默认的静默 5 分钟卸载（默认 -1 永不过期）
               "keep_alive": keep_alive()}
    if options:
        payload["options"] = options
    if stop:
        payload["options"] = dict(payload.get("options") or {}, stop=stop)
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(UPSTREAM + "/api/chat", data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    t0 = time.time()
    try:
        resp = _OPENER.open(req, timeout=timeout)
        obj = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise BackendError("Ollama HTTP {}: {}".format(e.code, body))
    except Exception as e:
        raise BackendError("Ollama 调用失败（{} 是否在跑？）: {}".format(UPSTREAM, e))

    total_ms = int(round((time.time() - t0) * 1000))
    text = ""
    try:
        text = ((obj.get("message") or {}).get("content") or "").strip()
    except Exception:
        text = ""

    def ns2ms(v):
        try:
            return int(round(int(v) / 1_000_000))
        except Exception:
            return 0

    part = {
        "load_ms": ns2ms(obj.get("load_duration")),
        "prompt_eval_ms": ns2ms(obj.get("prompt_eval_duration")),
        "eval_ms": ns2ms(obj.get("eval_duration")),
        "total_ms": total_ms,
        "prefill_ms": ns2ms(obj.get("load_duration")) + ns2ms(obj.get("prompt_eval_duration")),
        "generate_ms": ns2ms(obj.get("eval_duration")),
        "prompt_tokens": obj.get("prompt_eval_count") or 0,
        "output_tokens": obj.get("eval_count") or 0,
        "input_chars": sum(len(m.get("content") or "") for m in messages),
        "output_chars": len(text),
    }
    _acc(ctx.stage, part)
    return text


def _parse_line_list(text, lines):
    """把"只输出 JSON 数组"的回包解析成等长列表。不合法 → 抛 BackendError。"""
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw[:4].lower() == "json":
            raw = raw[4:].strip()
    arr = None
    try:
        obj = json.loads(raw)
        if isinstance(obj, list):
            arr = obj
        elif isinstance(obj, dict) and isinstance(obj.get("translations"), list):
            arr = obj["translations"]
    except Exception:
        s, e = raw.find("["), raw.rfind("]")
        if s >= 0 and e > s:
            try:
                arr = json.loads(raw[s:e + 1])
            except Exception:
                arr = None
    if not isinstance(arr, list) or len(arr) != len(lines):
        got = len(arr) if isinstance(arr, list) else "非数组"
        raise BackendError(
            "通用模型返回的译文条数不匹配（期望 {}，实得 {}）；原始返回前 200 字: {}".format(
                len(lines), got, raw[:200]))
    out = []
    for i, v in enumerate(arr):
        s = ("" if v is None else str(v)).strip()
        if not s:
            raise BackendError("通用模型第 {} 条译文为空".format(i))
        out.append(s)
    return out


class Backend:
    name = "base"

    def translate_lines(self, lines, ctx):
        raise NotImplementedError


class SakuraBackend(Backend):
    """Sakura / GalTransl 专用翻译模型。

    ⚠️ 绝不能把通用指令直接喂给它 —— 必须经 `sakura.py` 规范化成官方格式，
    并带上官方生成参数（temperature/top_p/repeat_penalty）。详见 `sakura.py` 顶部说明。
    """
    name = "sakura"

    def _one(self, japanese, ctx):
        """单段（可含多行）→ 官方格式调用。"""
        messages = sakura.build_messages(ctx.model, japanese)
        if DEBUG_DUMP:
            try:
                log("  [DEBUG] Sakura 规范化后 user 文本（前 800 字）:\n{}".format(
                    messages[1]["content"][:800]), model=ctx.model)
            except Exception:
                pass
        text = _ollama_chat(ctx.model, messages, ctx,
                            options=sakura.OFFICIAL_OPTIONS,
                            stop=sakura.STOP_TOKENS)
        if not text:
            raise BackendError("Sakura 返回空文本（model={}）".format(ctx.model))
        return text.strip()

    def _try_batch(self, lines, ctx, tagged=False):
        """整批一次调用。行数不匹配 / 有空行 → None（由调用方决定回退）。

        `tagged=True` 是**失配后的补救档**：给每行加 `序号|` 前缀再送，返回后按序号对齐。

        为什么要有这一档（2026-10-10 实测，同一批真实失败原文重放 14 次）：
          · 普通送法缺行 9 次，带行序号 0 次 —— 模型有了显式行锚点就不跳行；
          · 日志从「送入 6 / 返回 5」升级成「缺第 1 行」，事后可归因；
          · 代价是输出多约 2.2 token/行（生成耗时 +30%），所以**只在失配时才用**。
            历史真实失配率 6.9%，每次都加要付 +25% 期望耗时，只在失配时加只付 +5.7%。
        """
        if not tagged:
            out = self._one("\n".join(lines), ctx)
            got = [g.strip() for g in out.split("\n")]
            if len(got) != len(lines) or any(not g for g in got):
                # 记下**实际行数**：只写"不匹配"无法区分"漏行"与"多输出/重复行"，
                # 事后只能靠猜（这条日志缺口让 10-04~10-06 那 101 次失败全都无法归因）。
                log("  批量返回行数不符（送入 {} / 返回 {}，其中空行 {}）".format(
                    len(lines), len(got), sum(1 for g in got if not g)), model=ctx.model)
                return None
            return got

        out = self._one("\n".join(sakura.tag_lines(lines)), ctx)
        rows = [g.strip() for g in out.split("\n")]
        ids, texts, unparsed = sakura.untag_lines(rows)
        expect = list(range(1, len(lines) + 1))
        missing = [x for x in expect if x not in ids]
        dup = sorted({i for i in ids if ids.count(i) > 1})
        disordered = ids != [x for x in expect if x in ids]
        if (missing or dup or unparsed or disordered
                or len(texts) != len(lines) or any(not t for t in texts)):
            # 不再重复「批量行数不匹配」这个关键词：上面 plain 那次已经记过，
            # 一个请求只留一条，避免日后统计失配率时被重复计数。
            log("  带序号重跑仍不匹配（送入 {} / 返回 {}，缺行 {}，"
                "重复 {}，未带序号 {}，乱序 {}）".format(
                    len(lines), len(ids), missing, dup, len(unparsed), disordered),
                model=ctx.model)
            return None
        log("  带序号重跑成功（{} 行，缺行已补回）".format(len(lines)), model=ctx.model)
        return texts

    def translate_lines(self, lines, ctx):
        """规范化 → 分流（不可译/批量/逐条）→ 逐条显式失败。

        * 不可译文本（纯 ASCII/数字/符号）**不送模型**，原样返回 ——
          让 Sakura 去"翻译"它只会得到幻觉。
        * 可批量时按 `sakura.MAX_INPUT_CHARS` 切块，避免整页超上下文崩坏。
        * 任何拿不到译文的路径都抛 BackendError，绝不 `or 原文`。
        """
        if not lines:
            return []

        norm = [sakura.normalize_japanese(x) for x in lines]
        out = [None] * len(norm)
        # 哪些条目是"不可译、没送过模型"的 —— 它们不参与下面的空值断言。
        # （2026-10-05 修复：原文只剩零宽字符时 norm[i] 会是空串，旧实现把它当模型的
        #   "空译文"撞上 `_finalize` 的断言 → 一行脏输入让整页 502。）
        passthrough = [False] * len(norm)

        # 1) 不可译的原地返回，不打扰模型
        pending = []
        for i, s in enumerate(norm):
            if not s or not sakura.has_translatable(s):
                out[i] = s
                passthrough[i] = True
            else:
                pending.append(i)

        # 2) 批量（可选，按字符数切块）
        if BATCH_TRANSLATE and sakura.batchable([norm[i] for i in pending]):
            idxs = list(pending)
            done = False
            chunks = sakura.chunk_lines([norm[i] for i in idxs])
            if len(chunks) == 1 and len(chunks[0]) == len(idxs):
                got = self._try_batch(chunks[0], ctx)
                if got is not None:
                    for pos, i in enumerate(idxs):
                        out[i] = got[pos]
                    log("  批量翻译成功（{} 行）".format(len(idxs)), model=ctx.model)
                    done = True
                else:
                    # 第一级补救：**带行序号重跑一次**（单次请求）。
                    #
                    # 实证（2026-10-10，拿日志里 01:29:10 那次真实失败原文重放 14 次）：
                    # 普通送法缺行 9 次，带行序号 0 次 —— 模型有了显式行锚点就不跳行。
                    # 成本只在失配时才付（历史真实失配率 6.9%），平时零开销。
                    # 带序号也失败 → 不切块，直接沿用 shinobu 原本的逐行请求兜底（见下方第 3 步）。
                    got = self._try_batch(chunks[0], ctx, tagged=True)
                    if got is not None:
                        for pos, i in enumerate(idxs):
                            out[i] = got[pos]
                        done = True
            if done:
                return _finalize_all(out, norm, passthrough)

        # 3) 逐条（shinobu 原本的兜底：整批 / 带序号重跑都失败时，逐行请求）
        for i in pending:
            out[i] = self._one(norm[i], ctx)
        return _finalize_all(out, norm, passthrough)


def _finalize(v, fallback_norm):
    """兜底断言：绝不允许把原文当译文返回。"""
    if v is None or not str(v).strip():
        raise BackendError("译文中出现空值（原文: {}）".format((fallback_norm or "")[:60]))
    return str(v).strip()


def _finalize_all(values, norm, passthrough):
    """逐条收口。

    · 送过模型的条目 → `_finalize`（空值必须显式失败）；
    · 不可译的条目（`passthrough[i]`）→ 原样返回，**不做空值断言** ——
      它们从没送过模型，不存在"模型返回空译文"这回事；规范化后为空就是空。
    """
    out = []
    for i, v in enumerate(values):
        if passthrough[i]:
            out.append("" if v is None else v)
        else:
            out.append(_finalize(v, norm[i]))
    return out


class GenericBackend(Backend):
    """通用模型（Qwen 等）：只产出纯译文 JSON 数组，结构由服务端拼装。

    这样避免模型把 UUID / columns 数组也生成出来（v1 实测这会多出近一半 token）。
    """
    name = "generic"

    def translate_lines(self, lines, ctx):
        if not lines:
            return []
        user = json.dumps(lines, ensure_ascii=False)
        text = _ollama_chat(ctx.model, [{"role": "system", "content": QWEN_LINES_SYSTEM},
                                        {"role": "user", "content": user}], ctx)
        if not text:
            raise BackendError("通用模型返回空文本（model={}）".format(ctx.model))
        return _parse_line_list(text, lines)

    def chat(self, messages, ctx):
        """非结构化：原样转发 messages。"""
        text = _ollama_chat(ctx.model, messages, ctx)
        if not text:
            raise BackendError("通用模型返回空文本（model={}）".format(ctx.model))
        return text


BACKENDS = {"sakura": SakuraBackend(), "generic": GenericBackend()}


def stage_to_trace(stage):
    """ctx.stage → trace 的 stages 字典（键名与 v1 保持兼容，便于对账）。"""
    s = stage or {}
    return {
        "sakura_prefill_ms": s.get("prefill_ms", 0),
        "sakura_generate_ms": s.get("generate_ms", 0),
        "ollama_prompt_eval_ms": s.get("prompt_eval_ms", 0),
        "ollama_eval_ms": s.get("eval_ms", 0),
        "ollama_load_ms": s.get("load_ms", 0),
        "sakura_total_ms": s.get("total_ms", 0),
        "prompt_tokens": s.get("prompt_tokens", 0),
        "output_tokens": s.get("output_tokens", 0),
        "input_chars": s.get("input_chars", 0),
        "output_chars": s.get("output_chars", 0),
    }
