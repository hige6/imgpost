<#
imgpost（图邮）一键安装脚本 —— Windows / PowerShell

做四件事：
  1. 把插件放到 ~/.dsh/plugins/imgpost（内容已一致就跳过复制）
  2. 备份 profile 的 package.json 与（若需覆盖）现有插件目录
  3. 写入 link: 依赖，并把 "imgpost" 加进该 profile 的 dsh.profile.bundles 名单
  4. 校验 JSON，失败自动回滚；最后跑 pnpm install（检查退出码）

执行顺序（重要）：
  只读探测 → 只读解析 → 只读计划 → 交互确认 → 备份 → 写入 → 校验 → pnpm
  也就是说：在你说 Yes 之前，脚本不会改动插件目录、也不会改动任何配置文件。
  确认时选 No 时，插件目录与 profile 配置保持原样。

备份位置（就近存放，时间戳后缀）：
  <plugins>/imgpost.bak-<时间戳>/            覆盖前的插件目录（若本来就存在）
  <profile>/package.json.bak-<时间戳>       原始 profile package.json
  <profile>/cordis.patch.yml.bak-<时间戳>   legacy 模式下的原始 patch 文件

安全：
  * 只增不删：已有的 dependencies / bundles 顺序原样保留
  * 插件复制、JSON 写入任一步失败都会回滚（含把插件目录恢复到备份）
  * 写入后重新解析校验，校验不通过立刻回滚

用法：
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -FromNpm
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -LegacyPatch   # 老版 DSH：改写 cordis.patch.yml
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Yes           # 不交互确认

退出码：
  0 = 全部成功（或本来就已安装完整）
  1 = 失败（已回滚到改动前的状态）
  2 = 配置已写入，但 pnpm install 未完成（按提示再跑一次即可）
  3 = 你在确认时选了 No，未做任何改动
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
$targetDir = [System.IO.Path]::GetFullPath((Join-Path $pluginsRoot $pluginName))
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Say-Step([string]$m) { Write-Host $m -ForegroundColor Cyan }
function Say-Ok([string]$m) { Write-Host $m -ForegroundColor Green }
function Say-Warn([string]$m) { Write-Host $m -ForegroundColor Yellow }
function Say-Err([string]$m) { Write-Host $m -ForegroundColor Red }
function Say-Dim([string]$m) { Write-Host $m -ForegroundColor DarkGray }
function Fail([string]$message, [int]$code) {
  Say-Err ("错误：" + $message)
  exit $code
}
# 本次实际生成的备份列表（用于结尾提示）
$script:BackupsMade = New-Object System.Collections.ArrayList
function Say-BackupNote {
  if ($script:BackupsMade.Count -gt 0) { Say-Dim ("备份： " + ($script:BackupsMade -join '   ')) }
}

# ── 通用小工具 ────────────────────────────────────────────────────────────
function Resolve-Full([string]$p) {
  if (-not $p) { return $null }
  try { return [System.IO.Path]::GetFullPath($p) } catch { return $null }
}
function Test-SamePath([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  return [string]::Equals((Resolve-Full $a), (Resolve-Full $b), [System.StringComparison]::OrdinalIgnoreCase)
}
# 把 "link:<path>" 解析成绝对路径（相对路径按 profile 目录展开）
function Get-LinkTarget([string]$value, [string]$relativeTo) {
  if (-not $value) { return $null }
  $v = [string]$value
  if (-not $v.Trim().StartsWith('link:', [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
  $p = $v.Trim().Substring(5)
  if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $relativeTo $p }
  return (Resolve-Full $p)
}
# 目录内全部文件的相对路径 -> SHA256（跳过 .git / node_modules / *.bak*）
function Get-FileMap([string]$root) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $root)) { return $map }
  $base = (Resolve-Full $root).TrimEnd('\', '/')
  Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.Name -notmatch '\.bak' } |
    ForEach-Object {
      $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
      $map[$rel] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  return $map
}
# 返回源目录相对目标目录的差异清单（空 = 内容一致，不需要复制）
function Get-CopyDiff([string]$source, [string]$target) {
  $diff = New-Object System.Collections.ArrayList
  $src = Get-FileMap $source
  $tgt = Get-FileMap $target
  foreach ($rel in ($src.Keys | Sort-Object)) {
    if (-not $tgt.ContainsKey($rel)) { [void]$diff.Add($rel + ' 缺失') ; continue }
    if ($tgt[$rel] -ne $src[$rel]) { [void]$diff.Add($rel + ' 不一致') }
  }
  return $diff
}

# ── 回滚机制：任何写入前先登记，失败时按相反顺序还原 ────────────────────────
$script:RollbackActions = @()
function Add-Rollback([string]$kind, [string]$target, [string]$backup) {
  $script:RollbackActions += [pscustomobject]@{ Kind = $kind; Target = $target; Backup = $backup }
}
function Invoke-Rollback {
  if ($script:RollbackActions.Count -eq 0) { return }
  Say-Warn "正在回滚到改动前的状态 ..."
  for ($i = $script:RollbackActions.Count - 1; $i -ge 0; $i--) {
    $a = $script:RollbackActions[$i]
    try {
      if ($a.Kind -eq 'file') {
        if ($a.Backup -and (Test-Path -LiteralPath $a.Backup)) {
          Copy-Item -LiteralPath $a.Backup -Destination $a.Target -Force
          Say-Dim ("  已恢复 " + $a.Target)
        }
      } elseif ($a.Kind -eq 'dir') {
        if (Test-Path -LiteralPath $a.Target) { Remove-Item -LiteralPath $a.Target -Recurse -Force }
        if ($a.Backup -and (Test-Path -LiteralPath $a.Backup)) {
          Move-Item -LiteralPath $a.Backup -Destination $a.Target -Force
          Say-Dim ("  已恢复 " + $a.Target)
        } else {
          Say-Dim ("  已移除新建的 " + $a.Target)
        }
      }
    } catch {
      Say-Warn ("  回滚 " + $a.Target + " 失败：" + $_.Exception.Message)
    }
  }
}

Say-Step "== imgpost (TuYou) installer =="

# ══ 阶段 0：只读探测插件来源 ═══════════════════════════════════════════════
$sourceDir = $null
$stageDir = $null
if ($FromNpm) {
  # 真正的下载放到确认之后（阶段 4），这里只记录意图
  $stageDir = Join-Path $env:TEMP ('imgpost-npm-' + $stamp)
  Say-Dim ("插件来源：npm（确认后下载到 " + $stageDir + "）")
} else {
  if ($PluginDir -ne "") { $sourceDir = $PluginDir } else { $sourceDir = Split-Path $PSScriptRoot -Parent }
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $entryRel))) {
    Say-Err ("插件入口不存在：" + (Join-Path $sourceDir $entryRel))
    Say-Dim "用 -PluginDir 指向 imgpost 源码目录，或用 -FromNpm 从 npm 安装。"
    exit 1
  }
  $sourceDir = (Resolve-Full $sourceDir)
  Say-Dim ("插件来源：" + $sourceDir)
}

$samePath = Test-SamePath $sourceDir $targetDir
Say-Dim ("目标目录：" + $targetDir)

# ══ 阶段 1：只读定位 profile ═══════════════════════════════════════════════
$profilesDir = Join-Path $dshRoot 'profiles'
$candidates = @()
if ($Profile -ne "") {
  $p = Join-Path $profilesDir (Join-Path $Profile 'package.json')
  if (Test-Path -LiteralPath $p) { $candidates += $p } else { Fail ("找不到 profile：" + $p + "（用 -Profile <名字> 指定）") 1 }
} else {
  if (Test-Path -LiteralPath $profilesDir) {
    # 只看 ~/.dsh/profiles/<名字>/package.json 这一层，天然避开 node_modules 里的副本
    $candidates += Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'package.json' } |
      Where-Object { Test-Path -LiteralPath $_ }
  }
}
$candidates = @($candidates | Select-Object -Unique)
if ($candidates.Count -eq 0) {
  Fail "在 ~/.dsh/profiles/*/package.json 下没找到 DSH profile，请用 -Profile <名字> 指定。" 1
}
if ($candidates.Count -gt 1) {
  Say-Warn "找到多个 profile，使用第一个："
  $candidates | ForEach-Object { Say-Dim ("  - " + $_) }
}
$profilePkg = $candidates[0]
$profileDir = Split-Path $profilePkg -Parent
Say-Dim ("profile：" + $profilePkg)

# ══ 阶段 2：只读解析 profile 配置 ══════════════════════════════════════════
$profileRaw = [string](Get-Content -LiteralPath $profilePkg -Raw -Encoding UTF8)
if ([string]::IsNullOrWhiteSpace($profileRaw)) { Fail "profile 的 package.json 是空的，已停止（未做任何改动）。" 1 }
$pkg = $null
try {
  $pkg = $profileRaw | ConvertFrom-Json
} catch {
  Fail ("profile 的 package.json 不是合法 JSON，已停止（未做任何改动）：" + $_.Exception.Message) 1
}
if ($null -eq $pkg) { Fail ("profile 的 package.json 是空的，已停止（未做任何改动）。") 1 }

# ══ 阶段 3：只读计划 ═══════════════════════════════════════════════════════
function Invoke-LegacyPatch([string]$patchDir) {
  # 老版 DSH：往 cordis.patch.yml 末尾追加一个 insert 块（先备份、后写入、再校验）
  $patchFile = Join-Path $patchDir 'cordis.patch.yml'
  $oldContent = if (Test-Path -LiteralPath $patchFile) { Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8 } else { "" }
  # 空文件时 Get-Content -Raw 返回 $null，后面要调 .TrimEnd()，这里先归一成空串
  if ($null -eq $oldContent) { $oldContent = '' }
  if ($oldContent -match '(?m)^\s*-\s*id:\s*imgpost\s*$') {
    Say-Warn ("imgpost 已经写在 " + $patchFile + " 里了，无需操作。")
    exit 0
  }
  $relEntry = '../../plugins/' + $pluginName + '/' + ($entryRel -replace '\\', '/')
  $block = @"

# -- imgpost (TuYou): send_image / generate_image / imgpost_read_image / imgpost_check_backend --
- insert:
    - id: imgpost
      name: '$relEntry'
"@
  if (-not $Yes) {
    Write-Host ""
    Write-Host ("将向 " + $patchFile + " 末尾追加 imgpost 配置（先备份、失败回滚）。继续？[Y/n] ") -NoNewline -ForegroundColor Yellow
    $ans = Read-Host
    if ($ans -notmatch '^[Yy]?$') { Say-Warn "已取消，未做任何改动。"; exit 3 }
  }
  # 备份就近存放：cordis.patch.yml.bak-<时间戳>
  $patchBackup = $patchFile + '.bak-' + $stamp
  try {
    if (Test-Path -LiteralPath $patchFile) { Copy-Item -LiteralPath $patchFile -Destination $patchBackup -Force }
  } catch {
    Fail ("创建备份失败，未做任何改动：" + $_.Exception.Message) 1
  }
  Add-Rollback 'file' $patchFile $patchBackup
  $newContent = $oldContent.TrimEnd() + "`n" + $block + "`n"
  try {
    [System.IO.File]::WriteAllText($patchFile, $newContent, [System.Text.UTF8Encoding]::new($false))
  } catch {
    Invoke-Rollback
    Fail ("写入 cordis.patch.yml 失败：" + $_.Exception.Message) 1
  }
  $problems = Test-PatchFile $patchFile $oldContent $relEntry
  if ($problems.Count -gt 0) {
    Invoke-Rollback
    Say-Err "cordis.patch.yml 校验不通过："
    $problems | ForEach-Object { Say-Dim ("  - " + $_) }
    Fail "已回滚到改动前的内容。" 1
  }
  Say-Ok ("imgpost 已写入 " + $patchFile + "（legacy insert 模式）。")
  Say-Dim ("备份：" + $patchBackup)
  Say-Warn "下一步：重启 DSH。"
  exit 0
}

# YAML 结构校验：优先用真正的 YAML 解析器，没有就退化为结构检查
function Test-PatchFile([string]$patchFile, [string]$oldContent, [string]$relEntry) {
  $problems = New-Object System.Collections.ArrayList
  # 同样：空文件要归一成空串，否则 .StartsWith / 正则都会炸
  $text = [string](Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8)

  # 1) 原有内容必须原样保留（我们只追加）
  $prefix = $oldContent.TrimEnd()
  if ($prefix.Length -gt 0 -and -not $text.StartsWith($prefix)) {
    [void]$problems.Add('原有内容发生了变化（应只在末尾追加）')
  }
  # 2) 顶层必须是数组：第一行有效内容要么是 [] 要么是 "- " 开头的列表项
  $firstLine = ($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') } | Select-Object -First 1)
  if ($firstLine -and -not ($firstLine.Trim() -eq '[]' -or $firstLine.TrimStart().StartsWith('- '))) {
    [void]$problems.Add('顶层不是 YAML 数组（第一行有效内容应为 "[]" 或 "- ..."）')
  }
  # 3) 追加块的结构：- insert: 顶格，子项 4 空格，name 6 空格
  if ($text -notmatch '(?m)^- insert:\s*$') { [void]$problems.Add('缺少顶格的 "- insert:" 行') }
  if ($text -notmatch '(?m)^ {4}- id: imgpost\s*$') { [void]$problems.Add('缺少正确的 "    - id: imgpost" 行（4 空格缩进）') }
  if ($text -notmatch ('(?m)^ {6}name: ' + [regex]::Escape("'" + $relEntry + "'") + '\s*$')) {
    [void]$problems.Add('缺少正确的 name 行（6 空格缩进且指向 ' + $relEntry + '）')
  }
  # 4) 若有 YAML 解析器，做一次真正的解析
  $yamlCmd = Get-Command ConvertFrom-Yaml -ErrorAction SilentlyContinue
  if ($yamlCmd) {
    try {
      # 注意：YAML 只有一个顶层条目时（例如原本空的 cordis.patch.yml），解析器
      # 返回的是单个对象而不是数组。这里用 @() 归一化后再看内容；"顶层必须是
      # 数组"由上面的结构检查负责，避免把合法的单条目文件误判成非法。
      $items = @($text | ConvertFrom-Yaml)
      if ($items.Count -eq 0) {
        [void]$problems.Add('ConvertFrom-Yaml 解析结果为空')
      } else {
        $found = $false
        foreach ($entry in $items) {
          if ($entry -and $entry.insert) {
            foreach ($item in @($entry.insert)) {
              if ($item -and ($item.id -eq 'imgpost')) { $found = $true }
            }
          }
        }
        if (-not $found) { [void]$problems.Add('ConvertFrom-Yaml 解析后找不到 insert -> id: imgpost') }
      }
    } catch {
      [void]$problems.Add('ConvertFrom-Yaml 解析失败：' + $_.Exception.Message)
    }
  }
  return $problems
}

# ── legacy 模式直接走 ──────────────────────────────────────────────────────
if ($LegacyPatch) { Invoke-LegacyPatch $profileDir }

# ── 判断 profile 里 dsh 结构是否需要初始化（不再对 null 调 Add-Member）──────
$hasDsh = $null -ne $pkg.PSObject.Properties['dsh']
if (-not $hasDsh) {
  Say-Warn "这个 profile 里没有 dsh 配置块，改用 legacy 的 cordis.patch.yml 方式。"
  Invoke-LegacyPatch $profileDir
}

$wantLink = 'link:' + ($targetDir -replace '\\', '/')
$depValue = $null
if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties[$pluginName]) {
  $depValue = [string]$pkg.dependencies.$pluginName
}
$depTarget = Get-LinkTarget $depValue $profileDir
$depOk = Test-SamePath $depTarget $targetDir

$bundles = $null
if ($pkg.dsh.profile -and $pkg.dsh.profile.PSObject.Properties['bundles']) { $bundles = $pkg.dsh.profile.bundles }
$bundleOk = ($null -ne $bundles) -and (@($bundles) -contains $pluginName)

$needCopy = $true
$copyDiff = @()
if ($FromNpm) {
  $copyDiff = @('（npm 模式：确认后下载再复制）')
} elseif ($samePath) {
  $needCopy = $false
} else {
  $copyDiff = @(Get-CopyDiff $sourceDir $targetDir)
  $needCopy = ($copyDiff.Count -gt 0)
}

$linked = Test-Path -LiteralPath (Join-Path $profileDir ('node_modules\' + $pluginName))

Say-Step "计划："
Say-Dim ("  插件目录      : " + $targetDir + $(if ($needCopy) { '  -> 将被写入' } else { '  -> 内容已一致，跳过' }))
if ($needCopy) { $copyDiff | Select-Object -First 8 | ForEach-Object { Say-Dim ("                  · " + $_) } }
if ($copyDiff.Count -gt 8) { Say-Dim ("                  · ... 共 " + $copyDiff.Count + " 项") }
$depLine = '  依赖           : '
if ($depOk) { $depLine += $wantLink + '（已正确）' }
elseif ($depValue) { $depLine += $depValue + '  -> 将改为 ' + $wantLink }
else { $depLine += '将新增 ' + $wantLink }
Say-Dim $depLine
if ($bundleOk) { Say-Dim '  dsh.profile.bundles: 已包含 imgpost' }
elseif ($null -eq $bundles) { Say-Dim '  dsh.profile.bundles: 不存在 -> 将创建并加入 imgpost' }
else { Say-Dim '  dsh.profile.bundles: 将加入 imgpost（保持原有顺序）' }
if ($linked) { Say-Dim '  node_modules 链接  : 已存在' } else { Say-Dim '  node_modules 链接  : 缺失 -> 需要 pnpm install' }

$configChanged = (-not $depOk) -or (-not $bundleOk)

if ((-not $needCopy) -and (-not $configChanged) -and $linked) {
  Say-Ok "imgpost 已安装且链接完整，无需操作。"
  exit 0
}
if ((-not $needCopy) -and (-not $configChanged) -and (-not $linked)) {
  Say-Warn "配置已就绪，但 node_modules 里还没有 imgpost 链接，需要跑一次 pnpm install。"
}

# ══ 阶段 4：确认（在任何写操作之前）════════════════════════════════════════
if (-not $Yes) {
  Write-Host ""
  Write-Host "以上是即将执行的改动（先备份，失败回滚）。继续？[Y/n] " -NoNewline -ForegroundColor Yellow
  $ans = Read-Host
  if ($ans -notmatch '^[Yy]?$') { Say-Warn "已取消，未做任何改动。"; exit 3 }
}

# ══ 阶段 5a：-FromNpm 先下载到临时目录（只写 TEMP，失败时用户目录零痕迹）══
if ($FromNpm) {
  Say-Step ("从 npm 下载到 " + $stageDir + " ...")
  $npmCode = 1
  try {
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Push-Location $stageDir
    npm install --no-save imgpost
    $npmCode = $LASTEXITCODE
    Pop-Location
  } catch {
    try { Pop-Location } catch { }
    Fail ("npm install 失败，未做任何改动：" + $_.Exception.Message + "（可手动执行：npm install imgpost --prefix " + $stageDir + "）") 1
  }
  if ($npmCode -ne 0) {
    Fail ("npm install 退出码 " + $npmCode + "，未做任何改动。可手动执行：npm install imgpost --prefix " + $stageDir) 1
  }
  $sourceDir = Join-Path $stageDir 'node_modules\imgpost'
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir $entryRel))) {
    Fail ("npm 下载的包里没有 " + $entryRel + "，未做任何改动。") 1
  }
}

# ══ 阶段 5b：备份（就近存放，便于手工还原）═════════════════════════════════
Say-Step "备份 ..."
$profileBackup = $profilePkg + '.bak-' + $stamp
try {
  Copy-Item -LiteralPath $profilePkg -Destination $profileBackup -Force
} catch {
  Fail ("备份 profile package.json 失败，未做任何改动：" + $_.Exception.Message) 1
}
Add-Rollback 'file' $profilePkg $profileBackup
[void]$script:BackupsMade.Add($profileBackup)
Say-Dim ("  profile 配置 -> " + $profileBackup)

$pluginBackup = $null
if ($needCopy -and (Test-Path -LiteralPath $targetDir)) {
  $pluginBackup = $targetDir + '.bak-' + $stamp
  try {
    Copy-Item -LiteralPath $targetDir -Destination $pluginBackup -Recurse -Force
    Add-Rollback 'dir' $targetDir $pluginBackup
    [void]$script:BackupsMade.Add($pluginBackup)
    Say-Dim ("  插件目录   -> " + $pluginBackup)
  } catch {
    Fail ("备份插件目录失败，未做任何改动：" + $_.Exception.Message) 1
  }
}
if ($needCopy -and -not (Test-Path -LiteralPath $targetDir)) {
  Add-Rollback 'dir' $targetDir $null   # 新建的目录，回滚时删掉
}

# ══ 阶段 6：写入（失败即回滚）═════════════════════════════════════════════
if ($needCopy) {
  Say-Step ("复制插件到 " + $targetDir + " ...")
  try {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -Path (Join-Path $sourceDir '*') -Destination $targetDir -Recurse -Force
  } catch {
    Invoke-Rollback
    Fail ("复制插件失败：" + $_.Exception.Message) 1
  }
  if (-not (Test-Path -LiteralPath (Join-Path $targetDir $entryRel))) {
    Invoke-Rollback
    Fail ("复制后找不到入口文件 " + (Join-Path $targetDir $entryRel)) 1
  }
  $afterCopy = @(Get-CopyDiff $sourceDir $targetDir)
  if ($afterCopy.Count -gt 0) {
    Invoke-Rollback
    Say-Err "复制后校验失败，以下文件与来源不一致："
    $afterCopy | Select-Object -First 8 | ForEach-Object { Say-Dim ("  - " + $_) }
    Fail "已回滚。" 1
  }
  Say-Dim "  复制完成并逐文件校验通过"
}

if ($configChanged) {
  Say-Step ("更新 " + $profilePkg + " ...")
  try {
    # dependencies：保留已有顺序，只补/改 imgpost 这一项
    if (-not ($pkg.PSObject.Properties['dependencies'] -and $pkg.dependencies)) {
      $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($pkg.dependencies.PSObject.Properties[$pluginName]) {
      $pkg.dependencies.$pluginName = $wantLink
    } else {
      $pkg.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $wantLink -Force
    }
    # dsh / dsh.profile / dsh.profile.bundles：缺失就建出来（不再对 null 调 Add-Member）
    if (-not $pkg.dsh.PSObject.Properties['profile'] -or -not $pkg.dsh.profile) {
      $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if (-not $pkg.dsh.profile.PSObject.Properties['bundles'] -or -not $pkg.dsh.profile.bundles) {
      $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
    }
    if (-not (@($pkg.dsh.profile.bundles) -contains $pluginName)) {
      $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $pluginName
    }
    $json = $pkg | ConvertTo-Json -Depth 32
    [System.IO.File]::WriteAllText($profilePkg, $json + "`n", [System.Text.UTF8Encoding]::new($false))
  } catch {
    Invoke-Rollback
    Fail ("写入 profile 配置失败：" + $_.Exception.Message) 1
  }

  # 写完立刻重新解析校验
  $ok = $false
  try {
    $check = (Get-Content -LiteralPath $profilePkg -Raw -Encoding UTF8) | ConvertFrom-Json
    $checkDep = Get-LinkTarget ([string]$check.dependencies.$pluginName) $profileDir
    $ok = (Test-SamePath $checkDep $targetDir) -and (@($check.dsh.profile.bundles) -contains $pluginName)
  } catch {
    $ok = $false
  }
  if (-not $ok) {
    Invoke-Rollback
    Fail "写入后校验不通过（dependencies 或 bundles 没写对），已回滚。" 1
  }
  Say-Dim "  已写入并重新解析校验通过"
  Say-Dim ("    dependencies." + $pluginName + " = " + $wantLink)
  Say-Dim ("    dsh.profile.bundles += " + $pluginName)
}

# ══ 阶段 7：pnpm install（检查退出码）═════════════════════════════════════
$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCmd) {
  Say-Err "没找到 pnpm，安装尚未完成。请手动执行："
  Say-Dim ("  cd " + $profileDir + " ; pnpm install")
  Say-BackupNote
  exit 2
}
Say-Step ("在 profile 目录跑 pnpm install ...")
$pnpmCode = 1
try {
  Push-Location $profileDir
  & $pnpmCmd.Source install --ignore-scripts
  $pnpmCode = $LASTEXITCODE
  Pop-Location
} catch {
  try { Pop-Location } catch { }
  $pnpmCode = 1
  Say-Err ("pnpm install 执行失败：" + $_.Exception.Message)
}
if ($pnpmCode -ne 0) {
  Say-Err ("pnpm install 退出码 " + $pnpmCode + "，安装尚未完成。请手动执行：")
  Say-Dim ("  cd " + $profileDir + " ; pnpm install")
  Say-Dim "提示：装了多个 pnpm store 时可能要加 --store-dir 指回原来的 store。"
  Say-BackupNote
  exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $profileDir ('node_modules\' + $pluginName)))) {
  Say-Warn "pnpm install 成功，但 node_modules 里仍没有 imgpost 链接（可能是 workspace 链接策略），请检查后再重启 DSH。"
  Say-BackupNote
  exit 2
}

Say-Ok "imgpost 安装成功。"
Say-BackupNote
Say-Warn "下一步：重启 DSH，模型会拿到 send_image / generate_image / imgpost_read_image / imgpost_check_backend。"
Say-Dim "可选配置："
Say-Dim "  生图：~/.dsh/image-sender.json { apiKey, baseURL, model } 或 DSH_IMAGE_API_*"
Say-Dim "  识图：~/.dsh/vision-sender.json { primary, fallback }    或 DSH_VISION_API_*"
exit 0
