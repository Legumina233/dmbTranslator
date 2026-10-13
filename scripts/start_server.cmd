@echo off
chcp 65001 >nul
setlocal
set HERE=%~dp0
set PORT=%1
if "%PORT%"=="" set PORT=11436
set PY=
if defined DMB_PYTHON set PY=%DMB_PYTHON%
REM 优先�?setup.cmd 建的虚拟环境 —�?它在**仓库�?* .venv，不�?server\ 下�?
if not defined PY if exist "%HERE%..\.venv\Scripts\python.exe" set PY=%HERE%..\.venv\Scripts\python.exe
REM 兼容早期�?venv 建在 server\ 下的布局
if not defined PY if exist "%HERE%..\server\.venv\Scripts\python.exe" set PY=%HERE%..\server\.venv\Scripts\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [FAIL] 找不�?Python。先�?setup.cmd，或�?DMB_PYTHON 指向�?torch/PIL 的解释器�?
  exit /b 1
)
echo [dmbTranslator v2] 启动服务�? 端口=%PORT%
echo    解释�? %PY%
echo    （首�?OCR 会加�?manga-ocr，约 30s；之后常驻）
"%PY%" "%HERE%..\server\app.py" %PORT%
