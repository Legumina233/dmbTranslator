#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator 本机服务 —— 环境自检（doctor）

用法（在任意 Python 下都能跑，不需要 torch）：
    python scripts/doctor.py            # 基础检查
    python scripts/doctor.py --online   # 附加：联网检查 ollama / 服务端口

本脚本只用 <项目根> 下的相对位置，与仓库布局无关：
仓库根/scripts/doctor.py → 上溯一层即项目根，跟着检查该根下的
server/、manga-ocr/、models/、.venv/。

解释器解析顺序与 scripts\*.cmd / install_native_host.py 一致：
    DMB_PYTHON → 仓库根 .venv → server\.venv → 当前解释器
所以用 conda / 别处的 venv 时，只要设了 DMB_PYTHON 就能被正确识别并检查依赖，
不强制要求仓库里存在 .venv。

退出码：0 = 无阻塞项；1 = 有 FAIL。
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL = HERE.parent
VENV_PY = LOCAL / ".venv" / "Scripts" / "python.exe"
MODEL_DIR = LOCAL / "models" / "manga-ocr-base"

DMB_PORT = 11436
OLLAMA_PORT = 11434
OLLAMA_CTRL_PORT = 11437

PASS, WARN, FAIL, SKIP = "OK", "WARN", "FAIL", "--"
rows = []
def add(name, status, detail=""):
    rows.append((name, status, detail))


def http_json(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"__error__": str(e)}


def port_up(port):
    s = socket.socket()
    s.settimeout(0.6)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def which(name):
    """Windows 上脚本解释器可能是 py 启动器，shutil.which 对 .cmd 的处理要放宽。"""
    hit = shutil.which(name)
    if hit:
        return hit
    for ext in (".exe", ".cmd", ".bat"):
        hit = shutil.which(name + ext)
        if hit:
            return hit
    return None


# ── 解释器解析：与 scripts\*.cmd / install_native_host.py 同一套顺序 ──
def resolve_python():
    """DMB_PYTHON → 仓库根 .venv → server\\.venv → 当前解释器。

    外部环境（conda / 别处的 venv）只要设了 DMB_PYTHON 就会被认出来 ——
    不再强制要求仓库里必须有 .venv。
    """
    for cand in (
        os.environ.get("DMB_PYTHON"),
        str(VENV_PY),
        str(LOCAL / "server" / ".venv" / "Scripts" / "python.exe"),
    ):
        if cand and os.path.exists(cand):
            return cand
    return sys.executable


# ── 1. Python 与虚拟环境 ────────────────────────────────────
def check_python():
    v = sys.version_info
    ver = f"{v.major}.{v.minor}.{v.micro}"
    if (v.major, v.minor) == (3, 11):
        add("Python 版本", PASS, ver)
    elif (v.major, v.minor) in ((3, 10), (3, 12)):
        add("Python 版本", WARN, f"{ver}（推荐 3.11，未验证）")
    else:
        add("Python 版本", FAIL, f"{ver}（需要 3.11）")

    if VENV_PY.exists():
        r = subprocess.run([str(VENV_PY), "--version"], capture_output=True, text=True)
        add("虚拟环境 .venv/", PASS, (r.stdout or r.stderr).strip())
    elif os.environ.get("DMB_PYTHON"):
        add("Python 解释器", PASS, f"外部环境（DMB_PYTHON）= {resolve_python()}")
    elif (LOCAL / "server" / ".venv" / "Scripts" / "python.exe").exists():
        add("Python 解释器", PASS, "外部环境（server\\.venv）")
    else:
        add("虚拟环境 .venv/", FAIL,
            "不存在 —— 先跑 scripts\\setup.cmd，或用 DMB_PYTHON 指向已有环境")


# ── 2. OCR 依赖 ─────────────────────────────────────────────
def check_deps():
    target = resolve_python()
    if not os.path.exists(target):
        for pkg in ("torch", "transformers", "PIL", "jaconv", "loguru"):
            add(f"依赖 · {pkg}", SKIP, "找不到可用的解释器")
        add("torch 是否 CUDA 版", SKIP, "找不到可用的解释器")
        return

    code = (
        "import importlib,json\n"
        "out={}\n"
        "for m,name in [('torch','torch'),('transformers','transformers'),"
        "('PIL','Pillow'),('jaconv','jaconv'),('loguru','loguru')]:\n"
        "    try:\n"
        "        mod=importlib.import_module(m)\n"
        "        out[name]={'ok':True,'ver':getattr(mod,'__version__','?')}\n"
        "    except Exception as e:\n"
        "        out[name]={'ok':False,'err':type(e).__name__+': '+str(e)}\n"
        "try:\n"
        "    import torch\n"
        "    out['_cuda']={'avail':torch.cuda.is_available(),"
        "'name':(torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')}\n"
        "except Exception:\n"
        "    out['_cuda']={'avail':False,'name':''}\n"
        "print(json.dumps(out))\n"
    )
    r = subprocess.run([target, "-c", code], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    try:
        info = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        add("依赖检查", FAIL, (r.stderr or r.stdout or "")[:100])
        return

    for name in ("torch", "transformers", "Pillow", "jaconv", "loguru"):
        d = info.get(name, {})
        if d.get("ok"):
            add(f"依赖 · {name}", PASS, d.get("ver", ""))
        else:
            add(f"依赖 · {name}", FAIL, d.get("err", "未安装")[:80])

    cuda = info.get("_cuda", {})
    if cuda.get("avail"):
        add("torch 是否 CUDA 版", PASS, cuda.get("name", ""))
    else:
        add("torch 是否 CUDA 版", WARN,
            "CPU 版 —— 能用但 OCR 慢很多；有 N 卡就重跑 setup.cmd 选 CUDA")


# ── 3. OCR 权重 ─────────────────────────────────────────────
def check_model():
    if MODEL_DIR.is_dir() and (MODEL_DIR / "config.json").exists():
        size = sum(f.stat().st_size for f in MODEL_DIR.rglob("*") if f.is_file())
        add("manga-ocr 权重", PASS, f"{MODEL_DIR.name} · {size / 1048576:.0f} MB")
    elif MODEL_DIR.is_dir():
        add("manga-ocr 权重", FAIL, "目录存在但不完整（缺 config.json），删掉重跑 setup.cmd")
    else:
        add("manga-ocr 权重", WARN,
            "未预下载 —— 首次 OCR 会自动下载约 400 MB（HF）")


# ── 4. 服务端代码完整性 ─────────────────────────────────────
def check_server():
    need = ["app.py", "ocr.py", "translate.py", "backends.py", "config.py"]
    miss = [f for f in need if not (LOCAL / "server" / f).exists()]
    if miss:
        add("服务端代码 server/", FAIL, "缺: " + ", ".join(miss))
    else:
        add("服务端代码 server/", PASS, "核心文件齐")

    mo = LOCAL / "manga-ocr" / "manga_ocr" / "ocr.py"
    add("vendored manga-ocr", PASS if mo.exists() else FAIL,
        "已就位" if mo.exists() else "缺失 —— 仓库不完整")

    ex = LOCAL / "manga-ocr" / "manga_ocr" / "assets" / "example.jpg"
    add("manga-ocr 自检图", PASS if ex.exists() else FAIL,
        "已就位" if ex.exists() else "缺失 —— MangaOcr 启动会直接抛异常")


# ── 5. 端口与服务 ───────────────────────────────────────────
def check_runtime(online):
    if not online:
        for n, p in (("11436 dmb_server", DMB_PORT),
                     ("11437 ollama 控制", OLLAMA_CTRL_PORT),
                     ("11434 ollama 引擎", OLLAMA_PORT)):
            add(f"端口 {n}", SKIP, "加 --online 才检查")
        return

    if port_up(DMB_PORT):
        h = http_json(f"http://127.0.0.1:{DMB_PORT}/health")
        if "__error__" in h:
            add("dmb_server 11436", WARN, "端口在但 /health 无响应")
        else:
            loaded = h.get("ocr_loaded")
            err = h.get("ocr_error")
            if loaded:
                add("dmb_server 11436", PASS, "OCR 已就绪")
            elif err:
                add("dmb_server 11436", FAIL, f"OCR 加载失败: {str(err)[:70]}")
            else:
                add("dmb_server 11436", WARN, "在跑，OCR 尚未加载（首个请求会触发）")
    else:
        add("dmb_server 11436", WARN, "未在跑 —— scripts\\start_server.cmd 启动")

    if port_up(OLLAMA_PORT):
        info = http_json(f"http://127.0.0.1:{OLLAMA_PORT}/api/tags")
        names = sorted(m.get("name", "") for m in info.get("models", [])) if "__error__" not in info else []
        add("ollama 引擎 11434", PASS,
            f"{len(names)} 个模型" if names else "在跑，但没有任何模型")
        if names:
            has_sakura = any(n.startswith("sakura") for n in names)
            add("ollama 模型 sakura", PASS if has_sakura else WARN,
                "已就位" if has_sakura else f"没找到 sakura*，现有: {', '.join(names)[:60]}")
    else:
        add("ollama 引擎 11434", WARN,
            "未在跑 —— 仅「本地模型」路线需要，云端 API 路线不需要")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--online", action="store_true", help="检查端口与正在运行的服务")
    args = ap.parse_args()

    print("=" * 70)
    print(" dmbTranslator 本机服务 · 环境自检")
    print(f" 项目根: {LOCAL}")
    print(f" 解释器: {sys.executable}")
    print("=" * 70)

    check_python()
    check_deps()
    check_model()
    check_server()
    check_runtime(args.online)

    width = max(len(n) for n, _, _ in rows) + 2
    icon = {PASS: "[OK]  ", WARN: "[WARN]", FAIL: "[FAIL]", SKIP: "[ -- ]"}
    print()
    for n, s, d in rows:
        print(f"  {icon.get(s, '[?]')} {n.ljust(width)} {d}")

    n_fail = sum(1 for _, s, _ in rows if s == FAIL)
    n_warn = sum(1 for _, s, _ in rows if s == WARN)
    print()
    print(f"  小计: {len(rows)} 项 · FAIL={n_fail} · WARN={n_warn}")
    if n_fail:
        print("  => 有阻塞项，先解决 FAIL。相关步骤见 README「安装」。")
    elif n_warn:
        print("  => 无阻塞项。WARN 多为可选功能（如 GPU / 本地模型）。")
    else:
        print("  => 全部通过，可以启动服务了。")
    print("=" * 70)
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
