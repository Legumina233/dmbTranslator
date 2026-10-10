@echo off
chcp 65001 >nul
setlocal
set PORT=%1
if "%PORT%"=="" set PORT=11436
echo [dmbTranslator v2] 停止监听 %PORT% 的进程...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo   taskkill /PID %%p /F
  taskkill /PID %%p /F >nul 2>&1
)
echo 完成。
