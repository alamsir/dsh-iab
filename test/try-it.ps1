# dsh-iab 试装/试用/清理脚本（全程独立 profile，不碰 desktop）
#
#   .\try-it.ps1 start     # 建临时 profile + 装插件 + 起一个独立端口的 dsh web
#   .\try-it.ps1 status    # 看它是否在跑
#   .\try-it.ps1 stop      # 关掉这个实例
#   .\try-it.ps1 clean     # stop + 删除临时 profile
#
# 为什么用独立 profile：插件的宿主侧代码跑在 DSH 进程里。装进 desktop 会让
# 桌面端连带加载它；放在独立 profile 里试，出问题最多是这个临时实例起不来，
# 你的 desktop 和正在用的 GUI 都不受影响。

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'clean', 'status')]
  [string]$Action = 'start',
  [int]$Port = 64990,
  [string]$ProfileName = 'iabtry'
)

$ErrorActionPreference = 'Stop'

$DshCli = 'D:\Users\fan.deng\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$Plugin = 'D:\Users\fan.deng\dsh\testcase-output\dsh-iab'
$ProfilesRoot = 'D:\Users\fan.deng\.dsh\profiles'
$ProfileDir = Join-Path $ProfilesRoot $ProfileName
$LogDir = 'D:\Users\fan.deng\dsh\testcase-output\_try'
$LogOut = Join-Path $LogDir 'server.log'
$LogErr = Join-Path $LogDir 'server.err'

function Get-ServerProcess {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) { return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue }
  return $null
}

function Stop-Server {
  $proc = Get-ServerProcess
  if ($proc) {
    Write-Host "停止临时实例 (pid=$($proc.Id), port=$Port) ..." -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  # 插件自己拉起的 Chromium 也一并收掉（只认 dsh-iab 的 profile）
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dsh-iab' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

switch ($Action) {
  'status' {
    $proc = Get-ServerProcess
    if ($proc) {
      Write-Host "运行中: pid=$($proc.Id) port=$Port" -ForegroundColor Green
      if (Test-Path $LogOut) {
        $m = Select-String -Path $LogOut -Pattern 'token=([A-Za-z0-9_\-]+)' | Select-Object -First 1
        if ($m) { Write-Host "打开: http://127.0.0.1:$Port/?token=$($m.Matches[0].Groups[1].Value)" -ForegroundColor Cyan }
      }
    } else {
      Write-Host "未运行 (port=$Port)" -ForegroundColor DarkGray
    }
  }

  'start' {
    Stop-Server | Out-Null

    # 1) 临时 profile：dsh-base + dsh-web-app + dsh-iab，和 desktop 同构但不含其它插件
    if (-not (Test-Path $ProfileDir)) {
      New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
      $pkg = [ordered]@{
        name    = "dsh-profile-$ProfileName"
        private = $true
        dependencies = [ordered]@{ 'dsh-iab' = "link:$($Plugin -replace '\\', '/')" }
        dsh     = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-iab') } }
      }
      $json = $pkg | ConvertTo-Json -Depth 6
      # 必须写成无 BOM 的 UTF-8：Windows PowerShell 的 Set-Content -Encoding UTF8
      # 会加 BOM，而 DSH 用 JSON.parse 读 profile 清单，BOM 会让它直接抛错。
      [System.IO.File]::WriteAllText(
        (Join-Path $ProfileDir 'package.json'),
        $json,
        (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "已创建临时 profile: $ProfileDir" -ForegroundColor Green
    }

    # 2) 装依赖（本地 link，无需联网）
    #    dsh.cmd 会往 stderr 写正常进度，$ErrorActionPreference='Stop' 会把这类
    #    NativeCommandError 当致命错误，所以这一段单独放宽。
    Push-Location $ProfileDir
    $previousEap = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      $installOut = & $DshCli plugin --profile $ProfileName install 2>&1
      $ErrorActionPreference = $previousEap
      $installOut | Select-Object -Last 3
      if ($LASTEXITCODE -ne 0) {
        Write-Host "安装依赖失败 (exit=$LASTEXITCODE)" -ForegroundColor Red
        $installOut | Select-Object -Last 15
        exit 1
      }
    } finally {
      $ErrorActionPreference = $previousEap
      Pop-Location
    }

    # 3) 起一个独立端口的实例
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Remove-Item $LogOut, $LogErr -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $DshCli `
      -ArgumentList @('--profile', $ProfileName, '--no-open', '--port', "$Port") `
      -RedirectStandardOutput $LogOut -RedirectStandardError $LogErr -WindowStyle Hidden | Out-Null

    # 4) 等它打印 token
    $token = $null
    for ($i = 0; $i -lt 60 -and -not $token; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-Path $LogOut) {
        $m = Select-String -Path $LogOut -Pattern 'token=([A-Za-z0-9_\-]+)' | Select-Object -First 1
        if ($m) { $token = $m.Matches[0].Groups[1].Value }
      }
    }

    if (-not $token) {
      Write-Host '启动超时。stderr 末尾：' -ForegroundColor Red
      Get-Content $LogErr -ErrorAction SilentlyContinue | Select-Object -Last 20
      exit 1
    }

    $err = Get-Content $LogErr -ErrorAction SilentlyContinue
    if ($err -match 'did not activate') {
      Write-Host ''; Write-Host '⚠ 有条目激活失败：' -ForegroundColor Red
      $err | Select-Object -Last 20
    } else {
      Write-Host ''; Write-Host '启动正常（无 did not activate 警告）' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host '在浏览器里打开这个地址：' -ForegroundColor Cyan
    Write-Host "  http://127.0.0.1:$Port/?token=$token" -ForegroundColor White
    Write-Host ''
    Write-Host "它和你的 desktop 实例互不影响。用完执行： .\try-it.ps1 clean" -ForegroundColor DarkGray
  }

  'stop' {
    Stop-Server
    Write-Host '已停止。' -ForegroundColor Green
  }

  'clean' {
    Stop-Server
    if (Test-Path $ProfileDir) {
      Remove-Item $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "已删除临时 profile: $ProfileDir" -ForegroundColor Green
    }
    Write-Host '清理完成，desktop 未被触碰。' -ForegroundColor Green
  }
}
