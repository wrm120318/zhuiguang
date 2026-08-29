-- ============================================================
-- 🗄️ 追光学科共享平台 · Cloudflare D1 完整建表脚本
-- ============================================================
-- 用法: npx wrangler d1 execute zhuiguang-db --remote --file=schema.sql
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  real_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'STUDENT',
  email TEXT, phone TEXT,
  avatar TEXT DEFAULT '',
  exp INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  subject_id INTEGER DEFAULT NULL,
  last_active TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 班级表
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, grade TEXT, description TEXT,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 班级成员表
CREATE TABLE IF NOT EXISTS class_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  role_in_class TEXT NOT NULL, subject_id INTEGER,
  joined_at TEXT DEFAULT (datetime('now','+8 hours')),
  FOREIGN KEY(class_id) REFERENCES classes(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

-- 学科表
CREATE TABLE IF NOT EXISTS subjects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  icon TEXT, color TEXT, description TEXT, display_order INTEGER DEFAULT 0,
  modules TEXT DEFAULT '{}', announcement TEXT DEFAULT '',
  forum_auto_approve_threshold INTEGER DEFAULT 0  -- v4.1.1 论坛免审阈值（按学科，0=全部需审；>0 表示字数≤该值免审）
);

-- 美文表
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, content TEXT NOT NULL,
  author TEXT, source TEXT, recommendation TEXT,
  subject_id INTEGER, user_id INTEGER, class_id INTEGER,
  cover TEXT, images TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', category TEXT,
  status TEXT DEFAULT 'pending', likes INTEGER DEFAULT 0, views INTEGER DEFAULT 0,
  actual_user_id INTEGER DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 资源表
CREATE TABLE IF NOT EXISTS resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER, title TEXT NOT NULL, description TEXT,
  file_name TEXT, file_type TEXT, file_size INTEGER, file_path TEXT,
  category TEXT, tags TEXT DEFAULT '[]',
  user_id INTEGER, class_id INTEGER,
  status TEXT DEFAULT 'pending', downloads INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0, collects INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 查询任务表
CREATE TABLE IF NOT EXISTS query_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT,
  title TEXT NOT NULL, note TEXT, valid_until TEXT,
  show_comment INTEGER DEFAULT 1, allow_export INTEGER DEFAULT 0,
  headers TEXT, match_field TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 查询行表
CREATE TABLE IF NOT EXISTS query_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL, data_row TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES query_tasks(id)
);

-- 经验日志表
CREATE TABLE IF NOT EXISTS exp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, action_type TEXT, exp_change INTEGER,
  description TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 通知表
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, title TEXT, content TEXT, type TEXT,
  target_url TEXT,
  read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
-- v4.2.1：通知跳转链接（在线 ALTER，幂等）
-- ALTER TABLE notices ADD COLUMN target_url TEXT;

-- 主题表
CREATE TABLE IF NOT EXISTS themes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, config TEXT, is_active INTEGER DEFAULT 0,
  created_by INTEGER, updated_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 点赞表
CREATE TABLE IF NOT EXISTS likes_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, target_type TEXT, target_id INTEGER, UNIQUE(user_id, target_type, target_id)
);

-- 题库表
CREATE TABLE IF NOT EXISTS quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT,
  title TEXT NOT NULL, description TEXT,
  duration INTEGER DEFAULT 0,
  valid_until TEXT,
  status TEXT DEFAULT 'published',
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 题目表
CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL,
  qtype TEXT NOT NULL,
  content TEXT NOT NULL,
  options TEXT DEFAULT '[]',
  answer TEXT DEFAULT '',
  score INTEGER DEFAULT 5,
  attachments TEXT DEFAULT '[]',
  sort INTEGER DEFAULT 0
);

-- 提交记录表
CREATE TABLE IF NOT EXISTS quiz_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  answers TEXT DEFAULT '{}',
  total_score INTEGER DEFAULT 0,
  max_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  submitted_at TEXT,
  graded_at TEXT, graded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 学科题目池
CREATE TABLE IF NOT EXISTS subject_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  creator_id INTEGER, creator_name TEXT,
  qtype TEXT NOT NULL,
  content TEXT NOT NULL,
  options TEXT DEFAULT '[]',
  answer TEXT DEFAULT '',
  score INTEGER DEFAULT 5,
  attachments TEXT DEFAULT '[]',
  sort INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 单题训练提交记录
CREATE TABLE IF NOT EXISTS practice_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL, subject_id INTEGER,
  user_id INTEGER NOT NULL,
  answer TEXT DEFAULT '',
  score INTEGER DEFAULT 0,
  max_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  correct INTEGER,
  comment TEXT,
  submitted_at TEXT,
  graded_at TEXT, graded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 通用页面表
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ptype TEXT NOT NULL,
  scope TEXT DEFAULT 'site',
  class_id INTEGER,
  title TEXT NOT NULL, content TEXT NOT NULL,
  cover TEXT, images TEXT DEFAULT '[]', attachments TEXT DEFAULT '[]',
  author_id INTEGER, author_name TEXT,
  subject_id INTEGER DEFAULT NULL,  -- v4.1.0 学科论坛：非空即表示该帖属于某学科论坛（ptype='forum'）
  topic_ids TEXT DEFAULT '[]',      -- v4.1.0 论坛话题 id 列表（JSON 数组字符串）
  status TEXT DEFAULT 'published',
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  pinned_scope TEXT DEFAULT 'none',
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  updated_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 页面评论表
CREATE TABLE IF NOT EXISTS page_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, user_name TEXT, avatar TEXT,
  content TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,  -- v4.2.0 二级回复：NULL=主评论，否则指向父评论 id
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 美文评论表
CREATE TABLE IF NOT EXISTS article_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  user_name TEXT, avatar TEXT, content TEXT NOT NULL,
  parent_id INTEGER DEFAULT NULL,  -- v4.2.0 二级回复：NULL=主评论，否则指向父评论 id（生产 D1 该列为 INTEGER）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP  -- 原写法 DEFAULT datetime('now','+8 hours') 缺括号，SQLite 语法报错（v4.2.2 修正，与生产 D1 一致）
);

-- 论坛话题表（v4.1.0 学科论坛）
CREATE TABLE IF NOT EXISTS forum_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#F59E0B',      -- 与生产 D1 一致
  created_by INTEGER NOT NULL,       -- 与生产 D1 一致
  created_at TEXT DEFAULT (datetime('now','+8 hours')),
  FOREIGN KEY(subject_id) REFERENCES subjects(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

-- 站内信表
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
  content TEXT NOT NULL, attachments TEXT DEFAULT '[]',
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);

-- 全局设置表
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 功能开关表
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ====== 索引 ======
-- v4.2.0 二级回复
CREATE INDEX IF NOT EXISTS idx_art_c_p ON article_comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_page_c_p ON page_comments(parent_id);
-- v4.1.0 学科论坛
CREATE INDEX IF NOT EXISTS idx_forum_topics_subject ON forum_topics(subject_id);
CREATE INDEX IF NOT EXISTS idx_pages_subject ON pages(subject_id);
CREATE INDEX IF NOT EXISTS idx_art_c_a ON article_comments(article_id);
CREATE INDEX IF NOT EXISTS idx_articles_subject ON articles(subject_id);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_class ON articles(class_id);
CREATE INDEX IF NOT EXISTS idx_resources_subject ON resources(subject_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);
CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id);
CREATE INDEX IF NOT EXISTS idx_class_members_class ON class_members(class_id);
CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_quiz ON quiz_submissions(quiz_id);
CREATE INDEX IF NOT EXISTS idx_quiz_submissions_user ON quiz_submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_practice_submissions_q ON practice_submissions(question_id);
CREATE INDEX IF NOT EXISTS idx_pages_ptype ON pages(ptype);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
