#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 服务端端到端自测。

覆盖四条路径 + 两个"必须成立"的断言：
  T1 /health
  T2 /ocr
  T3 /v1/chat/completions 简版 → 译出中文；并断言翻译侧仍落一条 image.jsonl 归档
     （整页"配对"已删：2026-10-04 用户拍板，它从未在真机生效）
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

_fail = []

# 本机调用绝不走系统代理：环境里若设了 http_proxy 且无 no_proxy，
# urllib 会把 127.0.0.1 也塞给代理，拿回一个莫名其妙的 502。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ok(name, detail=""):
    print(f"[PASS] {name}" + (f"  {detail}" if detail else ""))


def bad(name, detail=""):
    print(f"[FAIL] {name}" + (f"  {detail}" if detail else ""))
    _fail.append(name)


def post(base, path, obj, timeout=300):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base.rstrip("/") + path, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with _OPENER.open(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, {"raw": body[:400]}


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


def last_image_record(_model=None):
    """取 logs/ 下最新的 image.jsonl 的最后一条。

    不按模型名拼路径 —— 服务端会把它解析成真实模型名（可能带 :latest），
    测试脚本不该复刻那条规则，否则测的是"路径对不对"而不是"记录对不对"。
    """
    files = sorted((ROOT / "logs").glob("*/*.image.jsonl"),
                   key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return None, ROOT / "logs"
    p = files[0]
    lines = [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    return (json.loads(lines[-1]) if lines else None), p


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
        st, resp = post(base, "/ocr", {"images": [
            {"id": "line-1", "data": b64, "direction": "h"}]})
        items = resp if isinstance(resp, list) else [resp]
        text = " ".join(str(i.get("text", "")) for i in items if isinstance(i, dict))
        if st == 200 and has_cjk(text):
            ok("T2 /ocr", f"识别: {text}")
        else:
            bad("T2 /ocr", f"status={st} resp={str(resp)[:200]}")
    except Exception as e:
        bad("T2 /ocr", str(e))

    # T3 简版翻译 + 归档落盘
    try:
        st, resp = post(base, "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": f"原文：{JP}"}],
            "stream": False})
        content = ""
        try:
            content = resp["choices"][0]["message"]["content"]
        except Exception:
            content = json.dumps(resp, ensure_ascii=False)[:200]
        if st == 200 and has_cjk(content) and not has_kana(content):
            ok("T3 简版翻译", f"{JP} -> {content.strip()[:60]}")
        else:
            bad("T3 简版翻译", f"status={st} content={content[:160]}")

        rec, path = last_image_record(model)
        if rec and rec.get("translate_list"):
            ok("T3b 翻译归档落盘", f"{path.name} translate_list={len(rec.get('translate_list') or [])} 条")
        else:
            bad("T3b 翻译归档落盘",
                f"最后一条记录里没有 translate_list: "
                f"{json.dumps(rec, ensure_ascii=False)[:200] if rec else '无'}")
    except Exception as e:
        bad("T3 简版翻译", str(e))

    # T4 结构化
    try:
        regions_in = [{"id": "r1", "sourceText": {"plainText": JP}, "direction": "h", "targetLines": 1},
                      {"id": "r2", "sourceText": {"plainText": JP2}, "direction": "v", "targetColumns": 2}]
        prompt = "输入数据：" + json.dumps(regions_in, ensure_ascii=False)
        st, resp = post(base, "/v1/chat/completions", {
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
        st, resp = post(base, "/v1/chat/completions", {
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
        bad("T5 失败显式报错", str(e))

    print("=" * 74)
    print(" 结果:", "全部通过" if not _fail else f"失败 {len(_fail)} 项: {', '.join(_fail)}")
    return 1 if _fail else 0


if __name__ == "__main__":
    sys.exit(main())
