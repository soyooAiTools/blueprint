#!/bin/bash
# Smart deploy: only restart PM2 if server.cjs changed
# Frontend-only changes are served immediately without restart

cd /opt/blueprint-editor

# Record server.cjs hash before pull
OLD_HASH=$(md5sum server.cjs 2>/dev/null | cut -d' ' -f1)

git stash 2>/dev/null
git pull

NEW_HASH=$(md5sum server.cjs 2>/dev/null | cut -d' ' -f1)

if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "server.cjs changed - restarting PM2..."
  pm2 restart blueprint-editor 2>/dev/null
  echo "PM2 restarted (brief 2-3s loading page may appear)"
else
  echo "Frontend-only change - no restart needed, changes are live immediately"
fi

echo "Deploy complete"
