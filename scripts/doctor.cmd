@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
set HERE=%~dp0
set LOCAL=%HERE%..
set VENV=%LOCAL%\.venv

set PY=
REM 优先 DMB_PYTHON（显式指定），其次仓库根 .venv —�?�?start_server / start_ollama / test_ocr 保持一�?
if defined DMB_PYTHON if exist "%DMB_PYTHON%" set PY=%DMB_PYTHON%
if not defined PY if exist "%VENV%\Scripts\python.exe" set PY=%VENV%\Scripts\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [FAIL] 找不�?Python。先�?setup.cmd，或�?DMB_PYTHON�?
  exit /b 1
)

"%PY%" "%HERE%doctor.py" %*
exit /b %errorlevel%
