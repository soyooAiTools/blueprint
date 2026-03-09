@echo off
REM Worker 部署脚本 — 确保进程唯一、代码最新、环境变量正确
REM 用法: deploy.cmd

echo [DEPLOY] Stopping all worker processes...
pm2 delete worker-client 2>nul
pm2 delete worker-unity 2>nul

echo [DEPLOY] Pulling latest code...
cd /d C:\worker
git pull origin main 2>nul || echo [DEPLOY] Git pull skipped (not a git repo, using SCP deploy)

echo [DEPLOY] Checking .env file...
if not exist C:\worker\.env (
    echo [DEPLOY] ERROR: .env file not found! Copy .env.example to .env and fill in values.
    exit /b 1
)

echo [DEPLOY] Installing dependencies...
call npm install --production 2>nul

echo [DEPLOY] Starting worker-unity via ecosystem.config.cjs...
pm2 start C:\worker\ecosystem.config.cjs --only worker-unity
pm2 save

echo [DEPLOY] Verifying...
timeout /t 3 /nobreak >nul
pm2 list

echo [DEPLOY] Done!
