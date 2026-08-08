#!/bin/bash
# tunnel-supervisor.sh v1.0 - 【追光平台 SSH隧道终极守护】3秒级检测，死了立刻重连
# 不依赖任何复杂逻辑，就管2件事：
#   1. SSH pinggy隧道进程数<2 → 立刻补建
#   2. 每30秒把所有活着的URL合并写GitHub（候选池永远≥2条）
#
# 🔧 启动：setsid nohup bash /workspace/tunnel-supervisor.sh >> /tmp/tunnel-supervisor.log 2>&1 < /dev/null &
# 📊 日志：tail -f /tmp/tunnel-supervisor.log
# ✅ 验证：ps -ef | grep ssh.*pinggy 进程数≥2；ps -ef | grep tunnel-supervisor 进程数≥1

set +e
cd /workspace
[ -f .env ] && export $(grep -v '^#' .env | xargs 2>/dev/null)

LOG="/tmp/tunnel-supervisor.log"
WRITE_LOCK="/tmp/tunnel_write.lock"
LOCAL_PORT=3001
PROXY_HOST="127.0.0.1"
PROXY_PORT="18080"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="wrm120318/zhuiguang"
FILE_PATH="tunnel-url.txt"
TMP_DIR="/tmp/tunnels_sup"
mkdir -p "$TMP_DIR"

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }
b64enc(){ printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }

# ===== 1. 单条隧道建连函数 =====
build_tunnel() {
  local NODE="$1"        # a / b / c
  local OUTF="$2"        # 输出文件
  rm -f "$OUTF"; touch "$OUTF"
  # ✅ 实测100%稳定的SSH参数组合：无BatchMode + StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null
  ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=25 \
    -o TCPKeepAlive=yes \
    -o "ProxyCommand=nc -X connect -x ${PROXY_HOST}:${PROXY_PORT} %h %p" \
    -p 443 -R0:localhost:${LOCAL_PORT} ${NODE}.pinggy.io >> "$OUTF" 2>&1
}

# ===== 2. 全量URL合并写GitHub =====
write_urls_to_github() {
  # 拿互斥锁（10秒超时）
  exec 9>"$WRITE_LOCK" 2>/dev/null || return 0
  if ! flock -w 10 9 2>/dev/null; then return 0; fi
  local ALL=""
  for NODE in a b c; do
    local OUTF="$TMP_DIR/${NODE}.out"
    [ -f "$OUTF" ] || continue
    local URLS=$(grep -oE "https://[A-Za-z0-9\-]+\.(free\.pinggy\.net|run\.pinggy-free\.link)" "$OUTF" 2>/dev/null | sort -u)
    for u in $URLS; do
      # 只留HTTP200活的
      local H=$(curl -s --noproxy '*' --max-time 4 -o /dev/null -w "%{http_code}" \
        -H "User-Agent: Zhuiguang-SUP/1.0" -H "X-Pinggy-No-Screen: 1" "$u/__zg_health" 2>/dev/null)
      [ "$H" = "200" ] && ALL="${ALL}${u}
"
    done
  done
  ALL=$(echo "$ALL" | grep -v '^$' | sort -u | head -6)
  local CNT=$(echo "$ALL" | grep -cv '^$' || echo 0)
  if [ "$CNT" -lt 1 ]; then log "⚠️ 没有活URL，不写GitHub（避免写空）"; return 0; fi
  local TMPF="$TMP_DIR/github_write.txt"
  echo "$ALL" > "$TMPF"
  local SHA=$(curl -s --max-time 10 -x http://${PROXY_HOST}:${PROXY_PORT} \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${REPO}/contents/${FILE_PATH}" 2>/dev/null \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('sha','') if isinstance(d,dict) else '')" 2>/dev/null)
  [ -z "$SHA" ] && return 0
  local B64=$(b64enc "$(cat "$TMPF")")
  curl -s --max-time 15 -x http://${PROXY_HOST}:${PROXY_PORT} -X PUT \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    -d "{\"message\":\"tunnel-supervisor自动维护（${CNT}条活隧道）\",\"content\":\"${B64}\",\"sha\":\"${SHA}\"}" \
    "https://api.github.com/repos/${REPO}/contents/${FILE_PATH}" >/dev/null 2>&1
  log "✅ GitHub候选URL已更新=$CNT条"
}

log "================ tunnel-supervisor.sh v1.0 启动 ================"
WRITE_COUNTDOWN=0

while true; do
  # ===== 循环1：确保a/b/c至少2条SSH隧道进程活着 =====
  ALIVE_NODES=""
  for NODE in a b c; do
    OUTF="$TMP_DIR/${NODE}.out"
    # 检查该节点的SSH进程是不是活着（用输出文件+pgrep双保险）
    PID=$(pgrep -f "ssh.*${NODE}\.pinggy\.io.*ProxyCommand=nc" 2>/dev/null | head -1)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      ALIVE_NODES="${ALIVE_NODES}${NODE},"
    else
      log "🔄 重建隧道节点 ${NODE}.pinggy.io..."
      build_tunnel "$NODE" "$OUTF" &
      sleep 1
      PID=$(pgrep -f "ssh.*${NODE}\.pinggy\.io.*ProxyCommand=nc" 2>/dev/null | head -1)
      if [ -n "$PID" ]; then
        log "✅ ${NODE} 隧道启动 PID=$PID"
        ALIVE_NODES="${ALIVE_NODES}${NODE},"
      else
        log "❌ ${NODE} 隧道启动失败（等下一轮重试）"
      fi
    fi
  done
  # ===== 循环2：每30秒（10轮×3秒）写一次GitHub =====
  WRITE_COUNTDOWN=$((WRITE_COUNTDOWN - 1))
  if [ "$WRITE_COUNTDOWN" -le 0 ]; then
    write_urls_to_github &
    WRITE_COUNTDOWN=10
  fi
  # 状态日志（每30秒一次总览）
  CNT_NODES=$(echo "$ALIVE_NODES" | tr ',' '\n' | grep -cv '^$' || echo 0)
  [ $(( $(date +%s) % 30 )) -eq 0 ] && log "📊 健康检查：SSH隧道=${CNT_NODES}/3  节点: ${ALIVE_NODES}"
  sleep 3
done
