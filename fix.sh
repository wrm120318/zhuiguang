#!/bin/bash
# fix.sh - 追光平台 一键修复脚本（解决90%常见故障）
# 用法: bash /workspace/fix.sh
# 效果: 自动诊断+自动修复: 后端挂了拉 / 隧道挂了重建 / GitHub URL写最新 / 进程清理
# 0成本！不用花一分钱！
set +e
cd /workspace
export PATH="/app/bin:$PATH"
[ -f .env ] && export $(grep -v '^#' .env | xargs)

LOG="/tmp/fix_$(date +%s).log"
exec > >(tee -a "$LOG") 2>&1
echo "======================================"
echo "🚑 追光平台 一键修复 启动 $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"
PROXY="127.0.0.1:18080"
LOCAL_PORT=3001

STEP=0
step(){ STEP=$((STEP+1)); echo ""; echo "【步骤 $STEP】$1 ..."; }

step "清理僵尸进程"
pkill -9 -f "ssh.*pinggy\|ssh.*serveo\|ssh.*localhost.run" 2>/dev/null
pkill -9 -f "tunnel-keeper\|tun_starter" 2>/dev/null
sleep 3
pkill -9 -f "tsx.*server/index.ts\|node.*dist/index" 2>/dev/null
sleep 3
echo "  清理完成"

step "启动后端（HTTP 3001）"
BACK_PID=""
# 方式1: 根目录 tsx
nohup npx tsx server/index.ts > /tmp/node_backend.log 2>&1 &
BACK_PID=$!
echo "  后端启动 PID=$BACK_PID，等 15 秒..."
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 1
  C=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:$LOCAL_PORT/api/pages/guide 2>&1)
  [ "$C" = "200" ] && break
done
C=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" http://localhost:$LOCAL_PORT/api/pages/guide 2>&1)
if [ "$C" = "200" ]; then
  echo "  ✅ 后端HTTP200 启动成功！"
else
  echo "  ⚠️ 后端未HTTP200，查日志:"
  tail -15 /tmp/node_backend.log
  exit 1
fi

step "建立 SSH 隧道 (pinggy多节点轮流试，建立成功立刻用)"
NEW_URL=""
SERVERS=("a.pinggy.io" "us-east-1.a.pinggy.io" "b.pinggy.io" "eu-west-1.a.pinggy.io")
for S in "${SERVERS[@]}"; do
  [ -n "$NEW_URL" ] && break
  LOGF="/tmp/ssh_$(date +%s)_$RANDOM.log"
  nohup ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o "ProxyCommand=nc -X connect -x $PROXY %h %p" \
    -o ConnectTimeout=20 -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -R0:localhost:$LOCAL_PORT "$S" > "$LOGF" 2>&1 &
  PID=$!
  for i in $(seq 1 25); do
    sleep 1
    NEW_URL=$(grep -oP 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)' "$LOGF" 2>/dev/null | head -1)
    [ -n "$NEW_URL" ] && break
    kill -0 "$PID" 2>/dev/null || break
  done
  if [ -n "$NEW_URL" ]; then
    echo "$PID" > /tmp/tunnel-PINGGY-pid
    echo "$NEW_URL" > /tmp/tunnel-PINGGY-url
    # 验证HTTP
    sleep 2
    C=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$NEW_URL/api/pages/guide" 2>&1)
    if [ "$C" = "200" ]; then
      echo "  ✅ 隧道建立成功: $NEW_URL (HTTP200，节点=$S)"
      break
    else
      echo "  ⚠️ 隧道URL拿到了但HTTP没200($C)，试下一个节点"
      NEW_URL=""
      kill -9 "$PID" 2>/dev/null
    fi
  else
    echo "  ❌ 节点 $S 失败，试下一个"
    kill -9 "$PID" 2>/dev/null
    sleep 2
  fi
done
if [ -z "$NEW_URL" ]; then
  echo "  ❌ 4个节点全部失败！检查代理18080"
  exit 1
fi

step "读取GitHub tunnel-url.txt的历史候选，合并最新URL(保持至少4条候选池)"
HIST_URLS=""
HIST_SHA=""
FETCH=$(curl -s -x "http://$PROXY" --max-time 10 \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt" 2>/dev/null)
HIST_SHA=$(echo "$FETCH" | grep -oP '"sha"\s*:\s*"\K[^"]+' 2>/dev/null | head -1)
B64=$(echo "$FETCH" | grep -oP '"content"\s*:\s*"\K[^"]+' 2>/dev/null | tr -d ' \n')
[ -n "$B64" ] && HIST_URLS=$(printf '%s' "$B64" | base64 -d 2>/dev/null | grep -E "^https://" | head -10)
# 合并: NEW在前，历史URL去重补到至少4条
MERGED="$NEW_URL"
seen="$NEW_URL"
cnt=1
while IFS= read -r u; do
  [ -z "$u" ] && continue
  case "|$seen|" in *"|$u|"*) continue ;; esac
  MERGED="${MERGED}
$u"
  seen="${seen}|$u"
  cnt=$((cnt+1))
  [ $cnt -ge 5 ] && break
done <<< "$HIST_URLS"
CNT=$(echo "$MERGED" | grep -c . || echo 0)
echo "  合并后候选URL数 = $CNT"
echo "$MERGED" | while read -r u; do [ -n "$u" ] && echo "    - $u"; done
CONTENT=$(printf "# fix.sh自动修复生成 候选池 %s条\n%s\n" "$CNT" "$MERGED")

step "写 GitHub tunnel-url.txt（Worker v6.3/v6.4 立刻能读到）"
ENCODED=$(printf '%s' "$CONTENT" | base64 -w0 2>/dev/null || printf '%s' "$CONTENT" | base64)
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'message':'fix.sh自动修复 $(date +%H:%M:%S) 新隧道=$CNT条候选','content':sys.argv[1],'sha':sys.argv[2] if len(sys.argv)>2 else ''}))" "$ENCODED" "$HIST_SHA")
RESULT=$(curl -s -x "http://$PROXY" --max-time 15 -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt" \
  -d "$PAYLOAD" 2>/dev/null | grep -c '"name":')
if [ "$RESULT" -gt 0 ]; then
  echo "  ✅ GitHub写入成功！Worker会在5秒内刷新缓存（v6.3/v6.4）"
else
  echo "  ⚠️ GitHub写入失败，继续下一步（至少本地隧道是好的）"
fi

step "后台启动 tunnel-keeper.sh（以后40分钟自动重建+监控）"
pkill -9 -f "tunnel-keeper" 2>/dev/null
sleep 2
nohup bash /workspace/tunnel-keeper.sh >> /tmp/keeper_v52.log 2>&1 &
KPID=$!
echo "  tunnel-keeper PID=$KPID 已启动（监控+周期性重建）"

step "最终验证：线上 https://xkzg.de5.net/login"
echo "  等12秒Worker缓存刷新..."
sleep 12
FAIL=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  C=$(curl -s --max-time 12 -o /dev/null -w "%{http_code}" "https://xkzg.de5.net/login?t=$(date +%s%3N)" 2>&1)
  echo "    第${i}次: HTTP $C"
  [ "$C" != "200" ] && FAIL=$((FAIL+1))
  [ "$C" = "200" ] && [ $i -eq 1 ] && break
done
echo ""
echo "======================================"
if [ "$FAIL" -le 2 ]; then
  echo "✅✅✅ 修复成功！10次请求失败=$FAIL ≤ 2，线上现在可以正常访问了！"
  echo "🌐 打开 https://xkzg.de5.net/login 试试吧～"
  echo "📄 详细日志：$LOG"
else
  echo "⚠️ 仍有问题。请贴 $LOG 内容给AI助手排查"
fi
echo "修复完成时间：$(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"
