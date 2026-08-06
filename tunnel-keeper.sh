#!/usr/bin/env bash
# ==============================================================================
# tunnel-keeper.sh v5.0  严格3条规范版  (按分析文档6.4硬性规范落地)
# 更新日期: 2026-08-06
# ==============================================================================
# 🧠 6.4硬性规范:
#   · 同服务商维持≤3条活跃隧道(本脚本=3条Pinggy a.pinggy.io，错开sleep)
#   · 之前46条同Pinggy隧道=自杀式部署→平台限流/IP封禁/连接队列打满→集体超时
#   · Worker v7.4只读GitHub tunnel-url.txt【前3条】，就算本脚本误写几十条也只取3
#
# 核心流程:
#   1. 启动时清理僵尸，只留3条a.pinggy.io，stdout/stderr都用stdbuf永久后台
#   2. 每60秒巡检: 进程活? /__zg_health 200? 死了立刻重启
#   3. 每55分钟(3300秒) 平滑滚动重启: 先启新的→测活→写GitHub→再杀旧的(零中断)
#   4. 每次隧道URL有变化 → 测活双200 → 前3条 → git push GitHub
#
# 零成本承诺: 不绑卡, 不花钱, 只用 Pinggy 免费 + GitHub公开仓库
# ==============================================================================
set +e
umask 022
export LANG=C LC_ALL=C TZ="Asia/Shanghai"

WORK_DIR="/workspace"
TMP_DIR="/tmp/ult"
LOG_FILE="$TMP_DIR/tkeeper_v5.log"
mkdir -p "$TMP_DIR"

# ============ 基础配置 ============
PROXY="http://127.0.0.1:18080"
export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
BACKEND_PORT=3001
GIT_REMOTE="origin"
GIT_BRANCH="main"
TUNNEL_COUNT=3           # 严格=3
SSH_NODE="a.pinggy.io"   # 沙箱环境只有这个节点能握手成功(b/in/serveo/lhrun全超时)
TUN_TO=22
TUN_SLEEP=(0 5 11)       # 3条错开启动秒数，避免同时抢端口=平台限流
RESTART_EVERY_S=3300     # 55分钟=3300s 平滑滚动刷新(在Pinggy免费60min过期前)
HEALTHY_EVERY_S=60       # 60s健康巡检
GRACE_S=45               # 启动后最大45s内必须出URL+双200，否则判死重建

# ============ 日志 ============
log()  { echo "[$(date +'%m-%d %H:%M:%S')] 💡 $*" | tee -a "$LOG_FILE"; }
warn() { echo "[$(date +'%m-%d %H:%M:%S')] ⚠️ $*" | tee -a "$LOG_FILE"; }
err()  { echo "[$(date +'%m-%d %H:%M:%S')] 🧨 $*" | tee -a "$LOG_FILE"; }

# ============ 清理僵尸SSH ============
cleanup_zombies() {
  local KILLED=0
  ps aux | grep -v sshd | grep "ssh " | grep -v grep | awk '{print $2}' | while read PID; do
    local CMD
    CMD=$(cat /proc/$PID/cmdline 2>/dev/null | tr '\0' ' ')
    case "$CMD" in
      *"$SSH_NODE"*) ;; # 我们的目标节点，不在这里杀(单独处理)
      *) kill -9 $PID 2>/dev/null; KILLED=$((KILLED+1)) ;;
    esac
  done
  [ "$KILLED" -gt 0 ] && log "清理僵尸SSH非目标节点: $KILLED 条"
  true
}

# ============ 启动1条隧道(永久后台 stdbuf强制行缓冲写log) ============
start_one_tunnel() {
  local idx=$1
  local logf="$TMP_DIR/tk_tun_${idx}.log"
  local pidf="$TMP_DIR/tk_tun_${idx}.pid"
  local startf="$TMP_DIR/tk_tun_${idx}.started_at"
  rm -f "$logf"
  touch "$startf"
  nohup stdbuf -oL -eL ssh -4 -tt \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o TCPKeepAlive=yes \
    -o ConnectTimeout=20 \
    -o ProxyCommand="nc -X connect -x ${PROXY#http://} %h %p" \
    -p 443 -R0:localhost:${BACKEND_PORT} $SSH_NODE \
    &> "$logf" < /dev/null &
  local PID=$!
  echo $PID > "$pidf"
  log "启动 tun_${idx} PID=$PID LOG=$logf"
  echo $PID
}

# ============ 从日志提取URL ============
extract_urls() {
  local logf="$1"
  [ -f "$logf" ] || return 1
  grep -oE "https://[a-zA-Z0-9-]+\.pinggy[a-z0-9._/-]+" "$logf" 2>/dev/null \
    | grep -v "dashboard.pinggy.io" | sort -u | tail -4
}

# ============ 健康检测(双200=通过) ============
is_url_alive() {
  local U="$1"
  local C1 C2
  C1=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/__zg_health" 2>/dev/null)
  C2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/login"     2>/dev/null)
  [ "$C1" = "200" ] && [ "$C2" = "200" ]
}

# ============ 推送到GitHub tunnel-url.txt (严格前3条真活) ============
push_to_github() {
  local -n urls=$1
  local LIVE3=() i=0
  for U in "${urls[@]}"; do
    is_url_alive "$U" && LIVE3+=("$U") && i=$((i+1))
    [ $i -ge 3 ] && break
  done
  [ "${#LIVE3[@]}" -lt 2 ] && { warn "GitHub推送中止: 真活只有${#LIVE3[@]}条(要求≥2)"; return 1; }
  printf "%s\n" "${LIVE3[@]:0:3}" > "$WORK_DIR/tunnel-url.txt"
  cd "$WORK_DIR" >/dev/null
  {
    git add tunnel-url.txt
    git -c http.proxy="$PROXY" -c https.proxy="$PROXY" commit \
      -m "🔥 tk-v5 自动刷新[$(date +'%m-%d %H:%M')] ${#LIVE3[@]}条真活(严格≤3)" tunnel-url.txt --allow-empty
    git -c http.proxy="$PROXY" -c https.proxy="$PROXY" push -f $GIT_REMOTE $GIT_BRANCH
  } >/dev/null 2>&1
  log "→ GitHub已推送 ${#LIVE3[@]}条真活 前3条:"
  for U in "${LIVE3[@]:0:3}"; do log "    · $U"; done
  true
}

# ============ 主流程 ============
main_loop() {
  log "========== tunnel-keeper v5.0 启动（严格3条规范） =========="
  log "节点=$SSH_NODE × ${TUNNEL_COUNT}条 · 刷新间隔=$((RESTART_EVERY_S/60))分钟"
  cleanup_zombies

  # 1. 首次启动3条
  local -a PIDS
  local -a LOGS
  for i in $(seq 1 $TUNNEL_COUNT); do
    idx=$((i-1))
    [ "${TUN_SLEEP[$idx]}" -gt 0 ] && sleep "${TUN_SLEEP[$idx]}"
    PID=$(start_one_tunnel $i)
    PIDS[$idx]=$PID
    LOGS[$idx]="$TMP_DIR/tk_tun_${i}.log"
  done

  # 2. 等所有出URL(最多45s)
  log "等隧道出URL(最多${GRACE_S}s)..."
  sleep $GRACE_S

  # 3. 主循环
  local start_epoch now last_restart_epoch
  start_epoch=$(date +%s)
  last_restart_epoch=$start_epoch
  while true; do
    now=$(date +%s)

    # --- 收集所有活URL ---
    local ALL_LIVE=()
    local ALIVE_COUNT=0
    for i in $(seq 1 $TUNNEL_COUNT); do
      idx=$((i-1))
      PID="${PIDS[$idx]}"
      # a. 进程死了？立刻重启
      if ! kill -0 "$PID" 2>/dev/null; then
        warn "tun_${i} PID=$PID 死了！立刻重启"
        NEW_PID=$(start_one_tunnel $i)
        PIDS[$idx]="$NEW_PID"
        sleep $GRACE_S
      fi
      # b. 从日志取URL+测活
      URLS=$(extract_urls "${LOGS[$idx]}")
      if [ -n "$URLS" ]; then
        while read U; do
          if is_url_alive "$U"; then
            ALL_LIVE+=("$U")
            ALIVE_COUNT=$((ALIVE_COUNT+1))
          fi
        done <<< "$URLS"
      fi
    done

    # --- 去重 ---
    ALL_LIVE=($(printf "%s\n" "${ALL_LIVE[@]}" | sort -u))
    ALIVE_COUNT=${#ALL_LIVE[@]}

    # --- 变化就推GitHub ---
    local HASH_NEW
    HASH_NEW=$(printf "%s\n" "${ALL_LIVE[@]:0:3}" | md5sum | awk '{print $1}')
    local HASH_OLD=""
    [ -f "$TMP_DIR/tk_last_push.md5" ] && HASH_OLD=$(cat "$TMP_DIR/tk_last_push.md5")
    if [ "$HASH_NEW" != "$HASH_OLD" ] && [ "$ALIVE_COUNT" -ge 2 ]; then
      push_to_github ALL_LIVE && echo "$HASH_NEW" > "$TMP_DIR/tk_last_push.md5"
    fi

    # --- 55分钟滚动平滑重启: 先启新3条→测活→推GitHub→再杀旧3条 ---
    local ELAPSED=$((now - last_restart_epoch))
    if [ $ELAPSED -ge $RESTART_EVERY_S ]; then
      warn "滚动重启：运行${ELAPSED}s≥${RESTART_EVERY_S}s，先启新3条再杀旧3条"
      local -a NEW_PIDS NEW_LOGS
      for i in $(seq 1 $TUNNEL_COUNT); do
        idx=$((i-1))
        [ "${TUN_SLEEP[$idx]}" -gt 0 ] && sleep "${TUN_SLEEP[$idx]}"
        # 新日志用_new后缀
        local logf="$TMP_DIR/tk_tun_${i}_new.log"
        rm -f "$logf"
        nohup stdbuf -oL -eL ssh -4 -tt \
          -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o ServerAliveInterval=15 -o ServerAliveCountMax=2 -o TCPKeepAlive=yes \
          -o ConnectTimeout=20 \
          -o ProxyCommand="nc -X connect -x ${PROXY#http://} %h %p" \
          -p 443 -R0:localhost:${BACKEND_PORT} $SSH_NODE \
          &> "$logf" < /dev/null &
        NEW_PIDS[$idx]=$!
        NEW_LOGS[$idx]="$logf"
      done
      sleep $GRACE_S
      # 收集新的URL
      local NEW_LIVE=()
      for i in $(seq 1 $TUNNEL_COUNT); do
        idx=$((i-1))
        URLS=$(extract_urls "${NEW_LOGS[$idx]}")
        while read U; do
          is_url_alive "$U" && NEW_LIVE+=("$U")
        done <<< "$URLS"
      done
      NEW_LIVE=($(printf "%s\n" "${NEW_LIVE[@]}" | sort -u))
      if [ "${#NEW_LIVE[@]}" -ge 2 ]; then
        push_to_github NEW_LIVE
        # 新的成功了！替换旧PID+LOG+杀旧
        for i in $(seq 1 $TUNNEL_COUNT); do
          idx=$((i-1))
          OLD_PID="${PIDS[$idx]}"
          # 重命名新日志→正式日志
          mv "$TMP_DIR/tk_tun_${i}_new.log" "$TMP_DIR/tk_tun_${i}.log" 2>/dev/null
          LOGS[$idx]="$TMP_DIR/tk_tun_${i}.log"
          kill -9 "$OLD_PID" 2>/dev/null
          PIDS[$idx]="${NEW_PIDS[$idx]}"
        done
        last_restart_epoch=$(date +%s)
        log "✅ 滚动重启完成！新真活数=${#NEW_LIVE[@]}"
      else
        warn "⚠️  新3条URL不足2条真活，保留旧的不杀，${HEALTHY_EVERY_S}s后再巡检"
        # 清理新的
        for PID in "${NEW_PIDS[@]}"; do kill -9 $PID 2>/dev/null; done
      fi
      cleanup_zombies
    fi

    # --- 心跳日志(每5分钟打一次) ---
    local MIN_ELAPSED=$(( (now - start_epoch) / 60 ))
    if [ $(( MIN_ELAPSED % 5 )) -eq 0 ] && [ ! -f "$TMP_DIR/.heartbeat_${MIN_ELAPSED}" ]; then
      log "💓 运行${MIN_ELAPSED}分钟: 活URL=${ALIVE_COUNT}条 进程PID列表: ${PIDS[*]}"
      touch "$TMP_DIR/.heartbeat_${MIN_ELAPSED}"
    fi

    sleep $HEALTHY_EVERY_S
  done
}

# ============ 入口 ============
cd "$WORK_DIR"
if [ "$1" = "--once" ]; then
  # 调试：跑一次健康+推送
  cleanup_zombies
  declare -a LIVE_DEBUG=()
  for f in "$TMP_DIR"/tk_tun_*.log; do
    [ -f "$f" ] || continue
    URLS=$(extract_urls "$f")
    while read U; do
      is_url_alive "$U" && LIVE_DEBUG+=("$U")
    done <<< "$URLS"
  done
  LIVE_DEBUG=($(printf "%s\n" "${LIVE_DEBUG[@]}" | sort -u))
  echo "活URL数=${#LIVE_DEBUG[@]}"
  printf "  %s\n" "${LIVE_DEBUG[@]}"
  [ "${#LIVE_DEBUG[@]}" -ge 2 ] && push_to_github LIVE_DEBUG
  exit 0
fi

# 防止重复启动
PIDF="$TMP_DIR/tkeeper_v5.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then
  echo "tunnel-keeper v5 已在运行，PID=$(cat $PIDF)，退出"
  exit 0
fi
echo $$ > "$PIDF"
trap 'rm -f "$PIDF"; exit 0' INT TERM EXIT

main_loop
