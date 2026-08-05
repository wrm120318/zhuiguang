#!/bin/bash
# tunnel-keeper.sh v5 - 【革命性双隧道并行版】解决用户反馈的"频繁断线无法使用"
# 重大升级：不再单隧道单写！改为同时跑2条独立隧道：
#   主隧道：Cloudflare Quick Tunnel (cloudflared trycloudflare.com) - 官方出品，稳定性>>SSH隧道
#   备隧道：pinggy SSH 免费隧道 - 故障转移
# 写GitHub的tunnel-url.txt格式：一行一个URL，优先放Cloudflare的
# 配合 worker.js v6 同时轮询多URL，500ms级切换

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="wrm120318/zhuiguang"
FILE_PATH="tunnel-url.txt"
PROXY="127.0.0.1:18080"
LOCAL_PORT=3001
LOG="/tmp/tunnel-keeper.log"

PINGGY_SERVERS=(
  "a.pinggy.io"
  "b.pinggy.io"
  "us-east-1.a.pinggy.io"
)
RETRY_DELAY=5
MAX_RETRY_DELAY=120

echo "==========================================" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 双隧道并行版启动" >> "$LOG"
echo "==========================================" >> "$LOG"

# ===== GitHub写入（v5：写多行URL，一行一个，带3次重试）=====
update_github_multi_url() {
  local url_list="$1"   # 多行，每行一个URL，优先的放前面
  if [ -z "$url_list" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ⚠️ 全部隧道失败，写空串兜底" >> "$LOG"
    url_list=""
  fi
  local encoded=$(echo -n "$url_list" | base64 -w0 2>/dev/null || echo -n "$url_list" | base64)
  local max_retries=3

  for attempt in 1 2 3; do
    local sha=$(curl -s -x "http://$PROXY" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)

    local payload=$(python3 -c "import json; import sys; print(json.dumps({'message':'更新隧道URL(v5双隧道)','content':sys.argv[1],'sha':sys.argv[2] if len(sys.argv)>2 else ''}))" "$encoded" "$sha")
    local result=$(curl -s -x "http://$PROXY" -X PUT \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
      -d "$payload" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'content' in d else d.get('message','error'))" 2>/dev/null)

    if [ "$result" = "ok" ]; then
      local count=$(echo "$url_list" | grep -c . || echo 0)
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ✅ GitHub更新成功 (第${attempt}次, 共${count}条URL)" >> "$LOG"
      echo "  URL列表:" >> "$LOG"
      echo "$url_list" | while read -r u; do [ -n "$u" ] && echo "    - $u" >> "$LOG"; done
      return 0
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] GitHub更新失败第${attempt}/3次: $result" >> "$LOG"
    [ $attempt -lt 3 ] && sleep 5
  done
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ❌ GitHub更新彻底失败，写空串兜底" >> "$LOG"
  local empty_encoded=$(echo -n "" | base64 -w0 2>/dev/null || echo -n "" | base64)
  local sha2=$(curl -s -x "http://$PROXY" \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)
  local payload2=$(python3 -c "import json; import sys; print(json.dumps({'message':'隧道断开兜底(v5)','content':sys.argv[1],'sha':sys.argv[2] if len(sys.argv)>2 else ''}))" "$empty_encoded" "$sha2")
  curl -s -x "http://$PROXY" -X PUT \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
    -d "$payload2" 2>/dev/null >/dev/null
  return 1
}

# ===== 单URL健康检测 =====
validate_url() {
  local url="$1"
  local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$url/api/pages/guide" 2>/dev/null)
  if [ "$code" = "200" ]; then
    return 0
  else
    # 二次
    sleep 2
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$url/api/pages/guide" 2>/dev/null)
    [ "$code" = "200" ] && return 0
    return 1
  fi
}

# ===== 启动 Cloudflare Quick Tunnel (主隧道) =====
start_cloudflared_tunnel() {
  local output_file="/tmp/cf_tunnel_$$_$RANDOM"
  local url=""
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 🔵 启动Cloudflare Quick Tunnel (主隧道)" >> "$LOG"
  nohup cloudflared tunnel --url http://localhost:$LOCAL_PORT --no-autoupdate --loglevel warn > "$output_file" 2>&1 &
  local pid=$!

  for i in $(seq 1 30); do
    sleep 1
    url=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$output_file" 2>/dev/null | grep -v "^https://api\.trycloudflare\.com$" | head -1)
    if [ -n "$url" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
  done

  if [ -z "$url" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ❌ Cloudflare隧道失败（未拿到URL）" >> "$LOG"
    kill -9 $pid 2>/dev/null
    rm -f "$output_file"
    return 1
  fi
  # 校验
  if validate_url "$url"; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ✅ Cloudflare隧道建立: $url (PID=$pid, 校验HTTP200通过)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ⚠️ Cloudflare隧道建立但未通过校验，先保留: $url (PID=$pid)" >> "$LOG"
  fi
  echo "$pid" > /tmp/tunnel-cf-pid
  echo "$url" > /tmp/tunnel-cf-url
  rm -f "$output_file"
  export CF_PID=$pid
  export CF_URL=$url
  return 0
}

# ===== 启动 Pinggy SSH 隧道 (备隧道) =====
start_pinggy_tunnel() {
  local server_idx=${1:-0}
  local server="${PINGGY_SERVERS[$server_idx]}"
  local output_file="/tmp/pinggy_$$_$RANDOM"
  local url=""
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 🟡 启动Pinggy备隧道 server=$server" >> "$LOG"
  nohup ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=nc -X connect -x $PROXY %h %p" \
    -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -R0:localhost:$LOCAL_PORT "$server" > "$output_file" 2>&1 &
  local pid=$!

  for i in $(seq 1 20); do
    sleep 1
    url=$(grep -oP 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)' "$output_file" 2>/dev/null | head -1)
    if [ -n "$url" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
  done

  if [ -z "$url" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ❌ Pinggy隧道失败 server=$server" >> "$LOG"
    kill -9 $pid 2>/dev/null
    rm -f "$output_file"
    return 1
  fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ✅ Pinggy备隧道建立: $url (PID=$pid server=$server)" >> "$LOG"
  echo "$pid" > /tmp/tunnel-pg-pid
  echo "$url" > /tmp/tunnel-pg-url
  rm -f "$output_file"
  export PG_PID=$pid
  export PG_URL=$url
  return 0
}

# ===== 本地服务异常容忍 =====
LOCAL_FAIL_LIMIT=3
local_fail_count=0
SERVER_IDX=0

# ===== 主循环 =====
while true; do
  echo "" >> "$LOG"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ============ 新一轮双隧道启动 ============" >> "$LOG"
  CF_URL=""
  PG_URL=""

  # Step A: 启动Cloudflare主隧道
  if start_cloudflared_tunnel; then
    CF_URL=$(cat /tmp/tunnel-cf-url 2>/dev/null)
  else
    CF_URL=""
  fi
  sleep 3

  # Step B: 启动Pinggy备隧道（无论主隧道成败都要）
  PG_TRY_COUNT=0
  while [ $PG_TRY_COUNT -lt 3 ]; do
    if start_pinggy_tunnel $SERVER_IDX; then
      PG_URL=$(cat /tmp/tunnel-pg-url 2>/dev/null)
      break
    fi
    PG_TRY_COUNT=$((PG_TRY_COUNT + 1))
    SERVER_IDX=$(( (SERVER_IDX + 1) % ${#PINGGY_SERVERS[@]} ))
    sleep 3
  done

  # Step C: 组合URL列表（Cloudflare优先）
  URL_LIST=""
  [ -n "$CF_URL" ] && URL_LIST="${CF_URL}"
  [ -n "$PG_URL" ] && URL_LIST="${URL_LIST:+$URL_LIST
}$PG_URL"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 最终可用URL列表: [$(echo "$URL_LIST" | tr '\n' '|' | sed 's/|$//')]" >> "$LOG"

  # Step D: 写GitHub（多行格式）
  update_github_multi_url "$URL_LIST" || true

  # 如果两条都失败，等一会重试
  if [ -z "$CF_URL" ] && [ -z "$PG_URL" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ❌ 两条隧道全部失败，${RETRY_DELAY}秒后整体重试..." >> "$LOG"
    sleep $RETRY_DELAY
    RETRY_DELAY=$(( RETRY_DELAY * 2 ))
    [ $RETRY_DELAY -gt $MAX_RETRY_DELAY ] && RETRY_DELAY=$MAX_RETRY_DELAY
    continue
  fi
  RETRY_DELAY=5
  local_fail_count=0

  # Step E: 监控循环（最长50分钟主动重连双隧道，更保守）
  pid_cf=$(cat /tmp/tunnel-cf-pid 2>/dev/null)
  pid_pg=$(cat /tmp/tunnel-pg-pid 2>/dev/null)
  loop_start=$(date +%s)
  MAX_RUN=$(( 50 * 60 ))

  while true; do
    sleep 20
    # 检测本地服务
    if ! curl -s -o /dev/null --max-time 3 "http://localhost:$LOCAL_PORT/api/pages/guide" 2>/dev/null; then
      local_fail_count=$(( local_fail_count + 1 ))
      if [ $local_fail_count -ge $LOCAL_FAIL_LIMIT ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 本地服务连续异常${LOCAL_FAIL_LIMIT}次，整体重启双隧道" >> "$LOG"
        break
      fi
    else
      local_fail_count=0
    fi

    # 检测隧道进程是否都死了
    cf_alive=0; pg_alive=0
    [ -n "$pid_cf" ] && kill -0 "$pid_cf" 2>/dev/null && cf_alive=1
    [ -n "$pid_pg" ] && kill -0 "$pid_pg" 2>/dev/null && pg_alive=1
    if [ $cf_alive -eq 0 ] && [ $pg_alive -eq 0 ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 两条隧道进程都退出，整体重启" >> "$LOG"
      break
    fi

    # 每5分钟做一次HTTP健康检测，如果某条隧道挂了就立即重写GitHub（把好的URL写上去）
    now=$(date +%s)
    if [ $(( now - loop_start )) -gt 0 ] && [ $(( (now - loop_start) % 300 )) -lt 21 ]; then
      need_rewrite=0
      NEW_LIST=""
      if [ $cf_alive -eq 1 ] && validate_url "$CF_URL"; then
        NEW_LIST="$CF_URL"
      else
        [ -n "$CF_URL" ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ⚠️ Cloudflare主隧道HTTP检测失败" >> "$LOG" && need_rewrite=1
      fi
      if [ $pg_alive -eq 1 ] && validate_url "$PG_URL"; then
        NEW_LIST="${NEW_LIST:+$NEW_LIST
}$PG_URL"
      else
        [ -n "$PG_URL" ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] ⚠️ Pinggy备隧道HTTP检测失败" >> "$LOG" && need_rewrite=1
      fi
      if [ $need_rewrite -eq 1 ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 🔄 5分钟例行检测，有隧道失效，重写GitHub URL列表" >> "$LOG"
        update_github_multi_url "$NEW_LIST" || true
      fi
    fi

    # 50分钟主动整体重连
    elapsed=$(( now - loop_start ))
    if [ $elapsed -ge $MAX_RUN ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5] 50分钟到，主动整体重建双隧道" >> "$LOG"
      break
    fi
  done

  # 清理隧道进程
  kill -9 "$pid_cf" 2>/dev/null
  kill -9 "$pid_pg" 2>/dev/null
  pkill -9 -f "cloudflared tunnel" 2>/dev/null
  sleep 4
done
