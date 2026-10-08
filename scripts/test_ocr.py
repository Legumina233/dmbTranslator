#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 本地服务冒烟测试

自测项:
  1) 生成一张日文测试图（用系统日文字体），存到 tests/fixtures/jp_sample.png
  2) POST /ocr  → 校验能回出日文文本
  3) (--translate) POST /v1/chat/completions → 校验能回出中文

用法:
    python scripts/test_ocr.py
    python scripts/test_ocr.py --translate --model sakura-14b
    python scripts/test_ocr.py --url http://127.0.0.1:11436/ocr

需要 PIL（用带 torch/PIL 的那个 Python 跑；见 scripts/test_ocr.cmd 的自动探测）。
退出码: 0 = 通过；1 = 失败。
"""
import argparse
import base64
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "jp_sample.png"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\YuGothM.ttc",
    r"C:\Windows\Fonts\meiryo.ttc",
    r"C:\Windows\Fonts\msgothic.ttc",
    r"C:\Windows\Fonts\YuGothR.ttc",
]
JP_LINES = ["猫が庭で寝ている", "これはテストです"]


def pick_font():
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return p
    return None


def make_image(font_path):
    from PIL import Image, ImageDraw, ImageFont
    W, H, size, pad = 900, 320, 56, 40
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(font_path, size)
    y = pad
    for line in JP_LINES:
        d.text((pad, y), line, fill="black", font=f)
        y += size + 40
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return img, buf.getvalue()


# 本机调用绝不走系统代理（设了 http_proxy 而无 no_proxy 时，urllib 会拿回 502）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(url, payload, timeout=180):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with _OPENER.open(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    return json.loads(body), time.time() - t0


def has_cjk(s):
    return any(("\u3040" <= c <= "\u30ff") or ("\u4e00" <= c <= "\u9fff") for c in s or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:11436/ocr")
    ap.add_argument("--translate", action="store_true", help="附带测一次翻译")
    ap.add_argument("--model", default="sakura-14b")
    ap.add_argument("--base", default="http://127.0.0.1:11436", help="/v1 的 base")
    args = ap.parse_args()

    ok = True
    print("=" * 72)
    print(" dmbTranslator v2 —— 本地服务冒烟测试")
    print("=" * 72)

    try:
        import PIL  # noqa
    except Exception:
        print("[FAIL] 当前 Python 没有 PIL。请用带 PIL/torch 的环境跑，")
        print("       例如: 先 set DMB_PYTHON=<带 PIL/torch 的 python.exe>，再跑本脚本")
        return 1

    font = pick_font()
    if not font:
        print("[FAIL] 找不到日文字体，无法生成测试图。")
        return 1

    img, png = make_image(font)
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_bytes(png)
    print(f"[ OK ] 生成测试图: {FIXTURE}  ({len(png)//1024} KB, 字体={Path(font).name})")

    # ---- 1) OCR ----
    payload = {"images": [
        {"id": "line-1", "data": base64.b64encode(png).decode(), "direction": "h"},
    ]}
    try:
        resp, dt = post(args.url, payload)
    except Exception as e:
        print(f"[FAIL] 请求 {args.url} 失败: {e}")
        print("       （服务端没起来？先跑 scripts\\start_server.cmd，或确认 11436 在监听）")
        return 1

    items = resp if isinstance(resp, list) else resp.get("results") or resp.get("images") or []
    if not items and isinstance(resp, dict):
        items = [resp]
    texts = []
    for it in items:
        if isinstance(it, dict):
            texts.append(str(it.get("text", "")))
    joined = " / ".join(t for t in texts if t)
    print(f"[ OK ] POST /ocr  {dt*1000:.0f} ms")
    print(f"       -> 识别结果: {joined or '(空)'}")
    print(f"       期望包含: {' / '.join(JP_LINES)}")

    if joined and has_cjk(joined):
        print("[PASS] OCR 返回了日文文本")
    else:
        print("[FAIL] OCR 没返回有效日文 —— 检查 manga-ocr 模型是否加载成功")
        ok = False

    # ---- 2) 翻译（可选）----
    if args.translate:
        body = {
            "model": args.model,
            "messages": [
                {"role": "user", "content": "将下面的日文文本翻译成中文：\n猫が庭で寝ている"},
            ],
            "stream": False,
        }
        try:
            t0 = time.time()
            r, _ = post(args.base.rstrip("/") + "/v1/chat/completions", body, timeout=300)
            dt = time.time() - t0
            msg = ""
            try:
                msg = r["choices"][0]["message"]["content"]
            except Exception:
                msg = json.dumps(r, ensure_ascii=False)[:200]
            print(f"[ OK ] POST /v1/chat/completions  {dt:.1f}s  (含冷加载)"
                  f"  模型={args.model}")
            print(f"       -> 译文: {msg.strip()[:120]}")
            if msg and has_cjk(msg) and not any("\u3040" <= c <= "\u30ff" for c in msg):
                print("[PASS] 翻译返回了中文")
            else:
                print("[WARN] 译文可疑（可能仍是日文或为空），人工确认")
        except Exception as e:
            print(f"[FAIL] 翻译请求失败: {e}")
            ok = False

    print("=" * 72)
    print(" 结果:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
