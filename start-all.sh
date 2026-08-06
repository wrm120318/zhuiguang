#!/usr/bin/env bash
# ==============================================================================
# start-all.sh v5.0  追光学科共享平台 一键启动总控
# 更新日期: 2026-08-06
# ==============================================================================
# 严格按分析文档6.4规范: 同服务商≤3条隧道 × worker v7.4只读前3条
#
# 三层守护:
#   ① Node.js后端 (tsx server/index.ts)  —— keep-alive.sh每60s保活
#   ② 隧道守护 tunnel-keeper.sh v5       —— 3条Pinggy a节点×55分钟滚动刷新×自动推GitHub
#   ③ 健康保活 keep-alive.sh v5          —— 每60s心跳+连续3次熔断+后端保活
#
# 零成本承诺: 0花费 0绑卡 纯免费
# ==============================================================================
set +e
umask 022
export LANG=C LC_ALL=C TZ="Asia/Shanghai"

WORK_DIR="/workspace"
TMP_DIR="/tmp/ult"
mkdir -p "$TMP_DIR"

PROXY="http://127.0.0.1:18080"
export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"

# 颜色日志
log()  { echo -e "\033[1;34m[$(date +'%m-%d %H:%M:%S')] 💡 $*\033[0m"; }
ok()   { echo -e "\033[1;32m[$(date +'%m-%d %H:%M:%S')] ✅ $*\033[0m"; }
warn() { echo -e "\033[1;33m[$(date +'%m-%d %H:%M:%S')] ⚠️ $*\033[0m"; }
err()  { echo -e "\033[1;31m[$(date +'%m-%d %H:%M:%S')] 🧨 $*\033[0m"; }

cd "$WORK_DIR"

log "================================================"
log "追光学科共享平台 一键启动 v5.0"
log "严格3条隧道规范 + Worker v7.4只读前3条"
log "零成本 · 零绑卡 · 纯免费"
log "================================================"

# 0. 清理之前所有守护旧进程
log "① 清理历史守护进程..."
pkill -9 -f "never-die-guard\|daemon-watchdog\|tunnel-keeper\|keep-alive" 2>/dev/null
pkill -9 -f "ssh.*pinggy\|ssh.*serveo\|ssh.*localhost.run" 2>/dev/null
sleep 4
ok "  清理完成"

# 1. node_modules完整性
log "② node_modules完整性检查..."
KEY_PKGS=(express better-sqlite3 jsonwebtoken bcryptjs cors multer compression)
BAD=0
for PKG in "${KEY_PKGS[@]}"; do
  if [ -d "$WORK_DIR/node_modules/$PKG" ]; then
    true
  else
    warn "  缺失 $PKG，准备重装..."
    BAD=$((BAD+1))
  fi
done
if [ $BAD -gt 0 ] || [ ! -d "$WORK_DIR/node_modules/better-sqlite3/build/Release" ]; then
  warn "  执行 npm install (最多4分钟)..."
  rm -rf node_modules 2>/dev/null
  rm -f package-lock.json 2>/dev/null
  timeout 300 npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -5 | while read L; do log "    $L"; done
  ok "  npm install 完成"
fi
ok "  关键依赖共${#KEY_PKGS[@]}个全部存在"

# 2. 启动后端
log "③ 启动 Node.js 后端 (端口3001)..."
pkill -9 -f "node.*server/index\|tsx.*server" 2>/dev/null
sleep 2
nohup npx tsx server/index.ts &> "$TMP_DIR/backend.log" < /dev/null &
BPID=$!
log "  后端PID=$BPID"
sleep 10
BACK_OK=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:3001/__zg_health 2>/dev/null)
if [ "$BACK_OK" = "200" ]; then
  ok "  后端启动成功 localhost:3001/__zg_health=200"
else
  err "  后端HTTP=$BACK_OK，查看日志 tail -30 $TMP_DIR/backend.log"
fi

# 3. 启动tunnel-keeper v5 (严格3条+55分钟刷新+自动推GitHub)
log "④ 启动 tunnel-keeper v5 (严格3条Pinggy a节点)..."
chmod +x "$WORK_DIR/tunnel-keeper.sh"
nohup bash "$WORK_DIR/tunnel-keeper.sh" &> "$TMP_DIR/tkeeper_v5.log" < /dev/null &
TK_PID=$!
log "  tunnel-keeper PID=$TK_PID  日志=$TMP_DIR/tkeeper_v5.log"

# 4. 启动keep-alive v5 (心跳+熔断+后端保活)
log "⑤ 启动 keep-alive v5 (每60s心跳+连续3次熔断)..."
chmod +x "$WORK_DIR/keep-alive.sh"
nohup bash "$WORK_DIR/keep-alive.sh" &> "$TMP_DIR/keepalive_v5.log" < /dev/null &
KA_PID=$!
log "  keep-alive PID=$KA_PID  日志=$TMP_DIR/keepalive_v5.log"

# 5. 等待隧道出URL (最多45秒)
log "⑥ 等隧道出URL (最多45秒)..."
sleep 45

# 6. 收集+测活+打印
log "⑦ 验收集群状态..."
echo ""
CAND=()
if [ -f "$WORK_DIR/tunnel-url.txt" ]; then
  while read U; do [ -n "$U" ] && CAND+=("$U"); done < "$WORK_DIR/tunnel-url.txt"
fi
for i in 1 2 3; do
  f="$TMP_DIR/tk_tun_${i}.log"
  [ -f "$f" ] || continue
  while read U; do [ -n "$U" ] && CAND+=("$U"); done < <(grep -oE "https://[a-zA-Z0-9-]+\.pinggy[a-z0-9._/-]+" "$f" 2>/dev/null | grep -v dashboard | sort -u)
done
CAND=($(printf "%s\n" "${CAND[@]}" | sort -u))
LIVE=()
for U in "${CAND[@]}"; do
  C1=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/__zg_health" 2>/dev/null)
  C2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 7 "$U/login" 2>/dev/null)
  SHORT=$(echo "$U" | sed 's|https://||;s|\..*||')
  if [ "$C1" = "200" ] && [ "$C2" = "200" ]; then
    ok "  双200 $SHORT (zg=$C1 login=$C2)  →  $U"
    LIVE+=("$U")
  else
    warn "  $SHORT  zg=$C1 login=$C2  →  $U"
  fi
done
echo ""

# 7. 打印总结
ok "三层守护全部启动完成！"
echo "  · 后端进程       PID=$BPID  HTTP=$BACK_OK"
echo "  · tunnel-keeper  PID=$TK_PID  (每60s巡检×每55分钟滚动刷新×自动推GitHub)"
echo "  · keep-alive     PID=$KA_PID  (每60s心跳×连续3次熔断5分钟)"
echo "  · 活隧道数       ${#LIVE[@]}/${#CAND[@]}"
echo ""
if [ "${#LIVE[@]}" -ge 2 ]; then
  ok "GitHub tunnel-url.txt 当前内容:"
  cat "$WORK_DIR/tunnel-url.txt" 2>/dev/null || warn "(空)"
else
  warn "⚠️  活隧道不足2条，tunnel-keeper会在60s内自动重建！最多等2分钟就会好！"
fi
echo ""
warn "【您还需要做1步】30秒部署 Worker v7.4 到 Cloudflare："
echo "  1. dash.cloudflare.com → Workers & Pages → xkzg-de5-net → Edit code"
echo "  2. 打开文件: worker.js (v7.4-20260806-3RULE-4VENDOR-STRICT)"
echo "  3. 全选复制 → 粘贴到CF → 点Deploy → 验证 xkzg.de5.net/login ≠ 急救箱"
echo ""
ok "零成本·零绑卡·纯免费·自动滚动刷新·独立运行不用找我！"
