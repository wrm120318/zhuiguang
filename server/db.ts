// ===== 追光 · 数据库初始化与种子数据（Turso/libSQL 版） =====
import { createClient } from '@libsql/client'
import bcrypt from 'bcryptjs'

// Turso 远程数据库；本地开发可设为 file:./server/local.db 走嵌入式模式
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:./server/local.db'
const dbToken = process.env.TURSO_AUTH_TOKEN

export const db = createClient({
  url: dbUrl,
  authToken: dbToken,
})

// ============ 便捷封装：把 libSQL 的 execute 包成 better-sqlite3 类似的形态（异步） ============
// 用法对应关系：
//   db.prepare(sql).all(...args)  →  await all(sql, ...args)
//   db.prepare(sql).get(...args)  →  await get(sql, ...args)
//   db.prepare(sql).run(...args)  →  await run(sql, ...args)
//   db.exec(sql)                  →  await exec(sql)
export async function all<T = any>(sql: string, ...args: any[]): Promise<T[]> {
  const r = await db.execute({ sql, args })
  return r.rows as T[]
}
export async function get<T = any>(sql: string, ...args: any[]): Promise<T | undefined> {
  const r = await db.execute({ sql, args })
  return r.rows[0] as T | undefined
}
export async function run(sql: string, ...args: any[]): Promise<{ lastInsertRowid: number | bigint }> {
  const r = await db.execute({ sql, args })
  return { lastInsertRowid: r.lastInsertRowid as number | bigint }
}
export async function exec(sql: string): Promise<void> {
  await db.executeMultiple(sql)
}

// ============ 建表 + 种子 ============
export async function initDB() {
  // libSQL 用 executeMultiple 跑多条 DDL
  await db.executeMultiple(`
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
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, grade TEXT, description TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS class_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      role_in_class TEXT NOT NULL, subject_id INTEGER,
      joined_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(class_id) REFERENCES classes(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      icon TEXT, color TEXT, description TEXT, display_order INTEGER DEFAULT 0,
      modules TEXT DEFAULT '{}', announcement TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, content TEXT NOT NULL,
      author TEXT, source TEXT, recommendation TEXT,
      subject_id INTEGER, user_id INTEGER, class_id INTEGER,
      cover TEXT, images TEXT DEFAULT '[]', tags TEXT DEFAULT '[]', category TEXT,
      status TEXT DEFAULT 'pending', likes INTEGER DEFAULT 0, views INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER, title TEXT NOT NULL, description TEXT,
      file_name TEXT, file_type TEXT, file_size INTEGER, file_path TEXT,
      category TEXT, tags TEXT DEFAULT '[]',
      user_id INTEGER, class_id INTEGER,
      status TEXT DEFAULT 'pending', downloads INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0, collects INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS query_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT,
      title TEXT NOT NULL, note TEXT, valid_until TEXT,
      show_comment INTEGER DEFAULT 1, allow_export INTEGER DEFAULT 0,
      headers TEXT, match_field TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS query_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL, data_row TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES query_tasks(id)
    );
    CREATE TABLE IF NOT EXISTS exp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, action_type TEXT, exp_change INTEGER,
      description TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, title TEXT, content TEXT, type TEXT,
      read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS themes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, config TEXT, is_active INTEGER DEFAULT 0,
      created_by INTEGER, updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS likes_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, target_type TEXT, target_id INTEGER, UNIQUE(user_id, target_type, target_id)
    );
    -- 题库自测
    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT,
      title TEXT NOT NULL, description TEXT,
      duration INTEGER DEFAULT 0,
      valid_until TEXT,
      status TEXT DEFAULT 'published',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
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
    CREATE TABLE IF NOT EXISTS quiz_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quiz_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      answers TEXT DEFAULT '{}',
      total_score INTEGER DEFAULT 0,
      max_score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      submitted_at TEXT,
      graded_at TEXT, graded_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    -- 学科题目池（单题训练用，独立于考试）
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
      created_at TEXT DEFAULT (datetime('now','localtime'))
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
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    -- 通用页面：网站说明 / 博客 / 公告
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ptype TEXT NOT NULL,
      scope TEXT DEFAULT 'site',
      class_id INTEGER,
      title TEXT NOT NULL, content TEXT NOT NULL,
      cover TEXT, images TEXT DEFAULT '[]', attachments TEXT DEFAULT '[]',
      author_id INTEGER, author_name TEXT,
      status TEXT DEFAULT 'published',
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS page_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, user_name TEXT, avatar TEXT,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    -- 站内信
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
      content TEXT NOT NULL, attachments TEXT DEFAULT '[]',
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    -- 全局设置（经验规则 / 功能开关）
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)

  // 迁移：为旧数据库补齐 users.subject_id 列（CREATE TABLE IF NOT EXISTS 不会修改已存在的表）
  try { await db.execute('ALTER TABLE users ADD COLUMN subject_id INTEGER DEFAULT NULL') } catch {}
  // 迁移：为 pages 补齐 likes 列
  try { await db.execute('ALTER TABLE pages ADD COLUMN likes INTEGER DEFAULT 0') } catch {}
  // 迁移：公告置顶功能（需求2）
  try { await db.execute('ALTER TABLE pages ADD COLUMN pinned INTEGER DEFAULT 0') } catch {}
  try { await db.execute('ALTER TABLE pages ADD COLUMN pinned_scope TEXT DEFAULT \'none\'') } catch {}
  // 迁移：美文代发功能（需求3）actual_user_id=实际作者学生ID；status增加pending_student状态
  try { await db.execute('ALTER TABLE articles ADD COLUMN actual_user_id INTEGER DEFAULT NULL') } catch {}
  // 迁移：用户最后活跃时间（需求5监控在线人数）
  try { await db.execute('ALTER TABLE users ADD COLUMN last_active TEXT DEFAULT NULL') } catch {}

  await seed()
}

async function seed() {
  const c = await get<{ n: number }>('SELECT COUNT(*) as n FROM users')
  if (c && c.n > 0) return

  const hash = (p: string) => bcrypt.hashSync(p, 8)

  // 仅创建超级管理员账号（密码：admin123456）
  await run(
    `INSERT INTO users (username,password_hash,real_name,role,email,phone,avatar,exp,level) VALUES (?,?,?,?,?,?,?,?,?)`,
    'admin', hash('admin123456'), '超级管理员', 'SUPER_ADMIN', 'admin@zguang.edu', '13800000000', 'https://api.dicebear.com/7.x/shapes/svg?seed=admin', 0, 1
  )

  // 预设学科（基础框架）
  const subjects = [
    ['语文', 'chinese', '📖', '#f59e0b', '诗书礼乐，美文共赏', 1, '{"announcement":true,"resources":true,"articles":true,"query":true,"quiz":true,"leaderboard":true}', ''],
    ['数学', 'math', '📐', '#eab308', '逻辑与抽象之美', 2, '{"announcement":true,"resources":true,"articles":false,"query":true,"quiz":true,"leaderboard":true}', ''],
    ['英语', 'english', '🌍', '#fbbf24', 'English & Beyond', 3, '{"announcement":true,"resources":true,"articles":true,"query":true,"quiz":true,"leaderboard":true}', ''],
    ['物理', 'physics', '🔬', '#facc15', '探究万物之理', 4, '{"announcement":true,"resources":true,"articles":false,"query":true,"quiz":true,"leaderboard":true}', ''],
    ['化学', 'chemistry', '⚗️', '#d97706', '分子与反应的魔法', 5, '{"announcement":true,"resources":true,"articles":false,"query":true,"quiz":false,"leaderboard":true}', ''],
    ['生物', 'biology', '🧬', '#a16207', '生命的密码', 6, '{"announcement":true,"resources":true,"articles":false,"query":true,"quiz":false,"leaderboard":true}', ''],
    ['历史', 'history', '🏛️', '#92400e', '以史为鉴', 7, '{"announcement":true,"resources":true,"articles":false,"query":false,"quiz":false,"leaderboard":true}', ''],
    ['信息技术', 'it', '💻', '#ca8a04', '代码改变世界', 8, '{"announcement":true,"resources":true,"articles":false,"query":true,"quiz":true,"leaderboard":true}', ''],
  ]
  for (const s of subjects) {
    await run(`INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)`, ...s)
  }

  // 预设班级
  await run(`INSERT INTO classes (name,grade,description) VALUES (?,?,?)`, '高二（1）班', '高二', '理科实验班')
  await run(`INSERT INTO classes (name,grade,description) VALUES (?,?,?)`, '高二（2）班', '高二', '文科重点班')

  // 默认主题
  await run(`INSERT INTO themes (name,config,is_active) VALUES (?,?,?)`, '暖阳浅黄（默认）', JSON.stringify({ primary: '#F59E0B', primary2: '#FB923C', accent: '#FBBF24', bgFrom: '#FFFBEB', bgVia: '#FEF3C7', bgTo: '#FDE68A', blur: 16, radius: 18 }), 1)
  await run(`INSERT INTO themes (name,config,is_active) VALUES (?,?,?)`, '晨曦琥珀', JSON.stringify({ primary: '#F97316', primary2: '#EA580C', accent: '#FDBA74', bgFrom: '#FFF7ED', bgVia: '#FED7AA', bgTo: '#FDBA74', blur: 14, radius: 20 }), 0)
  await run(`INSERT INTO themes (name,config,is_active) VALUES (?,?,?)`, '清新柠檬', JSON.stringify({ primary: '#EAB308', primary2: '#CA8A04', accent: '#FEF08A', bgFrom: '#FEFCE8', bgVia: '#FEF9C3', bgTo: '#FEF08A', blur: 15, radius: 22 }), 0)

  // ===== 默认全局设置：经验值规则 + 功能开关 =====
  const expRules = {
    login: 5, register: 5, article: 15, resource: 15, query: 2, quiz_pass: 10, blog: 5,
    announcement_read: 1, message_reply: 0,
  }
  const featureFlags = {
    quiz: true, blog: true, guide: true, announcement: true, message: true,
    leaderboard: true, favorites: true, search: true, subjects: true,
  }
  await run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', 'exp_rules', JSON.stringify(expRules))
  await run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', 'feature_flags', JSON.stringify(featureFlags))

  // ===== 网站说明首页内容（ptype=guide，单条） =====
  await run(
    `INSERT INTO pages (ptype,scope,title,content,author_name,status) VALUES (?,?,?,?,?,?)`,
    'guide', 'site', '追光学科共享平台 · 使用说明',
    `<h2>🌟 欢迎来到追光</h2>
<p>追光是一个面向师生的学科共享平台，在这里你可以分享资料、撰写美文、参与题库自测、查询成绩，与同学共同成长。</p>
<h3>📚 核心功能</h3>
<ul>
<li><b>学科子站</b>：每个学科都有独立的公告栏、资料共享、美文共赏、数据查询、题库自测、学科榜。</li>
<li><b>题库自测</b>：教师/管理员上传题目（支持文字、Markdown、图片、文件），客观题线上作答自动判分，主观题教师批改，生成测评报告。</li>
<li><b>网站博客</b>：所有成员都可发布博客，支持文字、Markdown、图片、附件。</li>
<li><b>网站公告</b>：全站公告所有人可见；班级公告仅对应班级学生可见。</li>
<li><b>站内信</b>：成员之间可互发消息，超级管理员可查看所有消息内容。</li>
<li><b>经验值</b>：登录、发布美文/资料、完成查询/题库等行为均可获得经验，经验值规则可在「管理后台 → 经验设置」查看。</li>
</ul>
<h3>👤 角色说明</h3>
<ul>
<li><b>超级管理员</b>：拥有所有权限，可管理用户、学科、班级、内容审核、功能开关、经验规则。</li>
<li><b>学科教师</b>：可管理所属学科的内容、审核、题库、批改、发布班级公告。</li>
<li><b>学生</b>：可浏览内容、作答题库、发布博客、收发站内信。</li>
</ul>
<h3>❓ 常见问题</h3>
<p>如遇账号问题请联系超级管理员重置密码（默认 123456）。</p>`,
    '超级管理员', 'published'
  )

  console.log('[db] seed done (admin + subjects + classes + themes + settings + guide, no sample content)')
}
