#!/bin/bash
# tunnel-keeper.sh v3 - 升级版隧道守护
# 特性：多服务器故障转移、指数退避、健康检查、自动更新GitHub URL
# 用法：bash tunnel-keeper.sh

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="wrm120318/zhuiguang"
FILE_PATH="tunnel-url.txt"
PROXY="127.0.0.1:18080"
LOCAL_PORT=3001
LOG="/tmp/tunnel-keeper.log"

# 多个 pinggy 服务器（故障转移）
PINGGY_SERVERS=(
  "a.pinggy.io"
  "b.pinggy.io"
  "us-east-1.a.pinggy.io"
  "us-west-2.a.pinggy.io"
  "eu-west-1.a.pinggy.io"
)

# 重试间隔（秒），指数退避
RETRY_DELAY=5
MAX_RETRY_DELAY=120

echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] v3 启动" >> "$LOG"

update_github_url() {
  local url="$1"
  local encoded=$(echo -n "$url" | base64)

  # 获取当前文件 SHA
  local sha=$(curl -s -x "http://$PROXY" \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)

  local payload=$(python3 -c "import json; print(json.dumps({'message':'更新隧道URL','content':'$encoded','sha':'$sha'}))")
  local result=$(curl -s -x "http://$PROXY" -X PUT \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
    -d "$payload" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'content' in d else d.get('message','error'))" 2>/dev/null)

  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] GitHub更新: $result (URL: $url)" >> "$LOG"
}

start_tunnel() {
  local server_idx=${1:-0}
  local server="${PINGGY_SERVERS[$server_idx]}"
  local output_file="/tmp/pinggy_$$_$RANDOM"

  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 尝试服务器: $server" >> "$LOG"

  nohup ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=nc -X connect -x $PROXY %h %p" \
    -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -R0:localhost:$LOCAL_PORT "$server" > "$output_file" 2>&1 &
  local pid=$!

  # 等待 URL（最多 20 秒）
  local url=""
  for i in $(seq 1 20); do
    sleep 1
    url=$(grep -oP 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)' "$output_file" 2>/dev/null | head -1)
    if [ -n "$url" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
  done

  if [ -z "$url" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 服务器 $server 失败" >> "$LOG"
    kill "$pid" 2>/dev/null
    rm -f "$output_file"
    return 1
  fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 隧道已建立: $url (PID: $pid, 服务器: $server)" >> "$LOG"
  update_github_url "$url"
  echo "$pid" > "/tmp/tunnel-pid"
  echo "$url" > "/tmp/tunnel-url-current"
  echo "$server" > "/tmp/tunnel-server"
  return 0
}

# 本地服务异常容忍次数（避免后端刚启动时短暂不可达误杀隧道）
LOCAL_FAIL_LIMIT=3
local_fail_count=0

# 主循环
SERVER_IDX=0
while true; do
  if ! start_tunnel $SERVER_IDX; then
    # 重置本地服务失败计数
    local_fail_count=0
    # 故障转移到下一个服务器
    SERVER_IDX=$(( (SERVER_IDX + 1) % ${#PINGGY_SERVERS[@]} ))
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 切换到服务器 $SERVER_IDX，${RETRY_DELAY}秒后重试..." >> "$LOG"
    sleep $RETRY_DELAY
    # 指数退避
    RETRY_DELAY=$(( RETRY_DELAY * 2 ))
    [ $RETRY_DELAY -gt $MAX_RETRY_DELAY ] && RETRY_DELAY=$MAX_RETRY_DELAY
    continue
  fi

  # 重置重试间隔
  RETRY_DELAY=5

  # 读取 PID
  pid=$(cat /tmp/tunnel-pid 2>/dev/null)
  if [ -z "$pid" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 无法读取PID，重启..." >> "$LOG"
    sleep 5
    continue
  fi

  # 监控（最长 55 分钟主动重连，避免 pinggy 60 分钟过期）
  local_start=$(date +%s)
  while true; do
    sleep 20
    # 检查隧道进程
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 隧道进程退出，重启..." >> "$LOG"
      break
    fi
    # 检查本地服务是否存活（连续失败3次才重启隧道，避免误杀）
    if ! curl -s -o /dev/null --max-time 3 "http://localhost:$LOCAL_PORT/api/pages/guide" 2>/dev/null; then
      local_fail_count=$(( local_fail_count + 1 ))
      if [ $local_fail_count -ge $LOCAL_FAIL_LIMIT ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 本地服务连续异常${LOCAL_FAIL_LIMIT}次，重启隧道..." >> "$LOG"
        local_fail_count=0
        break
      else
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 本地服务异常($local_fail_count/$LOCAL_FAIL_LIMIT)，继续观察..." >> "$LOG"
      fi
    else
      local_fail_count=0
    fi
    # 55 分钟主动重连
    local_now=$(date +%s)
    local_elapsed=$((local_now - local_start))
    if [ $local_elapsed -ge 3300 ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper] 55分钟到，主动重连..." >> "$LOG"
      break
    fi
  done

  kill "$pid" 2>/dev/null
  sleep 3
done
