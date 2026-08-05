#!/bin/bash
# start-all.sh - 追光平台全量启动脚本（进程守护版）
# 同时启动 Node.js 后端 + pinggy 隧道守护，崩溃自动重启
# 用法：bash start-all.sh          前台运行（可 Ctrl+C 停止）
#       nohup bash start-all.sh &  后台运行

cd /workspace
APP_LOG="/tmp/zhuiguang-app.log"
TUNNEL_LOG="/tmp/tunnel-keeper.log"
PID_DIR="/tmp/zhuiguang-pids"
mkdir -p "$PID_DIR"

# 加载 .env 环境变量（隧道守护需要 GITHUB_TOKEN）
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# 自动检查并安装依赖（环境重置后 node_modules 可能被清空）
# 关键依赖列表：缺任意一个就触发 npm install（更精准）
CRITICAL_DEPS=(
  "dotenv/lib/main.js"
  "express/index.js"
  "better-sqlite3/build/Release/better_sqlite3.node"
  "better-sqlite3"
  "jsonwebtoken"
  "bcryptjs"
  "cors"
  "multer"
  "axios"
  "cheerio"
  "marked"
  "@supabase/supabase-js"
  "xlsx"
)
need_install=0
for dep in "${CRITICAL_DEPS[@]}"; do
  if [ ! -d "node_modules/$dep" ] && [ ! -f "node_modules/$dep" ]; then
    echo "$(date '+%H:%M:%S') [init] 关键依赖缺失: $dep"
    need_install=1
  fi
done
if [ $need_install -eq 1 ]; then
  echo "$(date '+%H:%M:%S') [init] 触发 npm install --production ..."
  npm install --production 2>&1 | tail -5
  echo "$(date '+%H:%M:%S') [init] 依赖安装完成"
fi
# 二次验证：express + better-sqlite3 必须存在
if [ ! -d "node_modules/express" ] || [ ! -d "node_modules/better-sqlite3" ]; then
  echo "$(date '+%H:%M:%S') [init] ⚠️ 二次验证仍失败，强制完整重装..."
  rm -rf node_modules package-lock.json
  npm install --production 2>&1 | tail -10
fi

# 停止旧进程
stop_old() {
  for name in app tunnel keepalive; do
    pidf="$PID_DIR/$name.pid"
    if [ -f "$pidf" ]; then
      old=$(cat "$pidf")
      if kill -0 "$old" 2>/dev/null; then
        echo "$(date '+%H:%M:%S') 停止旧 $name 进程 (PID: $old)"
        kill "$old" 2>/dev/null
        sleep 2
        kill -9 "$old" 2>/dev/null
      fi
      rm -f "$pidf"
    fi
  done
  pkill -f "tsx server/index.ts" 2>/dev/null
  pkill -f "tunnel-keeper.sh" 2>/dev/null
  pkill -f "keep-alive.sh" 2>/dev/null
  sleep 1
}

# 守护函数：崩溃后自动重启
guard() {
  local name="$1"
  local cmd="$2"
  local logfile="$3"
  while true; do
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] 启动..." >> "$logfile"
    eval "$cmd" &
    local pid=$!
    echo "$pid" > "$PID_DIR/$name.pid"
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] 运行中 (PID: $pid)" >> "$logfile"
    wait "$pid"
    local code=$?
    echo "$(date '+%Y-%m-%d %H:%M:%S') [$name] 退出 (code: $code)，3秒后重启..." >> "$logfile"
    sleep 3
  done
}

stop_old
echo "$(date '+%Y-%m-%d %H:%M:%S') ===== 追光平台启动 ====="

# 启动后端服务（延迟2秒，确保端口释放）
sleep 2
guard "app" "/workspace/node_modules/.bin/tsx server/index.ts" "$APP_LOG" &
APP_GUARD_PID=$!

# 等待后端就绪
sleep 5

# 启动隧道守护
guard "tunnel" "/bin/bash /workspace/tunnel-keeper.sh" "$TUNNEL_LOG" &
TUNNEL_GUARD_PID=$!

# 启动保活脚本
guard "keepalive" "/bin/bash /workspace/keep-alive.sh" "/tmp/keep-alive.log" &
KEEPALIVE_GUARD_PID=$!

echo "后端守护 PID: $APP_GUARD_PID (日志: $APP_LOG)"
echo "隧道守护 PID: $TUNNEL_GUARD_PID (日志: $TUNNEL_LOG)"
echo "保活守护 PID: $KEEPALIVE_GUARD_PID (日志: /tmp/keep-alive.log)"
echo "停止: kill $APP_GUARD_PID $TUNNEL_GUARD_PID $KEEPALIVE_GUARD_PID"

# 捕获 Ctrl+C
trap "echo '正在停止...'; kill $APP_GUARD_PID $TUNNEL_GUARD_PID $KEEPALIVE_GUARD_PID 2>/dev/null; stop_old; exit 0" INT TERM

# 保持前台运行
wait
