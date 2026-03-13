# push-and-deploy.ps1
# 用法: .\scripts\push-and-deploy.ps1 [commit message]
# 自动: git add + commit + push + deploy to Worker ECS

param([string]$msg = "update worker code")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$env:https_proxy = "http://127.0.0.1:7890"

Write-Host "=== Git add + commit ===" -ForegroundColor Cyan
git add -A
git commit -m $msg 2>&1 | Out-Host

Write-Host "`n=== Git push ===" -ForegroundColor Cyan
git push origin main 2>&1 | Out-Host

Write-Host "`n=== Deploy to Worker ECS ===" -ForegroundColor Cyan
node scripts/deploy-to-worker.js

Write-Host "`n=== ALL DONE ===" -ForegroundColor Green
