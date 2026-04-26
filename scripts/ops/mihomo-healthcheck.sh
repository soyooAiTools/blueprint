#!/bin/bash
# Mihomo 代理健康检查 + 自动恢复
# crontab: */2 * * * * /opt/blueprint-editor/mihomo-healthcheck.sh

LOG="/root/.pm2/logs/mihomo-healthcheck.log"
CLASH_API="http://127.0.0.1:9090"
PROXY="http://127.0.0.1:7890"
TEST_URL="https://api.anthropic.com"

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

# 1. 检查 mihomo 进程是否存活
if ! systemctl is-active --quiet mihomo; then
  echo "$(timestamp) [ALERT] mihomo not running, restarting..." >> "$LOG"
  systemctl restart mihomo
  sleep 3
  if systemctl is-active --quiet mihomo; then
    echo "$(timestamp) [RECOVERED] mihomo restarted successfully" >> "$LOG"
  else
    echo "$(timestamp) [CRITICAL] mihomo failed to start" >> "$LOG"
  fi
  exit 0
fi

# 2. 检查代理是否能连通 Google（2秒超时）
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 5 -x "$PROXY" "$TEST_URL" 2>/dev/null)

if [ "$HTTP_CODE" != "000" ]; then
  exit 0  # 代理正常
fi

echo "$(timestamp) [ALERT] Proxy not reachable (HTTP=$HTTP_CODE), attempting recovery..." >> "$LOG"

# 3. 尝试切换节点（触发 URLTest 延迟测试）
CURRENT=$(curl -s "$CLASH_API/proxies/%E8%89%AF%E5%BF%83%E4%BA%91" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('now',''))" 2>/dev/null)
echo "$(timestamp) Current node in 良心云: $CURRENT" >> "$LOG"

curl -s -X PUT "$CLASH_API/proxies/%E8%89%AF%E5%BF%83%E4%BA%91/delay?timeout=3000&url=https://api.anthropic.com" > /dev/null 2>&1
sleep 2

NEW=$(curl -s "$CLASH_API/proxies/%E8%89%AF%E5%BF%83%E4%BA%91" 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('now',''))" 2>/dev/null)
echo "$(timestamp) After test: node=$NEW" >> "$LOG"

# 4. 再测一次
HTTP_CODE2=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 5 -x "$PROXY" "$TEST_URL" 2>/dev/null)
if [ "$HTTP_CODE2" != "000" ]; then
  echo "$(timestamp) [RECOVERED] Proxy works after node switch ($CURRENT -> $NEW)" >> "$LOG"
  exit 0
fi

# 5. 节点切换没用，重启 mihomo
echo "$(timestamp) [ALERT] Node switch didn't help, restarting mihomo..." >> "$LOG"
systemctl restart mihomo
sleep 5

HTTP_CODE3=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 2 --max-time 5 -x "$PROXY" "$TEST_URL" 2>/dev/null)
if [ "$HTTP_CODE3" != "000" ]; then
  echo "$(timestamp) [RECOVERED] Proxy works after mihomo restart" >> "$LOG"
else
  echo "$(timestamp) [CRITICAL] Proxy still dead after restart. Manual check needed." >> "$LOG"
fi
