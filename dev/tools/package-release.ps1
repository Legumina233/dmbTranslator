# dmbTranslator 完整包（服务端 + 预构建扩展）打包脚本
# 用法： powershell -ExecutionPolicy Bypass -File dev\tools\package-release.ps1 [-IncludeModels] [-IncludeLauncher] [-SkipZip]
# 产出： artifacts\dmbTranslator-<ver>-win64.zip  +  artifacts\SHA256SUMS.txt
# 规则： 只带"用户需要 + setup.cmd 不能重建"的东西；排除一切可由 setup.cmd 重建或只对开发者有用的内容。
param(
  [switch]$IncludeModels,     # 把 models\（manga-ocr 权重，约 400MB）也打进包
  [switch]$IncludeLauncher,   # 把 run\nm_host_launcher.exe（预编译宿主，兜底用）也打进包
  [switch]$SkipZip            # 只做 staging 与清单，不压缩（快速核对用）
)
$ErrorActionPreference = 'Stop'
$REPO = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # dev\tools\ 上溯两级 = 仓库根
$ART  = Join-Path $REPO 'artifacts'
$ver  = (Get-Content (Join-Path $REPO 'frontend\apps\extension\package.json') -Raw | ConvertFrom-Json).version
$stage = Join-Path $ART ("stage-dmbTranslator-$ver-win64")

# ── 要带的东西（用户必需 / setup.cmd 无法重建） ─────────────────────────
$includeFiles = @(
  'setup.cmd', 'requirements.txt', 'README.md', 'LICENSE', 'NOTICE', '.upstream@a5af759',
  'frontend\LICENSE', 'frontend\NOTICE', 'frontend\THIRD_PARTY_NOTICES.md'
  'frontend\public\models\models.json'
)
$includeDirs = @(
  'server', 'manga-ocr', 'docs',
  'frontend\apps\extension\dist-chromium'
# 注：frontend\public\models 的模型资产按许可证不得随包分发，改由 setup.cmd 的 [5/6] 从官方 Release 自动下载并校验
)
# scripts\ 只带用户向脚本（白名单）：开发工具已移到 dev\tools\，不进发行包
$includeFiles += @(
  'scripts\doctor.cmd', 'scripts\doctor.py', 'scripts\find-ollama.ps1', 'scripts\install_native_host.py',
  'scripts\start_server.cmd', 'scripts\start_ollama.cmd', 'scripts\stop_server.cmd', 'scripts\stop_ollama.cmd',
  'scripts\test_ocr.cmd', 'scripts\test_ocr.py'
)
if ($IncludeModels)   { $includeDirs += 'models' }                                    # 可选：省用户 400MB 下载
if ($IncludeLauncher) { $includeFiles += 'run\nm_host_launcher.exe' }                 # 可选：[6/6] 编译失败时兜底

# ── 明确排除（即便在 include 目录里也剔掉） ─────────────────────────────
$excludePatterns = @(
  '\\node_modules\\', '\\\.venv\\', '\\logs\\', '\\.cache\\', '\\\.tools\\', '\\artifacts\\',
  '\\run\\.*\.json$', '\\run\\.*\.log$', '\\__pycache__\\', '\\\.pytest_cache\\',
  '\\frontend\\tests\\', '\\frontend\\benchmark\\', '\\\.git\\'
)

function Test-Excluded([string]$rel) {
  foreach ($p in $excludePatterns) { if ($rel -match $p) { return $true } }
  return $false
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path $ART  | Out-Null

$copied = 0; $bytes = 0
foreach ($f in $includeFiles) {
  $src = Join-Path $REPO $f
  if (-not (Test-Path $src)) { Write-Host ("  [skip] 缺: " + $f); continue }
  $dst = Join-Path $stage $f
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  Copy-Item $src $dst -Force; $copied++; $bytes += (Get-Item $src).Length
}
foreach ($d in $includeDirs) {
  $srcRoot = Join-Path $REPO $d
  if (-not (Test-Path $srcRoot)) { Write-Host ("  [skip] 缺: " + $d); continue }
  Get-ChildItem $srcRoot -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($REPO.Length).TrimStart('\')
    if (Test-Excluded $rel) { return }
    $dst = Join-Path $stage $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    Copy-Item $_.FullName $dst -Force; $copied++; $bytes += $_.Length
  }
}

Write-Host ("staging: " + $stage)
Write-Host ("文件数: " + $copied + "   合计: " + [math]::Round($bytes/1MB,1) + " MB")

if ($SkipZip) { Write-Host '（-SkipZip：未压缩）'; exit 0 }

$zip = Join-Path $ART ("dmbTranslator-" + $ver + "-win64.zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
# 关键：把 staging 的**内容**压到 zip 根部（setup.cmd 必须在 zip 根，不能多一层目录）
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"SHA256 ($([System.IO.Path]::GetFileName($zip))) = $hash" | Set-Content (Join-Path $ART 'SHA256SUMS.txt') -Encoding ASCII
Write-Host ("zip: " + $zip + "  " + [math]::Round((Get-Item $zip).Length/1MB,1) + " MB")
Write-Host ("SHA256SUMS.txt 已写: " + $hash)

# 说明：不再产出 models.zip —— 模型资产受许可证限制，不得随发行物分发。
