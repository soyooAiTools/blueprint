#!/bin/bash
# Blueprint 健康检查 — 建议加入 crontab: */5 * * * * /opt/blueprint/healthcheck.sh
# 检查服务是否正常响应，不正常则自动恢复

PORT=3901
URL="http://localhost:${PORT}/api/projects"
LOG="/root/.pm2/logs/blueprint-healthcheck.log"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# 1. HTTP 健康检查
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null)

if [ "$HTTP_CODE" = "200" ]; then
  exit 0  # 一切正常
fi

echo "$(timestamp) [ALERT] HTTP check failed (code=$HTTP_CODE), attempting recovery..." >> "$LOG"

# 2. 检查 PM2 进程状态
PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); print(next((a['pm2_env']['status'] for a in apps if a['name']=='blueprint'), 'missing'))" 2>/dev/null)

echo "$(timestamp) PM2 status: $PM2_STATUS" >> "$LOG"

# 3. 杀掉占端口的孤儿进程
ORPHAN_PID=$(ss -tlnp sport = :${PORT} 2>/dev/null | grep -oP 'pid=\K\d+' | head -1)
if [ -n "$ORPHAN_PID" ]; then
  # 检查是否是 PM2 管理的
  PM2_PID=$(pm2 jlist 2>/dev/null | python3 -c "import sys,json; apps=json.load(sys.stdin); print(next((a['pid'] for a in apps if a['name']=='blueprint'), 0))" 2>/dev/null)
  
  if [ "$ORPHAN_PID" != "$PM2_PID" ]; then
    echo "$(timestamp) Killing orphan PID $ORPHAN_PID (PM2 PID is $PM2_PID)" >> "$LOG"
    kill "$ORPHAN_PID" 2>/dev/null
    sleep 2
    kill -9 "$ORPHAN_PID" 2>/dev/null
    sleep 1
  fi
fi

# 4. 重启 PM2 进程
echo "$(timestamp) Restarting blueprint via PM2..." >> "$LOG"
pm2 restart blueprint 2>> "$LOG"
sleep 3

# 5. 验证恢复
HTTP_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null)
if [ "$HTTP_CODE2" = "200" ]; then
  echo "$(timestamp) [RECOVERED] Service restored successfully" >> "$LOG"
else
  echo "$(timestamp) [CRITICAL] Recovery failed! HTTP=$HTTP_CODE2. Manual intervention needed." >> "$LOG"
fi
