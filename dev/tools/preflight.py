#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dmbTranslator v2 —— 环境预检 (preflight)

用法:
    python scripts/preflight.py            # 常规检查
    python scripts/preflight.py --deep     # 附加：4 个 ONNX 模型 sha256 校验(约 200MB 读取)

纯标准库，不依赖 torch / PIL，任何 Python >=3.8 均可运行。
退出码: 0 = 无 FAIL；1 = 存在 FAIL。
"""
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIN_FILE = ROOT / ".upstream@a5af759"
EXPECTED_COMMIT = "a5af759e3c1696045aeae1a7c43256d477182fd2"
OLLAMA = "http://127.0.0.1:11434"
DMB = "http://127.0.0.1:11436"
REQUIRED_MODELS = ["sakura-14b", "qwen3.5:4b"]

PASS, WARN, FAIL, SKIP = "PASS", "WARN", "FAIL", "--"
rows = []


def add(name, status, detail=""):
    rows.append((name, status, detail))


def run(cmd, cwd=None, timeout=30):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, shell=False,
                           encoding="utf-8", errors="replace")
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except Exception as e:
        return -1, "", str(e)


def http_json(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"__error__": str(e)}


def port_up(port):
    s = socket.socket()
    s.settimeout(1.0)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    except Exception:
        return False
    finally:
        s.close()


def major(ver):
    try:
        return int(ver.lstrip("v").split(".")[0])
    except Exception:
        return -1


def find_npm():
    """npm 可能是 npm / npm.cmd / npm.exe，且常与 node 同目录但不在 PATH。"""
    for name in ("npm", "npm.cmd", "npm.exe"):
        hit = shutil.which(name)
        if hit:
            return hit
    node = shutil.which("node")
    if node:
        base = Path(node).parent
        for name in ("npm.cmd", "npm.exe", "npm"):
            cand = base / name
            if cand.exists():
                return str(cand)
    return None


def check_tools():
    critical = {"git", "node", "python"}
    tools = [("git", ["git", "--version"]),
             ("node", ["node", "--version"]),
             ("python", [sys.executable, "--version"]),
             ("nvidia-smi", ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"])]
    for tool, cmd in tools:
        if not shutil.which(cmd[0]) and cmd[0] != sys.executable:
            add(f"工具 · {tool}", FAIL if tool in critical else WARN, "未找到可执行文件")
            continue
        rc, out, err = run(cmd)
        if rc != 0:
            add(f"工具 · {tool}", FAIL if tool in critical else WARN, (err or out)[:80])
        else:
            add(f"工具 · {tool}", PASS, out.splitlines()[0] if out else "")

    npm = find_npm()
    if npm:
        rc, out, err = run([npm, "--version"])
        add("工具 · npm", PASS if rc == 0 else WARN,
            out if rc == 0 else (err or out)[:80])
    else:
        add("工具 · npm", WARN,
            "未在 PATH / node 同目录找到 —— 若在你自己终端里 `npm -v` 正常则可忽略")


def check_node_engine():
    rc, out, _ = run(["node", "--version"])
    if rc != 0:
        add("Node 版本满足上游 ^24", FAIL, "node 不可用")
        return
    m = major(out)
    if m >= 24:
        add("Node 版本满足上游 ^24", PASS, out)
    else:
        add("Node 版本满足上游 ^24", WARN,
            f"{out} —— 上游 engines 要求 ^24，将出现 EBADENGINE 警告，建议装 Node 24")


def check_ollama():
    info = http_json(f"{OLLAMA}/api/tags")
    if "__error__" in info:
        add("Ollama 服务 11434", FAIL, info["__error__"][:80])
        add("Ollama 必需模型", SKIP, "服务不可达")
        return
    add("Ollama 服务 11434", PASS, "可达")
    have = {m.get("name", "") for m in info.get("models", [])}
    for need in REQUIRED_MODELS:
        hit = any(h == need or h.startswith(need + ":") for h in have)
        add(f"Ollama 模型 {need}", PASS if hit else FAIL,
            "已就位" if hit else "缺失，需 ollama pull")
    add("Ollama 模型总数", PASS, f"{len(have)} 个: {', '.join(sorted(have))[:120]}")


def check_ports():
    if port_up(11434):
        add("端口 11434 (Ollama)", PASS, "LISTENING")
    else:
        add("端口 11434 (Ollama)", FAIL, "未监听")
    if port_up(11436):
        add("端口 11436 (dmb_server)", WARN,
            "已被占用（可能是 v1 服务在跑）—— 启动 v2 前需先停掉")
    else:
        add("端口 11436 (dmb_server)", PASS, "空闲")


def check_gpu():
    rc, out, err = run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used",
                        "--format=csv,noheader,nounits"])
    if rc != 0:
        add("GPU", FAIL, (err or out)[:80])
        return
    line = out.splitlines()[0]
    parts = [p.strip() for p in line.split(",")]
    try:
        total, used = int(parts[1]), int(parts[2])
        free = total - used
        detail = f"{parts[0]} · 共 {total} MiB / 已用 {used} MiB / 空闲 {free} MiB"
        add("GPU", PASS, detail)
        if total < 16000:
            add("显存 ≥ 16GB", WARN, f"仅 {total} MiB —— 调度器并发必须=1（这是硬约束）")
        else:
            add("显存 ≥ 16GB", PASS, f"{total} MiB")
    except Exception:
        add("GPU", WARN, line)


def check_disk():
    try:
        u = shutil.disk_usage(str(ROOT))
        free_gb = u.free / (1024 ** 3)
        add("磁盘剩余 (项目所在盘)", PASS if free_gb > 20 else WARN,
            f"{free_gb:.0f} GB 可用")
    except Exception as e:
        add("磁盘剩余", WARN, str(e)[:60])


def check_repo():
    sh = ROOT / "frontend"
    if not (sh / "package.json").exists():
        add("上游 frontend/", FAIL, "未找到 —— 目录缺失")
    else:
        add("上游 frontend/", PASS, "存在")
        # frontend/ 去掉了内嵌 .git，基线由 pin 文件记录（不再问 git）
        if PIN_FILE.exists():
            lines = PIN_FILE.read_text(encoding="utf-8").splitlines()
            got = lines[1].strip() if len(lines) > 1 else ""
            ok = got == EXPECTED_COMMIT
            add("上游 pin == a5af759", PASS if ok else WARN,
                got[:12] + ("" if ok else f"（期望 {EXPECTED_COMMIT[:12]}）"))
        else:
            add("上游 pin == a5af759", WARN, "找不到 .upstream@a5af759")

    mo = ROOT / "manga-ocr" / "manga_ocr"
    add("vendor manga-ocr/", PASS if mo.exists() else FAIL,
        str(mo.relative_to(ROOT)) if mo.exists() else "缺失")

    mj = sh / "public" / "models" / "models.json"
    if not mj.exists():
        add("ONNX 模型资产", FAIL, "models.json 缺失")
        return
    spec = json.loads(mj.read_text(encoding="utf-8"))
    mdir = sh / "public" / "models"
    for key, meta in spec.get("models", {}).items():
        fn = meta.get("url", "").rsplit("/", 1)[-1]
        fp = mdir / fn
        if not fp.exists():
            add(f"模型 · {key}", FAIL, f"{fn} 缺失")
        elif fp.stat().st_size != meta.get("size"):
            add(f"模型 · {key}", FAIL,
                f"{fn} 大小 {fp.stat().st_size} != {meta.get('size')}")
        else:
            add(f"模型 · {key}", PASS, f"{fn} {fp.stat().st_size // 1048576} MB")


def deep_sha():
    mj = ROOT / "frontend" / "public" / "models" / "models.json"
    if not mj.exists():
        return
    spec = json.loads(mj.read_text(encoding="utf-8"))
    mdir = mj.parent
    for key, meta in spec.get("models", {}).items():
        fn = meta.get("url", "").rsplit("/", 1)[-1]
        fp = mdir / fn
        want = meta.get("sha256")
        if not (fp.exists() and want):
            continue
        h = hashlib.sha256()
        with open(fp, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        got = h.hexdigest()
        add(f"sha256 · {key}", PASS if got == want else FAIL,
            "一致" if got == want else f"{got[:12]}… != {want[:12]}…")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deep", action="store_true", help="校验模型 sha256")
    args = ap.parse_args()

    print("=" * 72)
    print(" dmbTranslator v2 环境预检")
    print(f" 项目根: {ROOT}")
    print("=" * 72)

    check_tools()
    check_node_engine()
    check_ollama()
    check_ports()
    check_gpu()
    check_disk()
    check_repo()
    if args.deep:
        print("  (--deep: 正在校验模型 sha256，约需十几秒…)")
        deep_sha()

    name_w = max(len(n) for n, _, _ in rows) + 2
    icon = {PASS: "[OK]  ", WARN: "[WARN]", FAIL: "[FAIL]", SKIP: "[ -- ]"}
    print()
    for n, s, d in rows:
        print(f"  {icon.get(s, '[?]')} {n.ljust(name_w)} {d}")
    n_fail = sum(1 for _, s, _ in rows if s == FAIL)
    n_warn = sum(1 for _, s, _ in rows if s == WARN)
    print()
    print(f"  小计: {len(rows)} 项 · FAIL={n_fail} · WARN={n_warn}")
    if n_fail:
        print("  => 存在阻塞项，请先解决 FAIL。")
    elif n_warn:
        print("  => 无阻塞项，但有 WARN，建议逐条确认。")
    else:
        print("  => 全部通过。")
    print("=" * 72)
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
