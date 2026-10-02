@echo off
setlocal
set HERE=%~dp0
set PY=
if defined DMB_PYTHON set PY=%DMB_PYTHON%
if not defined PY if exist "%HERE%..\server\.venv\Scripts\python.exe" set PY=%HERE%..\server\.venv\Scripts\python.exe
if not defined PY if exist "E:\AI\dmbTranslator\.conda\python.exe" set PY=E:\AI\dmbTranslator\.conda\python.exe
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo [FAIL] 找不到 Python。请设置环境变量 DMB_PYTHON 指向带 torch/PIL 的解释器。
  exit /b 1
)
echo Using Python: %PY%
echo.
"%PY%" "%HERE%test_ocr.py" %*
echo.
pause
