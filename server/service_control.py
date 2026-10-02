# -*- coding: utf-8 -*-
"""本机服务（dmb_server / Ollama）的启停控制 —— 供 native_host.py 调用。

设计约束（都是踩过的坑，改之前先想清楚）：
  · 浏览器扩展不能启动本机进程；启停只能由 Native Messaging 宿主代劳
    （宿主被浏览器按需拉起，处理一条消息就退出）。
  · 宿主的 stdout 是协议管道 —— 这里拉起的任何子进程都必须把 stdio 丢到 DEVNULL，
    否则会把二进制长度头写进管道、破坏与扩展的通信。
  · 被拉起的服务必须静默：ollama.exe 是 GUI 子系统，光 CREATE_NO_WINDOW 压不住它的窗口，
    必须再用 STARTUPINFO+SW_HIDE 强制隐藏；stdio 全部丢到 DEVNULL（见 launch_silent）。
    之前状态查询也走 NM，扩展一轮询就拉一次宿主 = 闪一次终端，现已改为纯 HTTP 探活。
  · 中文 Windows 上子进程输出是 936 编码，用 text=True 会让 stdout 变 None（踩过），
    所以按字节解、只取 ASCII。
  · Ollama 必须用 CLI 版 `ollama.exe serve`（托盘版 ollama app.exe 带界面且会开机自启），
    且必须注入 OLLAMA_MODELS（默认目录没模型，不注入则模型列表为空）。

对每个操作的返回值只包含调用方真正用到的东西：running / started|stopped / error。
状态查询不在这里 —— 扩展直接 HTTP 探活服务端口，不经过任何本机进程。
"""
import os
import shutil
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_APP = os.path.join(HERE, "app.py")

DEFAULT_SERVER_PORT = 11436
OLLAMA_PORT = 11434

# V1 的 serv_ollama.cmd 里写死的模型目录；沿用它，否则 Ollama 会去默认位置找模型
OLLAMA_MODELS_DIR = r"E:\AI\Ollama\OllamaModels"

_DEBUG = os.environ.get("DMB_SERVICE_DEBUG") == "1"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def log(msg):
    if _DEBUG:
        sys.stderr.write("[service] {}\n".format(msg))
        sys.stderr.flush()


# ── 基础设施 ────────────────────────────────────────────────

def port_open(port, timeout=0.5):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_port(port, want_open, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_open(port) == want_open:
            return True
        time.sleep(0.4)
    return False


def run_capture(cmd, timeout):
    """执行命令并返回 stdout 文本（按字节解 ASCII，见模块 docstring）。"""
    kwargs = {"capture_output": True, "timeout": timeout}
    if CREATE_NO_WINDOW:
        kwargs["creationflags"] = CREATE_NO_WINDOW
    try:
        res = subprocess.run(cmd, **kwargs)
    except Exception as e:
        log("{} 执行失败: {}".format(cmd[0], e))
        return ""
    return (res.stdout or b"").decode("ascii", "replace")


def listen_pid(port):
    """找监听该端口的 PID（供 taskkill 用）。找不到返回 None。

    不能只匹配 127.0.0.1：Ollama 监听 0.0.0.0/[::]、dmb_server 监听 127.0.0.1，
    所以按「本地地址以 :port 结尾」匹配。
    """
    out = run_capture(["netstat", "-ano", "-p", "TCP"], 10)
    suffix = ":{}".format(port)
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING" \
                and parts[1].endswith(suffix):
            try:
                return int(parts[4])
            except ValueError:
                return None
    return None


def launch_silent(args, cwd, env=None, *, give_hidden_console=False):
    """静默拉起一个独立进程：无窗口、脱离父进程、stdio 全部丢弃。

    两种模式（都是「静默」，区别在子进程要不要一个隐藏控制台）：
      · give_hidden_console=False（默认，给 dmb_server 这类不自拉可见子进程的服务）：
            DETACHED_PROCESS —— 子进程完全没有控制台，也不会被 Windows Terminal 接管。
      · give_hidden_console=True（给 ollama.exe serve 用）：
            ollama.exe serve 会再拉起 llama-server.exe。若父进程 DETACHED（无控制台），
            llama-server 就被分配「新控制台」，而 Win11 默认终端是 Windows Terminal，
            会把这个控制台接管成一个**可见窗口**（即用户看到的"闪窗"）。
            所以这里给 ollama 一个「隐藏的控制台」（不 DETACHED、不 CREATE_NO_WINDOW，只
            SW_HIDE），llama-server 继承这个隐藏控制台，WT 就不会再冒出来。
            CREATE_NEW_PROCESS_GROUP 让它脱离 NM 宿主独立存活（宿主回完消息就退出）。
    两者都带 STARTUPINFO.SW_HIDE，确保 GUI 子系统进程（ollama.exe）即便自己想建窗口也被压住。
    """
    kwargs = {
        "cwd": cwd,
        "close_fds": True,
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        from subprocess import STARTUPINFO, STARTF_USESHOWWINDOW, SW_HIDE
        si = STARTUPINFO()
        si.dwFlags = STARTF_USESHOWWINDOW
        si.wShowWindow = SW_HIDE
        kwargs["startupinfo"] = si
        if give_hidden_console:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["creationflags"] = (
                subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NEW_PROCESS_GROUP
            )
    return subprocess.Popen(args, **kwargs)


def python_launcher():
    """优先 pythonw.exe（无控制台窗口），找不到就用当前解释器。"""
    exe = sys.executable or ""
    if exe.lower().endswith("python.exe"):
        cand = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(cand):
            return cand
    return exe


# ── dmb_server ──────────────────────────────────────────────

def start_server(port=DEFAULT_SERVER_PORT):
    """幂等启动 dmb_server；端口就绪才算成功（实测冷启动可能超过 30s）。"""
    if port_open(port):
        return {"running": True, "started": False}
    args = [python_launcher(), SERVER_APP, str(port)]
    log("启动 dmb_server: {}".format(" ".join(args)))
    try:
        launch_silent(args, HERE)
    except Exception as e:
        return {"running": False, "started": False, "error": str(e)}
    if not wait_port(port, True, 60):
        return {"running": False, "started": False, "error": "启动超时（60s 内端口未就绪）"}
    return {"running": True, "started": True}


def stop_server(port=DEFAULT_SERVER_PORT):
    pid = listen_pid(port)
    if pid is None:
        # 找不到 PID 不等于没在跑（可能是 netstat 没解析出来），以端口探测为准
        return {"running": port_open(port), "stopped": False}
    run_capture(["taskkill", "/PID", str(pid), "/F", "/T"], 15)
    if not wait_port(port, False, 10):
        return {"running": True, "stopped": False, "error": "停止超时"}
    return {"running": False, "stopped": True}


# ── Ollama ──────────────────────────────────────────────────

def find_ollama_launcher():
    """返回 (启动命令, 工作目录)。只用 CLI 版 `ollama.exe serve` —— 托盘版带界面。"""
    dirs = []
    cli = shutil.which("ollama")
    if cli:
        dirs.append(os.path.dirname(cli))
    dirs += [
        r"E:\AI\Ollama\Ollama",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama"),
        r"C:\Program Files\Ollama",
    ]
    seen = set()
    for d in dirs:
        if not d or d in seen:
            continue
        seen.add(d)
        exe = os.path.join(d, "ollama.exe")
        if os.path.exists(exe):
            return [exe, "serve"], d
        app = os.path.join(d, "ollama app.exe")
        if os.path.exists(app):
            return [app], d
    return None, None


def start_ollama():
    """幂等、静默启动 Ollama 服务（无任何窗口）。"""
    if port_open(OLLAMA_PORT):
        return {"running": True, "started": False}
    args, cwd = find_ollama_launcher()
    if not args:
        return {"running": False, "started": False,
                "error": "找不到 Ollama（ollama.exe / ollama app.exe）"}
    env = os.environ.copy()
    if os.path.isdir(OLLAMA_MODELS_DIR):
        env["OLLAMA_MODELS"] = OLLAMA_MODELS_DIR
    log("启动 Ollama: {}".format(" ".join(args)))
    try:
        # give_hidden_console=True：给 ollama 一个隐藏控制台而非 DETACHED，
        # 这样它拉起的 llama-server.exe 继承隐藏控制台、不会被 Windows Terminal 接管成可见窗口
        launch_silent(args, cwd, env, give_hidden_console=True)
    except Exception as e:
        return {"running": False, "started": False, "error": str(e)}
    if not wait_port(OLLAMA_PORT, True, 40):
        return {"running": False, "started": False, "error": "启动超时（40s 内端口未就绪）"}
    return {"running": True, "started": True}


def stop_ollama():
    if not port_open(OLLAMA_PORT):
        return {"running": False, "stopped": False}
    # 托盘版会看护 ollama.exe，两个都要结束，只杀一个会被拉回来
    for name in ("ollama app.exe", "ollama.exe"):
        run_capture(["taskkill", "/IM", name, "/F", "/T"], 15)
    if not wait_port(OLLAMA_PORT, False, 10):
        return {"running": True, "stopped": False, "error": "停止超时"}
    return {"running": False, "stopped": True}
