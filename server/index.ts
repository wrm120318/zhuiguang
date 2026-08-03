import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { initDB, all, get, run } from './db'
import { signToken, auth, requireRole, requireStaff } from './auth'
import { addExp, addNotice, userClassIds, teachingSubjects, getExpRules, getFeatureFlags, refreshExpRules, refreshFeatureFlags, isFeatureEnabled } from './helpers'
import { uploadFile, downloadFile, deleteFile, extractKey, STORAGE_ENABLED, USE_LOCAL, LOCAL_UPLOAD_DIR, createPresignedUploadUrl } from './storage'
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

// 静态：前端构建产物（生产）
  const distDir = path.join(ROOT, 'dist')
  if (fs.existsSync(distDir)) {
    // 给 index.html 注入版本号，强制浏览器加载最新的 JS/CSS
    // 策略：只在当前 html 中已有的 /assets/xxx.js / .css 引用上追加 ?v= 时间戳，
    // 不再依赖 index.html.bak —— 每次启动都直接基于当前构建产物加工，避免旧备份造成的错乱
    const htmlPath = path.join(distDir, 'index.html')
    let BUILD_VER = '0'
    try {
      BUILD_VER = String(Date.now())
      const rawHtml = fs.readFileSync(htmlPath, 'utf-8')
      // 先清除已有的 ?v=xxx，保证每次都是干净的起点
      const cleanHtml = rawHtml.replace(/\?v=\d+/g, '')
      // 只替换干净的 /assets/...js 和 /assets/...css
      const html = cleanHtml
        .replace(/(src="\/assets\/[^"]+\.js)"/g, `$1?v=${BUILD_VER}"`)
        .replace(/(href="\/assets\/[^"]+\.css)"/g, `$1?v=${BUILD_VER}"`)
      fs.writeFileSync(htmlPath, html)
      console.log(`[build] 版本号: ${BUILD_VER}`)
    } catch (e) { console.log('[build] 版本号注入失败:', (e as Error).message) }

    // 明确处理 /assets/ 路径，避免被 SPA fallback 拦截
    app.use('/assets', express.static(path.join(distDir, 'assets'), {
      maxAge: '1y',
      immutable: true,
      index: false
    }))
    // 其余静态文件（如根路径的 index.html、favicon 等）
    app.use(express.static(distDir, { index: false }))
  }

// 静态：本地文件上传目录（仅本地兜底模式用；Supabase 模式时前端走外链，此挂载无害也无用）
if (USE_LOCAL) {
  app.use('/uploads', express.static(LOCAL_UPLOAD_DIR))
  console.log(`[storage] 本地兜底模式：文件存于 ${LOCAL_UPLOAD_DIR}`)
} else {
  console.log('[storage] Supabase Storage 模式：文件存于云端 bucket')
}

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
  // 每日首次登录才加积分（同一天重复登录不重复发放）
  const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD
  const todayLogin = await get('SELECT id FROM exp_logs WHERE user_id=? AND action_type=? AND substr(created_at,1,10)=? LIMIT 1', u.id, 'login', today)
  if (!todayLogin) await addExp(u.id, undefined, 'login', '每日首次登录')
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
  await addExp(uid, undefined, 'register', '注册奖励')
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
  // 超管可将密码重置为指定值，留空则重置为默认 123456
  const pwd = req.body.password || '123456'
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pwd, 8), req.params.id)
  res.json({ ok: true })
})

// 超管直接设置用户密码（需求6）
app.post('/api/users/:id/password', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { password } = req.body
  if (!password || password.length < 4) return res.status(400).json({ message: '密码至少 4 位' })
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 8), req.params.id)
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

// ============ 前端直传 Supabase 的预签名 URL（绕过 pinggy 隧道大文件限制） ============
app.post('/api/upload/presign', auth, async (req, res) => {
  const { fileName, contentType } = req.body
  if (!fileName) return res.status(400).json({ message: '缺少 fileName' })
  const ext = path.extname(fileName) || ''
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  const result = await createPresignedUploadUrl(key)
  if (!result) {
    // Supabase 不可用（如本地模式），返回回退标记，前端走旧的 /api/upload/file 接口
    return res.json({ fallback: true, key })
  }
  res.json({
    signedUrl: result.signedUrl,
    publicUrl: result.publicUrl,
    key,
    fileType: typeMap[ext] || 'file',
  })
})

// 图片专用 presign（头像/编辑器图片）
app.post('/api/upload/presign-image', auth, async (req, res) => {
  const { fileName } = req.body
  if (!fileName) return res.status(400).json({ message: '缺少 fileName' })
  const ext = path.extname(fileName) || '.png'
  const key = `img_${(req as any).user.id}_${Date.now()}${ext}`
  const result = await createPresignedUploadUrl(key)
  if (!result) return res.json({ fallback: true, key })
  res.json({ signedUrl: result.signedUrl, publicUrl: result.publicUrl, key })
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
    await addExp(a.user_id, undefined, 'article', `美文《${a.title}》审核通过`)
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
  const u = await get<any>('SELECT role FROM users WHERE id=?', id)
  const b = req.body
  // 教师/管理员上传的资料自动审核通过；学生上传需待审核
  const status = (u?.role === 'SUPER_ADMIN' || u?.role === 'TEACHER') ? 'approved' : 'pending'
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
    await addExp(r.user_id, undefined, 'resource', `资料《${r.title}》审核通过`)
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
  await addExp(uid, undefined, 'query', `完成数据查询：${t.title}`)
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

// ============ 设置（经验规则 / 功能开关） ============
app.get('/api/settings/exp_rules', auth, async (_req, res) => {
  res.json(await getExpRules())
})

app.put('/api/settings/exp_rules', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const rules = req.body || {}
  await run("UPDATE settings SET value=? WHERE key='exp_rules'", JSON.stringify(rules))
  // 若没有该行（理论上 seed 已写入），保险起见再 INSERT OR REPLACE
  await run("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", 'exp_rules', JSON.stringify(rules))
  refreshExpRules()
  res.json({ ok: true })
})

app.get('/api/settings/feature_flags', auth, async (_req, res) => {
  res.json(await getFeatureFlags())
})

app.put('/api/settings/feature_flags', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const flags = req.body || {}
  await run("UPDATE settings SET value=? WHERE key='feature_flags'", JSON.stringify(flags))
  await run("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", 'feature_flags', JSON.stringify(flags))
  refreshFeatureFlags()
  res.json({ ok: true })
})

// ============ 题库自测 ============
// 列出题库：教师/超管看自己创建+所属学科；学生看自己班级可见的
app.get('/api/quizzes', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const { subjectId, classId } = req.query
  let sql = 'SELECT q.* FROM quizzes q WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND q.subject_id=?'; args.push(subjectId) }
  if (classId) { sql += ' AND q.class_id=?'; args.push(classId) }
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return res.json([])
    sql += ` AND q.class_id IN (${cids.map(() => '?').join(',')})`
    args.push(...cids)
  } else if (role === 'TEACHER') {
    const sids = await teachingSubjects(uid)
    // 教师可见：自己创建的 OR 自己任教学科的（含 user.subject_id，确保能看到超管为本学科组织的考试）
    const me = await get<any>('SELECT subject_id FROM users WHERE id=?', uid)
    if (me?.subject_id && !sids.includes(me.subject_id)) sids.push(me.subject_id)
    if (sids.length) {
      sql += ` AND (q.creator_id=? OR q.subject_id IN (${sids.map(() => '?').join(',')}))`
      args.push(uid, ...sids)
    } else {
      sql += ' AND q.creator_id=?'; args.push(uid)
    }
  }
  sql += ' ORDER BY q.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list)
})

app.get('/api/quizzes/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  res.json({
    ...q,
    questions: questions.map(qq => ({ ...qq, options: j(qq.options), attachments: j(qq.attachments) })),
  })
})

// 教师/超管创建题库 + 题目
app.post('/api/quizzes', auth, requireStaff, async (req, res) => {
  const uid = (req as any).user.id
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const b = req.body
  const r = await run(
    `INSERT INTO quizzes (subject_id,class_id,creator_id,creator_name,title,description,duration,valid_until,status) VALUES (?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.classId, uid, me?.real_name || '', b.title, b.description || '', b.duration || 0, b.validUntil || '', b.status || 'published'
  )
  const qid = Number(r.lastInsertRowid)
  let sort = 0
  for (const qq of (b.questions || [])) {
    await run(
      `INSERT INTO quiz_questions (quiz_id,qtype,content,options,answer,score,attachments,sort) VALUES (?,?,?,?,?,?,?,?)`,
      qid, qq.qtype, qq.content, JSON.stringify(qq.options || []), qq.answer || '', qq.score ?? 5, JSON.stringify(qq.attachments || []), sort++
    )
  }
  // 通知班级学生
  if (b.classId) {
    const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
    for (const s of students) {
      await addNotice(s.user_id, '新题库自测', `${me?.real_name || '老师'}发布了「${b.title}」题库自测，请按时完成。`, 'teacher')
    }
  }
  res.json({ id: qid })
})

app.patch('/api/quizzes/:id', auth, requireStaff, async (req, res) => {
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, q.subject_id)) return res.status(403).json({ message: '无权限' })
  const b = req.body
  if (b.title !== undefined) await run('UPDATE quizzes SET title=? WHERE id=?', b.title, req.params.id)
  if (b.description !== undefined) await run('UPDATE quizzes SET description=? WHERE id=?', b.description, req.params.id)
  if (b.duration !== undefined) await run('UPDATE quizzes SET duration=? WHERE id=?', b.duration, req.params.id)
  if (b.validUntil !== undefined) await run('UPDATE quizzes SET valid_until=? WHERE id=?', b.validUntil, req.params.id)
  if (b.status !== undefined) await run('UPDATE quizzes SET status=? WHERE id=?', b.status, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/quizzes/:id', auth, requireStaff, async (req, res) => {
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, q.subject_id)) return res.status(403).json({ message: '无权限' })
  await run('DELETE FROM quiz_questions WHERE quiz_id=?', req.params.id)
  await run('DELETE FROM quiz_submissions WHERE quiz_id=?', req.params.id)
  await run('DELETE FROM quizzes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学生作答：自动判客观题，主观题待批改
app.post('/api/quizzes/:id/submit', auth, async (req, res) => {
  const uid = (req as any).user.id
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  // 检查是否已提交
  const exist = await get<any>('SELECT id FROM quiz_submissions WHERE quiz_id=? AND user_id=?', req.params.id, uid)
  if (exist) return res.status(400).json({ message: '你已提交过该题库' })

  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=?', req.params.id)
  const answers = req.body.answers || {}
  let totalScore = 0
  let maxScore = 0
  const hasSubjective = questions.some(q => q.qtype === 'subjective')
  const graded: Record<number, { score: number; correct?: boolean; max: number; type: string }> = {}

  for (const q of questions) {
    maxScore += q.score || 0
    if (q.qtype === 'single' || q.qtype === 'multiple' || q.qtype === 'judge') {
      const correct = String(q.answer || '').trim()
      const mine = String(answers[q.id] ?? '').trim()
      const isCorrect = correct && mine && correct === mine
      if (isCorrect) totalScore += q.score || 0
      graded[q.id] = { score: isCorrect ? (q.score || 0) : 0, correct: !!isCorrect, max: q.score || 0, type: q.qtype }
    } else {
      // 主观题：留待批改，score 暂记 0
      graded[q.id] = { score: 0, max: q.score || 0, type: q.qtype }
    }
  }

  const status = hasSubjective ? 'pending' : 'graded'
  let subId: number
  if (status === 'graded') {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'),?)`,
      req.params.id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, uid
    )
    subId = Number(r.lastInsertRowid)
    await addExp(uid, undefined, 'quiz_pass', `完成题库自测：${quiz.title}（得分 ${totalScore}/${maxScore}）`)
  } else {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at) VALUES (?,?,?,?,?,?,?)`,
      req.params.id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  // 站内信通知：有主观题时，提醒教师阅卷
  if (status === 'pending' && quiz.creator_id) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const stuName = stu?.real_name || `用户${uid}`
    const objCount = questions.filter(q => q.qtype !== 'subjective').length
    const msg = `📚 ${stuName} 提交了《${quiz.title}》的答卷\n客观题（${objCount}题）已自动评分：${totalScore} / ${maxScore} 分\n主观题等待您批改，请前往「题库 → 批改 / 报告」处理。`
    await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, quiz.creator_id, msg, '[]')
  }
  await addNotice(uid, '题库已提交', `《${quiz.title}》已提交。${status === 'pending' ? '客观题已评分，等待教师批改主观题。' : `得分 ${totalScore}/${maxScore}。`}`, 'system')
  res.json({ id: subId, totalScore, maxScore, status, graded, hasSubjective })
})

// 教师批改主观题
app.post('/api/quizzes/:id/submissions/:sid/grade', auth, requireStaff, async (req, res) => {
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, quiz.subject_id)) return res.status(403).json({ message: '无权限批改' })

  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE id=? AND quiz_id=?', req.params.sid, req.params.id)
  if (!sub) return res.status(404).json({ message: '提交记录不存在' })
  const data = j(sub.answers) || {}
  const grades = req.body.grades || {} // { questionId: { score, comment } }
  let total = 0
  const graded = { ...(data.graded || {}) }
  for (const k of Object.keys(grades)) {
    const sc = Number(grades[k].score) || 0
    if (graded[k]) graded[k].score = sc
    if (grades[k].comment) graded[k].comment = grades[k].comment
    total += sc
  }
  // 客观题分数 + 主观题分数
  let fullTotal = 0
  for (const k of Object.keys(graded)) fullTotal += graded[k].score || 0
  await run(
    `UPDATE quiz_submissions SET answers=?, total_score=?, status='graded', graded_at=datetime('now','localtime'), graded_by=? WHERE id=?`,
    JSON.stringify({ answers: data.answers, graded }), fullTotal, (req as any).user.id, req.params.sid
  )
  // 给学生加经验
  await addExp(sub.user_id, undefined, 'quiz_pass', `题库《${quiz.title}》批改完成（得分 ${fullTotal}/${sub.max_score}）`)
  await addNotice(sub.user_id, '题库批改完成', `《${quiz.title}》已批改，得分 ${fullTotal}/${sub.max_score}。`, 'teacher')
  // 站内信通知学生：整张试卷报告已生成
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id))?.real_name || '老师'
  const msg = `✅ 《${quiz.title}》整张试卷已批改完成\n批改人：${teacherName}\n最终得分：${fullTotal} / ${sub.max_score} 分\n完整测评报告已生成，点击「题库 → 查看报告」即可查看。`
  await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', (req as any).user.id, sub.user_id, msg, '[]')
  res.json({ ok: true, totalScore: fullTotal })
})

function datetimeNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// 我的提交记录 / 教师查看所有提交
app.get('/api/quizzes/:id/submissions', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '不存在' })
  // 教师只能查看本学科考试的提交（超管不限）
  if (role === 'TEACHER') {
    const u = await get<any>('SELECT subject_id FROM users WHERE id=?', uid)
    if (!canManageSubject(u, quiz.subject_id)) return res.status(403).json({ message: '无权限查看该考试' })
  }
  let list
  if (role === 'STUDENT') {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? AND s.user_id=? ORDER BY s.id DESC', req.params.id, uid)
  } else {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id DESC', req.params.id)
  }
  res.json(list.map(s => ({ ...s, answers: j(s.answers) })))
})

// 学生查看自己的报告
app.get('/api/quizzes/:id/my_report', auth, async (req, res) => {
  const uid = (req as any).user.id
  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE quiz_id=? AND user_id=?', req.params.id, uid)
  if (!sub) return res.status(404).json({ message: '尚未提交' })
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  res.json({
    quiz,
    submission: { ...sub, answers: j(sub.answers) },
    questions: questions.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })),
  })
})

// 教师查看本次考试的数据报告
app.get('/api/quizzes/:id/report', auth, requireStaff, async (req, res) => {
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!canManageSubject(u, quiz.subject_id) && quiz.creator_id !== (req as any).user.id) {
    return res.status(403).json({ message: '无权限查看' })
  }
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  const subs = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id', req.params.id)
  const total = subs.length
  const pending = subs.filter(s => s.status === 'pending').length
  const graded = subs.filter(s => s.status === 'graded')
  const gradedCount = graded.length
  const scores = graded.map(s => s.total_score || 0)
  const avg = gradedCount ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / gradedCount * 10) / 10 : 0
  const maxS = gradedCount ? Math.max(...scores) : 0
  const minS = gradedCount ? Math.min(...scores) : 0
  const totalMax = questions.reduce((a: number, q: any) => a + (q.score || 0), 0) || graded[0]?.max_score || 0
  const passLine = Math.round(totalMax * 0.6)
  const passCount = scores.filter(s => s >= passLine).length
  // 每题统计
  const qStats = questions.map(q => {
    let correctCnt = 0, answeredCnt = 0, scoreSum = 0
    for (const s of graded) {
      const ans = j(s.answers) || {}
      const g = ans.graded?.[q.id]
      if (g) {
        answeredCnt++
        if (q.qtype !== 'subjective' && g.correct) correctCnt++
        scoreSum += g.score || 0
      }
    }
    return {
      id: q.id, qtype: q.qtype, content: q.content, score: q.score,
      options: j(q.options), answer: q.answer,
      correctRate: answeredCnt ? Math.round(correctCnt / answeredCnt * 100) : 0,
      avgScore: answeredCnt ? Math.round(scoreSum / answeredCnt * 10) / 10 : 0,
      answeredCnt, correctCnt,
    }
  })
  // 分数段分布：按得分率百分比（每次考试总分不同，统一用百分比）
  const ranges = [
    { label: '0-59%', min: 0, max: 59.999, count: 0 },
    { label: '60-69%', min: 60, max: 69.999, count: 0 },
    { label: '70-79%', min: 70, max: 79.999, count: 0 },
    { label: '80-89%', min: 80, max: 89.999, count: 0 },
    { label: '90-100%', min: 90, max: 100, count: 0 },
  ]
  for (const sc of scores) {
    const pct = totalMax > 0 ? (sc / totalMax * 100) : 0
    const r = ranges.find(r => pct >= r.min && pct <= r.max)
    if (r) r.count++
  }
  res.json({
    quiz,
    summary: { total, pending, graded: gradedCount, avg, max: maxS, min: minS, passLine, passCount, maxScore: totalMax },
    questions: qStats,
    ranges,
    submissions: subs.map(s => ({ id: s.id, user_id: s.user_id, real_name: s.real_name, total_score: s.total_score, max_score: s.max_score, status: s.status, submitted_at: s.submitted_at, graded_at: s.graded_at })),
  })
})

// ============ 学科题目池（单题训练）============
// 列出某学科题目池
app.get('/api/subjects/:id/questions', auth, async (req, res) => {
  const rows = await all<any>('SELECT * FROM subject_questions WHERE subject_id=? ORDER BY sort,id DESC', req.params.id)
  res.json(rows.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })))
})

// 取单条题目（含学科信息，供单题训练作答页使用）
app.get('/api/subject-questions/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  const subj = await get<any>('SELECT id, name, slug, icon FROM subjects WHERE id=?', q.subject_id)
  res.json({ ...q, options: j(q.options), attachments: j(q.attachments), subject: subj })
})

// 教师向学科题目池添加题目
app.post('/api/subjects/:id/questions', auth, requireStaff, async (req, res) => {
  const sid = Number(req.params.id)
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id)
  const b = req.body
  const r = await run(
    'INSERT INTO subject_questions (subject_id,creator_id,creator_name,qtype,content,options,answer,score,attachments,sort) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sid, (req as any).user.id, me?.real_name || '', b.qtype || 'single', b.content || '', JSON.stringify(b.options || []), b.answer || '', b.score || 5, JSON.stringify(b.attachments || []), b.sort || 0
  )
  res.json({ id: Number(r.lastInsertRowid) })
})

// 删除题目池中的题目（仅创建者或超管）
app.delete('/api/subject-questions/:id', auth, requireStaff, async (req, res) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  if ((req as any).user.role !== 'SUPER_ADMIN' && q.creator_id !== (req as any).user.id) {
    return res.status(403).json({ message: '无权删除他人题目' })
  }
  await run('DELETE FROM practice_submissions WHERE question_id=?', req.params.id)
  await run('DELETE FROM subject_questions WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学生提交单题训练答案
app.post('/api/subject-questions/:id/submit', auth, async (req, res) => {
  const uid = (req as any).user.id
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  const ans = req.body.answer || ''
  const isSub = q.qtype === 'subjective'
  let correct: boolean | null = null
  let score = 0
  const max = q.score || 5
  if (!isSub) {
    // 客观题自动判分
    const std = String(q.answer || '').trim()
    const got = String(ans || '').trim()
    if (q.qtype === 'multiple') {
      const a = std.split(',').map(s => s.trim()).filter(Boolean).sort().join(',')
      const b = got.split(',').map(s => s.trim()).filter(Boolean).sort().join(',')
      correct = a === b && a !== ''
    } else {
      correct = std !== '' && std === got
    }
    score = correct ? max : 0
  }
  const status = isSub ? 'pending' : 'graded'
  let subId: number
  if (status === 'graded') {
    const r = await run(
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'),?)`,
      q.id, q.subject_id, uid, ans, score, max, status, correct ? 1 : 0, uid
    )
    subId = Number(r.lastInsertRowid)
  } else {
    const r = await run(
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      q.id, q.subject_id, uid, ans, 0, max, status, null, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  // 主观题：站内信通知学科教师批改
  if (isSub) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const subj = await get<any>('SELECT name FROM subjects WHERE id=?', q.subject_id)
    const msg = `📝 ${stu?.real_name || '学生'} 在「${subj?.name || '学科'}」单题训练中提交了一道主观题\n请前往「题库 → 单题训练待批」进行批改。`
    // 通知所有该学科教师与超管
    const teachers = await all<any>("SELECT id FROM users WHERE role IN ('SUPER_ADMIN','TEACHER') AND (role='SUPER_ADMIN' OR subject_id=?)", q.subject_id)
    for (const t of teachers) {
      if (t.id !== uid) await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, t.id, msg, '[]')
    }
  }
  res.json({ id: subId, status, score, max, correct })
})

// 学生查询单题训练结果（最近一次）
app.get('/api/subject-questions/:id/my_result', auth, async (req, res) => {
  const uid = (req as any).user.id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE question_id=? AND user_id=? ORDER BY id DESC LIMIT 1', req.params.id, uid)
  if (!sub) return res.status(404).json({ message: '尚未作答' })
  res.json(sub)
})

// 教师：待批的单题训练提交列表（按学科过滤）
app.get('/api/practice/pending', auth, requireStaff, async (req, res) => {
  const me = (req as any).user
  let sql = `SELECT ps.*, sq.qtype, sq.content AS qcontent, sq.options AS qoptions, sq.answer AS qanswer, sq.subject_id, sq.attachments AS qattachments,
    u.real_name, s.name AS subject_name
    FROM practice_submissions ps
    JOIN subject_questions sq ON sq.id = ps.question_id
    JOIN users u ON u.id = ps.user_id
    JOIN subjects s ON s.id = sq.subject_id
    WHERE ps.status='pending'`
  const args: any[] = []
  if (me.role === 'TEACHER') { sql += ' AND sq.subject_id=?'; args.push(me.subject_id) }
  sql += ' ORDER BY ps.id DESC'
  const rows = await all<any>(sql, ...args)
  res.json(rows.map(r => ({
    ...r,
    qoptions: j(r.qoptions),
    qattachments: j(r.qattachments),
  })))
})

// 教师：批改单题训练
app.post('/api/practice/:id/grade', auth, requireStaff, async (req, res) => {
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', req.params.id)
  if (!sub) return res.status(404).json({ message: '提交不存在' })
  const { score, comment } = req.body
  const sc = Math.max(0, Math.min(sub.max_score, Number(score) || 0))
  await run('UPDATE practice_submissions SET score=?, status=?, comment=?, graded_at=datetime(\'now\',\'localtime\'), graded_by=? WHERE id=?',
    sc, 'graded', comment || '', (req as any).user.id, req.params.id)
  await addExp(sub.user_id, undefined, 'quiz_pass', `单题训练批改完成（${sc}/${sub.max_score}）`)
  // 站内信通知学生
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id))?.real_name || '老师'
  const msg = `✅ 你的一道单题训练主观题已被批改\n批改人：${teacherName}\n得分：${sc} / ${sub.max_score}` + (comment ? `\n评语：${comment}` : '')
  await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', (req as any).user.id, sub.user_id, msg, '[]')
  res.json({ ok: true, score: sc })
})


// ============ 通用页面：网站说明 / 博客 / 公告 ============
app.get('/api/pages', async (req, res) => {
  const { ptype, scope, classId, mine, userId } = req.query
  let sql = 'SELECT * FROM pages WHERE status=?'
  const args: any[] = ['published']
  if (ptype) { sql += ' AND ptype=?'; args.push(ptype) }
  if (scope) { sql += ' AND scope=?'; args.push(scope) }
  if (classId) { sql += ' AND class_id=?'; args.push(classId) }
  if (mine === '1' && userId) { sql += ' AND author_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 取单条 guide（无 auth 也可读，前端首页用）
app.get('/api/pages/guide', async (_req, res) => {
  const p = await get<any>("SELECT * FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  if (!p) return res.json(null)
  res.json({ ...p, images: j(p.images), attachments: j(p.attachments) })
})

app.get('/api/pages/:id', async (req, res) => {
  const p = await get<any>('SELECT * FROM pages WHERE id=?', req.params.id)
  if (!p) return res.status(404).json({ message: '不存在' })
  await run('UPDATE pages SET views = views + 1 WHERE id=?', req.params.id)
  res.json({ ...p, images: j(p.images), attachments: j(p.attachments), views: p.views + 1 })
})

// 博客/页面点赞
app.post('/api/pages/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', req.params.id)
  if (exist) return res.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'page', req.params.id)
  await run('UPDATE pages SET likes = likes + 1 WHERE id=?', req.params.id)
  res.json({ liked: true })
})

// 我是否已点赞
app.get('/api/pages/:id/liked', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', req.params.id)
  res.json({ liked: !!exist })
})

// 评论列表
app.get('/api/pages/:id/comments', async (req, res) => {
  const list = await all<any>('SELECT * FROM page_comments WHERE page_id=? ORDER BY id DESC', req.params.id)
  res.json(list)
})

// 发表评论
app.post('/api/pages/:id/comments', auth, async (req, res) => {
  const uid = (req as any).user.id
  const content = String(req.body.content || '').trim()
  if (!content) return res.status(400).json({ message: '评论内容不能为空' })
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(
    'INSERT INTO page_comments (page_id,user_id,user_name,avatar,content) VALUES (?,?,?,?,?)',
    req.params.id, uid, u?.real_name || '匿名', u?.avatar || '', content
  )
  res.json({ id: Number(r.lastInsertRowid), page_id: Number(req.params.id), user_id: uid, user_name: u?.real_name || '匿名', avatar: u?.avatar || '', content, created_at: datetimeNow() })
})

// 公告可见性筛选：全站公告 + 当前用户所在班级的班级公告
app.get('/api/announcements', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const cids = await userClassIds(uid)
  let sql = "SELECT * FROM pages WHERE ptype='announcement' AND status='published'"
  const args: any[] = []
  if (role === 'SUPER_ADMIN') {
    // 全部可见
  } else if (cids.length) {
    sql += ` AND (scope='site' OR class_id IN (${cids.map(() => '?').join(',')}))`
    args.push(...cids)
  } else {
    sql += " AND scope='site'"
  }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 网站说明（管理后台编辑）
app.put('/api/pages/guide', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { title, content, images, attachments } = req.body
  const exist = await get<any>("SELECT id FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  if (exist) {
    await run('UPDATE pages SET title=?, content=?, images=?, attachments=? WHERE id=?', title, content, JSON.stringify(images || []), JSON.stringify(attachments || []), exist.id)
    res.json({ id: exist.id })
  } else {
    const r = await run('INSERT INTO pages (ptype,scope,title,content,images,attachments,author_name,status) VALUES (?,?,?,?,?,?,?,?)', 'guide', 'site', title, content, JSON.stringify(images || []), JSON.stringify(attachments || []), '超级管理员', 'published')
    res.json({ id: Number(r.lastInsertRowid) })
  }
})

// 创建博客 / 公告
app.post('/api/pages', auth, async (req, res) => {
  const uid = (req as any).user.id
  const me = await get<any>('SELECT real_name, role FROM users WHERE id=?', uid)
  const b = req.body
  // 权限校验：公告有特殊限制；博客人人可发
  if (b.ptype === 'announcement') {
    if (b.scope === 'site') {
      if (me?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '只有超级管理员可发布全站公告' })
    } else if (b.scope === 'class') {
      if (me?.role !== 'SUPER_ADMIN' && me?.role !== 'TEACHER') return res.status(403).json({ message: '只有教师/超管可发布班级公告' })
    }
  }
  const r = await run(
    `INSERT INTO pages (ptype,scope,class_id,title,content,cover,images,attachments,author_id,author_name,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    b.ptype, b.scope || 'site', b.classId || null, b.title, b.content, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.attachments || []), uid, me?.real_name || '', 'published'
  )
  // 博客加经验
  if (b.ptype === 'blog') {
    await addExp(uid, undefined, 'blog', `发布博客《${b.title}》`)
  }
  res.json({ id: Number(r.lastInsertRowid) })
})

app.delete('/api/pages/:id', auth, async (req, res) => {
  const p = await get<any>('SELECT author_id, ptype, scope FROM pages WHERE id=?', req.params.id)
  if (!p) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role FROM users WHERE id=?', (req as any).user.id)
  const isOwner = p.author_id === (req as any).user.id
  if (!isOwner && u?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '无权限删除' })
  await run('DELETE FROM pages WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 站内信 ============
app.get('/api/messages/contacts', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  // 给我发过 / 我发给过的所有人列表
  const rows = await all<any>(
    `SELECT DISTINCT CASE WHEN from_id=? THEN to_id ELSE from_id END AS oid
     FROM messages WHERE from_id=? OR to_id=?`,
    uid, uid, uid
  )
  const ids = rows.map(r => r.oid).filter(Boolean)
  let users: any[] = []
  if (ids.length) {
    users = await all<any>(`SELECT id, real_name, role, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
  }
  // 超管：列出全部用户作为可发对象
  if (role === 'SUPER_ADMIN') {
    users = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
  }
  res.json(users)
})

// 未读消息总数（必须在 :peerId 之前定义，否则会被参数路由吞掉）
app.get('/api/messages/unread/count', auth, async (req, res) => {
  const uid = (req as any).user.id
  const r = await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND is_read=0', uid)
  res.json({ count: r?.n || 0 })
})

// 最近会话列表（用于站内信首页）
app.get('/api/messages/sessions', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const list = await all<any>(
    `SELECT m.* FROM messages m
     INNER JOIN (
       SELECT MAX(id) as mid FROM messages WHERE from_id=? OR to_id=? GROUP BY CASE WHEN from_id=? THEN to_id ELSE from_id END
     ) t ON m.id = t.mid
     ORDER BY m.id DESC`,
    uid, uid, uid
  )
  // 补充对端用户信息 + 未读数
  const result = []
  for (const m of list) {
    const peerId = m.from_id === uid ? m.to_id : m.from_id
    const peer = await get<any>('SELECT id, real_name, role, avatar FROM users WHERE id=?', peerId)
    const unread = (await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND from_id=? AND is_read=0', uid, peerId))?.n || 0
    result.push({ ...m, attachments: j(m.attachments), peer, unread })
  }
  // 超管：返回所有用户作为可监督对象
  if (role === 'SUPER_ADMIN') {
    const allUsers = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
    res.json({ sessions: result, allUsers })
  } else {
    // 普通用户也返回全部活跃用户列表，供发起新会话时选择
    const allUsers = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
    res.json({ sessions: result, allUsers })
  }
})

// 超管查任意两用户之间的消息
app.get('/api/messages/all/:aId/:bId', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const aId = Number(req.params.aId)
  const bId = Number(req.params.bId)
  const list = await all<any>(
    `SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id ASC`,
    aId, bId, bId, aId
  )
  res.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

app.post('/api/messages', auth, async (req, res) => {
  const uid = (req as any).user.id
  const { toId, content, attachments } = req.body
  if (!toId || !content) return res.status(400).json({ message: '请填写收件人和内容' })
  const r = await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, toId, content, JSON.stringify(attachments || []))
  res.json({ id: Number(r.lastInsertRowid) })
})

// 与某人的对话（参数路由，必须放在所有具名子路径之后）
app.get('/api/messages/:peerId', auth, async (req, res) => {
  const uid = (req as any).user.id
  const peerId = Number(req.params.peerId)
  if (!peerId || isNaN(peerId)) return res.status(400).json({ message: '无效的会话对象' })
  const list = await all<any>(
    `SELECT * FROM messages WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id ASC`,
    uid, peerId, peerId, uid
  )
  // 标记我收到的消息为已读
  await run('UPDATE messages SET is_read=1 WHERE to_id=? AND from_id=?', uid, peerId)
  res.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

// SPA fallback - only for non-API, non-upload, non-assets requests
app.get('/{*splat}', (req, res, next) => {
  const p = req.path
  if (p.startsWith('/api/')) return next()
  if (p.startsWith('/assets/')) return next()
  if (p.startsWith('/uploads/')) return next()
  if (fs.existsSync(path.join(distDir, 'index.html'))) res.sendFile(path.join(distDir, 'index.html'))
  else res.status(404).json({ message: '页面不存在' })
})

const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, '0.0.0.0', () => console.log(`[server] 追光后端运行于 http://localhost:${PORT}`))
