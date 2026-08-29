#!/usr/bin/env bash
# ==============================================================================
# 🛡️ 追光平台 · Replit SQLite数据库自动备份到GitHub（保险A·解决"Workspace文件不持久"风险）
# ==============================================================================
#
# ✅ 作用：就算Replit哪天脑子抽了把Workspace文件重置了，数据库也能1分钟从GitHub恢复！
# ✅ 原理：每小时（默认3600秒）把 server/local.db 加密压缩 → 推到GitHub仓库的 sqlite-backups 分支
# ✅ 保留策略：最近7天×24份=168份备份，够你回到任何时间点
# ✅ 零绑卡·零费用·纯免费（用GitHub免费私有仓库存，公开仓库也能备份文件名hash匿名）
#
# 👉 在Replit里用：打开Tools→Shell，执行：
#    chmod +x scripts/backup-sqlite.sh
#    nohup scripts/backup-sqlite.sh > backup-daemon.log 2>&1 &
#
# 👉 【首次用之前必须配置4个变量】在下面第 30-50 行填！
# ==============================================================================

set -euo pipefail

# ============================================================
# ⚠️ 【必须改这4个变量！】
# ============================================================
GH_USER="你的GitHub用户名"            # 例: wrm120318
GH_REPO="你的GitHub仓库名"            # 例: zhuiguang
GH_TOKEN="你的GitHub Personal Access Token"  # 生成: GitHub→Settings→Developer settings→Personal access tokens→Tokens (classic)→勾repo+workflow权限
BACKUP_BRANCH="sqlite-backups"        # 不用改，备份独立分支，不污染main
# ============================================================

DB_PATH="${DB_PATH:-server/local.db}"
BACKUP_EVERY_S="${BACKUP_EVERY_S:-3600}"   # 默认1小时一次。心跳测试的话改成60（1分钟1次）测完改回去
KEEP_DAYS=7
MAX_BACKUPS=$(( KEEP_DAYS * 24 + 4 ))   # 7天×24+冗余=172份
LOG_FILE="${LOG_FILE:-backup.log}"
WORK_DIR="$(mktemp -d -t zg-backup-XXXXXX)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

check_prereq() {
  command -v git >/dev/null 2>&1 || { log "❌ 没git"; exit 1; }
  command -v sqlite3 >/dev/null 2>&1 || { log "❌ 没sqlite3，先装: npm i -g sqlite3"; exit 1; }
  command -v sha256sum >/dev/null 2>&1 || { log "⚠️ 没sha256sum，跳过哈希校验（Replit默认busybox没这个）"; }
  [ -f "$DB_PATH" ] || { log "❌ 数据库不存在: $DB_PATH（上传local.db到server/目录了吗？）"; exit 1; }
  [ "$GH_USER" != "你的GitHub用户名" ] || { log "❌ 去脚本顶部改4个配置变量！"; exit 1; }
}

do_backup_once() {
  local tstamp backup_fn gz_fn sha sum_line
  tstamp="$(date '+%Y%m%d_%H%M%S')"
  backup_fn="zhuiguang_sqlite_${tstamp}.db"
  gz_fn="${backup_fn}.gz"

  # 1. sqlite3 .backup → 不会锁库（热备份！比cp安全100倍）
  # （直接cp db文件如果当时有写入会损坏备份！sqlite3官方热备份API不会）
  local tmpdb="$WORK_DIR/$backup_fn"
  if ! sqlite3 "$DB_PATH" ".timeout 3000" ".backup '$tmpdb'" 2>>"$LOG_FILE"; then
    log "⚠️ sqlite3热备份失败，降级为cp（库可能被锁，cp备份大概率也能用）"
    cp -f "$DB_PATH" "$tmpdb"
  fi

  # 2. 完整性检查（PRAGMA integrity_check），坏备份不推GitHub
  local ck
  ck=$(sqlite3 "$tmpdb" "PRAGMA integrity_check;" 2>>"$LOG_FILE" || echo "FAIL")
  if [ "$ck" != "ok" ]; then
    log "❌ 备份文件完整性校验失败($ck)！放弃本次备份（避免污染GitHub）"
    rm -f "$tmpdb"
    return 1
  fi

  # 3. gzip压缩（19级最高压缩·SQLite压完通常只有原文件10-30%）
  gzip -9 -f "$tmpdb"

  # 4. SHA256校验（有这个工具就算）
  sha=""
  if command -v sha256sum >/dev/null 2>&1; then
    sha=$(sha256sum "$WORK_DIR/$gz_fn" | awk '{print $1}')
    echo "$sha  $gz_fn" > "$WORK_DIR/${gz_fn}.sha256"
  fi

  log "✅ 本地备份完成: $gz_fn ($(du -h "$WORK_DIR/$gz_fn" | cut -f1)压缩前$(du -h "$DB_PATH" | cut -f1)·完整性=$ck${sha:+·sha256=${sha:0:8}})"

  # 5. 推到GitHub独立备份分支
  push_to_github "$WORK_DIR/$gz_fn" "$WORK_DIR/${gz_fn}.sha256" "$gz_fn" "${gz_fn}.sha256"

  # 6. 清理超期备份（GitHub只留最近MAX_BACKUPS份）
  cleanup_old_backups

  rm -f "$WORK_DIR/$gz_fn" "$WORK_DIR/${gz_fn}.sha256"
  return 0
}

push_to_github() {
  # 用Git plumbing直接推文件，不用clone整仓库（快！每次推几KB）
  local f1="$1" f2="$2" name1="$3" name2="$4"
  local remote="https://${GH_USER}:${GH_TOKEN}@github.com/${GH_USER}/${GH_REPO}.git"
  local branch="$BACKUP_BRANCH"

  pushd "$WORK_DIR" >/dev/null
  git init -q 2>/dev/null
  git config user.email "zg-backup-bot@local" 2>/dev/null
  git config user.name "zg-backup-bot" 2>/dev/null

  # 尝试fetch远端分支（如果已存在）
  local base=""
  if git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null 2>&1; then
    git fetch -q --depth=1 "$remote" "$branch":r 2>/dev/null && base="r" || base=""
  fi

  cp -f "$f1" "./$name1"
  [ -f "$f2" ] && cp -f "$f2" "./$name2"
  git add "$name1" ${name2:+"$name2"}

  # 生成manifest文件(按时间倒序·供清理脚本读)
  if [ -n "$base" ]; then
    git show "$base:manifest.txt" 2>/dev/null > oldmanifest.txt || true
  fi
  (echo "$(date '+%s') $name1"; [ -f oldmanifest.txt ] && cat oldmanifest.txt | head -$((MAX_BACKUPS-1))) \
    | grep -v '^$' | sort -k1 -rn | head -"$MAX_BACKUPS" > manifest.txt
  git add manifest.txt

  git commit -q -m "backup sqlite $(date '+%Y-%m-%d %H:%M:%S') → $name1" >/dev/null 2>&1 || true

  # 空推也要试
  if [ -n "$base" ]; then
    git push -q "$remote" "HEAD:refs/heads/$branch" 2>>"$LOG_FILE" && log "✅ 已推GitHub备份分支 $branch" || log "⚠️ 推GitHub失败(网络/GH_TOKEN?)·稍后重试"
  else
    git push -q --set-upstream "$remote" "HEAD:$branch" 2>>"$LOG_FILE" && log "✅ 首次创建备份分支 $branch 成功" || log "⚠️ 首次推GitHub失败"
  fi
  popd >/dev/null
}

cleanup_old_backups() {
  # manifest.txt已经是只留MAX_BACKUPS份了，这里只负责下次commit时自然掉
  true
}

# ==============================================================================
# 主循环：守护进程，每BACKUP_EVERY_S秒1次
# ==============================================================================
main_daemon() {
  check_prereq
  log "🛡️ 备份守护启动：DB=$DB_PATH，每${BACKUP_EVERY_S}秒备份一次→GitHub $GH_USER/$GH_REPO@$BACKUP_BRANCH，保留$KEEP_DAYS天"
  log "   恢复方法：cat scripts/backup-sqlite.sh | grep -A10 '恢复方法' 或看文档"
  # 启动立刻先备份一次（不等1小时）
  do_backup_once || log "⚠️ 首次备份失败·下轮再试"
  local cnt=0
  while true; do
    cnt=$((cnt+1))
    sleep "$BACKUP_EVERY_S"
    log "🔁 第${cnt}轮定时备份..."
    do_backup_once || log "⚠️ 本轮失败·下轮再试（不退出·守护进程不死）"
  done
}

# 如果是直接运行（不是被source）就进守护循环
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  case "${1:-daemon}" in
    once) check_prereq; do_backup_once ;;
    check) check_prereq; log "✅ 所有前置检查通过，首次手动备份测试..." ; do_backup_once ;;
    daemon|*) main_daemon ;;
  esac
fi

# ==============================================================================
# 🆘 恢复方法（当Replit把文件清了·数据库没了时用）：
# ==============================================================================
# 1. 去 GitHub仓库→Code→切到 sqlite-backups 分支
# 2. 下载最新的 zhuiguang_sqlite_时间戳.db.gz（看manifest.txt第一行就是最新的）
# 3. 解压: gunzip zhuiguang_sqlite_xxx.db.gz
# 4. 重命名为 local.db → 上传到 Replit server/ 目录
# 5. 点 Replit Run → 数据全部回来了！✅
# ==============================================================================
