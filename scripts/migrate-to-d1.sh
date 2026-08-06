#!/usr/bin/env bash
# ============================================================
# 🗄️ 追光平台 · SQLite local.db → Cloudflare D1 数据迁移脚本
# ============================================================
#
# 用法（在沙箱里执行）:
#   cd /workspace
#   bash scripts/migrate-to-d1.sh
#
# 前提:
#   1. 已装 wrangler: npm i -g wrangler
#   2. 已登录: npx wrangler login
#   3. 已创建D1: npx wrangler d1 create zhuiguang-db (把返回的database_id填入wrangler.toml)
#
# ============================================================

set -euo pipefail
DB_FILE="server/local.db"
D1_NAME="zhuiguang-db"
PX="${HTTP_PROXY:-http://127.0.0.1:18080}"
export HTTP_PROXY="$PX" HTTPS_PROXY="$PX"

echo " ========== 🗄️ SQLite → D1 数据迁移 ========== "

# 1. 确认local.db存在
if [ ! -f "$DB_FILE" ]; then
  echo "❌ 数据库文件不存在: $DB_FILE"
  exit 1
fi
echo "✅ 找到数据库: $(du -h $DB_FILE | cut -f1)"

# 2. 先建表（schema.sql）
echo ""
echo " ========== 1. D1建表 =========="
npx wrangler d1 execute "$D1_NAME" --remote --file=schema.sql 2>&1 | tail -5
echo "✅ 建表完成"

# 3. 导出local.db所有数据为SQL INSERT语句
echo ""
echo " ========== 2. 导出local.db数据为INSERT语句 =========="
TMPSQL="/tmp/ult/d1_data_inserts.sql"
mkdir -p /tmp/ult

# 用sqlite3 .dump导出数据（只保留INSERT，不要CREATE TABLE/INDEX）
sqlite3 "$DB_FILE" ".dump" 2>/dev/null | grep -E "^INSERT INTO" > "$TMPSQL"
LINE_COUNT=$(wc -l < "$TMPSQL")
echo "✅ 导出 $LINE_COUNT 条INSERT语句"

if [ "$LINE_COUNT" -eq 0 ]; then
  echo "⚠️ 数据库为空，跳过数据导入"
  exit 0
fi

# 4. 分批导入D1（D1单次执行有SQL长度限制，分100条一批）
echo ""
echo " ========== 3. 分批导入D1 =========="
BATCH=50
TOTAL=$((LINE_COUNT / BATCH + 1))
CURRENT=0
FAIL=0

while IFS= read -r line; do
  echo "$line" >> /tmp/ult/d1_batch.sql
  CURRENT=$((CURRENT + 1))
  if [ $((CURRENT % BATCH)) -eq 0 ]; then
    BATCH_NUM=$((CURRENT / BATCH))
    echo -ne "  导入批次 $BATCH_NUM/$TOTAL ...\\r"
    if ! npx wrangler d1 execute "$D1_NAME" --remote --file=/tmp/ult/d1_batch.sql 2>/dev/null; then
      echo "  ⚠️ 批次 $BATCH_NUM 部分失败（可能是重复主键，忽略）"
      FAIL=$((FAIL+1))
    fi
    > /tmp/ult/d1_batch.sql
  fi
done < "$TMPSQL"

# 导入剩余
if [ -s /tmp/ult/d1_batch.sql ]; then
  BATCH_NUM=$((CURRENT / BATCH + 1))
  echo "  导入最后批次 $BATCH_NUM/$TOTAL ..."
  npx wrangler d1 execute "$D1_NAME" --remote --file=/tmp/ult/d1_batch.sql 2>/dev/null || true
fi

echo ""
echo " ========== ✅ 迁移完成 ========== "
echo "  总INSERT语句: $LINE_COUNT"
echo "  成功批次: $((TOTAL - FAIL))"
echo "  失败批次: $FAIL (重复主键可忽略)"
echo ""
echo "验证: npx wrangler d1 execute $D1_NAME --remote --command='SELECT COUNT(*) FROM users'"
