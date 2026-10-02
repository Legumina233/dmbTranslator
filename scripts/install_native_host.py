# -*- coding: utf-8 -*-
"""注册 Native Messaging 宿主 —— 装一次，扩展就能"点按钮"起停本机服务。

    python install_native_host.py [扩展ID]
    python install_native_host.py --remove

做四件事：
  1. 用 PyInstaller 把 server/nm_launcher.py 编译成无窗口 exe（run/nm_host_launcher.exe）
  2. 写配置 run/nm_launcher.json（exe 用它找到 python 与 native_host.py）
  3. 生成宿主清单 run/native_host_manifest.json —— **path 指向 exe**
  4. 写注册表 HKCU\\...\\NativeMessagingHosts\\com.dmb.translator（用户级，无需管理员）

为什么 manifest 必须指向 exe 而不是 .cmd（Chromium 官方 issue 41116264）：
    指向 .exe → Chrome 直接启动（无 cmd.exe、无窗口）；
    指向 .cmd → 走旧兼容路径先拉 cmd.exe 且不加 CREATE_NO_WINDOW → 每次通信闪一个终端。

扩展 ID 在 chrome://extensions、或扩展报错栈的 chrome-extension://<ID>/ 里。
注意：扩展目录位置或 manifest key 变了 ID 会变，ID 变了要重跑本脚本。
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LAUNCHER_SRC = os.path.join(REPO, "server", "nm_launcher.py")
HOST_SCRIPT = os.path.join(REPO, "server", "native_host.py")

RUN_DIR = os.path.join(REPO, "run")
EXE_PATH = os.path.join(RUN_DIR, "nm_host_launcher.exe")
LAUNCHER_CFG = os.path.join(RUN_DIR, "nm_launcher.json")
MANIFEST = os.path.join(RUN_DIR, "native_host_manifest.json")

HOST_NAME = "com.dmb.translator"
REG_KEY = r"HKCU\Software\Google\Chrome\NativeMessagingHosts\{}".format(HOST_NAME)
DEFAULT_EXTENSION_ID = "igjdkokkjkhfgkfffhnicobcdjjghmpn"  # 从用户报错栈里取到的当前 ID

# 能用来跑 PyInstaller 的解释器，按顺序找（隔离环境优先，避免污染用户自己的环境）
PYINSTALLER_PYTHONS = [
    r"C:\Users\Asbean233\.workbuddy\binaries\python\envs\default\Scripts\python.exe",
]

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def log(msg):
    print(msg)
    sys.stdout.flush()


def run(cmd, cwd=None, timeout=600):
    kwargs = {"capture_output": True, "timeout": timeout, "cwd": cwd}
    if CREATE_NO_WINDOW:
        kwargs["creationflags"] = CREATE_NO_WINDOW
    res = subprocess.run(cmd, **kwargs)
    out = (res.stdout or b"").decode("utf-8", "replace").strip()
    err = (res.stderr or b"").decode("utf-8", "replace").strip()
    return res.returncode, out, err


def resolve_python():
    for cand in (
        os.environ.get("DMB_PYTHON"),
        os.path.join(REPO, "server", ".venv", "Scripts", "python.exe"),
        r"E:\AI\dmbTranslator\.conda\python.exe",
    ):
        if cand and os.path.exists(cand):
            return cand
    for name in ("py", "python"):
        code, out, _ = run(["where", name], timeout=20)
        if code == 0 and out:
            return out.splitlines()[0].strip()
    return None


def build_launcher():
    """把 nm_launcher.py 编译成无窗口 exe（GUI 子系统，自身不带控制台）。"""
    builder = None
    for cand in PYINSTALLER_PYTHONS + [resolve_python()]:
        if not cand or not os.path.exists(cand):
            continue
        code, _, _ = run([cand, "-m", "PyInstaller", "--version"], timeout=60)
        if code == 0:
            builder = cand
            break
    if not builder:
        log("  [FAIL] 找不到可用的 PyInstaller。请先: pip install pyinstaller")
        return False

    os.makedirs(RUN_DIR, exist_ok=True)
    cmd = [
        builder, "-m", "PyInstaller",
        "--onefile", "--noconsole", "--clean", "-y",
        "--distpath", RUN_DIR,
        "--workpath", os.path.join(RUN_DIR, "pyinstaller-build"),
        "--specpath", os.path.join(RUN_DIR, "pyinstaller-build"),
        "--name", "nm_host_launcher",
        LAUNCHER_SRC,
    ]
    log("  编译启动器（PyInstaller, {}）…".format(os.path.basename(builder)))
    code, out, err = run(cmd, timeout=600)
    if code != 0 or not os.path.exists(EXE_PATH):
        log("  [FAIL] 编译失败:\n{}\n{}".format(out[-800:], err[-800:]))
        return False
    log("  已生成 exe: {}".format(EXE_PATH))
    return True


def write_config(py):
    with open(LAUNCHER_CFG, "w", encoding="utf-8") as f:
        json.dump({"python": py, "script": HOST_SCRIPT}, f, ensure_ascii=False, indent=2)
    log("  已写配置: {}".format(LAUNCHER_CFG))


def write_manifest(extension_id):
    manifest = {
        "name": HOST_NAME,
        "description": "dmbTranslator local service controller",
        # 关键：指向 exe —— Chrome 对 exe 宿主走直接启动路径，不经 cmd.exe，不弹窗口
        "path": EXE_PATH,
        "type": "stdio",
        "allowed_origins": ["chrome-extension://{}/".format(extension_id)],
    }
    os.makedirs(RUN_DIR, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log("  已写宿主清单: {}".format(MANIFEST))
    log("  绑定扩展: chrome-extension://{}/".format(extension_id))


def register():
    try:
        import winreg
    except ImportError:
        code, out, err = run(["reg", "add", REG_KEY, "/ve", "/t", "REG_SZ", "/d", MANIFEST, "/f"], timeout=30)
        if code != 0:
            log("  [FAIL] 写注册表失败: {}\n{}".format(out, err))
            return False
        log("  已写注册表: {}".format(REG_KEY))
        return True

    key_path = REG_KEY.split("\\", 1)[1]
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, MANIFEST)
    except OSError as e:
        log("  [FAIL] 写注册表失败: {}".format(e))
        return False
    log("  已写注册表: {}".format(REG_KEY))
    return True


def unregister():
    try:
        import winreg
        key_path = REG_KEY.split("\\", 1)[1]
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
            log("  已删除注册表项")
        except FileNotFoundError:
            log("  本来就没有注册表项")
    except ImportError:
        run(["reg", "delete", REG_KEY, "/f"], timeout=30)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("extension_id", nargs="?", default=DEFAULT_EXTENSION_ID)
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()

    if args.remove:
        log("卸载 Native Messaging 宿主…")
        unregister()
        return 0

    extension_id = args.extension_id.strip()
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        log("[FAIL] 扩展 ID 格式不对（应为 32 个 a-p 的小写字母）: {!r}".format(extension_id))
        return 1

    log("安装 Native Messaging 宿主…")
    py = resolve_python()
    if not py:
        log("  [FAIL] 找不到 Python。请设 DMB_PYTHON。")
        return 1
    log("  宿主解释器: {}".format(py))

    if not build_launcher():
        return 1
    write_config(py)
    write_manifest(extension_id)
    if not register():
        return 1

    log("")
    log("完成。宿主已指向 exe（Chrome 直接启动，不经 cmd.exe，不弹终端窗口）。")
    log("若 Chrome 之前已加载扩展，无需重装；ID 没变就不用动扩展。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
