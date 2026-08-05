#!/bin/bash
set +e
cd /workspace
[ -f .env ] && export $(grep -v '^#' .env | xargs)
INTERVAL=300
echo "[$(date '+%Y-%m-%d %H:%M:%S')] health守护循环启动，每${INTERVAL}秒检查一次" >> /tmp/health-loop.log
while true; do
  /bin/bash /workspace/health-check.sh >> /tmp/health-check.log 2>&1
  sleep $INTERVAL
done
