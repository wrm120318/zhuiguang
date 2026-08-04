#!/bin/bash
# keep-alive.sh - 自托管保活脚本
# 每5分钟通过代理 ping 隧道URL，防止服务空闲
# 同时检查本地服务健康，异常时记录日志

PROXY="http://127.0.0.1:18080"
LOCAL_PORT=3001
LOG="/tmp/keep-alive.log"
INTERVAL=300  # 5分钟

echo "$(date '+%Y-%m-%d %H:%M:%S') [keepalive] 启动 (间隔: ${INTERVAL}s)" >> "$LOG"

while true; do
  # 1. 检查本地服务
  local_ok=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://localhost:$LOCAL_PORT/api/pages/guide" 2>/dev/null)

  if [ "$local_ok" != "200" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keepalive] 本地服务异常 (HTTP: $local_ok)" >> "$LOG"
  fi

  # 2. 读取当前隧道URL并 ping
  TUNNEL_URL=$(cat /tmp/tunnel-url-current 2>/dev/null)
  if [ -n "$TUNNEL_URL" ]; then
    tunnel_ok=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 -x "$PROXY" "$TUNNEL_URL/api/pages/guide" 2>/dev/null)
    if [ "$tunnel_ok" != "200" ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keepalive] 隧道异常 (HTTP: $tunnel_ok, URL: $TUNNEL_URL)" >> "$LOG"
    else
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keepalive] OK (local: $local_ok, tunnel: $tunnel_ok)" >> "$LOG"
    fi
  fi

  sleep $INTERVAL
done
