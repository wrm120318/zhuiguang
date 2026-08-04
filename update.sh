#!/bin/bash
# update.sh - 一键拉取GitHub最新代码 + 构建前端 + 重启服务 + 验证
# 用法：bash update.sh
# 新AI推代码到GitHub后，跑这一条命令就行

cd /workspace
LOG="/tmp/zhuiguang-update.log"
echo "$(date '+%Y-%m-%d %H:%M:%S') ===== 开始更新 =====" | tee "$LOG"

# ===== 第1步：保护本地 .env 和数据库 =====
echo ">>> [1/6] 保护本地配置和数据库..." | tee -a "$LOG"
git stash push -m "auto-stash before update" -- .env server/local.db 2>/dev/null
echo "OK" | tee -a "$LOG"

# ===== 第2步：拉取GitHub最新代码 =====
echo ">>> [2/6] 拉取GitHub最新代码..." | tee -a "$LOG"
git fetch origin main 2>&1 | tee -a "$LOG"
git reset --hard origin/main 2>&1 | tee -a "$LOG"
echo "OK" | tee -a "$LOG"

# ===== 第3步：恢复本地配置和数据库 =====
echo ">>> [3/6] 恢复本地配置和数据库..." | tee -a "$LOG"
git stash pop 2>/dev/null || echo "（无需恢复，继续）" | tee -a "$LOG"
echo "OK" | tee -a "$LOG"

# ===== 第4步：检查依赖 =====
echo ">>> [4/6] 检查依赖..." | tee -a "$LOG"
if [ ! -d node_modules/dotenv ] || [ ! -d node_modules/express ]; then
  echo "node_modules 缺失，自动安装..." | tee -a "$LOG"
  npm install --production 2>&1 | tail -3 | tee -a "$LOG"
else
  echo "依赖正常" | tee -a "$LOG"
fi

# ===== 第5步：构建前端 =====
echo ">>> [5/6] 构建前端..." | tee -a "$LOG"
npm run build 2>&1 | tail -5 | tee -a "$LOG"
if [ $? -ne 0 ]; then
  echo "❌ 构建失败！请检查代码是否有语法错误" | tee -a "$LOG"
  exit 1
fi
echo "构建完成" | tee -a "$LOG"

# ===== 第6步：重启服务 =====
echo ">>> [6/6] 重启服务..." | tee -a "$LOG"
ps aux | grep -E "start-all|tsx server|tunnel-keeper|keep-alive|ssh.*pinggy" | grep -v grep | awk '{print $2}' | xargs kill 2>/dev/null
sleep 3
nohup bash start-all.sh > /tmp/zhuiguang-start.log 2>&1 &
echo "服务启动中..." | tee -a "$LOG"
sleep 10

# ===== 验证 =====
echo "" | tee -a "$LOG"
echo "===== 验证 =====" | tee -a "$LOG"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3001/api/pages/guide 2>/dev/null)
echo "本地服务: HTTP $HTTP" | tee -a "$LOG"

TUNNEL=$(cat /tmp/tunnel-url-current 2>/dev/null)
echo "隧道URL: $TUNNEL" | tee -a "$LOG"

THTTP=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -x "http://127.0.0.1:18080" "$TUNNEL/api/pages/guide" 2>/dev/null)
echo "隧道直连: HTTP $THTTP" | tee -a "$LOG"

# ===== 检查 worker.js 是否有变化 =====
if git diff HEAD~1 HEAD --name-only 2>/dev/null | grep -q "worker.js"; then
  echo "" | tee -a "$LOG"
  echo "⚠️  注意：worker.js 有更新！需要手动去Cloudflare后台部署：" | tee -a "$LOG"
  echo "   1. 登录 Cloudflare → Workers & Pages → zhuiguang-proxy" | tee -a "$LOG"
  echo "   2. 编辑代码 → 全选替换为最新 worker.js 内容" | tee -a "$LOG"
  echo "   3. 点保存并部署" | tee -a "$LOG"
fi

echo "" | tee -a "$LOG"
if [ "$HTTP" = "200" ]; then
  echo "✅ 更新完成！打开 https://xkzg.de5.net 验证" | tee -a "$LOG"
else
  echo "❌ 服务异常，请检查日志：tail -50 /tmp/zhuiguang-app.log" | tee -a "$LOG"
fi
echo "$(date '+%Y-%m-%d %H:%M:%S') ===== 更新结束 =====" | tee -a "$LOG"
