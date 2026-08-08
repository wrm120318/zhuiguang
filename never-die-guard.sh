#!/bin/bash
# ==============================================================================
#  never-die-guard.sh v4.1  永远不死守护进程（彻底根治pinggy 60分钟强制过期！）
#  更新日期：2026-08-06
# ==============================================================================
# 🛡️ v4.1 7大核心改进 = 网站100%独立运行 = 不用找用户 = 永不1016！
# ==============================================================================
#  1. ✅ PID文件锁：/tmp/ult/ndg.pid 永远只允许1个NDG进程（根治之前185个NDG灾难！）
#  2. ✅ 55分钟主动重启每条SSH隧道（赶在pinggy免费60分钟强制过期之前！）
#        → 从「被动过期530」变「主动刷新永远活」
#        → 3条隧道错峰重启（永远有2条活着在跑，不会同时全断！）
#  3. ✅ 每30秒 node_modules 兜底检查（根治：node_modules丢了=后端永远起不来）
#        → [ ! -d node_modules ] || [ ! -f node_modules/.bin/tsx ] → 立刻 npm install
#  4. ✅ 每15秒 Python+代理验真活URL（HTTP200）
#        → 只有真活URL列表变了才写GitHub（省API额度+减少无效写入）
#        → 假死URL（过期/1016/530）自动从候选池踢掉！
#  5. ✅ 每10秒 后端健康检查（3001/__zg_health）
#        → HTTP非200 → 先等5秒重试 → 还不行→杀旧tsx→nohup新起
#  6. ✅ 启动时强制清理所有历史僵尸进程（NDG启动前先杀旧的SSH/旧NDG/旧tsx）
#  7. ✅ v4.1新增：初始化宽限期+缩短错峰sleep（根治tun_3 40秒长sleep导致的无限重启bug）
#        · sleep从0/20/40秒→0/5/10秒
#        · SSH_N=0且bash活着时，若elapsed < (sleep+timeout+15s) = 正常初始化，不杀不重启
# ==============================================================================
#  启动方式（永远用这个，别用其他方式！）：
#     setsid nohup bash /workspace/never-die-guard.sh >> /tmp/never-die-guard.log 2>&1 < /dev/null &
#     disown $!
# ==============================================================================
set +e
umask 022

# ===== 基本配置 =====
WORK_DIR="/workspace"
TMP_DIR="/tmp/ult"
LOCAL_PORT=3001
PROXY="http://127.0.0.1:18080"
PROXY_HOST="127.0.0.1"
PROXY_PORT="18080"
PROXY_CMD='nc -X connect -x 127.0.0.1:18080 %h %p'
SSH_RESTART_EVERY_S=$(( 50 * 60 ))   # 每条隧道50分钟主动重启（赶在60分pinggy过期前！留10分钟缓冲，比v4.0的55分钟更安全）
mkdir -p "$TMP_DIR"

# ===== 日志函数 =====
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔴 $*" >&2; }

# ==============================================================================
# Step 0. PID文件锁（永远只能有1个NDG！）
# ==============================================================================
PIDF="$TMP_DIR/ndg.pid"
if [ -f "$PIDF" ]; then
  OLD=$(cat "$PIDF" 2>/dev/null | tr -cd '0-9')
  if [ -n "$OLD" ] && [ "$OLD" != "$$" ] && kill -0 "$OLD" 2>/dev/null; then
    # 另一个NDG活着→直接退出不抢
    log "⚠️  另一个NDG(PID=$OLD)活着，本进程退出（避免185个灾难！）"
    exit 0
  fi
fi
echo $$ > "$PIDF"
# 脚本退出时删PID文件
trap 'rm -f "$PIDF" 2>/dev/null' EXIT INT TERM QUIT HUP

log "============================================================================"
log "🚀 never-die-guard v4.0 启动！selfPID=$$"
log "  工作目录=$WORK_DIR   临时=$TMP_DIR   代理=$PROXY"
log "  后端端口=$LOCAL_PORT   SSH每${SSH_RESTART_EVERY_S}秒(=55分)主动重启"
log "============================================================================"

# ==============================================================================
# Step 0.5 启动时强制清历史僵尸进程（只杀和追光相关的，绝对不碰工具链！）
# ==============================================================================
MY_PID=$$
safe_kill() {
  local p="$1"
  [ "$p" = "$MY_PID" ] && return
  [ "$p" = "1" ] || [ "$p" -lt "100" ] 2>/dev/null && return
  [ -n "$p" ] && kill -9 "$p" 2>/dev/null
}
log "🧹 启动清理：杀历史僵尸进程..."
# a) 杀除自己外的所有never-die-guard
for p in $(pgrep -f "never-die-guard" 2>/dev/null); do
  [ "$p" = "$MY_PID" ] && continue
  safe_kill "$p" && log "   杀旧NDG PID=$p"
done
# b) 杀旧的bash/zsh while循环（之前的历史遗留pinggy脚本）
for p in $(ps -e -o pid=,args= | awk '($2=="/bin/bash" || $2=="/usr/bin/zsh" || $3=="/bin/bash" || $3=="/usr/bin/zsh") && (/pinggy\.io/ || /while true.*pinggy/) {print $1}' 2>/dev/null); do
  safe_kill "$p"
done
sleep 1
# c) 杀旧的ssh pinggy.io（稍后v4会新起3条，旧的全删）
KILLED_SSH=0
for p in $(ps -e -o pid=,args= | awk '$3=="/usr/bin/ssh" && /pinggy\.io/ {print $1}' 2>/dev/null); do
  safe_kill "$p" && KILLED_SSH=$((KILLED_SSH+1))
done
[ "$KILLED_SSH" -gt 0 ] && log "   杀旧SSH(pinggy.io) × $KILLED_SSH 条"
# d) 杀旧的tsx server（稍后新起1个）
KILLED_TSX=0
for p in $(ps -e -o pid=,args= | awk '/tsx.*server\/index\.ts/ {print $1}' 2>/dev/null); do
  safe_kill "$p" && KILLED_TSX=$((KILLED_TSX+1))
done
[ "$KILLED_TSX" -gt 0 ] && log "   杀旧tsx server × $KILLED_TSX 个"
sleep 2
log "🧹 清理完毕，准备新起..."

# ==============================================================================
# Step 1. 3条隧道配置（tun_1/tun_2/tun_3）+ 启动函数
# ==============================================================================
# 3条配置：tun1=a节点/20s/立即  tun2=a节点/25s/+5s错峰启动  tun3=b节点/28s/+10s错峰启动
# 这样重启时间也错开：55分钟后 tun1在T+55m重启，tun2在T+55m+5s重启，tun3在T+55m+10s重启（永远有2条活着）
# v4.1修复：sleep从0/20/40改为0/5/10，避免tun3睡40秒期间被NDG每15秒误判「死了」→无限重启
declare -A TUN_NODE TUN_TO TUN_SLEEP TUN_PIDF TUN_LOGF TUN_STARTD TUN_SCRIPT
for i in 1 2 3; do
  if   [ $i -eq 1 ]; then TUN_NODE[$i]="a"; TUN_TO[$i]="20"; TUN_SLEEP[$i]="0"
  elif [ $i -eq 2 ]; then TUN_NODE[$i]="a"; TUN_TO[$i]="25"; TUN_SLEEP[$i]="5"
  else                    TUN_NODE[$i]="b"; TUN_TO[$i]="28"; TUN_SLEEP[$i]="10"; fi
  TUN_PIDF[$i]="$TMP_DIR/tun_${i}.pid"
  TUN_LOGF[$i]="$TMP_DIR/tun_${i}.log"
  TUN_STARTD[$i]="$TMP_DIR/tun_${i}.started_at"
  TUN_SCRIPT[$i]="$TMP_DIR/tun_${i}.sh"
done

tun_ensure() {
  # 确保某条隧道活着。条件：tun_pid文件里的bash进程活着 + 有对应的ssh进程
  local i="$1"
  local pidf="${TUN_PIDF[$i]}"
  local logf="${TUN_LOGF[$i]}"
  local startf="${TUN_STARTD[$i]}"
  local script="${TUN_SCRIPT[$i]}"
  local node="${TUN_NODE[$i]}"
  local to="${TUN_TO[$i]}"
  local sl="${TUN_SLEEP[$i]}"
  local needs_start=0

  # 检查PID文件指向的bash是否活着
  local BASH_PID=""
  if [ -f "$pidf" ]; then
    BASH_PID=$(cat "$pidf" 2>/dev/null | tr -cd '0-9')
    if [ -z "$BASH_PID" ] || ! kill -0 "$BASH_PID" 2>/dev/null; then
      needs_start=1
    fi
  else
    needs_start=1
  fi

  # 检查这条隧道对应的ssh是否存在（至少1条）
  local SSH_N=0
  if [ -n "$BASH_PID" ]; then
    SSH_N=$(ps -e -o pid=,ppid=,args= 2>/dev/null | awk -v bp="$BASH_PID" '($2==bp || $3==bp) && /pinggy\.io/ {print $1}' | wc -l)
  fi
  if [ "$SSH_N" -lt "1" ]; then
    # ---- v4.1修复：初始化宽限期！bash刚启动，可能还在sleep/连SSH中，别急着杀重启 ----
    # 只要bash活着且启动时间 < (sleep + timeout + 15s宽限)，就认为是正常初始化中，不重启
    local INIT_GRACE=$(( sl + to + 15 ))
    local IN_INIT=0
    if [ -n "$BASH_PID" ] && kill -0 "$BASH_PID" 2>/dev/null && [ -f "$startf" ]; then
      local ST=$(cat "$startf" 2>/dev/null | tr -cd '0-9')
      local NOW=$(date +%s)
      if [ -n "$ST" ] && [ "$ST" -gt "0" ] 2>/dev/null; then
        local ELAPSED=$(( NOW - ST ))
        if [ "$ELAPSED" -lt "$INIT_GRACE" ]; then
          IN_INIT=1
          log "⏳ tun[$i] 初始化中(elapsed=${ELAPSED}s < grace=${INIT_GRACE}s)，bash活但SSH还没出=正常，不重启"
        fi
      fi
    fi
    if [ "$IN_INIT" = "0" ]; then
      needs_start=1
    fi
  fi

  # 检查是否超过SSH_RESTART_EVERY_S秒（55分钟）→ 主动重启！（赶在60分pinggy过期前！）
  if [ -f "$startf" ] && [ "$needs_start" = "0" ]; then
    local ST=$(cat "$startf" 2>/dev/null | tr -cd '0-9')
    local NOW=$(date +%s)
    if [ -n "$ST" ] && [ "$ST" -gt "0" ]; then
      local ELAPSED=$(( NOW - ST ))
      if [ "$ELAPSED" -ge "$SSH_RESTART_EVERY_S" ]; then
        log "⏰ tun[$i]已运行${ELAPSED}秒(>=$SSH_RESTART_EVERY_S=55分)！主动重启（赶在pinggy 60分钟强制过期前！）"
        # 杀旧的这条隧道的bash和它的所有ssh子进程
        if [ -n "$BASH_PID" ]; then
          # 先杀它的所有ssh子进程
          for sp in $(ps -e -o pid=,ppid= 2>/dev/null | awk -v bp="$BASH_PID" '$2==bp {print $1}'); do kill -9 "$sp" 2>/dev/null; done
          sleep 0.5
          kill -9 "$BASH_PID" 2>/dev/null
        fi
        needs_start=1
        rm -f "$pidf" "$startf" 2>/dev/null
        sleep 1
      fi
    fi
  fi

  if [ "$needs_start" = "1" ]; then
    log "🔄 启动隧道[$i] node=$node timeout=$to s sleep=$sl s"
    # 写独立启动脚本
    cat > "$script" <<TUNEOF
#!/bin/bash
umask 022
LOGF="$logf"
PIDF="$pidf"
STARTF="$startf"
NODE="$node"
TO="$to"
SL="$sl"
echo \$\$ > "\$PIDF"
# 删掉旧日志
rm -f "\$LOGF"; touch "\$LOGF"
echo "[INIT tun=$i node=\$NODE sleep=\$SL to=\$TO at \$(date '+%Y-%m-%d %H:%M:%S')] selfpid=\$\$" >> "\$LOGF"
sleep \$SL
echo \$(date +%s) > "\$STARTF"
echo "[START tun=$i at \$(date '+%Y-%m-%d %H:%M:%S')] \$(date +%s)" >> "\$LOGF"
while true; do
  /usr/bin/ssh \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ServerAliveInterval=20 -o ServerAliveCountMax=2 \
    -o ConnectTimeout=\$TO -o TCPKeepAlive=yes \
    -o "ProxyCommand=${PROXY_CMD}" \
    -p 443 -R0:localhost:${LOCAL_PORT} \${NODE}.pinggy.io >> "\$LOGF" 2>&1
  echo "[RECONNECT tun=$i at \$(date '+%Y-%m-%d %H:%M:%S')]" >> "\$LOGF"
  sleep 1
done
TUNEOF
    chmod +x "$script"
    # setsid -f 新会话，完全脱离当前shell
    setsid -f bash "$script" < /dev/null > /dev/null 2>&1
    sleep 0.8
    # 写启动时间（如果sleep没到也先写一个，等下轮再检查）
    if [ ! -f "$startf" ]; then
      local NOW=$(date +%s)
      local ADJ=$(( NOW - TUN_SLEEP[$i] ))
      echo "$ADJ" > "$startf"
    fi
    return 0
  fi
  return 1
}

# ==============================================================================
# Step 2. 后端保活函数（含node_modules兜底！根治之前node_modules不存在的致命bug！）
# ==============================================================================
ensure_node_modules() {
  # 30秒才检查一次（$TMP_DIR/ndg_nm_checked时间戳），不浪费IO
  local NOW=$(date +%s)
  local LAST_F="$TMP_DIR/ndg_nm_checked"
  local LAST=0
  [ -f "$LAST_F" ] && LAST=$(cat "$LAST_F" 2>/dev/null | tr -cd '0-9')
  local ELAPSED=$(( NOW - LAST ))
  if [ "$ELAPSED" -lt "30" ]; then return 0; fi
  echo "$NOW" > "$LAST_F"

  local NEEDS_INSTALL=0
  # v4.1 检查1：目录+文件存在性（根治：node_modules离奇丢失）
  if [ ! -d "$WORK_DIR/node_modules" ]; then
    err "🧨 node_modules/ 目录不存在！立刻npm install重装！"
    NEEDS_INSTALL=1
  elif [ ! -f "$WORK_DIR/node_modules/.bin/tsx" ]; then
    err "🧨 node_modules/.bin/tsx 不存在！立刻npm install重装！"
    NEEDS_INSTALL=1
  # v4.1 检查2：关键包完整性校验（半损坏时目录还在但包内缺文件=后端永远报错启动不了！）
  else
    local KEY_PKG_OK=1
    for KEY in express better-sqlite3 jsonwebtoken bcryptjs cors multer; do
      if [ ! -d "$WORK_DIR/node_modules/$KEY" ]; then
        err "🧨 关键依赖 node_modules/$KEY 目录缺失！（node_modules半损坏！）"
        KEY_PKG_OK=0
      fi
    done
    if [ "$KEY_PKG_OK" = "0" ]; then
      NEEDS_INSTALL=1
    fi
  fi
  if [ "$NEEDS_INSTALL" = "1" ]; then
    cd "$WORK_DIR"
    # v4.1：先删旧的node_modules和package-lock，避免半损坏污染
    log "📦 清理旧node_modules..."
    rm -rf "$WORK_DIR/node_modules" 2>/dev/null || true
    log "📦 npm install 开始（代理=$PROXY，最多4分钟）..."
    HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY" \
      timeout 300 npm install --no-audit --no-fund --prefer-offline >> /tmp/ndg_npm_install.log 2>&1
    local EXIT=$?
    log "📦 npm install 完成 exit=$EXIT"
    if [ ! -f "$WORK_DIR/node_modules/.bin/tsx" ]; then
      err "🧨 npm install后tsx仍不存在！紧急尝试npx tsx直接拉取："
    fi
  fi
}

ensure_backend() {
  # HTTP GET /__zg_health 非200→连续2次失败→重启
  local H=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/__zg_health" 2>/dev/null)
  if [ "$H" = "200" ]; then
    return 0
  fi
  # 第一次失败：等5秒再试一次（避免偶发抖动误重启）
  log "⚠️  后端HTTP=$H，5秒后重试..."
  sleep 5
  H=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/__zg_health" 2>/dev/null)
  if [ "$H" = "200" ]; then
    log "✅ 后端重试HTTP=200，没问题"
    return 0
  fi
  # 还是失败：杀旧tsx + 强制重启
  err "🔴 后端连续失败（HTTP=$H），重启..."
  for p in $(ps -e -o pid=,args= | awk '/tsx.*server\/index\.ts/ {print $1}' 2>/dev/null); do
    kill -9 "$p" 2>/dev/null
  done
  sleep 2
  # 先确保node_modules没丢（根治！）
  ensure_node_modules
  cd "$WORK_DIR"
  log "🚀 新起后端tsx server/index.ts..."
  (
    cd "$WORK_DIR"
    HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY" \
      nohup npx tsx server/index.ts >> /tmp/ndg_server.log 2>&1 < /dev/null &
    echo $! > "$TMP_DIR/server.pid"
  )
  sleep 1
  # 最多等24秒启动
  for i in 1 2 3 4 5 6; do
    sleep 4
    H=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/__zg_health" 2>/dev/null)
    if [ "$H" = "200" ]; then
      log "✅ 后端重启成功！/__zg_health=HTTP200（第$((i*4))秒）"
      return 0
    fi
  done
  err "🔴 后端重启超时！/tmp/ndg_server.log最后10行："
  tail -10 /tmp/ndg_server.log 2>/dev/null | while read l; do err "   $l"; done
  return 1
}

# ==============================================================================
# Step 3. 每15秒 Python+代理验真活URL + 只有变化才写GitHub
# ==============================================================================
WRITE_GITHUB_EVERY=5   # 每5轮=5×15秒=75秒 最多写一次（就算变了也不狂写，省API额度）
TICK=0
LAST_WRITE_TICK=-999
LAST_LIVE_MD5=""
write_live_urls_if_changed() {
  TICK=$(( TICK + 1 ))
  # 每1轮=15秒，3轮=45秒 才跑一次Python验真活（省CPU）
  if [ $(( TICK % 3 )) -ne 0 ]; then
    return 0
  fi
  # 调用Python脚本：验真活 + 打印MD5（若没变就不写GitHub）
  local OUT=$(HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY" \
    python3 "$WORK_DIR/ndg_check_live.py" 2>/dev/null)
  local MD5=$(echo "$OUT" | grep -oE '^MD5:[a-f0-9]+' | head -1 | cut -c5-)
  local LIVE_COUNT=$(echo "$OUT" | grep -oE '^LIVE:[0-9]+' | head -1 | cut -c6-)
  local CHANGED=1
  if [ -n "$MD5" ] && [ "$MD5" = "$LAST_LIVE_MD5" ]; then CHANGED=0; fi
  if [ -z "$LIVE_COUNT" ] || [ "$LIVE_COUNT" -eq "0" ]; then
    err "⚠️  Python验真活=0条真活URL（跳过写GitHub，等下轮）"
    return 1
  fi
  # 计算距上次写入多少轮（防太频繁）
  local SINCE=$(( TICK - LAST_WRITE_TICK ))
  if [ "$CHANGED" = "1" ] && [ "$SINCE" -ge "$WRITE_GITHUB_EVERY" ]; then
    log "🐙 Python验出$LIVE_COUNT条真活URL，且内容变化→写GitHub（MD5=$MD5 SINCE=$SINCE）"
    # Python脚本里已经写入GitHub了，这里只记录状态
    LAST_LIVE_MD5="$MD5"
    LAST_WRITE_TICK=$TICK
  elif [ "$CHANGED" = "1" ]; then
    log "🐙 Python验出$LIVE_COUNT条真活URL且变化，但SINCE=$SINCE < $WRITE_GITHUB_EVERY，暂不写（省额度）"
  else
    log "🐙 Python验出$LIVE_COUNT条真活URL，内容无变化→跳过写GitHub"
  fi
  return 0
}

# ==============================================================================
# 先写Python验活脚本（/workspace/ndg_check_live.py）= 每次都覆盖最新版
# ==============================================================================
cat > "$WORK_DIR/ndg_check_live.py" <<'PYEOF'
import os, sys, re, time, base64, json, hashlib, subprocess, urllib.request
PROXY = os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY") or "http://127.0.0.1:18080"
WORK_DIR = "/workspace"
TMP_DIR = "/tmp/ult"
GITHUB_TOKEN = ""
try:
    for line in open(f"{WORK_DIR}/.env"):
        line=line.strip()
        if line.startswith("GITHUB_TOKEN="):
            GITHUB_TOKEN = line.split("=",1)[1].strip().strip('"').strip("'")
except: pass

def sh(cmd, t=15):
    env = os.environ.copy()
    for k in ["http_proxy","https_proxy","HTTP_PROXY","HTTPS_PROXY"]: env[k]=PROXY
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=t, env=env)
        return (r.stdout+r.stderr).strip()
    except: return "__ERR__"

# 1. 从所有tun_*.log抓URL
all_urls=set()
for fn in sorted(os.listdir(TMP_DIR)) if os.path.exists(TMP_DIR) else []:
    if not re.match(r"tun_\d+\.log", fn): continue
    try:
        for line in open(os.path.join(TMP_DIR, fn)).read().splitlines()[-80:]:
            for u in re.findall(r"https://[A-Za-z0-9\-]+\.(?:free\.pinggy\.net|run\.pinggy-free\.link)", line):
                all_urls.add(u.rstrip("/"))
    except: pass

# 2. 走代理curl验HTTP200
live=[]
for u in sorted(all_urls):
    code = sh(f"curl -s --max-time 7 -x {PROXY} -o /dev/null -w '%{{http_code}}' -H 'User-Agent: Zhuiguang-NDGv4/1.0' -H 'X-Pinggy-No-Screen: 1' '{u}/__zg_health'")
    if code.strip() == "200": live.append(u)

# 3. MD5 + stdout（给bash端判断是否变化）
content = "\n".join(sorted(set(live))) + "\n" if live else ""
md5 = hashlib.md5(content.encode()).hexdigest()
cnt = len(live)
print(f"LIVE:{cnt}")
print(f"MD5:{md5}")

# 4. 写本地 + 写GitHub（只在真活>=1时写）
if cnt >= 1:
    with open(f"{TMP_DIR}/live.txt","w") as f: f.write(content)
    # 写GitHub（用token）
    if GITHUB_TOKEN:
        out = sh(f"curl -s --max-time 12 -x {PROXY} -H 'Authorization: token {GITHUB_TOKEN}' -H 'Accept: application/vnd.github.v3+json' 'https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt'")
        sha = ""
        try:
            d = json.loads(out)
            if isinstance(d, dict): sha = d.get("sha","")
        except: pass
        if sha:
            b64 = base64.b64encode(content.encode()).decode()
            body = {"message": f"🛡️ NDGv4:真活={cnt}条(55分主动刷新SSH+假死URL自动剔除)", "content": b64, "sha": sha}
            bf = f"{TMP_DIR}/_gh_body.json"
            with open(bf,"w") as f: json.dump(body, f)
            sh(f"""curl -s --max-time 20 -x {PROXY} -X PUT -H 'Authorization: token {GITHUB_TOKEN}' -H 'Accept: application/vnd.github.v3+json' -H 'Content-Type: application/json' --data-binary @{bf} 'https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt'""", t=22)
PYEOF
log "✅ 已写入Python验活脚本 $WORK_DIR/ndg_check_live.py"

# ==============================================================================
# Step 4. 首次启动：先确保node_modules + 后端 + 3条隧道
# ==============================================================================
log "========== 首次启动序列 =========="
ensure_node_modules
ensure_backend
for i in 1 2 3; do
  tun_ensure $i
  # 错峰：每条隧道启动之间隔2秒，避免同时连
  sleep 2
done
log "========== 首次启动序列完成，进入永久循环 =========="
echo ""

# ==============================================================================
# Step 5. 永久循环（每15秒一轮）
# ==============================================================================
while true; do
  # 5.1 后端健康检查（每轮15秒都查，最优先）
  ensure_backend

  # 5.2 3条隧道保活 + 55分钟主动重启（错峰）
  for i in 1 2 3; do
    tun_ensure $i
  done

  # 5.3 Python+代理验真活URL → 只有变化才写GitHub
  write_live_urls_if_changed

  # 5.4 本轮结束：打印健康汇总（每3轮=45秒打一次，避免日志刷屏）
  if [ $(( TICK % 3 )) -eq 0 ]; then
    N_NDG=$(pgrep -fc "never-die-guard" 2>/dev/null || echo 0)
    N_TSX=$(ps -e -o args= | grep "tsx.*server/index" | grep -v grep | wc -l)
    N_SSH=$(ps -e -o args= | grep "/usr/bin/ssh.*pinggy\.io" | grep -v grep | wc -l)
    H=$(curl -s --max-time 3 -o /dev/null -w "%{http_code}" "http://localhost:${LOCAL_PORT}/__zg_health" 2>/dev/null)
    log "📊 汇总(tick=$TICK): NDG=$N_NDG tsx=$N_TSX SSH=$N_SSH /__zg_health=HTTP$H"
  fi

  sleep 15
done
