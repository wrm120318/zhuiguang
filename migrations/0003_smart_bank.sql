-- ============================================================
-- 追光学科共享平台 · 智能题库（v4.5.0）数据库迁移
-- 用法（仅首次，对新库安全幂等）：
--   npx wrangler d1 execute zhuiguang-db --remote --file=migrations/0003_smart_bank.sql
-- 说明：
--   - 新表用 CREATE TABLE IF NOT EXISTS，可重复执行不报错
--   - subject_questions / quizzes 的新列由后端运行时「幂等 ALTER」（try/catch）自动补齐，
--     无需手动执行 ALTER（避免重复执行报错）。此处仅建新表。
-- ============================================================

-- 知识点主表（支持层级树）
CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  parent_id INTEGER DEFAULT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  FOREIGN KEY(subject_id) REFERENCES subjects(id)
);
CREATE INDEX IF NOT EXISTS idx_kp_subject ON knowledge_points(subject_id);
CREATE INDEX IF NOT EXISTS idx_kp_parent ON knowledge_points(parent_id);

-- 题目 ↔ 知识点 多对多
CREATE TABLE IF NOT EXISTS question_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  knowledge_point_id INTEGER NOT NULL,
  UNIQUE(question_id, knowledge_point_id),
  FOREIGN KEY(question_id) REFERENCES subject_questions(id) ON DELETE CASCADE,
  FOREIGN KEY(knowledge_point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qk_q ON question_knowledge(question_id);
CREATE INDEX IF NOT EXISTS idx_qk_kp ON question_knowledge(knowledge_point_id);

-- 个人题库：文件夹
CREATE TABLE IF NOT EXISTS question_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE INDEX IF NOT EXISTS idx_qf_user ON question_folders(user_id);

-- 个人题库：收藏
CREATE TABLE IF NOT EXISTS question_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  folder_id INTEGER DEFAULT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  UNIQUE(user_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_qfav_user ON question_favorites(user_id);

-- 题目纠错反馈
CREATE TABLE IF NOT EXISTS question_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  resolved_by INTEGER DEFAULT NULL,
  resolved_at TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_qfb_q ON question_feedback(question_id);

-- 多学科教师指派（与 class_members 并存）
CREATE TABLE IF NOT EXISTS user_subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  assigned_by INTEGER DEFAULT NULL,
  UNIQUE(user_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_us_user ON user_subjects(user_id);
CREATE INDEX IF NOT EXISTS idx_us_subject ON user_subjects(subject_id);
