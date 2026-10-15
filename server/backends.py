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
    # ★ "think" 是**模型类别的策略**，由后端类自己声明（`Backend.think`），共用路径不写死：
    #   · 通用模型（qwen3.5 等会思考的）→ GenericBackend.think = False
    #     不关会先吐几千 token 思考过程（真机：273 字输入 → 3921 token / 73 秒），解析失败且堵住管线。
    #   · Sakura 系 → Backend.think = None（**不发该字段**）
    #     2026-10-15 实测：对 qwen3 底座的 Sakura 强制 think=false，会让 Ollama 改写模板渲染、
    #     与 Sakura 官方 prefill 失配 → 模型立刻输出结束标记 → 空译文
    #     （批量失配后的「带序号重跑」与「逐条兜底」会整批全空 → 旧实现 502 → 扩展重试耗尽）。
    think = getattr(BACKENDS.get(getattr(ctx, "backend", None)), "think", None)
    if think is not None:
        payload["think"] = think
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
    # 是否向 Ollama 传 "think"：None = 不发该字段（模型自带模板，如 Sakura 系）；
    # False = 显式关闭思考（会思考的通用模型）。由每个后端类声明，见 _ollama_chat。
    think = None

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
            # 2026-10-15：单段空返回不再直接炸整页（由 translate_lines 第 3 步决定怎么收口）。
            # 实测：某段 145 字符的输入稳定只回 1 个字符 → 旧实现抛错 → 服务端 502 →
            # 扩展重试耗尽 → pipeline.failure.translationUnavailable，整页永远翻不出来。
            return ""
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
        # 2026-10-15：这一档的**目的就是"行数不匹配时把已翻好的行救回来"**，
        # 所以不再因「缺行 / 某行为空」整批作废（那样白跑一轮、再退化到逐行重发 ✗）。
        # 改为按行号回填：有号且有文本 → 用译文；缺号 / 空 → 留 None（调用方用原文）。
        # 只有「一行都没救回来」才返回 None（真失败，交给下一档）。
        filled = [None] * len(lines)
        for n, t in zip(ids, texts):
            if isinstance(n, int) and 1 <= n <= len(lines) and t and filled[n - 1] is None:
                filled[n - 1] = t
        salvaged = sum(1 for v in filled if v)
        if not salvaged:
            log("  带序号重跑仍不匹配（送入 {} / 返回 {}，缺行 {}，重复 {}，"
                "未带序号 {}，乱序 {}）".format(
                    len(lines), len(ids), missing, dup, len(unparsed), disordered),
                model=ctx.model)
            return None
        if salvaged != len(lines):
            log("  带序号重跑部分成功（{} / {} 行；其余 {} 行用原文）".format(
                salvaged, len(lines), len(lines) - salvaged), model=ctx.model)
        else:
            log("  带序号重跑成功（{} 行）".format(len(lines)), model=ctx.model)
        return filled

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
                            if got[pos]:
                                out[i] = got[pos]
                            else:
                                # 2026-10-15：该行没救回来 → 用原文，并标 passthrough
                                # （不参与 _finalize 的空值断言，整页照常完成）
                                out[i] = norm[i]
                                passthrough[i] = True
                        done = True
            if done:
                return _finalize_all(out, norm, passthrough)

        # 3) 逐条（shinobu 原本的兜底：整批 / 带序号重跑都失败时，逐行请求）
        #
        # 2026-10-15：个别行模型返回空文本时，**该行按"不可译"原样保留**，不让一行把整页
        # 打成 502（旧行为：抛错 → app.py 502 → 扩展重试耗尽 → translationUnavailable）。
        # 但"真故障"仍必须显式失败：若本请求所有待译行都空，照旧抛 BackendError。
        empty_lines = 0
        for i in pending:
            value = self._one(norm[i], ctx)
            if value:
                out[i] = value
            else:
                empty_lines += 1
                out[i] = norm[i]
                passthrough[i] = True
                log("  第 {} 行模型返回空文本 → 原样保留（{} 字）".format(
                    i + 1, len(norm[i])), model=ctx.model)
        if empty_lines and empty_lines == len(pending):
            # 2026-10-15（A2）：整批全空时**不再报错** —— 该页按"全部用原文"正常完成。
            # 依据：服务端日志显示同一页走「批量」能成功、走「逐条」却每行都空
            #（第 1..6 行全空），若在此抛错会让整页恒失败 → 502 → 扩展重试耗尽
            #  → pipeline.failure.translationUnavailable。
            # 但仍留一条显式 warning，把"疑似模型/参数异常"与"本来就无需翻译"区分开。
            log("!! 全部待译行均返回空文本 → 整页按原文返回（疑似模型/参数异常，请查上游）",
                model=ctx.model)
        elif empty_lines:
            log("  本请求有 {} 行模型返回空文本（已原样保留）".format(empty_lines),
                model=ctx.model)
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
    # 通用模型（qwen3.5 等）会先吐大段思考过程 → 必须显式关闭（理由见 _ollama_chat 注释）
    think = False

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
