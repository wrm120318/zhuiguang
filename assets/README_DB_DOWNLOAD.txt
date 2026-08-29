# 追光学科 SQLite数据库一键下载（沙箱在云端场景·Replit Shell里执行下面命令）
# ============================================================
# 【Replit里用·复制下面整段粘贴到Tools→Shell里回车即可】
mkdir -p server
curl -fsSL -o server/local.db.gz https://raw.githubusercontent.com/wrm120318/zhuiguang/main/assets/zhuiguang_localdb_latest.db.gz
gunzip -f server/local.db.gz
# 校验
sqlite3 server/local.db "PRAGMA integrity_check;"   # 输出ok=完美✅
ls -lh server/local.db
# 然后点绿色Run按钮·完事
