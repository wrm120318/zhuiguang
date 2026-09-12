-- ============================================================
-- 追光学科共享平台 · articles 表补列 updated_at（v4.4.10 紧急修复）
-- 部署：npx wrangler d1 execute zhuiguang-db --remote --file=migrations/0002_articles_updated_at.sql
-- 背景：
--   PATCH /api/articles/:id 在更新时执行 `updated_at=datetime('now','+8 hours')`，
--   但 articles 表自建库起从未创建 updated_at 列，导致每次编辑美文都报
--   D1_ERROR: no such column: updated_at（HTTP 500「服务器内部错误」），
--   美文编辑功能自上线即不可用。users / pages / themes 等表均有该列，唯独 articles 漏建。
--   本迁移补齐该列，使既有 handler 逻辑正常生效（并顺带记录编辑时间）。
-- 注意事项（D1 限制）：
--   D1 的 ALTER TABLE ADD COLUMN 不允许「非恒定默认值」（如 datetime(...)），
--   会报 code 7500「Cannot add a column with non-constant default」。
--   因此先用恒定空默认值 '' 加列，再用 UPDATE 回填存量行的编辑时间为 created_at。
--   线上 CREATE TABLE 仍保留 DEFAULT (datetime('now','+8 hours'))（建表时合法，仅 ALTER 受限）。
-- 幂等说明：
--   远程 articles 已确认无此列（PATCH 实测 no such column），单次执行即可成功；
--   若重复执行 ALTER 报「duplicate column name」属预期，可忽略后直接跑回填 UPDATE。
-- ============================================================

-- 1) 补列（恒定空默认值，规避 D1 非恒定默认值限制）
ALTER TABLE articles ADD COLUMN updated_at TEXT DEFAULT '';

-- 2) 存量回填：未编辑过的美文其 updated_at 取创建时间，保持语义一致
UPDATE articles SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = '';
