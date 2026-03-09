@echo off
REM ============================================================
REM  Worker Deploy Script — D:\worker-repo
REM  用法: D:\worker-repo\worker\deploy.cmd
REM  功能: git pull + npm install + pm2 唯一进程重启
REM ============================================================

echo [DEPLOY] Stopping all workers...
pm2 delete worker-client 2>nul
pm2 delete worker-unity 2>nul

echo [DEPLOY] Pulling latest code...
set PATH=%PATH%;C:\Program Files\Git\cmd
cd /d D:\worker-repo
git pull origin main

echo [DEPLOY] Installing dependencies...
cd /d D:\worker-repo\worker
npm install --production

echo [DEPLOY] Checking .env file...
if not exist D:\worker-repo\worker\.env (
    echo [DEPLOY] ERROR: .env not found! Copy .env.example to .env and fill in values.
    exit /b 1
)

echo [DEPLOY] Starting worker-unity...
pm2 start D:\worker-repo\worker\ecosystem.config.cjs --only worker-unity
pm2 save

echo [DEPLOY] Verifying...
timeout /t 3 /nobreak >nul
pm2 list

echo [DEPLOY] Done!
