#!/usr/bin/env bash
# ==============================================================================
# keep-alive.sh v5.0  严格3条隧道健康保活
# 更新日期: 2026-08-06
# ==============================================================================
# 功能:
#   1. 每60秒轮询3条隧道 /__zg_health，防止空闲断开(pinggy免费会断空闲连接)
#   2. 连续3次失败 → 标记熔断5分钟
#   3. 输出 /workspace/available_tunnels.txt 供后端读取
#   4. 后端进程保活(3001端口死掉→立刻重启)
# ==============================================================================
set +e
umask 022
export LANG=C LC_ALL=C TZ="Asia/Shanghai"

WORK_DIR="/workspace"
TMP_DIR="/tmp/ult"
LOG_FILE="$TMP_DIR/keepalive_v5.log"
AVAIL_FILE="$WORK_DIR/available_tunnels.txt"
mkdir -p "$TMP_DIR"

PROXY="http://127.0.0.1:18080"
BACKEND_PORT=3001
TUNNEL_COUNT=3
CHECK_EVERY_S=60
MAX_FAIL=3
FUSE_S=300  # 熔断5分钟

log()  { echo "[$(date +'%m-%d %H:%M:%S')] 💡 $*" | tee -a "$LOG_FILE"; }
warn() { echo "[$(date +'%m-%d %H:%M:%S')] ⚠️ $*" | tee -a "$LOG_FILE"; }
err()  { echo "[$(date +'%m-%d %H:%M:%S')] 🧨 $*" | tee -a "$LOG_FILE"; }

# ========== 失败计数器 ==========
declare -A FAIL_CNT FUSE_UNTIL

# ========== 保活后端 ==========
ensure_backend() {
  local C
  C=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/__zg_health" 2>/dev/null)
  if [ "$C" = "200" ]; then return 0; fi
  warn "后端HTTP=$C，立刻重启后端..."
  pkill -9 -f "node.*server/index\|tsx.*server" 2>/dev/null
  sleep 3
  cd "$WORK_DIR"
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
  nohup npx tsx server/index.ts &> "$TMP_DIR/backend_keepalive.log" < /dev/null &
  log "后端已重启，新PID=$!"
  sleep 10
}

# ========== 单条健康检查 ==========
health_one() {
  local U="$1"
  local C1 C2
  C1=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/__zg_health" 2>/dev/null)
  C2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/login"     2>/dev/null)
  [ "$C1" = "200" ] && [ "$C2" = "200" ]
}

# ========== 从 tunnel-url.txt + tk 日志取候选 ==========
get_candidates() {
  local RES=()
  # 1. GitHub同步的tunnel-url.txt(前3条)
  if [ -f "$WORK_DIR/tunnel-url.txt" ]; then
    while read U; do
      [ -z "$U" ] && continue
      case "$U" in https*) RES+=("$U") ;; esac
    done < "$WORK_DIR/tunnel-url.txt"
  fi
  # 2. tk_tun_x.log最新URL
  for i in $(seq 1 $TUNNEL_COUNT); do
    f="$TMP_DIR/tk_tun_${i}.log"
    [ -f "$f" ] || continue
    while read U; do
      [ -z "$U" ] && continue
      RES+=("$U")
    done < <(grep -oE "https://[a-zA-Z0-9-]+\.pinggy[a-z0-9._/-]+" "$f" 2>/dev/null | grep -v dashboard | sort -u | tail -2)
  done
  printf "%s\n" "${RES[@]}" | sort -u | head -6
}

# ========== 主循环 ==========
main_loop() {
  log "========== keep-alive v5.0 启动 =========="
  while true; do
    ensure_backend
    NOW=$(date +%s)
    # 取候选
    mapfile -t CANDS < <(get_candidates)
    local LIVE=()
    local TMP_F="$TMP_DIR/.ka_cand_tmp.txt"
    > "$TMP_F"
    for U in "${CANDS[@]}"; do
      [ -z "$U" ] && continue
      # a. 在熔断期?
      if [ -n "${FUSE_UNTIL[$U]}" ] && [ "$NOW" -lt "${FUSE_UNTIL[$U]}" ]; then
        continue
      fi
      # b. 健康检查
      if health_one "$U"; then
        FAIL_CNT[$U]=0
        LIVE+=("$U")
        echo "$U" >> "$TMP_F"
      else
        FAIL_CNT[$U]=$(( ${FAIL_CNT[$U]:-0} + 1 ))
        warn "$U 连续失败${FAIL_CNT[$U]}次"
        if [ "${FAIL_CNT[$U]}" -ge "$MAX_FAIL" ]; then
          FUSE_UNTIL[$U]=$(( NOW + FUSE_S ))
          warn "$U 连续${MAX_FAIL}次失败→熔断$((FUSE_S/60))分钟"
          FAIL_CNT[$U]=0
        fi
      fi
    done
    # 写available_tunnels.txt(严格前3条)
    > "$AVAIL_FILE"
    printf "%s\n" "${LIVE[@]}" | sort -u | head -3 >> "$AVAIL_FILE"
    [ "${#LIVE[@]}" -lt 1 ] && warn "本轮所有隧道都死了！写空文件等待tunnel-keeper自动重启"
    [ "${#LIVE[@]}" -eq 1 ] && warn "只剩1条隧道可用！注意！"
    # 日志(每10轮打一次≈10分钟)
    local R
    R=$(printf "%010d" $(( $(date +%s) / 600 )) )
    [ ! -f "$TMP_DIR/.ka_round_$R" ] && {
      log "💓 本轮候选${#CANDS[@]}条 → 活${#LIVE[@]}条: $(printf "%s " "${LIVE[@]}")"
      touch "$TMP_DIR/.ka_round_$R"
    }
    sleep $CHECK_EVERY_S
  done
}

# ========== 入口 ==========
PIDF="$TMP_DIR/keepalive_v5.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then
  echo "keep-alive v5 已在运行，PID=$(cat $PIDF)，退出"
  exit 0
fi
echo $$ > "$PIDF"
trap 'rm -f "$PIDF"; exit 0' INT TERM EXIT
main_loop
