#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 入口与 HTTP 路由。

职责边界：本文件**只做 route → service**，不放业务逻辑（目标 ~250 行）。

v1 的 P0-C 修复：**先落盘，后响应**。v1 把 `_send(200,...)` 排在记账之前，
响应已发出、处理线程才崩，记录就永远写不进去。
"""
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import ocr as ocr_mod                                             # noqa: E402
from backends import BackendError                                 # noqa: E402
from config import (DEFAULT_PORT, GLOSSARY_FILE, LISTEN_HOST,     # noqa: E402
                    SAKURA_MODEL, UPSTREAM, keep_alive)
from glossary import default_sakura_system, load_sakura_system     # noqa: E402
from logging_ import daily_log_path, log, trace_event             # noqa: E402
from ocr import handle_ocr                                        # noqa: E402
from pages import PAGES                                           # noqa: E402
from translate import (PipelineError, RequestContext,             # noqa: E402
                       assemble_translate_payload, handle_translate)
from panel import CONTROL_PANEL_HTML                              # noqa: E402
from vram import (ensure_inactive_unloaded, load_model,            # noqa: E402
                  local_model_names, model_base, model_status,
                  resolve_model, unload_all_models, unload_model)

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
        ctx = RequestContext(model=target, backend=backend, page_key=obj.get("pageKey"))

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
        payload = assemble_translate_payload(ctx, result.translate_list)
        PAGES.complete(ctx.page_key, payload)
        trace_event({"type": "translate", "mode": result.mode,
                     "regions": result.region_count, "pageKey": ctx.page_key,
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

    # ---- 模型控制（面板 + 接口）----
    def _handle_model(self, body):
        try:
            obj = json.loads(body.decode("utf-8", "replace")) if body else {}
        except Exception:
            obj = {}
        path = self.path.split("?")[0].rstrip("/")

        if path.endswith("/model/status"):
            self._send_json(200, model_status())
            return
        if path.endswith("/model/unload-all"):
            unload_all_models()
            self._send_json(200, {"ok": True, "detail": "已卸载全部驻留模型"})
            return

        name = obj.get("model") or obj.get("name")
        if not name:
            self._send_json(400, {"error": "缺少 model 字段"})
            return
        target, _backend = resolve_model(name)

        if path.endswith("/model/load"):
            okk, ms, detail, unloaded = load_model(target)
            self._send_json(200 if okk else 502,
                            {"ok": okk, "model": target, "ms": ms,
                             "detail": detail, "unloaded": unloaded})
            return
        if path.endswith("/model/unload"):
            unload_model(target)
            self._send_json(200, {"ok": True, "model": target, "detail": "已请求卸载"})
            return
        self._send_json(404, {"error": "未知的 /model 路径: {}".format(self.path)})

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send_json(200, self._health())
            return
        if self.path in ("/", "/index.html", "/panel"):
            self._send(200, CONTROL_PANEL_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if self.path.startswith("/model/status"):
            self._send_json(200, model_status())
            return
        if self.path.startswith("/v1/models"):
            names = local_model_names() or [SAKURA_MODEL]
            self._send_json(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "dmb-local", "root": model_base(n)}
                for n in names]})
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
        if self.path.startswith("/model/"):
            self._handle_model(body)
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
    names = local_model_names()
    custom = os.path.exists(os.path.join(HERE, "sakura_prompt.txt")) and \
        load_sakura_system(SAKURA_MODEL).strip() != default_sakura_system(SAKURA_MODEL).strip()
    log("=" * 60)
    log("dmbTranslator v2 本地服务已启动: http://{}:{}".format(LISTEN_HOST, LISTEN_PORT))
    log("  翻译端点  Shinobu Base URL 填 http://127.0.0.1:{}/v1".format(LISTEN_PORT))
    log("  OCR 端点  http://127.0.0.1:{}/ocr".format(LISTEN_PORT))
    log("  转发上游  {}".format(UPSTREAM))
    log("  可用模型  {}".format(", ".join(names) or "(拉取失败)"))
    log("  默认模型  {}".format(SAKURA_MODEL))
    log("  模型控制  http://{}:{}/   （加载/卸载模型按钮）".format(LISTEN_HOST, LISTEN_PORT))
    log("  驻留策略  keep_alive={}  {}".format(
        keep_alive(), "（永不过期，只能手动卸载）" if keep_alive() in (-1, "-1")
        else "（会自动卸载，设 DMB_KEEP_ALIVE=-1 可关闭）"))
    log("  Sakura提示  {}".format("自定义文件" if custom else "按模型版本自动选择"))
    log("  日志目录  {}  (按模型分子目录，每天一个文件)".format(
        os.path.dirname(daily_log_path("log", SAKURA_MODEL))))
    log("  当天日志  {}".format(daily_log_path("log", SAKURA_MODEL)))
    log("  整页日志  {}".format(daily_log_path("image", SAKURA_MODEL)))
    log("=" * 60)


def main():
    _ensure_glossary()
    banner()
    # 卸载显存里的模型放到后台：实测卸载一个 14B 模型要 ~19s，
    # 若同步执行，端口在这 19 秒内是死的（实测踩过）。先起监听，再慢慢清显存。
    threading.Thread(target=unload_all_models, name="startup-unload", daemon=True).start()
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
