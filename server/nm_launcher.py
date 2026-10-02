# -*- coding: utf-8 -*-
"""无窗口 Native Messaging 启动器 —— 由 install_native_host.py 编译成 exe，宿主清单直接指向该 exe。

为什么需要它（根因，Chromium 官方 issue 41116264 / CL b65bc1b）：
    Windows 上 Chrome 启动 NM 宿主有两条路径——
      · manifest 的 path 指向 **.exe** → M113+ 直接启动，不经 cmd.exe，无窗口
      · path 指向 **.cmd/.bat** → 走旧兼容路径，先拉起 cmd.exe，且不给它加
        CREATE_NO_WINDOW —— 于是每次通信都会闪一个 cmd 控制台窗口
        （即用户报的"点一下开关闪一个终端"）
    所以宿主必须以 .exe 的形式注册；本启动器就是那个 .exe。

它自己只做一件事：以 CREATE_NO_WINDOW 拉起真正的 python 宿主（native_host.py），
并把 Chrome 交给自己的 stdio 句柄原样透传过去。
本 exe 用 PyInstaller --noconsole 构建（GUI 子系统，自身无控制台）；
GUI 子系统进程里 sys.stdin/stdout 是 None，因此要用 GetStdHandle 拿原始句柄。

配置：与本 exe 同目录的 nm_launcher.json —— {"python": "...", "script": "..."}
（由安装器生成，路径是机器相关的，不进版本库）
"""
import ctypes
import json
import msvcrt
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000
STD_INPUT_HANDLE = -10
STD_OUTPUT_HANDLE = -11


def main():
    base = os.path.dirname(os.path.abspath(sys.executable))
    with open(os.path.join(base, "nm_launcher.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)

    kernel32 = ctypes.windll.kernel32
    stdin_fd = msvcrt.open_osfhandle(kernel32.GetStdHandle(STD_INPUT_HANDLE), os.O_RDONLY)
    stdout_fd = msvcrt.open_osfhandle(kernel32.GetStdHandle(STD_OUTPUT_HANDLE), 0)

    # 宿主的 stderr 留到 exe 旁边的日志文件，出问题时有据可查（stdout 绝不能碰）
    stderr_log = open(os.path.join(base, "nm_host.stderr.log"), "ab")

    proc = subprocess.Popen(
        [cfg["python"], cfg["script"]],
        stdin=stdin_fd,
        stdout=stdout_fd,
        stderr=stderr_log,
        creationflags=CREATE_NO_WINDOW,
        close_fds=False,
    )
    sys.exit(proc.wait())


if __name__ == "__main__":
    main()
