<#
imgpost（图邮）一键安装脚本 —— Windows / PowerShell

做四件事：
  1. 把插件放到 ~/.dsh/plugins/imgpost（已经是那里就跳过）
  2. 备份 profile 的 package.json，写入 link: 依赖
  3. 把 "imgpost" 加进该 profile 的 dsh.profile.bundles 名单
  4. 校验 JSON，失败自动回滚；然后尝试 pnpm install

安全：
  * 改文件前先备份（package.json.bak-<时间戳>）
  * 只增不删：已有的 dependencies / bundles 顺序原样保留
  * 写入后重新解析校验，失败立刻恢复备份

用法：
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -LegacyPatch   # 老版 DSH：改写 cordis.patch.yml
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Yes           # 不交互确认
#>
param(
  [string]$Profile = "",
  [string]$PluginDir = "",
  [switch]$FromNpm,
  [switch]$LegacyPatch,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$dshRoot = Join-Path $homeDir '.dsh'
$pluginName = 'imgpost'
$entryRel = 'src/host.js'
$pluginsRoot = Join-Path $dshRoot 'plugins'
$targetDir = Join-Path $pluginsRoot $pluginName

Write-Host "== imgpost (TuYou) installer ==" -ForegroundColor Cyan

# ── 1. 解析插件来源 ────────────────────────────────────────────────────────
$sourceDir = $null
if ($FromNpm) {
  $stage = Join-Path $env:TEMP ('imgpost-npm-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Write-Host "npm install imgpost -> $stage ..." -ForegroundColor Yellow
  try {
    Push-Location $stage
    npm install --no-save --silent imgpost 2>&1 | Out-Null
    Pop-Location
  } catch {
    Pop-Location
    Write-Host ("npm install failed: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
  }
  $sourceDir = Join-Path $stage 'node_modules\imgpost'
} elseif ($PluginDir -ne "") {
  $sourceDir = $PluginDir
} else {
  $sourceDir = Split-Path $PSScriptRoot -Parent
}

if (-not (Test-Path (Join-Path $sourceDir $entryRel))) {
  Write-Host ("Plugin entry not found: " + (Join-Path $sourceDir $entryRel)) -ForegroundColor Red
  Write-Host "Use -PluginDir to point at the imgpost source dir, or -FromNpm to install from npm."
  exit 1
}
Write-Host ("Plugin source: " + $sourceDir) -ForegroundColor Green

# ── 2. 落到 ~/.dsh/plugins/imgpost ─────────────────────────────────────────
$samePath = $false
try { $samePath = ((Resolve-Path $sourceDir).Path -eq (Resolve-Path (Split-Path $targetDir -Parent)).Path + '\' + $pluginName) } catch { $samePath = $false }
if (-not (Test-Path $targetDir)) {
  Write-Host "Copying plugin to $targetDir ..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $sourceDir '*') $targetDir
} elseif (-not $samePath) {
  Write-Host "Updating plugin files in $targetDir ..." -ForegroundColor Yellow
  Copy-Item -Recurse -Force (Join-Path $sourceDir 'src') $targetDir
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
    if (Test-Path (Join-Path $sourceDir $f)) { Copy-Item -Force (Join-Path $sourceDir $f) $targetDir }
  }
}
$entryFile = Join-Path $targetDir $entryRel
if (-not (Test-Path $entryFile)) {
  Write-Host ("Plugin entry missing after copy: " + $entryFile) -ForegroundColor Red
  exit 1
}
Write-Host ("Plugin entry: " + $entryFile) -ForegroundColor Green

# ── 3. 找 profile ──────────────────────────────────────────────────────────
$profilesDir = Join-Path $dshRoot 'profiles'
$candidates = @()
if ($Profile -ne "") {
  $p = Join-Path $profilesDir (Join-Path $Profile 'package.json')
  if (Test-Path $p) { $candidates += $p } else { Write-Host ("Profile not found: " + $p) -ForegroundColor Red; exit 1 }
} else {
  if (Test-Path $profilesDir) {
    $candidates += Get-ChildItem -Path $profilesDir -Filter 'package.json' -File -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.tmp-' } |
      ForEach-Object { $_.FullName }
  }
}
$candidates = @($candidates | Select-Object -Unique)
if ($candidates.Count -eq 0) {
  Write-Host "No DSH profile found under ~/.dsh/profiles/*/package.json. Use -Profile <name>." -ForegroundColor Red
  exit 1
}
if ($candidates.Count -gt 1) {
  Write-Host "Multiple profiles found, using the first:" -ForegroundColor Yellow
  $candidates | ForEach-Object { Write-Host ("  - " + $_) }
}
$profilePkg = $candidates[0]
$profileDir = Split-Path $profilePkg -Parent
Write-Host ("Profile: " + $profilePkg) -ForegroundColor Green

# ── 4. 老版 DSH：改写 cordis.patch.yml ─────────────────────────────────────
if ($LegacyPatch) {
  $patchFile = Join-Path $profileDir 'cordis.patch.yml'
  $content = if (Test-Path $patchFile) { Get-Content $patchFile -Raw -Encoding UTF8 } else { "" }
  if ($content -match '(?m)^\s*-\s*id:\s*imgpost\s*$') {
    Write-Host "imgpost is already configured in $patchFile. Nothing to do." -ForegroundColor Yellow
    exit 0
  }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = $patchFile + '.bak-' + $stamp
  if (Test-Path $patchFile) { Copy-Item -Force $patchFile $backup; Write-Host ("Backup: " + $backup) -ForegroundColor DarkGray }
  $block = @"

# -- imgpost (TuYou): send_image / generate_image / imgpost_read_image / imgpost_check_backend --
- insert:
    - id: imgpost
      name: '../../plugins/imgpost/src/host.js'
"@
  try {
    [System.IO.File]::WriteAllText($patchFile, $content.TrimEnd() + "`n" + $block + "`n", [System.Text.UTF8Encoding]::new($false))
  } catch {
    Write-Host ("Write failed: " + $_.Exception.Message) -ForegroundColor Red
    if (Test-Path $backup) { Copy-Item -Force $backup $patchFile; Write-Host "Rolled back." -ForegroundColor Yellow }
    exit 1
  }
  $verify = Get-Content $patchFile -Raw -Encoding UTF8
  if ($verify -match '(?m)^\s*-\s*id:\s*imgpost\s*$') {
    Write-Host "imgpost installed (legacy insert mode). Restart DSH." -ForegroundColor Green
    exit 0
  }
  Write-Host "Verification failed; rolling back..." -ForegroundColor Red
  if (Test-Path $backup) { Copy-Item -Force $backup $patchFile }
  exit 1
}

# ── 5. bundle 模式：改 profile 的 package.json ─────────────────────────────
$pkg = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $pkg.dsh) {
  Write-Host "This profile has no dsh.profile block; falling back to the legacy cordis.patch.yml method." -ForegroundColor Yellow
  & $PSCommandPath -Profile $Profile -PluginDir $PluginDir -LegacyPatch -Yes
  exit $LASTEXITCODE
}
if ($pkg.dsh.profile -and $pkg.dsh.profile.bundles -contains $pluginName) {
  Write-Host ("imgpost is already in dsh.profile.bundles of " + $profilePkg + ". Nothing to do.") -ForegroundColor Yellow
  exit 0
}

if (-not $Yes) {
  Write-Host ""
  Write-Host ("Will add imgpost to " + $profilePkg + " (backup first, rollback on failure). Continue? [Y/n] ") -NoNewline -ForegroundColor Yellow
  $ans = Read-Host
  if ($ans -notmatch '^[Yy]?$') { Write-Host "Cancelled."; exit 0 }
}

# link 依赖用正斜杠，避免 JSON / pnpm 里的反斜杠转义问题
$linkPath = ($targetDir -replace '\\', '/')
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$existingDep = $pkg.dependencies.$pluginName
if ($existingDep) {
  $pkg.dependencies.$pluginName = "link:$linkPath"
} else {
  $pkg.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue "link:$linkPath" -Force
}
if (-not $pkg.dsh.profile.bundles) {
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}
$pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $pluginName

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = $profilePkg + '.bak-' + $stamp
Copy-Item -Force $profilePkg $backup
Write-Host ("Backup: " + $backup) -ForegroundColor DarkGray

$json = $pkg | ConvertTo-Json -Depth 32
try {
  [System.IO.File]::WriteAllText($profilePkg, $json + "`n", [System.Text.UTF8Encoding]::new($false))
  $check = Get-Content $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
  $ok = ($check.dependencies.$pluginName -like 'link:*') -and ($check.dsh.profile.bundles -contains $pluginName)
} catch {
  $ok = $false
  Write-Host ("Write/verify failed: " + $_.Exception.Message) -ForegroundColor Red
}
if (-not $ok) {
  Copy-Item -Force $backup $profilePkg
  Write-Host "Verification failed; rolled back to the backup." -ForegroundColor Red
  exit 1
}
Write-Host "package.json updated:" -ForegroundColor Green
Write-Host ("  dependencies.${pluginName} = link:" + $linkPath)
Write-Host ("  dsh.profile.bundles += " + $pluginName)

# ── 6. 尽力跑一次 pnpm install ─────────────────────────────────────────────
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) {
  Write-Host "Running pnpm install in the profile ..." -ForegroundColor Yellow
  try {
    Push-Location $profileDir
    & $pnpm.Source install --ignore-scripts
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { Write-Host ("pnpm install exited with " + $code + " — run it yourself in " + $profileDir) -ForegroundColor Yellow }
  } catch {
    try { Pop-Location } catch {}
    Write-Host ("pnpm install failed: " + $_.Exception.Message) -ForegroundColor Yellow
  }
} else {
  Write-Host "pnpm not found on PATH — run 'pnpm install' in the profile dir yourself." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "imgpost installed. Restart DSH to load it." -ForegroundColor Cyan
Write-Host "The agent gets: send_image / generate_image / imgpost_read_image / imgpost_check_backend"
Write-Host ""
Write-Host "Config (optional):" -ForegroundColor DarkGray
Write-Host "  generation: ~/.dsh/image-sender.json  { apiKey, baseURL, model }  or DSH_IMAGE_API_*"
Write-Host "  vision:     ~/.dsh/vision-sender.json { primary, fallback }       or DSH_VISION_API_*"
