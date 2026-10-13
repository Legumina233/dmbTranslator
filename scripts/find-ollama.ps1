# 探测 Ollama：可执行文件与模型目录。找到就打印 EXE=/MODELS=，找不到什么都不打印。
# 顺序（不读 DMB_OLLAMA_EXE —— 那是安装脚本问过用户之后写下的结果，不是"用户会预先设好"的东西）：
#   1) 正在运行的 ollama 进程反查   2) PATH 上的 ollama   3-5) 官方默认安装位置
$exe = $null
try {
  $p = (Get-CimInstance Win32_Process -Filter "Name='ollama.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1).ExecutablePath
  if ($p -and (Test-Path $p)) { $exe = $p }
} catch { }
if (-not $exe) { try { $c = Get-Command ollama -ErrorAction SilentlyContinue; if ($c -and (Test-Path $c.Source)) { $exe = $c.Source } } catch { } }
if (-not $exe) {
  $dirs = @("$env:LOCALAPPDATA\Programs\Ollama", "$env:ProgramFiles\Ollama", "${env:ProgramFiles(x86)}\Ollama")
  foreach ($d in $dirs) { if ($d) { $c = Join-Path $d 'ollama.exe'; if (Test-Path $c) { $exe = $c; break } } }
}
$models = $env:OLLAMA_MODELS
if (-not $models) { $m = Join-Path $env:USERPROFILE '.ollama\models'; if (Test-Path $m) { $models = $m } }
if ($exe)    { Write-Output ("EXE=" + $exe) }
if ($models) { Write-Output ("MODELS=" + $models) }