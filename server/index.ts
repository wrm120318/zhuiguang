import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import db, { initDB } from './db'
import { signToken, auth, requireRole, requireStaff } from './auth'
import { addExp, addNotice, userClassIds, teachingSubjects } from './helpers'
import bcrypt from 'bcryptjs'
import multer from 'multer'

initDB()

// 迁移：为旧数据库补齐 users.subject_id 列（CREATE TABLE IF NOT EXISTS 不会修改已存在的表）
try { db.prepare('ALTER TABLE users ADD COLUMN subject_id INTEGER DEFAULT NULL').run() } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// 上传目录（与 server/index.ts 同目录，绝对路径，确保开发/生产一致）
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')
fs.mkdirSync(uploadDir, { recursive: true })
// 启动时校验上传目录存在且可写
try {
  fs.accessSync(uploadDir, fs.constants.W_OK)
  console.log('[server] 上传目录就绪且可写:', uploadDir)
} catch {
  console.error('[server] 警告：上传目录不可写:', uploadDir)
}
// 静态文件服务，必须在 SPA fallback 之前注册
app.use('/uploads', express.static(uploadDir))

// 静态：前端构建产物（生产）
const distDir = path.join(ROOT, 'dist')
if (fs.existsSync(distDir)) app.use(express.static(distDir))

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname)
      const rand = Math.random().toString(36).slice(2, 10)
      cb(null, `file_${Date.now()}_${rand}${ext}`)
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
})

const j = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null } catch { return null } }
const pub = (u: any) => { if (!u) return u; const { password_hash, ...rest } = u; return rest }

function setDownloadHeaders(res: express.Response, filename: string) {
  const encoded = encodeURIComponent(filename)
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
}

// 教师仅可管理自己任教学科；超管可管理所有学科
function canManageSubject(user: any, subjectId: any): boolean {
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  if (user.role === 'TEACHER') return user.subject_id === subjectId
  return false
}

// ============ 认证 ============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any
  if (!u) return res.status(400).json({ message: '用户不存在' })
  if (u.status !== 'active') return res.status(400).json({ message: '账号已被禁用' })
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(400).json({ message: '密码错误' })
  addExp(u.id, 5, 'login', '每日首次登录')
  res.json({ token: signToken({ id: u.id, role: u.role }), user: pub(u) })
})

app.post('/api/auth/register', (req, res) => {
  const { username, password, realName, email, classId } = req.body
  if (!username || !password || !realName) return res.status(400).json({ message: '请填写完整信息' })
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password, 8)
  const r = db.prepare('INSERT INTO users (username,password_hash,real_name,role,email,avatar) VALUES (?,?,?,?,?,?)').run(username, hash, realName, 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`)
  const uid = Number(r.lastInsertRowid)
  if (classId) db.prepare('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)').run(classId, uid, 'STUDENT')
  addExp(uid, 5, 'register', '注册奖励')
  res.json({ token: signToken({ id: uid, role: 'STUDENT' }), user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(uid)) })
})

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get((req as any).user.id)
  res.json({ user: pub(u) })
})

// ============ 用户管理 ============
app.get('/api/users', auth, requireStaff, (_req, res) => {
  const list = (db.prepare('SELECT * FROM users ORDER BY id').all() as any[]).map(pub)
  res.json(list)
})

app.post('/api/users', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { username, realName, role, email, classId, password, subjectId } = req.body
  if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password || '123456', 8)
  const r = db.prepare('INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id) VALUES (?,?,?,?,?,?,?)').run(username, hash, realName, role || 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`, subjectId ?? null)
  const uid = Number(r.lastInsertRowid)
  if (classId) db.prepare('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)').run(classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
  res.json({ id: uid })
})

app.patch('/api/users/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { realName, email, role, subjectId } = req.body
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id) as any
  if (!u) return res.status(404).json({ message: '用户不存在' })
  if (realName !== undefined) db.prepare('UPDATE users SET real_name=? WHERE id=?').run(realName, req.params.id)
  if (email !== undefined) db.prepare('UPDATE users SET email=? WHERE id=?').run(email, req.params.id)
  if (role !== undefined) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id)
  if (subjectId !== undefined) db.prepare('UPDATE users SET subject_id=? WHERE id=?').run(subjectId ?? null, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/users/:id/status', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(req.body.status, req.params.id)
  res.json({ ok: true })
})

app.post('/api/users/:id/reset', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('123456', 8), req.params.id)
  res.json({ ok: true })
})

app.delete('/api/users/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('DELETE FROM exp_logs WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM likes_map WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM notices WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM class_members WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM articles WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM resources WHERE user_id=?').run(req.params.id)
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// Admin: 调整用户经验值
app.patch('/api/users/:id/exp', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { exp, level } = req.body
  if (exp !== undefined) db.prepare('UPDATE users SET exp=? WHERE id=?').run(exp, req.params.id)
  if (level !== undefined) db.prepare('UPDATE users SET level=? WHERE id=?').run(level, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/profile', auth, (req, res) => {
  const id = (req as any).user.id
  const { realName, email, avatar } = req.body
  db.prepare('UPDATE users SET real_name=?, email=?, avatar=? WHERE id=?').run(realName, email, avatar, id)
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(id)) })
})

app.post('/api/upload/avatar', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  const ext = path.extname(req.file.originalname) || '.png'
  const name = `avatar_${(req as any).user.id}_${Date.now()}${ext}`
  fs.renameSync(req.file.path, path.join(uploadDir, name))
  const url = `/uploads/${name}`
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(url, (req as any).user.id)
  res.json({ url })
})

// ============ 班级 ============
app.get('/api/classes', auth, (_req, res) => res.json(db.prepare('SELECT * FROM classes ORDER BY id').all()))

app.post('/api/classes', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const r = db.prepare('INSERT INTO classes (name,grade,description) VALUES (?,?,?)').run(req.body.name, req.body.grade || '', req.body.description || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('UPDATE classes SET name=?,grade=?,description=? WHERE id=?').run(req.body.name, req.body.grade, req.body.description, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('DELETE FROM class_members WHERE class_id=?').run(req.params.id)
  db.prepare('DELETE FROM classes WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ============ 学科 ============
app.get('/api/subjects', (_req, res) => {
  const list = (db.prepare('SELECT * FROM subjects ORDER BY display_order').all() as any[]).map(s => ({ ...s, modules: j(s.modules) }))
  res.json(list)
})

app.get('/api/subjects/:slug', (req, res) => {
  const s = db.prepare('SELECT * FROM subjects WHERE slug = ?').get(req.params.slug) as any
  if (!s) return res.status(404).json({ message: '学科不存在' })
  res.json({ ...s, modules: j(s.modules) })
})

app.post('/api/subjects', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { name, slug, icon, color, description, displayOrder, modules, announcement } = req.body
  if (db.prepare('SELECT id FROM subjects WHERE slug=?').get(slug)) return res.status(400).json({ message: 'slug已存在' })
  const r = db.prepare('INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, slug, icon || '📚', color || '#f59e0b', description || '', displayOrder || 0, JSON.stringify(modules || {}), announcement || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { name, icon, color, description, displayOrder, modules, announcement } = req.body
  if (name !== undefined) db.prepare('UPDATE subjects SET name=? WHERE id=?').run(name, req.params.id)
  if (icon !== undefined) db.prepare('UPDATE subjects SET icon=? WHERE id=?').run(icon, req.params.id)
  if (color !== undefined) db.prepare('UPDATE subjects SET color=? WHERE id=?').run(color, req.params.id)
  if (description !== undefined) db.prepare('UPDATE subjects SET description=? WHERE id=?').run(description, req.params.id)
  if (displayOrder !== undefined) db.prepare('UPDATE subjects SET display_order=? WHERE id=?').run(displayOrder, req.params.id)
  if (modules !== undefined) db.prepare('UPDATE subjects SET modules=? WHERE id=?').run(JSON.stringify(modules), req.params.id)
  if (announcement !== undefined) db.prepare('UPDATE subjects SET announcement=? WHERE id=?').run(announcement, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('DELETE FROM articles WHERE subject_id=?').run(req.params.id)
  db.prepare('DELETE FROM resources WHERE subject_id=?').run(req.params.id)
  db.prepare('DELETE FROM subjects WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// 学科管理员也能修改公告/模块
app.patch('/api/subjects/:id/announcement', auth, requireStaff, (req, res) => {
  db.prepare('UPDATE subjects SET announcement=? WHERE id=?').run(req.body.announcement, req.params.id)
  res.json({ ok: true })
})

// 用户班级/任教
app.get('/api/me/classes', auth, (req, res) => {
  const id = (req as any).user.id
  res.json({ classIds: userClassIds(id), teachingSubjects: teachingSubjects(id) })
})

// ============ 美文 ============
app.get('/api/articles', (req, res) => {
  const { subjectId, status, mine, userId } = req.query
  let sql = 'SELECT * FROM articles WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND subject_id=?'; args.push(subjectId) }
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (mine === '1') { sql += ' AND user_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = (db.prepare(sql).all(...args) as any[]).map(a => ({ ...a, images: j(a.images), tags: j(a.tags) }))
  res.json(list)
})

app.get('/api/articles/:id', (req, res) => {
  const a = db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id) as any
  if (!a) return res.status(404).json({ message: '不存在' })
  db.prepare('UPDATE articles SET views = views + 1 WHERE id=?').run(req.params.id)
  res.json({ ...a, images: j(a.images), tags: j(a.tags), views: a.views + 1 })
})

app.post('/api/articles', auth, (req, res) => {
  const id = (req as any).user.id
  const u = db.prepare('SELECT real_name, class_id FROM users u LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE user_id=?) cm ON u.id=cm.user_id WHERE u.id=?').get(id, id) as any
  const b = req.body
  const cid = b.classId || u?.class_id || 1
  const role = (req as any).user.role
  const status = 'pending'
  const r = db.prepare(`INSERT INTO articles (title,content,author,source,recommendation,subject_id,user_id,class_id,cover,images,tags,category,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.title, b.content, b.author || u?.real_name, b.source || '原创', b.recommendation || '', b.subjectId, id, cid, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.tags || []), b.category || '', status)
  const aid = Number(r.lastInsertRowid)
  res.json({ id: aid, status })
})

app.patch('/api/articles/:id/status', auth, (req, res) => {
  const a = db.prepare('SELECT title, user_id, status, subject_id FROM articles WHERE id=?').get(req.params.id) as any
  if (!a) return res.status(404).json({ message: '不存在' })
  const u = db.prepare('SELECT role, subject_id FROM users WHERE id=?').get((req as any).user.id) as any
  if (!canManageSubject(u, a.subject_id)) return res.status(403).json({ message: '无权限审核该学科的美文' })
  db.prepare('UPDATE articles SET status=? WHERE id=?').run(req.body.status, req.params.id)
  if (req.body.status === 'approved' && a.status !== 'approved') {
    addExp(a.user_id, 20, 'article', `美文《${a.title}》审核通过`)
    addNotice(a.user_id, '美文审核通过', `你的《${a.title}》已通过审核，已公开展示。`, 'audit')
  } else if (req.body.status === 'rejected') {
    addNotice(a.user_id, '美文未通过审核', `《${a.title}》未通过审核，请修改后重新提交。`, 'audit')
  }
  res.json({ ok: true })
})

app.delete('/api/articles/:id', auth, (req, res) => {
  const a = db.prepare('SELECT user_id, subject_id FROM articles WHERE id=?').get(req.params.id) as any
  if (!a) return res.status(404).json({ message: '不存在' })
  const u = db.prepare('SELECT role, subject_id FROM users WHERE id=?').get((req as any).user.id) as any
  const isOwner = a.user_id === (req as any).user.id
  if (!isOwner && !canManageSubject(u, a.subject_id)) return res.status(403).json({ message: '无权限删除' })
  db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

app.post('/api/articles/:id/like', auth, (req, res) => {
  const uid = (req as any).user.id
  const exist = db.prepare('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?').get(uid, 'article', req.params.id)
  if (exist) return res.json({ liked: false })
  db.prepare('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)').run(uid, 'article', req.params.id)
  db.prepare('UPDATE articles SET likes = likes + 1 WHERE id=?').run(req.params.id)
  const a = db.prepare('SELECT user_id, title FROM articles WHERE id=?').get(req.params.id) as any
  if (a) addExp(a.user_id, 1, 'like', `美文《${a.title}》获得点赞`)
  res.json({ liked: true })
})

// ============ 资料 ============
app.get('/api/resources', (req, res) => {
  const { subjectId, status, mine, userId } = req.query
  let sql = 'SELECT * FROM resources WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND subject_id=?'; args.push(subjectId) }
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (mine === '1') { sql += ' AND user_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = (db.prepare(sql).all(...args) as any[]).map(r => ({ ...r, tags: j(r.tags) }))
  res.json(list)
})

app.post('/api/resources', auth, (req, res) => {
  const id = (req as any).user.id
  const role = (req as any).user.role
  const b = req.body
  const status = 'pending'
  const r = db.prepare(`INSERT INTO resources (subject_id,title,description,file_name,file_type,file_size,file_path,category,tags,user_id,class_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.subjectId, b.title, b.description || '', b.fileName || '', b.fileType || '', b.fileSize || 0, b.filePath || '', b.category || '', JSON.stringify(b.tags || []), id, b.classId || 1, status)
  const rid = Number(r.lastInsertRowid)
  res.json({ id: rid, status })
})

app.patch('/api/resources/:id/status', auth, (req, res) => {
  const r = db.prepare('SELECT title, user_id, status, subject_id FROM resources WHERE id=?').get(req.params.id) as any
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = db.prepare('SELECT role, subject_id FROM users WHERE id=?').get((req as any).user.id) as any
  if (!canManageSubject(u, r.subject_id)) return res.status(403).json({ message: '无权限审核该学科的资料' })
  db.prepare('UPDATE resources SET status=? WHERE id=?').run(req.body.status, req.params.id)
  if (req.body.status === 'approved' && r.status !== 'approved') {
    addExp(r.user_id, 15, 'resource', `资料《${r.title}》审核通过`)
    addNotice(r.user_id, '资料审核通过', `《${r.title}》已通过审核。`, 'audit')
  }
  res.json({ ok: true })
})

app.delete('/api/resources/:id', auth, (req, res) => {
  const r = db.prepare('SELECT user_id, file_path, subject_id FROM resources WHERE id=?').get(req.params.id) as any
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = db.prepare('SELECT role, subject_id FROM users WHERE id=?').get((req as any).user.id) as any
  const isOwner = r.user_id === (req as any).user.id
  if (!isOwner && !canManageSubject(u, r.subject_id)) return res.status(403).json({ message: '无权限删除' })
  if (r.file_path) {
    const p = path.join(__dirname, r.file_path)
    if (fs.existsSync(p)) { try { fs.unlinkSync(p) } catch {} }
  }
  db.prepare('DELETE FROM resources WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

app.post('/api/resources/:id/download', (req, res) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(req.params.id) as any
  if (!r) return res.status(404).json({ message: '不存在' })
  const filePath = path.join(__dirname, r.file_path || '')
  if (!r.file_path || !fs.existsSync(filePath)) {
    return res.status(404).json({ message: '文件不存在，可能已被清理' })
  }
  const filename = r.file_name || r.title || 'download'
  setDownloadHeaders(res, filename)
  db.prepare('UPDATE resources SET downloads = downloads + 1 WHERE id=?').run(req.params.id)
  res.download(filePath, filename)
})

app.post('/api/resources/:id/like', auth, (req, res) => {
  const uid = (req as any).user.id
  const exist = db.prepare('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?').get(uid, 'resource', req.params.id)
  if (exist) return res.json({ liked: false })
  db.prepare('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)').run(uid, 'resource', req.params.id)
  db.prepare('UPDATE resources SET likes = likes + 1 WHERE id=?').run(req.params.id)
  res.json({ liked: true })
})

// ============ 收藏 ============
app.get('/api/favorites', auth, (req, res) => {
  const uid = (req as any).user.id
  const list = db.prepare('SELECT * FROM likes_map WHERE user_id=? AND target_type IN (?,?) ORDER BY id DESC').all(uid, 'fav_article', 'fav_resource') as any[]
  res.json(list)
})
app.post('/api/favorites/:type/:id', auth, (req, res) => {
  const uid = (req as any).user.id
  const tp = req.params.type === 'article' ? 'fav_article' : 'fav_resource'
  const exist = db.prepare('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?').get(uid, tp, req.params.id)
  if (exist) { db.prepare('DELETE FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?').run(uid, tp, req.params.id); return res.json({ favorited: false }) }
  db.prepare('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)').run(uid, tp, req.params.id)
  res.json({ favorited: true })
})

// ============ 文件上传 ============
app.post('/api/upload/file', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  const filename = req.file.filename
  const ext = path.extname(req.file.originalname)
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  const url = `/uploads/${filename}`
  res.json({ url, filePath: `uploads/${filename}`, fileName: req.file.originalname, fileType: typeMap[ext] || 'file', fileSize: req.file.size })
})

app.post('/api/upload/image', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  const ext = path.extname(req.file.originalname) || '.png'
  const name = `img_${(req as any).user.id}_${Date.now()}${ext}`
  fs.renameSync(req.file.path, path.join(uploadDir, name))
  const url = `/uploads/${name}`
  res.json({ url })
})

// ============ 数据查询 ============
app.get('/api/query/tasks', auth, (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  let sql = 'SELECT * FROM query_tasks WHERE 1=1'
  const args: any[] = []
  if (role === 'STUDENT') {
    const cids = userClassIds(uid)
    if (!cids.length) return res.json([])
    sql += ` AND class_id IN (${cids.map(() => '?').join(',')})`; args.push(...cids)
  } else if (role === 'TEACHER') {
    sql += ' AND creator_id=?'; args.push(uid)
  }
  sql += ' ORDER BY id DESC'
  const list = db.prepare(sql).all(...args) as any[]
  res.json(list.map(t => ({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })))
})

app.get('/api/query/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM query_tasks WHERE id=?').get(req.params.id) as any
  if (!t) return res.status(404).json({ message: '不存在' })
  res.json({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })
})

app.post('/api/query/tasks/:id/query', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM query_tasks WHERE id=?').get(req.params.id) as any
  if (!t) return res.status(404).json({ message: '不存在' })
  const uid = (req as any).user.id
  const user = db.prepare('SELECT real_name FROM users WHERE id=?').get(uid) as any
  const matchField = t.match_field
  const rows = (db.prepare('SELECT data_row FROM query_rows WHERE task_id=?').all(req.params.id) as any[]).map(r => j(r.data_row))
  const myRows = rows.filter(r => String(r[matchField]) === String(user.real_name))
  const headers = j(t.headers)
  addExp(uid, 2, 'query', `完成数据查询：${t.title}`)
  res.json({
    task: { ...t, headers, show_comment: !!t.show_comment, allow_export: !!t.allow_export },
    headers: t.show_comment ? headers : headers.filter((h: string) => h !== '评语'),
    myRows,
  })
})

app.post('/api/query/tasks', auth, requireStaff, (req, res) => {
  const id = (req as any).user.id
  const name = (db.prepare('SELECT real_name FROM users WHERE id=?').get(id) as any).real_name
  const b = req.body
  const r = db.prepare(`INSERT INTO query_tasks (subject_id,class_id,creator_id,creator_name,title,note,valid_until,show_comment,allow_export,headers,match_field) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.subjectId, b.classId, id, name, b.title, b.note || '', b.validUntil, b.showComment ? 1 : 0, b.allowExport ? 1 : 0, JSON.stringify(b.headers), b.matchField)
  const tid = Number(r.lastInsertRowid)
  const insRow = db.prepare('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)')
  b.rows.forEach((row: any) => insRow.run(tid, JSON.stringify(row)))
  const students = (db.prepare('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?').all(b.classId, 'STUDENT') as any[])
  students.forEach(s => addNotice(s.user_id, '新查询任务发布', `${name}老师发布了「${b.title}」成绩查询。`, 'query'))
  res.json({ id: tid })
})

app.delete('/api/query/tasks/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('DELETE FROM query_rows WHERE task_id=?').run(req.params.id)
  db.prepare('DELETE FROM query_tasks WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ============ 经验值 & 排行榜 ============
app.get('/api/exp/logs', auth, (req, res) => {
  const uid = req.query.userId || (req as any).user.id
  res.json(db.prepare('SELECT * FROM exp_logs WHERE user_id=? ORDER BY id DESC').all(uid))
})

app.post('/api/exp/logs', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { userId, change, actionType, description } = req.body
  addExp(userId, change, actionType, description)
  res.json({ ok: true })
})

app.get('/api/leaderboard', (req, res) => {
  const { scope = 'all', classId, subjectId, period = 'total' } = req.query
  let list = db.prepare('SELECT id,real_name,role,avatar,exp,level FROM users WHERE status=? ORDER BY exp DESC').all('active') as any[]
  if (scope === 'class' && classId) {
    const ids = (db.prepare('SELECT user_id FROM class_members WHERE class_id=?').all(classId) as any[]).map(r => r.user_id)
    list = list.filter(u => ids.includes(u.id))
  }
  if (scope === 'subject' && subjectId) {
    const tIds = (db.prepare('SELECT DISTINCT user_id FROM class_members WHERE subject_id=? AND role_in_class=?').all(subjectId, 'TEACHER') as any[]).map(r => r.user_id)
    const cIds = new Set<number>([...tIds, ...(db.prepare('SELECT user_id FROM resources WHERE subject_id=?').all(subjectId) as any[]).map((r: any) => r.user_id), ...(db.prepare('SELECT user_id FROM articles WHERE subject_id=?').all(subjectId) as any[]).map((r: any) => r.user_id)])
    list = list.filter(u => cIds.has(u.id))
  }
  const factor = period === 'week' ? 0.3 : period === 'month' ? 0.7 : 1
  list = list.map(u => ({ ...u, pe: Math.round(u.exp * factor + (period !== 'total' ? 20 : 0)) })).sort((a, b) => b.pe - a.pe)
  res.json(list)
})

// ============ 通知 ============
app.get('/api/notices', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC').all((req as any).user.id))
})

app.post('/api/notices/readAll', auth, (req, res) => {
  db.prepare('UPDATE notices SET read=1 WHERE user_id=?').run((req as any).user.id)
  res.json({ ok: true })
})

app.post('/api/notices/:id/read', auth, (req, res) => {
  db.prepare('UPDATE notices SET read=1 WHERE id=? AND user_id=?').run(req.params.id, (req as any).user.id)
  res.json({ ok: true })
})

// 管理员群发通知
app.post('/api/notices/broadcast', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const { title, content, type } = req.body
  const users = db.prepare('SELECT id FROM users WHERE status=?').all('active') as any[]
  const ins = db.prepare('INSERT INTO notices (user_id,title,content,type) VALUES (?,?,?,?)')
  users.forEach(u => ins.run(u.id, title, content, type || 'system'))
  res.json({ ok: true, count: users.length })
})

// ============ 主题 ============
app.get('/api/themes', (_req, res) => {
  const list = db.prepare('SELECT * FROM themes ORDER BY id').all() as any[]
  res.json(list.map(t => ({ ...t, config: j(t.config) })))
})

app.get('/api/themes/active', (_req, res) => {
  const t = db.prepare('SELECT * FROM themes WHERE is_active=1 LIMIT 1').get() as any
  if (!t) return res.json(null)
  res.json({ ...t, config: j(t.config) })
})

app.patch('/api/themes/:id/active', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('UPDATE themes SET is_active=0').run()
  db.prepare('UPDATE themes SET is_active=1 WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

app.put('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('UPDATE themes SET config=?, name=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(JSON.stringify(req.body.config), req.body.name, req.params.id)
  if (req.body.isActive) {
    db.prepare('UPDATE themes SET is_active=0').run()
    db.prepare('UPDATE themes SET is_active=1 WHERE id=?').run(req.params.id)
  }
  res.json({ ok: true })
})

app.post('/api/themes', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  const r = db.prepare('INSERT INTO themes (name,config,is_active) VALUES (?,?,?)').run(req.body.name, JSON.stringify(req.body.config), req.body.isActive ? 1 : 0)
  const id = Number(r.lastInsertRowid)
  if (req.body.isActive) { db.prepare('UPDATE themes SET is_active=0').run(); db.prepare('UPDATE themes SET is_active=1 WHERE id=?').run(id) }
  res.json({ id })
})

app.delete('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), (req, res) => {
  db.prepare('DELETE FROM themes WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ============ 数据统计 ============
app.get('/api/stats', auth, requireStaff, (req, res) => {
  const u = db.prepare('SELECT role, subject_id FROM users WHERE id=?').get((req as any).user.id) as any
  const teacherSid = (u && u.role === 'TEACHER') ? u.subject_id : null
  const subjWhere = teacherSid ? 'AND subject_id=?' : ''
  const subjArg: any[] = teacherSid ? [teacherSid] : []
  const users = db.prepare('SELECT COUNT(*) as n FROM users').get().n
  const subjects = db.prepare('SELECT COUNT(*) as n FROM subjects').get().n
  const articles = db.prepare(`SELECT COUNT(*) as n FROM articles WHERE 1=1 ${subjWhere}`).get(...subjArg).n
  const approvedArticles = db.prepare(`SELECT COUNT(*) as n FROM articles WHERE status=? ${subjWhere}`).get('approved', ...subjArg).n
  const pendingArticles = db.prepare(`SELECT COUNT(*) as n FROM articles WHERE status=? ${subjWhere}`).get('pending', ...subjArg).n
  const resources = db.prepare(`SELECT COUNT(*) as n FROM resources WHERE 1=1 ${subjWhere}`).get(...subjArg).n
  const approvedResources = db.prepare(`SELECT COUNT(*) as n FROM resources WHERE status=? ${subjWhere}`).get('approved', ...subjArg).n
  const pendingResources = db.prepare(`SELECT COUNT(*) as n FROM resources WHERE status=? ${subjWhere}`).get('pending', ...subjArg).n
  const queryTasks = db.prepare(`SELECT COUNT(*) as n FROM query_tasks WHERE 1=1 ${subjWhere}`).get(...subjArg).n
  res.json({ users, subjects, articles, approvedArticles, pendingArticles, resources, approvedResources, pendingResources, queryTasks })
})

app.get('/api/search', (req, res) => {
  const q = (req.query.q as string || '').trim()
  if (!q) return res.json({ articles: [], resources: [] })
  const like = `%${q}%`
  const articles = (db.prepare('SELECT id,title,author,cover,subject_id,category,created_at FROM articles WHERE status=? AND (title LIKE ? OR author LIKE ? OR content LIKE ?) ORDER BY id DESC LIMIT 20').all('approved', like, like, like) as any[])
  const resources = (db.prepare('SELECT id,title,description,file_name,file_type,subject_id,category,downloads FROM resources WHERE status=? AND (title LIKE ? OR description LIKE ?) ORDER BY id DESC LIMIT 20').all('approved', like, like) as any[])
  res.json({ articles, resources })
})

// SPA fallback - only for non-API, non-upload requests
app.get('/{*splat}', (req, res, next) => {
  const path = req.path
  if (path.startsWith('/api/') || path.startsWith('/uploads/')) return next()
  if (fs.existsSync(path.join(distDir, 'index.html'))) res.sendFile(path.join(distDir, 'index.html'))
  else res.status(404).json({ message: '页面不存在' })
})

const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, '0.0.0.0', () => console.log(`[server] 追光后端运行于 http://localhost:${PORT}`))
