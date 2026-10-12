@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion
set HERE=%~dp0
set LOCAL=%HERE%..
set VENV=%LOCAL%\.venv
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
echo   [1/5] 建虚拟环境   [2/5] 装 torch   [3/5] 装其余依赖
echo   [4/5] 下模型权重   [5/5] 前端依赖（可选）
echo.

call :ensure_python || goto :fail
call :step_python   || goto :fail
call :step_torch    || goto :fail
call :step_deps     || goto :fail
call :step_weights
call :step_frontend
goto :summary

REM ── 1/5 建虚拟环境 ────────────────────────────────────────────────────
REM ── [0/5] 保证有一个"能用的" Python（没有就自动获取便携版） ──────────────
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
if not defined DMB_TOOLS set "DMB_TOOLS=%LOCALAPPDATA%\dmbTranslator\tools"
for /f "delims=" %%W in ('dir /b /a-d "%DMB_TOOLS%\torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "%DMB_TOOLS%\%%W" && exit /b 0
)
for /f "delims=" %%W in ('dir /b /a-d "E:\AI\tools\torch-*.whl" 2^>nul') do (
  echo         找到本地 wheel：%%W
  "%PY%" -m pip install --force-reinstall --no-deps --no-index "E:\AI\tools\%%W" && exit /b 0
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

:ensure_python
if defined BASE call :try_python "%BASE%" && goto :eof
set "DMB_TOOLS=%LOCALAPPDATA%\dmbTranslator\tools"
if exist "%DMB_TOOLS%\python311\python.exe" call :try_python "%DMB_TOOLS%\python311\python.exe" && goto :eof
for /f "delims=" %%P in ('where python 2^>nul') do call :try_python "%%P" && goto :eof
py -3.11 -c "import sys, venv" >nul 2>nul && set "BASE=py" && goto :eof
echo.
echo [0/5] 本机没有可用的 Python，将自动下载官方 Python 3.11
echo        位置：%DMB_TOOLS%\python311   （仅当前用户，不改系统 PATH）
set "DMB_PYEXE=%TEMP%\dmb-python-3.11.9-amd64.exe"
if not exist "%DMB_PYEXE%" powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile '%DMB_PYEXE%' -UseBasicParsing } catch { exit 1 }"
if not exist "%DMB_PYEXE%" (
  echo [FAIL] 自动下载失败。请手动安装 Python 3.11：https://www.python.org/downloads/
  echo        安装时选 "Install for me only"；或用 DMB_PYTHON 指向已有的 python.exe。
  exit /b 1
)
echo        正在静默安装（约 1 分钟）...
"%DMB_PYEXE%" /quiet InstallAllUsers=0 PrependPath=0 Include_launcher=0 Include_test=0 TargetDir="%DMB_TOOLS%\python311"
if not exist "%DMB_TOOLS%\python311\python.exe" (
  echo [FAIL] 安装未完成：%DMB_TOOLS%\python311\python.exe 不存在
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
  echo [1/5] [FAIL] 找不到 Python。装一个 Python 3.11 并勾选 "Add to PATH"，然后重跑本脚本。
  echo             或先设 DMB_PYTHON 指向 python.exe。
  exit /b 1
)
if exist "%PY%" (
  echo [1/5] 虚拟环境已存在，跳过。
  exit /b 0
)
echo [1/5] 创建虚拟环境...
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
  echo [1/5] [FAIL] 虚拟环境创建失败。请确认 Python 3.11 可用：python --version
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
  echo [2/5] 已标记为 GPU 版（%VENV%\.gpu），跳过 torch 安装。
  exit /b 0
)
if not defined TORCH_KIND (
  echo [2/5] torch 安装方式：
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
  echo [2/5] [FAIL] torch 安装失败，检查网络后重跑本脚本。
  exit /b 1
)
exit /b 0

REM ── 3/5 其余 OCR 依赖 ────────────────────────────────────────────────
:step_deps
echo [3/5] 安装其余依赖（transformers / Pillow / jaconv / loguru）...
"%PY%" -m pip install --upgrade pip -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
REM 不加 --no-deps：requirements 里的 torch>=2.0 已被第 2 步装好的版本满足（pip 不会降级成 CPU 版）；加了反而会漏掉 transformers 的 tokenizers / safetensors 等传递依赖。
"%PY%" -m pip install -r "%LOCAL%\requirements.txt" -i "%DMB_PIP_MIRROR%" --timeout 60 --retries 10
if errorlevel 1 (
  echo [3/5] [FAIL] 依赖安装失败，检查网络后重跑本脚本。
  exit /b 1
)
exit /b 0

REM ── 4/5 预下载 manga-ocr 权重 ────────────────────────────────────────
:step_weights
echo [4/5] 预下载 manga-ocr 权重（约 400 MB，首次较慢）...
if exist "%LOCAL%\models\manga-ocr-base\config.json" (
  echo        已存在，跳过。
  exit /b 0
)
set HF_ENDPOINT=%DMB_HF_MIRROR_ENDPOINT%
if not defined HF_ENDPOINT set HF_ENDPOINT=https://hf-mirror.com
echo        镜像源：%HF_ENDPOINT%
"%PY%" -c "import os,sys; from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base', local_dir=os.path.join(r'%LOCAL%','models','manga-ocr-base')); print('ok')"
if errorlevel 1 (
  echo [4/5] [WARN] 权重预下载失败。不影响安装，首次 OCR 时会自动重试下载。
  echo        手动重试：
  echo          set HF_ENDPOINT=https://hf-mirror.com
  echo          "%PY%" -c "from huggingface_hub import snapshot_download; snapshot_download('kha-white/manga-ocr-base', local_dir=r'%LOCAL%\models\manga-ocr-base')"
)
exit /b 0

REM ── 5/5 前端依赖（可选）─────────────────────────────────────────────
:step_frontend
if defined DMB_SKIP_FRONTEND (
  echo [5/5] 已设 DMB_SKIP_FRONTEND，跳过前端依赖。
  exit /b 0
)
set NPM_FOUND=
where npm >nul 2>nul && set NPM_FOUND=1
if not defined NPM_FOUND (
    echo [5/5] 未检测到 npm，跳过前端依赖（注意：本机服务不需要 Node）。
    echo        只有"从源码自己构建扩展"才需要 Node 24；若你用已构建好的扩展包，
    echo        解压后在 chrome://extensions 加载即可，与本步骤无关。
    echo        想从源码构建时再执行：
    echo          cd frontend
    echo          npm install
    echo          npm run build:extension:chromium
)
set NODEVER=
for /f "delims=" %%v in ('node --version 2^>nul') do set NODEVER=%%v
if not defined NODEVER set NODEVER=?
echo [5/5] 检测到 Node %NODEVER%。上游 engines 要求 Node 24；Node 22 能装但会有 EBADENGINE 警告。
choice /c 12 /n /m "        是否现在安装前端依赖？[1=是 2=否]: "
if errorlevel 2 (
  echo        已跳过。之后手动执行下面两条即可：
  echo          cd frontend
  echo          npm install
  exit /b 0
)
echo        -^> 安装前端依赖（首次约 3~8 分钟）...
pushd "%LOCAL%\frontend"
call npm install
if errorlevel 1 (
  echo [5/5] [WARN] npm install 失败。不影响本机服务，可稍后手动重跑。
  echo        若报 EBUSY —— 那是受限沙箱下的已知问题，改用：npm install --ignore-scripts
) else (
  echo        -^> 前端依赖就绪。

    echo        -^> 构建扩展（chromium）...
    call npm run build:extension:chromium
    if errorlevel 1 (
      echo [5/5] [WARN] 扩展构建失败。不影响本机服务，可稍后手动重跑：
      echo          cd frontend ^&^& npm install ^&^& npm run build:extension:chromium
    ) else (
      echo        -^> 扩展已构建：frontend\apps\extension\dist-chromium
      echo            到 chrome://extensions 打开"开发者模式"，用"加载已解压的扩展程序"选这个目录
    )
)
popd
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
echo  构建扩展（需 Node 24）：
echo    cd frontend
echo    npm run typecheck:extension
echo    npm run build:extension:chromium
echo.
echo  想用「本地模型」翻译路线，需要本地有 ollama 与模型：
echo    ollama pull sakura-14b
echo    ollama pull qwen3.5:4b
echo    （自定义 Modelfile 见 server\modelfiles\，详见 docs\ARCHITECTURE.md）
echo.
echo  想让扩展能「点按钮」起停本机服务，再装一次 Native Messaging 宿主：
echo    python scripts\install_native_host.py
echo.
echo  更多说明见 README.md 与 docs\ 下的三份文档。
echo ============================================================
echo.
endlocal
exit /b 0

:fail
echo.
echo ============================================================
echo  安装中断。修掉上面的 [FAIL] 后重跑本脚本 ——
echo  已完成的步骤会自动跳过，不会重复下载。
echo ============================================================
echo.
endlocal
exit /b 1
