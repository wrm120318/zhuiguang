#!/bin/bash
# cloudflared-keeper.sh - 持久维持 cloudflared 隧道
# cloudflared 比 pinggy 稳定得多，不会随意断开

CONFIG_DIR="$HOME/.cloudflared"
LOG="/tmp/cloudflared-keeper.log"
LOCAL_PORT=3001

echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] cloudflared 守护启动" >> "$LOG"

# 确保旧的 cloudflared 进程被清理
pkill -f cloudflared 2>/dev/null
sleep 2

while true; do
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 启动 cloudflared 隧道..." >> "$LOG"
  
  cloudflared tunnel run --config "$CONFIG_DIR/config.yml" --logfile "$LOG" 2>&1 &
  PID=$!
  
  # 等待隧道就绪（最多 30 秒）
  READY=0
  for i in $(seq 1 30); do
    sleep 1
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] cloudflared 进程秒退，重试..." >> "$LOG"
      break
    fi
    # 检查日志是否显示连接成功
    if grep -q "Connection established\|Registered connection\|cloudflared.*is running" "$LOG" 2>/dev/null; then
      READY=1
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 隧道已就绪 (PID: $PID)" >> "$LOG"
      break
    fi
  done
  
  if [ $READY -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 隧道启动超时，杀掉重试..." >> "$LOG"
    kill "$PID" 2>/dev/null
    sleep 5
    continue
  fi
  
  # 监控进程，挂了就重启
  while kill -0 "$PID" 2>/dev/null; do
    sleep 30
    # 检查本地服务是否存活
    if ! curl -s -o /dev/null "http://localhost:$LOCAL_PORT/api/pages/guide" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 本地服务异常，重启隧道..." >> "$LOG"
      break
    fi
  done
  
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] cloudflared 退出，重启中..." >> "$LOG"
  kill "$PID" 2>/dev/null
  sleep 3
done
