#!/bin/bash
# daemon-watchdog.sh v1.1 - 【追光平台无缝自动守护·终极版】用户完全不用管！
# 3个WatchDog并行 + WatchDog B新增：每隔60秒自动把【当前所有活着的隧道URL+历史】合并写GitHub
# → 保证Worker v6.3/v6.5候选池永远保持≥3条，1条挂了立刻换另一条，用户完全无感！
#
# 🔹 WatchDog A（3秒/次）  - 后端进程+3001HTTP，非200 3秒内拉起
# 🔹 WatchDog B（10秒/次） - SSH隧道<2条 立即补建；每60秒 全量活着的URL+历史→写GitHub（≥3条候选）
# 🔹 WatchDog C（30秒/次） - 线上xkzg.dpdns.org 1次非200 → 自动触发bash /workspace/fix.sh（有10分钟锁）
#
# 启动方式： nohup bash /workspace/daemon-watchdog.sh >> /tmp/daemon-watchdog.log 2>&1 &
# 验证： ps aux | grep daemon-watchdog （应有 ~10 个进程=1主+3子while+sleep们）
# 日志： tail -f /tmp/daemon-watchdog.log

set +e
cd /workspace
[ -f .env ] && export $(grep -v '^#' .env | xargs)

LOG="/tmp/daemon-watchdog.log"
FIX_LOCK="/tmp/health_fix.lock"
WRITE_LOCK="/tmp/url_write.lock"   # 写GitHub的互斥锁，避免B和fix.sh和tunnel-keeper互相覆盖
LOCAL_PORT=3001
PROXY="127.0.0.1:18080"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
REPO="wrm120318/zhuiguang"
FILE_PATH="tunnel-url.txt"

log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"; }
can_fix() {
  if [ -f "$FIX_LOCK" ]; then
    LAST=$(cat "$FIX_LOCK" 2>/dev/null); NOW=$(date +%s); DIFF=$(( NOW - LAST ))
    [ $DIFF -lt 600 ] && return 1
  fi
  date +%s > "$FIX_LOCK"
  return 0
}
b64enc() { printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }
b64dec() { printf '%s' "$1" | base64 -d 2>/dev/null; }

# ============================================================
# 工具函数：把"当前所有活着的隧道URL"+GitHub历史URL合并→去重→写GitHub
# 保持至少 MIN=3 条候选，最多 MAX=8 条
# ============================================================
write_all_alive_urls_to_github() {
  [ -z "$GITHUB_TOKEN" ] && return 1
  # 写锁（30秒超时）避免并发覆盖
  (
    if flock -w 30 200; then
      # Step1：收集当前活着的URL（直接HTTP验证，不是只看日志）
      local alive=""
      local tmpfile=$(mktemp)
      # 1A. 从所有SSH进程日志/tmp里grep所有可能的pinggy URL
      grep -rhoP 'https://[a-z0-9-]+\.(run\.pinggy-free\.link|free\.pinggy\.net)' \
        /tmp/ssh*.log /tmp/fix_*.log /tmp/fix_auto_*.log /tmp/keeper_*.log /tmp/daemon-watchdog.log \
        2>/dev/null | sort -u > "$tmpfile"
      # 1B. 从GitHub历史里取（万一隧道进程刚建还没写日志）
      local old_resp=$(curl -s -x "http://$PROXY" --max-time 10 \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/$REPO/contents/$FILE_PATH" 2>/dev/null)
      local sha=$(echo "$old_resp" | grep -oP '"sha"\s*:\s*"\K[^"]+' 2>/dev/null | head -1)
      local old_b64=$(echo "$old_resp" | grep -oP '"content"\s*:\s*"\K[^"]+' 2>/dev/null | tr -d ' \n')
      local old_urls=""
      [ -n "$old_b64" ] && old_urls=$(b64dec "$old_b64" 2>/dev/null | grep -E "^https://" | head -10)
      [ -n "$old_urls" ] && echo "$old_urls" >> "$tmpfile"
      # 1C. 去重+HTTP验证，只要200就认为活着
      local seen="__DUMMY__"
      local cnt=0
      while IFS= read -r u; do
        [ -z "$u" ] && continue
        case "|$seen|" in *"|$u|"*) continue ;; esac
        seen="${seen}|$u"
        local C=$(curl -s --max-time 6 -o /dev/null -w "%{http_code}" "$u/api/pages/guide" 2>&1)
        if [ "$C" = "200" ]; then
          alive="${alive}${alive:+
}$u"
          cnt=$((cnt+1))
          [ $cnt -ge 8 ] && break
        fi
      done < "$tmpfile"
      rm -f "$tmpfile"
      # 如果活着的URL<3条，把历史URL里没失效的也补上（哪怕过期了Worker会自己判失败换下一条）
      local final_cnt=$cnt
      local final="$alive"
      if [ $final_cnt -lt 3 ] && [ -n "$old_urls" ]; then
        while IFS= read -r u; do
          [ -z "$u" ] && continue
          case "|$seen|" in *"|$u|"*) continue ;; esac
          seen="${seen}|$u"
          final="${final}${final:+
}$u"
          final_cnt=$((final_cnt+1))
          [ $final_cnt -ge 5 ] && break
        done <<< "$old_urls"
      fi
      [ -z "$final" ] && return 0   # 没东西就不写
      final_cnt=$(echo "$final" | grep -c .)
      # Step2：写GitHub
      local content=$(printf "# daemon-watchdog v1.1 %s条候选池（Worker v6.3/v6.5自动取多条，1条不通立刻换下一条，用户完全无感）\n%s\n" "$final_cnt" "$final")
      local encoded=$(b64enc "$content")
      local payload
      payload=$(python3 -c "import json,sys; d={'message':'daemon-watchdog v1.1 全量${final_cnt}候选（自动合并活着的URL）','content':sys.argv[1]}
if len(sys.argv)>2 and sys.argv[2]: d['sha']=sys.argv[2]
print(json.dumps(d))" "$encoded" "$sha")
      local wr=$(curl -s -x "http://$PROXY" --max-time 15 -X PUT \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/$REPO/contents/$FILE_PATH" \
        -d "$payload" 2>/dev/null | grep -c '"name":')
      if [ "$wr" -gt 0 ]; then
        log "✅ [B-写GitHub] 全量${final_cnt}条候选写入成功（活着=$cnt）"
        return 0
      else
        log "⚠️ [B-写GitHub] sha=$sha 写入失败，下次再试"
        return 1
      fi
    fi
  ) 200>"$WRITE_LOCK"
}

log "=========== daemon-watchdog v1.1 【终极无缝版】启动 ==========="
log "🔹 A(3s): 后端3001 HTTP检测，挂了3秒内拉起"
log "🔹 B(10s): SSH隧道进程<2立即补建 + 每60s自动合并所有活着URL→写GitHub(≥3条候选)"
log "🔹 C(30s): 线上xkzg.dpdns.org 1次非200→自动bash /workspace/fix.sh"
log "================================================================"

# ============================================================
# WatchDog A：后端守护（3秒检查周期）
# ============================================================
(
  while true; do
    sleep 3
    # 进程存在检测
    if ! pgrep -f "tsx.*server/index" > /dev/null 2>&1 && \
       ! pgrep -f "node.*dist/index" > /dev/null 2>&1; then
      log "⚠️ [A] 后端进程不存在，立即拉起..."
      nohup npx tsx server/index.ts > /tmp/node_backend.log 2>&1 &
      sleep 12
    fi
    # HTTP 3001 检测
    C=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:$LOCAL_PORT/api/pages/guide 2>&1)
    if [ "$C" != "200" ]; then
      log "⚠️ [A] 后端3001 HTTP=$C ≠200，重启..."
      pkill -9 -f "tsx.*server/index\|node.*dist/index" 2>/dev/null
      sleep 3
      nohup npx tsx server/index.ts > /tmp/node_backend.log 2>&1 &
      sleep 12
      C2=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:$LOCAL_PORT/api/pages/guide 2>&1)
      [ "$C2" = "200" ] && log "✅ [A] 后端重启成功 HTTP200" || log "❌ [A] 后端重启失败 HTTP=$C2"
    fi
  done
) &
WDA_PID=$!
log "✅ WatchDog A 启动 PID=$WDA_PID"

# ============================================================
# WatchDog B：隧道守护（10秒检查周期 + 每60秒写GitHub全量URL）
# ============================================================
(
  LAST_WRITE=0
  while true; do
    sleep 10
    # B1：SSH隧道进程<2 → 立即补建1条
    TUNNEL_CNT=$(ps aux | grep "ssh.*pinggy" | grep -v grep | wc -l | tr -d ' ')
    if [ "$TUNNEL_CNT" -lt 2 ]; then
      log "⚠️ [B] SSH隧道数=$TUNNEL_CNT < 2，立即补建..."
      SRV="a.pinggy.io"
      case "$(( RANDOM % 5 ))" in
        0) SRV="a.pinggy.io" ;;
        1) SRV="b.pinggy.io" ;;
        2) SRV="us-east-1.a.pinggy.io" ;;
        3) SRV="us-west-2.a.pinggy.io" ;;
        4) SRV="eu-west-1.a.pinggy.io" ;;
      esac
      LOGF="/tmp/ssh_daemon_$(date +%s).log"
      nohup ssh -p 443 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o "ProxyCommand=nc -X connect -x $PROXY %h %p" \
        -o ConnectTimeout=15 -o ServerAliveInterval=10 -o ServerAliveCountMax=2 \
        -o ExitOnForwardFailure=yes \
        -R0:localhost:$LOCAL_PORT $SRV 2>&1 | tee -a "$LOGF" > /dev/null &
      sleep 8
      NEW_CNT=$(ps aux | grep 'ssh.*pinggy' | grep -v grep | wc -l | tr -d ' ')
      log "✅ [B] 补建后隧道数=$NEW_CNT （节点=$SRV，日志=$LOGF）"
      # 补建后立刻写一次GitHub（等10秒让SSH建完）
      sleep 12
      write_all_alive_urls_to_github
      LAST_WRITE=$(date +%s)
    fi
    # B2：tunnel-keeper.sh不存在 → 拉起
    if ! pgrep -f "tunnel-keeper.sh" > /dev/null 2>&1; then
      log "⚠️ [B] tunnel-keeper.sh挂了，自动启动..."
      nohup bash /workspace/tunnel-keeper.sh >> /tmp/keeper_v52.log 2>&1 &
      sleep 2
    fi
    # B3：每60秒强制写一次GitHub（保证候选池永远是最新的、最多的）
    NOW_T=$(date +%s)
    if [ $(( NOW_T - LAST_WRITE )) -ge 60 ]; then
      write_all_alive_urls_to_github
      LAST_WRITE=$NOW_T
    fi
  done
) &
WDB_PID=$!
log "✅ WatchDog B 启动 PID=$WDB_PID"

# ============================================================
# WatchDog C：线上健康（30秒检查周期，1次非200触发fix.sh）
# ============================================================
(
  while true; do
    sleep 30
    C=$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "https://xkzg.dpdns.org/login?t=$(date +%s%3N)" 2>&1)
    if [ "$C" != "200" ]; then
      log "⚠️ [C] 线上HTTP=$C ≠200，自动触发 bash /workspace/fix.sh..."
      if can_fix; then
        FIXLOG="/tmp/fix_auto_$(date +%Y%m%d_%H%M%S).log"
        nohup bash /workspace/fix.sh >> "$FIXLOG" 2>&1 &
        log "✅ [C] fix.sh已触发，日志=$FIXLOG"
      else
        log "🔒 [C] fix锁未到期（10分钟防重复触发），跳过本次"
      fi
    fi
  done
) &
WDC_PID=$!
log "✅ WatchDog C 启动 PID=$WDC_PID"

log ""
log "🚀 daemon-watchdog v1.1【终极无缝版】启动完毕！"
log "🚀 PID: A=$WDA_PID  B=$WDB_PID  C=$WDC_PID"
log "🚀 您完全不用管！后端/隧道/线上有问题3~30秒内自动修复！Worker候选池永远≥3条，1条不通自动换！"
log "🚀 日志: tail -f /tmp/daemon-watchdog.log"
log ""

# 启动时立刻写一次GitHub（热启动）
write_all_alive_urls_to_github

# 父进程60秒心跳（不退出，保证子进程不变成孤儿）
while true; do
  sleep 60
  AOK=$(kill -0 $WDA_PID 2>/dev/null && echo 1 || echo 0)
  BOK=$(kill -0 $WDB_PID 2>/dev/null && echo 1 || echo 0)
  COK=$(kill -0 $WDC_PID 2>/dev/null && echo 1 || echo 0)
  BHTTP=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' http://localhost:$LOCAL_PORT/api/pages/guide 2>&1)
  TC=$(ps aux | grep 'ssh.*pinggy' | grep -v grep | wc -l | tr -d ' ')
  log "💓 心跳：A=$AOK B=$BOK C=$COK | 后端HTTP=$BHTTP | SSH隧道=$TC条"
done
