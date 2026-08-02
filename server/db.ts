// ===== 追光 · 数据库初始化与种子数据 =====
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH || path.join(__dirname, 'zhuiguang.db')
try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }) } catch {}
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

export function initDB() {
  db.exec(`
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
  `)
  seed()
}

function seed() {
  const c = db.prepare('SELECT COUNT(*) as n FROM users').get() as any
  if (c.n > 0) return

  const hash = (p: string) => bcrypt.hashSync(p, 8)

  // 仅创建超级管理员账号（密码：admin123456）
  const insUser = db.prepare(`INSERT INTO users (username,password_hash,real_name,role,email,phone,avatar,exp,level) VALUES (?,?,?,?,?,?,?,?,?)`)
  insUser.run('admin', hash('admin123456'), '超级管理员', 'SUPER_ADMIN', 'admin@zguang.edu', '13800000000', 'https://api.dicebear.com/7.x/shapes/svg?seed=admin', 0, 1)
  const adminId = Number(db.prepare('SELECT id FROM users WHERE username=?').get('admin').id)

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
  const insSub = db.prepare(`INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)`)
  subjects.forEach(s => insSub.run(...s))

  // 预设班级
  const insCls = db.prepare(`INSERT INTO classes (name,grade,description) VALUES (?,?,?)`)
  insCls.run('高二（1）班', '高二', '理科实验班')
  insCls.run('高二（2）班', '高二', '文科重点班')

  // 默认主题：浅黄橘黄小清新（参考图风格）
  const insT = db.prepare(`INSERT INTO themes (name,config,is_active) VALUES (?,?,?)`)
  insT.run('暖阳浅黄（默认）', JSON.stringify({ primary: '#F59E0B', primary2: '#FB923C', accent: '#FBBF24', bgFrom: '#FFFBEB', bgVia: '#FEF3C7', bgTo: '#FDE68A', blur: 16, radius: 18 }), 1)
  insT.run('晨曦琥珀', JSON.stringify({ primary: '#F97316', primary2: '#EA580C', accent: '#FDBA74', bgFrom: '#FFF7ED', bgVia: '#FED7AA', bgTo: '#FDBA74', blur: 14, radius: 20 }), 0)
  insT.run('清新柠檬', JSON.stringify({ primary: '#EAB308', primary2: '#CA8A04', accent: '#FEF08A', bgFrom: '#FEFCE8', bgVia: '#FEF9C3', bgTo: '#FEF08A', blur: 15, radius: 22 }), 0)

  console.log('[db] seed done (admin + subjects + classes + themes, no sample content)')
}

export default db
