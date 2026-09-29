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
  powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DshHome '<DSH 根目录>'
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
  [string]$DshHome = "",
  [switch]$FromNpm,
  [switch]$LegacyPatch,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$osHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
# DSH 根目录：优先级必须与插件运行时一致 —— -DshHome > $env:DSH_HOME（trim 后非空）> <os home>/.dsh，
# 支持 '~' / '~/' / '~\' 前缀展开。插件按 dshHome 配置 > $DSH_HOME > ~/.dsh 解析根目录，
# 安装器若固定用 USERPROFILE\.dsh，在自定义根目录的机器上会去改错的 profile。
if ($DshHome -and $DshHome.Trim()) {
  $dshRootRaw = $DshHome.Trim(); $dshRootSource = '-DshHome'
} elseif ($env:DSH_HOME -and $env:DSH_HOME.Trim()) {
  $dshRootRaw = $env:DSH_HOME.Trim(); $dshRootSource = '$env:DSH_HOME'
} else {
  $dshRootRaw = Join-Path $osHome '.dsh'; $dshRootSource = '默认 (<os home>/.dsh)'
}
if ($dshRootRaw -eq '~') { $dshRootRaw = $osHome }
elseif ($dshRootRaw.StartsWith('~/') -or $dshRootRaw.StartsWith('~\')) { $dshRootRaw = Join-Path $osHome $dshRootRaw.Substring(2) }
$dshRoot = [System.IO.Path]::GetFullPath($dshRootRaw)
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
  # 回滚没能完全还原时，退出码必须非零，哪怕调用方传了 0。
  if ($code -eq 0 -and $script:RollbackFailures -and $script:RollbackFailures.Count -gt 0) { $code = 1 }
  exit $code
}
# 本次实际生成的备份列表（用于结尾提示）
$script:BackupsMade = New-Object System.Collections.ArrayList
# 回滚过程中还原失败的条目。单个条目失败不中断其余条目的还原，但必须记下来并让退出码非零。
$script:RollbackFailures = New-Object System.Collections.ArrayList
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
# 枚举一律 -ErrorAction Stop：静默漏文件会让"双向哈希校验"看不出任何问题，等于校验失效。
# 计划阶段就会调用它做差异比对，所以枚举失败必然发生在任何写入之前。
function Get-FileMap([string]$root) {
  $map = @{}
  if (-not (Test-Path -LiteralPath $root)) { return $map }
  $base = (Resolve-Full $root).TrimEnd('\', '/')
  try {
    $files = Get-ChildItem -LiteralPath $base -Recurse -File -Force -ErrorAction Stop |
      Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.Name -notmatch '\.bak' }
  } catch {
    throw ("无法枚举目录内容：" + $base + " -> " + $_.Exception.Message)
  }
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($base.Length).TrimStart('\', '/')
    try {
      $map[$rel] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
    } catch {
      throw ("无法读取文件哈希：" + $file.FullName + " -> " + $_.Exception.Message)
    }
  }
  return $map
}
# 双向差异：Add = 源有目标缺失/不一致（需要写），Del = 目标有源没有（需要删）。
# 只比源侧的话，目标目录里旧版残留（比如删掉本地模板后留下的 src\workflows\*.json）
# 差异数会是 0，永远清理不掉。
function Get-CopyDiff([string]$source, [string]$target) {
  $add = New-Object System.Collections.ArrayList
  $del = New-Object System.Collections.ArrayList
  $src = Get-FileMap $source
  $tgt = Get-FileMap $target
  foreach ($rel in ($src.Keys | Sort-Object)) {
    if (-not $tgt.ContainsKey($rel)) { [void]$add.Add($rel + ' 缺失'); continue }
    if ($tgt[$rel] -ne $src[$rel]) { [void]$add.Add($rel + ' 不一致') }
  }
  foreach ($rel in ($tgt.Keys | Sort-Object)) {
    if (-not $src.ContainsKey($rel)) { [void]$del.Add($rel) }
  }
  return [pscustomobject]@{ Add = @($add); Del = @($del) }
}

# 把源目录整棵树复制到目标（含隐藏文件如 .gitignore，这是 Copy-Item 通配符写法会漏掉的）。
# 排除规则必须与 Get-FileMap 一致（.git / node_modules / *.bak），否则做完复制的差异校验
# 会因为被排除的文件而误报。
# 枚举用 -ErrorAction Stop：漏文件必须当场失败。复制完成后的核对由 Get-CopyDiff 负责，
# 它会**重新枚举**源与目标两侧，不复用这里可能不完整的清单。
function Copy-Tree([string]$Source, [string]$Target) {
  $src = (Resolve-Full $Source).TrimEnd('\', '/')
  try {
    $files = Get-ChildItem -LiteralPath $src -Recurse -File -Force -ErrorAction Stop |
      Where-Object { $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\node_modules\\' -and $_.Name -notmatch '\.bak' }
  } catch {
    throw ("无法枚举源目录：" + $src + " -> " + $_.Exception.Message)
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($file in $files) {
    $rel = $file.FullName.Substring($src.Length).TrimStart('\', '/')
    $dest = Join-Path $Target $rel
    $parent = Split-Path -Path $dest -Parent
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $file.FullName -Destination $dest -Force -ErrorAction Stop
  }
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
      # 所有文件操作都用终止性错误（-ErrorAction Stop）：默认的非终止性错误不会进 catch，
      # 于是"已恢复"会被打印出来而文件其实没还原 —— 那是比不打印更糟的假成功。
      if ($a.Kind -eq 'file') {
        if ($a.Backup -and (Test-Path -LiteralPath $a.Backup -ErrorAction Stop)) {
          Copy-Item -LiteralPath $a.Backup -Destination $a.Target -Force -ErrorAction Stop
          Say-Dim ("  已恢复 " + $a.Target)
        } elseif (-not $a.Backup) {
          # 登记时目标原本不存在（例如新建的 cordis.patch.yml）：回滚就是删掉它，
          # 否则"回滚成功"之后文件还在，等于没回滚。
          if (Test-Path -LiteralPath $a.Target -ErrorAction Stop) {
            Remove-Item -LiteralPath $a.Target -Force -ErrorAction Stop
            Say-Dim ("  已移除新建的 " + $a.Target)
          }
        }
      } elseif ($a.Kind -eq 'dir') {
        if (Test-Path -LiteralPath $a.Target -ErrorAction Stop) { Remove-Item -LiteralPath $a.Target -Recurse -Force -ErrorAction Stop }
        if ($a.Backup -and (Test-Path -LiteralPath $a.Backup -ErrorAction Stop)) {
          Move-Item -LiteralPath $a.Backup -Destination $a.Target -Force -ErrorAction Stop
          Say-Dim ("  已恢复 " + $a.Target)
        } else {
          Say-Dim ("  已移除新建的 " + $a.Target)
        }
      }
    } catch {
      # 单个条目失败不中断其余条目：继续还原后面的，但记下来并显著报出来。
      Say-Err ("  回滚 " + $a.Target + " 失败：" + $_.Exception.Message)
      [void]$script:RollbackFailures.Add($a.Target)
    }
  }
  if ($script:RollbackFailures.Count -gt 0) {
    Say-Err ("回滚未完全成功，以下目标需要你手工核对：" + ($script:RollbackFailures -join '  '))
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
# 在 patch 文本里找 imgpost 那一项，返回 id 行下标与缩进；找不到返回 -1。
# 只读、不抛错：调用方（计划阶段）必须能在任何写入之前安全地跑它。
function Find-LegacyEntry([string[]]$lines) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^([ \t]*)-\s*id:\s*imgpost\s*$') {
      return [pscustomobject]@{ Index = $i; Indent = $matches[1].Length }
    }
  }
  return [pscustomobject]@{ Index = -1; Indent = 0 }
}

# 取 imgpost 那一项里的 name 值（同一项内、遇到同级或更浅的下一个 "- " 条目就停）。找不到返回 $null。
function Get-LegacyEntryName([string[]]$lines, [int]$idIndex, [int]$idIndent) {
  for ($j = $idIndex + 1; $j -lt $lines.Count; $j++) {
    $line = $lines[$j]
    if ($line.Trim() -eq '') { continue }
    if ($line -match '^([ \t]*)-\s') { if ($matches[1].Length -le $idIndent) { break } else { continue } }
    if ($line -match '^[ \t]*#') { continue }
    if ($line -match '^[ \t]*name:\s*(.*?)\s*$') { return ([string]$matches[1]).Trim().Trim("'").Trim('"') }
  }
  return $null
}

# 探测 legacy 需要改的 patch 文件状态（只读，供计划与后面的写入使用）。
# 只看到 "- id: imgpost" **不算**已安装：还要核对这一项的 name 是否指向我们预期的入口。
# 指向别处（例如 missing.js）时必须视为"需要修正"，否则脚本会跳过写入、最后只校验预期
# 路径存在，patch 里那条错误路径永远不会被发现。
function Get-LegacyState([string]$patchDir) {
  $relEntry = '../../plugins/' + $pluginName + '/' + ($entryRel -replace '\\', '/')
  $patchFile = Join-Path $patchDir 'cordis.patch.yml'
  $exists = Test-Path -LiteralPath $patchFile
  $content = ''
  if ($exists) {
    $content = [string](Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8)
    # 空文件时 Get-Content -Raw 返回 $null，后面要调 .TrimEnd()，这里先归一成空串
    if ($null -eq $content) { $content = '' }
  }
  $lines = $content -split "\n"
  $entry = Find-LegacyEntry $lines
  $found = ($entry.Index -ge 0)
  $foundName = $null
  if ($found) { $foundName = Get-LegacyEntryName $lines $entry.Index $entry.Indent }
  $nameOk = $false
  if ($found -and $foundName) {
    $nameOk = Test-SamePath (Join-Path $patchDir $foundName) (Join-Path $patchDir $relEntry)
  }
  return [pscustomobject]@{
    File         = $patchFile
    Exists       = $exists
    Content      = $content
    Registered   = ($found -and $nameOk)
    NeedsFix     = ($found -and (-not $nameOk))
    FoundName    = $foundName
    ExpectedName = $relEntry
  }
}

# 把既有的 imgpost 条目里的 name 改成预期入口，其它内容与注释原样保留。
# 找不到条目返回 $null（调用方据此判定"修正失败"，不要静默当成成功）。
function Set-LegacyEntryName([string]$content, [string]$relEntry) {
  $lines = New-Object System.Collections.ArrayList
  foreach ($l in ($content -split "\n")) { [void]$lines.Add($l) }
  $entry = Find-LegacyEntry ($lines.ToArray())
  if ($entry.Index -lt 0) { return $null }
  $replaceAt = -1
  $indent = ' ' * ($entry.Indent + 2)
  for ($j = $entry.Index + 1; $j -lt $lines.Count; $j++) {
    $line = $lines[$j]
    if ($line.Trim() -eq '') { continue }
    if ($line -match '^([ \t]*)-\s') { if ($matches[1].Length -le $entry.Indent) { break } else { continue } }
    if ($line -match '^[ \t]*#') { continue }
    if ($line -match '^([ \t]*)name:\s*') { $indent = $matches[1]; $replaceAt = $j; break }
  }
  if ($replaceAt -ge 0) {
    $lines[$replaceAt] = $indent + "name: '" + $relEntry + "'"
  } else {
    $lines.Insert($entry.Index + 1, $indent + "name: '" + $relEntry + "'")
  }
  return ($lines -join "`n")
}

# 写入 legacy 的 cordis.patch.yml。调用方已完成确认、备份与插件落地；这里只管写 + 校验，
# 失败即回滚并退出（不再提前 exit，否则插件根本没被复制就已经"安装成功"了）。
# $needsFix = 已有 imgpost 条目但 name 指向别处：只改那一行，保留其它条目与注释。
function Write-LegacyPatch([string]$patchDir, [string]$oldContent, [bool]$needsFix) {
  $patchFile = Join-Path $patchDir 'cordis.patch.yml'
  $relEntry = '../../plugins/' + $pluginName + '/' + ($entryRel -replace '\\', '/')
  $blockBody = @"
# -- imgpost (TuYou): send_image / generate_image / imgpost_read_image / imgpost_check_backend --
- insert:
    - id: imgpost
      name: '$relEntry'
"@
  # 空文档（0 字节）或顶层空数组（[]）：整份重写成新数组。往 "[]" 后面追加 "- insert:"
  # 会得到"数组后面再跟一个 map"的混合文档，宿主真实的 js-yaml 会直接拒绝。这种文档本来
  # 就没有可保留的注释，所以选择重写而不是追加。
  $trimmed = $oldContent.Trim()
  $isEmptyDoc = ($trimmed -eq '') -or ($trimmed -eq '[]') -or ($trimmed -match '^---\s*(\[\])?\s*$')
  if ($isEmptyDoc) {
    $newContent = $blockBody + "`n"
  } elseif ($needsFix) {
    $newContent = Set-LegacyEntryName $oldContent $relEntry
    if ($null -eq $newContent) {
      # 计划阶段看到过这个条目，这里却找不到：宁可失败回滚，也不要写出一个半对的文件
      Invoke-Rollback
      Fail "无法在 cordis.patch.yml 里定位 imgpost 条目的 name 行，未做修改并已回滚。" 1
    }
  } else {
    $newContent = $oldContent.TrimEnd() + "`n`n" + $blockBody + "`n"
  }
  try {
    [System.IO.File]::WriteAllText($patchFile, $newContent, [System.Text.UTF8Encoding]::new($false))
  } catch {
    Invoke-Rollback
    Fail ("写入 cordis.patch.yml 失败：" + $_.Exception.Message) 1
  }
  # 重写/修正过的文档没有"原内容可比"的说法，按空前缀传入
  $prefixForCheck = $(if ($isEmptyDoc -or $needsFix) { '' } else { $oldContent })
  # 集合通过 $script:PatchProblems 传递（见 Test-PatchFile 注释）：空 ArrayList 走管道会被
  # 展开成 $null，调用方再 .Add 就抛异常、回滚不会执行 —— 第三轮审计的阻断项就是这个。
  # 这里再套一层 try/catch：校验过程本身出错也必须先回滚，绝不留"patch 写了、插件没就位"。
  $problems = New-Object System.Collections.ArrayList
  try {
    [void](Test-PatchFile $patchFile $prefixForCheck $relEntry)
    $problems = $script:PatchProblems
    # 注册的入口必须真的存在：配置写好了但插件没落地，是这一轮要堵的主要漏洞
    $resolvedEntry = Resolve-Full (Join-Path $patchDir $relEntry)
    if (-not (Test-Path -LiteralPath $resolvedEntry)) {
      [void]$problems.Add('patch 里注册的入口文件不存在：' + $resolvedEntry)
    }
  } catch {
    [void]$problems.Add('校验过程出错：' + $_.Exception.Message)
  }
  if ($problems.Count -gt 0) {
    Invoke-Rollback
    Say-Err "cordis.patch.yml 校验不通过："
    $problems | ForEach-Object { Say-Dim ("  - " + $_) }
    Fail "已回滚到改动前的状态。" 1
  }
  Say-Dim "  写入并校验通过（顶层数组 / 缩进 / 注册入口存在）"
}

# 没有 YAML 解析器时的**近似**结构校验：只判断"这份文档像不像一个合法的顶层数组"，
# 不能证明它是合法 YAML。已知局限：不处理流式风格嵌套、锚点/别名、多行标量、转义序列；
# 引号配平只看单行；缩进只按空白的相对多少判断。有 ConvertFrom-Yaml 时以真解析为准。
function Test-YamlStructure([string]$text) {
  $issues = New-Object System.Collections.ArrayList
  $lines = $text -split "\n"
  $brackets = 0
  $braces = 0
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    # 引号外的 "#"（前面是空白）才起注释：注释里的括号/引号不参与判定
    $stripped = ''
    $inS = $false
    $inD = $false
    for ($c = 0; $c -lt $line.Length; $c++) {
      $ch = $line[$c]
      if ($ch -eq "'" -and -not $inD) { $inS = -not $inS; $stripped += $ch; continue }
      if ($ch -eq '"' -and -not $inS) { $inD = -not $inD; $stripped += $ch; continue }
      if ($ch -eq '#' -and -not $inS -and -not $inD -and $c -gt 0 -and ($line[$c - 1] -eq ' ' -or $line[$c - 1] -eq "`t")) { break }
      $stripped += $ch
    }
    if ($inS -or $inD) { [void]$issues.Add("第 $($i + 1) 行引号未配平") }
    foreach ($ch in $stripped.ToCharArray()) {
      if ($ch -eq '[') { $brackets++ }
      elseif ($ch -eq ']') { $brackets--; if ($brackets -lt 0) { [void]$issues.Add("第 $($i + 1) 行出现多余的 ]"); $brackets = 0 } }
      elseif ($ch -eq '{') { $braces++ }
      elseif ($ch -eq '}') { $braces--; if ($braces -lt 0) { [void]$issues.Add("第 $($i + 1) 行出现多余的 }"); $braces = 0 } }
    }
    # 顶层（顶格）的非注释非空行必须是数组项，或空数组/文档起始标记
    if ($line.Trim() -ne '' -and -not $line.TrimStart().StartsWith('#')) {
      if ($line -eq $line.TrimStart() -and -not $line.StartsWith('- ') -and $line.Trim() -ne '[]' -and $line.Trim() -ne '---') {
        [void]$issues.Add("第 $($i + 1) 行位于顶层但不是数组项（应以 '- ' 开头）：" + $line.Trim())
      }
    }
  }
  if ($brackets -ne 0) { [void]$issues.Add("方括号未配平（差 $brackets 个）") }
  if ($braces -ne 0) { [void]$issues.Add("花括号未配平（差 $braces 个）") }
  return $issues
}

# YAML 结构校验：优先用真正的 YAML 解析器，没有就退化到上面的近似结构检查。
# 问题集合放进 $script:PatchProblems，**不**在管道里返回：PowerShell 会把空集合展开成
# $null，调用方再 .Add(...) 就抛异常、回滚不会执行（第三轮审计的阻断项）。
# 返回问题个数（int，管道安全），调用方可以忽略。
function Test-PatchFile([string]$patchFile, [string]$oldContent, [string]$relEntry) {
  $script:PatchProblems = New-Object System.Collections.ArrayList
  $problems = $script:PatchProblems
  # 同样：空文件要归一成空串，否则 .StartsWith / 正则都会炸
  $text = [string](Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8)
  if ($null -eq $text) { $text = '' }

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
  # 3.5) 近似结构校验（括号/引号配平、顶层条目形态）：没有 YAML 解析器时不再只靠正则
  foreach ($issue in (Test-YamlStructure $text)) { [void]$problems.Add($issue) }
  # 3.6) 追加块与原内容之间必须正好是一个空行（只在"往原文档末尾追加"时要求；整份重写/
  #      修正时 prefix 传空，这条跳过）。注意：不能用 "- insert:" 去找分隔位置 —— 追加块
  #      的第一行是注释行，子串匹配会落在注释之后，把正确的输出判成缺空行（误报）。
  if ($prefix.Length -gt 0 -and -not $text.Contains($prefix + "`n`n")) {
    [void]$problems.Add('原有内容与追加块之间缺少空行分隔')
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
  return $problems.Count
}

# ── 判定安装模式：profile 里有可用的 dsh 块就走 bundle，否则走 legacy 的 cordis.patch.yml ──
# dsh: null 必须当成"没有"：只判属性存在的话，后面的 $pkg.dsh.PSObject / Add-Member
# 会在 null 上抛错。
$hasDsh = ($null -ne $pkg.PSObject.Properties['dsh']) -and ($null -ne $pkg.dsh)
$useLegacy = $LegacyPatch -or (-not $hasDsh)
if ($LegacyPatch -and $hasDsh) {
  Say-Dim "指定了 -LegacyPatch：按 legacy 的 cordis.patch.yml 方式安装（不动 profile 的 package.json）。"
} elseif (-not $hasDsh) {
  Say-Warn "这个 profile 里没有可用的 dsh 配置块（缺失或为 null），改用 legacy 的 cordis.patch.yml 方式。"
}

$wantLink = 'link:' + ($targetDir -replace '\\', '/')
$depValue = $null
if ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties[$pluginName]) {
  $depValue = [string]$pkg.dependencies.$pluginName
}
$depTarget = Get-LinkTarget $depValue $profileDir
$depOk = (Test-SamePath $depTarget $targetDir)

$bundles = $null
if ((-not $useLegacy) -and $pkg.dsh.profile -and $pkg.dsh.profile.PSObject.Properties['bundles']) { $bundles = $pkg.dsh.profile.bundles }
$bundleOk = ($null -ne $bundles) -and (@($bundles) -contains $pluginName)

$needCopy = $true
$copyAdd = @()
$copyDel = @()
if ($FromNpm) {
  $copyAdd = @('（npm 模式：确认后下载再复制）')
} elseif ($samePath) {
  $needCopy = $false
} else {
  try {
    $d = Get-CopyDiff $sourceDir $targetDir
    $copyAdd = @($d.Add)
    $copyDel = @($d.Del)
    $needCopy = (($copyAdd.Count + $copyDel.Count) -gt 0)
  } catch {
    # 源目录里有读不了的文件（被独占锁定 / 权限不足）时差异比对会抛错：必须在任何写入
    # 之前停下并给出明确原因，而不是甩一个原始异常、更不是带着半份差异继续往下走。
    Fail ("无法读取源目录或目标目录里的文件，改动前已停止（未做任何写入）：" + $_.Exception.Message) 1
  }
}

$linked = Test-Path -LiteralPath (Join-Path $profileDir ('node_modules\' + $pluginName))
$legacy = Get-LegacyState $profileDir

Say-Step "计划："
Say-Dim ("  DSH 根目录    : " + $dshRoot + "（来源：" + $dshRootSource + "）")
Say-Dim ("  插件目录      : " + $targetDir + $(if ($needCopy) { '  -> 将按源内容重建' } else { '  -> 内容已一致，跳过' }))
if ($needCopy) {
  $copyAdd | Select-Object -First 6 | ForEach-Object { Say-Dim ("                  + " + $_) }
  if ($copyAdd.Count -gt 6) { Say-Dim ("                  + ... 共 " + $copyAdd.Count + " 项新增/更新") }
  $copyDel | Select-Object -First 6 | ForEach-Object { Say-Dim ("                  - " + $_ + "（源里已没有，将删除）") }
  if ($copyDel.Count -gt 6) { Say-Dim ("                  - ... 共 " + $copyDel.Count + " 项将删除") }
}
if ($useLegacy) {
  Say-Dim ("  安装方式      : legacy（改 " + $legacy.File + "，不动 profile 的 package.json）")
  if ($legacy.Registered) { Say-Dim '  cordis.patch.yml   : 已包含 imgpost 且入口正确（不会重复追加）' }
  elseif ($legacy.NeedsFix) {
    $shown = $(if ($legacy.FoundName) { $legacy.FoundName } else { '（缺少 name 行）' })
    Say-Dim ("  cordis.patch.yml   : 已有 imgpost 条目但 name 指向 " + $shown + " -> 将改为 " + $legacy.ExpectedName)
  }
  elseif (-not $legacy.Exists) { Say-Dim '  cordis.patch.yml   : 不存在 -> 将新建' }
  elseif ($legacy.Content.Trim() -eq '[]' -or $legacy.Content.Trim() -eq '') { Say-Dim '  cordis.patch.yml   : 空文档 -> 将整份重写为新数组' }
  else { Say-Dim '  cordis.patch.yml   : 将追加 imgpost 条目（保留原有内容）' }
} else {
  $depLine = '  依赖           : '
  if ($depOk) { $depLine += $wantLink + '（已正确）' }
  elseif ($depValue) { $depLine += $depValue + '  -> 将改为 ' + $wantLink }
  else { $depLine += '将新增 ' + $wantLink }
  Say-Dim $depLine
  if ($bundleOk) { Say-Dim '  dsh.profile.bundles: 已包含 imgpost' }
  elseif ($null -eq $bundles) { Say-Dim '  dsh.profile.bundles: 不存在 -> 将创建并加入 imgpost' }
  else { Say-Dim '  dsh.profile.bundles: 将加入 imgpost（保持原有顺序）' }
  if ($linked) { Say-Dim '  node_modules 链接  : 已存在' } else { Say-Dim '  node_modules 链接  : 缺失 -> 需要 pnpm install' }
}

$configChanged = ((-not $depOk) -or (-not $bundleOk)) -and (-not $useLegacy)
$legacyChanged = $useLegacy -and (-not $legacy.Registered)

if ((-not $needCopy) -and (-not $configChanged) -and (-not $legacyChanged) -and ($linked -or $useLegacy)) {
  Say-Ok "imgpost 已安装完整，无需操作。"
  exit 0
}
if ((-not $needCopy) -and (-not $configChanged) -and (-not $useLegacy) -and (-not $linked)) {
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
if (-not $useLegacy) {
  $profileBackup = $profilePkg + '.bak-' + $stamp
  try {
    Copy-Item -LiteralPath $profilePkg -Destination $profileBackup -Force
  } catch {
    Fail ("备份 profile package.json 失败，未做任何改动：" + $_.Exception.Message) 1
  }
  Add-Rollback 'file' $profilePkg $profileBackup
  [void]$script:BackupsMade.Add($profileBackup)
  Say-Dim ("  profile 配置 -> " + $profileBackup)
} elseif (-not $legacy.Registered) {
  # legacy 模式只动 cordis.patch.yml：存在就备份，不存在就把"新建"登记进回滚
  # （Backup 为空 = 回滚时删除），否则失败回滚后反而留下一个多出来的 patch 文件。
  if ($legacy.Exists) {
    $patchBackup = $legacy.File + '.bak-' + $stamp
    try {
      Copy-Item -LiteralPath $legacy.File -Destination $patchBackup -Force
    } catch {
      Fail ("备份 cordis.patch.yml 失败，未做任何改动：" + $_.Exception.Message) 1
    }
    Add-Rollback 'file' $legacy.File $patchBackup
    [void]$script:BackupsMade.Add($patchBackup)
    Say-Dim ("  cordis.patch.yml -> " + $patchBackup)
  } else {
    Add-Rollback 'file' $legacy.File $null
    Say-Dim "  cordis.patch.yml -> 不存在（本次新建，回滚时删除）"
  }
}

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
  Say-Step ("把插件目录按源内容重建：" + $targetDir + " ...")
  try {
    # 事务式替换：先清空再复制。只做合并复制的话，目标里旧版残留（例如上一版带的
    # src\workflows\*.json）差异数为 0，永远清不掉。清空前目录已经整份备份并登记回滚。
    if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
    Copy-Tree -Source $sourceDir -Target $targetDir
  } catch {
    Invoke-Rollback
    Fail ("复制插件失败：" + $_.Exception.Message) 1
  }
  # 复制后的复核整段都在回滚保护下：Get-CopyDiff 会在枚举/哈希失败时抛异常（文件被锁、
  # 读取失败这类竞态），原先这段在 try/catch 之外，异常逃逸后会留下一个已被替换、却没通过
  # 校验的目标目录，而且不会回滚。这里把结果记进变量、出了 try 再回滚退出，避免在 try 里
  # 调 Fail（exit 在 try 中的行为容易踩坑）。
  $copyVerifyProblem = $null
  try {
    $entryPath = Join-Path $targetDir $entryRel
    if (-not (Test-Path -LiteralPath $entryPath -ErrorAction Stop)) {
      $copyVerifyProblem = "复制后找不到入口文件 " + $entryPath
    } else {
      $afterCopy = Get-CopyDiff $sourceDir $targetDir
      $afterAdd = @($afterCopy.Add)
      $afterDel = @($afterCopy.Del)
      if (($afterAdd.Count + $afterDel.Count) -gt 0) {
        Say-Err "复制后校验失败（双向比对要求目标与源完全一致）："
        $afterAdd | Select-Object -First 8 | ForEach-Object { Say-Dim ("  + " + $_) }
        $afterDel | Select-Object -First 8 | ForEach-Object { Say-Dim ("  - " + $_ + "（多余，未清掉）") }
        $copyVerifyProblem = "复制后双向逐文件校验不通过"
      }
    }
  } catch {
    $copyVerifyProblem = "复制后校验无法完成（枚举或读取失败）：" + $_.Exception.Message
  }
  if ($copyVerifyProblem) {
    Invoke-Rollback
    Fail ($copyVerifyProblem + " 已回滚。") 1
  }
  Say-Dim "  复制完成，双向逐文件校验通过"
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

# ══ 阶段 7：legacy 收尾（写 cordis.patch.yml，不需要 pnpm）═════════════════
if ($useLegacy) {
  if ($legacy.Registered) {
    Say-Dim "  cordis.patch.yml 里已有 imgpost 条目且入口正确，跳过写入。"
  } else {
    Say-Step ("写入 " + $legacy.File + " ...")
    Write-LegacyPatch $profileDir $legacy.Content $legacy.NeedsFix
  }
  # 最后再确认一次注册的入口确实存在（插件已经在阶段 6 落地）
  $entryPath = Resolve-Full (Join-Path $profileDir ('../../plugins/' + $pluginName + '/' + ($entryRel -replace '\\', '/')))
  if (-not (Test-Path -LiteralPath $entryPath)) {
    Invoke-Rollback
    Fail ("安装后校验失败：patch 注册的入口不存在 " + $entryPath) 1
  }
  Say-Ok "imgpost 安装成功（legacy insert 模式）。"
  Say-Dim ("  入口：" + $entryPath)
  Say-BackupNote
  Say-Warn "下一步：重启 DSH，模型会拿到 send_image / generate_image / imgpost_read_image / imgpost_check_backend。"
  exit 0
}

# ══ 阶段 8：pnpm install（检查退出码）═════════════════════════════════════
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
