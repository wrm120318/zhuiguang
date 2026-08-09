// ==============================================================================
// 追光 · Cloudflare Workers + Hono 后端
// 由 Express 版本 (server/index.ts) 转换而来
// 保留全部 100+ 路由的完整业务逻辑、SQL 查询、JWT auth、Supabase Storage
// ==============================================================================
import { Hono } from 'hono'
import type { Context } from 'hono'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { createClient } from '@supabase/supabase-js'

// ===== Workers 环境变量类型 =====
interface Env {
  DB: D1Database
  BUCKET: R2Bucket
  JWT_SECRET?: string
  JWT_EXPIRES?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_BUCKET?: string
}

// ===== 全局变量（在请求中间件中从 c.env 设置） =====
let D1: D1Database
let R2_BUCKET: R2Bucket | null = null
let JWT_SECRET = 'zhuiguang-secret-2026'
let JWT_EXPIRES = '7d'
let SUPABASE_URL = ''
let SUPABASE_KEY = ''
let SUPABASE_BUCKET = 'zhuiguang-files'

// ===== 互斥锁（self-repair 和 __zg_fix 共用） =====
const SELF_REPAIR_LOCK = { at: 0 }
const ZGFIX_IP_LOCK = new Map<string, { at: number; cnt: number }>()

// ==============================================================================
// D1 数据库便捷封装（对应 db-d1.ts，内部用全局 D1 binding）
//   用法对应关系：
//   db.prepare(sql).all(...args)  →  await all(sql, ...args)
//   db.prepare(sql).get(...args)  →  await get(sql, ...args)
//   db.prepare(sql).run(...args)  →  await run(sql, ...args)
// ==============================================================================
export async function all<T = any>(sql: string, ...args: any[]): Promise<T[]> {
  const r = await D1.prepare(sql).bind(...args).all()
  return r.results as T[]
}
export async function get<T = any>(sql: string, ...args: any[]): Promise<T | undefined> {
  const r = await D1.prepare(sql).bind(...args).first()
  return r as T | undefined
}
export async function run(sql: string, ...args: any[]): Promise<{ lastInsertRowid: number | bigint }> {
  const r = await D1.prepare(sql).bind(...args).run()
  return { lastInsertRowid: r.meta.last_row_id as number | bigint }
}

// ==============================================================================
// JWT Auth
// ==============================================================================
export function signToken(payload: { id: number; role: string }) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES as any })
}

/** auth 中间件：验证 JWT，从数据库实时读取 role 和 status（修复身份显示错乱/权限弹窗BUG） */
export const auth = async (c: Context, next: () => Promise<void>) => {
  const h = c.req.header('authorization')
  if (!h) return c.json({ message: '未登录' }, 401)
  const token = h.startsWith('Bearer ') ? h.slice(7) : h
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; role: string }
    // 从数据库实时读取 role + status，防止 JWT 中 role 过期导致身份错乱
    try {
      const u = await get<{ status: string; role: string }>('SELECT status, role FROM users WHERE id=?', payload.id)
      if (!u) return c.json({ message: '用户不存在' }, 401)
      if (u.status === 'disabled') {
        return c.json({ message: '账号已被禁用，请联系管理员', disabled: true }, 401)
      }
      // 使用数据库中的最新 role，而非 JWT 中的旧 role
      c.set('user', { id: payload.id, role: u.role })
    } catch {
      c.set('user', payload)
    }
    await next()
  } catch {
    return c.json({ message: '登录已过期，请重新登录' }, 401)
  }
}

/** requireRole 中间件：检查用户角色 */
export const requireRole = (...roles: string[]) => {
  return async (c: Context, next: () => Promise<void>) => {
    const u = c.get('user') as { id: number; role: string } | undefined
    if (!u || !roles.includes(u.role)) return c.json({ message: '无权限' }, 403)
    await next()
  }
}

/** requireStaff 中间件：教师或超管 */
export const requireStaff = async (c: Context, next: () => Promise<void>) => {
  const u = c.get('user') as { id: number; role: string } | undefined
  if (!u || (u.role !== 'TEACHER' && u.role !== 'SUPER_ADMIN')) {
    return c.json({ message: '需要教师或管理员权限' }, 403)
  }
  await next()
}

// ==============================================================================
// Helpers（经验值、通知、权限检查等）
// ==============================================================================
let expRulesCache: Record<string, number> | null = null

const DEFAULT_EXP_RULES: Record<string, number> = {
  login: 5, register: 5, article: 15, resource: 15, query: 2, quiz_pass: 10,
  blog: 5, announcement_read: 1, message_reply: 0,
  comment: 1, like: 1, favorite: 0, practice_pass: 5,
  article_delete: -15, resource_delete: -15, blog_delete: -5, query_delete: -2,
  comment_delete: -1, like_cancel: -1, favorite_cancel: 0,
  quiz_fail: 0, practice_fail: 0, admin_adjust: 0,
}

export async function getExpRules(): Promise<Record<string, number>> {
  if (expRulesCache) return expRulesCache
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='exp_rules'")
    const saved = r ? JSON.parse(r.value) : {}
    // 合并默认规则与已保存规则，确保所有场景都有默认值
    expRulesCache = { ...DEFAULT_EXP_RULES, ...saved }
  } catch { expRulesCache = { ...DEFAULT_EXP_RULES } }
  return expRulesCache!
}

export function refreshExpRules() { expRulesCache = null }

export async function addExp(userId: number, change: number | undefined, actionType: string, desc: string) {
  let delta = change
  if (delta === undefined) {
    const rules = await getExpRules()
    delta = rules[actionType] ?? 0
  }
  if (!delta) return
  await run('UPDATE users SET exp = exp + ?, level = (exp / 60) + 1 WHERE id = ?', delta, userId)
  await run(`INSERT INTO exp_logs (user_id,action_type,exp_change,description,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, userId, actionType, delta, desc)
}

export async function addNotice(userId: number, title: string, content: string, type: string) {
  await run(`INSERT INTO notices (user_id,title,content,type,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, userId, title, content, type)
}

export async function userClassIds(userId: number): Promise<number[]> {
  const rows = await all<{ class_id: number }>('SELECT class_id FROM class_members WHERE user_id = ?', userId)
  return rows.map(r => r.class_id)
}

export async function teachingSubjects(userId: number): Promise<number[]> {
  const rows = await all<{ subject_id: number }>('SELECT DISTINCT subject_id FROM class_members WHERE user_id = ? AND role_in_class = ? AND subject_id IS NOT NULL', userId, 'TEACHER')
  return rows.map(r => r.subject_id)
}

let flagsCache: Record<string, boolean> | null = null
export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  if (flagsCache) return flagsCache
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='feature_flags'")
    flagsCache = r ? JSON.parse(r.value) : {}
    try {
      const rr = await get<{ value: string }>("SELECT value FROM feature_flags WHERE key='registration_enabled'")
      flagsCache.registration_enabled = !rr || rr.value !== '0'
    } catch {}
  } catch { flagsCache = {} }
  return flagsCache!
}
export function refreshFeatureFlags() { flagsCache = null }
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const f = await getFeatureFlags()
  return f[key] !== false
}

// ==============================================================================
// Storage（R2 优先，Supabase 回退 — 双线路兼容）
// ==============================================================================
let _supabase: any = null

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  if (!_supabase) {
    _supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  }
  return _supabase
}

const STORAGE_ENABLED = true

/** 生成 Supabase 签名上传 URL（前端直传用，仅 R2 不可用时回退） */
export async function createPresignedUploadUrl(key: string): Promise<{ signedUrl: string; publicUrl: string } | null> {
  const sb = getSupabase()
  if (!sb) return null
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).createSignedUploadUrl(key)
  if (error || !data?.signedUrl) return null
  const pub = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(key).data.publicUrl
  return { signedUrl: data.signedUrl, publicUrl: pub }
}

/** 通过 file_path 推断 MIME */
function guessContentType(key: string): string {
  const ext = extname(key).toLowerCase()
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[ext] || 'application/octet-stream'
}

/** 上传文件 — R2 优先，Supabase 回退。返回 /file/key 或 Supabase publicUrl */
export async function uploadFile(key: string, data: ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
  // 线路1：R2 私有桶
  if (R2_BUCKET) {
    await R2_BUCKET.put(key, data, { httpMetadata: { contentType: contentType || guessContentType(key) } })
    return `/file/${key}`
  }
  // 线路2：Supabase 回退
  const sb = getSupabase()
  if (!sb) throw new Error('Storage not configured (R2 和 Supabase 均不可用)')
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(key, data, { contentType, upsert: true })
  if (error) throw error
  const { data: d } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(key)
  return d.publicUrl
}

/** 删除文件 — R2 + Supabase 双删（确保双线路都清理干净） */
export async function deleteFile(key: string): Promise<void> {
  if (!key) return
  // R2 删除
  if (R2_BUCKET) { try { await R2_BUCKET.delete(key) } catch {} }
  // Supabase 删除
  const sb = getSupabase()
  if (sb) { try { await sb.storage.from(SUPABASE_BUCKET).remove([key]) } catch {} }
}

/** 从 file_path 字段提取存储 key（兼容 /file/key、Supabase URL、裸 key） */
export function extractKey(filePath: string): string {
  if (!filePath) return ''
  // /file/xxx 格式
  if (filePath.startsWith('/file/')) return filePath.slice(6)
  // 如果是完整的 Supabase URL，提取 object key
  if (/^https?:\/\//.test(filePath)) {
    const m = filePath.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)$/)
    if (m) return m[1]
    const parts = filePath.split('/')
    return parts[parts.length - 1] || ''
  }
  return filePath.replace(/^\/?uploads?\//, '')
}

/** 下载文件 — R2 优先，Supabase 回退 */
export async function downloadFile(filePath: string): Promise<{ buffer: ArrayBuffer; contentType?: string } | null> {
  const key = extractKey(filePath)
  if (!key) return null
  // 线路1：R2
  if (R2_BUCKET) {
    const obj = await R2_BUCKET.get(key)
    if (obj) return { buffer: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType }
  }
  // 线路2：Supabase 回退
  const sb = getSupabase()
  if (!sb) return null
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(key)
  if (error || !data) return null
  return { buffer: await data.arrayBuffer(), contentType: (data as any).type }
}

// ==============================================================================
// 工具函数
// ==============================================================================
const j = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null } catch { return null } }
const pub = (u: any) => { if (!u) return u; const { password_hash, ...rest } = u; return rest }

function setDownloadHeaders(c: Context, filename: string) {
  const encoded = encodeURIComponent(filename)
  c.header('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
}

function canManageSubject(user: any, subjectId: any): boolean {
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  if (user.role === 'TEACHER') return user.subject_id === subjectId
  return false
}

function datetimeNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}
function dateNowBeijing() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}
function datetimeBeijing(d: Date) {
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

/** path.extname 的 Workers 兼容替代 */
function extname(filename: string): string {
  const idx = filename.lastIndexOf('.')
  if (idx < 0) return ''
  return filename.slice(idx)
}

/** 可选 auth 解析（返回 {id,role,subject_id} | null） */
async function parseOptionalAuth(c: Context): Promise<{ id: number; role: string; subject_id: number | null } | null> {
  const h = c.req.header('authorization')
  if (!h || !h.startsWith('Bearer ')) return null
  try {
    const token = h.slice(7)
    const dec: any = jwt.verify(token, JWT_SECRET)
    if (!dec || !dec.id) return null
    const u = await get<any>('SELECT id, role, subject_id, status FROM users WHERE id=?', dec.id)
    if (!u || u.status === 'disabled') return null
    return { id: u.id, role: u.role, subject_id: u.subject_id ? Number(u.subject_id) : null }
  } catch { return null }
}

// ==============================================================================
// API 短期内存缓存（只缓存 GET /api/*，按 Authorization hash+URL 做 key）
// ==============================================================================
type CacheEntry = { body: string; type: string; expireAt: number; etag: string }
const API_CACHE = new Map<string, CacheEntry>()
const API_CACHE_MAX = 500

function apiCacheKey(c: Context): string | null {
  if (c.req.method !== 'GET') return null
  const p = new URL(c.req.url).pathname
  if (!p.startsWith('/api/')) return null
  if (p.includes('/upload/') || p.includes('/download/') || p.includes('/comments') || p.includes('/export')) return null
  const auth = (c.req.header('authorization') || '').slice(0, 200)
  let authHash = 'anon'
  try { authHash = btoa(auth).slice(0, 24) } catch {}
  let ttl = 15000
  if (p.includes('/admin/monitor') || p.includes('/me/status') || p.includes('/online')) ttl = 30000
  if (p.includes('/feature-flags') || p.includes('/pages/') || p.includes('/themes')) ttl = 30000
  const urlKey = p + '|' + new URL(c.req.url).search
  return `${authHash}|${ttl}|${urlKey}`
}

let lastCacheCleanup = 0
function maybeCleanupCache() {
  const now = Date.now()
  if (now - lastCacheCleanup > 30000) {
    lastCacheCleanup = now
    for (const [k, v] of API_CACHE) if (v.expireAt < now) API_CACHE.delete(k)
  }
}

/** 清除全部缓存（公共内容修改后调用，确保所有用户立即看到最新数据） */
function clearAllCache() {
  API_CACHE.clear()
}

// ==============================================================================
// Hono App
// ==============================================================================
let AUTO_MIGRATION_DONE = false
const app = new Hono<{ Bindings: Env; Variables: { user: { id: number; role: string } } }>()

// ===== 中间件1：从 c.env 设置全局变量 =====
app.use('*', async (c, next) => {
  D1 = c.env.DB
  R2_BUCKET = c.env.BUCKET || null
  JWT_SECRET = c.env.JWT_SECRET || JWT_SECRET
  JWT_EXPIRES = c.env.JWT_EXPIRES || JWT_EXPIRES
  SUPABASE_URL = c.env.SUPABASE_URL || ''
  SUPABASE_KEY = c.env.SUPABASE_SERVICE_KEY || c.env.SUPABASE_ANON_KEY || ''
  SUPABASE_BUCKET = c.env.SUPABASE_BUCKET || SUPABASE_BUCKET
  // 首次请求自动建表/补列（确保评论、设置等功能可用）
  if (!AUTO_MIGRATION_DONE) {
    AUTO_MIGRATION_DONE = true
    try {
      await D1.prepare(`CREATE TABLE IF NOT EXISTS article_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, article_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT, avatar TEXT, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','+8 hours')))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS page_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT, avatar TEXT, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','+8 hours')))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, value TEXT)`).run()
      try { await D1.prepare("ALTER TABLE pages ADD COLUMN updated_at TEXT").run() } catch {}
      try { await D1.prepare("ALTER TABLE articles ADD COLUMN actual_user_id INTEGER").run() } catch {}
      try { await D1.prepare("UPDATE pages SET updated_at=created_at WHERE updated_at IS NULL OR updated_at='none'").run() } catch {}
      try { await D1.prepare('CREATE INDEX IF NOT EXISTS idx_art_c_a ON article_comments(article_id)').run() } catch {}
    } catch {}
  }
  await next()
})

// ===== 中间件2：CORS（动态回显Origin，支持withCredentials） =====
app.use('*', async (c, next) => {
  const origin = c.req.header('Origin') || '*'
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  c.header('Access-Control-Allow-Credentials', 'true')
  if (c.req.method === 'OPTIONS') return c.text('', 204)
  await next()
})

// ===== 中间件3：记录登录用户最后活跃时间 =====
app.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const decoded: any = jwt.verify(token, JWT_SECRET)
      if (decoded && decoded.id) {
        const now = datetimeNow()
        run('UPDATE users SET last_active=? WHERE id=?', now, decoded.id).catch(() => {})
      }
    } catch {}
  }
  await next()
})

// ===== 中间件4：API 短期内存缓存 =====
app.use('*', async (c, next) => {
  maybeCleanupCache()
  const k = apiCacheKey(c)
  if (!k) {
    // 非 GET 请求（POST/PUT/PATCH/DELETE）：清除全部缓存，确保后续 GET 拿到最新数据
    if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS' && c.req.method !== 'HEAD') {
      clearAllCache()
    }
    await next(); return
  }
  const [, ttlStr] = k.split('|', 3)
  const ttl = parseInt(ttlStr || '15000', 10)
  const e = API_CACHE.get(k)
  if (e && e.expireAt > Date.now()) {
    const ifNm = c.req.header('if-none-match')
    if (ifNm === e.etag) {
      c.header('X-Zg-Cache', 'HIT-304')
      return c.body(null, 304)
    }
    c.header('Content-Type', e.type)
    c.header('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`)
    c.header('ETag', e.etag)
    c.header('X-Zg-Cache', `HIT-${Math.floor((e.expireAt - Date.now()) / 1000)}s`)
    return c.body(e.body)
  }
  await next()
  // 缓存响应
  try {
    if (c.res.status >= 200 && c.res.status < 300) {
      const body = await c.res.text()
      let hash = 0
      for (let i = 0; i < body.length; i++) hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0
      const etag = 'W/"' + Math.abs(hash).toString(36) + '-' + body.length.toString(36) + '"'
      const contentType = c.res.headers.get('Content-Type') || 'application/json; charset=utf-8'
      if (API_CACHE.size >= API_CACHE_MAX) {
        const firstKey = API_CACHE.keys().next().value
        if (firstKey) API_CACHE.delete(firstKey)
      }
      API_CACHE.set(k, { body, type: contentType, expireAt: Date.now() + ttl, etag })
      const headers = new Headers(c.res.headers)
      headers.set('ETag', etag)
      headers.set('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`)
      headers.set('X-Zg-Cache', 'MISS')
      c.res = new Response(body, { status: c.res.status, headers })
    }
  } catch {}
})

// ==============================================================================
// /file/* R2 私有桶鉴权路由（复用 JWT 登录校验，支持 Cookie/Header/Query 三种鉴权方式）
// 未登录拦截跳转登录页，已登录流式返回 R2 文件（含缓存头提速）
// R2 未命中时自动回退 Supabase（双线路兼容）
// ==============================================================================

/** 从请求中提取 JWT token（支持 Header / Cookie / Query Param 三种方式） */
function getTokenFromRequest(c: Context): string | null {
  // 1. Authorization header（用于 fetch/API 请求）
  const h = c.req.header('authorization')
  if (h) return h.startsWith('Bearer ') ? h.slice(7) : h
  // 2. Cookie（同域时 <img> 标签自动携带）
  const cookie = c.req.header('cookie') || ''
  const m = cookie.match(/zg_token=([^;]+)/)
  if (m) return m[1]
  // 3. Query param ?t=xxx（跨域 <img> 标签使用）
  const t = c.req.query('t')
  if (t) return t
  return null
}

app.get('/file/*', async (c) => {
  // 鉴权：复用 JWT 登录校验
  const token = getTokenFromRequest(c)
  if (!token) {
    const accept = c.req.header('accept') || ''
    if (accept.includes('text/html')) return c.redirect('/login', 302)
    return c.json({ message: '未登录' }, 401)
  }
  let userId = 0
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; role: string }
    const u = await get<{ status: string }>('SELECT status FROM users WHERE id=?', payload.id)
    if (!u || u.status === 'disabled') return c.json({ message: '未登录' }, 401)
    userId = payload.id
  } catch {
    return c.json({ message: '登录已过期' }, 401)
  }

  // 提取文件 key
  const path = new URL(c.req.url).pathname
  const key = decodeURIComponent(path.replace(/^\/file\//, ''))
  if (!key) return c.json({ message: '无效路径' }, 400)

  const origin = c.req.header('Origin') || '*'
  const cacheHeaders: Record<string, string> = {
    'Cache-Control': 'private, max-age=86400',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  }

  // 线路1：R2 私有桶
  if (R2_BUCKET) {
    const obj = await R2_BUCKET.get(key)
    if (obj) {
      const ct = obj.httpMetadata?.contentType || guessContentType(key)
      return new Response(obj.body, {
        headers: { ...cacheHeaders, 'Content-Type': ct, 'ETag': obj.etag || '' },
      })
    }
  }

  // 线路2：Supabase 回退（旧文件仍可访问）
  const sb = getSupabase()
  if (sb) {
    const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(key)
    if (data) {
      const ct = (data as any).type || guessContentType(key)
      return new Response(await data.arrayBuffer(), {
        headers: { ...cacheHeaders, 'Content-Type': ct },
      })
    }
  }

  return c.json({ message: '文件不存在' }, 404)
})

// ==============================================================================
// 健康检查 + 小白公开修复接口（放在所有业务路由之前）
// ==============================================================================

// (1) 健康检查接口
app.get('/__zg_health', (c) => {
  return c.text('OK:' + Date.now().toString(36))
})

// (2) 小白公开修复接口（不用登录，改成 D1 完整性检查 + 索引重建）
app.get('/__zg_fix', async (c) => {
  const now = Date.now()
  const ip = (c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || '0.0.0.0').split(',')[0].trim()
  // 防刷：同一IP 1小时≤2次
  const rec = ZGFIX_IP_LOCK.get(ip) || { at: 0, cnt: 0 }
  if (now - rec.at > 60 * 60 * 1000) { rec.at = now; rec.cnt = 0 }
  if (rec.cnt >= 2) {
    return c.html(`<!doctype html><meta charset="utf-8"><title>追光 · 修复太频繁</title>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fff7ed;color:#9a3412;padding:60px 24px;line-height:1.8">
<h2 style="margin:0 0 12px;font-size:20px">⏳ 修复太频繁啦</h2>
<p style="margin:0 0 16px">为了保护服务器，同一个IP 1小时内最多修复2次。</p>
<p style="margin:0 0 16px">上次修复还没超过1小时，请耐心等一等，多按几次 <b>F5</b> 刷新试试。</p>
<p style="margin:0;color:#6b7280">如果一直不好，直接和AI助手说一句「网站挂了」就行～</p>
</body></html>`, 429)
  }
  rec.cnt += 1; ZGFIX_IP_LOCK.set(ip, rec)
  // 10分钟互斥锁
  if (now - SELF_REPAIR_LOCK.at < 10 * 60 * 1000) {
    return c.html(`<!doctype html><meta charset="utf-8"><title>追光 · 修复进行中</title>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fef3c7;color:#92400e;padding:60px 24px;line-height:1.8">
<h2 style="margin:0 0 12px;font-size:20px">🔄 修复已经在跑啦～</h2>
<p style="margin:0 0 16px">10分钟内已经有一次修复在执行，不用重复点。</p>
<p style="margin:0 0 16px">请耐心等 <b>1~2 分钟</b>，然后 <b>多按几次 F5（Ctrl+R）</b> 刷新页面。</p>
<p style="margin:0;color:#6b7280">如果3分钟后还是打不开，直接和AI助手说一句「网站挂了」～</p>
</body></html>`, 200)
  }
  SELF_REPAIR_LOCK.at = now
  // D1 修复：完整性检查 + 索引重建
  try {
    await D1.prepare('PRAGMA integrity_check').first()
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_art_c_a ON article_comments(article_id)',
      'CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status)',
      'CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status)',
      'CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_exp_logs_user ON exp_logs(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, is_read)',
      'CREATE INDEX IF NOT EXISTS idx_likes_map ON likes_map(user_id, target_type)',
      'CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(ptype, status)',
      'CREATE INDEX IF NOT EXISTS idx_quiz_sub_quiz ON quiz_submissions(quiz_id, user_id)',
    ]
    for (const idx of indexes) { try { await D1.prepare(idx).run() } catch {} }
    // 确保pages表有updated_at列（历史数据可能缺失）
    try { await D1.prepare("ALTER TABLE pages ADD COLUMN updated_at TEXT").run() } catch {}
    // 确保articles表有actual_user_id列
    try { await D1.prepare("ALTER TABLE articles ADD COLUMN actual_user_id INTEGER").run() } catch {}
    // 初始化已存在guide记录的updated_at
    try { await D1.prepare("UPDATE pages SET updated_at=created_at WHERE updated_at IS NULL OR updated_at='none'").run() } catch {}
    await D1.prepare('ANALYZE').run()
  } catch {}
  return c.html(`<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>追光 · 自动修复已启动 ✅</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #fff7ed 0%, #fef3c7 100%); color: #78350f; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border-radius: 20px; padding: 40px 28px; max-width: 520px; width: 100%;
    box-shadow: 0 20px 50px rgba(245,158,11,.18), 0 4px 10px rgba(245,158,11,.08); text-align: center; }
  .emoji { font-size: 64px; display: block; margin-bottom: 16px; animation: bounce 1.2s ease-in-out infinite; }
  @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  h1 { font-size: 22px; margin-bottom: 14px; color: #92400e; font-weight: 800; }
  p { font-size: 15px; line-height: 1.85; margin-bottom: 12px; color: #78350f; }
  .step { background: #fffbeb; border-radius: 12px; padding: 14px 16px; margin: 18px 0; text-align: left; }
  .step li { font-size: 14px; line-height: 2; color: #78350f; list-style: none; padding-left: 0; }
  .n { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center;
       background: #f59e0b; color: #fff; border-radius: 50%; font-size: 12px; font-weight: 700; margin-right: 8px; }
  .tip { font-size: 12px; color: #6b7280; margin-top: 18px; padding-top: 14px; border-top: 1px dashed #fcd34d; }
  kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 6px;
        padding: 2px 8px; font-size: 12px; font-family: inherit; color: #374151; }
</style>
<body>
<div class="card">
  <span class="emoji">🚑</span>
  <h1>自动修复已经启动啦！</h1>
  <p>数据库完整性检查已完成，索引已重建。</p>
  <div class="step">
    <ul>
      <li><span class="n">1</span> 耐心等待 <b>几秒钟</b></li>
      <li><span class="n">2</span> 然后 <b>多按几次 <kbd>F5</kbd>（或 <kbd>Ctrl</kbd>+<kbd>R</kbd>）</b> 刷新</li>
      <li><span class="n">3</span> 如果还是不好 → 直接和 AI 助手说一句「网站挂了」</li>
    </ul>
  </div>
  <p style="font-size:13px;color:#b45309;font-weight:600">💡 提示：您可以把本页加入收藏，下次坏了直接打开就能修。</p>
  <div class="tip">修复接口：<code>/__zg_fix</code>（记住这个网址=随时自己修）</div>
</div>
</body>`, 200)
})

// ==============================================================================
// ============ 认证 ============
// ==============================================================================
app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json()
  const u = await get<any>('SELECT * FROM users WHERE username = ?', username)
  if (!u) return c.json({ message: '用户不存在' }, 400)
  if (u.status === 'disabled') return c.json({ message: '账号已被禁用，请联系管理员', disabled: true }, 401)
  if (u.status !== 'active') return c.json({ message: '账号状态异常' }, 400)
  if (!bcrypt.compareSync(password, u.password_hash)) return c.json({ message: '密码错误' }, 400)
  const today = dateNowBeijing()
  const todayLogin = await get('SELECT id FROM exp_logs WHERE user_id=? AND action_type=? AND substr(created_at,1,10)=? LIMIT 1', u.id, 'login', today)
  if (!todayLogin) await addExp(u.id, undefined, 'login', '每日首次登录')
  const token = signToken({ id: u.id, role: u.role })
  // 设置 Cookie 供 /file/* 路由鉴权（同域时 <img> 标签自动携带）
  c.header('Set-Cookie', `zg_token=${token}; Path=/; SameSite=None; Secure; Max-Age=604800`, { append: true })
  return c.json({ token, user: pub(u) })
})

app.get('/api/me/status', async (c) => {
  const authHeader = c.req.header('authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ login: false, disabled: false, userId: null })
  }
  try {
    const token = authHeader.slice(7)
    const decoded: any = jwt.verify(token, JWT_SECRET)
    if (!decoded || !decoded.id) {
      return c.json({ login: false, disabled: false, userId: null })
    }
    const u = await get<{ status: string }>('SELECT status FROM users WHERE id=?', decoded.id)
    if (!u) return c.json({ login: false, disabled: false, userId: null })
    return c.json({ login: true, disabled: u.status === 'disabled', userId: Number(decoded.id) })
  } catch {
    return c.json({ login: false, disabled: false, userId: null })
  }
})

app.post('/api/auth/register', async (c) => {
  let callerIsAdmin = false
  const authHeader = c.req.header('authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const decoded: any = jwt.verify(token, JWT_SECRET)
      if (decoded && decoded.role === 'SUPER_ADMIN') callerIsAdmin = true
    } catch {}
  }
  const regFlag = await get<{ value: string }>("SELECT value FROM feature_flags WHERE key='registration_enabled'")
  if (!callerIsAdmin && regFlag && regFlag.value === '0') {
    return c.json({ message: '管理员已关闭注册功能' }, 403)
  }
  const { username, password, realName, email, classId } = await c.req.json()
  if (!username || !password || !realName) return c.json({ message: '请填写完整信息' }, 400)
  if (await get('SELECT id FROM users WHERE username = ?', username)) return c.json({ message: '用户名已存在' }, 400)
  const hash = bcrypt.hashSync(password, 8)
  const r = await run(`INSERT INTO users (username,password_hash,real_name,role,email,avatar,created_at) VALUES (?,?,?,?,?,?,datetime('now','+8 hours'))`, username, hash, realName, 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, classId, uid, 'STUDENT')
  await addExp(uid, undefined, 'register', '注册奖励')
  const newUser = await get<any>('SELECT * FROM users WHERE id=?', uid)
  return c.json({ token: signToken({ id: uid, role: 'STUDENT' }), user: pub(newUser) })
})

app.get('/api/auth/me', auth, async (c) => {
  const u = await get<any>('SELECT * FROM users WHERE id = ?', c.get('user').id)
  return c.json({ user: pub(u) })
})

// ==============================================================================
// ============ 用户管理 ============
// ==============================================================================
app.get('/api/users', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const list = await all<any>('SELECT u.*, cm.class_id FROM users u LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE role_in_class=?) cm ON u.id=cm.user_id ORDER BY u.id', 'STUDENT')
  return c.json(list.map(pub))
})

app.post('/api/users', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { username, realName, role, email, classId, password, subjectId } = await c.req.json()
  if (await get('SELECT id FROM users WHERE username=?', username)) return c.json({ message: '用户名已存在' }, 400)
  const hash = bcrypt.hashSync(password || '123456', 8)
  const r = await run(`INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','+8 hours'))`, username, hash, realName, role || 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`, subjectId ?? null)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
  return c.json({ id: uid })
})

// 批量导入用户
app.post('/api/users/import', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { users } = await c.req.json() as { users: Array<{ realName: string; username: string; role: string; email?: string; password?: string; classId?: number; subjectId?: number | null }> }
  if (!Array.isArray(users) || !users.length) return c.json({ message: '未检测到用户数据' }, 400)
  const results: { success: number; skipped: number; errors: string[] } = { success: 0, skipped: 0, errors: [] }
  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    const lineNo = i + 2
    try {
      if (!u.username || !u.realName) { results.errors.push(`第${lineNo}行：姓名和用户名不能为空`); continue }
      const existing = await get('SELECT id FROM users WHERE username=?', u.username)
      if (existing) { results.skipped++; results.errors.push(`第${lineNo}行：用户名「${u.username}」已存在，跳过`); continue }
      const role = u.role || 'STUDENT'
      const hash = bcrypt.hashSync(u.password || '123456', 8)
      const email = u.email || `${u.username}@zguang.edu`
      const avatar = `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}${i}`
      const r = await run(`INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','+8 hours'))`, u.username, hash, u.realName, role, email, avatar, u.subjectId ?? null)
      const uid = Number(r.lastInsertRowid)
      if (u.classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, u.classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
      results.success++
    } catch (e: any) { results.errors.push(`第${lineNo}行：${e.message || '未知错误'}`) }
  }
  return c.json(results)
})

app.patch('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { username, realName, email, role, subjectId, classId } = await c.req.json()
  const id = c.req.param('id')
  const u = await get('SELECT id FROM users WHERE id=?', id)
  if (!u) return c.json({ message: '用户不存在' }, 404)
  if (username !== undefined) await run('UPDATE users SET username=? WHERE id=?', username, id)
  if (realName !== undefined) await run('UPDATE users SET real_name=? WHERE id=?', realName, id)
  if (email !== undefined) await run('UPDATE users SET email=? WHERE id=?', email, id)
  if (role !== undefined) await run('UPDATE users SET role=? WHERE id=?', role, id)
  if (subjectId !== undefined) await run('UPDATE users SET subject_id=? WHERE id=?', subjectId ?? null, id)
  if (classId !== undefined) {
    // 先删除该用户的 STUDENT 类型班级关联，再按新值插入（null 表示移出班级）
    await run('DELETE FROM class_members WHERE user_id=? AND role_in_class=?', id, 'STUDENT')
    if (classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, classId, id, 'STUDENT')
  }
  return c.json({ ok: true })
})

app.patch('/api/users/:id/status', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { status } = await c.req.json()
  await run('UPDATE users SET status = ? WHERE id = ?', status, c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/users/:id/reset', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { password } = await c.req.json()
  const pwd = password || '123456'
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pwd, 8), c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/users/:id/password', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { password } = await c.req.json()
  if (!password || password.length < 4) return c.json({ message: '密码至少 4 位' }, 400)
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 8), c.req.param('id'))
  return c.json({ ok: true })
})

app.delete('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  await run('DELETE FROM exp_logs WHERE user_id=?', id)
  await run('DELETE FROM likes_map WHERE user_id=?', id)
  await run('DELETE FROM notices WHERE user_id=?', id)
  await run('DELETE FROM class_members WHERE user_id=?', id)
  await run('DELETE FROM articles WHERE user_id=?', id)
  await run('DELETE FROM resources WHERE user_id=?', id)
  await run('DELETE FROM users WHERE id=?', id)
  return c.json({ ok: true })
})

app.patch('/api/users/:id/exp', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { exp, level } = await c.req.json()
  const id = c.req.param('id')
  if (exp !== undefined) await run('UPDATE users SET exp=? WHERE id=?', exp, id)
  if (level !== undefined) await run('UPDATE users SET level=? WHERE id=?', level, id)
  return c.json({ ok: true })
})

app.patch('/api/profile', auth, async (c) => {
  const id = c.get('user').id
  const { realName, email, avatar } = await c.req.json()
  await run('UPDATE users SET real_name=?, email=?, avatar=? WHERE id=?', realName, email, avatar, id)
  const u = await get<any>('SELECT * FROM users WHERE id=?', id)
  return c.json({ user: pub(u) })
})

app.post('/api/upload/avatar', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  if (!R2_BUCKET && !getSupabase()) return c.json({ message: '文件存储未配置（R2 和 Supabase 均不可用）' }, 500)
  const ext = extname(file.name) || '.png'
  const key = `avatar_${c.get('user').id}_${Date.now()}${ext}`
  const arrayBuffer = await file.arrayBuffer()
  const url = await uploadFile(key, arrayBuffer, file.type)
  await run('UPDATE users SET avatar=? WHERE id=?', url, c.get('user').id)
  return c.json({ url })
})

// ============ 前端直传 Supabase 的预签名 URL（R2 可用时自动走 fallback 到后端代传） ============
app.post('/api/upload/presign', auth, async (c) => {
  const { fileName, contentType } = await c.req.json()
  if (!fileName) return c.json({ message: '缺少 fileName' }, 400)
  const ext = extname(fileName) || ''
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  // R2 可用时，直接走后端代传（返回 fallback 让前端走 /api/upload/file）
  if (R2_BUCKET) return c.json({ fallback: true, key, fileType: typeMap[ext] || 'file' })
  const result = await createPresignedUploadUrl(key)
  if (!result) return c.json({ fallback: true, key })
  return c.json({ signedUrl: result.signedUrl, publicUrl: result.publicUrl, key, fileType: typeMap[ext] || 'file' })
})

// 图片专用 presign
app.post('/api/upload/presign-image', auth, async (c) => {
  const { fileName } = await c.req.json()
  if (!fileName) return c.json({ message: '缺少 fileName' }, 400)
  const ext = extname(fileName) || '.png'
  const key = `img_${c.get('user').id}_${Date.now()}${ext}`
  // R2 可用时，直接走后端代传
  if (R2_BUCKET) return c.json({ fallback: true, key })
  const result = await createPresignedUploadUrl(key)
  if (!result) return c.json({ fallback: true, key })
  return c.json({ signedUrl: result.signedUrl, publicUrl: result.publicUrl, key })
})

// ==============================================================================
// ============ 班级 ============
// ==============================================================================
app.get('/api/classes', auth, async (c) => c.json(await all('SELECT * FROM classes ORDER BY id')))

app.post('/api/classes', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { name, grade, description } = await c.req.json()
  const r = await run(`INSERT INTO classes (name,grade,description,created_at) VALUES (?,?,?,datetime('now','+8 hours'))`, name, grade || '', description || '')
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { name, grade, description } = await c.req.json()
  await run('UPDATE classes SET name=?,grade=?,description=? WHERE id=?', name, grade, description, c.req.param('id'))
  return c.json({ ok: true })
})

app.delete('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  await run('DELETE FROM class_members WHERE class_id=?', id)
  await run('DELETE FROM classes WHERE id=?', id)
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 学科 ============
// ==============================================================================
app.get('/api/subjects', async (c) => {
  const list = await all<any>('SELECT * FROM subjects ORDER BY display_order')
  return c.json(list.map(s => ({ ...s, modules: j(s.modules) })))
})

app.get('/api/subjects/:slug', async (c) => {
  const s = await get<any>('SELECT * FROM subjects WHERE slug = ?', c.req.param('slug'))
  if (!s) return c.json({ message: '学科不存在' }, 404)
  return c.json({ ...s, modules: j(s.modules) })
})

app.post('/api/subjects', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { name, slug, icon, color, description, displayOrder, modules, announcement } = await c.req.json()
  if (await get('SELECT id FROM subjects WHERE slug=?', slug)) return c.json({ message: 'slug已存在' }, 400)
  const r = await run('INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)',
    name, slug, icon || '📚', color || '#f59e0b', description || '', displayOrder || 0, JSON.stringify(modules || {}), announcement || '')
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { name, icon, color, description, displayOrder, modules, announcement } = await c.req.json()
  const id = c.req.param('id')
  if (name !== undefined) await run('UPDATE subjects SET name=? WHERE id=?', name, id)
  if (icon !== undefined) await run('UPDATE subjects SET icon=? WHERE id=?', icon, id)
  if (color !== undefined) await run('UPDATE subjects SET color=? WHERE id=?', color, id)
  if (description !== undefined) await run('UPDATE subjects SET description=? WHERE id=?', description, id)
  if (displayOrder !== undefined) await run('UPDATE subjects SET display_order=? WHERE id=?', displayOrder, id)
  if (modules !== undefined) await run('UPDATE subjects SET modules=? WHERE id=?', JSON.stringify(modules), id)
  if (announcement !== undefined) await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, id)
  return c.json({ ok: true })
})

app.delete('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  await run('DELETE FROM articles WHERE subject_id=?', id)
  await run('DELETE FROM resources WHERE subject_id=?', id)
  await run('DELETE FROM subjects WHERE id=?', id)
  return c.json({ ok: true })
})

app.patch('/api/subjects/:id/announcement', auth, requireStaff, async (c) => {
  const { announcement } = await c.req.json()
  await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, c.req.param('id'))
  return c.json({ ok: true })
})

// 用户班级/任教
app.get('/api/me/classes', auth, async (c) => {
  const id = c.get('user').id
  return c.json({ classIds: await userClassIds(id), teachingSubjects: await teachingSubjects(id) })
})

// ==============================================================================
// ============ 美文 ============
// ==============================================================================
app.get('/api/articles', async (c) => {
  const subjectId = c.req.query('subjectId')
  const status = c.req.query('status')
  const mine = c.req.query('mine')
  const userId = c.req.query('userId')
  const allStatus = c.req.query('allStatus')
  const me = await parseOptionalAuth(c)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null

  const statusClauses: string[] = []
  const statusArgs: any[] = []
  const explicitStatus = typeof status === 'string' && status
  const wantAllStatus = allStatus === '1' && (myRole === 'SUPER_ADMIN' || myRole === 'TEACHER')

  if (myRole === 'SUPER_ADMIN') {
    if (explicitStatus) { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
  } else if (myRole === 'TEACHER') {
    const sids = await teachingSubjects(myId)
    if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
    const parts: string[] = []
    parts.push("a.status='approved'")
    parts.push('a.user_id=?'); statusArgs.push(myId)
    if (sids.length) {
      const ph = sids.map(() => '?').join(',')
      parts.push(`(a.status<>'approved' AND a.subject_id IN (${ph}))`)
      statusArgs.push(...sids)
    }
    parts.push('a.actual_user_id=?'); statusArgs.push(myId)
    statusClauses.push(`(${parts.join(' OR ')})`)
    if (explicitStatus && !wantAllStatus) { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
  } else if (myRole === 'STUDENT') {
    const parts: string[] = []
    parts.push("a.status='approved'")
    parts.push('a.user_id=?'); statusArgs.push(myId)
    parts.push('a.actual_user_id=?'); statusArgs.push(myId)
    statusClauses.push(`(${parts.join(' OR ')})`)
    if (explicitStatus && !wantAllStatus) { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
  } else {
    if (explicitStatus && explicitStatus === 'approved') { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
    else { statusClauses.push("a.status='approved'") }
  }

  let sql = `SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    WHERE 1=1`
  const args: any[] = []
  if (statusClauses.length) { sql += ' AND (' + statusClauses.join(') AND (') + ')'; args.push(...statusArgs) }
  if (subjectId) { sql += ' AND a.subject_id=?'; args.push(subjectId) }
  if (mine === '1') {
    if (!me) return c.json([])
    sql += ' AND (a.user_id=? OR a.actual_user_id=?)'; args.push(myId, myId)
  } else if (userId && myRole === 'SUPER_ADMIN') {
    sql += ' AND a.user_id=?'; args.push(userId)
  }
  sql += ' ORDER BY a.id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map(a => ({ ...a, images: j(a.images), tags: j(a.tags) })))
})

// 需求3：学生查看待我确认的美文列表（必须在 /:id 之前定义）
app.get('/api/articles/pending-student', auth, async (c) => {
  const uid = c.get('user').id
  const list = await all<any>(`SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    WHERE a.actual_user_id=? AND a.status=? ORDER BY a.id DESC`, uid, 'pending_student')
  return c.json(list.map(a => ({ ...a, images: j(a.images), tags: j(a.tags) })))
})

// 需求3：学生同意发布代发的美文
app.post('/api/articles/:id/student-approve', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const a = await get<any>('SELECT * FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '不存在' }, 404)
  if (Number(a.actual_user_id) !== Number(uid)) return c.json({ message: '不是代你发的美文' }, 403)
  if (a.status !== 'pending_student') return c.json({ message: '状态不正确' }, 400)
  await run('UPDATE articles SET status=? WHERE id=?', 'pending', id)
  await addNotice(a.user_id, '代发美文学生已确认', `学生确认同意发布《${a.title}》，现已进入待超管审核状态。`, 'audit')
  const stuMsg = `<p>你已确认同意发布美文《${a.title}》</p><p>该文现已进入<b>超管审核</b>阶段，通过后将会公开展示。请耐心等待。</p>`
  const stuAtts = JSON.stringify([{ type: 'action', articleId: Number(id), title: '查看美文' }])
  await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, a.user_id, uid, stuMsg, stuAtts)
  return c.json({ ok: true })
})

// 需求3：学生拒绝发布代发的美文
app.post('/api/articles/:id/student-reject', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const a = await get<any>('SELECT * FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '不存在' }, 404)
  if (Number(a.actual_user_id) !== Number(uid)) return c.json({ message: '不是代你发的美文' }, 403)
  if (a.status !== 'pending_student') return c.json({ message: '状态不正确' }, 400)
  await run('DELETE FROM articles WHERE id=?', id)
  await addNotice(a.user_id, '代发美文被学生拒绝', `学生拒绝了代发美文《${a.title}》，该文已删除。`, 'audit')
  return c.json({ ok: true })
})

// 需求9：超管代学生确认美文（手动点击生效，不自动确认）
app.post('/api/articles/:id/admin-confirm', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  const a = await get<any>('SELECT * FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '不存在' }, 404)
  if (a.status !== 'pending_student') return c.json({ message: '该美文不在待学生确认状态' }, 400)
  // 超管代为确认，直接进入待超管审核状态
  await run('UPDATE articles SET status=? WHERE id=?', 'pending', id)
  await addNotice(a.user_id, '超管代确认美文', `超级管理员已代为确认《${a.title}》，现已进入待超管审核状态。`, 'audit')
  if (a.actual_user_id) {
    await addNotice(Number(a.actual_user_id), '你的美文已被超管代确认', `《${a.title}》已被超级管理员代为确认，现已进入审核阶段。`, 'audit')
  }
  return c.json({ ok: true })
})

app.get('/api/articles/:id', async (c) => {
  const id = c.req.param('id')
  const me = await parseOptionalAuth(c)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null
  const a = await get<any>(`SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    WHERE a.id=?`, id)
  if (!a) return c.json({ message: '不存在' }, 404)
  if (a.status !== 'approved') {
    const isOwner = Number(a.user_id) === myId
    const isActual = a.actual_user_id && Number(a.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (a.subject_id && sids.includes(Number(a.subject_id))) canSee = true
    }
    if (!canSee) return c.json({ message: '无权查看该美文' }, 403)
  }
  await run('UPDATE articles SET views = views + 1 WHERE id=?', id)
  return c.json({ ...a, images: j(a.images), tags: j(a.tags), views: (a.views ?? 0) + 1 })
})

app.post('/api/articles', auth, async (c) => {
  const id = c.get('user').id
  const role = c.get('user').role
  const u = await get<any>('SELECT real_name, class_id, role FROM users u LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE user_id=?) cm ON u.id=cm.user_id WHERE u.id=?', id, id)
  const b = await c.req.json()
  const cid = b.classId || u?.class_id || 1
  let status = 'pending'
  let actualUserId: number | null = null
  if (role === 'SUPER_ADMIN' || role === 'TEACHER') {
    if (b.actualUserId && Number(b.actualUserId) !== id) { actualUserId = Number(b.actualUserId); status = 'pending_student' }
    else { status = 'approved' }
  }
  const r = await run(`INSERT INTO articles (title,content,author,source,recommendation,subject_id,user_id,class_id,cover,images,tags,category,status,actual_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    b.title, b.content, b.author || u?.real_name, b.source || '原创', b.recommendation || '', b.subjectId, id, cid, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.tags || []), b.category || '', status, actualUserId)
  const aid = Number(r.lastInsertRowid)
  if (status === 'pending_student' && actualUserId) {
    const teacherName = u?.real_name || '老师'
    await addNotice(actualUserId, '有人代你发布美文', `${teacherName}老师代你发布了《${b.title}》，请到个人中心 → 待我确认的美文中确认是否同意发布。`, 'audit')
    const msgHtml = `<p>${teacherName}老师代你发布了美文《${b.title}》</p><p>请前往「个人中心 → 待我确认的美文」中 <b>确认是否同意发布</b>。</p>`
    const atts = JSON.stringify([{ type: 'action', articleId: aid, title: '点此确认' }])
    await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, id, actualUserId, msgHtml, atts)
  }
  if (status === 'approved') {
    const expUid = actualUserId || id
    await addExp(expUid, undefined, 'article', `美文《${b.title}》发布`)
  }
  clearAllCache()
  return c.json({ id: aid, status })
})

app.patch('/api/articles/:id/status', auth, async (c) => {
  const id = c.req.param('id')
  const { status: newStatus } = await c.req.json()
  const a = await get<any>('SELECT title, user_id, status, subject_id, actual_user_id FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '不存在' }, 404)
  const reviewerId = c.get('user').id
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', reviewerId)
  if (u?.role !== 'SUPER_ADMIN' && !canManageSubject(u, a.subject_id)) return c.json({ message: '无权限审核该学科的美文' }, 403)
  await run('UPDATE articles SET status=? WHERE id=?', newStatus, id)
  if (newStatus === 'approved' && a.status !== 'approved') {
    // 审核通过后，给实际作者发放经验值奖励（防重复：检查是否已发放过）
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    const already = await get("SELECT id FROM exp_logs WHERE user_id=? AND action_type='article' AND description LIKE ?", expUid, `%${a.title}%`)
    if (!already) {
      await addExp(expUid, undefined, 'article', `美文《${a.title}》审核通过`)
    }
    await addNotice(a.user_id, '美文审核通过', `你的《${a.title}》已通过审核，已公开展示。`, 'audit')
    if (a.actual_user_id) {
      await addNotice(Number(a.actual_user_id), '你的美文审核通过', `《${a.title}》已通过审核，已公开展示。`, 'audit')
    }
  } else if (newStatus === 'rejected') {
    await addNotice(a.user_id, '美文未通过审核', `《${a.title}》未通过审核，请修改后重新提交。`, 'audit')
    if (a.actual_user_id) {
      await addNotice(Number(a.actual_user_id), '你的美文未通过审核', `代发的《${a.title}》未通过审核。`, 'audit')
    }
  }
  clearAllCache()
  return c.json({ ok: true })
})

app.delete('/api/articles/:id', auth, async (c) => {
  const id = c.req.param('id')
  const a = await get<any>('SELECT user_id, subject_id, title, actual_user_id, status FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
  const isOwner = a.user_id === c.get('user').id
  const isActualUser = a.actual_user_id && Number(a.actual_user_id) === Number(c.get('user').id)
  // 允许：发布者、实际作者（代发美文的学生）、超管、对应学科教师删除
  if (!isOwner && !isActualUser && !canManageSubject(u, a.subject_id)) return c.json({ message: '无权限删除' }, 403)
  // 删除前回收已发放的经验（美文发布/审核通过/点赞相关）
  const expUid = Number(a.actual_user_id) || Number(a.user_id)
  if (expUid && a.title) {
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type IN ('article','like') AND description LIKE ?", expUid, `%${a.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    if (total) await addExp(expUid, -total, 'article', `删除美文《${a.title}》回收经验`)
  }
  await run('DELETE FROM article_comments WHERE article_id=?', id)
  await run('DELETE FROM likes_map WHERE target_type=? AND target_id=?', 'article', id)
  await run('DELETE FROM articles WHERE id=?', id)
  clearAllCache()
  return c.json({ ok: true })
})

app.post('/api/articles/:id/like', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'article', id)
  if (exist) return c.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'article', id)
  await run('UPDATE articles SET likes = likes + 1 WHERE id=?', id)
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', id)
  if (a) await addExp(Number(a.actual_user_id) || Number(a.user_id), 1, 'like', `美文《${a.title}》获得点赞`)
  return c.json({ liked: true })
})

// Bug2: 美文评论 - 列表
app.get('/api/articles/:id/comments', async (c) => {
  const id = c.req.param('id')
  const me = await parseOptionalAuth(c)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null
  const a = await get<any>('SELECT * FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '文章不存在' }, 404)
  if (a.status !== 'approved') {
    const isOwner = Number(a.user_id) === myId
    const isActual = a.actual_user_id && Number(a.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (a.subject_id && sids.includes(Number(a.subject_id))) canSee = true
    }
    if (!canSee) return c.json({ message: '无权查看该美文的评论' }, 403)
  }
  const list = await all<any>('SELECT * FROM article_comments WHERE article_id=? ORDER BY id DESC', id)
  // 映射字段名，与前端 ArticleView.vue 期望的 name/time/text 格式一致
  return c.json(list.map((c: any) => ({ ...c, name: c.user_name, time: c.created_at, text: c.content })))
})

// Bug2: 美文评论 - 发布
app.post('/api/articles/:id/comments', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const me = await parseOptionalAuth(c)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null
  const art = await get<any>('SELECT * FROM articles WHERE id=?', id)
  if (!art) return c.json({ message: '文章不存在' }, 404)
  if (art.status !== 'approved') {
    const isOwner = Number(art.user_id) === myId
    const isActual = art.actual_user_id && Number(art.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (art.subject_id && sids.includes(Number(art.subject_id))) canSee = true
    }
    if (!canSee) return c.json({ message: '无权评论该美文' }, 403)
  }
  const { content } = await c.req.json()
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(`INSERT INTO article_comments (article_id,user_id,user_name,avatar,content,created_at) VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
    id, uid, u?.real_name, u?.avatar, content)
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', id)
  if (a) {
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    if (expUid !== uid) await addExp(expUid, 1, 'comment', `《${a.title}》获得评论`)
  }
  const created_at = datetimeNow()
  return c.json({ id: Number(r.lastInsertRowid), user_id: uid, user_name: u?.real_name, avatar: u?.avatar, content, created_at, name: u?.real_name, time: created_at, text: content })
})

// 需求9：删除美文评论（本人或超管）
app.delete('/api/articles/:id/comments/:commentId', auth, async (c) => {
  const commentId = c.req.param('commentId')
  const articleId = c.req.param('id')
  const uid = c.get('user').id
  const u = await get<any>('SELECT role FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT user_id FROM article_comments WHERE id=?', commentId)
  if (!comment) return c.json({ message: '评论不存在' }, 404)
  if (comment.user_id !== uid && u?.role !== 'SUPER_ADMIN') return c.json({ message: '无权限删除' }, 403)
  // 回收评论带来的经验：评论创建时给文章作者加1经验（仅当评论者非作者）
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', articleId)
  if (a) {
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    if (expUid !== Number(comment.user_id)) await addExp(expUid, -1, 'comment', `《${a.title}》评论被删除回收经验`)
  }
  await run('DELETE FROM article_comments WHERE id=?', commentId)
  clearAllCache()
  return c.json({ ok: true })
})

// 需求9：删除页面评论（本人或超管）
app.delete('/api/pages/:id/comments/:commentId', auth, async (c) => {
  const commentId = c.req.param('commentId')
  const uid = c.get('user').id
  const u = await get<any>('SELECT role FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT user_id FROM page_comments WHERE id=?', commentId)
  if (!comment) return c.json({ message: '评论不存在' }, 404)
  if (comment.user_id !== uid && u?.role !== 'SUPER_ADMIN') return c.json({ message: '无权限删除' }, 403)
  await run('DELETE FROM page_comments WHERE id=?', commentId)
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 资料 ============
// ==============================================================================
app.get('/api/resources', async (c) => {
  const subjectId = c.req.query('subjectId')
  const status = c.req.query('status')
  const mine = c.req.query('mine')
  const userId = c.req.query('userId')
  const me = await parseOptionalAuth(c)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  let sql = 'SELECT r.*, u.real_name AS creator_name FROM resources r LEFT JOIN users u ON r.user_id = u.id WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND r.subject_id=?'; args.push(subjectId) }
  if (mine === '1') {
    // 个人中心「我的资料」：仅本人可查自己全部状态
    if (!myId) return c.json([])
    sql += ' AND r.user_id=?'; args.push(myId)
  } else {
    // 公开列表：仅展示已通过审核的资料
    if (myRole === 'SUPER_ADMIN') {
      if (status) { sql += ' AND r.status=?'; args.push(status) }
    } else if (myRole === 'TEACHER') {
      // 教师可看已通过的 + 自己上传的全部状态
      const sids = await teachingSubjects(myId)
      sql += ` AND (r.status='approved'`
      if (sids.length) {
        sql += ` OR (r.user_id=? AND r.subject_id IN (${sids.map(() => '?').join(',')}))`
        args.push(myId, ...sids)
      }
      sql += ` OR r.user_id=?`
      args.push(myId)
      sql += `)`
    } else {
      sql += " AND r.status='approved'"
    }
  }
  sql += ' ORDER BY r.id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map(r => ({ ...r, tags: j(r.tags) })))
})

app.post('/api/resources', auth, async (c) => {
  const id = c.get('user').id
  const u = await get<any>('SELECT role FROM users WHERE id=?', id)
  const b = await c.req.json()
  const status = (u?.role === 'SUPER_ADMIN' || u?.role === 'TEACHER') ? 'approved' : 'pending'
  const r = await run(`INSERT INTO resources (subject_id,title,description,file_name,file_type,file_size,file_path,category,tags,user_id,class_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    b.subjectId, b.title, b.description || '', b.fileName || '', b.fileType || '', b.fileSize || 0, b.filePath || '', b.category || '', JSON.stringify(b.tags || []), id, b.classId || 1, status)
  const rid = Number(r.lastInsertRowid)
  return c.json({ id: rid, status })
})

app.patch('/api/resources/:id/status', auth, async (c) => {
  const id = c.req.param('id')
  const { status: newStatus } = await c.req.json()
  const r = await get<any>('SELECT title, user_id, status, subject_id FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
  if (!canManageSubject(u, r.subject_id)) return c.json({ message: '无权限审核该学科的资料' }, 403)
  await run('UPDATE resources SET status=? WHERE id=?', newStatus, id)
  if (newStatus === 'approved' && r.status !== 'approved') {
    await addExp(r.user_id, undefined, 'resource', `资料《${r.title}》审核通过`)
    await addNotice(r.user_id, '资料审核通过', `《${r.title}》已通过审核。`, 'audit')
  }
  return c.json({ ok: true })
})

app.delete('/api/resources/:id', auth, async (c) => {
  const id = c.req.param('id')
  const r = await get<any>('SELECT user_id, file_path, subject_id, title, status FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
  const isOwner = r.user_id === c.get('user').id
  if (!isOwner && !canManageSubject(u, r.subject_id)) return c.json({ message: '无权限删除' }, 403)
  // 删除前回收已发放的经验（资料审核通过/点赞相关）
  if (r.user_id && r.title) {
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type IN ('resource','like') AND description LIKE ?", r.user_id, `%${r.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    if (total) await addExp(r.user_id, -total, 'resource', `删除资料《${r.title}》回收经验`)
  }
  if (r.file_path) { try { await deleteFile(extractKey(r.file_path)) } catch {} }
  await run('DELETE FROM likes_map WHERE target_type IN (?,?) AND target_id=?', 'resource', 'fav_resource', id)
  await run('DELETE FROM resources WHERE id=?', id)
  clearAllCache()
  return c.json({ ok: true })
})

app.post('/api/resources/:id/download', auth, async (c) => {
  const id = c.req.param('id')
  const uid = c.get('user').id
  const r = await get<any>('SELECT * FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '不存在' }, 404)
  // 权限：已通过的资料所有人可下载；未通过的仅上传者本人和超管/对应学科教师可下载
  if (r.status !== 'approved') {
    const me = await get<any>('SELECT role, subject_id FROM users WHERE id=?', uid)
    const isOwner = Number(r.user_id) === Number(uid)
    if (!isOwner && !canManageSubject(me, r.subject_id)) {
      return c.json({ message: '该资料尚未通过审核' }, 403)
    }
  }
  if (!r.file_path) return c.json({ message: '文件不存在，可能已被清理' }, 404)
  const file = await downloadFile(r.file_path)
  if (!file) return c.json({ message: '文件不存在，可能已被清理' }, 404)
  const filename = r.file_name || r.title || 'download'
  const encoded = encodeURIComponent(filename)
  await run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id)
  const headers: Record<string, string> = {
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
  }
  if (file.contentType) headers['Content-Type'] = file.contentType
  return new Response(file.buffer, { headers })
})

app.post('/api/resources/:id/like', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'resource', id)
  if (exist) return c.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'resource', id)
  await run('UPDATE resources SET likes = likes + 1 WHERE id=?', id)
  return c.json({ liked: true })
})

// ==============================================================================
// ============ 收藏 ============
// ==============================================================================
app.get('/api/favorites', auth, async (c) => {
  const uid = c.get('user').id
  const list = await all<any>('SELECT * FROM likes_map WHERE user_id=? AND target_type IN (?,?) ORDER BY id DESC', uid, 'fav_article', 'fav_resource')
  return c.json(list)
})

app.post('/api/favorites/:type/:id', auth, async (c) => {
  const uid = c.get('user').id
  const tp = c.req.param('type') === 'article' ? 'fav_article' : 'fav_resource'
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, id)
  if (exist) {
    await run('DELETE FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, id)
    if (tp === 'fav_resource') await run('UPDATE resources SET collects = MAX(collects - 1, 0) WHERE id=?', id)
    return c.json({ favorited: false })
  }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, tp, id)
  if (tp === 'fav_resource') await run('UPDATE resources SET collects = collects + 1 WHERE id=?', id)
  return c.json({ favorited: true })
})

// ==============================================================================
// ============ 文件上传（统一走 Supabase Storage） ============
// ==============================================================================
app.post('/api/upload/file', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  if (!R2_BUCKET && !getSupabase()) return c.json({ message: '文件存储未配置（R2 和 Supabase 均不可用）' }, 500)
  const ext = extname(file.name)
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const arrayBuffer = await file.arrayBuffer()
  const url = await uploadFile(key, arrayBuffer, file.type)
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  return c.json({ url, filePath: key, fileName: file.name, fileType: typeMap[ext] || 'file', fileSize: file.size })
})

app.post('/api/upload/image', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  if (!R2_BUCKET && !getSupabase()) return c.json({ message: '文件存储未配置（R2 和 Supabase 均不可用）' }, 500)
  const ext = extname(file.name) || '.png'
  const key = `img_${c.get('user').id}_${Date.now()}${ext}`
  const arrayBuffer = await file.arrayBuffer()
  const url = await uploadFile(key, arrayBuffer, file.type)
  return c.json({ url })
})

// ==============================================================================
// ============ 数据查询 ============
// ==============================================================================
app.get('/api/query/tasks', auth, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  let sql = 'SELECT * FROM query_tasks WHERE 1=1'
  const args: any[] = []
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return c.json([])
    sql += ` AND class_id IN (${cids.map(() => '?').join(',')})`; args.push(...cids)
  } else if (role === 'TEACHER') {
    sql += ' AND creator_id=?'; args.push(uid)
  }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map(t => ({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })))
})

app.get('/api/query/tasks/:id', auth, async (c) => {
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', c.req.param('id'))
  if (!t) return c.json({ message: '不存在' }, 404)
  return c.json({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })
})

app.post('/api/query/tasks/:id/query', auth, async (c) => {
  const id = c.req.param('id')
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  const uid = c.get('user').id
  const user = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const matchField = t.match_field
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=?', id)
  const allRows = rows.map(r => j(r.data_row))
  const myRows = allRows.filter(r => String(r[matchField]) === String(user.real_name))
  const headers = j(t.headers)
  await addExp(uid, undefined, 'query', `完成数据查询：${t.title}`)
  return c.json({
    task: { ...t, headers, show_comment: !!t.show_comment, allow_export: !!t.allow_export },
    headers: t.show_comment ? headers : headers.filter((h: string) => h !== '评语'),
    myRows,
  })
})

app.post('/api/query/tasks', auth, requireStaff, async (c) => {
  const id = c.get('user').id
  const role = c.get('user').role
  const me = await get<any>('SELECT real_name, subject_id, role FROM users WHERE id=?', id)
  const name = me?.real_name || ''
  const b = await c.req.json()
  if (role === 'TEACHER' && me?.subject_id && Number(b.subjectId) !== Number(me.subject_id)) {
    return c.json({ message: '你只能发布自己任教学科的数据查询' }, 403)
  }
  const r = await run(`INSERT INTO query_tasks (subject_id,class_id,creator_id,creator_name,title,note,valid_until,show_comment,allow_export,headers,match_field,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    b.subjectId, b.classId, id, name, b.title, b.note || '', b.validUntil, b.showComment ? 1 : 0, b.allowExport ? 1 : 0, JSON.stringify(b.headers), b.matchField)
  const tid = Number(r.lastInsertRowid)
  for (const row of b.rows) {
    await run('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)', tid, JSON.stringify(row))
  }
  const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
  for (const s of students) {
    await addNotice(s.user_id, '新查询任务发布', `${name}老师发布了「${b.title}」成绩查询。`, 'query')
  }
  return c.json({ id: tid })
})

// 需求1：超管下载数据查询任务的原始Excel
app.get('/api/query/tasks/:id/export', auth, requireStaff, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  const id = c.req.param('id')
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) {
    return c.json({ message: '无权限下载该查询任务' }, 403)
  }
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=? ORDER BY id', id)
  const headers = j(t.headers) || []
  const aoa: any[][] = [headers]
  for (const r of rows) {
    const row = j(r.data_row) || {}
    aoa.push(headers.map(h => row[h] ?? ''))
  }
  const XLSX = await import('xlsx')
  const xlsx = (XLSX.default || XLSX)
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '查询数据')
  const buf = xlsx.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const encoded = encodeURIComponent(`${t.title}_查询数据.xlsx`)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
      'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
      'Access-Control-Allow-Credentials': 'true',
    }
  })
})

app.delete('/api/query/tasks/:id', auth, requireStaff, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  const id = c.req.param('id')
  const t = await get<any>('SELECT creator_id, title FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) return c.json({ message: '无权限删除' }, 403)
  // 删除前回收已发放的经验（数据查询相关）
  if (t.title) {
    const logs = await all<{ user_id: number; exp_change: number }>("SELECT user_id, exp_change FROM exp_logs WHERE action_type='query' AND description LIKE ?", `%${t.title}%`)
    const byUser = new Map<number, number>()
    for (const l of logs) { byUser.set(l.user_id, (byUser.get(l.user_id) || 0) + (l.exp_change || 0)) }
    for (const [userId, total] of byUser) {
      if (total) await addExp(userId, -total, 'query', `删除查询任务「${t.title}」回收经验`)
    }
  }
  await run('DELETE FROM query_rows WHERE task_id=?', id)
  await run('DELETE FROM query_tasks WHERE id=?', id)
  return c.json({ ok: true })
})

// 编辑查询任务（超管或创建教师）
app.put('/api/query/tasks/:id', auth, requireStaff, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  const id = c.req.param('id')
  const t = await get<any>('SELECT creator_id FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) return c.json({ message: '无权限编辑' }, 403)
  const b = await c.req.json()
  await run('UPDATE query_tasks SET title=?, note=?, valid_until=? WHERE id=?', b.title ?? '', b.note ?? '', b.validUntil ?? '', id)
  if (Array.isArray(b.headers) && Array.isArray(b.rows)) {
    await run('DELETE FROM query_rows WHERE task_id=?', id)
    for (const row of b.rows) {
      await run('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)', id, JSON.stringify(row))
    }
    await run('UPDATE query_tasks SET headers=?, match_field=? WHERE id=?', JSON.stringify(b.headers), b.matchField ?? '', id)
  }
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 小白一键修复：SUPER_ADMIN（改成 D1 修复） ============
// ==============================================================================
app.post('/api/admin/self-repair', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const now = Date.now()
  if (now - SELF_REPAIR_LOCK.at < 10 * 60 * 1000) {
    return c.json({ ok: false, msg: '修复正在进行中，请耐心等待1~2分钟后刷新页面' })
  }
  SELF_REPAIR_LOCK.at = now
  // D1 修复：完整性检查 + 索引重建 + 统计更新
  try {
    await D1.prepare('PRAGMA integrity_check').first()
    // 确保关键表存在（修复评论功能等）
    const tables = [
      `CREATE TABLE IF NOT EXISTS article_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        user_name TEXT, avatar TEXT, content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','+8 hours'))
      )`,
      `CREATE TABLE IF NOT EXISTS page_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL, user_name TEXT, avatar TEXT,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now','+8 hours'))
      )`,
      `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
      `CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, value TEXT)`,
    ]
    for (const sql of tables) { try { await D1.prepare(sql).run() } catch {} }
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_art_c_a ON article_comments(article_id)',
      'CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status)',
      'CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status)',
      'CREATE INDEX IF NOT EXISTS idx_resources_user ON resources(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_exp_logs_user ON exp_logs(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id, is_read)',
      'CREATE INDEX IF NOT EXISTS idx_likes_map ON likes_map(user_id, target_type)',
      'CREATE INDEX IF NOT EXISTS idx_class_members_user ON class_members(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(ptype, status)',
      'CREATE INDEX IF NOT EXISTS idx_quiz_sub_quiz ON quiz_submissions(quiz_id, user_id)',
    ]
    for (const idx of indexes) { try { await D1.prepare(idx).run() } catch {} }
    await D1.prepare('ANALYZE').run()
  } catch {}
  return c.json({ ok: true, msg: '修复已启动！请耐心等待1~2分钟后刷新页面（或按F5多刷几次）' })
})

// ==============================================================================
// ============ 经验值 & 排行榜 ============
// ==============================================================================
app.get('/api/exp/logs', auth, async (c) => {
  const role = c.get('user').role
  const queryUserId = c.req.query('userId')
  // 超管可查看任意用户经验记录；其他用户只能查看自己的
  const uid = (role === 'SUPER_ADMIN' && queryUserId) ? Number(queryUserId) : c.get('user').id
  return c.json(await all('SELECT * FROM exp_logs WHERE user_id=? ORDER BY id DESC', uid))
})

// 超管查看全员经验记录（带用户信息）
app.get('/api/exp/all-logs', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const page = Number(c.req.query('page') || '1')
  const pageSize = Math.min(Number(c.req.query('pageSize') || '50'), 200)
  const offset = (page - 1) * pageSize
  const logs = await all<any>(
    `SELECT el.*, u.real_name, u.username, u.role, u.avatar
     FROM exp_logs el
     LEFT JOIN users u ON el.user_id = u.id
     ORDER BY el.id DESC
     LIMIT ? OFFSET ?`,
    pageSize, offset
  )
  const countRow = await get<{ total: number }>('SELECT COUNT(*) as total FROM exp_logs')
  return c.json({ list: logs, total: countRow?.total || 0, page, pageSize })
})

app.post('/api/exp/logs', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { userId, change, actionType, description } = await c.req.json()
  await addExp(userId, change, actionType, description)
  return c.json({ ok: true })
})

app.get('/api/leaderboard', async (c) => {
  const scope = c.req.query('scope') || 'all'
  const classId = c.req.query('classId')
  const subjectId = c.req.query('subjectId')
  const period = c.req.query('period') || 'total'
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
  return c.json(list)
})

// ==============================================================================
// ============ 通知 ============
// ==============================================================================
app.get('/api/notices', auth, async (c) => {
  return c.json(await all('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC', c.get('user').id))
})

app.post('/api/notices/readAll', auth, async (c) => {
  await run('UPDATE notices SET "read"=1 WHERE user_id=?', c.get('user').id)
  return c.json({ ok: true })
})

app.post('/api/notices/:id/read', auth, async (c) => {
  await run('UPDATE notices SET "read"=1 WHERE id=? AND user_id=?', c.req.param('id'), c.get('user').id)
  return c.json({ ok: true })
})

app.post('/api/notices/broadcast', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { title, content, type } = await c.req.json()
  const users = await all<{ id: number }>('SELECT id FROM users WHERE status=?', 'active')
  for (const u of users) {
    await run(`INSERT INTO notices (user_id,title,content,type,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, u.id, title, content, type || 'system')
  }
  return c.json({ ok: true, count: users.length })
})

// ==============================================================================
// ============ 主题 ============
// ==============================================================================
app.get('/api/themes', async (c) => {
  const list = await all<any>('SELECT * FROM themes ORDER BY id')
  return c.json(list.map(t => ({ ...t, config: j(t.config) })))
})

app.get('/api/themes/active', async (c) => {
  const t = await get<any>('SELECT * FROM themes WHERE is_active=1 LIMIT 1')
  if (!t) return c.json(null)
  return c.json({ ...t, config: j(t.config) })
})

app.patch('/api/themes/:id/active', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  await run('UPDATE themes SET is_active=0')
  await run('UPDATE themes SET is_active=1 WHERE id=?', id)
  return c.json({ ok: true })
})

app.put('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  const { config, name, isActive } = await c.req.json()
  await run('UPDATE themes SET config=?, name=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', JSON.stringify(config), name, id)
  if (isActive) {
    await run('UPDATE themes SET is_active=0')
    await run('UPDATE themes SET is_active=1 WHERE id=?', id)
  }
  return c.json({ ok: true })
})

app.post('/api/themes', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const { name, config, isActive } = await c.req.json()
  const r = await run('INSERT INTO themes (name,config,is_active) VALUES (?,?,?)', name, JSON.stringify(config), isActive ? 1 : 0)
  const id = Number(r.lastInsertRowid)
  if (isActive) { await run('UPDATE themes SET is_active=0'); await run('UPDATE themes SET is_active=1 WHERE id=?', id) }
  return c.json({ id })
})

app.delete('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (c) => {
  await run('DELETE FROM themes WHERE id=?', c.req.param('id'))
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 数据统计 ============
// ==============================================================================
app.get('/api/stats', auth, async (c) => {
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
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
  return c.json({ users, subjects, articles, approvedArticles, pendingArticles, resources, approvedResources, pendingResources, queryTasks })
})

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json({ articles: [], resources: [] })
  const like = `%${q}%`
  const articles = await all<any>('SELECT id,title,author,cover,subject_id,category,created_at FROM articles WHERE status=? AND (title LIKE ? OR author LIKE ? OR content LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like, like)
  const resources = await all<any>('SELECT id,title,description,file_name,file_type,subject_id,category,downloads FROM resources WHERE status=? AND (title LIKE ? OR description LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like)
  return c.json({ articles, resources })
})

// ==============================================================================
// ============ 设置（经验规则 / 功能开关） ============
// ==============================================================================
app.get('/api/settings/exp_rules', auth, async (c) => {
  return c.json(await getExpRules())
})

app.put('/api/settings/exp_rules', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const rules = await c.req.json() || {}
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", 'exp_rules', JSON.stringify(rules))
  refreshExpRules()
  clearAllCache()
  return c.json({ ok: true })
})

// Bug5: 公开的功能开关接口（给登录页用）
app.get('/api/feature-flags/public', async (c) => {
  const regFlag = await get<{ value: string }>("SELECT value FROM feature_flags WHERE key='registration_enabled'")
  return c.json({ registration_enabled: !regFlag || regFlag.value !== '0' })
})

app.get('/api/settings/feature_flags', auth, requireRole('SUPER_ADMIN'), async (c) => {
  return c.json(await getFeatureFlags())
})

app.put('/api/settings/feature_flags', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const flags = await c.req.json() || {}
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", 'feature_flags', JSON.stringify(flags))
  if (flags.registration_enabled !== undefined) {
    const v = flags.registration_enabled ? '1' : '0'
    await run("INSERT OR REPLACE INTO feature_flags (key,value) VALUES ('registration_enabled',?)", v)
  }
  refreshFeatureFlags()
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 网站自定义设置（超管） ============
// ==============================================================================
app.get('/api/settings/site_config', async (c) => {
  // 默认配置（与前端 SiteConfigView.vue defaultConfig 保持一致）
  const defaults: any = {
    siteName: '追光学科共享平台',
    siteSlogan: '追光的人，终会身披万丈光芒',
    heroSubtitle: '在这里分享知识，收获成长。',
    showQuickLinks: true,
    quickLinks: [
      { icon: '📚', label: '学科广场', path: '/subjects', color: '#F59E0B' },
      { icon: '🏆', label: '经验排行', path: '/leaderboard', color: '#FBBF24' },
      { icon: '👤', label: '个人中心', path: '/profile', color: '#FB923C' },
      { icon: '📖', label: '网站说明', path: '/guide', color: '#EF4444' },
    ],
    footerText: '© 追光学科共享平台 · 用知识点亮未来',
    showAnnouncementBar: false,
    announcementBar: '欢迎来到追光学科共享平台！',
    navTitle: '追光学科共享平台',
    navTitleIcon: '🌟',
    showNavSearch: true,
    showNavMessage: true,
    showNavNotice: true,
    showHeroStats: true,
    showSubjects: true,
    showLatestArticles: true,
    maxArticlesOnHome: 6,
    primaryColor: '#F59E0B',
  }
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='site_config'")
    if (r) {
      const saved = JSON.parse(r.value)
      // 合并：已保存的值覆盖默认值，确保所有字段都有值
      return c.json({ ...defaults, ...saved })
    }
  } catch {}
  return c.json(defaults)
})

app.put('/api/settings/site_config', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const config = await c.req.json() || {}
  // 使用 INSERT OR REPLACE 确保无论 key 是否存在都能正确保存
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", 'site_config', JSON.stringify(config))
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 题库自测 ============
// ==============================================================================
app.get('/api/quizzes', auth, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  const subjectId = c.req.query('subjectId')
  const classId = c.req.query('classId')
  let sql = 'SELECT q.* FROM quizzes q WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND q.subject_id=?'; args.push(subjectId) }
  if (classId) { sql += ' AND q.class_id=?'; args.push(classId) }
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return c.json([])
    sql += ` AND q.class_id IN (${cids.map(() => '?').join(',')})`
    args.push(...cids)
  } else if (role === 'TEACHER') {
    const sids = await teachingSubjects(uid)
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
  return c.json(list)
})

app.get('/api/quizzes/:id', auth, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT * FROM quizzes WHERE id=?', id)
  if (!q) return c.json({ message: '不存在' }, 404)
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', id)
  return c.json({
    ...q,
    questions: questions.map(qq => ({ ...qq, options: j(qq.options), attachments: j(qq.attachments) })),
  })
})

// 教师/超管创建题库 + 题目
app.post('/api/quizzes', auth, requireStaff, async (c) => {
  const uid = c.get('user').id
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const b = await c.req.json()
  const r = await run(
    `INSERT INTO quizzes (subject_id,class_id,creator_id,creator_name,title,description,duration,valid_until,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
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
  if (b.classId) {
    const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
    for (const s of students) {
      await addNotice(s.user_id, '新题库自测', `${me?.real_name || '老师'}发布了「${b.title}」题库自测，请按时完成。`, 'teacher')
    }
  }
  return c.json({ id: qid })
})

app.patch('/api/quizzes/:id', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', id)
  if (!q) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
  if (!canManageSubject(u, q.subject_id)) return c.json({ message: '无权限' }, 403)
  const b = await c.req.json()
  if (b.title !== undefined) await run('UPDATE quizzes SET title=? WHERE id=?', b.title, id)
  if (b.description !== undefined) await run('UPDATE quizzes SET description=? WHERE id=?', b.description, id)
  if (b.duration !== undefined) await run('UPDATE quizzes SET duration=? WHERE id=?', b.duration, id)
  if (b.validUntil !== undefined) await run('UPDATE quizzes SET valid_until=? WHERE id=?', b.validUntil, id)
  if (b.status !== undefined) await run('UPDATE quizzes SET status=? WHERE id=?', b.status, id)
  return c.json({ ok: true })
})

app.delete('/api/quizzes/:id', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', id)
  if (!q) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', c.get('user').id)
  if (!canManageSubject(u, q.subject_id)) return c.json({ message: '无权限' }, 403)
  await run('DELETE FROM quiz_questions WHERE quiz_id=?', id)
  await run('DELETE FROM quiz_submissions WHERE quiz_id=?', id)
  await run('DELETE FROM quizzes WHERE id=?', id)
  return c.json({ ok: true })
})

// 学生作答：自动判客观题，主观题待批改
app.post('/api/quizzes/:id/submit', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', id)
  if (!quiz) return c.json({ message: '题库不存在' }, 404)
  const exist = await get<any>('SELECT id FROM quiz_submissions WHERE quiz_id=? AND user_id=?', id, uid)
  if (exist) return c.json({ message: '你已提交过该题库' }, 400)
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=?', id)
  const body = await c.req.json()
  const answers = body.answers || {}
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
      graded[q.id] = { score: 0, max: q.score || 0, type: q.qtype }
    }
  }
  const status = hasSubjective ? 'pending' : 'graded'
  let subId: number
  if (status === 'graded') {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours'),?)`,
      id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, uid
    )
    subId = Number(r.lastInsertRowid)
    await addExp(uid, undefined, 'quiz_pass', `完成题库自测：${quiz.title}（得分 ${totalScore}/${maxScore}）`)
  } else {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at) VALUES (?,?,?,?,?,?,?)`,
      id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  if (status === 'pending' && quiz.creator_id) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const stuName = stu?.real_name || `用户${uid}`
    const objCount = questions.filter(q => q.qtype !== 'subjective').length
    const msg = `📚 ${stuName} 提交了《${quiz.title}》的答卷\n客观题（${objCount}题）已自动评分：${totalScore} / ${maxScore} 分\n主观题等待您批改，请前往「题库 → 批改 / 报告」处理。`
    await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, uid, quiz.creator_id, msg, '[]')
  }
  await addNotice(uid, '题库已提交', `《${quiz.title}》已提交。${status === 'pending' ? '客观题已评分，等待教师批改主观题。' : `得分 ${totalScore}/${maxScore}。`}`, 'system')
  return c.json({ id: subId, totalScore, maxScore, status, graded, hasSubjective })
})

// 教师批改主观题
app.post('/api/quizzes/:id/submissions/:sid/grade', auth, requireStaff, async (c) => {
  const quizId = c.req.param('id')
  const sid = c.req.param('sid')
  const reviewerId = c.get('user').id
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', quizId)
  if (!quiz) return c.json({ message: '题库不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', reviewerId)
  if (!canManageSubject(u, quiz.subject_id)) return c.json({ message: '无权限批改' }, 403)
  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE id=? AND quiz_id=?', sid, quizId)
  if (!sub) return c.json({ message: '提交记录不存在' }, 404)
  const data = j(sub.answers) || {}
  const body = await c.req.json()
  const grades = body.grades || {}
  let total = 0
  const graded = { ...(data.graded || {}) }
  for (const k of Object.keys(grades)) {
    const sc = Number(grades[k].score) || 0
    if (graded[k]) graded[k].score = sc
    if (grades[k].comment) graded[k].comment = grades[k].comment
    total += sc
  }
  let fullTotal = 0
  for (const k of Object.keys(graded)) fullTotal += graded[k].score || 0
  await run(
    `UPDATE quiz_submissions SET answers=?, total_score=?, status='graded', graded_at=datetime('now','+8 hours'), graded_by=? WHERE id=?`,
    JSON.stringify({ answers: data.answers, graded }), fullTotal, reviewerId, sid
  )
  await addExp(sub.user_id, undefined, 'quiz_pass', `题库《${quiz.title}》批改完成（得分 ${fullTotal}/${sub.max_score}）`)
  await addNotice(sub.user_id, '题库批改完成', `《${quiz.title}》已批改，得分 ${fullTotal}/${sub.max_score}。`, 'teacher')
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', reviewerId))?.real_name || '老师'
  const msg = `✅ 《${quiz.title}》整张试卷已批改完成\n批改人：${teacherName}\n最终得分：${fullTotal} / ${sub.max_score} 分\n完整测评报告已生成，点击「题库 → 查看报告」即可查看。`
  await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, reviewerId, sub.user_id, msg, '[]')
  return c.json({ ok: true, totalScore: fullTotal })
})

// 我的提交记录 / 教师查看所有提交
app.get('/api/quizzes/:id/submissions', auth, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
  const id = c.req.param('id')
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', id)
  if (!quiz) return c.json({ message: '不存在' }, 404)
  if (role === 'TEACHER') {
    const u = await get<any>('SELECT subject_id FROM users WHERE id=?', uid)
    if (!canManageSubject(u, quiz.subject_id)) return c.json({ message: '无权限查看该考试' }, 403)
  }
  let list
  if (role === 'STUDENT') {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? AND s.user_id=? ORDER BY s.id DESC', id, uid)
  } else {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id DESC', id)
  }
  return c.json(list.map(s => ({ ...s, answers: j(s.answers) })))
})

// 学生查看自己的报告
app.get('/api/quizzes/:id/my_report', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE quiz_id=? AND user_id=?', id, uid)
  if (!sub) return c.json({ message: '尚未提交' }, 404)
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', id)
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', id)
  return c.json({
    quiz,
    submission: { ...sub, answers: j(sub.answers) },
    questions: questions.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })),
  })
})

// 教师查看本次考试的数据报告
app.get('/api/quizzes/:id/report', auth, requireStaff, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', id)
  if (!quiz) return c.json({ message: '题库不存在' }, 404)
  const u = await get<any>('SELECT role, subject_id FROM users WHERE id=?', uid)
  if (!canManageSubject(u, quiz.subject_id) && quiz.creator_id !== uid) {
    return c.json({ message: '无权限查看' }, 403)
  }
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', id)
  const subs = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id', id)
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
  return c.json({
    quiz,
    summary: { total, pending, graded: gradedCount, avg, max: maxS, min: minS, passLine, passCount, maxScore: totalMax },
    questions: qStats,
    ranges,
    submissions: subs.map(s => ({ id: s.id, user_id: s.user_id, real_name: s.real_name, total_score: s.total_score, max_score: s.max_score, status: s.status, submitted_at: s.submitted_at, graded_at: s.graded_at })),
  })
})

// ==============================================================================
// ============ 学科题目池（单题训练）============
// ==============================================================================
app.get('/api/subjects/:id/questions', auth, async (c) => {
  const rows = await all<any>('SELECT * FROM subject_questions WHERE subject_id=? ORDER BY sort,id DESC', c.req.param('id'))
  return c.json(rows.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })))
})

app.get('/api/subject-questions/:id', auth, async (c) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', c.req.param('id'))
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const subj = await get<any>('SELECT id, name, slug, icon FROM subjects WHERE id=?', q.subject_id)
  return c.json({ ...q, options: j(q.options), attachments: j(q.attachments), subject: subj })
})

app.post('/api/subjects/:id/questions', auth, requireStaff, async (c) => {
  const sid = Number(c.req.param('id'))
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', c.get('user').id)
  const b = await c.req.json()
  const r = await run(
    `INSERT INTO subject_questions (subject_id,creator_id,creator_name,qtype,content,options,answer,score,attachments,sort,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    sid, c.get('user').id, me?.real_name || '', b.qtype || 'single', b.content || '', JSON.stringify(b.options || []), b.answer || '', b.score || 5, JSON.stringify(b.attachments || []), b.sort || 0
  )
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.delete('/api/subject-questions/:id', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', id)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  if (c.get('user').role !== 'SUPER_ADMIN' && q.creator_id !== c.get('user').id) {
    return c.json({ message: '无权删除他人题目' }, 403)
  }
  await run('DELETE FROM practice_submissions WHERE question_id=?', id)
  await run('DELETE FROM subject_questions WHERE id=?', id)
  return c.json({ ok: true })
})

// 学生提交单题训练答案
app.post('/api/subject-questions/:id/submit', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', id)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const { answer: ans } = await c.req.json()
  const isSub = q.qtype === 'subjective'
  let correct: boolean | null = null
  let score = 0
  const max = q.score || 5
  if (!isSub) {
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
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours'),?)`,
      q.id, q.subject_id, uid, ans || '', score, max, status, correct ? 1 : 0, uid
    )
    subId = Number(r.lastInsertRowid)
  } else {
    const r = await run(
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      q.id, q.subject_id, uid, ans || '', 0, max, status, null, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  if (isSub) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const subj = await get<any>('SELECT name FROM subjects WHERE id=?', q.subject_id)
    const msg = `📝 ${stu?.real_name || '学生'} 在「${subj?.name || '学科'}」单题训练中提交了一道主观题\n请前往「题库 → 单题训练待批」进行批改。`
    const teachers = await all<any>("SELECT id FROM users WHERE role IN ('SUPER_ADMIN','TEACHER') AND (role='SUPER_ADMIN' OR subject_id=?)", q.subject_id)
    for (const t of teachers) {
      if (t.id !== uid) await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, uid, t.id, msg, '[]')
    }
  }
  return c.json({ id: subId, status, score, max, correct })
})

// 学生查询单题训练结果（最近一次）
app.get('/api/subject-questions/:id/my_result', auth, async (c) => {
  const uid = c.get('user').id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE question_id=? AND user_id=? ORDER BY id DESC LIMIT 1', c.req.param('id'), uid)
  if (!sub) return c.json({ message: '尚未作答' }, 404)
  return c.json(sub)
})

// 教师：待批的单题训练提交列表
app.get('/api/practice/pending', auth, requireStaff, async (c) => {
  const me = c.get('user') as any
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
  return c.json(rows.map(r => ({ ...r, qoptions: j(r.qoptions), qattachments: j(r.qattachments) })))
})

// 教师：批改单题训练
app.post('/api/practice/:id/grade', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const reviewerId = c.get('user').id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', id)
  if (!sub) return c.json({ message: '提交不存在' }, 404)
  const { score, comment } = await c.req.json()
  const sc = Math.max(0, Math.min(sub.max_score, Number(score) || 0))
  await run('UPDATE practice_submissions SET score=?, status=?, comment=?, graded_at=datetime(\'now\',\'localtime\'), graded_by=? WHERE id=?',
    sc, 'graded', comment || '', reviewerId, id)
  await addExp(sub.user_id, undefined, 'quiz_pass', `单题训练批改完成（${sc}/${sub.max_score}）`)
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', reviewerId))?.real_name || '老师'
  const msg = `✅ 你的一道单题训练主观题已被批改\n批改人：${teacherName}\n得分：${sc} / ${sub.max_score}` + (comment ? `\n评语：${comment}` : '')
  await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, reviewerId, sub.user_id, msg, '[]')
  return c.json({ ok: true, score: sc })
})

// ==============================================================================
// ============ 通用页面：网站说明 / 博客 / 公告 ============
// ==============================================================================
app.get('/api/pages', async (c) => {
  const ptype = c.req.query('ptype')
  const scope = c.req.query('scope')
  const classId = c.req.query('classId')
  const mine = c.req.query('mine')
  const userId = c.req.query('userId')
  let sql = 'SELECT * FROM pages WHERE status=?'
  const args: any[] = ['published']
  if (ptype) { sql += ' AND ptype=?'; args.push(ptype) }
  if (scope) { sql += ' AND scope=?'; args.push(scope) }
  if (classId) { sql += ' AND class_id=?'; args.push(classId) }
  if (mine === '1' && userId) { sql += ' AND author_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 取单条 guide
app.get('/api/pages/guide', async (c) => {
  const p = await get<any>("SELECT * FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  if (!p) return c.json(null)
  return c.json({ ...p, images: j(p.images), attachments: j(p.attachments) })
})

app.get('/api/pages/:id', async (c) => {
  const id = c.req.param('id')
  const p = await get<any>('SELECT * FROM pages WHERE id=?', id)
  if (!p) return c.json({ message: '不存在' }, 404)
  await run('UPDATE pages SET views = views + 1 WHERE id=?', id)
  return c.json({ ...p, images: j(p.images), attachments: j(p.attachments), views: p.views + 1 })
})

// 博客/页面点赞
app.post('/api/pages/:id/like', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', id)
  if (exist) return c.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'page', id)
  await run('UPDATE pages SET likes = likes + 1 WHERE id=?', id)
  return c.json({ liked: true })
})

// 我是否已点赞
app.get('/api/pages/:id/liked', auth, async (c) => {
  const uid = c.get('user').id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', c.req.param('id'))
  return c.json({ liked: !!exist })
})

// 评论列表
app.get('/api/pages/:id/comments', async (c) => {
  const list = await all<any>('SELECT * FROM page_comments WHERE page_id=? ORDER BY id DESC', c.req.param('id'))
  return c.json(list)
})

// 发表评论
app.post('/api/pages/:id/comments', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const { content: raw } = await c.req.json()
  const content = String(raw || '').trim()
  if (!content) return c.json({ message: '评论内容不能为空' }, 400)
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(
    `INSERT INTO page_comments (page_id,user_id,user_name,avatar,content,created_at) VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
    id, uid, u?.real_name || '匿名', u?.avatar || '', content
  )
  return c.json({ id: Number(r.lastInsertRowid), page_id: Number(id), user_id: uid, user_name: u?.real_name || '匿名', avatar: u?.avatar || '', content, created_at: datetimeNow() })
})

// 公告可见性筛选
app.get('/api/announcements', auth, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
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
  sql += ' ORDER BY pinned DESC, id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 网站说明（管理后台编辑）
app.put('/api/pages/guide', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const body = await c.req.json()
  const title = body.title || ''
  const content = body.content || ''
  // 保留已有的 images/attachments，如果请求中有则覆盖
  const exist = await get<any>("SELECT id, images, attachments FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  const images = body.images !== undefined ? body.images : (exist ? j(exist.images) : [])
  const attachments = body.attachments !== undefined ? body.attachments : (exist ? j(exist.attachments) : [])
  if (exist) {
    await run("UPDATE pages SET title=?, content=?, images=?, attachments=?, updated_at=datetime('now','+8 hours') WHERE id=?", title, content, JSON.stringify(images || []), JSON.stringify(attachments || []), exist.id)
    clearAllCache()
    return c.json({ id: exist.id })
  } else {
    const r = await run("INSERT INTO pages (ptype,scope,title,content,images,attachments,author_name,status,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','+8 hours'))", 'guide', 'site', title, content, JSON.stringify(images || []), JSON.stringify(attachments || []), '超级管理员', 'published')
    clearAllCache()
    return c.json({ id: Number(r.lastInsertRowid) })
  }
})

// 创建博客 / 公告
app.post('/api/pages', auth, async (c) => {
  const uid = c.get('user').id
  const me = await get<any>('SELECT real_name, role FROM users WHERE id=?', uid)
  const b = await c.req.json()
  if (b.ptype === 'announcement') {
    if (b.scope === 'site') {
      if (me?.role !== 'SUPER_ADMIN') return c.json({ message: '只有超级管理员可发布全站公告' }, 403)
    } else if (b.scope === 'class') {
      if (me?.role !== 'SUPER_ADMIN' && me?.role !== 'TEACHER') return c.json({ message: '只有教师/超管可发布班级公告' }, 403)
    }
  }
  const pinned = b.pinned ? 1 : 0
  const pinnedScope = pinned ? (b.pinnedScope || b.scope || 'site') : 'none'
  const r = await run(
    `INSERT INTO pages (ptype,scope,class_id,title,content,cover,images,attachments,author_id,author_name,status,pinned,pinned_scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.ptype, b.scope || 'site', b.classId || null, b.title, b.content, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.attachments || []), uid, me?.real_name || '', 'published', pinned, pinnedScope
  )
  if (b.ptype === 'blog') {
    await addExp(uid, undefined, 'blog', `发布博客《${b.title}》`)
  }
  clearAllCache()
  return c.json({ id: Number(r.lastInsertRowid) })
})

// 修改公告置顶状态
app.patch('/api/pages/:id/pin', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const id = c.req.param('id')
  const { pinned, pinnedScope } = await c.req.json()
  const p = await get<any>('SELECT id FROM pages WHERE id=?', id)
  if (!p) return c.json({ message: '不存在' }, 404)
  const pinVal = pinned ? 1 : 0
  const scopeVal = pinned ? (pinnedScope || 'site') : 'none'
  await run('UPDATE pages SET pinned=?, pinned_scope=? WHERE id=?', pinVal, scopeVal, id)
  clearAllCache()
  return c.json({ ok: true })
})

app.delete('/api/pages/:id', auth, async (c) => {
  const id = c.req.param('id')
  const p = await get<any>('SELECT author_id, ptype, scope, title FROM pages WHERE id=?', id)
  if (!p) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role FROM users WHERE id=?', c.get('user').id)
  const isOwner = p.author_id === c.get('user').id
  if (!isOwner && u?.role !== 'SUPER_ADMIN') return c.json({ message: '无权限删除' }, 403)
  // 删除前回收已发放的经验（博客发布相关）
  if (p.author_id && p.title && p.ptype === 'blog') {
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type='blog' AND description LIKE ?", p.author_id, `%${p.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    if (total) await addExp(p.author_id, -total, 'blog', `删除博客《${p.title}》回收经验`)
  }
  await run('DELETE FROM page_comments WHERE page_id=?', id)
  await run('DELETE FROM likes_map WHERE target_type=? AND target_id=?', 'page', id)
  await run('DELETE FROM pages WHERE id=?', id)
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 站内信 ============
// ==============================================================================
app.get('/api/messages/contacts', auth, async (c) => {
  const uid = c.get('user').id
  const role = c.get('user').role
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
  if (role === 'SUPER_ADMIN') {
    users = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
  }
  return c.json(users)
})

// 未读消息总数（必须在 :peerId 之前定义）
app.get('/api/messages/unread/count', auth, async (c) => {
  const uid = c.get('user').id
  const r = await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND is_read=0', uid)
  return c.json({ count: r?.n || 0 })
})

// 最近会话列表
app.get('/api/messages/sessions', auth, async (c) => {
  const uid = c.get('user').id
  const list = await all<any>(
    `SELECT m.* FROM messages m
     INNER JOIN (
       SELECT MAX(id) as mid FROM messages WHERE from_id=? OR to_id=? GROUP BY CASE WHEN from_id=? THEN to_id ELSE from_id END
     ) t ON m.id = t.mid
     ORDER BY m.id DESC`,
    uid, uid, uid
  )
  const result = []
  for (const m of list) {
    const peerId = m.from_id === uid ? m.to_id : m.from_id
    const peer = await get<any>('SELECT id, real_name, role, avatar FROM users WHERE id=?', peerId)
    const unread = (await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND from_id=? AND is_read=0', uid, peerId))?.n || 0
    result.push({ ...m, attachments: j(m.attachments), peer, unread })
  }
  const allUsers = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
  return c.json({ sessions: result, allUsers })
})

// 超管查任意两用户之间的消息
app.get('/api/messages/all/:aId/:bId', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const aId = Number(c.req.param('aId'))
  const bId = Number(c.req.param('bId'))
  const list = await all<any>(
    `SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id ASC`,
    aId, bId, bId, aId
  )
  return c.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

app.post('/api/messages', auth, async (c) => {
  const uid = c.get('user').id
  const { toId, content, attachments } = await c.req.json()
  if (!toId || !content) return c.json({ message: '请填写收件人和内容' }, 400)
  const r = await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, uid, toId, content, JSON.stringify(attachments || []))
  return c.json({ id: Number(r.lastInsertRowid) })
})

// 全部已读（站内信）
app.post('/api/messages/read-all', auth, async (c) => {
  const uid = c.get('user').id
  await run('UPDATE messages SET is_read=1 WHERE to_id=? AND is_read=0', uid)
  return c.json({ ok: true })
})

// 与某人的对话（参数路由，必须放在所有具名子路径之后）
app.get('/api/messages/:peerId', auth, async (c) => {
  const uid = c.get('user').id
  const peerId = Number(c.req.param('peerId'))
  if (!peerId || isNaN(peerId)) return c.json({ message: '无效的会话对象' }, 400)
  const list = await all<any>(
    `SELECT * FROM messages WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id ASC`,
    uid, peerId, peerId, uid
  )
  await run('UPDATE messages SET is_read=1 WHERE to_id=? AND from_id=?', uid, peerId)
  return c.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

// ==============================================================================
// ============ 需求5：超管网站运行监控 ============
// ==============================================================================
app.get('/api/admin/monitor', auth, requireRole('SUPER_ADMIN'), async (c) => {
  const t0 = Date.now()
  c.header('X-Monitor-Version', 'v2-optimized')
  const fiveMinAgo = datetimeBeijing(new Date(Date.now() - 5 * 60 * 1000))
  const oneHourAgo = datetimeBeijing(new Date(Date.now() - 60 * 60 * 1000))
  const today = dateNowBeijing()
  const sevenDaysAgo = new Date(Date.now() - 6 * 86400 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })

  // ---- 批次1: 用户统计 + 今日数据 + 待审核 (合并为单条SQL) ----
  const userStatsRow = (await get<{ total: number; active: number; online5: number; online1h: number }>(
    `SELECT COUNT(*) as total,
       COUNT(CASE WHEN status='active' THEN 1 END) as active,
       COUNT(CASE WHEN last_active>=? AND status='active' THEN 1 END) as online5,
       COUNT(CASE WHEN last_active>=? AND status='active' THEN 1 END) as online1h
     FROM users`, fiveMinAgo, oneHourAgo))!
  const todayRow = (await get<{ logins: number; articles: number; resources: number; exps: number; pArticles: number; pResources: number }>(
    `SELECT (SELECT COUNT(DISTINCT user_id) FROM exp_logs WHERE action_type='login' AND substr(created_at,1,10)=?) as logins,
       (SELECT COUNT(*) FROM articles WHERE substr(created_at,1,10)=?) as articles,
       (SELECT COUNT(*) FROM resources WHERE substr(created_at,1,10)=?) as resources,
       (SELECT COALESCE(SUM(exp_change),0) FROM exp_logs WHERE substr(created_at,1,10)=?) as exps,
       (SELECT COUNT(*) FROM articles WHERE status IN ('pending','pending_student')) as pArticles,
       (SELECT COUNT(*) FROM resources WHERE status='pending') as pResources`, today, today, today, today))!

  // ---- 批次2: 19张表COUNT(*) 一次batch ----
  const tables = ['users','classes','class_members','subjects','articles','resources','query_tasks','query_rows','exp_logs','notices','pages','page_comments','messages','quizzes','quiz_questions','quiz_submissions','subject_questions','practice_submissions','likes_map']
  const batchResults = await D1.batch(tables.map(t => D1.prepare(`SELECT COUNT(*) as n FROM ${t}`)))
  const tableStats: Record<string, number> = {}
  tables.forEach((t, i) => { tableStats[t] = (batchResults[i]?.results?.[0] as any)?.n ?? 0 })

  // ---- 批次3: 7天活跃趋势 (2条GROUP BY替代14条串行) + 角色分布 + 学科分布 ----
  const [dailyUsers, dailyArticles, roleDist, subjArticles, subjResources, subjects] = await Promise.all([
    all<{ d: string; n: number }>("SELECT substr(created_at,1,10) as d, COUNT(DISTINCT user_id) as n FROM exp_logs WHERE substr(created_at,1,10)>=? GROUP BY d", sevenDaysAgo),
    all<{ d: string; n: number }>("SELECT substr(created_at,1,10) as d, COUNT(*) as n FROM articles WHERE substr(created_at,1,10)>=? GROUP BY d", sevenDaysAgo),
    all<{ role: string; n: number }>("SELECT role, COUNT(*) as n FROM users GROUP BY role ORDER BY n DESC"),
    all<{ subject_id: number; n: number }>('SELECT subject_id, COUNT(*) as n FROM articles GROUP BY subject_id'),
    all<{ subject_id: number; n: number }>('SELECT subject_id, COUNT(*) as n FROM resources GROUP BY subject_id'),
    all<{ id: number; name: string; icon: string }>('SELECT id, name, icon FROM subjects ORDER BY display_order'),
  ])

  // D1 数据库大小
  let dbSize = 0
  try {
    const [pc, ps] = await D1.batch([D1.prepare('PRAGMA page_count'), D1.prepare('PRAGMA page_size')])
    const pcVal = (pc?.results?.[0] as any)?.page_count || 0
    const psVal = (ps?.results?.[0] as any)?.page_size || 4096
    dbSize = pcVal * psVal
  } catch {}
  function fmtBytes(b: number) {
    if (b < 1024) return b + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  // 组装7天趋势
  const userMap = new Map(dailyUsers.map(r => [r.d, r.n]))
  const articleMap = new Map(dailyArticles.map(r => [r.d, r.n]))
  const dailyActive: { date: string; users: number; articles: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    dailyActive.push({ date: d.slice(5), users: userMap.get(d) ?? 0, articles: articleMap.get(d) ?? 0 })
  }

  // 组装学科分布
  const artMap = new Map(subjArticles.map(r => [r.subject_id, r.n]))
  const resMap = new Map(subjResources.map(r => [r.subject_id, r.n]))
  const subjectDist = subjects
    .map(s => ({ name: `${s.icon || '📚'} ${s.name}`, value: (artMap.get(s.id) ?? 0) + (resMap.get(s.id) ?? 0) }))
    .filter(s => s.value > 0)

  const cf = (c.req.raw as any).cf
  return c.json({
    online: {
      online5min: userStatsRow.online5, online1hour: userStatsRow.online1h,
      totalUsers: userStatsRow.total, activeUsers: userStatsRow.active,
      todayLogins: todayRow.logins, todayArticles: todayRow.articles,
      todayResources: todayRow.resources, todayExps: todayRow.exps,
    },
    database: { fileSize: dbSize, fileSizeFmt: fmtBytes(dbSize), tables: tableStats },
    platform: {
      runtime: 'Cloudflare Workers', colo: cf?.colo || 'N/A', country: cf?.country || 'N/A',
      httpProtocol: cf?.httpProtocol || 'HTTP/2', tlsVersion: cf?.tlsVersion || 'TLSv1.3',
      isEdge: true, d1Region: 'WNAM', d1SizeLimit: '500 MB (免费套餐)',
      workerCpuLimit: '10ms CPU/请求 (免费套餐)', workerSubrequests: '50 子请求/请求',
    },
    subjectDist,
    roleDist: roleDist.map(r => ({ name: r.role === 'SUPER_ADMIN' ? '超级管理员' : r.role === 'TEACHER' ? '教师' : '学生', value: r.n })),
    pending: { articles: todayRow.pArticles, resources: todayRow.pResources },
    dailyActive,
    _debug: { totalMs: Date.now() - t0 },
  })
})

// ==============================================================================
// 404 处理（Workers 不处理静态文件，静态文件由 Cloudflare Pages 负责）
// ==============================================================================
app.notFound((c) => {
  const p = new URL(c.req.url).pathname
  if (p.startsWith('/api/')) {
    return c.json({ message: '接口不存在' }, 404)
  }
  return c.json({ message: '页面不存在' }, 404)
})

// 全局错误处理
app.onError((err, c) => {
  console.error('[worker] Unhandled error:', err)
  return c.json({ message: '服务器内部错误', error: (err as Error).message }, 500)
})

// ==============================================================================
// Workers 入口
// ==============================================================================
export default app
