#!/bin/bash
# deploy-ecs.sh — 一键部署 Blueprint 到 ECS
# 放在 ECS /root/blueprint/scripts/ 下，也可从本地 SSH 调用
# 用法：
#   本地: sshpass -p 'Soyoo2026!Ecs' ssh root@120.55.70.226 'bash /root/blueprint/scripts/deploy-ecs.sh'
#   ECS上: bash /root/blueprint/scripts/deploy-ecs.sh

set -e

BLUEPRINT_DIR="/opt/blueprint-editor"
PM2_NAME="blueprint-editor"

echo "=== Blueprint Deploy $(date '+%Y-%m-%d %H:%M:%S') ==="

cd "$BLUEPRINT_DIR"

# 1. Git pull
echo "[1/4] Git pull..."
git stash 2>/dev/null || true
git pull --ff-only
echo "    ✅ $(git log --oneline -1)"

# 2. Install deps if needed
if [ package.json -nt node_modules/.package-lock.json ] 2>/dev/null; then
  echo "[2/4] npm install..."
  npm install --production
else
  echo "[2/4] npm install... (skipped, up to date)"
fi

# 3. PM2 restart
echo "[3/4] PM2 restart..."
pm2 restart "$PM2_NAME" 2>/dev/null || pm2 start server.cjs --name "$PM2_NAME"

# 4. Verify
echo "[4/4] Verify..."
sleep 1
pm2 show "$PM2_NAME" | grep -E "status|uptime|restarts"

echo ""
echo "=== Deploy Complete ✅ ==="
