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
from config import (DEFAULT_OLLAMA_SERVICE_PORT, DEFAULT_PORT,     # noqa: E402
                    GLOSSARY_FILE, LISTEN_HOST, SAKURA_MODEL,
                    SAKURA_PROMPT_FILE, UPSTREAM, keep_alive)
from glossary import default_sakura_system, load_sakura_system     # noqa: E402
from logging_ import (daily_log_path, log)                         # noqa: E402
from ocr import handle_ocr                                        # noqa: E402
import eventlog                                                   # noqa: E402
import support as support_mod                                     # noqa: E402
from translate import (PipelineError, RequestContext,             # noqa: E402
                       assemble_translate_payload, handle_translate)
from panel import SERVER_PANEL_HTML                               # noqa: E402
# 翻译路径仍需"请求的模型名 → 实际模型 + 后端"与"腾显存"两件小事：
# 它们是**对 Ollama 的查询**（HTTP 客户端），不是模型控制面 —— 控制面在 ollama_server。
from vram import ensure_inactive_unloaded, resolve_model           # noqa: E402

LISTEN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def build_json_response(model, content, stream=False, timing=None):
    """OpenAI 兼容回包。stream 时给一段合法的 SSE（内容一次性发出）。

    `timing`（2026-10-04 新增）：本服务自己测的翻译耗时明细（模型 load/prefill/generate、
    token 数等），作为**非标准顶层字段 `dmb_timing`** 放进响应体 —— OpenAI 客户端会忽略
    未知字段，而我们的扩展靠它把服务端侧耗时并进"整页日志"（流式分支不带，见下）。
    """
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
    if timing:
        obj["dmb_timing"] = timing
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

    def _send(self, status, data, content_type, extra_headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        # ★ M1：贯穿 ID **回显** —— 客户端拿到就能记进自己的事件，两侧按它对齐。
        rid = getattr(self, "_request_id", None)
        if rid:
            self.send_header(eventlog.REQUEST_ID_HEADER, rid)
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            pass

    def _send_json(self, status, obj, extra_headers=None):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json", extra_headers=extra_headers)

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
        # ★ M1 贯穿 ID：与 /ocr 同一套规则（请求头带了就沿用，否则生成），由 `_send` 统一回显。
        request_id = eventlog.resolve_request_id(self.headers)
        self._request_id = request_id
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
            # ★ M1：失败也是第一公民 —— 服务端自己留一条 `failure` 事件
            # ★ M4：`.trace.jsonl` 已下线，分阶段耗时并入这里（原来另写一份 jsonl，
            #   同一件事两处写、还要靠人比对，违背"1 条事件流"）。
            eventlog.append_event({
                "kind": "failure", "level": "error",
                "requestId": request_id, "runId": request_id,
                "where": {"repo": "server", "module": "app", "fn": "_handle_chat"},
                "what": {"stage": "translate", "model": target, "retryable": True,
                         "mode": "error", "stages": ctx.trace_stages()},
                "err": {"type": "BackendError", "message": str(e)},
                "dur_ms": ctx.elapsed_ms(),
            })
            return True

        # 服务端侧耗时明细：与 trace.jsonl 里的 stages 同一份（sakura_*/ollama_*/tokens）
        data, ctype = build_json_response(target, result.content, stream, timing={
            "total_ms": ctx.elapsed_ms(),
            "unload_other_ms": ctx.unload_ms or 0,
            "stages": ctx.trace_stages(),
            "requestId": request_id,   # ★ 贯通 ID：回到扩展，被记进 page.completed 事件
        })

        # ★ 先落盘，后响应（P0-C）
        payload = assemble_translate_payload(ctx, result.translate_list)
        # M4：`.image.jsonl` 独立出口已下线。它的内容是**原文+译文**（Q4 排「翻译质量差」
        # 才需要），所以按设计 §5 归入 **L1 详细层**：
        #   * 默认**不写** —— 「默认日志不含原文」是对用户的承诺，用户才敢把日志发出去；
        #   * 要排翻译质量时临时开 `DMB_EVENT_LOG_VERBOSE=1`，它才作为 `log.verbose` 事件
        #     进同一条事件流（不再另起一个 jsonl 文件）。
        if eventlog.verbose_enabled():
            eventlog.append_event({
                "kind": "log.verbose", "level": "debug",
                "requestId": request_id,
                "where": {"repo": "server", "module": "app", "fn": "_handle_chat"},
                "what": {"stage": "translate.payload", "payload": payload},
            })
        # M1：服务端自己在统一事件流里留一条（与扩展侧那条可按 requestId 对齐）
        # M4：分阶段耗时并入这里（原 `.trace.jsonl` 已下线）。
        eventlog.append_event({
            "kind": "llm.call", "level": "info",
            "requestId": request_id,
            "where": {"repo": "server", "module": "app", "fn": "_handle_chat"},
            "what": {"model": target, "mode": result.mode, "regions": result.region_count,
                     "total_ms": ctx.elapsed_ms(), "unload_other_ms": ctx.unload_ms or 0,
                     "stages": ctx.trace_stages()},
        })
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
        if self.path.startswith("/support"):
            # M3 · 支持包（日志体系重构 §4.2）：扩展的弹窗调它拿 events+summary+server，
            # 再补上自己的 env/settings 拼成单文件 JSON。
            # 事件真正的家在服务端（扩展侧缓冲 500ms 就 flush 走了），所以由这里出。
            limit = support_mod.DEFAULT_EVENT_LIMIT
            tail = support_mod.DEFAULT_TAIL_LINES
            try:
                from urllib.parse import parse_qs, urlparse
                query = parse_qs(urlparse(self.path).query)
                if query.get("limit"):
                    limit = max(1, min(5000, int(query["limit"][0])))
                if query.get("tail"):
                    tail = max(0, min(500, int(query["tail"][0])))
            except Exception:
                # 参数坏不该让"导出"整体失败 —— 用默认值继续。
                limit = support_mod.DEFAULT_EVENT_LIMIT
                tail = support_mod.DEFAULT_TAIL_LINES
            self._send_json(200, support_mod.build_support_payload(
                health=self._health(), limit=limit, tail_lines=tail,
                exporter={"repo": "dmb-server", "commit": None}))
            return
        if self.path in ("/", "/index.html", "/panel"):
            self._send(200, SERVER_PANEL_HTML.encode("utf-8"), "text/html; charset=utf-8")
            return
        if self.path.startswith("/log/"):
            # 同 do_POST：`/log/` 是本服务的命名空间，不许 passthrough 出去变成 502。
            self._send_json(404, {
                "error": "未知的日志端点（M4 起只有 /log/events，且它是 POST）",
                "path": self.path,
            })
            return
        self._passthrough(None, "GET")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else b""

        if self.path.startswith("/ocr"):
            # ★ M1 贯穿 ID：请求头带了就沿用，没带就服务端生成；**两种情况都回显**。
            request_id = eventlog.resolve_request_id(self.headers)
            status, obj, timing = handle_ocr(body, request_id=request_id)
            self._send_json(status, obj, extra_headers=(
                {"X-DMB-Timing": json.dumps(timing, ensure_ascii=False),
                 eventlog.REQUEST_ID_HEADER: request_id} if timing
                else {eventlog.REQUEST_ID_HEADER: request_id}))
            return
        if self.path.startswith("/log/events"):
            # 统一事件流 —— **现在它是唯一的事件落点**（M4 起）。
            # 曾经的并存方 `/log/page`（整页日志独立系统）已下线：它的记录口径搬进了
            # `page.completed` / `failure` 事件（`stages` / `total_ms` / L1 的 `lines`）。
            try:
                payload = json.loads(body.decode("utf-8", "replace")) if body else {}
            except Exception as e:
                self._send_json(400, {"error": "JSON 解析失败: {}".format(e)})
                return
            request_id = eventlog.resolve_request_id(self.headers)
            self._request_id = request_id
            raw_events = payload.get("events") if isinstance(payload, dict) else payload
            if isinstance(raw_events, list):
                # 事件自带 requestId 优先（那是发起方生成的）；没带的用本次请求的 ID 兜底，
                # 免得这批事件在服务端日志里变成"无主"、对不上任何一次调用。
                for item in raw_events:
                    if isinstance(item, dict) and not item.get("requestId"):
                        item["requestId"] = request_id
            ok, detail, written = eventlog.append_events(payload)
            self._send_json(200 if ok else 500,
                            {"ok": ok, "detail": detail, "written": written,
                             "path": eventlog.event_log_path()})
            return
        if self.path.startswith("/log/"):
            # `/log/` 是本服务的命名空间，**不能落到 passthrough** ——
            # 那会把它转发给 Ollama，返回一个 502，看起来像"服务故障"，
            # 排查的人会先去查服务是不是挂了；而真相是这个端点已经不存在了。
            # M4 起只有 `/log/events`（整页日志的 `/log/page` 已下线）。
            self._send_json(404, {
                "error": "未知的日志端点（M4 起只有 /log/events）",
                "path": self.path,
            })
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
    # 是否用了自定义 system 提示词：直接比"生效值 vs 按模型版本自动选的值"。
    # 不再单独 os.path.exists 判一次 —— load_sakura_system 本来就在文件缺失/只有注释时回落默认，
    # 两个条件叠着写只会多一个会漂移的路径字面量。
    custom = load_sakura_system(SAKURA_MODEL).strip() != default_sakura_system(SAKURA_MODEL).strip()
    log("=" * 60)
    log("dmbTranslator v2 本地服务已启动: http://{}:{}".format(LISTEN_HOST, LISTEN_PORT))
    log("  翻译端点  Shinobu Base URL 填 http://127.0.0.1:{}/v1".format(LISTEN_PORT))
    log("  OCR 端点  http://127.0.0.1:{}/ocr  （manga-ocr，本地 GPU）".format(LISTEN_PORT))
    log("  转发上游  {}".format(UPSTREAM))
    log("  默认模型  {}   keep_alive={}".format(SAKURA_MODEL, keep_alive()))
    log("  Sakura提示  {}  （覆盖文件 {}）".format(
        "自定义正文" if custom else "按模型版本自动选择", SAKURA_PROMPT_FILE))
    log("  模型/ollama 控制  → 已拆到独立服务 http://{}:{}".format(
        LISTEN_HOST, DEFAULT_OLLAMA_SERVICE_PORT))
    log("  日志目录  {}  (按模型分子目录，每天一个文件)".format(
        os.path.dirname(daily_log_path(SAKURA_MODEL))))
    log("  当天日志  {}".format(daily_log_path(SAKURA_MODEL)))
    log("=" * 60)


def main():
    _ensure_glossary()
    banner()
    # 注意：本服务**不再**在启动时清显存 —— 那是 ollama 独立服务启动时的活。
    # （原先在这里卸模型，会让"启动 OCR/翻译服务"顺带动 ollama 的状态，正是要解开的耦合。）
    #
    # ★ 2026-10-05（用户拍板）：本服务拉起后**直接预载 manga-ocr**。
    #   原因：ocr.get_ocr() 原本是懒加载，首个 OCR 请求要现场 import torch + 读 400MB 权重，
    #   实测把客户端 await fetch 拖到 13 秒（14:43:58 fetchResolved=13121ms vs 服务端
    #   total_ms=743ms），而热态缺口只有 2~7ms。
    #   · 放**后台线程**：HTTP 先起来，/health 立刻可用，别让浏览器等模型加载才开服。
    #   · 只管 manga-ocr 自己，**不碰 vram.py**（那是 Ollama runner 的专属通道），
    #     也不动 LLM「同时只能跑一个 / 切模型要卸载」的规则 —— oilama 服务（11437）管的事。
    #   · preload_ocr() 幂等（_ocr_lock 保护），首请求若在预载完成前到达会复用同一次加载，
    #     不会加载两遍。
    try:
        threading.Thread(target=ocr_mod.preload_ocr, name="ocr-preload",
                         daemon=True).start()
    except Exception as e:  # 预载失败绝不能拖垮服务启动
        log("!! manga-ocr 预载线程启动失败（改为懒加载，首个请求现场加载）: {}".format(e))
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
