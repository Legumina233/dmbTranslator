#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 入口与 HTTP 路由（OCR + 翻译）。

职责边界：本文件**只做 route → service**，不放业务逻辑（目标 ~250 行）。

★ 2026-10-04（用户拍板）：**ollama 与模型控制已拆到独立服务** `ollama_server.py`（11437）。
  本服务只剩 manga-ocr（/ocr）与 Sakura 规范化翻译（/v1/chat/completions），
  与 ollama 的启停/模型加载卸载**互不依赖**，两边可自由开关。
  所以这里不再有 /model/* 路由，启动时也不再清显存（那是 ollama 服务的事）。

v1 的 P0-C 修复：**先落盘，后响应**。v1 把 `_send(200,...)` 排在记账之前，
响应已发出、处理线程才崩，记录就永远写不进去。
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ocr as ocr_mod                                             # noqa: E402
from backends import BackendError                                 # noqa: E402
from config import (DEFAULT_OLLAMA_SERVICE_PORT, DEFAULT_PORT,     # noqa: E402
                    GLOSSARY_FILE, LISTEN_HOST, SAKURA_MODEL, UPSTREAM,
                    keep_alive)
from glossary import default_sakura_system, load_sakura_system     # noqa: E402
from logging_ import (daily_log_path, log, trace_event,           # noqa: E402
                     write_image_record)
from ocr import handle_ocr                                        # noqa: E402
from translate import (PipelineError, RequestContext,             # noqa: E402
                       assemble_translate_payload, handle_translate)
from panel import SERVER_PANEL_HTML                               # noqa: E402
# 翻译路径仍需"请求的模型名 → 实际模型 + 后端"与"腾显存"两件小事：
# 它们是**对 Ollama 的查询**（HTTP 客户端），不是模型控制面 —— 控制面在 ollama_server。
from vram import ensure_inactive_unloaded, resolve_model           # noqa: E402

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_json_response(model, content, stream=False):
    """OpenAI 兼容回包。stream 时给一段合法的 SSE（内容一次性发出）。"""
    if stream:
        chunk = {
            "id": "chatcmpl-dmb", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": content},
                         "finish_reason": None}],
        }
        end = {
            "id": "chatcmpl-dmb", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }
        body = "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n".format(
            json.dumps(chunk, ensure_ascii=False), json.dumps(end, ensure_ascii=False))
        return body.encode("utf-8"), "text/event-stream"
    obj = {
        "id": "chatcmpl-dmb", "object": "chat.completion",
        "created": int(time.time()), "model": model,
        "choices": [{"index": 0,
                     "message": {"role": "assistant", "content": content},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }
    return json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # ---- CORS：扩展从 chrome-extension:// 跨域调用 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _send_json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _passthrough(self, body, method):
        """未识别的路径原样转发到 Ollama（保留 v1 行为）。"""
        req = urllib.request.Request(UPSTREAM + self.path,
                                     data=body if body else None, method=method)
        for h in ("Content-Type", "Authorization", "Accept"):
            if h in self.headers:
                req.add_header(h, self.headers[h])
        try:
            resp = _OPENER.open(req, timeout=600)
            status, data = resp.status, resp.read()
            ctype = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
            ctype = e.headers.get("Content-Type", "application/json")
        except Exception as e:
            status, data = 502, json.dumps({"error": str(e)}).encode("utf-8")
            ctype = "application/json"
        self._send(status, data, ctype)

    # ---- 翻译 ----
    def _handle_chat(self, body):
        try:
            obj = json.loads(body.decode("utf-8", "replace"))
        except Exception:
            return False
        requested = obj.get("model") or SAKURA_MODEL
        target, backend = resolve_model(requested)
        messages = obj.get("messages") or []
        stream = bool(obj.get("stream"))
        ctx = RequestContext(model=target, backend=backend)

        t_unload = time.time()
        ensure_inactive_unloaded(target)
        ctx.unload_ms = int(round((time.time() - t_unload) * 1000))

        try:
            result = handle_translate(ctx, messages)
        except PipelineError as e:
            log("管线无法处理该输入，回退透传: {}".format(e), model=target)
            return False
        except BackendError as e:
            # ★ 失败必须说出来，绝不返回原文冒充译文（P0-B）
            log("!! 翻译失败（已显式报错，不返回原文）: {}".format(e), model=target)
            self._send_json(502, {"error": {
                "message": str(e), "type": "backend_error", "model": target}})
            trace_event({"type": "translate", "mode": "error",
                         "duration_ms": ctx.elapsed_ms(), "error": str(e),
                         "stages": ctx.trace_stages()}, model=target)
            return True

        data, ctype = build_json_response(target, result.content, stream)

        # ★ 先落盘，后响应（P0-C）
        # 2026-10-04 用户拍板：整页「配对」机制已删 —— 它在真机从未生效（扩展两端都不带
        # pageKey，481 条真机记录全是 none(no pageKey)）。归档本身保留：翻译侧照旧落一条，
        # OCR 侧不再落（那是没配对的纯噪音）。详见 docs/SERVER.md §七。
        payload = assemble_translate_payload(ctx, result.translate_list)
        write_image_record(payload, model=target)
        trace_event({"type": "translate", "mode": result.mode,
                     "regions": result.region_count,
                     "duration_ms": ctx.elapsed_ms(), "stages": ctx.trace_stages()},
                    model=target)
        log(">>> 已返回 {} 结果 ({} region, {} ms)".format(
            result.mode, result.region_count, ctx.elapsed_ms()), model=target)
        self._send(200, data, ctype)
        return True

    def _health(self):
        return {
            "status": "ok",
            "sakura_model": SAKURA_MODEL,
            "upstream": UPSTREAM,
            "ocr_loaded": ocr_mod._ocr is not None,
            "ocr_error": ocr_mod._ocr_error,
            "port": LISTEN_PORT,
        }

    # ---- 模型控制已拆走（2026-10-04）----
    # /model/* 与"加载/卸载/状态"归 ollama 独立服务（11437，server/ollama_server.py）。
    # 本服务不再提供这些路由：这样 dmb_server 关掉也能管模型，两边互不牵连。

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send_json(200, self._health())
            return
        if self.path in ("/", "/index.html", "/panel"):
            self._send(200, SERVER_PANEL_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        self._passthrough(None, "GET")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""

        if self.path.startswith("/ocr"):
            status, obj = handle_ocr(body)
            self._send_json(status, obj)
            return
        if self.path.startswith("/health"):
            self._send_json(200, self._health())
            return
        if "/chat/completions" in self.path or "/api/chat" in self.path:
            if self._handle_chat(body):
                return
        self._passthrough(body, "POST")


def _ensure_glossary():
    if os.path.exists(GLOSSARY_FILE):
        return
    try:
        with open(GLOSSARY_FILE, "w", encoding="utf-8") as f:
            f.write("// Sakura 术语表，格式：原文->译文 #注释\n")
            f.write("// 修改后自动热重载，无需重启服务\n")
    except Exception:
        pass


def banner():
    custom = os.path.exists(os.path.join(HERE, "sakura_prompt.txt")) and \
        load_sakura_system(SAKURA_MODEL).strip() != default_sakura_system(SAKURA_MODEL).strip()
    log("=" * 60)
    log("dmbTranslator v2 本地服务已启动: http://{}:{}".format(LISTEN_HOST, LISTEN_PORT))
    log("  翻译端点  Shinobu Base URL 填 http://127.0.0.1:{}/v1".format(LISTEN_PORT))
    log("  OCR 端点  http://127.0.0.1:{}/ocr  （manga-ocr，本地 GPU）".format(LISTEN_PORT))
    log("  转发上游  {}".format(UPSTREAM))
    log("  默认模型  {}   keep_alive={}".format(SAKURA_MODEL, keep_alive()))
    log("  Sakura提示  {}".format("自定义文件" if custom else "按模型版本自动选择"))
    log("  模型/ollama 控制  → 已拆到独立服务 http://{}:{}".format(
        LISTEN_HOST, DEFAULT_OLLAMA_SERVICE_PORT))
    log("  日志目录  {}  (按模型分子目录，每天一个文件)".format(
        os.path.dirname(daily_log_path("log", SAKURA_MODEL))))
    log("  当天日志  {}".format(daily_log_path("log", SAKURA_MODEL)))
    log("  整页日志  {}".format(daily_log_path("image", SAKURA_MODEL)))
    log("=" * 60)


def main():
    _ensure_glossary()
    banner()
    # 注意：本服务**不再**在启动时清显存 —— 那是 ollama 独立服务启动时的活。
    # （原先在这里卸模型，会让"启动 OCR/翻译服务"顺带动 ollama 的状态，正是要解开的耦合。）
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
