-- ============================================================
-- 追光学科共享平台 · 性能索引补充（v4.8.26）
-- 用法：
--   npx wrangler d1 execute zhuiguang-db --remote --file=migrations/0004_perf_indexes.sql
--
-- 背景（生产实测基线，样本 40）：
--   平均响应 3.925s / P50 1.620s / P95 25.013s（超时）
--   边缘缓存命中率仅 1~4/10，每次未命中都要回源 D1。
--
-- 本迁移目标：**降低回源时的查询耗时**（与缓存优化互补，非替代）。
--
-- 安全说明（重要）：
--   · 全部为 `CREATE INDEX IF NOT EXISTS` —— 幂等，可重复执行
--   · **不修改任何表结构、不触碰任何数据、不删除任何索引**
--   · SQLite 建索引是纯附加操作，失败也不会影响既有查询
--   · 索引会略微增大存储并让写入稍慢（本项目写入量极小，可忽略）
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. subject_questions —— 题库主表，**最热**
-- ────────────────────────────────────────────────────────────
-- 热查询（worker-api.ts 题库列表）：
--   SELECT sq.* FROM subject_questions sq
--   WHERE sq.subject_id=? [AND sq.status=?] [AND sq.qtype=?] ...
--   ORDER BY sq.sort, sq.id DESC
--
-- 原状态：subject_id 上**无任何索引** → 每次题库列表全表扫描。
-- 建复合索引覆盖「学科 + 状态」这两个最高频的组合条件，
-- 并带上排序列（sort, id DESC）让 ORDER BY 也能走索引、免去额外排序。
CREATE INDEX IF NOT EXISTS idx_sq_subject_status_sort
  ON subject_questions(subject_id, status, sort, id);

-- 题型筛选（题库「选择题/填空题/解答题」tab 切换）
CREATE INDEX IF NOT EXISTS idx_sq_subject_qtype
  ON subject_questions(subject_id, qtype);

-- 难度筛选
CREATE INDEX IF NOT EXISTS idx_sq_subject_difficulty
  ON subject_questions(subject_id, difficulty);

-- 教材版本 / 地区 / 年份 / 题源：题库高级筛选的独立维度
CREATE INDEX IF NOT EXISTS idx_sq_textbook ON subject_questions(textbook_version);
CREATE INDEX IF NOT EXISTS idx_sq_region   ON subject_questions(region);
CREATE INDEX IF NOT EXISTS idx_sq_year     ON subject_questions(year);
CREATE INDEX IF NOT EXISTS idx_sq_source   ON subject_questions(source);

-- 创建者维度的查询（「我出的题」）
CREATE INDEX IF NOT EXISTS idx_sq_creator ON subject_questions(creator_id);

-- ────────────────────────────────────────────────────────────
-- 2. question_knowledge —— 知识点关联（题库按知识点筛选题）
-- ────────────────────────────────────────────────────────────
-- 已有 idx_qk_q(question_id) 与 idx_qk_kp(knowledge_point_id)。
-- 补充：v4.8.25 起「点一级知识点 = 本节点 OR 其直接子节点」的聚合子查询
--   会同时用到 knowledge_point_id 与 JOIN knowledge_points.parent_id，
--   建复合索引让该子查询免去回表。
CREATE INDEX IF NOT EXISTS idx_qk_kp_qid
  ON question_knowledge(knowledge_point_id, question_id);

-- ────────────────────────────────────────────────────────────
-- 3. knowledge_points —— 知识点树
-- ────────────────────────────────────────────────────────────
-- 已有 idx_kp_subject、idx_kp_parent。
-- 补充：按「学科 + 父节点」一次性取整棵树（侧栏渲染）是最热路径。
CREATE INDEX IF NOT EXISTS idx_kp_subject_parent
  ON knowledge_points(subject_id, parent_id, sort);

-- ────────────────────────────────────────────────────────────
-- 4. messages —— 站内信（未读计数 / 会话列表）
-- ────────────────────────────────────────────────────────────
-- 已有 idx_messages_to(to_id)。
-- 未读计数查询：WHERE to_id=? AND is_read=0
CREATE INDEX IF NOT EXISTS idx_messages_to_read
  ON messages(to_id, is_read);

-- ────────────────────────────────────────────────────────────
-- 5. notices —— 公告（首页拉取，实测最慢 25s）
-- ────────────────────────────────────────────────────────────
-- 已有 idx_notices_user(user_id)。
-- 首页按时间倒序取最近若干条
CREATE INDEX IF NOT EXISTS idx_notices_created
  ON notices(created_at DESC);

-- ────────────────────────────────────────────────────────────
-- 6. users —— 登录 / 成员列表
-- ────────────────────────────────────────────────────────────
-- 登录按用户名查（唯一约束通常已隐式建索引，此处显式化以防万一）
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_role     ON users(role);

-- ────────────────────────────────────────────────────────────
-- 7. practice_submissions —— 单题训练记录
-- ────────────────────────────────────────────────────────────
-- 已有 idx_practice_submissions_q(question_id)。
-- 「我的练习记录」：WHERE user_id=? ORDER BY id DESC
CREATE INDEX IF NOT EXISTS idx_ps_user
  ON practice_submissions(user_id, id DESC);
-- 待批改列表：WHERE status='pending'
CREATE INDEX IF NOT EXISTS idx_ps_status
  ON practice_submissions(status, id DESC);

-- ────────────────────────────────────────────────────────────
-- 8. wrong_book / 错题本相关（若表存在）
-- ────────────────────────────────────────────────────────────
-- 错题本按「用户 + 学科」查询
-- 注：错题本若由 practice_submissions 的 correct=0 推导，则上面的 idx_ps_user 已覆盖；
--     下面这条针对独立错题表（如不存在则 CREATE INDEX 会报错，
--     故用 IF NOT EXISTS 之外无法防「表不存在」——已确认该表在 schema 中。
CREATE INDEX IF NOT EXISTS idx_practice_user_correct
  ON practice_submissions(user_id, correct);

-- ============================================================
-- 说明：以上索引均为**附加**，任何一条创建失败都不影响其余，
--       也不影响既有功能的正确性。执行后可用
--   npx wrangler d1 execute zhuiguang-db --remote --command \
--     "SELECT name,tbl_name FROM sqlite_master WHERE type='index' ORDER BY tbl_name"
-- 核对。
-- ============================================================
