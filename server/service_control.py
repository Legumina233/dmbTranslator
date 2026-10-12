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
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_APP = os.path.join(HERE, "app.py")
# ★ Ollama 与模型控制独立成服务（2026-10-04）：宿主启停的是**这个**服务，
#   再由它去启停 ollama 引擎 —— 于是 ollama 的开关不再依赖 dmb_server。
OLLAMA_SERVICE_APP = os.path.join(HERE, "ollama_server.py")

DEFAULT_SERVER_PORT = 11436
OLLAMA_PORT = 11434
OLLAMA_SERVICE_PORT = 11437

def _resolve_ollama_models_dir():
    """Ollama 模型目录 —— **不写死机器路径**。

    顺序：Ollama 自己的 `OLLAMA_MODELS` 环境变量 → 本仓库作者机器的历史位置
    （**仅在真实存在时**才用；换台机器不会命中，因此不影响别人）→ 默认位置
    `%USERPROFILE%\\.ollama\\models`。

    ★ 2026-10-12 修：原来直接写死 `E:\\AI\\Ollama\\OllamaModels` —— 别人克隆下来
      模型列表必然是空的（并且服务会去一个不存在的目录找模型）。
    """
    env = os.environ.get("OLLAMA_MODELS")
    if env:
        return env
    legacy = r"E:\AI\Ollama\OllamaModels"
    if os.path.isdir(legacy):
        return legacy
    home = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    return os.path.join(home, ".ollama", "models")


# 启动 ollama 引擎时注入给它的 `OLLAMA_MODELS`（见 start_ollama）。
OLLAMA_MODELS_DIR = _resolve_ollama_models_dir()

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
    """返回 (启动命令, 工作目录)。**只用 CLI 版 `ollama.exe serve`** —— 托盘版带界面且会开机自启。

    ★ 2026-10-12 两处真机修正：
      ① 删掉候选目录里写死的 `E:\\AI\\Ollama\\Ollama`（别人机器必然找不到）；
      ② **删掉"找不到 CLI 就退回 `ollama app.exe`"这条分支** —— 那正是"启动时弹 ollama 窗口"
         的来源，与本文档"必须静默、无窗口"的目标冲突。找不到 CLI 时宁可让上层**明确报错**
         （提示装 Ollama，或用 `DMB_OLLAMA_EXE` 指定）。
    """
    override = os.environ.get("DMB_OLLAMA_EXE")
    if override and os.path.exists(override):
        return [override, "serve"], os.path.dirname(override)
    dirs = []
    cli = shutil.which("ollama")
    if cli:
        dirs.append(os.path.dirname(cli))
    dirs += [
        # 作者机器的历史位置：**不存在时会被下面的 os.path.exists 直接跳过**，
        # 因此换台机器/换安装位置都不受影响。想彻底去掉，就把它删掉并用
        # 环境变量 DMB_OLLAMA_EXE 指定你自己的 ollama.exe。
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
    """关闭 Ollama 引擎：**先卸载全部驻留模型，再结束整棵进程树**。

    顺序不能反（2026-10-04 用户拍板）：`ollama.exe` 一死，卸载就再也发不出去，
    显存只能靠进程退出被动释放；而下一次启动时那些模型还"算已加载"，
    UI 上就会看到开关/加载状态回弹。所以先卸模型、再停服务。

    结束进程树要连 runner 一起（ollama_llama_server.exe / llama-server.exe）——
    只杀 ollama.exe 时 runner 可能还挂着显存，那也是"回弹"的一种。
    """
    if not port_open(OLLAMA_PORT):
        # 端口已关，但可能还有孤儿 runner 在占显存：一并收掉，保证干净
        try:
            import vram
            vram.kill_model_runners()
        except Exception as e:
            log("（清理孤儿 runner 时忽略: {}）".format(e))
        return {"running": False, "stopped": False}
    # ① 卸载全部驻留模型（强制路径：正在跑的推理也停）
    unload_detail = ""
    try:
        import vram
        ok, unload_detail, _unloaded = vram.unload_all_models_forced()
        if not ok:
            log("!! 关停前卸载模型未完全成功: {}".format(unload_detail))
    except Exception as e:
        unload_detail = "卸载步骤异常（忽略，继续关停）: {}".format(e)
        log("!! " + unload_detail)
    # ② 结束整棵进程树（托盘版会看护 ollama.exe，两个都要结束，只杀一个会被拉回来）
    for name in ("ollama app.exe", "ollama.exe"):
        run_capture(["taskkill", "/IM", name, "/F", "/T"], 15)
    try:
        import vram
        vram.kill_model_runners()
    except Exception:
        pass
    if not wait_port(OLLAMA_PORT, False, 10):
        return {"running": True, "stopped": False, "error": "停止超时"}
    return {"running": False, "stopped": True, "detail": unload_detail}


# ── ollama 独立服务（11437）─────────────────────────────────
#
# 为什么要有这一层：模型加载/卸载/状态原先由 dmb_server 提供，于是"管模型"这件事
# 被绑死在 OCR/翻译服务上 —— dmb_server 一关就管不了模型。现在这些能力归 ollama 服务，
# 与 dmb_server 互不依赖（2026-10-04 用户拍板）。

def _request(method, port, path, timeout, body=None):
    """向本机服务发一次 HTTP 请求，返回 (ok, 解析后的 JSON 或 None)。"""
    url = "http://127.0.0.1:{}{}".format(port, path)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
        try:
            return True, json.loads(raw)
        except Exception:
            return True, None
    except Exception as e:
        log("{} {} 失败: {}".format(method, url, e))
        return False, None


def start_ollama_service(port=OLLAMA_SERVICE_PORT):
    """幂等启动 ollama 独立服务（它自己会拉起 ollama 引擎并清显存）。"""
    if port_open(port):
        return {"running": True, "started": False}
    args = [python_launcher(), OLLAMA_SERVICE_APP, str(port)]
    log("启动 ollama 服务: {}".format(" ".join(args)))
    try:
        launch_silent(args, HERE)
    except Exception as e:
        return {"running": False, "started": False, "error": str(e)}
    if not wait_port(port, True, 60):
        return {"running": False, "started": False,
                "error": "ollama 服务启动超时（60s 内端口 {} 未就绪）".format(port)}
    return {"running": True, "started": True}


def stop_ollama_service(port=OLLAMA_SERVICE_PORT):
    """关闭 ollama 独立服务：**先请它自己优雅收尾**（卸模型 + 停 ollama），再收掉进程。

    不能直接 taskkill 服务进程 —— 那样就没机会先卸载模型，正是"回弹"的来源。
    优雅通道走不通（服务没响应）时才退化：直接停 ollama 引擎 + 杀服务进程。
    """
    if not port_open(port):
        # 服务没在跑：仍确保 ollama 引擎没被留下（口径：这个开关关了就全关）
        engine = stop_ollama() if port_open(OLLAMA_PORT) else {"running": False, "stopped": False}
        return {"running": False, "stopped": False, "engine": engine}
    ok, payload = _request("POST", port, "/shutdown", 180, {})
    graceful = bool(ok and (payload or {}).get("ok"))
    if not graceful:
        log("  优雅关停未确认，改走强制路径")
        if port_open(OLLAMA_PORT):
            stop_ollama()           # 兜底：卸模型 + 停引擎
    pid = listen_pid(port)
    if pid is not None:
        run_capture(["taskkill", "/PID", str(pid), "/F", "/T"], 15)
    if not wait_port(port, False, 15):
        return {"running": True, "stopped": False, "error": "ollama 服务停止超时"}
    return {"running": False, "stopped": True, "graceful": graceful}
