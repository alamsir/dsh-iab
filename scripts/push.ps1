param(
    [string]$Owner = 'alamsir',
    [string]$Repo  = 'dsh-iab',
    [switch]$Check
)

# Push dsh-iab to GitHub.
#
# Run this AFTER you have:
#   1. Added the public key (PUBLISH.md section 1) to GitHub > Settings > SSH and GPG keys
#   2. Created the EMPTY repo alamsir/dsh-iab at https://github.com/new
#      (no README, no .gitignore, no license - an initialized repo rejects this push)
#
#   .\scripts\push.ps1              # push to alamsir/dsh-iab
#   .\scripts\push.ps1 -Check       # only verify SSH auth, change nothing

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host 'Checking GitHub SSH authentication...' -ForegroundColor Cyan
    # "ssh -T git@github.com" answers "successfully authenticated" on success but
    # always exits non-zero, so the message - not the exit code - is the signal.
    $probe = (cmd /c 'ssh -o ConnectTimeout=15 -T git@github.com 2>&1' | Out-String)
    if ($probe -match 'successfully authenticated') {
        Write-Host 'OK - the key is accepted by GitHub.' -ForegroundColor Green
    }
    elseif ($probe -match 'Permission denied') {
        Write-Host 'FAIL - GitHub rejected the key.' -ForegroundColor Red
        Write-Host 'Add the line below to https://github.com/settings/ssh/new, then retry:'
        Write-Host ''
        Get-Content (Join-Path $env:USERPROFILE '.ssh\id_ed25519.pub')
        exit 1
    }
    else {
        Write-Host 'FAIL - unexpected answer from GitHub:' -ForegroundColor Red
        Write-Host $probe
        exit 1
    }

    if ($Check) {
        Write-Host 'Check-only mode: not pushing.' -ForegroundColor Yellow
        exit 0
    }

    $url = "git@github.com:$Owner/$Repo.git"
    # `git remote get-url` writes to stderr when origin is missing, and with
    # $ErrorActionPreference = 'Stop' that aborts the script. Probe the config
    # instead — it fails silently.
    $hasRemote = $false
    git config --get remote.origin.url *> $null
    if ($LASTEXITCODE -eq 0) { $hasRemote = $true }
    if ($hasRemote) {
        git remote set-url origin $url
    }
    else {
        git remote add origin $url
    }
    Write-Host "Pushing to $url ..." -ForegroundColor Cyan
    git push -u origin main
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Push failed. The usual cause is a repo created WITH a README or' -ForegroundColor Red
        Write-Host 'license, so its history conflicts. Recreate it empty, or run:' -ForegroundColor Red
        Write-Host '  git pull --rebase origin main --allow-unrelated-histories'
        exit 1
    }

    Write-Host ''
    Write-Host "Done: https://github.com/$Owner/$Repo" -ForegroundColor Green
    Write-Host 'Next: add the dsh-plugin topic (repo page > About gear > Topics).'
}
finally {
    Pop-Location
}
