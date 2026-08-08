#!/bin/bash
# /etc/rc.local - 追光学科共享平台 开机自启脚本
# 作用：系统重启后 60秒内 自动恢复后端 + 3条SSH隧道 + NDG守护
# 包含：node_modules丢失自动重装（根治之前重启后永远起不来的致命bug！）
# 
# 启用方式（如果是systemd系统，首次需要执行）：
#   chmod +x /etc/rc.local
#   systemctl enable rc-local 2>/dev/null || true
#   systemctl start rc-local  2>/dev/null || true
#
# 更新日期：2026-08-06  NDG v4.0 配套
# ==============================================================================
set +e
umask 022

LOGF="/var/log/zhuiguang-boot.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] rc.local 开始执行（追光开机自启）" >> "$LOGF" 2>&1

WORK_DIR="/workspace"
TMP_DIR="/tmp/ult"
PROXY="http://127.0.0.1:18080"
LOCAL_PORT=3001
mkdir -p "$TMP_DIR"

# 1. 等待代理和网络（最多等60秒，云启动慢时需要）
READY=0
for i in $(seq 1 30); do
  if curl -s --max-time 5 -x "$PROXY" -o /dev/null -w "%{http_code}" https://www.baidu.com 2>/dev/null | grep -q "200"; then
    READY=1
    echo "[$(date '+%H:%M:%S')] 代理+网络OK（第$((i*2))秒）" >> "$LOGF" 2>&1
    break
  fi
  sleep 2
done
if [ "$READY" = "0" ]; then
  echo "[$(date '+%H:%M:%S')] ⚠️  60秒内代理没好，硬着头皮继续（可能是内网环境）..." >> "$LOGF" 2>&1
fi

# 2. node_modules 兜底检查（根治：重启后node_modules离奇丢失的bug！）
cd "$WORK_DIR"
if [ ! -d node_modules ] || [ ! -f node_modules/.bin/tsx ]; then
  echo "[$(date '+%H:%M:%S')] 🧨 node_modules/缺失！执行npm install重装（最多4分钟）..." >> "$LOGF" 2>&1
  HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY" \
    timeout 240 npm install --no-audit --no-fund --prefer-offline >> "$LOGF" 2>&1
  echo "[$(date '+%H:%M:%S')] npm install 完成，exit=$?" >> "$LOGF" 2>&1
fi

# 3. 确保有ndg_check_live.py（如果没的话先占位，NDG启动时会覆盖最新版）
if [ ! -f "$WORK_DIR/ndg_check_live.py" ]; then
  echo 'print("placeholder")' > "$WORK_DIR/ndg_check_live.py"
fi

# 4. 清理旧的NDG PID（上次关机没删干净的话）
rm -f "$TMP_DIR/ndg.pid" 2>/dev/null

# 5. 启动 never-die-guard v4.0 （终极守护：15秒循环管一切）
echo "[$(date '+%H:%M:%S')] 🚀 启动 never-die-guard v4.0..." >> "$LOGF" 2>&1
cd "$WORK_DIR"
setsid nohup bash "$WORK_DIR/never-die-guard.sh" >> /tmp/never-die-guard.log 2>&1 < /dev/null &
NDG_PID=$!
disown $NDG_PID 2>/dev/null || true
echo $NDG_PID > "$TMP_DIR/ndg_autostart.pid"
echo "[$(date '+%H:%M:%S')] NDG后台PID=$NDG_PID（等15秒后确认）" >> "$LOGF" 2>&1

# 6. 等20秒后写验收日志（给将来排障用）
(
  sleep 20
  N_NDG=$(pgrep -fc "never-die-guard" 2>/dev/null || echo 0)
  N_TSX=$(ps -e -o args= | grep "tsx.*server/index" | grep -v grep | wc -l)
  N_SSH=$(ps -e -o args= | grep "/usr/bin/ssh.*pinggy\.io" | grep -v grep | wc -l)
  H=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/__zg_health" 2>/dev/null)
  echo "[$(date '+%H:%M:%S')] ✅ 开机自启验收: NDG=$N_NDG tsx=$N_TSX SSH=$N_SSH /__zg_health=HTTP$H" >> "$LOGF" 2>&1
) &

echo "[$(date '+%Y-%m-%d %H:%M:%S')] rc.local 执行完毕（NDG后台PID=$NDG_PID）" >> "$LOGF" 2>&1
exit 0
