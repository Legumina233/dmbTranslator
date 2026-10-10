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

call :step_python   || goto :fail
call :step_torch    || goto :fail
call :step_deps     || goto :fail
call :step_weights
call :step_frontend
goto :summary

REM ── 1/5 建虚拟环境 ────────────────────────────────────────────────────
:step_python
set BASE=
if defined DMB_PYTHON if exist "%DMB_PYTHON%" set BASE=%DMB_PYTHON%
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
  py -3.11 -m venv "%VENV%" 2>nul || py -m venv "%VENV%"
) else (
  "%BASE%" -m venv "%VENV%"
)
if not exist "%PY%" (
  echo [1/5] [FAIL] 虚拟环境创建失败。请确认 Python 3.11 可用：python --version
  exit /b 1
)
exit /b 0

REM ── 2/5 torch ────────────────────────────────────────────────────────
:step_torch
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
  "%PY%" -m pip install --upgrade pip
  "%PY%" -m pip install torch --index-url https://download.pytorch.org/whl/cpu
) else (
  echo         -^> 安装 CUDA 版 torch（%TORCH_KIND%）
  "%PY%" -m pip install --upgrade pip
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
"%PY%" -m pip install --upgrade pip
REM 不加 --no-deps：requirements 里的 torch>=2.0 已被第 2 步装好的版本满足（pip 不会降级成 CPU 版）；加了反而会漏掉 transformers 的 tokenizers / safetensors 等传递依赖。
"%PY%" -m pip install -r "%LOCAL%\requirements.txt"
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
  echo [5/5] 未检测到 npm，跳过前端依赖。
  echo        要用扩展本身，需先装 Node 24，再手动执行下面两条：
  echo          cd frontend
  echo          npm install
  exit /b 0
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
