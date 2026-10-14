#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 服务端端到端自测。

覆盖四条路径 + 三个"必须成立"的断言：
  T1 /health
  T2 /ocr
  T3 /v1/chat/completions 简版 → 译出中文
  T3b 响应头回显 X-DMB-Request-Id（客户端生成 → 服务端沿用并回显）
  T3c 统一事件流落盘：logs/events/<今天>.events.jsonl 里存在同 requestId 的 llm.call
      （`.image.jsonl` 归档已随 M4 下线，这里验的是当前唯一的翻译侧落点；
       服务端若以 DMB_EVENT_LOG=0 启动，本项必然失败）
  T4 /v1/chat/completions 结构化（regions）→ 回 regions，columns 按 targetLines/targetColumns 切
  T5 失败必须显式：故意请求一个不存在的模型名 + 空文本，断言**不会**把原文当译文返回

用法:  python scripts/test_server.py [--base http://127.0.0.1:11436] [--model sakura-14b]
需要 PIL（用于生成测试图）。建议用带 torch/PIL 的那个 Python 运行。
"""
import argparse
import base64
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

JP = "猫が庭で寝ている"
JP2 = "これはテストです"

# 贯穿 ID 的请求头名（与服务端 eventlog.REQUEST_ID_HEADER 同值）。
REQUEST_ID_HEADER = "X-DMB-Request-Id"

_fail = []

# 本机调用绝不走系统代理：环境里若设了 http_proxy 且无 no_proxy，
# urllib 会把 127.0.0.1 也塞给代理，拿回一个莫名其妙的 502。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ok(name, detail=""):
    print(f"[PASS] {name}" + (f"  {detail}" if detail else ""))


def bad(name, detail=""):
    print(f"[FAIL] {name}" + (f"  {detail}" if detail else ""))
    _fail.append(name)


def post(base, path, obj, timeout=300, headers=None):
    """POST 一个 JSON，返回 (status, 解析后的 body, 响应头)。

    响应头要回传：T3b 验的是"服务端回显了 X-DMB-Request-Id"，那只有响应头里才有。
    """
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        req.add_header(name, value)
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace")), r.headers
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body), e.headers
        except Exception:
            return e.code, {"raw": body[:400]}, e.headers


def get(base, path, timeout=30):
    with _OPENER.open(base.rstrip("/") + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def has_cjk(s):
    return any(("\u3040" <= c <= "\u30ff") or ("\u4e00" <= c <= "\u9fff") for c in s or "")


def has_kana(s):
    return any("\u3040" <= c <= "\u30ff" for c in s or "")


def make_png():
    sys.path.insert(0, str(ROOT / "scripts"))
    import test_ocr as toc
    font = toc.pick_font()
    if not font:
        raise SystemExit("找不到日文字体")
    _img, png = toc.make_image(font)
    return png


def event_log_path():
    """今天的统一事件流文件（与服务端 `eventlog.event_log_path()` 同规则）。"""
    import time as _t
    return ROOT / "logs" / "events" / "{}.events.jsonl".format(_t.strftime("%Y-%m-%d"))


def find_event(request_id, kind=None, path=None):
    """在统一事件流里按 requestId 找事件，返回 (event | None, path)。

    M4 起服务端只有这一个落点（`.image.jsonl` / `.trace.jsonl` 均已下线），
    所以"翻译侧有没有落盘"这件事现在只能、也只应该在这里验。
    """
    path = path or event_log_path()
    if not path.exists():
        return None, path
    hit = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("requestId") != request_id:
            continue
        if kind and rec.get("kind") != kind:
            continue
        hit = rec
    return hit, path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:11436")
    ap.add_argument("--model", default="sakura-14b")
    args = ap.parse_args()
    base, model = args.base, args.model

    print("=" * 74)
    print(" dmbTranslator v2 服务端端到端自测")
    print(f" base={base}  model={model}")
    print("=" * 74)

    # T1（服务端启动时会后台清显存，可能还没起监听 → 重试等待）
    import time as _t
    h, err = None, None
    for _ in range(30):
        try:
            h = get(base, "/health")
            break
        except Exception as e:
            err = e
            _t.sleep(1)
    if h and h.get("status") == "ok":
        ok("T1 /health", f"port={h.get('port')}")
    else:
        bad("T1 /health", str(err))
        print("\n服务端没起来？先跑:  server\\app.py 11436")
        return 1

    # T2
    try:
        png = make_png()
        b64 = base64.b64encode(png).decode()
        st, resp, _ = post(base, "/ocr", {"images": [
            {"id": "line-1", "data": b64, "direction": "h"}]})
        items = resp if isinstance(resp, list) else [resp]
        text = " ".join(str(i.get("text", "")) for i in items if isinstance(i, dict))
        if st == 200 and has_cjk(text):
            ok("T2 /ocr", f"识别: {text}")
        else:
            bad("T2 /ocr", f"status={st} resp={str(resp)[:200]}")
    except Exception as e:
        bad("T2 /ocr", "{}: {}".format(type(e).__name__, e))

    # T3 简版翻译 + 贯穿 ID 回显 + 事件流落盘
    req_id = "q-test-{}".format(int(_t.time() * 1000))
    hdr = None
    try:
        st, resp, hdr = post(base, "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": f"原文：{JP}"}],
            "stream": False}, headers={REQUEST_ID_HEADER: req_id})
        content = ""
        try:
            content = resp["choices"][0]["message"]["content"]
        except Exception:
            content = json.dumps(resp, ensure_ascii=False)[:200]
        if st == 200 and has_cjk(content) and not has_kana(content):
            ok("T3 简版翻译", f"{JP} -> {content.strip()[:60]}")
        else:
            bad("T3 简版翻译", f"status={st} content={content[:160]}")
    except Exception as e:
        bad("T3 简版翻译", "{}: {}".format(type(e).__name__, e))

    # T3b 贯穿 ID：客户端生成 → 服务端沿用并回显（设计 §6）
    try:
        echoed = hdr.get(REQUEST_ID_HEADER) if hdr is not None else None
        if echoed == req_id:
            ok("T3b requestId 回显", req_id)
        else:
            bad("T3b requestId 回显", f"发出 {req_id}，响应头回来 {echoed!r}")
    except Exception as e:
        bad("T3b requestId 回显", "{}: {}".format(type(e).__name__, e))

    # T3c 落盘：M4 起翻译侧只有统一事件流这一个落点（.image.jsonl 已下线）
    try:
        ev, path = find_event(req_id, kind="llm.call")
        if ev:
            what = ev.get("what") or {}
            ok("T3c 事件流落盘", "{} model={} regions={}".format(
                path.name, what.get("model"), what.get("regions")))
        else:
            bad("T3c 事件流落盘", "{} 里找不到 requestId={} 的 llm.call".format(path, req_id))
    except Exception as e:
        bad("T3c 事件流落盘", "{}: {}".format(type(e).__name__, e))

    # T4 结构化
    try:
        regions_in = [{"id": "r1", "sourceText": {"plainText": JP}, "direction": "h", "targetLines": 1},
                      {"id": "r2", "sourceText": {"plainText": JP2}, "direction": "v", "targetColumns": 2}]
        prompt = "输入数据：" + json.dumps(regions_in, ensure_ascii=False)
        st, resp, _ = post(base, "/v1/chat/completions", {
            "model": model, "messages": [{"role": "user", "content": prompt}],
            "stream": False})
        content = ""
        try:
            content = resp["choices"][0]["message"]["content"]
        except Exception:
            pass
        parsed = json.loads(content) if content.strip().startswith("{") else None
        regs = (parsed or {}).get("regions") or []
        good = (st == 200 and len(regs) == 2 and all(r.get("translation") for r in regs)
                and all(isinstance(r.get("columns"), list) for r in regs))
        if good:
            ok("T4 结构化 regions", f"{len(regs)} 个 region, columns={[r['columns'] for r in regs]}")
        else:
            bad("T4 结构化 regions", f"status={st} content={str(content)[:200]}")
    except Exception as e:
        bad("T4 结构化 regions", "{}: {}".format(type(e).__name__, e))

    # T5 失败必须显式（不返回原文）
    try:
        st, resp, _ = post(base, "/v1/chat/completions", {
            "model": "no-such-model-xyz",
            "messages": [{"role": "user", "content": "原文："}],
            "stream": False}, timeout=120)
        err = ""
        try:
            err = json.dumps(resp.get("error"), ensure_ascii=False)
        except Exception:
            err = str(resp)[:200]
        if st >= 400 and "error" in resp:
            ok("T5 失败显式报错", f"status={st} {err[:120]}")
        else:
            bad("T5 失败显式报错", f"status={st} 返回={str(resp)[:200]}")
    except urllib.error.HTTPError as e:
        ok("T5 失败显式报错", f"HTTP {e.code}")
    except Exception as e:
        bad("T5 失败显式报错", "{}: {}".format(type(e).__name__, e))

    print("=" * 74)
    print(" 结果:", "全部通过" if not _fail else f"失败 {len(_fail)} 项: {', '.join(_fail)}")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
