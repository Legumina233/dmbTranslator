@echo off
setlocal
set HERE=%~dp0
echo Running dmbTranslator v2 preflight...
echo.
where py >nul 2>nul && ( py "%HERE%preflight.py" %* & goto :done )
where python >nul 2>nul && ( python "%HERE%preflight.py" %* & goto :done )
echo [FAIL] 未找到 python / py，请先安装 Python 3.8+ 并加入 PATH。
exit /b 1
:done
echo.
pause
