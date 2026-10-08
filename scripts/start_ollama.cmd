@echo off
setlocal
set HERE=%~dp0
set PORT=%1
if "%PORT%"=="" set PORT=11437
set PY=
if defined DMB_PYTHON set PY=%DMB_PYTHON%
if not defined PY if exist "%HERE%..\server\.venv\Scripts\python.exe" set PY=%HERE%..\server\.venv\Scripts\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [FAIL] 找不到 Python。请设 DMB_PYTHON 指向带 torch/PIL 的解释器。
  exit /b 1
)
echo [dmbTranslator v2] 启动 Ollama 独立服务  端口=%PORT%
echo    解释器: %PY%
echo    （它会确保 ollama 引擎在跑，并清掉上次残留的驻留模型）
"%PY%" "%HERE%..\server\ollama_server.py" %PORT%
