# 一键回滚 dsh-iab（desktop 起不来时用）
#
#   .\rollback-dsh-iab.ps1                  # 真回滚
#   .\rollback-dsh-iab.ps1 -DryRun          # 只看会做什么，不动文件
#
# 从备份还原 desktop profile 的三个文件并摘掉 node_modules 链接。
# 不需要 DSH 在运行 —— 这正是它能救场的原因。
# 先完全退出 DeepSeek Harness 再执行，否则 Electron 可能把文件覆盖回去。

[CmdletBinding()]
param(
  [string]$ProfileDir = 'D:\Users\fan.deng\.dsh\profiles\desktop',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 每组：要还原的文件 + 首选备份 + 兜底备份
$pairs = @(
  @{ name = 'package.json';     backups = @('package.json.bak-beforeinstall', 'package.json.bak-iab') },
  @{ name = 'cordis.patch.yml'; backups = @('cordis.patch.yml.bak-beforeinstall', 'cordis.patch.yml.bak-iab') },
  @{ name = 'pnpm-lock.yaml';   backups = @('pnpm-lock.yaml.bak-beforeinstall') }
)

if (-not (Test-Path $ProfileDir)) {
  Write-Host "找不到 profile 目录: $ProfileDir" -ForegroundColor Red
  exit 1
}

$running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host '!! DeepSeek Harness 还在运行。请先完全退出桌面端再执行。' -ForegroundColor Yellow
  Write-Host '   （运行中继续操作，可能被 Electron 覆盖回去）' -ForegroundColor DarkGray
}

foreach ($pair in $pairs) {
  $target = Join-Path $ProfileDir $pair.name
  $source = $null
  foreach ($candidate in $pair.backups) {
    $candidatePath = Join-Path $ProfileDir $candidate
    if (Test-Path $candidatePath) { $source = $candidatePath; break }
  }
  if (-not $source) {
    Write-Host "跳过 $($pair.name)（没有可用备份）" -ForegroundColor DarkGray
    continue
  }
  if ($DryRun) {
    Write-Host "[dry] $($pair.name)  <-  $(Split-Path $source -Leaf)" -ForegroundColor Cyan
  } else {
    Copy-Item $source $target -Force
    Write-Host "还原 $($pair.name)  <-  $(Split-Path $source -Leaf)" -ForegroundColor Green
  }
}

$link = Join-Path $ProfileDir 'node_modules\dsh-iab'
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType) {
    if ($DryRun) {
      Write-Host "[dry] 摘除 node_modules\dsh-iab ($($item.LinkType) -> $($item.Target))" -ForegroundColor Cyan
    } else {
      Remove-Item $link -Force
      Write-Host '已摘除 node_modules\dsh-iab 链接' -ForegroundColor Green
    }
  } else {
    Write-Host '!! node_modules\dsh-iab 是真实目录而非链接，未删除，请人工确认' -ForegroundColor Yellow
  }
} else {
  Write-Host 'node_modules\dsh-iab 不存在，无需摘除' -ForegroundColor DarkGray
}

Write-Host ''
if ($DryRun) {
  Write-Host 'DryRun 结束，未修改任何文件。' -ForegroundColor Cyan
} else {
  $leftover = Select-String -Path (Join-Path $ProfileDir 'package.json') -Pattern 'dsh-iab' -ErrorAction SilentlyContinue
  if ($leftover) {
    Write-Host '!! package.json 里仍有 dsh-iab 字样，请人工检查' -ForegroundColor Yellow
  } else {
    Write-Host '完成：desktop profile 已回到未安装状态，可以重新启动 DSH。' -ForegroundColor Green
  }
}
