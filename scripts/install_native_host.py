# -*- coding: utf-8 -*-
"""注册 Native Messaging 宿主 —— 装一次，扩展就能"点按钮"起停本机服务。

    python install_native_host.py                 # 自动从构建产物反推扩展 ID（推荐）
    python install_native_host.py <32位扩展ID>     # 手工指定
    python install_native_host.py --remove

做四件事：
  1. 用 PyInstaller 把 server/nm_launcher.py 编译成无窗口 exe（run/nm_host_launcher.exe）
  2. 写配置 run/nm_launcher.json（exe 用它找到 python 与 native_host.py）
  3. 生成宿主清单 run/native_host_manifest.json —— **path 指向 exe**
  4. 写注册表 HKCU\\...\\NativeMessagingHosts\\com.dmb.translator（用户级，无需管理员）

为什么 manifest 必须指向 exe 而不是 .cmd（Chromium 官方 issue 41116264）：
    指向 .exe → Chrome 直接启动（无 cmd.exe、无窗口）；
    指向 .cmd → 走旧兼容路径先拉 cmd.exe 且不加 CREATE_NO_WINDOW → 每次通信闪一个终端。

扩展 ID 从哪来：
    **默认自动反推** —— 读构建产物 frontend/apps/extension/dist-chromium/manifest.json 里的 `key`
    （base64 公钥），按 Chromium 算法算出 ID。因为 manifest.ts 里钉了固定 `key`，这个 ID
    与加载目录**无关**：谁 clone 到这个仓库、把扩展放在哪个盘哪个目录，ID 都一样。
    所以新克隆者只要 `npm run build:extension:chromium` 再跑本脚本，**不需要手工抄 ID**。
    想手工指定就传第一个位置参数；用了非默认构建目录就配 --dist。

    为什么以前要手工抄：manifest 没 `key` 时 Chrome 用**加载目录的绝对路径**做哈希，
    路径一变 ID 就变，宿主的 allowed_origins 立刻失效 —— 见 manifest.ts 顶部注释。
    （历史遗留：本文件曾硬编码某个人的本机 ID，那属个人机器痕迹，已移除。）
"""
import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time

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

# 构建产物：vite 把 manifest.ts 里 createExtensionManifest() 的结果原样写进去，
# 所以这里能读到为「固定扩展 ID」而钉的 `key`。默认按一下就能反推出 ID。
DEFAULT_BUILT_MANIFEST = os.path.join(
    REPO, "frontend", "apps", "extension", "dist-chromium", "manifest.json"
)

# 能用来跑 PyInstaller 的解释器候选（按顺序试，第一个装了 PyInstaller 的就用）。
# 用环境变量 DMB_PYINSTALLER_PYTHON 指定最稳；不设就退到当前解释器 / 系统 python。
# ⚠️ 这里不许写死任何人的本机路径 —— 本文件是随仓库公开的。
PYINSTALLER_PYTHONS = [
    os.environ.get("DMB_PYINSTALLER_PYTHON"),
    sys.executable,
]

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _safe_stdout():
    """中文 Windows 控制台是 GBK：emoji（如 ⚠️）会让 print 抛 UnicodeEncodeError 而**整个脚本崩掉**
    （真机踩过：注册其实已经写好了，却在最后一行提示上崩，exit=1，看起来像失败）。
    这里只把"当前编码编不出的字符"降级成 ?，**不改编码** —— 中文照常显示。"""
    try:
        sys.stdout.reconfigure(errors="replace")
        sys.stderr.reconfigure(errors="replace")
    except Exception:
        pass


_safe_stdout()


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
        os.path.join(REPO, ".venv", "Scripts", "python.exe"),  # 仓库自己的 .venv 优先（换盘/换目录/换机器都对；不再被外部环境变量带跑）
        # scripts/setup.cmd 建的虚拟环境在**仓库根** .venv（不在 server/ 下）
        os.path.join(REPO, ".venv", "Scripts", "python.exe"),
        # 兼容早期把 venv 建在 server/ 下的布局
        os.path.join(REPO, "server", ".venv", "Scripts", "python.exe"),
    ):
        if cand and os.path.exists(cand):
            return cand
    for name in ("py", "python"):
        code, out, _ = run(["where", name], timeout=20)
        if code == 0 and out:
            return out.splitlines()[0].strip()
    return None


def extension_id_from_key(key_b64):
    """按 Chromium 的算法从 `key`（base64 公钥）反推扩展 ID。

    ID = SHA-256(**公钥 DER**) 取前 16 字节，再把每个 hex 位 0-9a-f 映射成 a-p。
    参考 Chromium `components/crx_file/id_util.cc`：`kIdSize = 16`，
    `ConvertHexadecimalToIDAlphabet` 用 a-p 而非 0-f，是为了避免 ID 纯数字被当成 IP。
    """
    der = base64.b64decode(key_b64)
    digest = hashlib.sha256(der).digest()[:16]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest.hex())


def detect_extension_id(manifest_path=None):
    """从构建产物的 manifest.json 里读 `key` 反推扩展 ID。

    返回 (extension_id, 来源说明)；失败时返回 (None, 失败原因)。
    """
    path = manifest_path or DEFAULT_BUILT_MANIFEST
    if not os.path.exists(path):
        return None, "构建产物不存在：{}\n        先跑 npm run build:extension:chromium".format(path)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return None, "读不了 {}：{}".format(path, e)
    key = data.get("key")
    if not key:
        return None, (
            "{} 里没有 `key` 字段 —— 这种扩展的 ID 由**加载目录的绝对路径**决定，\n"
            "        换台机器/换个目录就会变。请先在 frontend/apps/extension/manifest.ts 的\n"
            "        chromium 分支里钉入固定 key，再跑 npm run build:extension:chromium。"
        ).format(path)
    try:
        return extension_id_from_key(key), "由 {} 的 key 反推".format(os.path.relpath(path, REPO))
    except (ValueError, TypeError) as e:
        return None, "{} 里的 key 不是合法 base64 公钥：{}".format(path, e)


def build_launcher(force=False):
    """把 nm_launcher.py 编译成无窗口 exe（GUI 子系统，自身不带控制台）。

    exe 已存在时**默认直接复用** —— 编译它需要 PyInstaller，而它只包了一个极薄的
    转发逻辑（读 run/nm_launcher.json 后拉起 native_host.py），跟源码几乎不耦合，
    为它专门装一个 PyInstaller 不划算。要重新编译加 --force-launcher。
    """
    if not force and os.path.exists(EXE_PATH):
        stat = os.stat(EXE_PATH)
        log("  复用已有 exe: {}".format(EXE_PATH))
        log("    （{}，{:.1f} MB；要强制重编加 --force-launcher）".format(
            time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
            stat.st_size / 1048576,
        ))
        return True

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
    parser = argparse.ArgumentParser(
        description="注册 Native Messaging 宿主（扩展 ID 默认从构建产物自动反推，无需手工抄）"
    )
    parser.add_argument(
        "extension_id",
        nargs="?",
        default=None,
        help="32 位扩展 ID（仅含 a-p）。不填则从构建产物 manifest.json 的 key 自动反推",
    )
    parser.add_argument(
        "--dist",
        default=None,
        help="构建产物的 manifest.json 路径（默认 {})".format(
            os.path.relpath(DEFAULT_BUILT_MANIFEST, REPO)
        ),
    )
    parser.add_argument("--remove", action="store_true")
    parser.add_argument(
        "--force-launcher",
        action="store_true",
        help="即使 run/nm_host_launcher.exe 已存在，也用 PyInstaller 重新编译",
    )
    args = parser.parse_args()

    if args.remove:
        log("卸载 Native Messaging 宿主…")
        unregister()
        return 0

    if args.extension_id:
        extension_id = args.extension_id.strip()
        source = "命令行指定"
    else:
        extension_id, source = detect_extension_id(args.dist)
        if not extension_id:
            log("[FAIL] 无法确定扩展 ID：")
            log("        {}".format(source))
            log("        也可以手工指定：python scripts/install_native_host.py <32位扩展ID>")
            return 1

    if not re.fullmatch(r"[a-p]{32}", extension_id):
        log("[FAIL] 扩展 ID 格式不对（应为 32 个 a-p 的小写字母）: {!r}".format(extension_id))
        return 1

    log("安装 Native Messaging 宿主…")
    log("  扩展 ID: {}（{}）".format(extension_id, source))
    py = resolve_python()
    if not py:
        log("  [FAIL] 找不到 Python。请设 DMB_PYTHON。")
        return 1
    log("  宿主解释器: {}".format(py))

    if not build_launcher(force=args.force_launcher):
        return 1
    write_config(py)
    write_manifest(extension_id)
    if not register():
        return 1

    log("")
    log("完成。宿主已指向 exe（Chrome 直接启动，不经 cmd.exe，不弹终端窗口）。")
    log("已绑定 ID: {}".format(extension_id))
    log("")
    log("⚠️ 若是**首次**给这个扩展钉上固定 key，扩展 ID 已经变了 —— 请在 chrome://extensions")
    log("   里把旧条目「移除」，再用「加载已解压的扩展程序」重新指向 dist-chromium；")
    log("   若直接点「重新加载」报 ID 变化而不给加载，就按上面先移除再加载。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
