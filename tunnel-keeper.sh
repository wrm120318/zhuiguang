#!/bin/bash
# tunnel-keeper.sh v5.1 - 【双SSH隧道并行版】解决cloudflared quick tunnel在代理环境无法获取URL的问题
# 修正：cloudflared --url quick tunnel 需要直连Cloudflare边缘节点，本环境必须走18080代理，用不了
# 改为：2条独立SSH免费隧道并行（Pinggy池 + localhost.run池），互不影响
# 每条隧道各有3台服务器，单隧道断线最多5秒切换
# 配合 worker.js v6 多URL自动轮询+健康评分

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="wrm120318/zhuiguang"
FILE_PATH="tunnel-url.txt"
PROXY="127.0.0.1:18080"
LOCAL_PORT=3001
LOG="/tmp/tunnel-keeper.log"

# 主隧道池：Pinggy 5台服务器（全球节点分散）
PINGGY_SERVERS=(
  "a.pinggy.io"
  "b.pinggy.io"
  "us-east-1.a.pinggy.io"
  "us-west-2.a.pinggy.io"
  "eu-west-1.a.pinggy.io"
)
# 备隧道池：localhost.run / serveo 免费SSH隧道（和Pinggy不同服务商，物理独立）
BACKUP_SERVERS=(
  "nokey@localhost.run"     # 服务商A：localhost.run
  "serveo.net"              # 服务商B：Serveo（不同基础设施）
)
RETRY_DELAY=5
MAX_RETRY_DELAY=120

echo "==========================================" >> "$LOG"
echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 双SSH隧道并行版启动（Pinggy主 + localhost.run/Serveo备）" >> "$LOG"
echo "==========================================" >> "$LOG"

# ===== GitHub写入（多行URL，一行一个，带3次重试）=====
update_github_multi_url() {
  local url_list="$1"
  if [ -z "$url_list" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ⚠️ 全部隧道失败，写空串兜底" >> "$LOG"
    url_list=""
  fi
  local encoded=$(echo -n "$url_list" | base64 -w0 2>/dev/null || echo -n "$url_list" | base64)
  for attempt in 1 2 3; do
    local sha=$(curl -s -x "http://$PROXY" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)
    local payload=$(python3 -c "import json,sys; print(json.dumps({'message':'更新隧道URL(v5.1双SSH)','content':sys.argv[1],'sha':sys.argv[2] if len(sys.argv)>2 else ''}))" "$encoded" "$sha")
    local result=$(curl -s -x "http://$PROXY" -X PUT \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
      -d "$payload" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'content' in d else d.get('message','error'))" 2>/dev/null)
    if [ "$result" = "ok" ]; then
      local count=$(echo "$url_list" | grep -c . || echo 0)
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ✅ GitHub更新成功 (第${attempt}次, 共${count}条URL)" >> "$LOG"
      echo "$url_list" | while read -r u; do [ -n "$u" ] && echo "    - $u" >> "$LOG"; done
      return 0
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] GitHub更新失败第${attempt}/3次: $result" >> "$LOG"
    [ $attempt -lt 3 ] && sleep 5
  done
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ❌ GitHub更新彻底失败，写空串兜底" >> "$LOG"
  local empty_encoded=$(echo -n "" | base64 -w0 2>/dev/null || echo -n "" | base64)
  local sha2=$(curl -s -x "http://$PROXY" \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)
  local payload2=$(python3 -c "import json,sys; print(json.dumps({'message':'隧道断开兜底(v5.1)','content':sys.argv[1],'sha':sys.argv[2] if len(sys.argv)>2 else ''}))" "$empty_encoded" "$sha2")
  curl -s -x "http://$PROXY" -X PUT \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
    -d "$payload2" 2>/dev/null >/dev/null
  return 1
}

# ===== URL健康检测 =====
validate_url() {
  local url="$1"
  local code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$url/api/pages/guide" 2>/dev/null)
  [ "$code" = "200" ] && return 0
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$url/api/pages/guide" 2>/dev/null)
  [ "$code" = "200" ] && return 0
  return 1
}

# ===== 启动 SSH 隧道（通用函数）=====
# 参数: $1=连接字符串(server[:port] 或 user@server) $2=标识(PINGGY/BACKUP) $3=正则提取URL
start_ssh_tunnel() {
  local conn="$1"
  local label="$2"
  local regex="$3"
  local output_file="/tmp/ssh_${label}_$$_$RANDOM"
  local url=""
  # 支持 user@server 和 纯server两种格式；port默认443
  local user=""
  local server="$conn"
  local port=443
  if echo "$conn" | grep -q "@"; then
    user=$(echo "$conn" | cut -d@ -f1)
    server=$(echo "$conn" | cut -d@ -f2)
  fi
  # Serveo特殊：默认22端口，不用443
  if echo "$server" | grep -q "serveo\.net"; then port=22; fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 🟢 启动${label}隧道 $user@$server:$port" >> "$LOG"
  # localhost.run特殊：需加 --no-inject-http-proxy-headers
  local extra_opt=""
  echo "$server" | grep -q "localhost\.run" && extra_opt="-o StrictHostKeyChecking=no"

  nohup ssh -p $port -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=nc -X connect -x $PROXY %h %p" \
    -o ConnectTimeout=15 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    $([ -n "$user" ] && echo "$user@")$server \
    -R0:localhost:$LOCAL_PORT $extra_opt > "$output_file" 2>&1 &
  local pid=$!

  for i in $(seq 1 22); do
    sleep 1
    url=$(grep -oP "$regex" "$output_file" 2>/dev/null | head -1)
    if [ -n "$url" ]; then break; fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
  done

  if [ -z "$url" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ❌ ${label}隧道失败 server=$server (未拿到URL)" >> "$LOG"
    kill -9 $pid 2>/dev/null
    rm -f "$output_file"
    return 1
  fi
  # 健康检测
  if validate_url "$url"; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ✅ ${label}隧道建立: $url (PID=$pid, HTTP200校验通过)" >> "$LOG"
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ⚠️ ${label}隧道建立但未通过校验，保留: $url (PID=$pid)" >> "$LOG"
  fi
  # 存到对应临时文件
  echo "$pid" > "/tmp/tunnel-${label}-pid"
  echo "$url" > "/tmp/tunnel-${label}-url"
  rm -f "$output_file"
  export URL_${label}="$url"
  export PID_${label}="$pid"
  return 0
}

# ===== 主循环 =====
LOCAL_FAIL_LIMIT=3
local_fail_count=0
IDX_PINGGY=0
IDX_BACKUP=0

while true; do
  echo "" >> "$LOG"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ============ 新一轮双隧道启动 ============" >> "$LOG"
  URL_PRIMARY=""   # Pinggy主隧道URL
  URL_BACKUP=""    # localhost.run/Serveo备隧道URL

  # ① 启动Pinggy主隧道（最多重试3次不同服务器）
  for t in 1 2 3; do
    if start_ssh_tunnel "${PINGGY_SERVERS[$IDX_PINGGY]}" "PINGGY" 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)'; then
      URL_PRIMARY=$(cat /tmp/tunnel-PINGGY-url 2>/dev/null)
      break
    fi
    IDX_PINGGY=$(( (IDX_PINGGY + 1) % ${#PINGGY_SERVERS[@]} ))
    sleep 3
  done
  sleep 2

  # ② 启动Backup备隧道（localhost.run / serveo）
  for t in 1 2 3; do
    BK="${BACKUP_SERVERS[$IDX_BACKUP]}"
    REGEX='https://[a-zA-Z0-9-]+\.(lhr\.life|serveo\.net|ssh\.localtunnel\.me)'
    # localhost.run的URL特征：*.lhr.life
    echo "$BK" | grep -q "localhost\.run" && REGEX='https://[a-zA-Z0-9-]+\.lhr\.life'
    # serveo的URL特征：*.serveo.net
    echo "$BK" | grep -q "serveo\.net" && REGEX='https://[a-zA-Z0-9-]+\.serveo\.net'
    if start_ssh_tunnel "$BK" "BACKUP" "$REGEX"; then
      URL_BACKUP=$(cat /tmp/tunnel-BACKUP-url 2>/dev/null)
      break
    fi
    IDX_BACKUP=$(( (IDX_BACKUP + 1) % ${#BACKUP_SERVERS[@]} ))
    sleep 3
  done

  # ③ 组合URL列表（主隧道在前）
  URL_LIST=""
  [ -n "$URL_PRIMARY" ] && URL_LIST="$URL_PRIMARY"
  [ -n "$URL_BACKUP" ] && URL_LIST="${URL_LIST:+$URL_LIST
}$URL_BACKUP"
  echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 最终可用URL列表: [$(echo "$URL_LIST" | tr '\n' '|' | sed 's/|$//')]" >> "$LOG"

  # ④ 写GitHub
  update_github_multi_url "$URL_LIST" || true

  # ⑤ 都失败就整体等并重试
  if [ -z "$URL_PRIMARY" ] && [ -z "$URL_BACKUP" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ❌ 两条隧道全部失败，${RETRY_DELAY}秒后重试..." >> "$LOG"
    sleep $RETRY_DELAY
    RETRY_DELAY=$(( RETRY_DELAY * 2 ))
    [ $RETRY_DELAY -gt $MAX_RETRY_DELAY ] && RETRY_DELAY=$MAX_RETRY_DELAY
    continue
  fi
  RETRY_DELAY=5
  local_fail_count=0

  # ⑥ 监控循环（40分钟主动重建，更保守，避免60分钟pinggy强制断档）
  pid_pri=$(cat /tmp/tunnel-PINGGY-pid 2>/dev/null)
  pid_bak=$(cat /tmp/tunnel-BACKUP-pid 2>/dev/null)
  loop_start=$(date +%s)
  MAX_RUN=$(( 40 * 60 ))

  while true; do
    sleep 20
    # 本地服务检测
    if ! curl -s -o /dev/null --max-time 3 "http://localhost:$LOCAL_PORT/api/pages/guide" 2>/dev/null; then
      local_fail_count=$(( local_fail_count + 1 ))
      if [ $local_fail_count -ge $LOCAL_FAIL_LIMIT ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 本地服务连续异常${LOCAL_FAIL_LIMIT}次，整体重启" >> "$LOG"
        break
      fi
    else
      local_fail_count=0
    fi
    # 隧道进程存活检测（都死了才重建，只死一个就HTTP重写URL）
    pri_alive=0; bak_alive=0
    [ -n "$pid_pri" ] && kill -0 "$pid_pri" 2>/dev/null && pri_alive=1
    [ -n "$pid_bak" ] && kill -0 "$pid_bak" 2>/dev/null && bak_alive=1
    if [ $pri_alive -eq 0 ] && [ $bak_alive -eq 0 ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 两条隧道进程都退出，整体重建" >> "$LOG"
      break
    fi
    # 每4分钟做一次HTTP健康检测，任何一条挂了就立即重写GitHub（只写健康的）
    now=$(date +%s)
    if [ $(( now - loop_start )) -gt 0 ] && [ $(( (now - loop_start) % 240 )) -lt 21 ]; then
      need=0
      NEW=""
      if [ $pri_alive -eq 1 ] && validate_url "$URL_PRIMARY"; then
        NEW="$URL_PRIMARY"
      else
        [ -n "$URL_PRIMARY" ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ⚠️ Pinggy主隧道HTTP失败，从候选中移除" >> "$LOG" && need=1
      fi
      if [ $bak_alive -eq 1 ] && validate_url "$URL_BACKUP"; then
        NEW="${NEW:+$NEW
}$URL_BACKUP"
      else
        [ -n "$URL_BACKUP" ] && echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] ⚠️ Backup备隧道HTTP失败，从候选中移除" >> "$LOG" && need=1
      fi
      if [ $need -eq 1 ]; then
        echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 🔄 4分钟例行检测发现隧道失效，重写GitHub候选列表" >> "$LOG"
        update_github_multi_url "$NEW" || true
      fi
    fi
    # 40分钟主动整体重建
    elapsed=$(( now - loop_start ))
    if [ $elapsed -ge $MAX_RUN ]; then
      echo "$(date '+%Y-%m-%d %H:%M:%S') [keeper-v5.1] 40分钟到，主动整体重建双隧道（避免60分钟强制断档）" >> "$LOG"
      break
    fi
  done

  # 清理
  kill -9 "$pid_pri" 2>/dev/null
  kill -9 "$pid_bak" 2>/dev/null
  pkill -9 -f "ssh.*pinggy\.io" 2>/dev/null
  pkill -9 -f "ssh.*localhost\.run" 2>/dev/null
  pkill -9 -f "ssh.*serveo\.net" 2>/dev/null
  sleep 4
done
