#!/bin/bash
# Smart deploy: only restart PM2 if server.cjs changed
# Frontend builds locally on each pull (frontend/dist/ no longer tracked since 2026-04-26)

cd /opt/blueprint-editor

# Record server.cjs hash before pull
OLD_HASH=$(md5sum server.cjs 2>/dev/null | cut -d' ' -f1)

git stash 2>/dev/null
git pull

NEW_HASH=$(md5sum server.cjs 2>/dev/null | cut -d' ' -f1)

# 反馈 01 (2026-04-26): frontend/dist/ 已从仓库 untrack,每次 pull 后必须本地构建,
# 否则 server.cjs 会找不到 SPA entry。新机部署 / 老机首次拉到本变更后,这步会跑得稍慢。
echo "Building frontend (cd frontend && npm run build)..."
( cd frontend && npm run build ) || { echo "FATAL: frontend build failed, aborting deploy"; exit 1; }

if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "server.cjs changed - restarting PM2..."
  pm2 restart blueprint-editor 2>/dev/null
  echo "PM2 restarted (brief 2-3s loading page may appear)"
else
  echo "Frontend rebuilt - PM2 not restarted (server.cjs unchanged)"
fi

echo "Deploy complete"
