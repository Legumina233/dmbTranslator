@echo off
chcp 65001 >nul
setlocal
set HERE=%~dp0
set PORT=%1
if "%PORT%"=="" set PORT=11437
set PY=
if defined DMB_PYTHON set PY=%DMB_PYTHON%
REM 优先�?setup.cmd 建的虚拟环境（在**仓库�?* .venv，不�?server\ 下）
if not defined PY if exist "%HERE%..\.venv\Scripts\python.exe" set PY=%HERE%..\.venv\Scripts\python.exe
REM 兼容早期�?venv 建在 server\ 下的布局
if not defined PY if exist "%HERE%..\server\.venv\Scripts\python.exe" set PY=%HERE%..\server\.venv\Scripts\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [FAIL] 找不�?Python。先�?setup.cmd，或�?DMB_PYTHON�?
  exit /b 1
)
echo [dmbTranslator v2] 关闭 Ollama 独立服务 %PORT%（先卸模�?-> 再停 ollama -> 收掉服务�?
"%PY%" -c "import sys; sys.path.insert(0, r'%HERE%..\server'); import service_control; r = service_control.stop_ollama_service(%PORT%); print(r); raise SystemExit(0 if not r.get('running') else 1)"
