# -*- coding: utf-8 -*-
"""Chrome Native Messaging 宿主 —— 扩展「点开关」时被浏览器按需拉起，代为启停本机服务。

协议（Chrome 规定 stdin/stdout 走「4 字节小端长度 + UTF-8 JSON」；
stdout 只能写协议内容，日志一律走 stderr）：

    请求: {"action": "setEnabled",
           "target": "server" | "ollama",
           "enabled": true | false,
           "port": 11436}          # 仅 target=server 需要；来自扩展当前配置的 Base URL
    回复: {"ok": true,
           "server":  {"running": bool},   # dmb_server（OCR + 翻译，11436）
           "ollama": {"running": bool}}    # Ollama 独立服务（11437）—— 引擎与模型控制都在里面
          # 失败: ok=false 且带 "error"（此时 server/ollama 仍为当前真实状态）

★ 2026-10-04（用户拍板）：target=ollama 现在启停的是**独立的 Ollama 服务进程**
  （`ollama_server.py`，11437），由它去管 ollama 引擎与模型；不再直接启停 ollama.exe。
  这样 ollama 的开关与 dmb_server 互不依赖，两边可各自开关、互不影响。
  关闭走的是服务自己的优雅通道（POST /shutdown）：**先卸模型 → 再停 ollama → 服务退出**，
  顺序反了会出现"开关回弹"（引擎关了但显存还占着、状态还是已加载）。

状态查询**不在这里**：扩展直接 HTTP 探活服务端口（不发消息、不拉进程、可高频轮询）。
宿主处理完一条消息即退出，无常驻进程。
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import service_control  # noqa: E402  同目录导入；启停逻辑全部在那里


def read_message():
    """读一条消息；stdin 关闭（Chrome 收完回复后）返回 None。"""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    if length <= 0 or length > 1024 * 1024:
        return None
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def write_message(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def current_state(server_port):
    """两个服务的真实运行状态（端口探活）。

    回复里带上它，UI 在收到启停结果时可即时更新圆点，不必等下一次 HTTP 轮询。
    这是客户端 setServiceEnabled 期望的契约：reply.server.running / reply.ollama.running。
    注意 ollama 这一项探的是**独立服务**（11437）——它就是 ollama 的开关本体。
    """
    return {
        "server": {"running": service_control.port_open(server_port)},
        "ollama": {"running": service_control.port_open(service_control.OLLAMA_SERVICE_PORT)},
    }


def handle(msg):
    if msg.get("action") != "setEnabled":
        return {"ok": False, "error": "未知操作: {!r}".format(msg.get("action")),
                **current_state(service_control.DEFAULT_SERVER_PORT)}

    target = msg.get("target")
    enabled = bool(msg.get("enabled"))
    port = int(msg.get("port") or service_control.DEFAULT_SERVER_PORT)

    if target == "server":
        result = (service_control.start_server(port) if enabled
                  else service_control.stop_server(port))
    elif target == "ollama":
        result = (service_control.start_ollama_service() if enabled
                  else service_control.stop_ollama_service())
    else:
        return {"ok": False, "error": "未知目标: {!r}".format(target), **current_state(port)}

    state = current_state(port)
    if "error" in result:
        return {"ok": False, "error": result["error"], **state}
    return {"ok": True, **state}


def main():
    while True:
        msg = read_message()
        if msg is None:
            break
        try:
            reply = handle(msg)
        except Exception as e:  # 必须回一条 JSON，否则扩展只会看到"宿主异常退出"
            reply = {"ok": False, "running": False,
                     "error": "{}: {}".format(type(e).__name__, e)}
        try:
            write_message(reply)
        except Exception:
            break


if __name__ == "__main__":
    main()
