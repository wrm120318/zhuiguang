import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { initDB, all, get, run } from './db'
import { signToken, auth, requireRole, requireStaff } from './auth'
import { addExp, addNotice, userClassIds, teachingSubjects } from './helpers'
import { uploadFile, downloadFile, deleteFile, extractKey, STORAGE_ENABLED } from './storage'
import bcrypt from 'bcryptjs'
import multer from 'multer'

// 初始化数据库（Turso/libSQL）
initDB().catch(e => {
  console.error('[server] 数据库初始化失败:', e)
  process.exit(1)
})

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const app = express()
app.use(cors())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// 静态：前端构建产物（生产）—— 文件上传已改用 Supabase Storage，不再需要本地 /uploads 目录
const distDir = path.join(ROOT, 'dist')
if (fs.existsSync(distDir)) app.use(express.static(distDir))

// multer 用内存存储：接收后立即上传到 Supabase，不落本地磁盘
const upload = multer({
  storage: multer.memoryStorage(),
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
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body
  const u = await get<any>('SELECT * FROM users WHERE username = ?', username)
  if (!u) return res.status(400).json({ message: '用户不存在' })
  if (u.status !== 'active') return res.status(400).json({ message: '账号已被禁用' })
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(400).json({ message: '密码错误' })
  await addExp(u.id, 5, 'login', '每日首次登录')
  res.json({ token: signToken({ id: u.id, role: u.role }), user: pub(u) })
})

app.post('/api/auth/register', async (req, res) => {
  const { username, password, realName, email, classId } = req.body
  if (!username || !password || !realName) return res.status(400).json({ message: '请填写完整信息' })
  if (await get('SELECT id FROM users WHERE username = ?', username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password, 8)
  const r = await run('INSERT INTO users (username,password_hash,real_name,role,email,avatar) VALUES (?,?,?,?,?,?)', username, hash, realName, 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)', classId, uid, 'STUDENT')
  await addExp(uid, 5, 'register', '注册奖励')
  const newUser = await get<any>('SELECT * FROM users WHERE id=?', uid)
  res.json({ token: signToken({ id: uid, role: 'STUDENT' }), user: pub(newUser) })
})

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await get<any>('SELECT * FROM users WHERE id = ?', (req as any).user.id)
  res.json({ user: pub(u) })
})

// ============ 用户管理 ============
app.get('/api/users', auth, requireStaff, async (_req, res) => {
  const list = await all<any>('SELECT * FROM users ORDER BY id')
  res.json(list.map(pub))
})

app.post('/api/users', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { username, realName, role, email, classId, password, subjectId } = req.body
  if (await get('SELECT id FROM users WHERE username=?', username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password || '123456', 8)
  const r = await run('INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id) VALUES (?,?,?,?,?,?,?)', username, hash, realName, role || 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`, subjectId ?? null)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)', classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
  res.json({ id: uid })
})

app.patch('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { realName, email, role, subjectId } = req.body
  const u = await get('SELECT id FROM users WHERE id=?', req.params.id)
  if (!u) return res.status(404).json({ message: '用户不存在' })
  if (realName !== undefined) await run('UPDATE users SET real_name=? WHERE id=?', realName, req.params.id)
  if (email !== undefined) await run('UPDATE users SET email=? WHERE id=?', email, req.params.id)
  if (role !== undefined) await run('UPDATE users SET role=? WHERE id=?', role, req.params.id)
  if (subjectId !== undefined) await run('UPDATE users SET subject_id=? WHERE id=?', subjectId ?? null, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/users/:id/status', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE users SET status = ? WHERE id = ?', req.body.status, req.params.id)
  res.json({ ok: true })
})

app.post('/api/users/:id/reset', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync('123456', 8), req.params.id)
  res.json({ ok: true })
})

app.delete('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM exp_logs WHERE user_id=?', req.params.id)
  await run('DELETE FROM likes_map WHERE user_id=?', req.params.id)
  await run('DELETE FROM notices WHERE user_id=?', req.params.id)
  await run('DELETE FROM class_members WHERE user_id=?', req.params.id)
  await run('DELETE FROM articles WHERE user_id=?', req.params.id)
  await run('DELETE FROM resources WHERE user_id=?', req.params.id)
  await run('DELETE FROM users WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// Admin: 调整用户经验值
app.patch('/api/users/:id/exp', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { exp, level } = req.body
  if (exp !== undefined) await run('UPDATE users SET exp=? WHERE id=?', exp, req.params.id)
  if (level !== undefined) await run('UPDATE users SET level=? WHERE id=?', level, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/profile', auth, async (req, res) => {
  const id = (req as any).user.id
  const { realName, email, avatar } = req.body
  await run('UPDATE users SET real_name=?, email=?, avatar=? WHERE id=?', realName, email, avatar, id)
  const u = await get<any>('SELECT * FROM users WHERE id=?', id)
  res.json({ user: pub(u) })
})

app.post('/api/upload/avatar', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname) || '.png'
  const key = `avatar_${(req as any).user.id}_${Date.now()}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  await run('UPDATE users SET avatar=? WHERE id=?', url, (req as any).user.id)
  res.json({ url })
})

// ============ 班级 ============
app.get('/api/classes', auth, async (_req, res) => res.json(await all('SELECT * FROM classes ORDER BY id')))

app.post('/api/classes', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const r = await run('INSERT INTO classes (name,grade,description) VALUES (?,?,?)', req.body.name, req.body.grade || '', req.body.description || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE classes SET name=?,grade=?,description=? WHERE id=?', req.body.name, req.body.grade, req.body.description, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM class_members WHERE class_id=?', req.params.id)
  await run('DELETE FROM classes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 学科 ============
app.get('/api/subjects', async (_req, res) => {
  const list = await all<any>('SELECT * FROM subjects ORDER BY display_order')
  res.json(list.map(s => ({ ...s, modules: j(s.modules) })))
})

app.get('/api/subjects/:slug', async (req, res) => {
  const s = await get<any>('SELECT * FROM subjects WHERE slug = ?', req.params.slug)
  if (!s) return res.status(404).json({ message: '学科不存在' })
  res.json({ ...s, modules: j(s.modules) })
})

app.post('/api/subjects', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { name, slug, icon, color, description, displayOrder, modules, announcement } = req.body
  if (await get('SELECT id FROM subjects WHERE slug=?', slug)) return res.status(400).json({ message: 'slug已存在' })
  const r = await run('INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)',
    name, slug, icon || '📚', color || '#f59e0b', description || '', displayOrder || 0, JSON.stringify(modules || {}), announcement || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { name, icon, color, description, displayOrder, modules, announcement } = req.body
  if (name !== undefined) await run('UPDATE subjects SET name=? WHERE id=?', name, req.params.id)
  if (icon !== undefined) await run('UPDATE subjects SET icon=? WHERE id=?', icon, req.params.id)
  if (color !== undefined) await run('UPDATE subjects SET color=? WHERE id=?', color, req.params.id)
  if (description !== undefined) await run('UPDATE subjects SET description=? WHERE id=?', description, req.params.id)
  if (displayOrder !== undefined) await run('UPDATE subjects SET display_order=? WHERE id=?', displayOrder, req.params.id)
  if (modules !== undefined) await run('UPDATE subjects SET modules=? WHERE id=?', JSON.stringify(modules), req.params.id)
  if (announcement !== undefined) await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM articles WHERE subject_id=?', req.params.id)
  await run('DELETE FROM resources WHERE subject_id=?', req.params.id)
  await run('DELETE FROM subjects WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学科管理员也能修改公告/模块
app.patch('/api/subjects/:id/announcement', auth, requireStaff, async (req, res) => {
  await run('UPDATE subjects SET announcement=? WHERE id=?', req.body.announcement, req.params.id)
  res.json({ ok: true })
})

// 用户班级/任教
app.get('/api/me/classes', auth, async (req, res) => {
  const id = (req as any).user.id
  res.json({ classIds: await userClassIds(id), teachingSubjects: await teachingSubjects(id) })
})

// ============ 美文 ============
app.get('/api/articles', async (req, res) => {
  const { subjectId, status, mine, userId } = req.query
  let sql = 'SELECT * FROM articles WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND subject_id=?'; args.push(subjectId) }
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (mine === '1') { sql += ' AND user_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(a => ({ ...a, images: j(a.images), tags: j(a.tags) })))
})

app.get('/api/articles/:id', async (req, res) => {
  const a = await get<any>('SELECT * FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  await run('UPDATE articles SET views = views + 1 WHERE id=?', req.params.id)
  res.json({ ...a, images: j(a.images), tags: j(a.tags), views: a.views + 1 })
})

app.post('/api/articles', auth, async (req, res) => {
  const id = (req as any).user.id
  const u = await get<any>('SELECT real_name, class_id FROM users u LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE user_id=?) cm ON u.id=cm.user_id WHERE u.id=?', id, id)
  const b = req.body
  const cid = b.classId || u?.class_id || 1
  const status = 'pending'
  const r = await run(`INSERT INTO articles (title,content,author,source,recommendation,subject_id,user_id,class_id,cover,images,tags,category,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.title, b.content, b.author || u?.real_name, b.source || '原创', b.recommendation || '', b.subjectId, id, cid, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.tags || []), b.category || '', status)
  const aid = Number(r.lastInsertRowid)
  res.json({ id: aid, status })
})

app.patch('/api/articles/:id/status', auth, async (req, res) => {
  const a = await get<any>('SELECT title, user_id, status, subject_id FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, a.subject_id)) return res.status(403).json({ message: '无权限审核该学科的美文' })
  await run('UPDATE articles SET status=? WHERE id=?', req.body.status, req.params.id)
  if (req.body.status === 'approved' && a.status !== 'approved') {
    await addExp(a.user_id, 20, 'article', `美文《${a.title}》审核通过`)
    await addNotice(a.user_id, '美文审核通过', `你的《${a.title}》已通过审核，已公开展示。`, 'audit')
  } else if (req.body.status === 'rejected') {
    await addNotice(a.user_id, '美文未通过审核', `《${a.title}》未通过审核，请修改后重新提交。`, 'audit')
  }
  res.json({ ok: true })
})

app.delete('/api/articles/:id', auth, async (req, res) => {
  const a = await get<any>('SELECT user_id, subject_id FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  const isOwner = a.user_id === (req as any).user.id
  if (!isOwner && !canManageSubject(u, a.subject_id)) return res.status(403).json({ message: '无权限删除' })
  await run('DELETE FROM articles WHERE id=?', req.params.id)
  res.json({ ok: true })
})

app.post('/api/articles/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'article', req.params.id)
  if (exist) return res.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'article', req.params.id)
  await run('UPDATE articles SET likes = likes + 1 WHERE id=?', req.params.id)
  const a = await get<any>('SELECT user_id, title FROM articles WHERE id=?', req.params.id)
  if (a) await addExp(a.user_id, 1, 'like', `美文《${a.title}》获得点赞`)
  res.json({ liked: true })
})

// ============ 资料 ============
app.get('/api/resources', async (req, res) => {
  const { subjectId, status, mine, userId } = req.query
  let sql = 'SELECT * FROM resources WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND subject_id=?'; args.push(subjectId) }
  if (status) { sql += ' AND status=?'; args.push(status) }
  if (mine === '1') { sql += ' AND user_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(r => ({ ...r, tags: j(r.tags) })))
})

app.post('/api/resources', auth, async (req, res) => {
  const id = (req as any).user.id
  const b = req.body
  const status = 'pending'
  const r = await run(`INSERT INTO resources (subject_id,title,description,file_name,file_type,file_size,file_path,category,tags,user_id,class_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.title, b.description || '', b.fileName || '', b.fileType || '', b.fileSize || 0, b.filePath || '', b.category || '', JSON.stringify(b.tags || []), id, b.classId || 1, status)
  const rid = Number(r.lastInsertRowid)
  res.json({ id: rid, status })
})

app.patch('/api/resources/:id/status', auth, async (req, res) => {
  const r = await get<any>('SELECT title, user_id, status, subject_id FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, r.subject_id)) return res.status(403).json({ message: '无权限审核该学科的资料' })
  await run('UPDATE resources SET status=? WHERE id=?', req.body.status, req.params.id)
  if (req.body.status === 'approved' && r.status !== 'approved') {
    await addExp(r.user_id, 15, 'resource', `资料《${r.title}》审核通过`)
    await addNotice(r.user_id, '资料审核通过', `《${r.title}》已通过审核。`, 'audit')
  }
  res.json({ ok: true })
})

app.delete('/api/resources/:id', auth, async (req, res) => {
  const r = await get<any>('SELECT user_id, file_path, subject_id FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  const isOwner = r.user_id === (req as any).user.id
  if (!isOwner && !canManageSubject(u, r.subject_id)) return res.status(403).json({ message: '无权限删除' })
  if (r.file_path) { try { await deleteFile(extractKey(r.file_path)) } catch {} }
  await run('DELETE FROM resources WHERE id=?', req.params.id)
  res.json({ ok: true })
})

app.post('/api/resources/:id/download', async (req, res) => {
  const r = await get<any>('SELECT * FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  if (!r.file_path) return res.status(404).json({ message: '文件不存在，可能已被清理' })
  const file = await downloadFile(r.file_path)
  if (!file) return res.status(404).json({ message: '文件不存在，可能已被清理' })
  const filename = r.file_name || r.title || 'download'
  setDownloadHeaders(res, filename)
  await run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', req.params.id)
  if (file.contentType) res.setHeader('Content-Type', file.contentType)
  res.send(file.buffer)
})

app.post('/api/resources/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'resource', req.params.id)
  if (exist) return res.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'resource', req.params.id)
  await run('UPDATE resources SET likes = likes + 1 WHERE id=?', req.params.id)
  res.json({ liked: true })
})

// ============ 收藏 ============
app.get('/api/favorites', auth, async (req, res) => {
  const uid = (req as any).user.id
  const list = await all<any>('SELECT * FROM likes_map WHERE user_id=? AND target_type IN (?,?) ORDER BY id DESC', uid, 'fav_article', 'fav_resource')
  res.json(list)
})
app.post('/api/favorites/:type/:id', auth, async (req, res) => {
  const uid = (req as any).user.id
  const tp = req.params.type === 'article' ? 'fav_article' : 'fav_resource'
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, req.params.id)
  if (exist) { await run('DELETE FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, req.params.id); return res.json({ favorited: false }) }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, tp, req.params.id)
  res.json({ favorited: true })
})

// ============ 文件上传（统一走 Supabase Storage） ============
app.post('/api/upload/file', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname)
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  // file_path 存储为相对 key（下载时 extractKey 兼容处理）
  res.json({ url, filePath: key, fileName: req.file.originalname, fileType: typeMap[ext] || 'file', fileSize: req.file.size })
})

app.post('/api/upload/image', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname) || '.png'
  const key = `img_${(req as any).user.id}_${Date.now()}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  res.json({ url })
})

// ============ 数据查询 ============
app.get('/api/query/tasks', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  let sql = 'SELECT * FROM query_tasks WHERE 1=1'
  const args: any[] = []
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return res.json([])
    sql += ` AND class_id IN (${cids.map(() => '?').join(',')})`; args.push(...cids)
  } else if (role === 'TEACHER') {
    sql += ' AND creator_id=?'; args.push(uid)
  }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(t => ({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })))
})

app.get('/api/query/tasks/:id', auth, async (req, res) => {
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  res.json({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })
})

app.post('/api/query/tasks/:id/query', auth, async (req, res) => {
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  const uid = (req as any).user.id
  const user = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const matchField = t.match_field
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=?', req.params.id)
  const allRows = rows.map(r => j(r.data_row))
  const myRows = allRows.filter(r => String(r[matchField]) === String(user.real_name))
  const headers = j(t.headers)
  await addExp(uid, 2, 'query', `完成数据查询：${t.title}`)
  res.json({
    task: { ...t, headers, show_comment: !!t.show_comment, allow_export: !!t.allow_export },
    headers: t.show_comment ? headers : headers.filter((h: string) => h !== '评语'),
    myRows,
  })
})

app.post('/api/query/tasks', auth, requireStaff, async (req, res) => {
  const id = (req as any).user.id
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', id)
  const name = me?.real_name || ''
  const b = req.body
  const r = await run(`INSERT INTO query_tasks (subject_id,class_id,creator_id,creator_name,title,note,valid_until,show_comment,allow_export,headers,match_field) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.classId, id, name, b.title, b.note || '', b.validUntil, b.showComment ? 1 : 0, b.allowExport ? 1 : 0, JSON.stringify(b.headers), b.matchField)
  const tid = Number(r.lastInsertRowid)
  for (const row of b.rows) {
    await run('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)', tid, JSON.stringify(row))
  }
  const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
  for (const s of students) {
    await addNotice(s.user_id, '新查询任务发布', `${name}老师发布了「${b.title}」成绩查询。`, 'query')
  }
  res.json({ id: tid })
})

app.delete('/api/query/tasks/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM query_rows WHERE task_id=?', req.params.id)
  await run('DELETE FROM query_tasks WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 经验值 & 排行榜 ============
app.get('/api/exp/logs', auth, async (req, res) => {
  const uid = req.query.userId || (req as any).user.id
  res.json(await all('SELECT * FROM exp_logs WHERE user_id=? ORDER BY id DESC', uid))
})

app.post('/api/exp/logs', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { userId, change, actionType, description } = req.body
  await addExp(userId, change, actionType, description)
  res.json({ ok: true })
})

app.get('/api/leaderboard', async (req, res) => {
  const { scope = 'all', classId, subjectId, period = 'total' } = req.query
  let list = await all<any>('SELECT id,real_name,role,avatar,exp,level FROM users WHERE status=? ORDER BY exp DESC', 'active')
  if (scope === 'class' && classId) {
    const rows = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=?', classId)
    const ids = rows.map(r => r.user_id)
    list = list.filter(u => ids.includes(u.id))
  }
  if (scope === 'subject' && subjectId) {
    const tRows = await all<{ user_id: number }>('SELECT DISTINCT user_id FROM class_members WHERE subject_id=? AND role_in_class=?', subjectId, 'TEACHER')
    const rRows = await all<{ user_id: number }>('SELECT user_id FROM resources WHERE subject_id=?', subjectId)
    const aRows = await all<{ user_id: number }>('SELECT user_id FROM articles WHERE subject_id=?', subjectId)
    const cIds = new Set<number>([...tRows.map(r => r.user_id), ...rRows.map(r => r.user_id), ...aRows.map(r => r.user_id)])
    list = list.filter(u => cIds.has(u.id))
  }
  const factor = period === 'week' ? 0.3 : period === 'month' ? 0.7 : 1
  list = list.map(u => ({ ...u, pe: Math.round(u.exp * factor + (period !== 'total' ? 20 : 0)) })).sort((a, b) => b.pe - a.pe)
  res.json(list)
})

// ============ 通知 ============
app.get('/api/notices', auth, async (req, res) => {
  res.json(await all('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC', (req as any).user.id))
})

app.post('/api/notices/readAll', auth, async (req, res) => {
  await run('UPDATE notices SET read=1 WHERE user_id=?', (req as any).user.id)
  res.json({ ok: true })
})

app.post('/api/notices/:id/read', auth, async (req, res) => {
  await run('UPDATE notices SET read=1 WHERE id=? AND user_id=?', req.params.id, (req as any).user.id)
  res.json({ ok: true })
})

// 管理员群发通知
app.post('/api/notices/broadcast', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { title, content, type } = req.body
  const users = await all<{ id: number }>('SELECT id FROM users WHERE status=?', 'active')
  for (const u of users) {
    await run('INSERT INTO notices (user_id,title,content,type) VALUES (?,?,?,?)', u.id, title, content, type || 'system')
  }
  res.json({ ok: true, count: users.length })
})

// ============ 主题 ============
app.get('/api/themes', async (_req, res) => {
  const list = await all<any>('SELECT * FROM themes ORDER BY id')
  res.json(list.map(t => ({ ...t, config: j(t.config) })))
})

app.get('/api/themes/active', async (_req, res) => {
  const t = await get<any>('SELECT * FROM themes WHERE is_active=1 LIMIT 1')
  if (!t) return res.json(null)
  res.json({ ...t, config: j(t.config) })
})

app.patch('/api/themes/:id/active', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE themes SET is_active=0')
  await run('UPDATE themes SET is_active=1 WHERE id=?', req.params.id)
  res.json({ ok: true })
})

app.put('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE themes SET config=?, name=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', JSON.stringify(req.body.config), req.body.name, req.params.id)
  if (req.body.isActive) {
    await run('UPDATE themes SET is_active=0')
    await run('UPDATE themes SET is_active=1 WHERE id=?', req.params.id)
  }
  res.json({ ok: true })
})

app.post('/api/themes', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const r = await run('INSERT INTO themes (name,config,is_active) VALUES (?,?,?)', req.body.name, JSON.stringify(req.body.config), req.body.isActive ? 1 : 0)
  const id = Number(r.lastInsertRowid)
  if (req.body.isActive) { await run('UPDATE themes SET is_active=0'); await run('UPDATE themes SET is_active=1 WHERE id=?', id) }
  res.json({ id })
})

app.delete('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM themes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 数据统计 ============
app.get('/api/stats', auth, requireStaff, async (req, res) => {
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  const teacherSid = (u && u.role === 'TEACHER') ? u.subject_id : null
  const subjWhere = teacherSid ? 'AND subject_id=?' : ''
  const subjArg: any[] = teacherSid ? [teacherSid] : []
  const users = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users'))!.n
  const subjects = (await get<{ n: number }>('SELECT COUNT(*) as n FROM subjects'))!.n
  const articles = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM articles WHERE 1=1 ${subjWhere}`, ...subjArg))!.n
  const approvedArticles = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM articles WHERE status=? ${subjWhere}`, 'approved', ...subjArg))!.n
  const pendingArticles = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM articles WHERE status=? ${subjWhere}`, 'pending', ...subjArg))!.n
  const resources = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM resources WHERE 1=1 ${subjWhere}`, ...subjArg))!.n
  const approvedResources = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM resources WHERE status=? ${subjWhere}`, 'approved', ...subjArg))!.n
  const pendingResources = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM resources WHERE status=? ${subjWhere}`, 'pending', ...subjArg))!.n
  const queryTasks = (await get<{ n: number }>(`SELECT COUNT(*) as n FROM query_tasks WHERE 1=1 ${subjWhere}`, ...subjArg))!.n
  res.json({ users, subjects, articles, approvedArticles, pendingArticles, resources, approvedResources, pendingResources, queryTasks })
})

app.get('/api/search', async (req, res) => {
  const q = (req.query.q as string || '').trim()
  if (!q) return res.json({ articles: [], resources: [] })
  const like = `%${q}%`
  const articles = await all<any>('SELECT id,title,author,cover,subject_id,category,created_at FROM articles WHERE status=? AND (title LIKE ? OR author LIKE ? OR content LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like, like)
  const resources = await all<any>('SELECT id,title,description,file_name,file_type,subject_id,category,downloads FROM resources WHERE status=? AND (title LIKE ? OR description LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like)
  res.json({ articles, resources })
})

// SPA fallback - only for non-API, non-upload requests
app.get('/{*splat}', (req, res, next) => {
  const p = req.path
  if (p.startsWith('/api/')) return next()
  if (fs.existsSync(path.join(distDir, 'index.html'))) res.sendFile(path.join(distDir, 'index.html'))
  else res.status(404).json({ message: '页面不存在' })
})

const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, '0.0.0.0', () => console.log(`[server] 追光后端运行于 http://localhost:${PORT}`))
