#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Ollama 独立服务 —— 只管 ollama 引擎与它的模型（2026-10-04 用户拍板独立出来）。

**为什么单独一个进程**（用户原话：不要让 ollama 的启动依赖现有的 server）：
  · 原先"模型加载/卸载/状态"由 dmb_server（11436）提供，于是 dmb_server 一关就管不了模型，
    开关与卸载状态会互相牵连、出现"回弹"。
  · 现在这一层只做三件事：**启停 ollama 引擎**、**模型状态/加载/卸载**、**显存驻留口径**。
    dmb_server（manga-ocr + Sakura 规范化）与它**零依赖**，两边可以各自开关。

生命周期约定（与用户口径一致）：
  · 本服务启动 = 确保 ollama 引擎在跑（并清掉上次残留的驻留模型，保证状态干净）。
  · 关闭 ollama（POST /service/stop 或本服务收到 /shutdown）=
      **先卸载全部驻留模型（强制：在跑的推理也停）→ 再结束 ollama 整棵进程树 → 确认端口关闭**。
    顺序不能反，反了就再也发不出卸载请求，显存只能被动释放，下次打开会看到"回弹"。
  · 卸载单个模型 = 只卸它；同样**不被"进程正在跑"阻塞**（见 vram.unload_model_forced）。

端口：11437（`config.DEFAULT_OLLAMA_SERVICE_PORT`）。启动：`scripts\\start_ollama.cmd`。
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

import service_control                                            # noqa: E402
import vram                                                       # noqa: E402
from config import DEFAULT_OLLAMA_SERVICE_PORT, LISTEN_HOST, UPSTREAM  # noqa: E402
from logging_ import log                                          # noqa: E402
from panel import CONTROL_PANEL_HTML                              # noqa: E402

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OLLAMA_SERVICE_PORT

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_STOP_LOCK = threading.Lock()


def ollama_running():
    return service_control.port_open(service_control.OLLAMA_PORT)


def engine_state():
    """给 UI 的最小事实集：引擎在不在跑 + 驻留了什么。"""
    running = ollama_running()
    return {
        "running": running,
        "port": service_control.OLLAMA_PORT,
        "loaded": vram.loaded_models() if running else [],
        "service_port": LISTEN_PORT,
    }


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

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return (json.loads(raw.decode("utf-8", "replace")) if raw else {}), raw
        except Exception:
            return {}, raw

    def _passthrough(self, body, method):
        """未识别路径原样转发给 Ollama（例如 /api/tags、/api/ps）。"""
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

    # ---- 服务（ollama 引擎）----
    def _handle_service(self, body):
        path = self.path.split("?")[0].rstrip("/")
        if path.endswith("/service/status"):
            self._send_json(200, engine_state())
            return
        if path.endswith("/service/start"):
            result = service_control.start_ollama()
            status = 200 if result.get("running") else 502
            self._send_json(status, {**result, "state": engine_state()})
            return
        if path.endswith("/service/stop"):
            with _STOP_LOCK:
                result = service_control.stop_ollama()
            status = 200 if not result.get("running") else 502
            self._send_json(status, {**result, "state": engine_state()})
            return
        self._send_json(404, {"error": "未知的 /service 路径: {}".format(self.path)})

    # ---- 模型 ----
    def _handle_model(self, body, method):
        path = self.path.split("?")[0].rstrip("/")

        if path.endswith("/model/status"):
            self._send_json(200, vram.model_status())
            return
        if path.endswith("/model/unload-all"):
            ok, detail, unloaded = vram.unload_all_models_forced()
            self._send_json(200 if ok else 502,
                            {"ok": ok, "detail": detail, "unloaded": unloaded})
            return

        name = body.get("model") or body.get("name")
        if not name:
            self._send_json(400, {"error": "缺少 model 字段"})
            return
        target, _backend = vram.resolve_model(name)

        if path.endswith("/model/load"):
            okk, ms, detail, unloaded = vram.load_model(target)
            self._send_json(200 if okk else 502,
                            {"ok": okk, "model": target, "ms": ms,
                             "detail": detail, "unloaded": unloaded})
            return
        if path.endswith("/model/unload"):
            # ★ 强制语义：正在跑的推理也停 —— 卸载不能被进程卡住（用户拍板）
            ok, detail = vram.unload_model_forced(target)
            self._send_json(200 if ok else 502,
                            {"ok": ok, "model": target, "detail": detail})
            return
        self._send_json(404, {"error": "未知的 /model 路径: {}".format(self.path)})

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send_json(200, {"status": "ok", **engine_state()})
            return
        if self.path in ("/", "/index.html", "/panel"):
            self._send(200, CONTROL_PANEL_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if self.path.startswith("/service/"):
            self._handle_service({})
            return
        if self.path.startswith("/model/status"):
            self._handle_model({}, "GET")
            return
        if self.path.startswith("/v1/models"):
            names = vram.local_model_names()
            self._send_json(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "dmb-local", "root": vram.model_base(n)}
                for n in names]})
            return
        self._passthrough(None, "GET")

    def do_POST(self):
        body, raw = self._read_body()

        if self.path.startswith("/shutdown"):
            # 优雅收尾：先卸模型再停 ollama，然后本进程退出（宿主会再确认端口关闭）
            with _STOP_LOCK:
                result = service_control.stop_ollama()
            self._send_json(200, {"ok": not result.get("running"), **result})

            def _exit_later():
                time.sleep(0.5)
                log("收到关停请求，退出 ollama 服务")
                os._exit(0)

            threading.Thread(target=_exit_later, name="shutdown", daemon=True).start()
            return
        if self.path.startswith("/service/") or self.path.startswith("/health"):
            self._handle_service(body)
            return
        if self.path.startswith("/model/"):
            self._handle_model(body, "POST")
            return
        self._passthrough(raw, "POST")


def banner():
    log("=" * 60)
    log("dmbTranslator · Ollama 独立服务已启动: http://{}:{}".format(LISTEN_HOST, LISTEN_PORT))
    log("  引擎端口  {}（ollama）".format(service_control.OLLAMA_PORT))
    log("  转发上游  {}".format(UPSTREAM))
    log("  模型控制  http://{}:{}/   （加载/卸载按钮）".format(LISTEN_HOST, LISTEN_PORT))
    log("  与 dmb_server（OCR/翻译，11436）**互不依赖**：各自开关互不影响")
    log("=" * 60)


def main():
    banner()
    # 启动即：① 确保 ollama 引擎在跑（开关打开就该可用）；
    #        ② 后台清掉上次残留的驻留模型（保证"已加载"状态干净）。
    # 清显存要 ~19s，必须放后台，否则端口在这期间是死的（app.py 同款教训）。
    def _boot():
        result = service_control.start_ollama()
        if not result.get("running"):
            log("!! ollama 引擎未能启动: {}".format(result.get("error")))
            return
        vram.unload_all_models()

    threading.Thread(target=_boot, name="boot", daemon=True).start()
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
