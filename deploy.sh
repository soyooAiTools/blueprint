#!/bin/bash
set -e
cd /opt/blueprint-editor

echo '=== Blueprint Deploy ==='
echo "[1/4] Git pull..."
git pull origin main 2>&1 || echo 'WARN: git pull failed, continuing with local files'

echo "[2/4] Validating .env..."
source .env
EXPECTED_MODEL="gemini-3.1-pro-preview"
if [ "$GEMINI_MODEL" != "$EXPECTED_MODEL" ]; then
  echo "❌ FATAL: .env GEMINI_MODEL='$GEMINI_MODEL', expected '$EXPECTED_MODEL'"
  echo "Fix .env before deploying!"
  exit 1
fi
if [ -z "$GEMINI_API_KEY" ]; then
  echo "❌ FATAL: GEMINI_API_KEY is empty in .env"
  exit 1
fi
echo "  GEMINI_MODEL=$GEMINI_MODEL ✅"
echo "  GEMINI_API_KEY=${GEMINI_API_KEY:0:10}... ✅"

echo "[3/4] Restarting PM2 (--update-env)..."
pm2 restart blueprint --update-env 2>&1

echo "[4/4] Verifying..."
sleep 3
RUNNING_MODEL=$(pm2 env 38 2>&1 | grep GEMINI_MODEL | head -1 | awk '{print $2}')
RUNNING_KEY=$(pm2 env 38 2>&1 | grep GEMINI_API_KEY | head -1 | awk '{print $2}')
echo "  Running GEMINI_MODEL=$RUNNING_MODEL"
echo "  Running GEMINI_API_KEY=${RUNNING_KEY:0:10}..."

if [ "$RUNNING_MODEL" != "$EXPECTED_MODEL" ]; then
  echo "⚠️ WARNING: PM2 env doesn't match .env! May need: pm2 delete blueprint && pm2 start server.cjs --name blueprint"
fi

echo '=== Deploy Complete ==='
