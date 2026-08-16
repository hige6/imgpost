# imgpost (TuYou) - one-click install script for Windows / PowerShell
#
# Adds imgpost to your DSH configuration so the agent gets three tools:
#   send_image / generate_image / imgpost_read_image
#
# Safety:
#   * Backs up cordis.patch.yml before touching it (cordis.patch.yml.bak-<ts>)
#   * Appends a fresh "- insert:" block at the END of the file; never edits
#     your existing entries
#   * Verifies the write and rolls back to the backup on failure
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm
#
# Params:
#   -Profile    DSH profile name (default: auto-detect ~/.dsh/profiles/*/cordis.patch.yml)
#   -PluginDir  imgpost source dir (default: parent of this script)
#   -FromNpm    npm install imgpost into ~/.dsh/plugins (requires published package)
#   -Yes        skip the confirmation prompt
param(
  [string]$Profile = "",
  [string]$PluginDir = "",
  [switch]$FromNpm,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$homeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$dshRoot = Join-Path $homeDir '.dsh'
$pluginName = 'imgpost'
$entryRel = 'src/host.js'

Write-Host "== imgpost (TuYou) installer ==" -ForegroundColor Cyan

# -- 1. resolve plugin dir / entry file --------------------------------
if ($FromNpm) {
  $PluginDir = Join-Path $dshRoot (Join-Path 'plugins' $pluginName)
  $entryFile = Join-Path $PluginDir $entryRel
  if (-not (Test-Path $entryFile)) {
    Write-Host "Installing imgpost from npm into $PluginDir ..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
    try {
      Push-Location $dshRoot
      npm install --prefix $PluginDir imgpost 2>&1 | Out-Null
      $npmpkg = Join-Path $PluginDir 'node_modules\imgpost'
      if (Test-Path (Join-Path $npmpkg $entryRel)) {
        Copy-Item -Recurse -Force (Join-Path $npmpkg '*') $PluginDir
        Remove-Item -Recurse -Force (Join-Path $PluginDir 'node_modules')
      }
      Pop-Location
    } catch {
      Pop-Location
      Write-Host ("npm install failed: " + $_.Exception.Message) -ForegroundColor Red
      exit 1
    }
  }
} elseif ($PluginDir -eq "") {
  $PluginDir = Split-Path $PSScriptRoot -Parent
}
$entryFile = Join-Path $PluginDir $entryRel
if (-not (Test-Path $entryFile)) {
  Write-Host ("Plugin entry not found: " + $entryFile) -ForegroundColor Red
  Write-Host "Use -PluginDir to point at the imgpost source dir, or -FromNpm to install from npm."
  exit 1
}
Write-Host ("Plugin entry: " + $entryFile) -ForegroundColor Green

# -- 2. locate DSH profile config ---------------------------------------
$patchFiles = @()
if ($Profile -ne "") {
  $p = Join-Path $dshRoot (Join-Path ('profiles\' + $Profile) 'cordis.patch.yml')
  if (Test-Path $p) { $patchFiles += $p }
} else {
  $profilesDir = Join-Path $dshRoot 'profiles'
  if (Test-Path $profilesDir) {
    # Only consider REAL profile configs: skip node_modules / temp copies.
    $patchFiles += Get-ChildItem -Path $profilesDir -Recurse -Filter 'cordis.patch.yml' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\.tmp-' } |
      ForEach-Object { $_.FullName }
  }
  $topLevel = Join-Path $dshRoot 'cordis.patch.yml'
  if (Test-Path $topLevel) { $patchFiles += $topLevel }
}
$patchFiles = @($patchFiles | Select-Object -Unique)
if ($patchFiles.Count -eq 0) {
  Write-Host "No DSH config found (~/.dsh/**/cordis.patch.yml). Is DSH installed? Or use -Profile." -ForegroundColor Red
  exit 1
}
if ($patchFiles.Count -gt 1) {
  Write-Host ("Multiple configs found, using the first: " + $patchFiles[0]) -ForegroundColor Yellow
  $patchFiles | ForEach-Object { Write-Host ("  - " + $_) }
}
$patchFile = $patchFiles[0]
Write-Host ("DSH config: " + $patchFile) -ForegroundColor Green

# -- 3. already installed? ----------------------------------------------
$content = if (Test-Path $patchFile) { Get-Content $patchFile -Raw -Encoding UTF8 } else { "" }
$alreadyInstalled = $content -match '(?m)^\s*-\s*id:\s*imgpost\s*$'
if ($alreadyInstalled) {
  Write-Host "imgpost is already configured in $patchFile. Nothing to do." -ForegroundColor Yellow
  exit 0
}

# -- 4. confirmation -----------------------------------------------------
if (-not $Yes) {
  Write-Host ""
  Write-Host ("Will append imgpost config to " + $patchFile + " (backup first, rollback on failure). Continue? [Y/n] ") -NoNewline -ForegroundColor Yellow
  $ans = Read-Host
  if ($ans -notmatch '^[Yy]?$') { Write-Host "Cancelled."; exit 0 }
}

# -- 5. backup -----------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = $patchFile + '.bak-' + $stamp
if (Test-Path $patchFile) {
  Copy-Item -Force $patchFile $backup
  Write-Host ("Backup: " + $backup) -ForegroundColor DarkGray
}

# -- 6. compute name (relative path from patch file dir) ------------------
# ~/.dsh layout is fixed: profiles live under ~/.dsh/profiles/<p>/, plugins
# under ~/.dsh/plugins/<name>/. From a profile patch file, a plugin in
# ~/.dsh/plugins is exactly ../../plugins/<name>/src/host.js. Fall back to the
# absolute path (forward-slash) for any other location.
$pluginsRoot = Join-Path $dshRoot 'plugins'
$patchDir = Split-Path $patchFile -Parent
$relEntry = $null
if ($entryFile.StartsWith($pluginsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  $relEntry = '../../plugins/' + $pluginName + '/' + ($entryRel -replace '\\', '/')
} else {
  try {
    $patchDirUri = (New-Object System.Uri($patchDir + [IO.Path]::DirectorySeparatorChar)).AbsoluteUri
    $entryUri = (New-Object System.Uri($entryFile)).AbsoluteUri
    $relEntry = ($patchDirUri.MakeRelativeUri($entryUri).ToString()) -replace '/', '/'
  } catch {
    $relEntry = $null
  }
}
if (-not $relEntry) { $relEntry = $entryFile -replace '\\', '/' }

# -- 7. append a fresh insert block (never touches existing content) -------
$block = @"

# -- imgpost (TuYou): send_image / generate_image / imgpost_read_image --
- insert:
    - id: imgpost
      name: '$relEntry'
"@
$newContent = $content.TrimEnd() + "`n" + $block + "`n"
try {
  [System.IO.File]::WriteAllText($patchFile, $newContent, [System.Text.UTF8Encoding]::new($false))
} catch {
  Write-Host ("Write failed: " + $_.Exception.Message) -ForegroundColor Red
  if (Test-Path $backup) { Copy-Item -Force $backup $patchFile; Write-Host "Rolled back to backup." -ForegroundColor Yellow }
  exit 1
}

# -- 8. verify ------------------------------------------------------------
$verify = Get-Content $patchFile -Raw -Encoding UTF8
$ok = $verify -match '(?m)^\s*-\s*id:\s*imgpost\s*$' -and $verify -match [regex]::Escape("name: '$relEntry'")
if ($ok) {
  Write-Host ""
  Write-Host "imgpost installed successfully!" -ForegroundColor Green
  Write-Host ("  Config: " + $patchFile)
  Write-Host ("  Backup: " + $backup)
  Write-Host ""
  Write-Host "Next: restart DSH. The agent will get send_image / generate_image / imgpost_read_image." -ForegroundColor Cyan
} else {
  Write-Host "Verification failed; rolling back..." -ForegroundColor Red
  if (Test-Path $backup) { Copy-Item -Force $backup $patchFile; Write-Host "Rolled back to backup." -ForegroundColor Yellow }
  exit 1
}
