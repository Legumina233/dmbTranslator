@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion
set HERE=%~dp0
set LOCAL=%~dp0.
set VENV=%LOCAL%\.venv

REM ── 便携工具（Python / Node / wheel 缓存）统一放在**项目目录**里：<repo>\.tools ──
if defined DMB_TOOLS_DIR set "DMB_TOOLS=%DMB_TOOLS_DIR%"
REM ★ 自足的根路径推导（不依赖后面才定义的 LOCAL —— 之前的 bug 就是这里没定义就用了）
set "DMB_ROOT=%~dp0"
if "%DMB_ROOT:~-1%"=="\" set "DMB_ROOT=%DMB_ROOT:~0,-1%"
if defined DMB_TOOLS_DIR set "DMB_TOOLS=%DMB_TOOLS_DIR%"
if not defined DMB_TOOLS set "DMB_TOOLS=%DMB_ROOT%\.tools"
if not defined DMB_TOOLS ( echo [0/6] [FAIL] 内部错误：DMB_TOOLS 未定义 & exit /b 1 )
if not exist "%DMB_TOOLS%" mkdir "%DMB_TOOLS%" >nul 2>nul
REM ── 所有下载/临时/缓存也放进项目目录（不占 C 盘）：<repo>\.tools\cache ──
set "DMB_CACHE=%DMB_TOOLS%\cache"
if not exist "%DMB_CACHE%" mkdir "%DMB_CACHE%" >nul 2>nul
set "TEMP=%DMB_CACHE%\tmp"
set "DMB_PYUNZIP=%DMB_CACHE%\tmp\dmb-py311-x"
set "DMB_PYZIPCOPY=%DMB_CACHE%\tmp\dmb-python311.zip"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%" >nul 2>nul
REM 各类包管理器的缓存也一起搬进项目（子进程会继承这些变量）
set "npm_config_cache=%DMB_CACHE%\npm"
set "PIP_CACHE_DIR=%DMB_CACHE%\pip"
set "PYTHONPYCACHEPREFIX=%DMB_CACHE%\pycache"
set "XDG_CACHE_HOME=%DMB_CACHE%"
if not exist "%DMB_CACHE%\npm" mkdir "%DMB_CACHE%\npm" >nul 2>nul
if not exist "%DMB_CACHE%\pip" mkdir "%DMB_CACHE%\pip" >nul 2>nul

set PY=%VENV%\Scripts\python.exe

REM ══════════════════════════════════════════════════════════════════════
REM  dmbTranslator · 一键安装（本机服务为主，第 5 步可选装前端）
REM
REM  可用环境变量（无人值守 / 自定义）：
REM    DMB_PYTHON               指定用来建 venv 的 python.exe
REM    DMB_TORCH=cpu|cu124      跳过交互，直接指定 torch 版本
REM    DMB_SKIP_FRONTEND=1      跳过第 5 步（前端依赖）
REM    DMB_HF_MIRROR_ENDPOINT   权重下载镜像，默认 https://hf-mirror.com
REM    DMB_PIP_MIRROR            pip 镜像，默认清华；想走官方就设 https://pypi.org/simple
if not defined DMB_PIP_MIRROR set "DMB_PIP_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"
REM
REM  [编码] 本文件存为 GBK(cp936)，第 2 行的 chcp 也固定 936 —— 不要改成 UTF-8/65001：
REM    cmd.exe 解析批处理时按 OEM 代码页（中文 Windows = 936）读字节。文件编码与它不一致时，
REM    行偏移会错位、从行中间切入，首屏吐出一串假的「'xxx' 不是内部或外部命令」并伴中文乱码。
REM    实测（同内容、只换编码，控制台 CP=936）：UTF-8 版 9~10 条假报错 + 乱码；GBK 版 0 条 + 正常。
REM    改回去就会复发。
REM  虚拟环境建在**仓库根** .venv —— scripts\start_server.cmd 等脚本按同一位置查找，
REM  所以装完之后直接跑那些脚本即可，不要再另外手建 venv。
REM ══════════════════════════════════════════════════════════════════════

echo.
echo ============================================================
echo  dmbTranslator 一键安装
echo ============================================================
echo   独立 Python 环境：%VENV%
echo   不会污染你系统里的其他 Python 项目。
echo.
echo   [1/6] 建虚拟环境   [2/6] 装 torch   [3/6] 装其余依赖
echo   [4/6] 下模型权重   [5/6] 前端依赖（有源码才构建）
echo.

call :ensure_python || goto :fail
call :step_python   || goto :fail
call :step_torch    || goto :fail
call :step_deps     || goto :fail
call :step_weights
call :step_frontend || goto :fail
call :step_host     || goto :fail
call :step_ollama
call :cleanup
goto :summary

REM ── 1/5 建虚拟环境 ────────────────────────────────────────────────────
REM ── [0/6] 保证有一个"能用的" Python（没有就自动获取便携版） ──────────────
:torch_local
REM ★ 已经就绪就**什么都不做**：本地 wheel 离线重装虽然不用下载，但也要白等好几分钟。
REM   判定：DMB_TORCH=cpu 时只要能 import；否则要求 import 成功且 CUDA 可用（这样"CPU 版 → GPU 版"仍然会被纠正）。
if /I "%DMB_TORCH%"=="cpu" (
  "%PY%" -c "import torch" >nul 2>nul && ( echo         torch 已就绪，跳过。 & exit /b 0 )
) else (
  "%PY%" -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)" >nul 2>nul && ( echo         torch 已就绪（CUDA 可用），跳过。 & exit /b 0 )
)
REM 优先本地 wheel / 国内镜像安装 torch。官方 download.pytorch.org 在部分网络下会无声挂死
REM （真机卡过 33 分钟 / 16 分钟：CPU 0%、缓存零增长）。返回 0 = 已装好，调用方直接 goto :eof。
if /I "%DMB_TORCH%"=="cpu" exit /b 1
REM ★ 也可以显式指定 wheel：set DMB_TORCH_WHEEL=<完整路径>（最优先）
if defined DMB_TORCH_WHEEL if exist "%DMB_TORCH_WHEEL%" (
  echo         找到本地 wheel（DMB_TORCH_WHEEL）：%DMB_TORCH_WHEEL%
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%DMB_TORCH_WHEEL%" && exit /b 0
)
if not defined DMB_TOOLS set "DMB_TOOLS=%DMB_ROOT%\.tools"
for /f "delims=" %%W in ('dir /b /a-d "%DMB_TOOLS%\torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%DMB_TOOLS%\%%W" && exit /b 0
)
for /f "delims=" %%W in ('dir /b /a-d "%USERPROFILE%\Downloads\torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel（下载文件夹）：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%USERPROFILE%\Downloads\%%W" && exit /b 0
)
for /f "delims=" %%W in ('dir /b /a-d "%~dp0torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel（仓库根）：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%~dp0%%W" && exit /b 0
)
if 1==0 (
  echo         找到本地 wheel：%%W
)
for /f "delims=" %%W in ('dir /b /a-d "%USERPROFILE%\Downloads\torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%USERPROFILE%\Downloads\%%W" && exit /b 0
)
if 1==0 (
  if exist %%W (
    echo         找到本地 wheel：%%~nxW
    "%PY%" -m pip install --force-reinstall --no-deps --no-index "%%~fW" && exit /b 0
  )
)
REM ② 本地没有 → 用 curl 自己下载（带进度、可重试；比让 pip 静默下载可靠）
set "DMB_WHL=%DMB_TOOLS%\torch-2.6.0+cu124-cp311-cp311-win_amd64.whl"
if not exist "%DMB_WHL%" (
  echo         本地没有 wheel，用 curl 下载（约 2.4 GB，可见进度）...
  echo         来源：https://mirrors.aliyun.com/pytorch-wheels/cu124/
  curl.exe -L --fail --retry 3 --connect-timeout 20 -o "%DMB_WHL%.part" "https://mirrors.aliyun.com/pytorch-wheels/cu124/torch-2.6.0%%2Bcu124-cp311-cp311-win_amd64.whl"
  if exist "%DMB_WHL%.part" move /y "%DMB_WHL%.part" "%DMB_WHL%" >nul
)
if exist "%DMB_WHL%" (
  echo         装本地 wheel：%DMB_WHL%
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%DMB_WHL%" && exit /b 0
)
echo         本地没有 wheel，改试国内 pytorch 轮子镜像...
"%PY%" -m pip install torch --force-reinstall --no-deps --no-index -f https://mirrors.aliyun.com/pytorch-wheels/cu124/ --timeout 60 --retries 10 && exit /b 0
exit /b 1

REM ── 6/6 注册本机宿主（扩展弹窗里的起停按钮依赖它）──────────────────────
:step_host
echo [6/6] 注册本机宿主（浏览器里弹窗的「起停服务」按钮需要它）...
if not exist "%LOCAL%\run\nm_host_launcher.exe" (
  echo         没有现成的宿主 exe，先确保 PyInstaller 可用...
  "%PY%" -c "import PyInstaller" >nul 2>nul || "%PY%" -m pip install pyinstaller -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
)
"%PY%" "%LOCAL%\scripts\install_native_host.py"
if errorlevel 1 (
  echo [6/6] [FAIL] 宿主注册失败（原因见上面的输出）。
  echo        可修好后手动重跑：
  echo          "%PY%" "%LOCAL%\scripts\install_native_host.py"
  exit /b 1
)
echo [6/6] 宿主已注册，并通过自校验（exe 存在 / allowed_origins 非空 / 注册表指向本仓库）。
exit /b 0

REM ── 5/6 的前置：没有 Node 就自己装一份便携版（只本次运行加入 PATH，不动系统 PATH）──
:ensure_node
if defined DMB_SKIP_FRONTEND exit /b 0
if not defined DMB_NPM_REGISTRY set "DMB_NPM_REGISTRY=https://registry.npmmirror.com"
set "npm_config_registry=%DMB_NPM_REGISTRY%"
if exist "%DMB_TOOLS%\node24\node.exe" (
  set "PATH=%DMB_TOOLS%\node24;%PATH%"
  exit /b 0
)
if defined DMB_NODE if exist "%DMB_NODE%" (
  for %%D in ("%DMB_NODE%") do set "PATH=%%~dpD;%PATH%"
  exit /b 0
)
where node >nul 2>nul && exit /b 0
echo [5/6] 没有检测到 Node，自动下载便携版 Node 24（约 30 MB，解压到用户目录，不改系统 PATH）...
set "DMB_NODE_VER=v24.21.0"
set "DMB_NODE_ZIP=%TEMP%\node-%DMB_NODE_VER%-win-x64.zip"
set "DMB_NODE_DST=%DMB_TOOLS%\node24"
if not exist "%DMB_NODE_ZIP%" powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://npmmirror.com/mirrors/node/%DMB_NODE_VER%/node-%DMB_NODE_VER%-win-x64.zip' -OutFile '%DMB_NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if not exist "%DMB_NODE_ZIP%" powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://nodejs.org/dist/%DMB_NODE_VER%/node-%DMB_NODE_VER%-win-x64.zip' -OutFile '%DMB_NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if not exist "%DMB_NODE_ZIP%" (
  echo [5/6] [WARN] Node 下载失败。本机服务不受影响；扩展可改用 Release 包里的 zip。
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$tmp='%DMB_NODE_DST%_tmp'; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -Path '%DMB_NODE_ZIP%' -DestinationPath $tmp -Force; $inner=(Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName; if (Test-Path '%DMB_NODE_DST%') { Remove-Item '%DMB_NODE_DST%' -Recurse -Force }; Move-Item $inner '%DMB_NODE_DST%' -Force; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue"
if not exist "%DMB_NODE_DST%\node.exe" (
  echo [5/6] [WARN] Node 解压失败。扩展可改用 Release 包里的 zip。
  exit /b 1
)
set "PATH=%DMB_NODE_DST%;%PATH%"
echo [5/6] 便携 Node 就绪：%DMB_NODE_DST%
exit /b 0

REM ── 7/7 配置 Ollama（只探测 + 问一次 + 记住；不依赖用户预先设过任何变量）──
:step_ollama
echo [7/7] 配置 Ollama（本机路线需要；只用云端整图翻译可跳过）...
set "FOUND_EXE="
set "FOUND_MODELS="
for /f "tokens=1,* delims==" %%A in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%LOCAL%\scripts\find-ollama.ps1" 2^>nul') do (
  if /I "%%A"=="EXE" set "FOUND_EXE=%%B"
  if /I "%%A"=="MODELS" set "FOUND_MODELS=%%B"
)
if defined FOUND_EXE ( echo         自动探测到：%FOUND_EXE% ) else ( echo         没有自动探测到 Ollama（可稍后重跑本脚本）。 )
set "OLLAMA_INPUT="
if defined FOUND_EXE (
  set /p "OLLAMA_INPUT=        回车使用它，或输入新的 ollama.exe 完整路径: "
) else (
  set /p "OLLAMA_INPUT=        请输入 Ollama 安装目录（含 ollama.exe），或回车跳过: "
)
if not defined OLLAMA_INPUT set "OLLAMA_INPUT=%FOUND_EXE%"
if not defined OLLAMA_INPUT ( echo         已跳过 Ollama 配置。 & exit /b 0 )
if exist "%OLLAMA_INPUT%\ollama.exe" set "OLLAMA_INPUT=%OLLAMA_INPUT%\ollama.exe"
if not exist "%OLLAMA_INPUT%" ( echo         [WARN] 找不到 %OLLAMA_INPUT%（路径不对？），已跳过。 & exit /b 0 )
setx DMB_OLLAMA_EXE "%OLLAMA_INPUT%" >nul
set "DMB_OLLAMA_EXE=%OLLAMA_INPUT%"
echo         已记住 DMB_OLLAMA_EXE = %OLLAMA_INPUT%
if defined FOUND_MODELS (
  setx OLLAMA_MODELS "%FOUND_MODELS%" >nul
  set "OLLAMA_MODELS=%FOUND_MODELS%"
  echo         已记住 OLLAMA_MODELS = %FOUND_MODELS%
) else (
  echo         没探测到模型目录；若模型不在 %%USERPROFILE%%\.ollama\models，请自行设 OLLAMA_MODELS。
)
echo         提示：新开的终端 / 重启浏览器后生效；想立即生效请注销重登一次。
exit /b 0

:ensure_python
if defined BASE call :try_python "%BASE%" && goto :eof
set "DMB_TOOLS=%DMB_ROOT%\.tools"
if exist "%DMB_TOOLS%\python311\python.exe" call :try_python "%DMB_TOOLS%\python311\python.exe" && goto :eof
for /f "delims=" %%P in ('where python 2^>nul') do call :try_python "%%P" && goto :eof
py -3.11 -c "import sys, venv" >nul 2>nul && set "BASE=py" && goto :eof
echo.
echo [0/6] 本机没有可用的 Python，将下载免安装版 Python 3.11（失败才回落官方安装器）
echo        位置：%DMB_TOOLS%\python311   （仅当前用户，不改系统 PATH）
REM ── 优先用"免安装 zip 版"Python：官方 .exe 安装器在静默模式下会**假成功**（退 0 但不装任何文件）──
set "DMB_PYZIP=%TEMP%\dmb-python-3.11.9.nupkg"
set "DMB_PYDST=%DMB_TOOLS%\python311"
if not exist "%DMB_PYDST%\python.exe" (
  echo         下载免安装版 Python（nuget 官方包，约 25MB，无安装器、无需提权）...
  if not exist "%DMB_PYZIP%" powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://globalcdn.nuget.org/packages/python.3.11.9.nupkg' -OutFile '%DMB_PYZIP%' -UseBasicParsing } catch { exit 1 }"
  if exist "%DMB_PYZIP%" (
    for %%A in ("%DMB_PYZIP%") do set "DMB_PYSZ=%%~zA"
    if not defined DMB_PYSZ set "DMB_PYSZ=0"
    if 1==1 (
      copy /y "%DMB_PYZIP%" "%TEMP%\dmb-python311.zip" >nul
      powershell -NoProfile -ExecutionPolicy Bypass -Command "$t='%DMB_PYUNZIP%'; if (Test-Path $t) { Remove-Item $t -Recurse -Force }; Expand-Archive -Path (Join-Path $env:TEMP 'dmb-python311.zip') -DestinationPath $t -Force; $inner = Join-Path $t 'tools'; if (-not (Test-Path (Join-Path $inner 'python.exe'))) { $inner = $t }; if (Test-Path '%DMB_PYDST%') { Remove-Item '%DMB_PYDST%' -Recurse -Force }; Move-Item $inner '%DMB_PYDST%' -Force; Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue"
      if exist "%DMB_PYDST%\python.exe" (
        call :try_python "%DMB_PYDST%\python.exe"
        if not errorlevel 1 ( echo         免安装版 Python 已就绪：%BASE% & exit /b 0 )
      )
    )
  )
  echo         免安装版没成功，改走官方安装器兜底...
)
set "DMB_PYEXE=%TEMP%\dmb-python-3.11.9-amd64.exe"
if not exist "%DMB_PYEXE%" powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile '%DMB_PYEXE%' -UseBasicParsing } catch { exit 1 }"
for %%A in ("%DMB_PYEXE%") do set "DMB_PYSZ=%%~zA"
if not defined DMB_PYSZ set "DMB_PYSZ=0"
if %DMB_PYSZ% LSS 5000000 (
  echo         下载不完整（%DMB_PYSZ% 字节，正常约 25MB），改用国内镜像重试...
  del /f /q "%DMB_PYEXE%" >nul 2>nul
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://mirrors.huaweicloud.com/python/3.11.9/python-3.11.9-amd64.exe' -OutFile '%DMB_PYEXE%' -UseBasicParsing } catch { exit 1 }"
)
if not exist "%DMB_PYEXE%" (
  echo [FAIL] 自动下载失败。请手动安装 Python 3.11：https://www.python.org/downloads/
  echo        安装时选 "Install for me only"；或用 DMB_PYTHON 指向已有的 python.exe。
  exit /b 1
)
echo        正在静默安装（约 1 分钟）...
"%DMB_PYEXE%" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0 TargetDir="%DMB_TOOLS%\python311"
set "DMB_PYRC=%ERRORLEVEL%"
echo         安装器退出码 %DMB_PYRC%；等待落盘（最多 120 秒）...
set "DMB_PYWAIT=0"
:dmb_py_wait
if exist "%DMB_TOOLS%\python311\python.exe" goto :dmb_py_ready
timeout /t 5 /nobreak >nul 2>nul
set /a DMB_PYWAIT+=5
if %DMB_PYWAIT% LSS 120 goto :dmb_py_wait
:dmb_py_ready
if not exist "%DMB_TOOLS%\python311\python.exe" (
  echo [FAIL] 安装未完成：%DMB_TOOLS%\python311\python.exe 不存在（安装器退出码 %DMB_PYRC%，等待 %DMB_PYWAIT% 秒）
  exit /b 1
)
call :try_python "%DMB_TOOLS%\python311\python.exe" || exit /b 1
echo        已就绪：%BASE%
exit /b 0

:try_python
REM %1 = 候选（完整路径或命令名）。必须真能跑（import sys, venv）才采用；
REM      并排除 Windows 商店的占位 stub（...\WindowsApps\python.exe），它是假的。
set "DMB_CAND=%~1"
if "%DMB_CAND%"=="" exit /b 1
echo %DMB_CAND% | findstr /I "WindowsApps" >nul && exit /b 1
%DMB_CAND% -c "import sys, venv" >nul 2>nul || exit /b 1
set "BASE=%DMB_CAND%"
exit /b 0

:step_python
REM ★ 先验证已有的 .venv 是否**真的能用**：底座被删/换了别的解释器时，它会变成一个空壳
REM   （真机现象：pyvenv.cfg 指向已不存在的旧 conda，%PY% 跑起来只报 No Python at ...）
if exist "%VENV%\Scripts\python.exe" (
  "%VENV%\Scripts\python.exe" -c "import sys" >nul 2>nul
  if errorlevel 1 (
    echo         .venv 已损坏（底座不在了）-^> 删除后重建
    rmdir /s /q "%VENV%" 2>nul
  )
)
if not defined BASE set BASE=
if not defined BASE if defined DMB_PYTHON if exist "%DMB_PYTHON%" set BASE=%DMB_PYTHON%
if not defined BASE where py >nul 2>nul && set BASE=py
if not defined BASE where python >nul 2>nul && set BASE=python
if not defined BASE (
  echo [1/6] [FAIL] 找不到 Python。装一个 Python 3.11 并勾选 "Add to PATH"，然后重跑本脚本。
  echo             或先设 DMB_PYTHON 指向 python.exe。
  exit /b 1
)
if exist "%PY%" (
  echo [1/6] 虚拟环境已存在，跳过。
  exit /b 0
)
echo [1/6] 创建虚拟环境...
if "%BASE%"=="py" (
  REM 只用 :ensure_python 选定的解释器建 venv（不再优先 py，避免和它不一致）
) else (
  if exist "%VENV%\pyvenv.cfg" findstr /I /C:"%BASE%" "%VENV%\pyvenv.cfg" >nul || (
  echo         .venv 的底座不是当前解释器 -^> 删除后重建
  rmdir /s /q "%VENV%" 2>nul
)
"%BASE%" -m venv "%VENV%"
)
if not exist "%PY%" (
  echo [1/6] [FAIL] 虚拟环境创建失败。请确认 Python 3.11 可用：python --version
  exit /b 1
)
exit /b 0

REM ── 2/5 torch ────────────────────────────────────────────────────────
:step_torch
call :torch_local
if not errorlevel 1 goto :eof
set TORCH_KIND=
if defined DMB_TORCH set TORCH_KIND=%DMB_TORCH%
if not defined TORCH_KIND if exist "%VENV%\.gpu" (
  echo [2/6] 已标记为 GPU 版（%VENV%\.gpu），跳过 torch 安装。
  exit /b 0
)
if not defined TORCH_KIND (
  echo [2/6] torch 安装方式：
  echo         [1] CUDA 版（NVIDIA 显卡，推荐）  约 2.5 GB
  echo         [2] CPU 版（无独显 / 只想先跑通） 约 200 MB
  choice /c 12 /n /m "        请选择 [1/2]: "
  if errorlevel 2 (set TORCH_KIND=cpu) else (set TORCH_KIND=cu124)
)
if /i "%TORCH_KIND%"=="cpu" (
  echo         -^> 安装 CPU 版 torch
  "%PY%" -m pip install --upgrade pip -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
  "%PY%" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
) else (
  echo         -^> 安装 CUDA 版 torch（%TORCH_KIND%）
  "%PY%" -m pip install --upgrade pip -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
  "%PY%" -m pip install torch --index-url https://download.pytorch.org/whl/%TORCH_KIND%
  echo gpu> "%VENV%\.gpu"
)
if errorlevel 1 (
  echo [2/6] [FAIL] torch 安装失败，检查网络后重跑本脚本。
  exit /b 1
)
exit /b 0

REM ── 3/5 其余 OCR 依赖 ────────────────────────────────────────────────
:step_deps
echo [3/6] 安装其余依赖（transformers / Pillow / jaconv / loguru）...
"%PY%" -m pip install --upgrade pip -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
REM 不加 --no-deps：requirements 里的 torch>=2.0 已被第 2 步装好的版本满足（pip 不会降级成 CPU 版）；加了反而会漏掉 transformers 的 tokenizers / safetensors 等传递依赖。
"%PY%" -m pip install -r "%LOCAL%\requirements.txt" -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
if errorlevel 1 (
  echo [3/6] [FAIL] 依赖安装失败，检查网络后重跑本脚本。
  exit /b 1
)
exit /b 0

REM ── 4/5 预下载 manga-ocr 权重 ────────────────────────────────────────
:step_weights
echo [4/6] 预下载 manga-ocr 权重（约 400 MB，首次较慢）...
if exist "%LOCAL%\models\manga-ocr-base\config.json" (
  echo        已存在，跳过。
  exit /b 0
)
set HF_ENDPOINT=%DMB_HF_MIRROR_ENDPOINT%
if not defined HF_ENDPOINT set HF_ENDPOINT=https://hf-mirror.com
echo        镜像源：%HF_ENDPOINT%
"%PY%" -c "import os,sys; from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base', local_dir=os.path.join(r'%LOCAL%','models','manga-ocr-base')); print('ok')"
if errorlevel 1 (
  echo [4/6] [WARN] 权重预下载失败。不影响安装，首次 OCR 时会自动重试下载。
  echo        手动重试：
  echo          set HF_ENDPOINT=https://hf-mirror.com
  echo          "%PY%" -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base', local_dir=r'%LOCAL%\models\manga-ocr-base')"
)
exit /b 0

REM ── 5/6 前端依赖（有源码才构建）─────────────────────────────────────────────
:step_frontend
call :step_frontend_models || exit /b 1
REM ★ 完整包路线：已带预构建扩展（且有产物、但没带前端源码）→ 跳过 Node 与构建，只做产物/资源校验
if exist "%LOCAL%\frontend\apps\extension\dist-chromium\content.js" if not exist "%LOCAL%\frontend\package.json" (
  echo [5/6] 包里已带预构建扩展（无前端源码）—— 跳过 Node 与构建，仅校验产物。
  goto :step_frontend_assets
)
call :ensure_node
if defined DMB_SKIP_FRONTEND (
  echo [5/6] 已设 DMB_SKIP_FRONTEND，跳过前端依赖。
  exit /b 0
)
set NPM_FOUND=
where npm >nul 2>nul && set NPM_FOUND=1
if not defined NPM_FOUND echo        没有检测到 Node —— 已尝试自动准备便携 Node；若仍不可用，请改用 Release 包里的 zip（本机服务不受影响）。
set NODEVER=
for /f "delims=" %%v in ('node --version 2^>nul') do set NODEVER=%%v
if not defined NODEVER set NODEVER=?
echo [5/6] 检测到 Node %NODEVER%。上游 engines 要求 Node 24；Node 22 能装但会有 EBADENGINE 警告。
echo        -^> 安装前端依赖（首次约 3~8 分钟）...
pushd "%LOCAL%\frontend"
set "PYTHON=%DMB_TOOLS%\python311\python.exe"
call npm install --ignore-scripts
if errorlevel 1 (
  echo [5/6] [WARN] npm install 失败。不影响本机服务，可稍后手动重跑。
  echo        若报 EBUSY —— 那是受限沙箱下的已知问题，改用：npm install --ignore-scripts
) else (
  echo        -^> 前端依赖就绪。

    echo        -^> 构建扩展（chromium）...
    call npm run build:extension:chromium
    if errorlevel 1 (
      echo [5/6] [FAIL] 扩展未能构建 —— 没有扩展就无法使用（可用 Release 完整包里的预构建扩展，或修好后重跑）。手动重跑：
    exit /b 1
      echo          cd frontend ^&^& npm install ^&^& npm run build:extension:chromium
    ) else (
      echo        -^> 扩展已构建：frontend\apps\extension\dist-chromium
:step_frontend_assets
  if defined DMB_SKIP_MODELS (
    echo         已设 DMB_SKIP_MODELS，跳过模型资源校验。
    exit /b 0
  )
  REM 扩展运行还需要 public\models 下的大文件（detector.ort / PP-OCRv6 / aot_inpaint / bubble，约 200MB）——仓库里不带它们，需下载
  if not exist "%LOCAL%\frontend\public\models\detector.ort" (
    echo         下载扩展所需的模型资源（约 200MB，首次较慢）...
    pushd "%LOCAL%\frontend"
    call node scripts\download-models.mjs
    popd
  )
  if not exist "%LOCAL%\frontend\public\models\detector.ort" (
    echo [5/6] [FAIL] 模型资源缺失：frontend\public\models\detector.ort
    echo         请手动执行：cd frontend ^&^& node scripts\download-models.mjs
    exit /b 1
  )
      echo            到 chrome://extensions 打开"开发者模式"，用"加载已解压的扩展程序"选这个目录
    )
)
popd
exit /b 0

REM ── 收尾：清除下载/安装中断留下的残留（设 DMB_SKIP_CLEANUP=1 可跳过）──
:cleanup
if defined DMB_SKIP_CLEANUP ( echo [清理] 已设 DMB_SKIP_CLEANUP，跳过。 & exit /b 0 )
set "SP=%VENV%\Lib\site-packages"
if not defined DMB_TOOLS set "DMB_TOOLS=%DMB_ROOT%\.tools"
if not defined HF_HUB   set "HF_HUB=%USERPROFILE%\.cache\huggingface\hub"
echo [清理] 清除下载/安装中断残留（只删没走完的碎屑，不动正常缓存）...
REM ① pip 安装中断：site-packages 下 ~ 开头的目录/文件（pip 先解压到 ~<包名>，装成才改名）
if exist "%SP%" for /f "delims=" %%X in ('dir /b /a "%SP%\~*" 2^>nul') do (rmdir /s /q "%SP%\%%X" 2>nul || del /q /f "%SP%\%%X" 2>nul & echo        已清 %%X)
REM ② 权重下载中断：local_dir 与 HF 缓存的 .incomplete（分片）/ tmp_*（临时文件或目录）
for %%D in ("%LOCAL%\models\manga-ocr-base" "%HF_HUB%") do if exist "%%~D" for /f "delims=" %%X in ('dir /b /s /a "%%~D\*.incomplete" 2^>nul ^& dir /b /s /a "%%~D\tmp_*" 2^>nul') do (rmdir /s /q "%%~fX" 2>nul || del /q /f "%%~fX" 2>nul & echo        已清 %%~nxX)
REM ③ torch wheel 下载中断：DMB_TOOLS 下的 .part（curl 中断产物）
if exist "%DMB_TOOLS%" for /f "delims=" %%X in ('dir /b "%DMB_TOOLS%\*.part" 2^>nul') do (del /q /f "%DMB_TOOLS%\%%X" 2>nul & echo        已清 %%X)
exit /b 0

:summary
echo.
echo ============================================================
echo  安装完成。
echo.
echo  下一步（按需，都在仓库根目录下执行）：
echo    scripts\doctor.cmd --online    环境自检 + 查端口/在跑的服务
echo    scripts\start_server.cmd       启动本机服务 11436（OCR + 翻译）
echo    scripts\start_ollama.cmd       启动 Ollama 独立服务 11437（模型控制面板）
echo    scripts\test_ocr.cmd           冒烟测试（需服务端已启动）
echo.
echo  扩展构建（[5/6] 已自动完成）；完整包自带预构建产物。手动重跑：
echo    cd frontend
echo    npm run typecheck:extension
echo    npm run build:extension:chromium
echo.
echo  想用「本地模型」翻译路线，需要本地有 ollama 与模型：
echo    （用你已部署的模型即可，无需按名字拉取）
echo 
echo    （自定义 Modelfile 见 server\modelfiles\，详见 dev\docs\ARCHITECTURE.md）
echo.
echo  Native Messaging 宿主（[6/6] 已自动注册并自校验；手动重跑：
echo    python scripts\install_native_host.py
echo.
echo  更多说明见 README.md 与 docs\ 下的三份文档。
echo ============================================================
echo.
endlocal
if not defined DMB_NO_PAUSE ( echo. & echo 按任意键关闭窗口... & pause >nul )
exit /b 0

:fail
if not defined DMB_NO_PAUSE ( echo. & echo 按任意键关闭窗口... & pause >nul )
echo.
echo ============================================================
echo  安装中断。修掉上面的 [FAIL] 后重跑本脚本 ——
echo  已完成的步骤会自动跳过，不会重复下载。
echo ============================================================
echo.
endlocal
exit /b 1

:step_frontend_models
if defined DMB_SKIP_MODELS exit /b 0
if exist "%DMB_ROOT%\frontend\public\models\detector.ort" exit /b 0
if not exist "%DMB_ROOT%\frontend\public\models\models.json" exit /b 0
echo [5/6] 正在准备扩展运行所需的模型资源（约 200MB）...
pushd "%DMB_ROOT%\frontend"
call node scripts\download-models.mjs
popd
if exist "%DMB_ROOT%\frontend\public\models\detector.ort" exit /b 0
echo [5/6] [FAIL] 缺少扩展运行所需的模型资源（detector.ort 等，约 200MB）。
echo         请把 models.zip 解压到：%DMB_ROOT%\frontend\public\models\
echo         （完整包 dmbTranslator-*-win64.zip 已内置这些文件，可直接用它）
exit /b 1
