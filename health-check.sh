#!/bin/bash
# health-check.sh - 追光平台自动健康检查（crontab每5分钟跑一次，0成本）
# 功能：
#   A. 后端3001挂了 → 自动拉起
#   B. 线上xkzg.de5.net连续3次非200 → 自动执行fix.sh 1键修复
#   C. 日志写 /tmp/health-check.log，排障直接看
set +e
LOG="/tmp/health-check.log"
cd /workspace
[ -f .env ] && export $(grep -v '^#' .env | xargs)

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }

# 限制：最多每10分钟才允许触发一次fix.sh（避免重复触发）
FIX_LOCK="/tmp/health_fix.lock"
can_fix() {
  if [ -f "$FIX_LOCK" ]; then
    LAST=$(cat "$FIX_LOCK" 2>/dev/null)
    NOW=$(date +%s)
    DIFF=$(( NOW - LAST ))
    [ $DIFF -lt 600 ] && return 1
  fi
  date +%s > "$FIX_LOCK"
  return 0
}

log "=== 检查开始 ==="

# A. 检查后端 localhost:3001
C=$(curl -s --max-time 4 -o /dev/null -w "%{http_code}" http://localhost:3001/api/pages/guide 2>&1)
if [ "$C" != "200" ]; then
  log "⚠️ 后端3001 HTTP=$C，异常！自动拉起..."
  pkill -9 -f "tsx.*server/index\|node.*dist/index" 2>/dev/null
  sleep 3
  nohup npx tsx server/index.ts > /tmp/node_backend.log 2>&1 &
  sleep 15
  C2=$(curl -s --max-time 4 -o /dev/null -w "%{http_code}" http://localhost:3001/api/pages/guide 2>&1)
  if [ "$C2" = "200" ]; then
    log "✅ 后端自动拉起成功（HTTP200）"
  else
    log "❌ 后端自动拉起失败 HTTP=$C2，触发fix.sh"
    can_fix && (nohup bash /workspace/fix.sh >> /tmp/fix_auto.log 2>&1 &)
  fi
else
  log "✅ 后端3001 HTTP200 正常"
fi

# B. 检查线上 xkzg.de5.net（连续3次）
BAD=0
for n in 1 2 3; do
  sleep 1
  CC=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "https://xkzg.de5.net/login?t=$(date +%s%3N)" 2>&1)
  [ "$CC" != "200" ] && BAD=$((BAD+1))
done
if [ $BAD -ge 2 ]; then
  log "⚠️ 线上异常：3次请求非200次数=$BAD，触发1键修复fix.sh"
  can_fix && (nohup bash /workspace/fix.sh >> /tmp/fix_auto.log 2>&1 &)
else
  log "✅ 线上正常（3次中非200=$BAD < 2）"
fi

# C. tunnel-keeper挂了就拉起来（周期性重建隧道）
if ! pgrep -f "tunnel-keeper.sh" > /dev/null 2>&1; then
  log "⚠️ tunnel-keeper.sh进程不存在，自动启动..."
  nohup bash /workspace/tunnel-keeper.sh >> /tmp/keeper_v52.log 2>&1 &
  sleep 2
  pgrep -f "tunnel-keeper.sh" > /dev/null 2>&1 && log "✅ tunnel-keeper启动成功" || log "❌ tunnel-keeper启动失败"
fi

log "=== 检查结束 ==="
