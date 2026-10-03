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
import * as XLSX from 'xlsx'
// ===== v4.4.0 统一存储抽象层（B2 原生 + Supabase 适配器 + 流式代理） =====
import {
  initStorage, doStorageUpload, serveFileById, prewarmFile, migrateToB2,
  getStorageMonitor, getQuotaToday, getUserOrigin, b2Delete, b2DownloadStream, supaExtractKey,
  runBucketCensus, getOfficialDaily, setOfficialDaily,
} from './storage-layer'
// ===== v4.13.0 AI 试卷识别（Cloudflare Workers AI + 智谱双通道，共享模块）=====
import {
  aiParsePaper, aiAvailable, effectiveProvider,
  DEFAULT_MODEL_CF, DEFAULT_MODEL_CF_FALLBACK, DEFAULT_MODEL_ZHIPU,
  AI_CONFIG_KEY, DEFAULT_AI_CONFIG, sanitizeAiConfig, mergeAiConfig, maskKey,
  type AiEnv, type AiBindingLike,
} from './shared/ai-paper'

// ===== Workers 环境变量类型 =====
interface Env {
  DB: D1Database
  JWT_SECRET?: string
  JWT_EXPIRES?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_BUCKET?: string
  // ===== v4.4.0 B2 存储配置（密钥类走 wrangler secret，禁止硬编码） =====
  STORAGE_BACKEND?: string        // B2_FREE | B2_PAID | SUPABASE（绝不自动切付费）
  B2_KEY_ID?: string
  B2_APPLICATION_KEY?: string     // secret
  B2_BUCKET_ID?: string
  B2_BUCKET_NAME?: string
  B2_ACCOUNT_ID?: string
  B2_QUOTA_ALERT?: string         // 默认 2200
  B2_USER_DAILY_ORIGIN_LIMIT?: string // 默认 100
  CACHE_TTL_PUBLIC?: string
  CACHE_TTL_WEBP?: string
  CACHE_TTL_PRIVATE?: string
  // ===== v4.13.0 AI 试卷识别（通道 A 走下面 [ai] 绑定，无需 Key）=====
  //   AI 绑定由 wrangler.toml 的 [ai] binding 提供，是"零配置"的关键
  AI?: AiBindingLike
  ZHIPU_API_KEY?: string
  AI_PROVIDER?: string          // cf | zhipu | auto（默认 auto）
  AI_MODEL_CF?: string
  AI_MODEL_CF_FALLBACK?: string
  AI_MODEL_ZHIPU?: string
  /** 仅测试用：把请求指向本地 mock（生产不配置） */
  AI_BASE_CF?: string
  AI_BASE_ZHIPU?: string
}

// ===== 全局变量（在请求中间件中从 c.env 设置） =====
let D1: D1Database
let JWT_SECRET = 'zhuiguang-secret-2026'
let JWT_EXPIRES = '7d'
let SUPABASE_URL = ''
let SUPABASE_KEY = ''
let SUPABASE_BUCKET = 'zhuiguang-files'

// ===== v4.4.0 存储层配置（供 storage-layer 使用） =====
let STORAGE_BACKEND = 'B2_FREE'
let B2_KEY_ID = ''
let B2_APPLICATION_KEY = ''
let B2_BUCKET_ID = ''
let B2_BUCKET_NAME = ''
let B2_ACCOUNT_ID = ''
let B2_QUOTA_ALERT = '2200'
let B2_USER_DAILY_ORIGIN_LIMIT = '100'
let CACHE_TTL_PUBLIC = '86400'
let CACHE_TTL_WEBP = '2592000'
let CACHE_TTL_PRIVATE = '0'

// ===== v4.13.0 AI 试卷识别配置（请求中间件从 c.env 注入）=====
//   直接复用共享模块的 AiEnv 类型，避免两处字段漂移（铁律#11）。
//   注意：这里只放"基础设施"部分（env.AI 绑定 + 环境变量兜底值）；
//   超管在后台改的配置存 D1，**每次请求实时合并**（见 aiEnv()），不缓存在这个变量上。
let AI_ENV: AiEnv = {}
let AI_BINDING: AiBindingLike | undefined

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
// 【v4.9.7】ADMIN 角色 + 每人独立权限模型
//   - SUPER_ADMIN：恒全权，任何地方不可被剥夺，不读 permissions 列
//   - ADMIN：权限来自 users.permissions（JSON 数组字符串），每个管理员各自一套
//   - TEACHER / STUDENT：不参与权限系统（教师走原有学科判定逻辑）
//   - 13 个 key 与后台菜单一一对应；前端同名单见 src/constants/permissions.ts
// ==============================================================================
export const PERM_KEYS = [
  'dashboard',     // 数据看板
  'users',         // 用户管理
  'subjects',      // 学科管理
  'classes',       // 班级管理
  'audit',         // 内容审核
  'query',         // 数据查询
  'guide',         // 网站说明
  'site_config',   // 网站自定义
  'exp_rules',     // 经验设置
  'exp_logs',      // 经验记录
  'feature_flags', // 功能开关
  'theme',         // 界面风格
  'monitor',       // 运行监控
  'ai_settings',   // AI 设置（v4.13.0）
] as const
export type PermKey = typeof PERM_KEYS[number]

// ==============================================================================
// 【v4.10.2】角色 → 中文名（后端侧）
//
// 与前端 `src/constants/permissions.ts` 的 roleName/roleFullName 保持一致。
// ⚠️ 教训：v4.9.7 新增 ADMIN 时，后端角色分布图用的是三元链兜底到「学生」，
//   导致管理员被统计成学生。此后**新增角色只改这两处**（前端 constants + 此处）。
//   未知角色一律返回「未知角色」，绝不冒充学生。
// ==============================================================================
const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: '超级管理员',
  ADMIN: '管理员',
  TEACHER: '教师',
  STUDENT: '学生',
}
/** 角色 → 中文名；未知角色返回「未知角色」（不冒充学生） */
export function roleName(r?: string | null): string {
  if (!r) return '未知角色'
  return ROLE_NAMES[r] || '未知角色'
}

/** 把 DB 中的 permissions（TEXT/JSON 数组字符串）解析为合法 key 数组；NULL/非法一律 → [] */
export function parsePerms(raw: any): PermKey[] {
  if (Array.isArray(raw)) return raw.filter((k: any) => (PERM_KEYS as readonly string[]).includes(k)) as PermKey[]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter((k: any) => (PERM_KEYS as readonly string[]).includes(k)) as PermKey[]
  } catch { return [] }
}

/**
 * 判断用户是否拥有某模块权限：SUPER_ADMIN 恒真；仅 ADMIN 读 permissions 数组
 *
 * ⚠️【重要】u.permissions 可能是两种形态，本函数都要能处理：
 *   1) 数组 —— 来自 auth 中间件（已 parsePerms）或 pub()；
 *   2) JSON 字符串 —— 来自 handler 内部 `SELECT ..., permissions FROM users` 的原始行。
 *   早期实现只认数组，导致「handler 里现查 DB 再调 hasPerm」恒为 false（审核美文 403 即此因）。
 */
export function hasPerm(u: any, key: PermKey): boolean {
  if (!u) return false
  if (u.role === 'SUPER_ADMIN') return true
  // 【v4.9.7 安全】只有 ADMIN 走权限数组。
  //   TEACHER / STUDENT 一律 false —— 即使 users.permissions 里残留了值也不认，
  //   防止「教师被误写入 permissions」或「降级为教师时权限未清」造成越权。
  if (u.role !== 'ADMIN') return false
  const raw = u.permissions
  if (Array.isArray(raw)) return raw.includes(key)
  if (typeof raw === 'string' && raw) return parsePerms(raw).includes(key)
  return false
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
    // 从数据库实时读取 role + status + subject_id + permissions
    // 【v4.9.7】permissions 一并实时读取：管理员被改权限后立即生效（无需等 JWT/前端缓存过期）
    try {
      const u = await get<{ status: string; role: string; subject_id: number | null; permissions: string | null }>(
        'SELECT status, role, subject_id, permissions FROM users WHERE id=?', payload.id)
      if (!u) return c.json({ message: '用户不存在' }, 401)
      if (u.status === 'disabled') {
        return c.json({ message: '账号已被禁用，请联系管理员', disabled: true }, 401)
      }
      // 使用数据库中的最新 role 与 subject_id（非 JWT 旧值）
      c.set('user', { id: payload.id, role: u.role, subject_id: u.subject_id ?? null, permissions: parsePerms(u.permissions) })
    } catch {
      c.set('user', { ...payload, subject_id: null, permissions: [] })
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

/**
 * 【v4.9.7】requirePerm 中间件：按模块权限 key 放行
 *  - SUPER_ADMIN：恒放行
 *  - ADMIN：permissions 数组含该 key 才放行
 *  - 其他角色：403
 * 用法：app.get('/api/users', auth, requirePerm('users'), handler)
 */
export const requirePerm = (key: PermKey) => {
  return async (c: Context, next: () => Promise<void>) => {
    const u = c.get('user') as any
    if (!u) return c.json({ message: '未登录' }, 401)
    if (!hasPerm(u, key)) return c.json({ message: '无权限' }, 403)
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

/**
 * 【v4.9.7】requireStaffOr 中间件：教师 OR 超管 OR 拥有指定模块权限的 ADMIN
 * 仅用于「数据查询」这类原本教师+超管可用、现在需要让配了权限的管理员也能进的接口。
 * ⚠️ 刻意不改 requireStaff 本身 —— 它被 quiz/exam/practice 等 20+ 路由共用，
 *    改它会波及其他业务语义，风险过大。
 */
export const requireStaffOr = (key: PermKey) => {
  return async (c: Context, next: () => Promise<void>) => {
    const u = c.get('user') as any
    const ok = !!u && (u.role === 'TEACHER' || u.role === 'SUPER_ADMIN' || hasPerm(u, key))
    if (!ok) return c.json({ message: '需要教师或管理员权限' }, 403)
    await next()
  }
}


/**
 * 【v4.0.0】学科教师或超管中间件（仅支持 params/query 来源，避免消费 body 一次）
 * 规则：
 *  - SUPER_ADMIN 永远放行
 *  - TEACHER 必须任教该 subject（class_members.role_in_class='TEACHER'）
 *  - 其他角色 403
 * 用法：
 *   app.post('/api/subjects/:id/questions', auth, requireSubjectStaff('params','id'), ...)
 *   app.patch('/api/subjects/:id/announcement', auth, requireSubjectStaff('params','id'), ...)
 *   app.get('/api/subjects/:id/xxx', auth, requireSubjectStaff('query','subjectId'), ...)
 * ⚠️ 对于 POST body 来源的 subjectId（如 /api/quizzes），仍由 handler 内部 await canManageSubject()
 */
export const requireSubjectStaff = (source: 'params' | 'query' = 'params', key = 'id') => {
  return async (c: Context, next: () => Promise<void>) => {
    const u = c.get('user') as { id: number; role: string; subject_id?: number | null } | undefined
    if (!u) return c.json({ message: '未登录' }, 401)
    if (u.role === 'SUPER_ADMIN') return next()
    // 【v4.9.7】拥有 subjects（学科管理）权限的管理员 = 可管全学科，等价超管放行
    if (hasPerm(u, 'subjects')) return next()
    if (u.role !== 'TEACHER') return c.json({ message: '需要教师或管理员权限' }, 403)
    let subjectId: any
    if (source === 'params') subjectId = c.req.param(key)
    else subjectId = c.req.query(key)
    const sid = Number(subjectId)
    if (!sid) return c.json({ message: '缺少 subjectId' }, 400)
    // 【v4.0.1】任教学科集合 + 主学科 users.subject_id 兜底
    const sids = await teachingSubjects(u.id)
    if (!sids.includes(sid) && u.subject_id && Number(u.subject_id) === sid) {
      sids.push(Number(u.subject_id))
    }
    if (!sids.includes(sid)) return c.json({ message: '无权管理该学科' }, 403)
    await next()
  }
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
    const merged = { ...DEFAULT_EXP_RULES, ...saved }
    // 过滤掉删除/取消类规则
    const excludeKeys = ['article_delete', 'resource_delete', 'blog_delete', 'query_delete', 'comment_delete', 'like_cancel', 'favorite_cancel']
    for (const k of excludeKeys) { delete merged[k] }
    // 自动修复：如果任何关键正向规则（login/register/article/resource/quiz_pass）
    // 在数据库中被设为0但默认值不为0，说明是前端BUG导致的错误数据，自动重置为默认规则
    const positiveKeys = ['login', 'register', 'article', 'resource', 'quiz_pass']
    const needsFix = positiveKeys.some(k => saved && k in saved && saved[k] === 0 && DEFAULT_EXP_RULES[k] !== 0)
    if (needsFix) {
      await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", 'exp_rules', JSON.stringify(DEFAULT_EXP_RULES))
      expRulesCache = { ...DEFAULT_EXP_RULES }
    } else {
      expRulesCache = merged
    }
  } catch { expRulesCache = { ...DEFAULT_EXP_RULES } }
  return expRulesCache!
}

export function refreshExpRules() { expRulesCache = null }

/**
 * 【v4.11.0 经验值单一真源】把 users.exp / users.level 按 exp_logs 全量重算。
 *
 * 设计原则：exp_logs 是**唯一真源**，users.exp 只是派生缓存（供排序 / 免聚合展示）。
 * 因此任何改动经验值的入口，只需保证"日志写对了"，再调用本函数重算缓存，
 * 就永远不会出现"两个数据源漂移"的问题。
 *
 * 之所以不用 `exp = exp + delta` 增量法：增量法一旦有一条写漏（例如历史遗留的
 * PATCH /api/users/:id/exp 直改 exp 不写日志），偏差会**永久固化**且无法自愈。
 * 全量 SUM 重算则是幂等的，任何一次调用都会把数据拉回正确值。
 */
export async function syncUserExp(userId: number) {
  await run(
    `UPDATE users
        SET exp = MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)),
            level = CAST(MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)) / 60 AS INTEGER) + 1
      WHERE id=?`,
    userId, userId, userId
  )
}

/** 批量重算（去重后逐个执行，避免重复查询） */
export async function syncUserExpBatch(userIds: number[]) {
  const uniq = Array.from(new Set(userIds.filter(n => Number.isFinite(n))))
  for (const uid of uniq) await syncUserExp(uid)
  return uniq.length
}

export async function addExp(userId: number, change: number | undefined, actionType: string, desc: string, subjectId?: number | null) {
  let delta = change
  if (delta === undefined) {
    const rules = await getExpRules()
    delta = rules[actionType] ?? 0
  }
  if (delta === undefined || delta === null || isNaN(delta as number)) return
  // 即使 delta=0 也要写 exp_logs 记录（用于每日登录防重复检查）
  await run(`INSERT INTO exp_logs (user_id,action_type,exp_change,description,subject_id,created_at) VALUES (?,?,?,?,?,datetime('now','+8 hours'))`, userId, actionType, delta, desc, subjectId ?? null)
  // 【v4.11.0】日志写完再按日志和重算缓存，彻底消除双源漂移
  if (delta !== 0) await syncUserExp(userId)
}

export async function addNotice(userId: number, title: string, content: string, type: string, targetUrl?: string) {
  await run(
    `INSERT INTO notices (user_id,title,content,type,target_url,created_at) VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
    userId, title, content, type, targetUrl || null
  )
}

export async function userClassIds(userId: number): Promise<number[]> {
  const rows = await all<{ class_id: number }>('SELECT class_id FROM class_members WHERE user_id = ?', userId)
  return rows.map(r => r.class_id)
}

export async function teachingSubjects(userId: number): Promise<number[]> {
  const rows = await all<{ subject_id: number }>(
    'SELECT DISTINCT subject_id FROM (' +
    'SELECT subject_id FROM class_members WHERE user_id = ? AND role_in_class = ? AND subject_id IS NOT NULL ' +
    'UNION SELECT subject_id FROM user_subjects WHERE user_id = ? AND subject_id IS NOT NULL ' +
    // 兼容历史数据：主学科 users.subject_id 兜底
    'UNION SELECT subject_id FROM users WHERE id = ? AND subject_id IS NOT NULL' +
    ')', userId, 'TEACHER', userId, userId)
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
// Storage（Supabase Storage，Workers 兼容）
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

/** 生成 Supabase 签名上传 URL（前端直传用） */
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

/** 上传文件到 Supabase Storage，返回公共 URL */
export async function uploadFile(key: string, data: ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
  const sb = getSupabase()
  if (!sb) throw new Error('Storage not configured')
  const { error } = await sb.storage.from(SUPABASE_BUCKET).upload(key, data, { contentType, upsert: true })
  if (error) throw error
  const { data: d } = sb.storage.from(SUPABASE_BUCKET).getPublicUrl(key)
  return d.publicUrl
}

/** 删除文件 */
export async function deleteFile(key: string): Promise<void> {
  const sb = getSupabase()
  if (!sb || !key) return
  await sb.storage.from(SUPABASE_BUCKET).remove([key])
}

/** 从 file_path 字段提取存储 key */
export function extractKey(filePath: string): string {
  if (!filePath) return ''
  // 如果是完整的 Supabase URL，提取 object key
  if (/^https?:\/\//.test(filePath)) {
    const m = filePath.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)$/)
    if (m) return m[1]
    const parts = filePath.split('/')
    return parts[parts.length - 1] || ''
  }
  return filePath.replace(/^\/?uploads?\//, '')
}

/** 下载文件（从 Supabase Storage） */
export async function downloadFile(filePath: string): Promise<{ buffer: ArrayBuffer; contentType?: string } | null> {
  const sb = getSupabase()
  const key = extractKey(filePath)
  if (!key || !sb) return null
  const { data, error } = await sb.storage.from(SUPABASE_BUCKET).download(key)
  if (error || !data) return null
  return { buffer: await data.arrayBuffer(), contentType: (data as any).type }
}

// 从各种形态的输入中提取 fileId：
//   /api/file/{id}                 → {id}
//   https://host/api/file/{id}     → {id}（v4.4.3 起前端会把相对路径补全为绝对外链写入库，需兼容）
//   裸 id（字母数字串）             → 原样返回
function parseFileId(input?: string | null): string | null {
  if (!input) return null
  const s = String(input).trim()
  const m = s.match(/\/api\/file\/([A-Za-z0-9_-]+)/)
  if (m) return m[1]
  if (/^[A-Za-z0-9_-]{8,}$/.test(s)) return s
  return null
}

// ==============================================================================
// 🔒 全局双层缓存鉴权系统（/file/* 站内路由专用）
// 第一层：JWT 登录校验（支持 query param + header 双模式）
// 第二层：资源权限校验（已审核公开 / 未审核仅本人+管理可见）
// ==============================================================================

/** 从请求中提取并验证 JWT（支持 Authorization header 和 ?token= query param） */
async function verifyFileAccess(c: Context): Promise<{ id: number; role: string } | null> {
  // 优先从 header 取
  let token = c.req.header('authorization')
  if (token && token.startsWith('Bearer ')) token = token.slice(7)
  // 回退到 query param（用于浏览器直接访问 /file/r/123?token=xxx）
  if (!token) token = c.req.query('token') || ''
  if (!token) return null
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; role: string }
    const u = await get<{ status: string; role: string }>('SELECT status, role FROM users WHERE id=?', payload.id)
    if (!u || u.status === 'disabled') return null
    return { id: payload.id, role: u.role }
  } catch { return null }
}

// ==============================================================================
// 🚀 边缘缓存 + 热点文件常驻缓存（根治 Supabase 429 限流）
// ==============================================================================
const EDGE_CACHE = caches.default

// 热点文件内存缓存（Worker 实例级常驻，LRU 淘汰）
type HotFileEntry = { buffer: ArrayBuffer; contentType: string; size: number; expireAt: number; hits: number }
const HOT_FILE_CACHE = new Map<string, HotFileEntry>()
const HOT_FILE_MAX = 30           // 最多缓存30个热点文件
const HOT_FILE_MAX_SIZE = 5 * 1024 * 1024  // 单文件最大5MB才入热点缓存
const HOT_FILE_TTL = 30 * 60 * 1000         // 热点缓存30分钟

function hotFileCleanup() {
  const now = Date.now()
  for (const [k, v] of HOT_FILE_CACHE) {
    if (v.expireAt < now) HOT_FILE_CACHE.delete(k)
  }
  // 超出数量限制时，按 hits 降序淘汰最冷门的
  if (HOT_FILE_CACHE.size > HOT_FILE_MAX) {
    const sorted = [...HOT_FILE_CACHE.entries()].sort((a, b) => a[1].hits - b[1].hits)
    while (HOT_FILE_CACHE.size > HOT_FILE_MAX && sorted.length > 0) {
      const [k] = sorted.shift()!
      HOT_FILE_CACHE.delete(k)
    }
  }
}

/** 生成边缘缓存 key（带版本号，方便批量失效） */
const FILE_CACHE_VERSION = 'v1'
function fileCacheKey(resourceId: number, mode: string): string {
  return `${FILE_CACHE_VERSION}:file:r:${resourceId}:${mode}`
}

/** 生成边缘缓存 Request（Cache API 需要 Request 作为 key） */
function fileCacheRequest(resourceId: number, mode: string): Request {
  const url = `https://zguang-file-cache.internal/${fileCacheKey(resourceId, mode)}`
  return new Request(url)
}

// ==============================================================================
// 📦 文件轻量化适配 - 容量监控辅助函数
// ==============================================================================

/** 列出 Supabase 存储桶中的所有文件（分页） */
async function listSupabaseFiles(prefix?: string): Promise<{ name: string; size: number; id: string; lastModified: string }[]> {
  const sb = getSupabase()
  if (!sb) return []
  const allFiles: { name: string; size: number; id: string; lastModified: string }[] = []
  let offset = 0
  const limit = 100
  // 最多取500个文件，防止超时
  for (let i = 0; i < 5; i++) {
    const { data, error } = await sb.storage.from(SUPABASE_BUCKET).list(prefix || '', {
      limit,
      offset,
      sortBy: { column: 'created_at', order: 'desc' },
    })
    if (error || !data) break
    for (const f of data) {
      if (f.name && !f.id.endsWith('/')) {
        allFiles.push({
          name: f.name,
          size: (f.metadata as any)?.size || 0,
          id: f.id,
          lastModified: (f.metadata as any)?.lastModified || (f.created_at as string) || '',
        })
      }
    }
    if (data.length < limit) break
    offset += limit
  }
  return allFiles
}

/** 获取 Supabase 存储桶总用量 */
async function getSupabaseStorageUsage(): Promise<{ totalFiles: number; totalSize: number; files: any[] }> {
  const files = await listSupabaseFiles()
  const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0)
  return { totalFiles: files.length, totalSize, files }
}

/** 获取 Supabase 数据库统计（通过 REST API） */
async function getSupabaseDbStats(): Promise<any> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null
  try {
    // 查询各表行数（通过 PostgREST count header）
    const tables = ['users', 'articles', 'resources', 'exp_logs', 'notices', 'pages', 'messages', 'quizzes', 'quiz_questions', 'quiz_submissions', 'subject_questions', 'practice_submissions', 'likes_map', 'class_members', 'classes', 'subjects', 'query_tasks', 'query_rows', 'article_comments', 'page_comments']
    const results: Record<string, number> = {}
    // 分批查询，避免超时（每次5个表）
    for (let i = 0; i < tables.length; i += 5) {
      const batch = tables.slice(i, i + 5)
      await Promise.all(batch.map(async (t) => {
        try {
          const resp = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Prefer': 'count=exact',
              'Range': '0-0',
            },
          })
          const range = resp.headers.get('content-range')
          if (range) {
            const m = range.match(/\/(\d+)/)
            results[t] = m ? parseInt(m[1]) : 0
          } else {
            results[t] = 0
          }
        } catch { results[t] = 0 }
      }))
    }
    return results
  } catch { return null }
}

/** 生成文件优化建议 */
function generateOptimizationSuggestions(files: any[], resources: any[]): any[] {
  const suggestions: any[] = []
  const resourceMap = new Map(resources.map((r: any) => [r.file_path, r]))
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() || ''
    const size = f.size || 0
    const resource = resourceMap.get(f.name) || resourceMap.get(f.id)
    if (size > 500 * 1024) { // >500KB 的文件才建议优化
      let type = ''
      let potentialSaving = 0
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
        type = 'image'
        potentialSaving = Math.floor(size * 0.4) // 图片预计可压缩40-60%
      } else if (ext === 'pdf') {
        type = 'pdf'
        potentialSaving = Math.floor(size * 0.2) // PDF预计可压缩15-30%
      } else if (['doc', 'docx', 'ppt', 'pptx'].includes(ext)) {
        type = 'document'
        potentialSaving = Math.floor(size * 0.15)
      } else if (['zip', 'rar', '7z'].includes(ext)) {
        type = 'archive'
        potentialSaving = Math.floor(size * 0.05)
      }
      if (type) {
        suggestions.push({
          fileName: f.name,
          fileSize: size,
          fileType: type,
          resourceId: resource?.id || null,
          resourceTitle: resource?.title || '未关联资源',
          potentialSaving,
          savingPercent: Math.round((potentialSaving / size) * 100),
        })
      }
    }
  }
  return suggestions.sort((a, b) => b.potentialSaving - a.potentialSaving)
}

/** 格式化字节 */
function fmtBytes(b: number): string {
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

// ==============================================================================
// 工具函数
// ==============================================================================
const j = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null } catch { return null } }
/**
 * 剥离敏感字段后返回用户对象
 * 【v4.9.7】permissions 列为 TEXT/JSON 字符串，这里统一解析为数组后再下发，
 *          前端（store.normalizeUser）可直接使用，无需再解析。
 */
const pub = (u: any) => {
  if (!u) return u
  const { password_hash, ...rest } = u
  if ('permissions' in rest) rest.permissions = parsePerms(rest.permissions)
  return rest
}

/**
 * 【v4.9.7】用户对象下发前的统一后处理：
 *   1) 剥离 password_hash
 *   2) permissions 规整为数组 —— SUPER_ADMIN 恒为全部 key（前端可直接依赖长度判断）
 * 登录 / 注册 / me 三处都走它，避免「某个入口漏了权限字段」导致前端菜单抽风。
 */
const withPerms = (u: any) => {
  const out = pub(u)
  if (out) out.permissions = out.role === 'SUPER_ADMIN' ? [...PERM_KEYS] : parsePerms(out.permissions)
  return out
}

function setDownloadHeaders(c: Context, filename: string) {
  const encoded = encodeURIComponent(filename)
  c.header('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
}

/**
 * 【v4.0.1】判断用户能否管理某 subject 的内容（异步）
 * 规则：
 *   - SUPER_ADMIN 永远 true
 *   - TEACHER：任教学科集合（class_members.role_in_class='TEACHER'）∪ 主学科 users.subject_id 兜底
 *   - 其他角色 false
 * 注意：原实现只看 user.subject_id（用户的"主学科"单一字段），不支持多学科任教；
 *       改为 async + 复用 teachingSubjects（已正确从 class_members 聚合），
 *       并对 user.subject_id 兜底（兼容老数据：教师只在 users 表里指了主学科、没进 class_members 的场景）
 */
async function canManageSubject(user: any, subjectId: any, fallbackUserId?: number): Promise<boolean> {
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  if (user.role === 'TEACHER') {
    const sid = Number(subjectId)
    if (!sid) return false
    // 【v4.3.0 修复】user.id 缺失会导致 teachingSubjects(undefined) → D1_TYPE_ERROR: Type 'undefined' not supported
    // 历史 bug：多处 'SELECT role, subject_id FROM users WHERE id=?' 漏查 id 字段，
    // 超管因第 515 行短路返回 true 而长期掩盖，只有教师会触发 500。
    // 这里 double 保险：SQL 已补 id；若仍缺失则用 fallbackUserId，都没有则安全拒绝（返回 false 而非抛 500）。
    const uid = user.id ?? user.user_id ?? fallbackUserId
    if (uid === undefined || uid === null) return false
    const sids = await teachingSubjects(Number(uid))
    if (!sids.includes(sid) && user.subject_id && Number(user.subject_id) === sid) {
      sids.push(Number(user.subject_id))
    }
    return sids.includes(sid)
  }
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
  // 【v4.3.2】/api/admin/storage/file 返回二进制流，若被当作字符串塞进 Map 会损坏文件且撑爆缓存
  if (p.includes('/upload/') || p.includes('/download/') || p.includes('/comments') || p.includes('/export')) return null
  if (p.includes('/storage/file')) return null
  // 【v4.4.1 严重修复】/api/file/* 是 v4.4.0 新增的「统一文件代理」（二进制流，含下载与预览）。
  //   必须排除！否则下面的 c.res.text() 会把二进制按 UTF-8 解码再编码：
  //   · 所有无效字节变成 U+FFFD（EF BF BD）→ PDF/图片/Office 全部损坏（2.86MB 会被撑成 5.26MB）
  //   · 且必须先全量缓冲进内存再返回，流式透传彻底失效 → 这就是「B2 下载慢」的一大半原因
  if (p.startsWith('/api/file/')) return null
  const auth = (c.req.header('authorization') || '').slice(0, 200)
  let authHash = 'anon'
  try { authHash = btoa(auth).slice(0, 24) } catch {}
  // urlKey 提前计算：下方 /api/home 的匿名分支需要它做稳定公共 key 的早期返回
  const urlKey = p + '|' + new URL(c.req.url).search
  // ===== 【v4.8.26 性能专项】TTL 分级 =====
  // 背景（生产实测基线，样本 40）：
  //   平均响应 3.925s / P50 1.620s / P95 25.013s（超时）
  //   公共接口连续 10 次命中率仅 1~4/10；/api/notices 为 0/8 且最慢 25s。
  // 根因：① 原 TTL 仅 60s，过期即回源，D1 冷查询 0.8~9.6s 波动全暴露给用户；
  //       ② /api/notices、题库、知识点等高频接口**不在**缓存白名单，每次都打 D1。
  // 策略：按「数据变化频率」分三档，而非一刀切。
  //   一致性保障：任何写操作仍会 clearAllCache() → CACHE_VERSION 递增 →
  //   所有旧 key 立即失效 + purgeEdgeCache 删边缘条目，因此延长 TTL **不会**导致
  //   用户看到过期数据（这是 v4.8.24 已打好的地基）。
  let ttl = 30000  // 默认 30s：未归类接口的保守值
  // ── 【v4.9.4】首页聚合接口（hero 6 项合一）缓存策略 ──
  //   未登录：响应对所有人完全一致（favorites=0、无 exp/level），按 __zg_auth=anon 共享边缘分片，
  //     命中率很高；但仍走 CACHE_VERSION 失效通道（不用 stable|public），
  //     否则超管发布新美文后，游客首页的「美文」数字会滞后到边缘 TTL 才更新。
  //   已登录：含个人数据（收藏数 / 经验值 / 等级）→ 按用户隔离 + 30s TTL，
  //     足以吸收 /api/auth/me 偶发 8s+ 抖动（实测 P95 8.4s），且写操作后 CACHE_VERSION
  //     递增会立即让旧 key 失效，不会出现「取消收藏后数字不更新」。
  //   注意：此分支必须**放在其它档位判定之前**，否则 p.includes('/articles') 等规则会把它抬到 600s。
  if (p === '/api/home') {
    // 注意：匿名时 auth 为空串，authHash 会被 btoa('') 覆盖为 ''（而非 'anon'），
    //   故必须用「是否带 Authorization 头」判定匿名，不能写 authHash === 'anon'。
    ttl = !auth ? 60000 : 30000
  }
  // ── 档位 3（30s）：实时性要求最高的接口 ──
  if (p.includes('/admin/monitor') || p.includes('/me/status') || p.includes('/online')) ttl = 30000
  // ── 档位 1（600s）：极低频变动的公共只读内容 ──
  if (p.includes('/subjects') || p.includes('/leaderboard') || p.includes('/pages') ||
      p.includes('/themes') || p.includes('/feature-flags')) ttl = 600000
  // ── 档位 1 补充：文章 / 公告 / 指南 —— 由管理员手动编辑，变动极低频 ──
  //   原 TTL 60s 时 /api/notices 实测 0/8 命中、最慢 25s，是首页卡顿的主因之一。
  if (p.includes('/articles') || p.includes('/notices') || p.includes('/announcements') ||
      p.includes('/guide') || p.includes('/blog')) ttl = 600000
  // ── 档位 2（120s）：中频内容，写入后可接受 2 分钟内生效 ──
  //   题库/知识点等：教师会编辑，但不需要秒级一致。
  //   注意：这些接口带 authHash，缓存按用户隔离，不会串数据。
  //   `/comments` 不在此列 —— 见 `apiCacheKey` 开头的排除名单（该接口从不进缓存）。
  if (p.includes('/knowledge-points') || p.includes('/questions') ||
      (p.includes('/subjects/') && p.includes('/forum'))) ttl = 120000
  // 【v4.8.28-fix3 修复「边缘缓存被 CACHE_VERSION 切碎，公共接口几乎不命中」】
  //   现象（生产实测，同一 AMS 节点 10 次请求）：
  //     MISS / MISS / HIT-428s / HIT-394s / HIT-425s / HIT-494s / MISS / HIT-389s / HIT-591s / HIT-539s
  //   → 同一 URL 同一时刻并存 **7 份不同 age 的副本**，命中率被稀释到 ~50%。
  //   根因：`CACHE_VERSION` 是**每实例私有**的模块级变量，写操作只递增"当时处理
  //     该请求的那个实例"的版本号。Worker 有 N 个隔离实例，各自算出**不同的 key**
  //     → 边缘缓存被切成 N 份，轮流 MISS 回源打 D1（D1 冷查 0.8~11.8s）。
  //     而 `caches.default` 是**跨实例跨节点共享**的 —— 用实例私有量做 key 前缀，
  //     本质上就是「让共享缓存永远冷」。
  //   修法：对**已确认纯公共只读**的接口（isPublicShared），key **不含 CACHE_VERSION**，
  //     全局只留一份 → 命中率趋近 100%，首屏主题/学科/特性开关全部毫秒级返回。
  //   写后一致性怎么保证？
  //     · 这些接口的写入只发生在超管后台，且**写完后立即 purge 精确删除公共分片**
  //       （见 `purgeEdgeCache` 里新增的 `__zg_auth=public` 变体）；
  //     · 不是靠"等过期"，所以「改了主题 → 前台立刻生效」依旧成立，不会出现
  //       「缓存覆盖新修改」的老问题。
  //   注意：非公共接口（含个人数据）**保持原样**用 CACHE_VERSION，行为完全不变。
  if (isPublicSharedPath(p)) return `stable|public|${ttl}|${urlKey}`
  return `${CACHE_VERSION}|${authHash}|${ttl}|${urlKey}`
}

/** 【v4.8.28-fix3】纯站点级公共只读路径判定 —— 结果对所有身份**完全一致**。
 *  这些接口的 key 不参与身份分片、不随 CACHE_VERSION 漂移，全局共享一份边缘缓存。
 *  安全性：已逐个核对实现，均为服务端固定返回全站同一份数据，无任何 req 身份参与查询。
 *  ⚠️ **不能**用 `/pages` 前缀 —— `/api/pages/:id/liked` 是带 auth 的个人接口，
 *     前缀豁免会把它一起放开 → 越权。故只列精确安全项。 */
function isPublicSharedPath(p: string): boolean {
  // `/api/subjects/:slug/forum` 等带个人视角的子路径必须排除豁免
  if (p.includes('/forum')) return false
  return (
    p === '/api/themes' ||                    // 主题列表（已瘦身，仅色板摘要）
    p === '/api/themes/active' ||             // 站点生效主题（纯公共配置）
    /^\/api\/themes\/\d+$/.test(p) ||         // 主题详情（后台点选预设）
    p === '/api/feature-flags' ||             // 全站功能开关
    p === '/api/subjects' ||                  // 学科全量列表
    /^\/api\/subjects\/[^/]+$/.test(p)        // 学科详情（纯公共，无个人字段）
  )
}

let lastCacheCleanup = 0
function maybeCleanupCache() {
  const now = Date.now()
  if (now - lastCacheCleanup > 30000) {
    lastCacheCleanup = now
    for (const [k, v] of API_CACHE) if (v.expireAt < now) API_CACHE.delete(k)
  }
}

/** 清除全部缓存（公共内容修改后调用，确保所有用户立即看到最新数据）
 *
 * 【v4.8.24 严重修复｜「增删改后列表不刷新，手动刷新也没用」】
 * 原实现只有 `API_CACHE.clear()` —— 只能清掉**本实例**的内存 Map，完全清不掉
 * Cloudflare 边缘缓存（caches.default）里那份 `s-maxage=60, stale-while-revalidate=120`
 * 的响应。后果（已生产实测确认）：
 *   · GET /api/subjects、/api/leaderboard、/api/pages 的响应头是
 *     `Cache-Control: public, max-age=14400, s-maxage=60, stale-while-revalidate=120`
 *   · 连续请求返回 `X-Zg-Cache: EDGE-HIT` —— 命中的是边缘缓存，压根没回源
 *   · 于是增删改之后，**最长 60 + 120 = 180 秒**所有用户仍拿到旧数据
 *   · 用户手动刷新（Ctrl+F5）只清**浏览器**缓存，**清不掉 CF 边缘缓存**，
 *     所以表现为「点了删除，列表还是旧的，手动刷新也不行」
 * 修法（双管齐下）：
 *   ① 同步递增 CACHE_VERSION —— 旧版本的所有缓存 key 立刻作废。这一步是**跨实例生效**的
 *      （不像清 Map 只能影响当前实例），是真正可靠的失效手段。
 *   ② 尽力删除已写入 caches.default 的具体条目（deleteByUrl 由调用方在写操作后触发）。
 * 说明：Worker 的 caches.default 里旧条目会自然过期（s-maxage=60），
 *      且 ① 保证任何请求都不会再复用它们，因此一致性是立即达成的。
 */
function clearAllCache() {
  API_CACHE.clear()
  // ① 版本号递增：所有基于旧版本号构造的缓存 key 立即全部失效（跨实例可靠）
  CACHE_VERSION = 'v' + Date.now()
  // ② 顺手记下需要从边缘缓存删除的 URL 前缀（由 afterWritePurgeEdge 消费）
  EDGE_PURGE_NEEDED = true
}

// ===== v4.8.24 缓存版本号（跨实例失效用）=====
// 每次发生写操作就 +1，拼进所有缓存 key。这样即使某个实例的内存 Map 或
// 某个节点的 caches.default 还残留旧条目，也会因为 key 不匹配而永不命中。
// ⚠️ 必须以 `v` 开头：下面提取 ttl 时用 `/^\d+$/` 找「纯数字段」，
//    若版本号是裸数字（如 Date.now()）会被误认成 ttl → max-age 算出天文数字。
let CACHE_VERSION = 'v' + Date.now()
let EDGE_PURGE_NEEDED = false

/** 写操作后清理边缘缓存：尽最大努力删除已知的公共只读接口缓存条目
 *
 * 【v4.8.26 修正】原实现按「裸 URL」删除（`origin + prefix`），
 *   但本版已把边缘缓存的 key 改为**合成 URL**（`/api/__edge__/<encoded edgeKey>`，
 *   见 `edgeCacheKeyToUrl`）→ 原删除逻辑**完全落空**，一个条目都删不掉。
 *
 *   一致性其实**已由 CACHE_VERSION 递增保证**（旧版本号构造的 key 永不再命中），
 *   所以这里删不掉也不会导致「增删改后不刷新」。
 *   但边缘缓存条目会一直留到 s-maxage 自然过期（现在最长 600s）占空间，
 *   因此仍按新 key 格式尽力删除，作为第二道保险。
 *
 *   注意：合成 key 里含 authHash（按身份分片），无法枚举全部身份，
 *   故这里只能清理 **anon（未登录）** 那份 —— 已登录用户的部分依赖 CACHE_VERSION
 *   失效 + 自然过期。这是有意的取舍：**宁可留着过期条目，也不做昂贵的全量扫描**。 */
async function purgeEdgeCache(c) {
  if (!EDGE_PURGE_NEEDED) return
  EDGE_PURGE_NEEDED = false
  // 新版 key 为合成 URL，需按相同规则构造才能命中；此处清理既有分片。
  // 【v4.8.28-fix3】公共只读接口已改用**稳定 key**（`stable|public|...`），
  //   不再随 CACHE_VERSION 漂移 —— 这意味着**必须**在这里真正删掉它，
  //   否则「超管改主题后前台要等 600s 才生效」，正是用户反复强调的
  //   「缓存覆盖新修改」老问题。故一次性清 anon（历史分片）与 public（现行分片）。
  const origin = new URL(c.req.url).origin
  const samples = ['/api/subjects', '/api/leaderboard', '/api/pages', '/api/themes',
                   '/api/feature-flags', '/api/notices', '/api/home']
  for (const prefix of samples) {
    for (const variant of [prefix, prefix + '/']) {
      for (const shard of ['anon', 'public']) {
        const legacyKey = variant + '?__zg_auth=' + shard
        try {
          await caches.default.delete(new Request(
            origin + '/api/__edge__/' + encodeURIComponent(legacyKey), { method: 'GET' }))
        } catch {}
      }
      // 顺带尝试删除旧版（裸 URL）残留条目，平滑过渡
      try { await caches.default.delete(new Request(origin + variant, { method: 'GET' })) } catch {}
    }
  }
}

// ===== v4.4.30 边缘缓存（Cloudflare Cache API / caches.default）=====
// 背景：api.xkzg.de5.net 是 Worker 自定义域名，前置无自动 CDN 缓存层；
//       内存缓存 API_CACHE 仅单实例有效，跨实例/冷启动仍会回源 D1（实测 5~8s）。
//       caches.default 是跨节点共享的边缘缓存，重复读取毫秒级命中、不再打 D1。
//
// 【v4.8.26 性能专项】覆盖面扩大 + 按身份隔离
//   原实现只缓存 5 类**完全公共**接口（subjects/leaderboard/pages/themes/feature-flags），
//   `edgeCacheablePath` 对带 auth 的接口一律返回 null → 题库、知识点、公告等
//   **高频接口每次请求都回源打 D1**，这是生产实测命中率仅 1~4/10 的直接原因。
//
//   ⚠️ 安全前提：caches.default 的缓存 key 是**请求 URL**，天然**不含 Authorization 头**。
//   若直接把带 auth 的接口塞进边缘缓存，不同用户会命中同一份缓存 → 越权/串数据。
//   因此这里给 key 追加 `__zg_auth=<authHash>` 查询参数，让**每个身份一份独立缓存**：
//     · 匿名（未登录）：__zg_auth=anon —— 多个游客共享，安全（内容完全一致）
//     · 已登录：__zg_auth=<token 前 24 位 base64> —— 每人一份，互相不可见
//   该参数仅用于缓存分片，路由处理时会被忽略（仅读 pathname 做匹配），不影响业务。
function assertSafeEdgePath(p: string): boolean {
  // 明确排除的**敏感/二进制/流式**路径 —— 绝不进边缘缓存
  if (p.includes('/upload/') || p.includes('/download/') || p.includes('/export')) return false
  if (p.includes('/storage/file') || p.startsWith('/api/file/')) return false
  // 认证类接口：含 token/密码语义，且用户高度个性化
  if (p.includes('/login') || p.includes('/register') || p.includes('/password') ||
      p.includes('/captcha') || p.includes('/auth/')) return false
  // 管理员监控/审计：数据实时性要求高，且体量大
  if (p.includes('/admin/monitor') || p.includes('/admin/audit') || p.includes('/admin/exp-logs')) return false
  // 实时性接口
  if (p.includes('/me/status') || p.includes('/online') || p.includes('/unread')) return false
  return true
}
function edgeCacheablePath(c) {
  if (c.req.method !== 'GET') return null
  const u = new URL(c.req.url)
  const p = u.pathname
  if (!p.startsWith('/api/')) return null
  if (!assertSafeEdgePath(p)) return null

  // ── 可缓存范围（与原实现保持兼容，仅做**扩大**，不移除任何原有项）──
  const cacheable =
    // 【v4.9.4】首页聚合接口（hero 6 项合一）：未登录走 __zg_auth=anon 共享分片，
    //   已登录按 token 隔离（__zg_auth=<authHash>），数据零串号，且经缓存层毫秒级命中。
    p === '/api/home' ||
    // 原有：完全公共的只读内容
    p.includes('/subjects') || p.includes('/leaderboard') || p.includes('/pages') ||
    p.includes('/themes') || p.includes('/feature-flags') ||
    // 【v4.8.26 新增】低频变动的公共内容（由管理员编辑）
    p.includes('/articles') || p.includes('/notices') || p.includes('/announcements') ||
    p.includes('/guide') || p.includes('/blog') ||
    // 【v4.8.26 新增】中频业务内容（题库/知识点）
    //   注：**刻意不含** `/comments` —— `apiCacheKey()` 出于历史原因把 `/comments` 排除在外
    //   （该函数返回 null 时整个缓存段短路），两处必须保持一致；
    //   若只在这一侧加白名单，会形成「看着覆盖了、实际从未生效」的假象。
    p.includes('/knowledge-points') || p.includes('/questions') ||
    p.includes('/forum/topics')
  if (!cacheable) return null

  // ===== 【v4.8.28-fix2 修复「主题接口边缘缓存命中率被身份分片打散」】=====
  // 现象（生产实测）：`/api/themes/active` 连续 12 次请求，
  //   X-Zg-Cache 在 HIT-548s / HIT-118s / MISS / HIT-33s / HIT-523s 之间乱跳 ——
  //   同一 URL 同一时刻 age 差出 500 秒，说明边缘上**同时存在多份不同 key 的副本**。
  // 根因：这里把 `authHash` 拼进边缘缓存 URL 做「按身份隔离」。这对
  //   **返回个人数据**的接口是必要的（防越权/串数据），但对**纯站点级公共配置**
  //   是纯粹负优化 —— 站点生效主题对所有身份**完全一致**，按身份分片只会把
  //   命中率除以用户数，导致反复 MISS 回源打 D1（D1 冷查 0.8~11.8s）。
  // 修法：为**确认无任何个人字段**的公共接口豁免身份分片，全局共享一份边缘缓存。
  //   （判定统一收敛到 `isPublicSharedPath()`，与 `apiCacheKey` 共用同一份名单，
  //     避免两处各写一遍导致「看着覆盖了、实际不一致」的假象。）
  if (isPublicSharedPath(p)) return p + u.search + (u.search ? '&' : '?') + '__zg_auth=public'

  // 按身份隔离（见上方安全说明）：authHash 参与 key，杜绝跨用户串数据
  const auth = (c.req.header('authorization') || '').slice(0, 200)
  let authHash = 'anon'
  try { authHash = btoa(auth).slice(0, 24) } catch {}
  return p + u.search + (u.search ? '&' : '?') + '__zg_auth=' + authHash
}
async function edgeCacheMatch(c, edgeKey?: string) {
  try {
    const req = new Request(edgeCacheKeyToUrl(c, edgeKey), { method: 'GET' })
    const hit = await caches.default.match(req)
    if (hit && hit.status === 200) return hit
  } catch {}
  return null
}
/** 【v4.8.26】把 edgeKey 映射成一个**稳定的合成 URL**，put/match 两端必须完全一致。
 *  用固定的 `/api/__edge__/<key>` 路径而非原始 URL：
 *    · 避免原始 URL 里已带查询串时拼接位置不一致（导致 put 与 match 的 key 不同 → 永不命中）；
 *    · `/api/__edge__/` 前缀不会与任何真实路由冲突（且此 URL 仅用于 caches.default，
 *      不会真的发出请求）。 */
function edgeCacheKeyToUrl(c, edgeKey: string): string {
  const origin = new URL(c.req.url).origin
  return origin + '/api/__edge__/' + encodeURIComponent(edgeKey)
}
async function edgeCachePut(c, body, status, ttlSec, edgeKey?: string) {
  try {
    const req = new Request(edgeCacheKeyToUrl(c, edgeKey), { method: 'GET' })
    // 复制 c.res 全部响应头（含中间件2写入的 CORS），仅覆盖缓存策略与标记头
    const h = new Headers(c.res.headers)
    // 【v4.8.24】存进边缘缓存时就用**正确策略**：no-cache（浏览器每次必须校验）
    //   + s-maxage=ttlSec（CF 边缘缓存 ttlSec 秒）。
    //   原写法 `max-age=${ttlSec}, s-maxage=${ttlSec}` 会让浏览器也长期缓存，
    //   导致「增删改后点菜单重进页面 / 普通 F5」都拿不到新数据。
    // 【v4.8.26】swr 从 120 提到 ttlSec 的 50% —— 让过期后仍能先返回旧值再后台刷新，
    //   避免「刚好过期」的那次请求被用户感知为慢。上限 600s 防止过期太久。
    const swr = Math.min(600, Math.max(120, Math.floor(ttlSec / 2)))
    h.set('Cache-Control', `public, no-cache, s-maxage=${ttlSec}, stale-while-revalidate=${swr}`)
    h.set('X-Zg-Cache', 'EDGE-MISS')
    await caches.default.put(req, new Response(body, { status, headers: h }))
  } catch {}
}

// ==============================================================================
// Hono App
// ==============================================================================
let AUTO_MIGRATION_DONE = false
const app = new Hono<{ Bindings: Env; Variables: { user: { id: number; role: string } } }>()

// ===== 中间件1：从 c.env 设置全局变量 =====
app.use('*', async (c, next) => {
  D1 = c.env.DB
  JWT_SECRET = c.env.JWT_SECRET || JWT_SECRET
  JWT_EXPIRES = c.env.JWT_EXPIRES || JWT_EXPIRES
  SUPABASE_URL = c.env.SUPABASE_URL || ''
  SUPABASE_KEY = c.env.SUPABASE_SERVICE_KEY || c.env.SUPABASE_ANON_KEY || ''
  SUPABASE_BUCKET = c.env.SUPABASE_BUCKET || SUPABASE_BUCKET
  // ===== v4.4.0 B2 存储配置注入 =====
  STORAGE_BACKEND = c.env.STORAGE_BACKEND || STORAGE_BACKEND
  B2_KEY_ID = c.env.B2_KEY_ID || ''
  B2_APPLICATION_KEY = c.env.B2_APPLICATION_KEY || ''
  B2_BUCKET_ID = c.env.B2_BUCKET_ID || ''
  B2_BUCKET_NAME = c.env.B2_BUCKET_NAME || ''
  B2_ACCOUNT_ID = c.env.B2_ACCOUNT_ID || ''
  B2_QUOTA_ALERT = c.env.B2_QUOTA_ALERT || B2_QUOTA_ALERT
  B2_USER_DAILY_ORIGIN_LIMIT = c.env.B2_USER_DAILY_ORIGIN_LIMIT || B2_USER_DAILY_ORIGIN_LIMIT
  CACHE_TTL_PUBLIC = c.env.CACHE_TTL_PUBLIC || CACHE_TTL_PUBLIC
  CACHE_TTL_WEBP = c.env.CACHE_TTL_WEBP || CACHE_TTL_WEBP
  CACHE_TTL_PRIVATE = c.env.CACHE_TTL_PRIVATE || CACHE_TTL_PRIVATE
  // 【v4.13.0】AI 试卷识别注入：只在这里读一次环境变量，通道 A 的 AI 绑定单独存。
  //   后台配置存 D1、每次请求实时合并（见 aiEnv()），保证超管改完立刻生效。
  AI_BINDING = c.env.AI
  AI_ENV = {
    ZHIPU_API_KEY: c.env.ZHIPU_API_KEY,
    AI_PROVIDER: c.env.AI_PROVIDER,
    AI_MODEL_CF: c.env.AI_MODEL_CF,
    AI_MODEL_CF_FALLBACK: c.env.AI_MODEL_CF_FALLBACK,
    AI_MODEL_ZHIPU: c.env.AI_MODEL_ZHIPU,
    AI_BASE_CF: c.env.AI_BASE_CF,
    AI_BASE_ZHIPU: c.env.AI_BASE_ZHIPU,
  }
  initStorage(D1, {
    STORAGE_BACKEND, B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, B2_BUCKET_NAME, B2_ACCOUNT_ID,
    B2_QUOTA_ALERT, B2_USER_DAILY_ORIGIN_LIMIT, CACHE_TTL_PUBLIC, CACHE_TTL_WEBP, CACHE_TTL_PRIVATE,
    SUPABASE_URL, SUPABASE_KEY, SUPABASE_BUCKET,
  })
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
      // 【v4.2.0】子评论支持：parent_id 字段 + 索引
      try { await D1.prepare("ALTER TABLE article_comments ADD COLUMN parent_id INTEGER").run() } catch {}
      try { await D1.prepare("ALTER TABLE page_comments ADD COLUMN parent_id INTEGER").run() } catch {}
      // 【v4.2.1】通知跳转链接
      try { await D1.prepare("ALTER TABLE notices ADD COLUMN target_url TEXT").run() } catch {}
      try { await D1.prepare("UPDATE pages SET updated_at=created_at WHERE updated_at IS NULL OR updated_at='none'").run() } catch {}
      try { await D1.prepare('CREATE INDEX IF NOT EXISTS idx_art_c_a ON article_comments(article_id)').run() } catch {}
      // ===== v4.4.0 B2 存储相关新表（幂等自愈） =====
      await D1.prepare(`CREATE TABLE IF NOT EXISTS file_meta (
        file_id TEXT PRIMARY KEY, b2_file_id TEXT, original_name TEXT, size INTEGER, mime TEXT,
        backend TEXT DEFAULT 'b2', bucket TEXT, object_key TEXT, is_public INTEGER DEFAULT 0,
        cacheable INTEGER DEFAULT 0, purpose TEXT, is_convert_webp INTEGER DEFAULT 0,
        file_hash TEXT, uploader_id INTEGER, created_at INTEGER, updated_at INTEGER)`).run()
      await D1.prepare(`CREATE INDEX IF NOT EXISTS idx_fm_uploader ON file_meta(uploader_id)`).run()
      await D1.prepare(`CREATE INDEX IF NOT EXISTS idx_fm_purpose ON file_meta(purpose)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_quota_daily (day TEXT PRIMARY KEY, b_class_count INTEGER DEFAULT 0, last_update INTEGER)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_user_origin (day TEXT NOT NULL, user_id INTEGER NOT NULL, cnt INTEGER DEFAULT 0, PRIMARY KEY (day, user_id))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_prewarm_log (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT, operator INTEGER, status TEXT DEFAULT 'done', cost_ms INTEGER, created_at INTEGER)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_download_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, file_id TEXT, user_id INTEGER, hit INTEGER DEFAULT 0, is_range INTEGER DEFAULT 0, cost_ms INTEGER, created_at INTEGER)`).run()
      // ===== v4.4.1：C 类交易治理 / 官方容量盘点 / 全量迁移幂等 =====
      // b2_auth_cache：把 b2_authorize_account 结果落库，全球 isolate 共享，
      //   否则每个 PoP / 每次冷启动都要花 1 次 Class C（曾出现「1 次下载 = 8 次 C 类」）
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_auth_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, api_url TEXT NOT NULL,
        download_url TEXT NOT NULL, account_id TEXT, exp INTEGER NOT NULL, updated_at INTEGER)`).run()
      // b2_bucket_census：B2 官方容量盘点快照（b2_list_file_names 全量求和，每日 1 次）
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_bucket_census (day TEXT PRIMARY KEY, file_count INTEGER DEFAULT 0, total_size INTEGER DEFAULT 0, created_at INTEGER)`).run()
      // b2_migration_log：Supabase → B2 迁移日志（source_key UNIQUE，保证幂等）
      await D1.prepare(`CREATE TABLE IF NOT EXISTS b2_migration_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_backend TEXT NOT NULL DEFAULT 'supabase',
        source_key TEXT NOT NULL UNIQUE, file_id TEXT NOT NULL, size INTEGER, mime TEXT, sha1 TEXT,
        refs_updated INTEGER DEFAULT 0, status TEXT DEFAULT 'done', created_at INTEGER)`).run()
      await D1.prepare(`CREATE INDEX IF NOT EXISTS idx_b2_migration_fid ON b2_migration_log(file_id)`).run()
      try { await D1.prepare("ALTER TABLE resources ADD COLUMN file_id TEXT").run() } catch {}
      // ===== v4.4.16 博客论坛化：站级话题分类（镜像 forum_topics，去掉 subject_id 外键）=====
      await D1.prepare(`CREATE TABLE IF NOT EXISTS site_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#F59E0B',
        created_by INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now','+8 hours'))
      )`).run()
      await D1.prepare(`CREATE INDEX IF NOT EXISTS idx_site_topics_name ON site_topics(name)`).run()
      // 博客推荐语/摘要（之前论坛 recommendation 字段未落库，本次统一补齐）
      try { await D1.prepare("ALTER TABLE pages ADD COLUMN recommendation TEXT DEFAULT ''").run() } catch {}
      // ===== v4.4.24 学科榜按学科贡献排名：exp_logs 补 subject_id 列（记录经验来源学科）=====
      try { await D1.prepare("ALTER TABLE exp_logs ADD COLUMN subject_id INTEGER").run() } catch {}
      // ===== v4.5.0 智能题库：题目表/卷表补列（幂等自愈）=====
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN analysis TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN difficulty INTEGER DEFAULT 3").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN textbook_version TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN region TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN chapter TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN status TEXT DEFAULT 'active'").run() } catch {}
      // 【v4.6.0】年份 / 题源维度：与 server/db.ts 幂等自愈迁移逐字对齐（双后端同步铁律）
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN year TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE subject_questions ADD COLUMN source TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE quizzes ADD COLUMN kind TEXT DEFAULT 'exam'").run() } catch {}
      try { await D1.prepare("ALTER TABLE quizzes ADD COLUMN template TEXT DEFAULT ''").run() } catch {}
      try { await D1.prepare("ALTER TABLE quizzes ADD COLUMN export_config TEXT DEFAULT '{}'").run() } catch {}
      // v4.5.0 智能题库新表（幂等自愈，避免漏跑迁移文件）
      await D1.prepare(`CREATE TABLE IF NOT EXISTS knowledge_points (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL, parent_id INTEGER DEFAULT NULL, name TEXT NOT NULL, description TEXT DEFAULT '', sort INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','+8 hours')), FOREIGN KEY(subject_id) REFERENCES subjects(id))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS question_knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER NOT NULL, knowledge_point_id INTEGER NOT NULL, UNIQUE(question_id, knowledge_point_id), FOREIGN KEY(question_id) REFERENCES subject_questions(id) ON DELETE CASCADE, FOREIGN KEY(knowledge_point_id) REFERENCES knowledge_points(id) ON DELETE CASCADE)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS question_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, parent_id INTEGER DEFAULT NULL, sort INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','+8 hours')))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS question_favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, question_id INTEGER NOT NULL, folder_id INTEGER DEFAULT NULL, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','+8 hours')), UNIQUE(user_id, question_id))`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS question_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, question_id INTEGER NOT NULL, content TEXT NOT NULL, status TEXT DEFAULT 'open', created_at TEXT DEFAULT (datetime('now','+8 hours')), resolved_by INTEGER DEFAULT NULL, resolved_at TEXT DEFAULT NULL)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS user_subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, subject_id INTEGER NOT NULL, assigned_by INTEGER DEFAULT NULL, UNIQUE(user_id, subject_id))`).run()
      // 【v4.8.0 考试管理】与 server/db.ts 逐字对齐（双后端同步铁律）
      await D1.prepare(`CREATE TABLE IF NOT EXISTS exams (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL, title TEXT NOT NULL, type TEXT DEFAULT 'exam', level TEXT DEFAULT '', exam_date TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT (datetime('now','+8 hours')), status TEXT DEFAULT 'draft', release_password TEXT DEFAULT '', questions TEXT DEFAULT '[]', total_score INTEGER DEFAULT 0)`).run()
      await D1.prepare(`CREATE INDEX IF NOT EXISTS idx_exams_subject ON exams(subject_id)`).run()
      await D1.prepare(`CREATE TABLE IF NOT EXISTS exam_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL, student_id INTEGER NOT NULL, scores TEXT DEFAULT '{}', total INTEGER DEFAULT 0, scan_url TEXT DEFAULT '', comment TEXT DEFAULT '', graded_by INTEGER, graded_at TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')), UNIQUE(exam_id, student_id))`).run()
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
// 【v4.9.5 性能优化】原实现对**每条**带 token 的请求都同步发起 `UPDATE users SET last_active` 写操作，
//   每次认证请求都打一次 D1 写（即便 `.catch()` 未 await，运行时会等其连接/执行），徒增 D1 负载与稳态延迟。
//   ⚠️ 重要口径：**首屏偶发的 8.4s 尖刺根因是 isolate 冷启动（bundle 过大 + nodejs_compat），与 D1 写无关**
//      —— 决定性证据：完全不碰 D1 的 /__zg_health、无 token 的 /api/subjects 同样有 8.4s 尖刺（见交接文档）。
//      本改动**不直接消除冷启动 8.4s**，但可显著降低稳态 D1 压力：
//   修复：① 节流——同用户 60s 内至多更新一次（last_active 本就是粗粒度指标，秒级精度无意义）；
//        ② 用 executionCtx.waitUntil 把写操作挂到后台，**绝不阻塞本次响应**。
//   二者叠加后，绝大多数认证请求完全不碰 D1 写；偶发的后台写即便遇冷连接也只影响后台、不影响用户感知。
//   ⚠️ 用户感知的「切回首页很慢」主要由**前端**修复（homeLast 即时渲染 + 后台刷新解耦）解决，
//      使 hero 渲染与后端延迟彻底脱钩，本改动仅为后端稳态减负。
const lastActiveSeen = new Map<number, number>() // uid -> 上次落库时间戳（ms）
app.use('*', async (c, next) => {
  const authHeader = c.req.header('authorization')
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const decoded: any = jwt.verify(token, JWT_SECRET)
      if (decoded && decoded.id) {
        const uid = decoded.id as number
        const now = Date.now()
        const last = lastActiveSeen.get(uid) || 0
        if (now - last > 60_000) {
          lastActiveSeen.set(uid, now)
          const ts = datetimeNow()
          const p = run('UPDATE users SET last_active=? WHERE id=?', ts, uid)
          // 放到后台执行，绝不阻塞本次响应（冷连接慢也只影响后台）
          try { c.executionCtx?.waitUntil?.(p) } catch {}
          p.catch(() => {})
        }
      }
    } catch {}
  }
  await next()
})

// ===== 中间件4：API 短期内存缓存 + 边缘缓存（Cache API，跨实例共享）=====
app.use('*', async (c, next) => {
  maybeCleanupCache()
  const k = apiCacheKey(c)
  if (!k) {
    // 非 GET 请求（POST/PUT/PATCH/DELETE）：清除全部缓存，确保后续 GET 拿到最新数据
    if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS' && c.req.method !== 'HEAD') {
      clearAllCache()
    }
    await next()
    // 【v4.8.24】写操作**成功**后，把边缘缓存里的公共只读条目也删掉。
    //   必须放在 await next() 之后：只有请求真的成功（2xx）才值得清；
    //   放在之前清是无效的 —— 那时写还没落库，清完立刻又会被回源填充旧值。
    if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS' && c.req.method !== 'HEAD') {
      if (c.res.status >= 200 && c.res.status < 300) {
        try { await purgeEdgeCache(c) } catch {}
      }
    }
    return
  }
  // 【v4.8.24】key 格式为 `${CACHE_VERSION}|${authHash}|${ttl}|${urlKey}`。
  //   注意：**不能**再用 `k.split('|', 3)[1]` 取 ttl —— 加了版本号后段位后移，
  //   原来那种「按位置取」的写法会取到 authHash，parseInt 出 NaN，
  //   最终发出去 `max-age=NaN, s-maxage=NaN`（浏览器/CF 会忽略该头，
  //   等于缓存策略失效）。这里改为从 key 里精确提取「纯数字」那一段，
  //   对将来再增删 key 字段也免疫。
  const ttlStr = k.split('|').find(seg => /^\d+$/.test(seg))
  const ttl = parseInt(ttlStr || '15000', 10)
  const ttlSec = Math.max(0, Math.floor(ttl / 1000))
  const edgeKey = edgeCacheablePath(c)
  // 【v4.8.24｜真修「增删改后列表不刷新，手动刷新也不行」】
  //   原策略：`public, max-age=60, s-maxage=60, stale-while-revalidate=120`
  //   —— `max-age=60` 是给**浏览器**的，导致 Chromium 把响应存进磁盘缓存，
  //      60 秒内（含 swr 共 180 秒）后续请求**根本不发出去**。
  //      实测抓包（CDP Network.responseReceived）：
  //        { "url": ".../api/subjects", "fromDiskCache": true,
  //          "cc": "public, max-age=60, s-maxage=60, stale-while-revalidate" }
  //      这完美解释了用户的现象：
  //        · 增删改后列表不刷新 —— 拿的是浏览器缓存里的旧响应
  //        · **手动刷新也不行** —— 普通 F5 仍命中磁盘缓存，只有 Ctrl+Shift+R 能绕过
  //   正确策略（业界标准）：
  //        · `s-maxage` 只作用于**共享缓存（CF 边缘 / CDN）**，性能收益保留；
  //        · `no-cache` 让**浏览器每次使用前都必须向服务端校验**（配合 ETag 走 304，
  //          数据没变时依然很省流量），但**绝不复用未经校验的旧数据**。
  //          刻意不用 `max-age=0`：它语义上等价，但实测部分场景下浏览器
  //          仍会把响应留在磁盘缓存里直接复用，`no-cache` 才是「必须校验」的最强标准写法。
  //      这样「边缘省流量」和「数据不陈旧」两头都拿到。
  const ccValue = edgeKey
    ? `public, no-cache, s-maxage=${ttlSec}, stale-while-revalidate=${Math.min(600, Math.max(120, Math.floor(ttlSec / 2)))}`
    : 'private, no-cache, must-revalidate'

  // --- ① 边缘缓存命中（跨全部实例共享，毫秒级，不再打 D1）---
  if (edgeKey) {
    const hit = await edgeCacheMatch(c, edgeKey)
    if (hit) {
      // 用 c.body() + c.header() 继承中间件2写入的 CORS 头，避免跨域请求失败
      c.header('Content-Type', hit.headers.get('Content-Type') || 'application/json; charset=utf-8')
      // 【v4.8.24】这里必须用**当前**的 ccValue，而不是 `hit.headers.get('Cache-Control')`。
      //   前者是「本次请求该发的策略」，后者是「当初 put 进边缘缓存时存下的旧策略」。
      //   若沿用旧值，即使代码已改成 max-age=0，边缘老条目仍会继续把 max-age=60 发给浏览器
      //   → 浏览器继续走磁盘缓存 → 用户的「手动刷新也不行」依旧复现。
      c.header('Cache-Control', ccValue)
      const etag = hit.headers.get('ETag'); if (etag) c.header('ETag', etag)
      c.header('X-Zg-Cache', 'EDGE-HIT')
      return c.body(hit.body, 200)
    }
  }

  // --- ② 内存缓存命中（单实例）---
  const e = API_CACHE.get(k)
  if (e && e.expireAt > Date.now()) {
    const ifNm = c.req.header('if-none-match')
    if (ifNm === e.etag) {
      // 【v4.8.24】304 必须**显式带上 Cache-Control**！
      //   304 Not Modified 不带缓存指令时，浏览器会**沿用上一次响应里存的 max-age**。
      //   于是即使我们已把策略改成 max-age=0，浏览器仍按旧的 max-age=60 继续用磁盘缓存
      //   → 表现就是「改了数据，重进页面/按 F5 都还是旧的」。
      //   这里把当前策略一并发出，让浏览器立刻改用「每次回源校验」。
      c.header('Cache-Control', ccValue)
      c.header('X-Zg-Cache', 'HIT-304')
      return c.body(null, 304)
    }
    c.header('Content-Type', e.type)
    c.header('Cache-Control', ccValue)
    c.header('ETag', e.etag)
    c.header('X-Zg-Cache', `HIT-${Math.floor((e.expireAt - Date.now()) / 1000)}s`)
    return c.body(e.body)
  }
  await next()
  // 缓存响应
  try {
    if (c.res.status >= 200 && c.res.status < 300) {
      // 【v4.4.1 兜底】只缓存「文本类」响应。二进制响应一旦走 c.res.text()
      // 就会被 UTF-8 解码再编码而损坏（无效字节 → U+FFFD）。这条是最后一道保险，
      // 防止将来新增二进制路由时忘记加进 apiCacheKey() 的排除名单。
      const respCt = c.res.headers.get('Content-Type') || ''
      if (respCt && !/json|text|javascript|xml|urlencoded|utf-8/i.test(respCt)) return
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
      headers.set('Cache-Control', ccValue)
      headers.set('X-Zg-Cache', 'MISS')
      c.res = new Response(body, { status: c.res.status, headers })
      // --- ③ 写入边缘缓存（跨实例共享，覆盖冷启动/跨节点回源）---
      if (edgeKey) await edgeCachePut(c, body, c.res.status, ttlSec, edgeKey)
    }
  } catch {}
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
      'CREATE INDEX IF NOT EXISTS idx_art_c_p ON article_comments(parent_id)',
      'CREATE INDEX IF NOT EXISTS idx_page_c_p ON page_comments(parent_id)',
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
// 🔒 /file/* 站内文件路由 —— 全局双层缓存鉴权系统
// 所有文件下载/预览强制走此路由，未登录直接拦截
// 双线路兼容：旧 POST /api/resources/:id/download 自动重定向到此路由
// ==============================================================================

// GET /file/r/:id        → 下载文件（attachment）
// GET /file/r/:id/preview → 预览文件（inline）
// GET /file/raw/:key     → 直接按存储 key 获取文件（头像/图片等，需登录）
app.get('/file/r/:id', async (c) => {
  return serveFileWithCache(c, c.req.param('id'), 'download')
})
app.get('/file/r/:id/preview', async (c) => {
  return serveFileWithCache(c, c.req.param('id'), 'preview')
})
app.get('/file/raw/*', async (c) => {
  // 直接按路径获取文件（头像、文章图片等，需登录但不需资源权限校验）
  const user = await verifyFileAccess(c)
  if (!user) return c.json({ message: '请先登录' }, 401)
  const path = new URL(c.req.url).pathname.replace('/file/raw/', '')
  const key = decodeURIComponent(path)
  if (!key) return c.json({ message: '无效的文件路径' }, 400)
  const file = await downloadFile(key)
  if (!file) return c.json({ message: '文件不存在' }, 404)
  const ct = file.contentType || guessContentType(key)
  const headers: Record<string, string> = {
    'Content-Type': ct,
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'Content-Type, Content-Length',
  }
  return new Response(file.buffer, { headers })
})

// ==============================================================================
// 🔒 v4.4.0 统一文件代理路由 /api/file/:fileId（纯流式透传，禁止内存全量加载）
//   全部上传/下载/鉴权代理统一经 Worker；浏览器禁止直连 B2。
//   Content-Type/Content-Length 取自 D1(file_meta)；缓存键随鉴权上下文，禁止越权缓存私有文件。
// ==============================================================================
async function resolveFileUser(c: Context): Promise<{ id: number; role: string } | null> {
  const u = await verifyFileAccess(c)
  if (u) c.set('user', u)
  return u
}

// GET /api/file/:fileId        → 下载（attachment）
// GET /api/file/:fileId/preview → 预览（inline）
// 【v4.4.3 修复】公开文件（is_public=1：头像/封面/图片/公告/站点/Logo）免登录直出，
// 否则浏览器 <img>/CSS 背景无法带鉴权、Pages 也不代理 /api，导致所有用户上传图片裂图。
// 待审核资料（purpose=resource, is_public=0）仍强制登录。
app.get('/api/file/:fileId', async (c) => {
  const fileId = c.req.param('fileId')
  const meta = await get<any>('SELECT * FROM file_meta WHERE file_id=?', fileId)
  if (!meta) return c.json({ message: '文件不存在或已被清理' }, 404)
  let user: { id: number; role: string } | null = null
  if (!meta.is_public) {
    user = await resolveFileUser(c)
    if (!user) return c.json({ message: '请先登录后下载', needLogin: true }, 401)
  }
  let resourceCheck: any
  if (meta.purpose === 'resource') {
    resourceCheck = async () => {
      const r = await get<any>('SELECT * FROM resources WHERE file_id=?', fileId)
      // 【v4.4.13 修复】题库/练习/论坛/站内信附件经 /api/upload/file 上传后 file_meta.purpose='resource'，
      // 但并未写入 resources 表。此类"独立附件"本就属于题目/消息内容，且已通过上面的登录校验，
      // 任何已登录用户均可访问（与「站内信全员可见」一致），故不再以「资源不存在」拦截。
      if (!r) return { ok: true }
      if (r.status !== 'approved') {
        const me = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', user!.id)
        const isOwner = Number(r.user_id) === Number(user!.id)
        if (!isOwner && !(await canManageSubject(me, r.subject_id, user!.id))) {
          return { ok: false, status: 403, message: '该资料尚未通过审核' }
        }
      }
      return { ok: true }
    }
    // 【v4.4.6 BUG #1 真修】/api/file/:fileId 走 serveFileById（不经 serveFileWithCache），
    //   v4.4.4 在 serveFileWithCache 内的 waitUntil 自增从未被命中，导致资料下载次数永远是 0。
    //   现在在路由出口前 waitUntil 异步自增 resources.downloads（response 流式返回，不阻塞）。
    c.executionCtx?.waitUntil?.(
      run('UPDATE resources SET downloads = downloads + 1 WHERE file_id = ?', fileId).catch(() => {})
    )
  }
  // 【v4.4.7 BUG #3 真修】公开图片资源（头像/封面/美文/题目图片/封面）默认走 inline 预览，
  //   这样浏览器 <img src> 才能直接显示，不会触发下载。
  //   资源类资料（purpose=resource）走 attachment（需要点"下载"按钮）。
  //   即使是资源类，is_public=1 + mime 是 image/* 也走 inline（兼容老 Supabase 上传的图片直接被引用）。
  const isImageMime = /^image\//i.test(meta.mime || '')
  const defaultMode = (meta.purpose === 'resource' && !isImageMime) ? 'download' : 'preview'
  return serveFileById(c, fileId, { mode: defaultMode, resourceCheck, rangeHeader: c.req.header('Range') })
})

app.get('/api/file/:fileId/preview', async (c) => {
  const fileId = c.req.param('fileId')
  const meta = await get<any>('SELECT * FROM file_meta WHERE file_id=?', fileId)
  if (!meta) return c.json({ message: '文件不存在或已被清理' }, 404)
  let user: { id: number; role: string } | null = null
  if (!meta.is_public) {
    user = await resolveFileUser(c)
    if (!user) return c.json({ message: '请先登录后预览', needLogin: true }, 401)
  }
  let resourceCheck: any
  if (meta.purpose === 'resource') {
    resourceCheck = async () => {
      const r = await get<any>('SELECT * FROM resources WHERE file_id=?', fileId)
      // 【v4.4.13 修复】题库/练习/论坛/站内信附件经 /api/upload/file 上传后 file_meta.purpose='resource'，
      // 但并未写入 resources 表。此类"独立附件"本就属于题目/消息内容，且已通过上面的登录校验，
      // 任何已登录用户均可访问（与「站内信全员可见」一致），故不再以「资源不存在」拦截。
      if (!r) return { ok: true }
      if (r.status !== 'approved') {
        const me = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', user!.id)
        const isOwner = Number(r.user_id) === Number(user!.id)
        if (!isOwner && !(await canManageSubject(me, r.subject_id, user!.id))) {
          return { ok: false, status: 403, message: '该资料尚未通过审核' }
        }
      }
      return { ok: true }
    }
  }
  return serveFileById(c, fileId, { mode: 'preview', resourceCheck, rangeHeader: c.req.header('Range') })
})

// ==============================================================================
// 🖼️ v4.8.19 外部图片代理 /api/proxy-image?url=<encoded>
//   场景：题面里引用了**第三方外链图片**（如 i.imgs.ovh / 各类图床），
//   导出 Word 时前端需要拿到图片字节流内嵌进 docx。但：
//     1) 图床普遍不带 Access-Control-Allow-Origin → 浏览器 fetch 被 CORS 拦截
//     2) 部分图床不认浏览器 UA / Referer，直连 403
//   由 Worker 在服务端代为抓取（服务端无 CORS 限制），再原样回传给前端。
//
//   🔒 安全约束（防止被当成开放代理 / SSRF 跳板）：
//     - 仅允许 http/https 协议
//     - 仅回传 content-type: image/* 的响应
//     - 单个响应体上限 8MB
//     - 拒绝指向内网/本地地址的 URL（SSRF 防护）
//     - 仅允许已登录用户调用（复用 verifyFileAccess 的鉴权语义）
//   命中后响应带 1 天 public 缓存，避免同一题反复抓取。
// ==============================================================================
const PROXY_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 判断主机名是否指向内网 / 环回 / 链路本地，用于 SSRF 防护 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  // 纯 IPv4 字面量（含十进制/十六进制简写一律保守拦掉）
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split('.').map(Number)
    if (p.some(n => n > 255)) return true
    if (p[0] === 10) return true                       // 10.0.0.0/8
    if (p[0] === 127) return true                      // 127.0.0.0/8
    if (p[0] === 0) return true                        // 0.0.0.0/8
    if (p[0] === 169 && p[1] === 254) return true      // 169.254.0.0/16
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true  // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true      // 192.168.0.0/16
    return false
  }
  // IPv6 环回 / 链路本地 / ULA
  if (h === '[::1]' || h === '::1') return true
  if (h.startsWith('[fe80:') || h.startsWith('[fc') || h.startsWith('[fd')) return true
  return false
}

app.get('/api/proxy-image', async (c) => {
  // 仅登录用户可调用（与文件代理同一套鉴权语义）
  const user = await resolveFileUser(c)
  if (!user) return c.json({ message: '请先登录', needLogin: true }, 401)

  const raw = c.req.query('url') || ''
  const target = raw.trim()
  if (!target) return c.json({ message: '缺少 url 参数' }, 400)
  if (!/^https?:\/\//i.test(target)) return c.json({ message: '仅支持 http/https 图片地址' }, 400)

  let u: URL
  try {
    u = new URL(target)
  } catch {
    return c.json({ message: 'url 格式非法' }, 400)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return c.json({ message: '协议不支持' }, 400)
  if (isPrivateHost(u.hostname)) return c.json({ message: '该地址不被允许' }, 403)

  let r: Response
  try {
    r = await fetch(u.toString(), {
      redirect: 'follow',
      headers: {
        // 伪装成普通浏览器，绕过部分图床的 UA / Referer 防盗链
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': `${u.protocol}//${u.host}/`,
      },
    })
  } catch (e: any) {
    return c.json({ message: '抓取失败：' + String(e?.message || e) }, 502)
  }
  if (!r.ok) return c.json({ message: `源站返回 ${r.status}` }, 502)

  const ct = (r.headers.get('content-type') || '').toLowerCase()
  if (!ct.startsWith('image/')) {
    return c.json({ message: '目标不是图片（' + (ct || 'unknown') + '）' }, 400)
  }

  // 先看 Content-Length 快速拒绝，再兜底检查实际字节数
  const declared = Number(r.headers.get('content-length') || 0)
  if (declared && declared > PROXY_IMAGE_MAX_BYTES) {
    return c.json({ message: '图片过大（超过 8MB）' }, 413)
  }

  let buf: ArrayBuffer
  try {
    buf = await r.arrayBuffer()
  } catch (e: any) {
    return c.json({ message: '读取图片数据失败：' + String(e?.message || e) }, 502)
  }
  if (buf.byteLength > PROXY_IMAGE_MAX_BYTES) {
    return c.json({ message: '图片过大（超过 8MB）' }, 413)
  }
  if (buf.byteLength === 0) return c.json({ message: '图片内容为空' }, 502)

  return new Response(buf, {
    headers: {
      'Content-Type': ct,
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'X-Proxy-Source': u.host,
    },
  })
})

/** 核心文件服务函数：鉴权 → 缓存检查 → Supabase 下载 → 缓存写入 → 返回 */
async function serveFileWithCache(c: Context, resourceId: string, mode: 'download' | 'preview'): Promise<Response> {
  const t0 = Date.now()
  // ===== 第一层：JWT 登录校验 =====
  const user = await verifyFileAccess(c)
  if (!user) {
    return c.json({ message: '请先登录后下载', needLogin: true }, 401)
  }
  c.set('user', user)

  const id = parseInt(resourceId, 10)
  if (!id) return c.json({ message: '无效的资源ID' }, 400)

  // ===== 查询资源信息 =====
  const r = await get<any>('SELECT * FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '资源不存在' }, 404)

  // ===== 第二层：资源权限校验 =====
  if (r.status !== 'approved') {
    // 【v4.3.0】必须查 id，否则 canManageSubject 内 teachingSubjects(undefined) 会抛 D1_TYPE_ERROR
    const me = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', user.id)
    const isOwner = Number(r.user_id) === Number(user.id)
    if (!isOwner && !(await canManageSubject(me, r.subject_id, user.id))) {
      return c.json({ message: '该资料尚未通过审核' }, 403)
    }
  }

  if (!r.file_path) return c.json({ message: '文件不存在，可能已被清理' }, 404)

  // ===== 边缘缓存检查（仅对已审核资源启用，未审核资源不缓存） =====
  const cacheable = r.status === 'approved'
  if (cacheable) {
    // 1. 检查热点文件内存缓存
    const hotKey = `${id}:${mode}`
    hotFileCleanup()
    const hot = HOT_FILE_CACHE.get(hotKey)
    if (hot && hot.expireAt > Date.now()) {
      hot.hits++
      const filename = r.file_name || r.title || 'download'
      const encoded = encodeURIComponent(filename)
      const disposition = mode === 'preview' ? 'inline' : 'attachment'
      const headers: Record<string, string> = {
        'Content-Type': hot.contentType,
        'Content-Disposition': `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
        'Content-Length': String(hot.size),
        'Cache-Control': 'public, max-age=86400',
        'X-Zg-File-Cache': `HOT-${hot.hits}hits`,
        'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type, Content-Length',
      }
      // 异步更新下载计数（不阻塞响应）
      c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
      return new Response(hot.buffer, { headers })
    }

    // 2. 检查边缘缓存（Cache API）
    try {
      const cached = await EDGE_CACHE.match(fileCacheRequest(id, mode))
      if (cached) {
        // 从边缘缓存恢复，同时写入热点缓存
        const buffer = await cached.arrayBuffer()
        const ct = cached.headers.get('Content-Type') || 'application/octet-stream'
        if (buffer.byteLength < HOT_FILE_MAX_SIZE) {
          HOT_FILE_CACHE.set(`${id}:${mode}`, {
            buffer, contentType: ct, size: buffer.byteLength,
            expireAt: Date.now() + HOT_FILE_TTL, hits: 1,
          })
        }
        const filename = r.file_name || r.title || 'download'
        const encoded = encodeURIComponent(filename)
        const disposition = mode === 'preview' ? 'inline' : 'attachment'
        const headers = new Headers(cached.headers)
        headers.set('X-Zg-File-Cache', 'EDGE-HIT')
        headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*')
        headers.set('Access-Control-Allow-Credentials', 'true')
        headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length')
        headers.set('Content-Disposition', `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`)
        c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
        return new Response(buffer, { status: cached.status, headers })
      }
    } catch {}
  }

  // ===== 从存储下载文件（v4.4.0 兼容：新 /api/file/ 代理地址走统一流式层） =====
  // 【v4.4.4 BUG 修复】serveFileById 走的是 file_meta 路径，**不更新 resources.downloads**。
  //   之前 /api/file/{fileId} 路径下载的资料下载次数永远是 0，统计失效。
  //   修复：在分支跳转前 waitUntil 自增；下载成功后无论走哪条路都记一笔。
  c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
  if (r.file_path && r.file_path.startsWith('/api/file/')) {
    const fid = r.file_path.replace('/api/file/', '')
    return serveFileById(c, fid, { mode, resourceCheck: async () => ({ ok: true }) })
  }
  const file = await downloadFile(r.file_path)
  if (!file) return c.json({ message: '文件不存在，可能已被清理' }, 404)

  const filename = r.file_name || r.title || 'download'
  const encoded = encodeURIComponent(filename)
  const disposition = mode === 'preview' ? 'inline' : 'attachment'
  const contentType = file.contentType || guessContentType(r.file_path)
  const fileSize = file.buffer.byteLength

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `${disposition}; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Content-Length': String(fileSize),
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type, Content-Length',
  }

  // 更新下载计数
  c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))

  // ===== 写入缓存（仅对已审核资源） =====
  if (cacheable && fileSize < HOT_FILE_MAX_SIZE) {
    // 写入热点内存缓存
    HOT_FILE_CACHE.set(`${id}:${mode}`, {
      buffer: file.buffer.slice(0),
      contentType, size: fileSize,
      expireAt: Date.now() + HOT_FILE_TTL, hits: 1,
    })
    // 写入边缘缓存
    if (fileSize < 10 * 1024 * 1024) { // <10MB 入边缘缓存
      try {
        const cacheResp = new Response(file.buffer, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400, s-maxage=604800',
            'X-Zg-File-Cache': 'MISS',
          },
        })
        c.executionCtx.waitUntil(EDGE_CACHE.put(fileCacheRequest(id, mode), cacheResp))
      } catch {}
    }
  }

  headers['X-Zg-File-Cache'] = 'MISS'
  headers['X-Zg-File-Ms'] = String(Date.now() - t0)
  return new Response(file.buffer, { headers })
}

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
  // 检查今天是否已发放过登录经验（exp_change>0 才算有效发放，防止bug导致的0值记录 blocking）
  const todayLogin = await get('SELECT id FROM exp_logs WHERE user_id=? AND action_type=? AND substr(created_at,1,10)=? AND exp_change > 0 LIMIT 1', u.id, 'login', today)
  if (!todayLogin) await addExp(u.id, undefined, 'login', '每日首次登录')
  // 【v4.9.7】带 permissions 返回（超管恒 13 项），前端菜单/守卫依赖它
  return c.json({ token: signToken({ id: u.id, role: u.role }), user: withPerms(u) })
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
  return c.json({ token: signToken({ id: uid, role: 'STUDENT' }), user: withPerms(newUser) })
})

app.get('/api/auth/me', auth, async (c) => {
  const u = await get<any>('SELECT * FROM users WHERE id = ?', c.get('user').id)
  // 【v4.9.7】withPerms 保证 permissions 恒为数组，且 SUPER_ADMIN 恒为全部 key
  return c.json({ user: withPerms(u) })
})

// ==============================================================================
// ============ 用户管理 ============
// ==============================================================================
app.get('/api/users', auth, requirePerm('users'), async (c) => {
  // 以 exp_logs 聚合的真实经验值（SUM(exp_change)）为准，
  // 避免「管理员界面显示 0、排行榜显示 232」这种 users.exp 与 logs 不同步的问题
  const list = await all<any>(
    `SELECT u.*, cm.class_id,
            COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=u.id), 0) AS exp_total,
            (SELECT MAX(id) FROM exp_logs WHERE user_id=u.id) AS last_log_id
     FROM users u
     LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE role_in_class=?) cm ON u.id=cm.user_id
     ORDER BY u.id`,
    'STUDENT'
  )
  return c.json(list.map((u: any) => {
    const base = pub(u)
    // 用真实经验值覆盖 users.exp，保证管理员界面与排行榜数据源一致
    base.exp = Number(u.exp_total || 0)
    base.level = Math.floor(base.exp / 60) + 1
    base.last_log_id = u.last_log_id || null
    return base
  }))
})

// 用户搜索（@提及选择器用）：登录用户即可调用，仅返回活跃用户的最小信息
// 返回 { id, username, realName }，上限 10 条
app.get('/api/users/search', auth, async (c) => {
  const q = (c.req.query('q') || '').trim()
  if (!q) return c.json([])
  const like = `%${q.replace(/[%_]/g, ch => '\\' + ch)}%`
  const rows = await all<any>(
    `SELECT id, username, real_name FROM users
     WHERE status='active' AND (username LIKE ? OR real_name LIKE ?)
     ORDER BY
       CASE WHEN username=? THEN 0
            WHEN username LIKE ? THEN 1
            WHEN real_name=? THEN 2
            ELSE 3 END,
       id
     LIMIT 10`,
    like, like, q, `${q}%`, q
  )
  return c.json(rows.map((r: any) => ({
    id: Number(r.id),
    username: r.username,
    realName: r.real_name || r.username,
  })))
})

// 单个用户公开信息（@提及点击跳转目标用户主页用）
// 登录即可访问，仅返回 active 用户；含真实经验值（与 /api/users 一致）
// 注意：路由顺序必须放在通配 /:id 之前（不在本文件里都是查单条，这条独立无冲突）
app.get('/api/users/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id) || id <= 0) return c.json({ message: '无效的用户 ID' }, 400)
  const u = await get<any>(
    `SELECT u.*, cm.class_id,
            COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=u.id), 0) AS exp_total
     FROM users u
     LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE role_in_class=?) cm ON u.id=cm.user_id
     WHERE u.id=?`,
    'STUDENT', id
  )
  if (!u) return c.json({ message: '用户不存在' }, 404)
  if (u.status !== 'active') return c.json({ message: '用户已停用' }, 403)
  const base = pub(u)
  base.exp = Number(u.exp_total || 0)
  base.level = Math.floor(base.exp / 60) + 1
  // 不返回 username 等敏感字段给其他用户？看一眼：search 已返回 username，且 username 本就是登录名，
  // 公开主页展示 username 让别人能搜索找到你是有意义的，故保留
  return c.json(base)
})

app.post('/api/users', auth, requirePerm('users'), async (c) => {
  const { username, realName, role, email, classId, password, subjectId, permissions } = await c.req.json()
  const me = c.get('user') as any
  // 【v4.9.7】越权防护：只有超管能创建 ADMIN；管理员不得造出与自己平级/更高的账号
  const newRole = role || 'STUDENT'
  if (newRole === 'SUPER_ADMIN' && me.role !== 'SUPER_ADMIN') return c.json({ message: '无权限创建超级管理员' }, 403)
  if (newRole === 'ADMIN' && me.role !== 'SUPER_ADMIN') return c.json({ message: '仅超级管理员可创建管理员账号' }, 403)
  if (await get('SELECT id FROM users WHERE username=?', username)) return c.json({ message: '用户名已存在' }, 400)
  const hash = bcrypt.hashSync(password || '123456', 8)
  // 仅 ADMIN 落库权限；其他角色恒 NULL（降级/越权提交都无效）
  const permStr = newRole === 'ADMIN' ? JSON.stringify(parsePerms(permissions)) : null
  const r = await run(`INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id,permissions,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`, username, hash, realName, newRole, email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`, subjectId ?? null, permStr)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, classId, uid, newRole === 'TEACHER' ? 'TEACHER' : 'STUDENT')
  return c.json({ id: uid })
})

// 批量导入用户
app.post('/api/users/import', auth, requirePerm('users'), async (c) => {
  const { users } = await c.req.json() as { users: Array<{ realName: string; username: string; role: string; email?: string; password?: string; classId?: number; subjectId?: number | null }> }
  if (!Array.isArray(users) || !users.length) return c.json({ message: '未检测到用户数据' }, 400)
  const me = c.get('user') as any
  const results: { success: number; skipped: number; errors: string[] } = { success: 0, skipped: 0, errors: [] }
  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    const lineNo = i + 2
    try {
      if (!u.username || !u.realName) { results.errors.push(`第${lineNo}行：姓名和用户名不能为空`); continue }
      const existing = await get('SELECT id FROM users WHERE username=?', u.username)
      if (existing) { results.skipped++; results.errors.push(`第${lineNo}行：用户名「${u.username}」已存在，跳过`); continue }
      // 【v4.9.7】越权防护：批量导入只允许 STUDENT/TEACHER；
      //   管理员与超管必须走「新建用户」弹窗单独配置权限，避免 Excel 批量提权。
      const reqRole = u.role || 'STUDENT'
      if (reqRole === 'ADMIN' || reqRole === 'SUPER_ADMIN') {
        results.skipped++; results.errors.push(`第${lineNo}行：角色「${reqRole}」不支持批量导入，请单独创建并配置权限`)
        continue
      }
      const role = reqRole
      const hash = bcrypt.hashSync(u.password || '123456', 8)
      const email = u.email || `${u.username}@zguang.edu`
      const avatar = `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}${i}`
      const r = await run(`INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','+8 hours'))`, u.username, hash, u.realName, role, email, avatar, u.subjectId ?? null)
      const uid = Number(r.lastInsertRowid)
      if (u.classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, u.classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
      results.success++
    } catch (e: any) { results.errors.push(`第${lineNo}行：${e.message || '未知错误'}`) }
  }
  void me
  return c.json(results)
})

app.patch('/api/users/:id', auth, requirePerm('users'), async (c) => {
  const { username, realName, email, role, subjectId, classId, permissions } = await c.req.json()
  const id = c.req.param('id')
  const me = c.get('user') as any
  const u = await get<{ id: number; role: string }>('SELECT id, role FROM users WHERE id=?', id)
  if (!u) return c.json({ message: '用户不存在' }, 404)
  // ===== 【v4.9.7】越权防护 =====
  // (1) 非超管不得改动超级管理员账号（防止管理员把超管降权/封禁）
  if (u.role === 'SUPER_ADMIN' && me.role !== 'SUPER_ADMIN') {
    return c.json({ message: '无权限修改超级管理员账号' }, 403)
  }
  // (2) 任何管理员（含超管）不得在此接口改自己的角色/权限，避免自提权与自锁死
  //     （超管改自己的入口在「设置」之外，不通过本弹窗；如需变更请由另一超管操作）
  if (String(id) === String(me.id) && (role !== undefined || permissions !== undefined)) {
    return c.json({ message: '不能修改自己的角色或权限' }, 403)
  }
  // (3) 仅超管可把他人提为 SUPER_ADMIN / ADMIN；普通管理员只能改普通用户的资料
  const targetRole = role !== undefined ? role : u.role
  if ((role === 'SUPER_ADMIN' || role === 'ADMIN') && me.role !== 'SUPER_ADMIN') {
    return c.json({ message: '仅超级管理员可授予管理员身份' }, 403)
  }
  // (4) 管理员不得改动其他管理员的权限（只有超管能配置）
  if (u.role === 'ADMIN' && me.role !== 'SUPER_ADMIN' && (role !== undefined || permissions !== undefined)) {
    return c.json({ message: '仅超级管理员可配置管理员权限' }, 403)
  }

  if (username !== undefined) await run('UPDATE users SET username=? WHERE id=?', username, id)
  if (realName !== undefined) await run('UPDATE users SET real_name=? WHERE id=?', realName, id)
  if (email !== undefined) await run('UPDATE users SET email=? WHERE id=?', email, id)
  if (role !== undefined) {
    await run('UPDATE users SET role=? WHERE id=?', role, id)
    // 降级即清空：只要不是 ADMIN，权限一律置 NULL（前端/后端双保险）
    if (role !== 'ADMIN') await run('UPDATE users SET permissions=NULL WHERE id=?', id)
  }
  // 权限落库：仅当目标最终身份是 ADMIN 时才写入，否则忽略（防越权夹带）
  if (permissions !== undefined && targetRole === 'ADMIN') {
    await run('UPDATE users SET permissions=? WHERE id=?', JSON.stringify(parsePerms(permissions)), id)
  }
  if (subjectId !== undefined) await run('UPDATE users SET subject_id=? WHERE id=?', subjectId ?? null, id)
  if (classId !== undefined) {
    // 先删除该用户的 STUDENT 类型班级关联，再按新值插入（null 表示移出班级）
    await run('DELETE FROM class_members WHERE user_id=? AND role_in_class=?', id, 'STUDENT')
    if (classId) await run(`INSERT INTO class_members (class_id,user_id,role_in_class,joined_at) VALUES (?,?,?,datetime('now','+8 hours'))`, classId, id, 'STUDENT')
  }
  return c.json({ ok: true })
})

app.patch('/api/users/:id/status', auth, requirePerm('users'), async (c) => {
  const { status } = await c.req.json()
  await run('UPDATE users SET status = ? WHERE id = ?', status, c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/users/:id/reset', auth, requirePerm('users'), async (c) => {
  const { password } = await c.req.json()
  const pwd = password || '123456'
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pwd, 8), c.req.param('id'))
  return c.json({ ok: true })
})

app.post('/api/users/:id/password', auth, requirePerm('users'), async (c) => {
  const { password } = await c.req.json()
  if (!password || password.length < 4) return c.json({ message: '密码至少 4 位' }, 400)
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 8), c.req.param('id'))
  return c.json({ ok: true })
})

app.delete('/api/users/:id', auth, requirePerm('users'), async (c) => {
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

/**
 * 【v4.11.0】调整用户经验值 —— 改为"写日志"语义，不再直接覆盖 users.exp。
 *
 * 旧实现的严重缺陷：`UPDATE users SET exp=?` 只改缓存、不写日志，
 * 于是 users.exp 与 SUM(exp_logs) 永久背离，且用户管理页（读日志）与
 * 排行榜（旧版读 users.exp）会显示两个不同数字。
 *
 * 新语义：把"目标值"翻译成一条补偿日志（diff = 目标 − 当前日志和），
 * 这样调整动作本身也进入审计流水，可追溯、可回滚。
 */
app.patch('/api/users/:id/exp', auth, requirePerm('users'), async (c) => {
  const body = await c.req.json() as { exp?: number; level?: number; reason?: string }
  const id = Number(c.req.param('id'))
  if (!Number.isFinite(id)) return c.json({ message: '用户 id 非法' }, 400)

  if (body.exp !== undefined) {
    const target = Math.max(0, Math.floor(Number(body.exp)))
    if (!Number.isFinite(target)) return c.json({ message: '经验值非法' }, 400)
    const cur = (await get<{ total: number }>(
      'SELECT COALESCE(SUM(exp_change), 0) AS total FROM exp_logs WHERE user_id=?', id
    ))?.total ?? 0
    const diff = target - cur
    if (diff !== 0) {
      // 直接插日志 + 重算，不复用 addExp（addExp 会把 undefined 走规则表）
      await run(
        `INSERT INTO exp_logs (user_id,action_type,exp_change,description,subject_id,created_at)
         VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
        id, 'admin_adjust', diff, body.reason || `管理员调整经验值（${cur} → ${target}）`, null
      )
    }
    await syncUserExp(id)
  }

  // level 单独传入时：以 level 换算目标经验（每级 60 分）同样落成日志，保持可追溯
  if (body.level !== undefined && body.exp === undefined) {
    const targetLv = Math.max(1, Math.floor(Number(body.level)))
    const targetExp = (targetLv - 1) * 60
    const cur = (await get<{ total: number }>(
      'SELECT COALESCE(SUM(exp_change), 0) AS total FROM exp_logs WHERE user_id=?', id
    ))?.total ?? 0
    const diff = targetExp - cur
    if (diff !== 0) {
      await run(
        `INSERT INTO exp_logs (user_id,action_type,exp_change,description,subject_id,created_at)
         VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
        id, 'admin_adjust', diff, body.reason || `管理员调整等级（Lv.${targetLv}）`, null
      )
    }
    await syncUserExp(id)
  }

  return c.json({ ok: true })
})

// ==============================================================================
// ============ 【v4.5.0】多学科教师指派（user_subjects 多对多）============
// ==============================================================================
app.post('/api/admin/users/:id/subjects', auth, requirePerm('users'), async (c) => {
  const uid = Number(c.req.param('id'))
  const b = await c.req.json()
  const sid = Number(b.subject_id)
  if (!sid) return c.json({ message: '学科不能为空' }, 400)
  try {
    const r = await run('INSERT INTO user_subjects (user_id, subject_id, assigned_by) VALUES (?,?,?)', uid, sid, c.get('user').id)
    return c.json({ ok: true, id: Number(r.lastInsertRowid) })
  } catch {
    return c.json({ ok: true, message: '已存在' }) // UNIQUE(user_id, subject_id)
  }
})

app.delete('/api/admin/users/:id/subjects/:sid', auth, requirePerm('users'), async (c) => {
  await run('DELETE FROM user_subjects WHERE user_id=? AND subject_id=?', Number(c.req.param('id')), Number(c.req.param('sid')))
  return c.json({ ok: true })
})

app.get('/api/admin/users/:id/subjects', auth, requirePerm('users'), async (c) => {
  const rows = await all<any>('SELECT subject_id FROM user_subjects WHERE user_id=?', Number(c.req.param('id')))
  return c.json(rows.map(r => r.subject_id))
})

// 批量拉取全部 用户-学科 指派（用于后台用户列表一次性展示多学科）
app.get('/api/admin/user-subjects', auth, requirePerm('users'), async (c) => {
  const rows = await all<any>('SELECT user_id, subject_id FROM user_subjects')
  return c.json(rows)
})


app.patch('/api/profile', auth, async (c) => {
  const id = c.get('user').id
  const b = await c.req.json().catch(() => ({}))
  // 【v4.4.8 头像修复】真·部分更新：只更新前端传入的非 undefined 字段，未传字段保持原值。
  // 旧实现一次性 bind(realName,email,avatar,id)，前端 uploadAvatar 只发 {avatar} 时
  // realName/email 为 undefined → D1 拒绝 undefined 绑定 → 500「服务器内部错误」（头像抽风根因）。
  //
  // 【v4.9.7 需求①】个人中心禁止自行修改姓名：
  //   此处彻底移除 real_name 的更新分支 —— 即使手工构造请求带上 realName 也静默忽略。
  //   姓名只能由管理员在「用户管理」里改（PATCH /api/users/:id，受 requirePerm('users') 保护）。
  const fields: string[] = []
  const args: any[] = []
  if (b.email !== undefined) { fields.push('email=?'); args.push(b.email) }
  if (b.avatar !== undefined) { fields.push('avatar=?'); args.push(b.avatar) }
  if (!fields.length) {
    const u = await get<any>('SELECT * FROM users WHERE id=?', id)
    return c.json({ user: pub(u), nameLocked: true })
  }
  // 【v4.9.7 修复】原实现这里多推了一个 `fields.push('id=?')`，使 SET 子句变成
  //   `SET email=?, id=?`，而 args 只有 [email, id] —— 占位符 3 个参数 2 个，
  //   D1 静默失败 → 「个人中心改了邮箱/头像但刷新后没变」的老 bug。
  //   正确做法：id 只作为 WHERE 的参数，不进 SET。
  args.push(id)
  await run(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, ...args)
  const u = await get<any>('SELECT * FROM users WHERE id=?', id)
  return c.json({ user: pub(u), nameLocked: true })
})

// 【v4.8.6】个人中心自助改密：必须校验原密码，避免他人越权改密
app.post('/api/profile/password', auth, async (c) => {
  const id = c.get('user').id
  const b = await c.req.json().catch(() => ({}))
  const oldPassword = b.oldPassword, newPassword = b.newPassword
  if (!oldPassword || !newPassword) return c.json({ message: '请填写原密码和新密码' }, 400)
  if (String(newPassword).length < 4) return c.json({ message: '新密码至少 4 位' }, 400)
  const u = await get<any>('SELECT * FROM users WHERE id=?', id)
  if (!u) return c.json({ message: '用户不存在' }, 404)
  if (!bcrypt.compareSync(String(oldPassword), u.password_hash)) return c.json({ message: '原密码错误' }, 400)
  await run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(String(newPassword), 8), id)
  return c.json({ ok: true })
})

// ============ v4.4.0 头像上传：统一经 Worker 存储层（废除 Supabase 直传） ============
app.post('/api/upload/avatar', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  let up
  try {
    up = await doStorageUpload({ purpose: 'avatar', file, uploaderId: c.get('user').id })
  } catch (e: any) {
    return c.json({ message: '头像上传失败：' + (e.message || '存储异常') }, 500)
  }
  // 头像为公开展示内容，允许 CF 边缘缓存（提升加载速度）
  await run('UPDATE file_meta SET is_public=1, cacheable=1, updated_at=? WHERE file_id=?', Date.now(), up.fileId)
  await run('UPDATE users SET avatar=? WHERE id=?', up.url, c.get('user').id)
  return c.json({ url: up.url, fileId: up.fileId })
})

// ============ 前端直传 Supabase 的预签名 URL ============
app.post('/api/upload/presign', auth, async (c) => {
  const { fileName, contentType } = await c.req.json()
  if (!fileName) return c.json({ message: '缺少 fileName' }, 400)
  const ext = extname(fileName) || ''
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
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
  const result = await createPresignedUploadUrl(key)
  if (!result) return c.json({ fallback: true, key })
  return c.json({ signedUrl: result.signedUrl, publicUrl: result.publicUrl, key })
})

// ==============================================================================
// ============ 班级 ============
// ==============================================================================
app.get('/api/classes', auth, async (c) => c.json(await all('SELECT * FROM classes ORDER BY id')))

app.post('/api/classes', auth, requirePerm('classes'), async (c) => {
  const { name, grade, description } = await c.req.json()
  const r = await run(`INSERT INTO classes (name,grade,description,created_at) VALUES (?,?,?,datetime('now','+8 hours'))`, name, grade || '', description || '')
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/classes/:id', auth, requirePerm('classes'), async (c) => {
  const { name, grade, description } = await c.req.json()
  await run('UPDATE classes SET name=?,grade=?,description=? WHERE id=?', name, grade, description, c.req.param('id'))
  return c.json({ ok: true })
})

app.delete('/api/classes/:id', auth, requirePerm('classes'), async (c) => {
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

app.post('/api/subjects', auth, requirePerm('subjects'), async (c) => {
  const { name, slug, icon, color, description, displayOrder, modules, announcement } = await c.req.json()
  if (await get('SELECT id FROM subjects WHERE slug=?', slug)) return c.json({ message: 'slug已存在' }, 400)
  const r = await run('INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)',
    name, slug, icon || '📚', color || '#f59e0b', description || '', displayOrder || 0, JSON.stringify(modules || {}), announcement || '')
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id', auth, requirePerm('subjects'), async (c) => {
  const { name, icon, color, description, displayOrder, modules, announcement, forumAutoApproveThreshold } = await c.req.json()
  const id = c.req.param('id')
  if (name !== undefined) await run('UPDATE subjects SET name=? WHERE id=?', name, id)
  if (icon !== undefined) await run('UPDATE subjects SET icon=? WHERE id=?', icon, id)
  if (color !== undefined) await run('UPDATE subjects SET color=? WHERE id=?', color, id)
  if (description !== undefined) await run('UPDATE subjects SET description=? WHERE id=?', description, id)
  if (displayOrder !== undefined) await run('UPDATE subjects SET display_order=? WHERE id=?', displayOrder, id)
  if (modules !== undefined) await run('UPDATE subjects SET modules=? WHERE id=?', JSON.stringify(modules), id)
  if (announcement !== undefined) await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, id)
  if (forumAutoApproveThreshold !== undefined) await run('UPDATE subjects SET forum_auto_approve_threshold=? WHERE id=?', Math.max(0, Number(forumAutoApproveThreshold) || 0), id)
  return c.json({ ok: true })
})

app.delete('/api/subjects/:id', auth, requirePerm('subjects'), async (c) => {
  const id = c.req.param('id')
  await run('DELETE FROM articles WHERE subject_id=?', id)
  await run('DELETE FROM resources WHERE subject_id=?', id)
  await run('DELETE FROM subjects WHERE id=?', id)
  return c.json({ ok: true })
})

// 【v4 Bug7】学科公告 - 教师必须任教该学科才能编辑
app.patch('/api/subjects/:id/announcement', auth, requireSubjectStaff('params', 'id'), async (c) => {
  const { announcement } = await c.req.json()
  await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, c.req.param('id'))
  return c.json({ ok: true })
})

// 【v4.1.1】学科论坛配置 - 免审阈值（本学科教师 + 超管可改）
app.patch('/api/subjects/:id/forum-config', auth, requireSubjectStaff('params', 'id'), async (c) => {
  const { forumAutoApproveThreshold } = await c.req.json()
  await run('UPDATE subjects SET forum_auto_approve_threshold=? WHERE id=?',
    Math.max(0, Number(forumAutoApproveThreshold) || 0), c.req.param('id'))
  return c.json({ ok: true })
})

// 用户班级/任教
app.get('/api/me/classes', auth, async (c) => {
  const id = c.get('user').id
  const u = await get<any>('SELECT subject_id FROM users WHERE id=?', id)
  // 【v4.0.1】同时返回主学科 subjectId，前端 store 用作兜底
  return c.json({ classIds: await userClassIds(id), teachingSubjects: await teachingSubjects(id), subjectId: u?.subject_id ?? null })
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
  let mySubjectId: number | null = null
  // 【v4.0.2 Bug-跨学科读】教师在非任教学科应与普通学生一样：传任意 subjectId 都允许
  //   - 但 SQL 仍按"approved"过滤（教师在非本学科看不到他人 pending）
  //   - 教师在自己任教学科可以看到：approved 全部 + 自己的全部状态
  let teachSidList: number[] = []
  if (myRole === 'TEACHER') {
    teachSidList = await teachingSubjects(myId)
    const meRow = await get<any>('SELECT subject_id FROM users WHERE id=?', myId)
    if (meRow?.subject_id) {
      mySubjectId = meRow.subject_id
      if (!teachSidList.includes(meRow.subject_id)) teachSidList.push(meRow.subject_id)
    }
  } else if (me) {
    const meRow = await get<any>('SELECT subject_id FROM users WHERE id=?', myId)
    mySubjectId = meRow?.subject_id ?? null
  }

  const statusClauses: string[] = []
  const statusArgs: any[] = []
  const explicitStatus = typeof status === 'string' && status
  const wantAllStatus = allStatus === '1' && (myRole === 'SUPER_ADMIN' || myRole === 'TEACHER')

  if (myRole === 'SUPER_ADMIN') {
    if (explicitStatus) { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
  } else if (myRole === 'TEACHER') {
    // 教师：approved 全部返回（公开）+ 自己发的全部状态
    const parts: string[] = []
    parts.push("a.status='approved'")
    parts.push('a.user_id=?'); statusArgs.push(myId)
    if (teachSidList.length) {
      const ph = teachSidList.map(() => '?').join(',')
      parts.push(`(a.status<>'approved' AND a.subject_id IN (${ph}))`)
      statusArgs.push(...teachSidList)
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

  // 【v4.3.0】审核界面需要显示学科：补 subject_name / subject_icon
  let sql = `SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name,
    s.name AS subject_name, s.icon AS subject_icon
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    LEFT JOIN subjects s ON s.id = a.subject_id
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
app.post('/api/articles/:id/admin-confirm', auth, requirePerm('audit'), async (c) => {
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
  // 【v4 Bug3】教师发布美文时必须选自己任教的学科
  // 【v4.4.6 BUG #2 真修】前端 ArticleEditView 发的是 subject_id（下划线），旧代码读 b.subjectId（驼峰）→ undefined → D1_TYPE_ERROR
  // 【v4.4.7 BUG #2 兜底】前端可能发 subjectId: undefined（用户没选学科），或 subjectId 不是数字 → 一律兜底为 1
  const rawSubjectId = b.subjectId ?? b.subject_id
  const parsedSubjectId = Number(rawSubjectId)
  const subjectId = Number.isFinite(parsedSubjectId) && parsedSubjectId > 0 ? parsedSubjectId : 1
  if (role === 'TEACHER' && !(await canManageSubject({ id, role }, subjectId))) {
    return c.json({ message: '教师只能在自己任教的学科下发布美文' }, 403)
  }
  // 过滤 undefined 字段，避免 D1 接收到 undefined（虽然 c.req.json() 已经解析，但兜底一下）
  const safe = (v: any, def: any = null) => (v === undefined || v === null) ? def : v
  const cid = safe(b.classId ?? b.class_id, u?.class_id || 1)
  let status = 'pending'
  let actualUserId: number | null = null
  if (role === 'SUPER_ADMIN' || role === 'TEACHER') {
    if ((b.actualUserId ?? b.actual_user_id) && Number(b.actualUserId ?? b.actual_user_id) !== id) {
      actualUserId = Number(b.actualUserId ?? b.actual_user_id)
      status = 'pending_student'
    } else { status = 'approved' }
  }
  const r = await run(`INSERT INTO articles (title,content,author,source,recommendation,subject_id,user_id,class_id,cover,images,tags,category,status,actual_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    safe(b.title, ''), safe(b.content, ''), safe(b.author, u?.real_name), safe(b.source, '原创'), safe(b.recommendation, ''), subjectId, id, cid, safe(b.cover, ''), JSON.stringify(Array.isArray(b.images) ? b.images : []), JSON.stringify(Array.isArray(b.tags) ? b.tags : []), safe(b.category, ''), status, actualUserId)
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
    await addExp(expUid, undefined, 'article', `美文《${b.title}》发布`, subjectId)
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
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师审核任何美文都 500 D1_TYPE_ERROR（超管因短路掩盖，一直没暴露）
  const u = await get<any>('SELECT id, role, subject_id, permissions FROM users WHERE id=?', reviewerId)
  // 【v4.9.7】拥有 audit 权限的管理员可审核全站美文；否则退回「本学科教师」判定
  if (!hasPerm(u, 'audit') && !(await canManageSubject(u, a.subject_id, reviewerId))) return c.json({ message: '无权限审核该学科的美文' }, 403)
  await run('UPDATE articles SET status=? WHERE id=?', newStatus, id)
  if (newStatus === 'approved' && a.status !== 'approved') {
    // 审核通过后，给实际作者发放经验值奖励（防重复：检查是否已发放过）
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    // 【v4.4.28 修复】description LIKE '%title%' 在标题含 ~ + 【】 等特殊字符时触发 SQLite "LIKE or GLOB pattern too complex" 而 500。
    //   改用 INSTR(description,?)>0 等价子串匹配规避。以下 article/like/comment/query/forum/blog 经验回退同理。
    const already = await get("SELECT id FROM exp_logs WHERE user_id=? AND action_type='article' AND INSTR(description, ?) > 0", expUid, a.title)
    if (!already) {
      await addExp(expUid, undefined, 'article', `美文《${a.title}》审核通过`, a.subject_id)
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
  const myId = c.get('user').id
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师删除美文 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', myId)
  const isOwner = a.user_id === myId
  const isActualUser = a.actual_user_id && Number(a.actual_user_id) === Number(myId)
  // 允许：发布者、实际作者（代发美文的学生）、超管、对应学科教师删除
  if (!isOwner && !isActualUser && !(await canManageSubject(u, a.subject_id, myId))) return c.json({ message: '无权限删除' }, 403)
  // 删除前直接删除相关的经验值记录（美文审核通过/点赞相关/评论相关）
  const expUid = Number(a.actual_user_id) || Number(a.user_id)
  if (expUid && a.title) {
    // 删除相关经验值记录
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type IN ('article','like','comment') AND INSTR(description, ?) > 0", expUid, a.title)
    // 【v4.11.0】删除日志后按日志和全量重算缓存（幂等，避免增量回退累积误差）
    await syncUserExp(expUid)
  }
  await run('DELETE FROM article_comments WHERE article_id=?', id)
  // 统计并修正点赞数
  const likeCount = await get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM likes_map WHERE target_type='article' AND target_id=?", id)
  if (likeCount && likeCount.cnt > 0) {
    await run('UPDATE articles SET likes = MAX(0, likes - ?) WHERE id=?', likeCount.cnt, id)
  }
  await run('DELETE FROM likes_map WHERE target_type=? AND target_id=?', 'article', id)
  await run('DELETE FROM articles WHERE id=?', id)
  clearAllCache()
  return c.json({ ok: true })
})

// 【v4.2.2】编辑美文：发布者本人 / 实际作者（代发美文的学生） / 超管 / 对应学科教师 可编辑
app.patch('/api/articles/:id', auth, async (c) => {
  const u = c.get('user')
  const id = c.req.param('id')
  const a = await get<any>('SELECT id, user_id, actual_user_id, subject_id, status FROM articles WHERE id=?', id)
  if (!a) return c.json({ message: '美文不存在' }, 404)
  const isOwner = Number(a.user_id) === Number(u.id)
  const isActualUser = a.actual_user_id && Number(a.actual_user_id) === Number(u.id)
  const isManage = hasPerm(u, 'audit') || (await canManageSubject(u, a.subject_id))
  if (!isOwner && !isActualUser && !isManage) {
    return c.json({ message: '无权限编辑该美文' }, 403)
  }
  const body = await c.req.json()
  // 允许编辑的字段：title / content / author / source / recommendation / cover / images / tags / category
  const updates: string[] = []
  const args: any[] = []
  if (typeof body.title === 'string' && body.title.trim()) { updates.push('title=?'); args.push(body.title.trim()) }
  if (typeof body.content === 'string') { updates.push('content=?'); args.push(body.content) }
  if (typeof body.author === 'string') { updates.push('author=?'); args.push(body.author) }
  if (typeof body.source === 'string') { updates.push('source=?'); args.push(body.source) }
  if (typeof body.recommendation === 'string') { updates.push('recommendation=?'); args.push(body.recommendation) }
  if (typeof body.cover === 'string') { updates.push('cover=?'); args.push(body.cover) }
  if (Array.isArray(body.images)) { updates.push('images=?'); args.push(JSON.stringify(body.images)) }
  if (Array.isArray(body.tags)) { updates.push('tags=?'); args.push(JSON.stringify(body.tags)) }
  if (typeof body.category === 'string') { updates.push('category=?'); args.push(body.category) }
  if (!updates.length) return c.json({ message: '没有可更新的字段' }, 400)
  updates.push("updated_at=datetime('now','+8 hours')")
  args.push(id)
  await run(`UPDATE articles SET ${updates.join(', ')} WHERE id=?`, ...args)
  clearAllCache()
  const updated = await get<any>('SELECT * FROM articles WHERE id=?', id)
  return c.json({ ok: true, article: updated })
})

app.post('/api/articles/:id/like', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'article', id)
  if (exist) {
    // 取消点赞：直接删除点赞时的经验值记录，不添加负值
    await run('DELETE FROM likes_map WHERE id=?', exist.id)
    await run('UPDATE articles SET likes = MAX(0, likes - 1) WHERE id=?', id)
    const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', id)
    if (a) {
      const owner = Number(a.actual_user_id) || Number(a.user_id)
      // 删除点赞时的 +1 记录；INSTR 双条件等价原 LIKE '%title%获得点赞%'（标题与"获得点赞"间有《》等字符，不可拼成单串）
      await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='like' AND INSTR(description, ?) > 0 AND INSTR(description, ?) > 0", owner, a.title, '获得点赞')
    }
    return c.json({ liked: false })
  }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'article', id)
  await run('UPDATE articles SET likes = likes + 1 WHERE id=?', id)
  const a = await get<any>('SELECT user_id, actual_user_id, title, subject_id FROM articles WHERE id=?', id)
  if (a) {
    const owner = Number(a.actual_user_id) || Number(a.user_id)
    if (owner !== uid) await addExp(owner, 1, 'like', `美文《${a.title}》获得点赞`, a.subject_id)
    // 【v4.2.1】通知作者收到点赞（自己点自己不通知）
    if (owner !== uid) {
      const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
      await addNotice(owner, '美文收到点赞', `${u?.real_name || '有人'} 点赞了你的美文《${a.title}》`, 'like', `/article/${id}#comment-area`)
    }
  }
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
  const body = await c.req.json()
  const content = String(body.content || '').trim()
  if (!content) return c.json({ message: '评论内容不能为空' }, 400)
  // 【v4.2.0】子评论：parent_id 可选
  const parentId = body.parent_id != null ? Number(body.parent_id) : null
  if (parentId != null) {
    const p = await get<any>('SELECT id FROM article_comments WHERE id=? AND article_id=?', parentId, id)
    if (!p) return c.json({ message: '父评论不存在' }, 400)
  }
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(`INSERT INTO article_comments (article_id,user_id,user_name,avatar,content,parent_id,created_at) VALUES (?,?,?,?,?,?,datetime('now','+8 hours'))`,
    id, uid, u?.real_name, u?.avatar, content, parentId)
  const newCommentId = Number(r.lastInsertRowid)
  // 仅给主评论（顶级）加经验：避免回复刷经验
  if (parentId == null) {
    const a = await get<any>('SELECT user_id, actual_user_id, title, subject_id FROM articles WHERE id=?', id)
    if (a) {
      const expUid = Number(a.actual_user_id) || Number(a.user_id)
      if (expUid !== uid) await addExp(expUid, 1, 'comment', `《${a.title}》获得评论`, a.subject_id)
      // 【v4.2.1】通知作者收到评论（自己评自己不通知）
      if (expUid !== uid) {
        await addNotice(expUid, '美文收到新评论', `${u?.real_name || '有人'} 评论了你的美文《${a.title}》：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `/article/${id}#comment-${newCommentId}`)
      }
    }
  } else {
    // 【v4.2.1】子评论：通知被回复人（父评论作者）；自己回复自己不通知
    const parent = await get<any>('SELECT user_id FROM article_comments WHERE id=?', parentId)
    if (parent && Number(parent.user_id) !== uid) {
      const a = await get<any>('SELECT title FROM articles WHERE id=?', id)
      await addNotice(Number(parent.user_id), '有人回复了你的评论', `${u?.real_name || '有人'} 回复了你对《${a?.title || '美文'}》的评论：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `/article/${id}#comment-${newCommentId}`)
    }
  }
  const created_at = datetimeNow()
  return c.json({ id: newCommentId, user_id: uid, user_name: u?.real_name, avatar: u?.avatar, content, parent_id: parentId, created_at, name: u?.real_name, time: created_at, text: content })
})

// 需求9：删除美文评论（本人或超管；【v4.9.7】拥有 audit 权限的管理员可删全站评论）
app.delete('/api/articles/:id/comments/:commentId', auth, async (c) => {
  const commentId = c.req.param('commentId')
  const articleId = c.req.param('id')
  const uid = c.get('user').id
  const u = await get<any>('SELECT role, permissions FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT * FROM article_comments WHERE id=?', commentId)
  if (!comment) return c.json({ message: '评论不存在' }, 404)
  if (comment.user_id !== uid && !hasPerm(u, 'audit')) return c.json({ message: '无权限删除' }, 403)
  // 【v4.2.0】如果是主评论，回收经验（仅算自己的，不算子评论带来的重复计算）
  if (comment.parent_id == null) {
    const a = await get<any>('SELECT user_id, actual_user_id, title, subject_id FROM articles WHERE id=?', articleId)
    if (a) {
      const expUid = Number(a.actual_user_id) || Number(a.user_id)
      if (expUid !== Number(comment.user_id)) await addExp(expUid, -1, 'comment', `《${a.title}》评论被删除回收经验`, a.subject_id)
    }
  }
  // 【v4.2.0】主评论 → 连同所有子评论一起删；子评论 → 仅删自己
  if (comment.parent_id == null) {
    await run('DELETE FROM article_comments WHERE id=? OR parent_id=?', commentId, commentId)
  } else {
    await run('DELETE FROM article_comments WHERE id=?', commentId)
  }
  clearAllCache()
  return c.json({ ok: true })
})

// 需求9：删除页面评论（本人或超管）【v4.2.0】主评论连同子评论一起删
// 【v4.9.7】拥有 guide 权限的管理员（网站说明页的运营者）可删全站页面评论
app.delete('/api/pages/:id/comments/:commentId', auth, async (c) => {
  const commentId = c.req.param('commentId')
  const uid = c.get('user').id
  const u = await get<any>('SELECT role, permissions FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT * FROM page_comments WHERE id=?', commentId)
  if (!comment) return c.json({ message: '评论不存在' }, 404)
  if (comment.user_id !== uid && !hasPerm(u, 'guide')) return c.json({ message: '无权限删除' }, 403)
  if (comment.parent_id == null) {
    await run('DELETE FROM page_comments WHERE id=? OR parent_id=?', commentId, commentId)
  } else {
    await run('DELETE FROM page_comments WHERE id=?', commentId)
  }
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
  // 【v4.0.2 Bug-跨学科读】教师在非任教学科应与普通学生一样：传任意 subjectId 都允许
  //   - 但 SQL 仍按"approved"过滤（教师在非本学科看不到他人 pending）
  //   - 教师在自己任教学科可以看到：approved 全部 + 自己的全部状态
  let teachSidList: number[] = []
  if (myRole === 'TEACHER') {
    teachSidList = await teachingSubjects(myId)
    const meRow = await get<any>('SELECT subject_id FROM users WHERE id=?', myId)
    if (meRow?.subject_id && !teachSidList.includes(meRow.subject_id)) teachSidList.push(meRow.subject_id)
  }
  // 【v4.3.0】审核界面需要显示学科：补 subject_name / subject_icon
  let sql = `SELECT r.*, u.real_name AS creator_name, s.name AS subject_name, s.icon AS subject_icon
    FROM resources r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN subjects s ON s.id = r.subject_id
    WHERE 1=1`
  const args: any[] = []
  if (subjectId) { sql += ' AND r.subject_id=?'; args.push(subjectId) }
  if (mine === '1') {
    // 个人中心「我的资料」：仅本人可查自己全部状态
    if (!myId) return c.json([])
    sql += ' AND r.user_id=?'; args.push(myId)
  } else {
    // 公开列表：仅展示已通过审核的资料（教师跨学科同学生；本学科额外显示自己的全部状态）
    if (myRole === 'SUPER_ADMIN') {
      if (status) { sql += ' AND r.status=?'; args.push(status) }
    } else if (myRole === 'TEACHER') {
      if (teachSidList.length) {
        const ph = teachSidList.map(() => '?').join(',')
        sql += ` AND (r.status='approved' OR (r.user_id=? AND r.subject_id IN (${ph})))`
        args.push(myId, ...teachSidList)
      } else {
        sql += ` AND r.user_id=?`
        args.push(myId)
      }
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
  // 【v4 Bug4】教师上传资料时必须选自己任教的学科
  if (u?.role === 'TEACHER' && !(await canManageSubject({ id, role: u.role }, b.subjectId))) {
    return c.json({ message: '教师只能在自己任教的学科下上传资料' }, 403)
  }
  // 【v4 Bug1】教师/超管上传直接 approved，立刻给上传者加经验值（之前只走 status 审核路径，导致超管/教师上传没经验）
  const status = (u?.role === 'SUPER_ADMIN' || u?.role === 'TEACHER') ? 'approved' : 'pending'
  const fileId = b.fileId || parseFileId(b.filePath)
  // v4.4.3 起前端会把 /api/file/{id} 补全为绝对外链（https://api.xkzg.de5.net/api/file/{id}）写入库，
  // 这里统一归一化为相对路径 /api/file/{id}，保证下载路由判定与 file_meta 关联稳定。
  const filePath = fileId ? `/api/file/${fileId}` : (b.filePath || '')
  const r = await run(`INSERT INTO resources (subject_id,title,description,file_name,file_type,file_size,file_path,category,tags,user_id,class_id,status,file_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    b.subjectId, b.title, b.description || '', b.fileName || '', b.fileType || '', b.fileSize || 0, filePath, b.category || '', JSON.stringify(b.tags || []), id, b.classId || 1, status, fileId)
  const rid = Number(r.lastInsertRowid)
  if (status === 'approved') {
    await addExp(id, undefined, 'resource', `上传资料《${b.title}》`, b.subjectId)
    // v4.4.0 审核通过（教师/超管直传即 approved）→ 关联文件翻为公开可缓存
    if (fileId) await run('UPDATE file_meta SET is_public=1, cacheable=1, updated_at=? WHERE file_id=?', Date.now(), fileId)
  }
  return c.json({ id: rid, status })
})

app.patch('/api/resources/:id/status', auth, async (c) => {
  const id = c.req.param('id')
  const { status: newStatus } = await c.req.json()
  const r = await get<any>('SELECT title, user_id, status, subject_id, file_id, file_path FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '不存在' }, 404)
  const myId = c.get('user').id
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师审核资料 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', myId)
  if (!(await canManageSubject(u, r.subject_id, myId))) return c.json({ message: '无权限审核该学科的资料' }, 403)
  await run('UPDATE resources SET status=? WHERE id=?', newStatus, id)
  if (newStatus === 'approved' && r.status !== 'approved') {
    await addExp(r.user_id, undefined, 'resource', `资料《${r.title}》审核通过`, r.subject_id)
    await addNotice(r.user_id, '资料审核通过', `《${r.title}》已通过审核。`, 'audit')
    // v4.4.0 审核通过 → 关联文件翻为公开可缓存（兼容绝对外链形式的 file_path）
    const fid = r.file_id || parseFileId(r.file_path)
    if (fid) await run('UPDATE file_meta SET is_public=1, cacheable=1, updated_at=? WHERE file_id=?', Date.now(), fid)
  }
  return c.json({ ok: true })
})

app.delete('/api/resources/:id', auth, async (c) => {
  const id = c.req.param('id')
  // 【v4.4.25 修复】必须带 file_id —— 漏查导致 `if (r.file_id)` 恒为 false，
  //   走 file_meta（B2/Supabase）存储的新上传资料存储文件永远删不掉（与 v4.4.11 同类老问题复燃）
  const r = await get<any>('SELECT user_id, file_path, subject_id, title, status, file_id FROM resources WHERE id=?', id)
  if (!r) return c.json({ message: '不存在' }, 404)
  const myId = c.get('user').id
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师删除资料 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', myId)
  const isOwner = Number(r.user_id) === myId
  if (!isOwner && !(await canManageSubject(u, r.subject_id, myId))) return c.json({ message: '无权限删除' }, 403)
  // 【v4.4.26 修复】r.user_id 是 D1 INTEGER 列返回的 BigInt，直接绑参会抛 D1_TYPE_ERROR(500)，必须 Number()（铁律9）。
  //   r.file_id 是 TEXT 列，D1 返回的是字符串（如 'a1b2c3'）——绝不可 Number()：会变成 NaN 导致文件删除分支被跳过（孤儿文件）。
  const rUid = Number(r.user_id)
  const rFid = r.file_id != null ? r.file_id : null
  // 删除前直接删除相关的经验值记录
  if (rUid && r.title) {
    // 【v4.4.28 修复】原 `description LIKE '%title%'` 在标题含 ~ + 【】 等特殊字符时会触发 SQLite
    //   "LIKE or GLOB pattern too complex" 而 500（D1_ERROR）。改用 INSTR(description,?)>0 等价子串匹配规避。
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type IN ('resource','like') AND INSTR(description, ?) > 0", rUid, r.title)
    // 【v4.11.0】删除日志后按日志和全量重算缓存
    await syncUserExp(rUid)
  }
  // v4.4.0 删除存储文件：优先 file_meta（B2）→ legacy file_path（Supabase）
  if (rFid) {
    const m = await get<any>('SELECT * FROM file_meta WHERE file_id=?', rFid)
    if (m) {
      try { if (m.backend === 'supabase') await supaDelete(m.object_key); else await b2Delete(m.object_key, m.b2_file_id) } catch {}
      try { await run('DELETE FROM file_meta WHERE file_id=?', rFid) } catch {}
    }
  } else if (r.file_path) { try { await deleteFile(extractKey(r.file_path)) } catch {} }
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
    // 【v4.3.0 修复】必须查 id —— 漏查导致教师下载待审资料 500 D1_TYPE_ERROR
    const me = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', uid)
    const isOwner = Number(r.user_id) === Number(uid)
    if (!isOwner && !(await canManageSubject(me, r.subject_id, uid))) {
      return c.json({ message: '该资料尚未通过审核' }, 403)
    }
  }
  if (!r.file_path) return c.json({ message: '文件不存在，可能已被清理' }, 404)

  // ===== 热点缓存检查（POST 请求也走热点缓存，减少 Supabase 调用） =====
  const cacheable = r.status === 'approved'
  if (cacheable) {
    const hotKey = `${id}:download`
    hotFileCleanup()
    const hot = HOT_FILE_CACHE.get(hotKey)
    if (hot && hot.expireAt > Date.now()) {
      hot.hits++
      const filename = r.file_name || r.title || 'download'
      const encoded = encodeURIComponent(filename)
      c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
      return new Response(hot.buffer, {
        headers: {
          'Content-Type': hot.contentType,
          'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
          'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
          'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
          'Access-Control-Allow-Credentials': 'true',
          'X-Zg-File-Cache': `HOT-${hot.hits}hits`,
        },
      })
    }
  }

  // ===== 修复 BUG #1：file_path 为相对 /api/file/{id} 或前端补全的绝对外链时，
  //            统一走 serveFileById 经 B2/Supabase 取文件（v4.4.3 起库内可能存在绝对外链形式）=====
  const dlFid = parseFileId(r.file_path)
  if (dlFid) {
    const fid = dlFid
    const filename = r.file_name || r.title || 'download'
    const encoded = encodeURIComponent(filename)
    c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
    return serveFileById(c, fid, {
      mode: 'download',
      rangeHeader: c.req.header('Range'),
      resourceCheck: async () => ({ ok: true }),  // 上面已校验过权限
    }).then((resp) => {
      // 覆盖 Content-Disposition 用真实文件名
      resp.headers.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
      resp.headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*')
      resp.headers.set('Access-Control-Allow-Credentials', 'true')
      resp.headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length')
      return resp
    })
  }

  // ===== 旧路径：从 Supabase 兜底下载（legacy file_path 兼容） =====
  const file = await downloadFile(r.file_path)
  if (!file) return c.json({ message: '文件不存在，可能已被清理' }, 404)
  const filename = r.file_name || r.title || 'download'
  const encoded = encodeURIComponent(filename)
  const fileSize = file.buffer.byteLength
  const contentType = file.contentType || guessContentType(r.file_path)

  // 写入热点缓存
  if (cacheable && fileSize < HOT_FILE_MAX_SIZE) {
    HOT_FILE_CACHE.set(`${id}:download`, {
      buffer: file.buffer.slice(0),
      contentType, size: fileSize,
      expireAt: Date.now() + HOT_FILE_TTL, hits: 1,
    })
  }

  c.executionCtx.waitUntil(run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', id).catch(() => {}))
  const headers: Record<string, string> = {
    'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    'Content-Type': contentType,
    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Type',
    'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
    'Access-Control-Allow-Credentials': 'true',
    'X-Zg-File-Cache': 'MISS',
  }
  return new Response(file.buffer, { headers })
})

app.post('/api/resources/:id/like', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'resource', id)
  if (exist) {
    await run('DELETE FROM likes_map WHERE id=?', exist.id)
    await run('UPDATE resources SET likes = MAX(0, likes - 1) WHERE id=?', id)
    return c.json({ liked: false })
  }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'resource', id)
  await run('UPDATE resources SET likes = likes + 1 WHERE id=?', id)
  // 【v4.2.1】通知资源作者收到点赞
  const r = await get<any>('SELECT user_id, title FROM resources WHERE id=?', id)
  if (r && Number(r.user_id) !== uid) {
    const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    await addNotice(Number(r.user_id), '资料收到点赞', `${u?.real_name || '有人'} 点赞了你的资料《${r.title}》`, 'like', `/resource/${id}`)
  }
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
// ============ v4.4.0 资料文件上传：统一经 Worker 存储层（返回 /api/file/{fileId}） ============
app.post('/api/upload/file', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  const ext = extname(file.name)
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  let up
  try {
    up = await doStorageUpload({ purpose: 'resource', file, uploaderId: c.get('user').id, isConvertWebp: file.type === 'image/webp' })
  } catch (e: any) {
    return c.json({ message: '文件上传失败：' + (e.message || '存储异常') }, 500)
  }
  return c.json({ url: up.url, fileId: up.fileId, filePath: up.url, fileName: file.name, fileType: typeMap[ext] || 'file', fileSize: file.size })
})

// ============ v4.4.0 图片上传：统一经 Worker 存储层（前端已转 webp） ============
app.post('/api/upload/image', auth, async (c) => {
  const body = await c.req.parseBody()
  const file = body.file as File
  if (!file) return c.json({ message: '无文件' }, 400)
  let up
  try {
    up = await doStorageUpload({ purpose: 'image', file, uploaderId: c.get('user').id, isConvertWebp: file.type === 'image/webp' })
  } catch (e: any) {
    return c.json({ message: '图片上传失败：' + (e.message || '存储异常') }, 500)
  }
  // 图片为公开内容，允许 CF 边缘缓存（提升加载速度）
  await run('UPDATE file_meta SET is_public=1, cacheable=1, updated_at=? WHERE file_id=?', Date.now(), up.fileId)
  return c.json({ url: up.url, fileId: up.fileId })
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
  await addExp(uid, undefined, 'query', `完成数据查询：${t.title}`, t.subject_id)
  return c.json({
    task: { ...t, headers, show_comment: !!t.show_comment, allow_export: !!t.allow_export },
    headers: t.show_comment ? headers : headers.filter((h: string) => h !== '评语'),
    myRows,
  })
})

app.post('/api/query/tasks', auth, requireStaffOr('query'), async (c) => {
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

// 需求1：超管下载数据查询任务的原始Excel（【v4.9.7】有 query 权限的管理员同样可下载他人任务）
app.get('/api/query/tasks/:id/export', auth, requireStaffOr('query'), async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  // 【v4.9.7】拥有 query 权限的管理员（视为数据管理员）可下载全站查询任务；
  //   教师 / 超管仍按「本人创建」约束。
  const isQueryAdmin = c.get('user').role === 'ADMIN' && hasPerm(c.get('user'), 'query')
  if (!isQueryAdmin && c.get('user').role !== 'SUPER_ADMIN' && t.creator_id !== uid) {
    return c.json({ message: '无权限下载该查询任务' }, 403)
  }
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=? ORDER BY id', id)
  const headers = j(t.headers) || []
  const aoa: any[][] = [headers]
  for (const r of rows) {
    const row = j(r.data_row) || {}
    aoa.push(headers.map(h => row[h] ?? ''))
  }
  const xlsx = (XLSX as any).default || XLSX
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

app.delete('/api/query/tasks/:id', auth, requireStaffOr('query'), async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const t = await get<any>('SELECT creator_id, title FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  // 【v4.9.7】超管、或有 query 权限的管理员可删任意任务；教师只能删自己创建的
  const canAll = c.get('user').role === 'SUPER_ADMIN' || hasPerm(c.get('user'), 'query')
  if (!canAll && t.creator_id !== uid) return c.json({ message: '无权限删除' }, 403)
  // 删除前回收已发放的经验（数据查询相关）
  if (t.title) {
    const logs = await all<{ user_id: number; exp_change: number }>("SELECT user_id, exp_change FROM exp_logs WHERE action_type='query' AND INSTR(description, ?) > 0", t.title)
    const byUser = new Map<number, number>()
    for (const l of logs) { byUser.set(l.user_id, (byUser.get(l.user_id) || 0) + (l.exp_change || 0)) }
    for (const [userId] of byUser) {
      await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='query' AND INSTR(description, ?) > 0", userId, t.title)
      // 【v4.11.0】删除日志后按日志和全量重算缓存
      await syncUserExp(userId)
    }
  }
  await run('DELETE FROM query_rows WHERE task_id=?', id)
  await run('DELETE FROM query_tasks WHERE id=?', id)
  return c.json({ ok: true })
})

// 编辑查询任务（超管 / 有 query 权限的管理员 / 创建教师）
app.put('/api/query/tasks/:id', auth, requireStaffOr('query'), async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const t = await get<any>('SELECT creator_id FROM query_tasks WHERE id=?', id)
  if (!t) return c.json({ message: '不存在' }, 404)
  // 【v4.9.7】超管、或有 query 权限的管理员可编辑任意任务；教师只能编辑自己创建的
  const canAll = c.get('user').role === 'SUPER_ADMIN' || hasPerm(c.get('user'), 'query')
  if (!canAll && t.creator_id !== uid) return c.json({ message: '无权限编辑' }, 403)
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
  const queryUserId = c.req.query('userId')
  // 超管 / 有 exp_logs 权限的管理员可查看任意用户经验记录；其他用户只能查看自己的
  // 【v4.9.7】原来只看 role==='SUPER_ADMIN'，导致配了权限的管理员仍只能看自己
  const canAll = c.get('user').role === 'SUPER_ADMIN' || hasPerm(c.get('user'), 'exp_logs')
  const uid = (canAll && queryUserId) ? Number(queryUserId) : c.get('user').id
  return c.json(await all('SELECT * FROM exp_logs WHERE user_id=? ORDER BY id DESC', uid))
})

// 超管查看全员经验记录（带用户信息）
app.get('/api/exp/all-logs', auth, requirePerm('exp_logs'), async (c) => {
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

app.post('/api/exp/logs', auth, requirePerm('exp_logs'), async (c) => {
  const { userId, change, actionType, description } = await c.req.json()
  await addExp(userId, change, actionType, description)
  return c.json({ ok: true })
})

// 超管：删除单条经验记录
// 删除时会同步把 users.exp 回退并重算 level，确保排行榜与 users.exp 不脱钩
app.delete('/api/exp/logs/:id', auth, requirePerm('exp_logs'), async (c) => {
  const id = c.req.param('id')
  const log = await get<any>('SELECT user_id, exp_change FROM exp_logs WHERE id=?', id)
  if (!log) return c.json({ message: '记录不存在' }, 404)
  await run('DELETE FROM exp_logs WHERE id=?', id)
  // 【v4.11.0】删除日志后按日志和全量重算缓存（不允许出现负数）
  await syncUserExp(log.user_id)
  return c.json({ ok: true, deleted: 1 })
})

// 超管：批量删除经验记录
app.post('/api/exp/logs/batch-delete', auth, requirePerm('exp_logs'), async (c) => {
  const body = await c.req.json() as { ids?: number[] }
  const ids = Array.isArray(body?.ids) ? body.ids.filter((x: any) => Number.isFinite(Number(x))).map((x: any) => Number(x)) : []
  if (!ids.length) return c.json({ message: '未提供要删除的记录 id' }, 400)
  // 先取出所有要删除的日志所属用户，后续按用户聚合回退 users.exp
  const logs = await all<any>('SELECT user_id, exp_change FROM exp_logs WHERE id IN (' + ids.map(() => '?').join(',') + ')', ...ids)
  await run('DELETE FROM exp_logs WHERE id IN (' + ids.map(() => '?').join(',') + ')', ...ids)
  // 【v4.11.0】去重后按日志和全量重算缓存
  const userIds = Array.from(new Set(logs.map((x: any) => x.user_id)))
  await syncUserExpBatch(userIds as number[])
  return c.json({ ok: true, deleted: logs.length, affectedUsers: userIds.length })
})

app.get('/api/leaderboard', async (c) => {
  const scope = c.req.query('scope') || 'all'
  const classId = c.req.query('classId')
  const subjectId = c.req.query('subjectId')
  const period = c.req.query('period') || 'total'

  // 获取所有活跃用户基础信息
  // 【v4.11.0】不再信任 users.exp（派生缓存可能滞后），基础列表只取身份字段，
  //   经验/等级统一在下面按 exp_logs 聚合后回填，保证与「用户管理」页口径一致。
  let list = await all<any>('SELECT id,real_name,role,avatar FROM users WHERE status=?', 'active')

  // 范围过滤
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

  // 经验值聚合：学科榜按 subject_id 过滤，确保显示"用户对本学科的贡献"而非全站总经验
  const subjArg = (scope === 'subject' && subjectId) ? Number(subjectId) : null
  const subjClause = subjArg !== null ? ' AND subject_id = ?' : ''

  if (period === 'total') {
    // 总榜：从 exp_logs 聚合经验值（与周榜/月榜数据源一致，确保不会出现月榜>总榜）
    // 学科榜额外按 subject_id 过滤
    const allExps = await all<{ user_id: number; total: number }>(
      `SELECT user_id, COALESCE(SUM(exp_change), 0) as total FROM exp_logs WHERE 1=1${subjClause} GROUP BY user_id`,
      ...(subjArg !== null ? [subjArg] : [])
    )
    const expMap = new Map<number, number>()
    for (const r of allExps) expMap.set(r.user_id, r.total)
    list = list.map(u => {
      const total = Math.max(0, expMap.get(u.id) || 0)
      return { ...u, exp: total, level: Math.floor(total / 60) + 1, pe: total }
    }).sort((a, b) => b.pe - a.pe)
  } else {
    // 周榜/月榜：从 exp_logs 按时间段聚合真实经验值
    // 计算起始日期（北京时间）
    const now = new Date()
    let startDate: string
    if (period === 'week') {
      // 本周一 00:00（北京时间）
      const beijingNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
      const dayOfWeek = beijingNow.getDay() // 0=周日, 1=周一
      const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1 // 距周一的天数
      const monday = new Date(beijingNow)
      monday.setDate(beijingNow.getDate() - diff)
      monday.setHours(0, 0, 0, 0)
      startDate = monday.getFullYear() + '-' +
        String(monday.getMonth() + 1).padStart(2, '0') + '-' +
        String(monday.getDate()).padStart(2, '0')
    } else {
      // 月榜：本月1日
      const beijingNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
      startDate = beijingNow.getFullYear() + '-' +
        String(beijingNow.getMonth() + 1).padStart(2, '0') + '-01'
    }

    // 查询时间段内各用户的经验值增量（学科榜按 subject_id 过滤）
    const periodExps = await all<{ user_id: number; total: number }>(
      `SELECT user_id, COALESCE(SUM(exp_change), 0) as total FROM exp_logs WHERE substr(created_at,1,10) >= ?${subjClause} GROUP BY user_id`,
      ...(subjArg !== null ? [startDate, subjArg] : [startDate])
    )
    const expMap = new Map<number, number>()
    for (const r of periodExps) expMap.set(r.user_id, r.total)

    // 【v4.11.0】周/月榜同时给出累计经验（真源），供前端显示等级；
    //   注意：学科榜的 pe 只统计该学科贡献，累计 exp 也应按同一口径累加，
    //   因此这里用与 total 分支一致的 SUM(全时段) 查询（带同样的 subject 过滤）。
    const totalExps = await all<{ user_id: number; total: number }>(
      `SELECT user_id, COALESCE(SUM(exp_change), 0) as total FROM exp_logs WHERE 1=1${subjClause} GROUP BY user_id`,
      ...(subjArg !== null ? [subjArg] : [])
    )
    const totalMap = new Map<number, number>()
    for (const r of totalExps) totalMap.set(r.user_id, r.total)

    // 合并：用户在该时间段内获得的经验值
    list = list.map(u => {
      const total = Math.max(0, totalMap.get(u.id) || 0)
      return { ...u, exp: total, level: Math.floor(total / 60) + 1, pe: expMap.get(u.id) || 0 }
    }).sort((a, b) => b.pe - a.pe)
  }

  return c.json(list)
})

// ==============================================================================
// ============ 通知 ============
// ==============================================================================
app.get('/api/notices', auth, async (c) => {
  return c.json(await all('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC', c.get('user').id))
})

app.post('/api/notices/readAll', auth, async (c) => {
  // 【v4 Bug15】通知中心"全部已读"修复
  //   修复原因：notices 表"read"是 SQLite/D1 关键字，必须用 "read" 双引号转义；
  //   之前在某些情况下可能因为 prepared statement 解析报错（如直接 `read=1` 触发 SQL 语法错误）。
  //   改用方括号别名 + 显式 RETURNING 验证 + 把执行结果返回，方便前端调试。
  const uid = c.get('user').id
  // 1) 先查总条数/未读条数（仅用于返回值）
  const total = (await get<{ c: number }>('SELECT COUNT(*) as c FROM notices WHERE user_id=?', uid))?.c ?? 0
  const unread = (await get<{ c: number }>('SELECT COUNT(*) as c FROM notices WHERE user_id=? AND "read"=0', uid))?.c ?? 0
  // 2) 执行 UPDATE（双引号包裹 read）
  await run('UPDATE notices SET "read"=1 WHERE user_id=? AND "read"=0', uid)
  // 3) 验证：再查一次未读，应为 0
  const after = (await get<{ c: number }>('SELECT COUNT(*) as c FROM notices WHERE user_id=? AND "read"=0', uid))?.c ?? 0
  return c.json({ ok: true, total, unreadBefore: unread, unreadAfter: after })
})

app.post('/api/notices/:id/read', auth, async (c) => {
  await run('UPDATE notices SET "read"=1 WHERE id=? AND user_id=?', c.req.param('id'), c.get('user').id)
  return c.json({ ok: true })
})

app.post('/api/notices/broadcast', auth, requirePerm('dashboard'), async (c) => {
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
// 【v4.8.28 性能专项】主题列表瘦身
//   背景（生产实测）：`/api/themes` 返回 **11973 字节**、耗时 **3.1~10.4s**，
//   而调用方在任何页面都会拉到它 —— 但**唯一真正需要「全量主题列表 + 每项完整
//   config」的只有后台「界面风格编辑器」**（预设色板 + 点选载入某套配置）。
//   前台每页只需要 `activeTheme`（306 字节，走 `/api/themes/active`）。
//
//   本次改动：
//     ① 列表接口只返回**摘要**（id / name / is_active + 仅两个配色点需要的
//        config.primary / config.accent），不再吐每套主题的完整配置；
//        体积从 ~12KB 降到 ~1KB 量级，后台主题页打开更快。
//     ② 新增 `GET /api/themes/:id` 返回单个主题的**完整 config**，
//        供管理端点选某套预设时按需加载（点一次拉一次，不做全量传输）。
//
//   兼容性：列表项仍保留 `config` 字段（值为 `{primary, accent}`），
//     因此现有前端 `t.config.primary` / `t.config.accent` 的色板渲染**不受影响**。
app.get('/api/themes', async (c) => {
  const list = await all<any>('SELECT id, name, is_active, config FROM themes ORDER BY id')
  return c.json(list.map((t) => {
    const cfg = j(t.config) || {}
    // 列表只带「色板圆点」需要的两个字段 → 显著减小响应体积
    return { id: t.id, name: t.name, is_active: t.is_active, config: { primary: cfg.primary, accent: cfg.accent } }
  }))
})

// 单个主题完整配置（后台点选预设时按需加载）
//   注意：必须注册在 `app.get('/api/themes/active')` **之后**，
//   否则 'active' 会被 :id 优先匹配。故此处仅定义引用，实际注册见下方。

app.get('/api/themes/active', async (c) => {
  const t = await get<any>('SELECT * FROM themes WHERE is_active=1 LIMIT 1')
  if (!t) return c.json(null)
  return c.json({ ...t, config: j(t.config) })
})

// 【v4.8.28】注册顺序说明：上面 active 已先注册，这里 :id 才不会误吞 'active'
app.get('/api/themes/:id', async (c) => {
  const id = c.req.param('id')
  const t = await get<any>('SELECT * FROM themes WHERE id=?', id)
  if (!t) return c.json(null)
  return c.json({ ...t, config: j(t.config) })
})

app.patch('/api/themes/:id/active', auth, requirePerm('theme'), async (c) => {
  const id = c.req.param('id')
  await run('UPDATE themes SET is_active=0')
  await run('UPDATE themes SET is_active=1 WHERE id=?', id)
  return c.json({ ok: true })
})

app.put('/api/themes/:id', auth, requirePerm('theme'), async (c) => {
  const id = c.req.param('id')
  const { config, name, isActive } = await c.req.json()
  await run('UPDATE themes SET config=?, name=?, updated_at=datetime(\'now\',\'+8 hours\') WHERE id=?', JSON.stringify(config), name, id)
  if (isActive) {
    await run('UPDATE themes SET is_active=0')
    await run('UPDATE themes SET is_active=1 WHERE id=?', id)
  }
  return c.json({ ok: true })
})

app.post('/api/themes', auth, requirePerm('theme'), async (c) => {
  const { name, config, isActive } = await c.req.json()
  const r = await run('INSERT INTO themes (name,config,is_active) VALUES (?,?,?)', name, JSON.stringify(config), isActive ? 1 : 0)
  const id = Number(r.lastInsertRowid)
  if (isActive) { await run('UPDATE themes SET is_active=0'); await run('UPDATE themes SET is_active=1 WHERE id=?', id) }
  return c.json({ id })
})

app.delete('/api/themes/:id', auth, requirePerm('theme'), async (c) => {
  await run('DELETE FROM themes WHERE id=?', c.req.param('id'))
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 数据统计 ============
// ==============================================================================
// 【v4.8.27 起 / v4.9.4 扩展 / v4.9.5 性能根治】首页聚合接口 —— hero 计数指标 1 次请求
//   背景：用户反馈「① 首页 hero 6 项能不能同时高速拉取」「② 登录用户切回首页数据很慢」。
//   本接口返回 hero 所需的**计数类**指标：
//     · stats.subjects  —— 学科总数
//     · stats.articles  —— 美文总数
//     · stats.resources —— 资料总数
//     · favoritesCount  —— 当前用户收藏数（未登录为 0）
//     · loggedIn        —— 是否已登录
//   ⚠️ 经验值 / 等级 **不在本接口返回**（见下方"v4.9.5 根治"说明），改由前端 Pinia
//     `user.current`（App 启动时 /api/auth/me 加载、跨导航持久）提供，避免重复请求。
//
//   【v4.9.5 后端减负 + 前端解耦】—— 说明：
//   原实现 `parseOptionalAuth()` + `SELECT exp,level FROM users` 共 **2 次 users 表 PK 查询**，
//   使已登录 /api/home 的 D1 往返达 3~4 次。
//   ⚠️ 口径修正：**首屏偶发 8.4s 尖刺的根因是 isolate 冷启动，非 users 表查询**
//      （公开端点 /api/subjects、完全无 D1 的 /__zg_health 同样有 8.4s，见交接文档），本改动无法消除该冷启动。
//   本改动：身份**仅从 JWT 解码**（jwt.verify 纯 CPU、零 D1），彻底移除 users 表查询，
//   已登录 /api/home 的 D1 往返从 3~4 次降到 **2 次**（聚合计数 + 收藏计数），**且都不碰 users 表**，
//   显著降低稳态延迟与 D1 压力（冷启动 8.4s 仍需前端解耦 + bundle 治理根治）。
//   前端侧配合「homeLast 上次已知数据即时渲染 + api.home() 后台刷新解耦」，
//   使 hero 渲染与后端延迟脱钩：切回首页 hero 瞬时显示真实数字、永不再出 0 空档。
//   ⚠️ 口径必须与 /api/stats **完全一致**：COUNT(*) 全站总数、**不过滤 status**。
//   兼容性：`/api/stats` 与 `/api/favorites` 原路由**保持不动**，本接口仅扩展字段，旧调用方不受影响。
app.get('/api/home', async (c) => {
  // 身份仅从 JWT 解码（纯 CPU，零 D1）——避免 users 表 PK 查询的 8.4s 冷抖动。
  // ⚠️ 注意：这里刻意**不**查 users 表，因此无法校验"账号是否被禁用"，
  //   但 /api/home 只返回公开计数 + 个人收藏数，被禁用账号看到这些无安全风险；
  //   任何写操作仍走 `auth` 中间件（会实时查库校验 status）。
  const h = c.req.header('authorization')
  let uid: number | null = null
  if (h && h.startsWith('Bearer ')) {
    try {
      const dec: any = jwt.verify(h.slice(7), JWT_SECRET)
      if (dec?.id) uid = dec.id
    } catch { uid = null }
  }

  // ── 并行取数：2 条独立查询同时发出，都不碰 users 表 ──
  const [cnt, favCnt] = await Promise.all([
    // 美文数 + 资料数 + 学科数：合并为**一条** SQL
    get<any>(
      `SELECT
         (SELECT COUNT(*) FROM articles) AS articles,
         (SELECT COUNT(*) FROM resources) AS resources,
         (SELECT COUNT(*) FROM subjects) AS subjects`,
    ),
    // 收藏数：只取 COUNT，不回传全量 rows
    uid
      ? get<any>(
          `SELECT COUNT(*) AS n FROM likes_map
           WHERE user_id = ? AND target_type IN ('fav_article','fav_resource')`,
          uid,
        )
      : Promise.resolve({ n: 0 }),
  ])

  return c.json({
    stats: {
      articles: cnt?.articles || 0,
      resources: cnt?.resources || 0,
      subjects: cnt?.subjects || 0,
    },
    favoritesCount: uid ? (favCnt?.n || 0) : 0,
    // 未登录时明确告知前端，便于前端决定是否隐藏"收藏"项
    loggedIn: !!uid,
  })
})

app.get('/api/stats', auth, async (c) => {
  // 【v4.0.2】全站统计口径：教师看到的资源/美文/查询任务/题库 都是全站数量（不是只本学科），
  // 跟学生、超管一致。教师"看到本学科"的需求 走 /api/subjects/:id/* 这类带 subjectId 的端点。
  const users = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users'))!.n
  const subjects = (await get<{ n: number }>('SELECT COUNT(*) as n FROM subjects'))!.n
  const articles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles'))!.n
  const approvedArticles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles WHERE status=?', 'approved'))!.n
  const pendingArticles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles WHERE status=?', 'pending'))!.n
  const resources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources'))!.n
  const approvedResources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources WHERE status=?', 'approved'))!.n
  const pendingResources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources WHERE status=?', 'pending'))!.n
  const queryTasks = (await get<{ n: number }>('SELECT COUNT(*) as n FROM query_tasks'))!.n
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

app.put('/api/settings/exp_rules', auth, requirePerm('exp_rules'), async (c) => {
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

app.get('/api/settings/feature_flags', auth, requirePerm('feature_flags'), async (c) => {
  return c.json(await getFeatureFlags())
})

app.put('/api/settings/feature_flags', auth, requirePerm('feature_flags'), async (c) => {
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

app.put('/api/settings/site_config', auth, requirePerm('site_config'), async (c) => {
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
  // 【v4.0.2 Bug-跨学科读】教师在非任教学科应与普通学生一样：传任意 subjectId 都允许
  //   - 但 SQL 仍按"status=published 跟我有关"过滤（学生仅看自己班级 + approved；教师跨学科看 published + 自己创建的）
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
  // v4.8.1 试卷存档密码：非本学科管理者（教师/超管）访问需输入密码
  const cfg = j(q.export_config || '{}')
  const pwd = cfg?.password
  const u = c.get('user')
  const canManage = await canManageSubject(u, q.subject_id, u.id)
  if (pwd && !canManage) {
    const input = String(c.req.query('pwd') || '')
    if (input !== pwd) {
      return c.json({ locked: true, needPwd: true, title: q.title }, 403)
    }
  }
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
  // 【v4 Bug5】教师创建题库必须选自己任教的学科
  const uRole = c.get('user').role
  if (uRole === 'TEACHER' && !(await canManageSubject({ id: uid, role: uRole }, b.subjectId))) {
    return c.json({ message: '教师只能在自己任教的学科下创建题库' }, 403)
  }
  const r = await run(
    `INSERT INTO quizzes (subject_id,class_id,creator_id,creator_name,title,description,duration,valid_until,status,kind,template,export_config,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    b.subjectId, b.classId, uid, me?.real_name || '', b.title, b.description || '', b.duration || 0, b.validUntil || '', b.status || 'published', b.kind || 'exam', b.template || '', JSON.stringify(b.export_config || {})
  )
  const qid = Number(r.lastInsertRowid)
  let sort = 0
  // 【v4 Bug10 兼容模式】支持两种题源：
  //   1) b.questions 数组 → 内联（教师自编）
  //   2) b.questionIds 数组 → 从 subject_questions 选题（教师/超管从学科题库选题）
  //   3) 两者都给时，先用内联，再用题库选题（按 sort 顺序）
  const inlineQuestions: any[] = Array.isArray(b.questions) ? b.questions : []
  const pickedIds: number[] = Array.isArray(b.questionIds) ? b.questionIds.map((n: any) => Number(n)).filter(Boolean) : []
  // 校验 questionIds 必须属于同一学科
  if (pickedIds.length) {
    const ph = pickedIds.map(() => '?').join(',')
    const picked = await all<any>(`SELECT id, qtype, content, options, answer, score, attachments FROM subject_questions WHERE id IN (${ph}) AND subject_id=?`, ...pickedIds, b.subjectId)
    if (picked.length !== pickedIds.length) {
      return c.json({ message: '所选题库中有题目不属于该学科或已被删除' }, 400)
    }
    // 按原顺序插入（保持教师指定的题序）
    const orderMap = new Map(pickedIds.map((id, i) => [id, i]))
    picked.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0))
    for (const qq of picked) {
      await run(
        `INSERT INTO quiz_questions (quiz_id,qtype,content,options,answer,score,attachments,sort) VALUES (?,?,?,?,?,?,?,?)`,
        qid, qq.qtype, qq.content, typeof qq.options === 'string' ? qq.options : JSON.stringify(qq.options || []), qq.answer || '', qq.score ?? 5, typeof qq.attachments === 'string' ? qq.attachments : JSON.stringify(qq.attachments || []), sort++
      )
    }
  }
  for (const qq of inlineQuestions) {
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
  const myId = c.get('user').id
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师编辑题库 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', myId)
  if (!(await canManageSubject(u, q.subject_id, myId))) return c.json({ message: '无权限' }, 403)
  const b = await c.req.json()
  if (b.title !== undefined) await run('UPDATE quizzes SET title=? WHERE id=?', b.title, id)
  if (b.description !== undefined) await run('UPDATE quizzes SET description=? WHERE id=?', b.description, id)
  if (b.duration !== undefined) await run('UPDATE quizzes SET duration=? WHERE id=?', b.duration, id)
  if (b.validUntil !== undefined) await run('UPDATE quizzes SET valid_until=? WHERE id=?', b.validUntil, id)
  if (b.status !== undefined) await run('UPDATE quizzes SET status=? WHERE id=?', b.status, id)
  if (b.kind !== undefined) await run('UPDATE quizzes SET kind=? WHERE id=?', b.kind, id)
  if (b.template !== undefined) await run('UPDATE quizzes SET template=? WHERE id=?', b.template, id)
  if (b.export_config !== undefined) await run('UPDATE quizzes SET export_config=? WHERE id=?', JSON.stringify(b.export_config || {}), id)
  return c.json({ ok: true })
})

app.delete('/api/quizzes/:id', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', id)
  if (!q) return c.json({ message: '不存在' }, 404)
  const myId = c.get('user').id
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师删除题库 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', myId)
  if (!(await canManageSubject(u, q.subject_id, myId))) return c.json({ message: '无权限' }, 403)
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
    await addExp(uid, undefined, 'quiz_pass', `完成题库自测：${quiz.title}（得分 ${totalScore}/${maxScore}）`, quiz.subject_id)
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
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师批改试卷 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', reviewerId)
  if (!(await canManageSubject(u, quiz.subject_id, reviewerId))) return c.json({ message: '无权限批改' }, 403)
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
  await addExp(sub.user_id, undefined, 'quiz_pass', `题库《${quiz.title}》批改完成（得分 ${fullTotal}/${sub.max_score}）`, quiz.subject_id)
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
    // 【v4.3.0 修复】原 SQL 只查 subject_id，缺 id 和 role →
    // canManageSubject 内 user.role==='TEACHER' 不成立，直接 return false，教师永远无法查看考试提交
    const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', uid)
    if (!(await canManageSubject(u, quiz.subject_id, uid))) return c.json({ message: '无权限查看该考试' }, 403)
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
  // 【v4.3.0 修复】必须查 id —— 漏查导致教师查看考试报告 500 D1_TYPE_ERROR
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', uid)
  if (!(await canManageSubject(u, quiz.subject_id, uid)) && quiz.creator_id !== uid) {
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
// 【v4.0.2 Bug-跨学科读】学科题目池 - 任何登录用户都能看
//   - subject_questions 表当前没有 status 字段（D1 schema 还没加），全表已激活的题目都对外可见
//   - 后续若给题目加 status 字段，再把 SQL 改为 `AND (status='active' OR 本学科教师 OR 超管)`
app.get('/api/subjects/:id/questions', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  // 【v4.9.7】有 subjects 权限的管理员视为可管全学科
  const isStaff = hasPerm(u, 'subjects') || (u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))
  // 【v4.5.0】智能选题多维度筛选
  const q = c.req.query()
  const where: string[] = ['sq.subject_id=?']
  const args: any[] = [sid]
  if (!isStaff) where.push("sq.status='active'")           // 学生只看到已激活题目
  // 【v4.8.25 修复「父子知识点逻辑」—— 对齐组卷网】
  //   旧写法只匹配**点中的那一个节点**：
  //     `WHERE knowledge_point_id = ?`
  //   → 点「力学」（一级）时，一道挂在「牛顿第二定律」（其子节点）上的题都查不出来，
  //     侧栏却显示父节点可点，用户体验就是「点了没反应 / 知识点是空的」。
  //   组卷网的语义是**一级节点 = 其下所有二级节点的聚合**，故改为「本节点 OR 其直接子节点」。
  //   本项目知识点层级为 2 级封顶（见下方 POST/PATCH 的层级校验），
  //   因此一层 `parent_id = ?` 即可覆盖，无需递归 CTE（D1/SQLite 也更好优化）。
  if (q.knowledge_point_id) {
    const kpId = Number(q.knowledge_point_id)
    where.push(`sq.id IN (
      SELECT qk.question_id FROM question_knowledge qk
      JOIN knowledge_points kp ON kp.id = qk.knowledge_point_id
      WHERE qk.knowledge_point_id = ? OR kp.parent_id = ?
    )`)
    args.push(kpId, kpId)
  }
  if (q.qtype) { where.push('sq.qtype=?'); args.push(q.qtype) }
  if (q.difficulty) { where.push('sq.difficulty=?'); args.push(Number(q.difficulty)) }
  if (q.textbook_version) { where.push('sq.textbook_version=?'); args.push(q.textbook_version) }
  if (q.region) { where.push('sq.region=?'); args.push(q.region) }
  if (q.chapter) { where.push('sq.chapter LIKE ?'); args.push('%' + q.chapter + '%') }
  if (q.year) { where.push('sq.year=?'); args.push(q.year) }
  if (q.source) { where.push('sq.source=?'); args.push(q.source) }
  if (q.keyword) { where.push('(sq.content LIKE ? OR sq.answer LIKE ?)'); args.push('%' + q.keyword + '%', '%' + q.keyword + '%') }
  const rows = await all<any>(`SELECT sq.* FROM subject_questions sq WHERE ${where.join(' AND ')} ORDER BY sq.sort, sq.id DESC`, ...args)
  const ids = rows.map(r => r.id)
  const kpMap: Record<number, any[]> = {}
  if (ids.length) {
    const kps = await all<any>(`SELECT qk.question_id, kp.id, kp.name, kp.parent_id FROM question_knowledge qk JOIN knowledge_points kp ON kp.id=qk.knowledge_point_id WHERE qk.question_id IN (${ids.map(() => '?').join(',')})`, ...ids)
    for (const k of kps) (kpMap[k.question_id] ||= []).push({ id: k.id, name: k.name, parent_id: k.parent_id })
  }
  return c.json(rows.map(r => ({ ...r, options: j(r.options), attachments: j(r.attachments), knowledge_points: kpMap[r.id] || [] })))
})

app.get('/api/subject-questions/:id', auth, async (c) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', c.req.param('id'))
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const subj = await get<any>('SELECT id, name, slug, icon FROM subjects WHERE id=?', q.subject_id)
  const kps = await all<any>('SELECT kp.id, kp.name, kp.parent_id FROM question_knowledge qk JOIN knowledge_points kp ON kp.id=qk.knowledge_point_id WHERE qk.question_id=?', q.id)
  return c.json({ ...q, options: j(q.options), attachments: j(q.attachments), subject: subj, knowledge_points: kps })
})

// ==============================================================================
// ============ 【v4.6.0】学情分析聚合：班级成绩 / 学生分层 / 知识点掌握度 / 高频错题 =============
app.get('/api/subjects/:id/analytics', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const quizzes = await all<any>('SELECT id,title,kind FROM quizzes WHERE subject_id=? AND kind<>? ORDER BY id DESC LIMIT 100', sid, 'paper')
  const quizIds = quizzes.map((q: any) => q.id)
  const result: any = {
    examStats: { quizCount: 0, subCount: 0, avgScore: 0, maxScore: 0, minScore: 0, excellentRate: 0, passRate: 0, difficulty: 0, discrimination: 0 },
    tiers: { excellent: [], good: [], medium: [], weak: [] },
    kpMastery: [], kpCoverage: [], topWrong: [], scoreHistogram: [],
  }
  if (quizIds.length) {
    const ph = quizIds.map(() => '?').join(',')
    const subs = await all<any>(`SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id IN (${ph})`, ...quizIds)
    const graded = subs.filter((s: any) => s.total_score != null)
    if (graded.length) {
      const scores = graded.map((s: any) => Number(s.total_score) || 0)
      const maxs = graded.map((s: any) => Number(s.max_score) || 0)
      const avg = scores.reduce((a: number, b: number) => a + b, 0) / scores.length
      const maxPossible = Math.max(...maxs, 1)
      const excellent = scores.filter((s: number) => s / maxPossible >= 0.85).length
      const pass = scores.filter((s: number) => s / maxPossible >= 0.6).length
      const sorted = [...scores].sort((a: number, b: number) => a - b)
      const cut = Math.max(1, Math.floor(sorted.length * 0.27))
      const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
      const discrimination = (mean(sorted.slice(sorted.length - cut)) - mean(sorted.slice(0, cut))) / maxPossible
      result.examStats = {
        quizCount: quizzes.length, subCount: graded.length,
        avgScore: +avg.toFixed(1), maxScore: Math.max(...scores), minScore: Math.min(...scores),
        excellentRate: +((excellent / scores.length) * 100).toFixed(1),
        passRate: +((pass / scores.length) * 100).toFixed(1),
        difficulty: +(avg / maxPossible).toFixed(3), discrimination: +discrimination.toFixed(3),
      }
      const byUser: Record<number, { name: string; scores: number[]; max: number[] }> = {}
      for (const s of graded) {
        const uid = s.user_id; (byUser[uid] ||= { name: s.real_name || ('用户' + uid), scores: [], max: [] })
        byUser[uid].scores.push(Number(s.total_score) || 0); byUser[uid].max.push(Number(s.max_score) || maxPossible)
      }
      const users = Object.entries(byUser).map(([uid, v]) => {
        const avgU = v.scores.reduce((a, b) => a + b, 0) / v.scores.length
        const rate = avgU / Math.max(...v.max, 1)
        return { uid: Number(uid), name: v.name, avg: +avgU.toFixed(1), rate: +rate.toFixed(3) }
      })
      for (const u of [...users].sort((a, b) => b.avg - a.avg)) {
        if (u.rate >= 0.85) result.tiers.excellent.push(u)
        else if (u.rate >= 0.7) result.tiers.good.push(u)
        else if (u.rate >= 0.6) result.tiers.medium.push(u)
        else result.tiers.weak.push(u)
      }
      const hist: Record<number, number> = {}
      for (const s of scores) { const b = Math.floor(s / 10) * 10; hist[b] = (hist[b] || 0) + 1 }
      result.scoreHistogram = Object.entries(hist).map(([k, v]) => ({ range: Number(k), count: v })).sort((a, b) => a.range - b.range)
    }
  }
  const mastery = await all<any>(`
    SELECT kp.id AS kpId, kp.name AS kpName, kp.parent_id,
      COUNT(DISTINCT ps.id) AS tries, SUM(CASE WHEN ps.correct=1 THEN 1 ELSE 0 END) AS correct
    FROM subject_questions sq
    JOIN question_knowledge qk ON qk.question_id=sq.id
    JOIN knowledge_points kp ON kp.id=qk.knowledge_point_id
    LEFT JOIN practice_submissions ps ON ps.question_id=sq.id
    WHERE sq.subject_id=?
    GROUP BY kp.id, kp.name, kp.parent_id
    ORDER BY correct*1.0/NULLIF(COUNT(DISTINCT ps.id),0) ASC
  `, sid)
  result.kpMastery = mastery.map((m: any) => ({
    kpId: m.kpId, kpName: m.kpName, parentId: m.parent_id,
    tries: Number(m.tries) || 0, correct: Number(m.correct) || 0,
    rate: m.tries ? +((Number(m.correct) / Number(m.tries)) * 100).toFixed(1) : null,
  }))
  const cov = await all<any>(`
    SELECT kp.id AS kpId, kp.name AS kpName, kp.parent_id, COUNT(sq.id) AS count
    FROM knowledge_points kp
    LEFT JOIN question_knowledge qk ON qk.knowledge_point_id=kp.id
    LEFT JOIN subject_questions sq ON sq.id=qk.question_id AND sq.subject_id=?
    WHERE kp.subject_id=?
    GROUP BY kp.id, kp.name, kp.parent_id
  `, sid, sid)
  result.kpCoverage = cov.map((c: any) => ({ kpId: c.kpId, kpName: c.kpName, parentId: c.parent_id, count: Number(c.count) || 0 }))
  const wrong = await all<any>(`
    SELECT sq.id, sq.content, sq.qtype, sq.difficulty, kp.name AS kpName,
      COUNT(ps.id) AS tries, SUM(CASE WHEN ps.correct=0 THEN 1 ELSE 0 END) AS wrongs
    FROM practice_submissions ps
    JOIN subject_questions sq ON sq.id=ps.question_id
    LEFT JOIN question_knowledge qk ON qk.question_id=sq.id
    LEFT JOIN knowledge_points kp ON kp.id=qk.knowledge_point_id
    WHERE sq.subject_id=?
    GROUP BY sq.id, sq.content, sq.qtype, sq.difficulty, kp.name
    HAVING wrongs > 0
    ORDER BY wrongs DESC, tries DESC LIMIT 10
  `, sid)
  result.topWrong = wrong.map((w: any) => ({
    id: w.id, content: w.content, qtype: w.qtype, difficulty: w.difficulty, kpName: w.kpName,
    tries: Number(w.tries) || 0, wrongs: Number(w.wrongs) || 0,
    wrongRate: w.tries ? +((Number(w.wrongs) / Number(w.tries)) * 100).toFixed(1) : 0,
  }))
  return c.json(result)
})

// ==============================================================================
// ============ 【v4.8.0】考试管理：创建 / 列表 / 详情 / 网阅 / 成绩发布 =============
// 免费实现：创建考试、答题卡模板（前端渲染）、教师上传扫描件+在线打分、成绩发布密码门
// ==============================================================================
app.post('/api/subjects/:id/exams', auth, requireSubjectStaff('params', 'id'), async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  const b = await c.req.json()
  if (!b.title?.trim()) return c.json({ message: '考试标题不能为空' }, 400)
  if (!Array.isArray(b.questions) || !b.questions.length) return c.json({ message: '请至少选择一道题' }, 400)
  const total = b.questions.reduce((a: number, q: any) => a + (Number(q.score) || 0), 0)
  const r = await run(`INSERT INTO exams (subject_id,title,type,level,exam_date,created_by,status,release_password,questions,total_score)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    sid, b.title.trim().slice(0, 80), b.type || 'exam', b.level || '', b.exam_date || '', u.id, 'draft', b.release_password || '', JSON.stringify(b.questions), total)
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.get('/api/subjects/:id/exams', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const rows = await all<any>('SELECT e.*, u.real_name AS creator_name FROM exams e LEFT JOIN users u ON e.created_by=u.id WHERE e.subject_id=? ORDER BY e.id DESC', sid)
  return c.json(rows.map((e: any) => ({ ...e, questions: j(e.questions) || [], total_score: Number(e.total_score) || 0 })))
})

app.get('/api/exams/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const e = await get<any>('SELECT * FROM exams WHERE id=?', id)
  if (!e) return c.json({ message: '考试不存在' }, 404)
  const qs: any[] = j(e.questions) || []
  let full: any[] = []
  if (qs.length) {
    const ids = qs.map((q) => q.id)
    const ph = ids.map(() => '?').join(',')
    const recs = await all<any>(`SELECT * FROM subject_questions WHERE id IN (${ph})`, ...ids)
    const byId: Record<number, any> = {}
    for (const r of recs) byId[r.id] = r
    full = qs.map((q) => {
      const r = byId[q.id]
      return r ? { ...r, options: j(r.options), attachments: j(r.attachments), score: Number(q.score) || Number(r.score) || 0 } : null
    }).filter(Boolean)
  }
  return c.json({ ...e, questions: full, total_score: Number(e.total_score) || 0 })
})

app.patch('/api/exams/:id', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  await run(`UPDATE exams SET title=COALESCE(?,title), type=COALESCE(?,type), level=COALESCE(?,level), exam_date=COALESCE(?,exam_date),
    status=COALESCE(?,status), release_password=COALESCE(?,release_password) WHERE id=?`,
    b.title?.trim() || null, b.type || null, b.level ?? null, b.exam_date ?? null, b.status || null, b.release_password ?? null, id)
  return c.json({ ok: true })
})

app.delete('/api/exams/:id', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  await run('DELETE FROM exam_responses WHERE exam_id=?', id)
  await run('DELETE FROM exams WHERE id=?', id)
  return c.json({ ok: true })
})

app.post('/api/exams/:id/responses', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const u = c.get('user') as any
  const b = await c.req.json()
  if (!b.student_id) return c.json({ message: '请指定学生' }, 400)
  const scores = b.scores && typeof b.scores === 'object' ? b.scores : {}
  const total = Object.values(scores).reduce((a: number, v: any) => a + (Number(v) || 0), 0)
  const existing = await get<any>('SELECT id FROM exam_responses WHERE exam_id=? AND student_id=?', id, Number(b.student_id))
  if (existing) {
    await run('UPDATE exam_responses SET scores=?, total=?, scan_url=COALESCE(?,scan_url), comment=COALESCE(?,comment), graded_by=?, graded_at=datetime(\'now\',\'+8 hours\') WHERE id=?',
      JSON.stringify(scores), total, b.scan_url ?? null, b.comment ?? null, u.id, existing.id)
  } else {
    await run('INSERT INTO exam_responses (exam_id,student_id,scores,total,scan_url,comment,graded_by,graded_at) VALUES (?,?,?,?,?,?,?,datetime(\'now\',\'+8 hours\'))',
      id, Number(b.student_id), JSON.stringify(scores), total, b.scan_url || '', b.comment || '', u.id)
  }
  return c.json({ ok: true, total })
})

app.get('/api/exams/:id/responses', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const rows = await all<any>(`SELECT r.*, u.real_name AS student_name, u.username AS student_no
    FROM exam_responses r LEFT JOIN users u ON r.student_id=u.id WHERE r.exam_id=? ORDER BY r.total DESC`, id)
  return c.json(rows.map((r: any) => ({ ...r, scores: j(r.scores) || {}, total: Number(r.total) || 0 })))
})

app.get('/api/exams/:id/my', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const u = c.get('user') as any
  const e = await get<any>('SELECT * FROM exams WHERE id=?', id)
  if (!e) return c.json({ message: '考试不存在' }, 404)
  if (e.status !== 'published') return c.json({ message: '成绩尚未发布', released: false }, 403)
  if (e.release_password && e.release_password !== (c.req.query('pwd') || '')) {
    return c.json({ message: '请输入正确的成绩查询密码', needPwd: true, released: false }, 403)
  }
  const r = await get<any>('SELECT * FROM exam_responses WHERE exam_id=? AND student_id=?', id, u.id)
  return c.json({ released: true, total_score: e.total_score, response: r ? { ...r, scores: j(r.scores) || {}, total: Number(r.total) || 0 } : null })
})

// 学科学生名册（供教师网阅打分选择学生）
app.get('/api/subjects/:id/students', auth, async (c) => {
  const rows = await all<any>('SELECT id, real_name, username FROM users WHERE role=? ORDER BY real_name', 'STUDENT')
  return c.json(rows)
})

// 历次考试纵向对比（平均分 / 人数随时间）
app.get('/api/subjects/:id/exam-trend', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const exams = await all<any>('SELECT id, title, exam_date, status, total_score FROM exams WHERE subject_id=? ORDER BY id ASC', sid)
  const out: any[] = []
  for (const e of exams) {
    const subs = await all<any>('SELECT total FROM exam_responses WHERE exam_id=?', e.id)
    const vals = subs.map((s: any) => Number(s.total) || 0)
    const avg = vals.length ? +(vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toFixed(1) : 0
    out.push({ id: e.id, title: e.title, date: e.exam_date, status: e.status, total: Number(e.total_score) || 0, avg, count: vals.length })
  }
  return c.json(out)
})

// ============ 【v4.1.0】学科论坛：话题标签 + 帖子 + 评论 =============
// ==============================================================================
// 设计：
//   - 论坛帖子复用 pages 表（ptype='forum', subject_id=非NULL）
//   - 话题标签独立表 forum_topics
//   - 评论复用 page_comments
//   - 权限：跨学科教师/学生 = 学生权限（只读 approved）；本学科教师 = 全部

// ---- 话题标签 ----
app.get('/api/subjects/:id/forum/topics', auth, async (c) => {
  const list = await all<any>('SELECT t.*, u.real_name AS creator_name FROM forum_topics t LEFT JOIN users u ON t.created_by=u.id WHERE t.subject_id=? ORDER BY t.id ASC', c.req.param('id'))
  return c.json(list)
})

app.post('/api/subjects/:id/forum/topics', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return c.json({ message: '只有超管和本学科教师可以创建话题标签' }, 403)
  }
  const b = await c.req.json()
  if (!b.name?.trim()) return c.json({ message: '话题名不能为空' }, 400)
  const r = await run(`INSERT INTO forum_topics (subject_id, name, color, created_by) VALUES (?,?,?,?)`,
    sid, b.name.trim().slice(0, 20), b.color || '#F59E0B', u.id)
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id/forum/topics/:tid', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const tid = Number(c.req.param('tid'))
  const u = c.get('user') as any
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return c.json({ message: '只有超管和本学科教师可以编辑话题标签' }, 403)
  }
  const b = await c.req.json()
  await run('UPDATE forum_topics SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND subject_id=?',
    b.name?.trim() || null, b.color || null, tid, sid)
  return c.json({ ok: true })
})

app.delete('/api/subjects/:id/forum/topics/:tid', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const tid = Number(c.req.param('tid'))
  const u = c.get('user') as any
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return c.json({ message: '只有超管和本学科教师可以删除话题标签' }, 403)
  }
  await run('DELETE FROM forum_topics WHERE id=? AND subject_id=?', tid, sid)
  return c.json({ ok: true })
})

// ---- 论坛帖子 ----
// 列帖子：跨学科教师/学生 = approved + 自己的；本学科教师/超管 = 全部
app.get('/api/subjects/:id/forum/posts', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const topicId = c.req.query('topicId')
  const u = c.get('user') as any
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  let sql = `SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar
    FROM pages p LEFT JOIN users u ON p.author_id=u.id
    WHERE p.subject_id=? AND p.ptype='forum'`
  const args: any[] = [sid]
  if (topicId) {
    const t = Number(topicId)
    sql += ' AND (p.topic_ids LIKE ? OR p.topic_ids LIKE ? OR p.topic_ids LIKE ? OR p.topic_ids LIKE ?)'
    args.push(`[${t},%`, `%,${t},%`, `%,${t}]`, `[${t}]`)
  }
  if (!isSuper && !isStaff) {
    sql += " AND (p.status='published' OR p.author_id=?)"
    args.push(u.id)
  }
  sql += ' ORDER BY p.pinned DESC, p.id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map((p: any) => ({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })))
})

// 详情：未发布 + 不是作者 = 404
app.get('/api/subjects/:id/forum/posts/:pid', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const pid = Number(c.req.param('pid'))
  const u = c.get('user') as any
  const p = await get<any>("SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar FROM pages p LEFT JOIN users u ON p.author_id=u.id WHERE p.id=? AND p.subject_id=? AND p.ptype='forum'", pid, sid)
  if (!p) return c.json({ message: '帖子不存在' }, 404)
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  if (p.status !== 'published' && !isSuper && !isStaff && p.author_id !== u.id) {
    return c.json({ message: '无权限' }, 403)
  }
  await run('UPDATE pages SET views = views + 1 WHERE id=?', pid)
  return c.json({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids), views: p.views + 1 })
})

// 发帖：
//   - 超管/本学科教师 = 直接 published
//   - 学生/跨学科教师：
//       若 subjects.forum_auto_approve_threshold > 0 且 纯文本字数 ≤ 阈值 → published（免审）
//       否则 → pending
app.post('/api/subjects/:id/forum/posts', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  const b = await c.req.json()
  if (!b.title?.trim()) return c.json({ message: '标题不能为空' }, 400)
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', u.id)
  const topicIds = JSON.stringify(Array.isArray(b.topicIds) ? b.topicIds.map(Number).filter(Boolean) : [])
  let status = (isSuper || isStaff) ? 'published' : 'pending'
  let autoApproved = false
  if (status === 'pending') {
    const sub = await get<any>('SELECT forum_auto_approve_threshold FROM subjects WHERE id=?', sid)
    const threshold = Number(sub?.forum_auto_approve_threshold || 0)
    if (threshold > 0) {
      // 纯文本长度（去掉 HTML 标签 + 空白）
      const plain = String(b.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length
      if (plain > 0 && plain <= threshold) {
        status = 'published'
        autoApproved = true
      }
    }
  }
  const r = await run(
    `INSERT INTO pages (ptype, scope, class_id, title, content, cover, images, attachments, author_id, author_name, status, views, likes, pinned, subject_id, topic_ids)
     VALUES ('forum','public',0,?,?,?,?,?,?,?,?,0,0,0,?,?)`,
    b.title.trim().slice(0, 100), b.content || '', b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.attachments || []),
    u.id, me?.real_name || '', status, sid, topicIds
  )
  const pid = Number(r.lastInsertRowid)
  // 教师/超管直接发布 → 发放经验
  if ((isSuper || isStaff) && status === 'published') {
    try { await addExp(u.id, undefined, 'forum_post', `论坛帖子《${b.title}》发布`, sid) } catch {}
  }
  return c.json({ id: pid, status, autoApproved })
})

// 编辑：作者本人 + 超管 + 本学科教师
app.patch('/api/subjects/:id/forum/posts/:pid', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const pid = Number(c.req.param('pid'))
  const u = c.get('user') as any
  const p = await get<any>("SELECT * FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return c.json({ message: '帖子不存在' }, 404)
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  if (!isSuper && !isStaff && p.author_id !== u.id) return c.json({ message: '无权编辑' }, 403)
  const b = await c.req.json()
  const topicIds = b.topicIds ? JSON.stringify(b.topicIds.map(Number).filter(Boolean)) : null
  await run(`UPDATE pages SET
    title=COALESCE(?,title), content=COALESCE(?,content), cover=COALESCE(?,cover),
    images=COALESCE(?,images), attachments=COALESCE(?,attachments), topic_ids=COALESCE(?,topic_ids),
    updated_at=datetime('now','+8 hours') WHERE id=?`,
    b.title?.trim() || null, b.content ?? null, b.cover ?? null,
    b.images ? JSON.stringify(b.images) : null, b.attachments ? JSON.stringify(b.attachments) : null,
    topicIds, pid)
  return c.json({ ok: true })
})

// 删除：作者本人 + 超管 + 本学科教师
app.delete('/api/subjects/:id/forum/posts/:pid', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const pid = Number(c.req.param('pid'))
  const u = c.get('user') as any
  const p = await get<any>("SELECT author_id FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return c.json({ message: '帖子不存在' }, 404)
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  if (!isSuper && !isStaff && p.author_id !== u.id) return c.json({ message: '无权删除' }, 403)
  await run('DELETE FROM page_comments WHERE page_id=?', pid)
  await run("DELETE FROM pages WHERE id=?", pid)
  return c.json({ ok: true })
})

// 审核论坛帖子：超管 + 本学科教师（复用美文审核的写法：status 流转 + 经验 + 通知）
//   body: { status: 'published' | 'rejected', reviewNote?: string }
app.patch('/api/subjects/:id/forum/posts/:pid/status', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const pid = Number(c.req.param('pid'))
  const u = c.get('user') as any
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员 = 可管全学科（跨学科管理能力与超管一致）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = (permSubjects || u.role === 'TEACHER') && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid) || permSubjects
  if (!isSuper && !isStaff) return c.json({ message: '只有超管和本学科教师可以审核论坛帖子' }, 403)
  const p = await get<any>("SELECT * FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return c.json({ message: '帖子不存在' }, 404)
  const b = await c.req.json()
  const newStatus = b.status
  if (!['published', 'rejected', 'pending'].includes(newStatus)) return c.json({ message: '状态不合法' }, 400)
  const note = b.reviewNote || ''
  await run("UPDATE pages SET status=?, reviewed_by=?, reviewed_at=datetime('now','+8 hours'), review_note=? WHERE id=?",
    newStatus, u.id, note, pid)
  // 经验值：approved 且 之前不是 published → 发放 forum_post 经验（防重复）
  if (newStatus === 'published' && p.status !== 'published') {
    const expUid = Number(p.author_id)
    const already = await get("SELECT id FROM exp_logs WHERE user_id=? AND action_type='forum_post' AND INSTR(description, ?) > 0", expUid, p.title)
    if (!already) {
      try { await addExp(expUid, undefined, 'forum_post', `论坛帖子《${p.title}》审核通过`, p.subject_id) } catch {}
    }
    await addNotice(expUid, '论坛帖子审核通过', `你的《${p.title}》已通过审核，已公开展示。`, 'audit')
  } else if (newStatus === 'rejected') {
    await addNotice(Number(p.author_id), '论坛帖子未通过审核', `《${p.title}》未通过审核${note ? '，原因：' + note : ''}，请修改后重新提交。`, 'audit')
  }
  clearAllCache()
  return c.json({ ok: true, status: newStatus })
})

// 论坛评论 = 直接复用 /api/pages/:id/comments

// 【v4.1.1】审核中心 - 论坛帖子列表（与美文/资料同 UI 流程）
//   GET /api/admin/audit/forum-posts
//   超管：全部 pending 论坛帖子
//   本学科教师：本学科 pending 论坛帖子
app.get('/api/admin/audit/forum-posts', auth, async (c) => {
  const u = c.get('user') as any
  // 【v4.9.7】拥有 audit 权限的管理员 = 审核全站（不限学科），等价超管视角
  const isSuper = u.role === 'SUPER_ADMIN' || hasPerm(u, 'audit')
  const isTeacher = u.role === 'TEACHER'
  if (!isSuper && !isTeacher) return c.json({ message: '无权访问审核中心' }, 403)
  let sql = `SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar, s.name AS subject_name, s.icon AS subject_icon
    FROM pages p
    LEFT JOIN users u ON p.author_id=u.id
    LEFT JOIN subjects s ON p.subject_id=s.id
    WHERE p.ptype='forum' AND p.status='pending'`
  const args: any[] = []
  if (!isSuper) {
    const sids = await teachingSubjects(u.id)
    if (u.subject_id && !sids.includes(Number(u.subject_id))) sids.push(Number(u.subject_id))
    if (!sids.length) return c.json([])
    sql += ` AND p.subject_id IN (${sids.map(() => '?').join(',')})`
    args.push(...sids)
  }
  sql += ' ORDER BY p.id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map((p: any) => ({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })))
})

// 审核中心 - 论坛帖子：单条详情（与美文详情保持一致）
app.get('/api/admin/audit/forum-posts/:id', auth, async (c) => {
  const u = c.get('user') as any
  const id = Number(c.req.param('id'))
  const isSuper = u.role === 'SUPER_ADMIN' || hasPerm(u, 'audit')
  const isTeacher = u.role === 'TEACHER'
  if (!isSuper && !isTeacher) return c.json({ message: '无权' }, 403)
  const p = await get<any>(`SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar, s.name AS subject_name, s.icon AS subject_icon
    FROM pages p
    LEFT JOIN users u ON p.author_id=u.id
    LEFT JOIN subjects s ON p.subject_id=s.id
    WHERE p.id=? AND p.ptype='forum'`, id)
  if (!p) return c.json({ message: '帖子不存在' }, 404)
  if (!isSuper) {
    const sids = await teachingSubjects(u.id)
    if (u.subject_id && !sids.includes(Number(u.subject_id))) sids.push(Number(u.subject_id))
    if (!sids.includes(Number(p.subject_id))) return c.json({ message: '无权查看该学科帖子' }, 403)
  }
  return c.json({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })
})

// 论坛评论 = 直接复用 /api/pages/:id/comments

// 【v4.5.0】题目 ↔ 知识点关联写入（幂等替换）
async function linkKnowledge(questionId: number, ids: any) {
  await run('DELETE FROM question_knowledge WHERE question_id=?', questionId)
  const arr = Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []
  for (const kp of arr) {
    try { await run('INSERT OR IGNORE INTO question_knowledge (question_id, knowledge_point_id) VALUES (?,?)', questionId, kp) } catch {}
  }
}

// ==============================================================================
// ============ 【v4.13.0】AI 试卷识别（自动切割 + 读答案/解析）============
// ==============================================================================
//
// 【为什么加这个】
//   Word 导入的自动切割原来是纯正则：题号格式一变就切不出、
//   答案只在行内紧邻才认、卷末「参考答案」区块完全关联不上、解析常年为空。
//   这里把「结构识别」交给大模型，正则只作降级兜底。
//
// 【双通道（v4.13.0 从 Gemini 迁移到 Cloudflare Workers AI）】
//   通道 A Cloudflare Workers AI —— 走 [ai] 绑定，**零密钥、零配置**，
//          免费档每天 10000 神经元；主力 glm-4.7-flash，备用 llama-3.3-70b
//   通道 B 智谱开放平台 —— 超管在管理后台填 Key，存 D1 settings 表
//   AI_PROVIDER=cf|zhipu|auto（默认 auto = 先 CF 失败切智谱）
//   两通道都不可用时返回 available:false，前端**自动回落正则**，功能永不中断。
//
// 【安全】密钥只从后台配置/环境变量读取，不落文件、不进日志（错误里也不回显）。
// ==============================================================================

/**
 * 读取超管在后台配置的 AI 设置。
 *
 * 每次请求都读一次？——是的，且**故意不缓存**。
 *   理由：AI 配置变更频率极低（可能几个月一次），但一旦改动，超管期望
 *   "点保存 → 立刻生效"。D1 单点查询 <10ms，相比一次 AI 调用的几十秒可忽略。
 *   相比之下，缓存会让"我明明改了怎么没用"成为一类难以排查的问题。
 */
async function readAiConfig(): Promise<ReturnType<typeof sanitizeAiConfig>> {
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key=?", AI_CONFIG_KEY)
    if (!r?.value) return { ...DEFAULT_AI_CONFIG }
    return sanitizeAiConfig(JSON.parse(r.value))
  } catch {
    // 表不存在/JSON 损坏都不能让 AI 功能整体垮掉 —— 回落到环境变量
    return { ...DEFAULT_AI_CONFIG }
  }
}

/**
 * 组装本次请求实际生效的 AiEnv = 基础设施(env.AI 绑定 + 环境变量) ⊕ 后台配置。
 * 后台配置优先（超管在界面上改的东西必须立刻生效）。
 */
async function aiEnv(): Promise<AiEnv> {
  const cfg = await readAiConfig()
  return { ...mergeAiConfig(AI_ENV, cfg), AI: AI_BINDING }
}


/** AI 可用性（前端据此决定按钮是否置灰 + 显示当前服务商） */
app.get('/api/ai/status', auth, async (c) => {
  const env = await aiEnv()
  const cfg = await readAiConfig()
  return c.json({
    available: aiAvailable(env),
    provider: (env.AI_PROVIDER || 'auto').toLowerCase(),
    // 实际会生效的通道（考虑可用性后的结果，比 provider 更能反映真相）
    effective: effectiveProvider(env),
    cf: !!(env.AI || env.AI_BASE_CF),
    zhipu: !!env.ZHIPU_API_KEY,
    modelCf: env.AI_MODEL_CF || DEFAULT_MODEL_CF,
    modelCfFallback: env.AI_MODEL_CF_FALLBACK || DEFAULT_MODEL_CF_FALLBACK,
    modelZhipu: env.AI_MODEL_ZHIPU || DEFAULT_MODEL_ZHIPU,
    // 脱敏后的智谱 Key，供后台确认"配没配"，绝不明文回显
    zhipuKeyMasked: maskKey(cfg.zhipuKey || env.ZHIPU_API_KEY),
  })
})

/**
 * 用 AI 解析试卷文本 → 结构化题目数组。
 *
 * 入参：{ text: string, subjectId?: number }
 *   · text 由前端从 mammoth 结果里抽取的**纯文本**（含公式/表格的自然语言化）
 *   · 也接受 html 字段（后端会粗转纯文本），方便前端少写代码
 *
 * 返回：{ ok, available, provider, model, questions[], attempts[] }
 *   · available=false 或 questions 为空 → 前端回落正则
 *
 * 权限：与「新增题目」一致（教师须任教该学科），避免任意用户白嫖 AI 额度。
 */
app.post('/api/ai/parse-paper', auth, async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const rawHtml: string = String(body?.html || '')
  const bodyText: string = String(body?.text || '')

  // 【v4.13.1】**优先用 HTML**（表格保行列、图片保位置）。
  //   v4.13.0 只认 text，导致表格被拍平、图片块因 text 为空而整块消失。
  //   现在前端会同时传 text 与 html：有 html 就交给共享层做结构化转换。
  const payload = rawHtml.trim() || bodyText
  if (!payload.trim()) return c.json({ ok: false, available: true, message: '试卷内容为空' }, 400)
  if (payload.length > 200000) return c.json({ ok: false, available: true, message: '试卷过大（上限 20 万字符），请拆分后再试' }, 400)

  // 权限：若是绑定学科的导入，要求任教该学科
  const subjectId = Number(body?.subjectId)
  if (subjectId) {
    const u = c.get('user')
    if (u.role !== 'SUPER_ADMIN') {
      const okStaff = await (async () => {
        if (u.role !== 'TEACHER') return false
        const row = await get<any>('SELECT 1 AS ok FROM user_subjects WHERE user_id=? AND subject_id=?', u.id, subjectId)
        if (row) return true
        const cs = await get<any>('SELECT 1 AS ok FROM class_members WHERE user_id=? AND subject_id=? AND role_in_class=?', u.id, subjectId, 'TEACHER')
        return !!cs
      })()
      if (!okStaff) return c.json({ message: '无权操作该学科' }, 403)
    }
  }

  const env = await aiEnv()
  if (!aiAvailable(env)) {
    // 明确告知"没配 AI"，前端据此直接用正则、不弹错误（这是预期路径，不是故障）
    // v4.13.0：通道 A 只要 [ai] 绑定在就可用，正常情况下走不到这里
    return c.json({ ok: false, available: false, message: 'AI 服务不可用，已使用规则识别', questions: [] })
  }

  const started = Date.now()
  const result = await aiParsePaper(env, payload, { timeoutMs: 55000, maxChars: 60000 })
  const elapsed = Date.now() - started

  if (!result || !result.questions.length) {
    return c.json({
      ok: false,
      available: true,
      message: 'AI 识别失败或未识别出题目，已回退规则识别',
      questions: [],
      attempts: result?.attempts || [],
      elapsed,
    })
  }

  return c.json({
    ok: true,
    available: true,
    provider: result.provider,
    model: result.model,
    questions: result.questions,
    // 【v4.13.1】把「图N → 原图 src」映射回传，前端据此把占位符换回 <img>，
    //   否则用户看到的题干里只有 "[图1]" 而没有图片。
    images: result.images || {},
    attempts: result.attempts,
    usage: result.usage,
    elapsed,
  })
})

// ==============================================================================
// ============ 【v4.13.0】AI 设置（超管在后台配置智谱 Key / 切换服务商）============
// ==============================================================================
//
// 【为什么要有这两个接口】
//   用户原话：「Google 这个我弄不了」+「智谱的 api 我完了给你 或者是
//   超级管理员可以在管理界面设置」。所以：
//     · 通道 A（Cloudflare Workers AI）零配置可用，不需要任何界面
//     · 通道 B（智谱）的 Key 让超管在管理界面自己填，不用碰命令行
//
// 【安全设计】
//   · 需要 `ai_settings` 权限（超管恒有，普通管理员需显式授予）
//   · GET 返回的 Key **必须脱敏**（前4后4），绝不明文下发到浏览器
//   · PUT 收到的是**完整配置**；如果 zhipuKey 传的是脱敏串或空，
//     说明用户没改 Key → 保留原值，避免"保存一次就把 Key 清空"的经典坑
// ==============================================================================

app.get('/api/settings/ai_config', auth, requirePerm('ai_settings'), async (c) => {
  const cfg = await readAiConfig()
  const env = await aiEnv()
  return c.json({
    ...cfg,
    // 脱敏后再下发；前端拿到的是 "abcd****wxyz"，不是真 Key
    zhipuKey: maskKey(cfg.zhipuKey),
    zhipuKeyMasked: maskKey(cfg.zhipuKey),
    // 实时可用性，让超管一眼看出"配的到底生效没有"
    available: aiAvailable(env),
    effective: effectiveProvider(env),
    cfReady: !!(env.AI || env.AI_BASE_CF),
    zhipuReady: !!env.ZHIPU_API_KEY,
  })
})

app.put('/api/settings/ai_config', auth, requirePerm('ai_settings'), async (c) => {
  const body = await c.req.json().catch(() => ({})) as any
  const prev = await readAiConfig()

  // 【关键】Key 的"未修改"判定：
  //   前端回显的是脱敏串（含 ****），用户不动它就直接提交了。
  //   若不识别这种情况，一次保存就会把真实 Key 覆盖成 "abcd****wxyz"，AI 当场失效。
  //   另外**纯空白也算未修改**（用户可能全选删掉但留了空格）——
  //   实测踩到过：`'   ' !== ''` 且不含 ****，于是被 trim 成空串把 Key 清掉了。
  const incoming = String(body?.zhipuKey ?? '').trim()
  const looksMasked = incoming.includes('****')
  const zhipuKey = (incoming === '' || looksMasked) ? prev.zhipuKey : incoming

  const next = sanitizeAiConfig({ ...body, zhipuKey })
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", AI_CONFIG_KEY, JSON.stringify(next))
  clearAllCache()
  return c.json({ ok: true })
})

/**
 * 一次性连接测试：用当前配置跑一道迷你题，返回真实结果。
 *
 * 为什么值得单独做一个接口：超管最需要回答的问题是
 * 「我配的这个 Key / 这个模型，到底能不能用？」——猜不出来，必须实测。
 */
app.post('/api/settings/ai_config/test', auth, requirePerm('ai_settings'), async (c) => {
  const env = await aiEnv()
  if (!aiAvailable(env)) {
    return c.json({ ok: false, message: 'AI 服务不可用：未绑定 Workers AI，且未配置智谱 Key' })
  }
  const sample = [
    '1. 下列函数中，在区间(0,+∞)上是增函数的是（    ）',
    'A. y = -x + 1    B. y = 1/x    C. y = x²    D. y = (1/2)^x',
    '【答案】C 【解析】y=x² 在 (0,+∞) 上单调递增。',
  ].join('\n')
  const started = Date.now()
  const result = await aiParsePaper(env, sample, { timeoutMs: 30000, maxChars: 5000 })
  const elapsed = Date.now() - started
  const ok = !!result?.questions?.length
  return c.json({
    ok,
    provider: result?.provider || '',
    model: result?.model || '',
    questions: result?.questions || [],
    attempts: result?.attempts || [],
    usage: result?.usage,
    elapsed,
    message: ok
      ? `连接成功（${result?.provider} / ${result?.model}，耗时 ${elapsed}ms）`
      : '连接失败：请检查下方错误详情',
  })
})

// 【v4 Bug9】单题训练 - 教师必须任教该学科才能加题
app.post('/api/subjects/:id/questions', auth, requireSubjectStaff('params', 'id'), async (c) => {
  const sid = Number(c.req.param('id'))
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', c.get('user').id)
  const b = await c.req.json()
  const r = await run(
    `INSERT INTO subject_questions (subject_id,creator_id,creator_name,qtype,content,options,answer,analysis,score,attachments,sort,difficulty,textbook_version,region,chapter,year,source,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'))`,
    sid, c.get('user').id, me?.real_name || '', b.qtype || 'single', b.content || '', JSON.stringify(b.options || []),
    b.answer || '', b.analysis || '', b.score || 5, JSON.stringify(b.attachments || []), b.sort || 0,
    b.difficulty || 3, b.textbook_version || '', b.region || '', b.chapter || '', b.year || '', b.source || '', b.status || 'active'
  )
  const qid = Number(r.lastInsertRowid)
  await linkKnowledge(qid, b.knowledge_point_ids)
  return c.json({ id: qid })
})

// 【v4 Bug9】删除单题 - 教师必须任教该题的学科；超管可删任意
app.delete('/api/subject-questions/:id', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', id)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const u = c.get('user') as any
  // 【v4.9.7】拥有 subjects 权限的管理员等同超管视角（可删全站题目）
  if (!hasPerm(u, 'subjects')) {
    if (!(await canManageSubject({ id: u.id, role: u.role }, q.subject_id))) {
      return c.json({ message: '教师只能删除自己任教学科的题目' }, 403)
    }
    if (q.creator_id !== u.id) return c.json({ message: '无权删除他人题目' }, 403)
  }
  await run('DELETE FROM practice_submissions WHERE question_id=?', id)
  await run('DELETE FROM subject_questions WHERE id=?', id)
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 【v4.5.0】题目二次编辑（创建者 / 本学科教师 / 超管）============
// ==============================================================================
app.patch('/api/subject-questions/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const u = c.get('user') as any
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', id)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const isSuper = u.role === 'SUPER_ADMIN'
  // 【v4.9.7】拥有 subjects 权限的管理员可编辑全站题目（不限学科）
  const permSubjects = hasPerm(u, 'subjects')
  const isStaff = permSubjects || (!isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, q.subject_id))
  if (!isSuper && !isStaff && q.creator_id !== u.id) return c.json({ message: '无权编辑该题（仅创建者、本学科教师或超管可编辑）' }, 403)
  const b = await c.req.json()
  await run(`UPDATE subject_questions SET
    qtype=COALESCE(?,qtype), content=COALESCE(?,content), options=COALESCE(?,options),
    answer=COALESCE(?,answer), analysis=COALESCE(?,analysis), score=COALESCE(?,score),
    difficulty=COALESCE(?,difficulty), textbook_version=COALESCE(?,textbook_version),
    region=COALESCE(?,region), chapter=COALESCE(?,chapter), year=COALESCE(?,year),
    source=COALESCE(?,source), status=COALESCE(?,status), sort=COALESCE(?,sort)
    WHERE id=?`,
    b.qtype || null, b.content ?? null, b.options ? JSON.stringify(b.options) : null,
    b.answer ?? null, b.analysis ?? null, b.score ?? null, b.difficulty ?? null,
    b.textbook_version ?? null, b.region ?? null, b.chapter ?? null, b.year ?? null, b.source ?? null, b.status ?? null, b.sort ?? null, id)
  if (b.knowledge_point_ids !== undefined) await linkKnowledge(id, b.knowledge_point_ids)
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 【v4.9.0】智能题库批量操作 + 去重 + 知识点推荐 ============
//
// 【背景】用户要求「补充智能题库功能」，澄清后明确「多多益善」。
//   组卷网/智学网在这一块的能力是：批量改题型、批量打知识点、批量删除、
//   题目去重、知识点自动标注。这里一次性补齐。
//
// 【设计原则：单条权限校验的复用】
//   批量端点**不重写**权限判断，而是复用与单条 PATCH/DELETE 完全相同的规则，
//   避免"单条拦得住、批量绕过"这种最危险的安全漏洞。
// ==============================================================================

/** 判断当前用户能否编辑/删除某道题（与单条端点同一套规则） */
async function canEditQuestion(u: any, q: any): Promise<boolean> {
  if (!u || !q) return false
  if (u.role === 'SUPER_ADMIN') return true
  const isStaff = u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, q.subject_id)
  if (isStaff) return true
  return Number(q.creator_id) === Number(u.id)
}

/** 把 id 列表切成 SQL IN 的占位符（D1 单语句参数上限 100，这里保守取 90） */
const BATCH_MAX = 90

app.post('/api/subject-questions/batch-update', auth, async (c) => {
  const u = c.get('user') as any
  const b = await c.req.json().catch(() => ({}))
  const ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean).slice(0, BATCH_MAX) : []
  if (!ids.length) return c.json({ message: '请至少选择一道题' }, 400)

  // 逐条校验权限：不做"先过滤再更新"的黑盒操作，保证能精确回报被拒绝的题
  const ph = ids.map(() => '?').join(',')
  const rows = await all<any>(`SELECT id, subject_id, creator_id FROM subject_questions WHERE id IN (${ph})`, ...ids)
  const allowed: number[] = []
  const denied: number[] = []
  for (const r of rows) (await canEditQuestion(u, r)) ? allowed.push(r.id) : denied.push(r.id)
  if (!allowed.length) return c.json({ message: '没有可操作的题目（权限不足）', denied }, 403)

  // 支持的批量字段（白名单，杜绝任意列注入）
  const FIELD_MAP: Record<string, string> = {
    qtype: 'qtype', difficulty: 'difficulty', score: 'score', status: 'status',
    textbook_version: 'textbook_version', region: 'region', chapter: 'chapter',
    year: 'year', source: 'source',
  }
  const sets: string[] = []
  const vals: any[] = []
  for (const [k, col] of Object.entries(FIELD_MAP)) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') { sets.push(`${col}=?`); vals.push(b[k]) }
  }
  const ph2 = allowed.map(() => '?').join(',')
  if (sets.length) {
    await run(`UPDATE subject_questions SET ${sets.join(', ')} WHERE id IN (${ph2})`, ...vals, ...allowed)
  }

  // 知识点：批量「追加」而非覆盖 —— 批量场景下覆盖会误删原有标注，风险太高
  const kpIds: number[] = Array.isArray(b.add_knowledge_point_ids) ? b.add_knowledge_point_ids.map(Number).filter(Boolean) : []
  if (kpIds.length) {
    for (const qid of allowed) {
      for (const kid of kpIds) {
        // 幂等：已存在的关系不重复插入（依赖 UNIQUE 索引 + INSERT OR IGNORE）
        await run('INSERT OR IGNORE INTO question_knowledge (question_id, knowledge_point_id) VALUES (?,?)', qid, kid)
      }
    }
  }

  clearAllCache()
  return c.json({ ok: true, updated: allowed.length, denied })
})

app.post('/api/subject-questions/batch-delete', auth, async (c) => {
  const u = c.get('user') as any
  const b = await c.req.json().catch(() => ({}))
  const ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean).slice(0, BATCH_MAX) : []
  if (!ids.length) return c.json({ message: '请至少选择一道题' }, 400)

  const ph = ids.map(() => '?').join(',')
  const rows = await all<any>(`SELECT id, subject_id, creator_id FROM subject_questions WHERE id IN (${ph})`, ...ids)
  const allowed: number[] = []
  const denied: number[] = []
  // 删除比编辑更严格：与单条 DELETE 一致，教师只能删**自己创建**的题
  // 【v4.9.7】拥有 subjects 权限的管理员等同超管视角，可删全站题目
  for (const r of rows) {
    const isSuper = u.role === 'SUPER_ADMIN' || hasPerm(u, 'subjects')
    const own = Number(r.creator_id) === Number(u.id)
    const canStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, r.subject_id)
    if (isSuper || (canStaff && own)) allowed.push(r.id)
    else denied.push(r.id)
  }
  if (!allowed.length) return c.json({ message: '没有可删除的题目（仅创建者可删除）', denied }, 403)

  const ph2 = allowed.map(() => '?').join(',')
  await run(`DELETE FROM practice_submissions WHERE question_id IN (${ph2})`, ...allowed)
  await run(`DELETE FROM subject_questions WHERE id IN (${ph2})`, ...allowed)
  clearAllCache()
  return c.json({ ok: true, deleted: allowed.length, denied })
})

/**
 * 题目去重检测。
 * 判据：题面归一化后（去空白 / 去标点 / 去 HTML）**前 N 字**相同，即视为疑似重复。
 * 不追求 100% 精确（那需要向量检索），但足以覆盖"同一道题被老师导入两次"这个最常见场景。
 */
app.get('/api/subjects/:subjectId/questions/duplicates', auth, requireStaff, async (c) => {
  const subjectId = Number(c.req.param('subjectId'))
  const rows = await all<any>(
    `SELECT id, qtype, content, answer, creator_id, created_at
     FROM subject_questions WHERE subject_id=? ORDER BY id ASC`, subjectId)
  const norm = (s: string) => String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, '')
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[。．.，,、；;：:！!？?"'“”‘’()（）\[\]【】]/g, '')
    .trim()
  const groups: Record<string, any[]> = {}
  for (const r of rows) {
    const key = norm(r.content).slice(0, 60)      // 前 60 字足以识别同题
    if (!key || key.length < 8) continue          // 太短的不参与（避免误判"如图"这类）
    ;(groups[key] ||= []).push({ id: r.id, qtype: r.qtype, preview: norm(r.content).slice(0, 80), answer: r.answer || '' })
  }
  const dupGroups = Object.values(groups).filter(g => g.length > 1)
  return c.json({ groups: dupGroups, total: dupGroups.reduce((s, g) => s + g.length, 0), scanned: rows.length })
})

/**
 * 知识点自动标注推荐。
 * 用「知识点名称在题面中出现的字面命中」做推荐 —— 简单、可解释、零额外成本。
 * 组卷网的"智能标注"本质也是关键词命中 + 人工确认，这里对齐同一语义。
 */
app.post('/api/subject-questions/:id/suggest-kp', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const q = await get<any>('SELECT id, subject_id, content, options FROM subject_questions WHERE id=?', id)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  const kps = await all<any>('SELECT id, name, parent_id FROM knowledge_points WHERE subject_id=?', q.subject_id)
  const text = String(q.content || '').replace(/<[^>]+>/g, '') + ' ' + String(q.options || '')
  const hits = kps
    .filter(k => {
      const name = String(k.name || '').trim()
      return name.length >= 2 && text.includes(name)   // 单字知识点不参与，误报率太高
    })
    .map(k => ({ id: k.id, name: k.name, parent_id: k.parent_id, score: 1 }))
  return c.json({ suggestions: hits })
})

/** 批量版知识点推荐：一次给一页题做标注建议（前端批量勾选后调 batch-update 落库） */
app.post('/api/subjects/:subjectId/suggest-kp-batch', auth, requireStaff, async (c) => {
  const subjectId = Number(c.req.param('subjectId'))
  const b = await c.req.json().catch(() => ({}))
  const ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean).slice(0, 50) : []
  if (!ids.length) return c.json({ suggestions: {} })
  const kps = await all<any>('SELECT id, name, parent_id FROM knowledge_points WHERE subject_id=?', subjectId)
  const ph = ids.map(() => '?').join(',')
  const rows = await all<any>(`SELECT id, content, options FROM subject_questions WHERE id IN (${ph})`, ...ids)
  const out: Record<string, any[]> = {}
  for (const r of rows) {
    const text = String(r.content || '').replace(/<[^>]+>/g, '') + ' ' + String(r.options || '')
    out[String(r.id)] = kps
      .filter(k => { const n = String(k.name || '').trim(); return n.length >= 2 && text.includes(n) })
      .map(k => ({ id: k.id, name: k.name, parent_id: k.parent_id }))
  }
  return c.json({ suggestions: out })
})

// ==============================================================================
// ============ 【v4.5.0】知识点（层级树）============
// 【v4.8.25 对齐组卷网】本项目知识点层级**固定 2 级封顶**：
//   · 一级 = 章 / 模块（如「力学」），作聚合标签，不再挂子级
//   · 二级 = 具体知识点（如「牛顿第二定律」），出题时真正打标的层级
//   组卷网交互语义：**点一级 = 查其下所有二级的题**（聚合查询，见上方筛选 SQL）。
//   之所以硬性限制 2 级：「点父节点聚合子节点」若允许无限层级就需要递归 CTE，
//   D1 上性能与可维护性都变差，而教学场景（章 → 节）2 级已足够。
// ==============================================================================

/** 【v4.8.25】校验知识点层级：父节点必须存在、属于同一学科、且自身不能再有父级 */
async function validateKpParent(subjectId: number, parentId: any, selfId?: number): Promise<string | null> {
  if (parentId === null || parentId === undefined || parentId === '') return null
  const pid = Number(parentId)
  if (!pid) return null
  if (selfId && pid === Number(selfId)) return '不能把知识点设为自己的上级'
  const parent = await get<any>('SELECT id, subject_id, parent_id FROM knowledge_points WHERE id=?', pid)
  if (!parent) return '上级知识点不存在'
  if (Number(parent.subject_id) !== Number(subjectId)) return '上级知识点不属于本学科'
  if (parent.parent_id) return '知识点最多支持两级（当前选择的上级本身已是子级）'
  return null
}

app.get('/api/subjects/:id/knowledge-points', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const list = await all<any>('SELECT * FROM knowledge_points WHERE subject_id=? ORDER BY sort, id ASC', sid)
  return c.json(list)
})

app.post('/api/subjects/:id/knowledge-points', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return c.json({ message: '只有超管和本学科教师可以管理知识点' }, 403)
  }
  const b = await c.req.json()
  if (!b.name?.trim()) return c.json({ message: '知识点名称不能为空' }, 400)
  // 【v4.8.25】层级校验：最多两级
  const bad = await validateKpParent(sid, b.parent_id)
  if (bad) return c.json({ message: bad }, 400)
  // 【v4.8.25】同级重名拦截（组卷网同样不允许，否则筛选时无法区分）
  const dup = b.parent_id
    ? await get<any>('SELECT id FROM knowledge_points WHERE subject_id=? AND name=? AND parent_id=?', sid, b.name.trim(), Number(b.parent_id))
    : await get<any>('SELECT id FROM knowledge_points WHERE subject_id=? AND name=? AND parent_id IS NULL', sid, b.name.trim())
  if (dup) return c.json({ message: '同级下已存在同名知识点' }, 400)
  const r = await run(`INSERT INTO knowledge_points (subject_id,parent_id,name,description,sort,created_at) VALUES (?,?,?,?,?,datetime('now','+8 hours'))`,
    sid, b.parent_id ? Number(b.parent_id) : null, b.name.trim().slice(0, 80), b.description || '', b.sort || 0)
  clearAllCache()
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/knowledge-points/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const u = c.get('user') as any
  const kp = await get<any>('SELECT * FROM knowledge_points WHERE id=?', id)
  if (!kp) return c.json({ message: '知识点不存在' }, 404)
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, kp.subject_id))) {
    return c.json({ message: '只有超管和本学科教师可以编辑知识点' }, 403)
  }
  const b = await c.req.json()
  // 【v4.8.25】层级校验（编辑时排除自身）
  if (b.parent_id !== undefined) {
    const bad = await validateKpParent(kp.subject_id, b.parent_id, id)
    if (bad) return c.json({ message: bad }, 400)
    // 若要把「已有子节点的一级」降为二级，会形成第 3 级 → 拒绝
    if (b.parent_id) {
      const child = await get<any>('SELECT id FROM knowledge_points WHERE parent_id=? LIMIT 1', id)
      if (child) return c.json({ message: '该知识点下已有子知识点，不能再设为其它知识点的下级' }, 400)
    }
  }
  const newName = b.name?.trim() || null
  // 【v4.8.25】同级重名拦截
  if (newName) {
    const effParent = b.parent_id !== undefined ? b.parent_id : kp.parent_id
    const dup = effParent
      ? await get<any>('SELECT id FROM knowledge_points WHERE subject_id=? AND name=? AND id<>? AND parent_id=?', kp.subject_id, newName, id, Number(effParent))
      : await get<any>('SELECT id FROM knowledge_points WHERE subject_id=? AND name=? AND id<>? AND parent_id IS NULL', kp.subject_id, newName, id)
    if (dup) return c.json({ message: '同级下已存在同名知识点' }, 400)
  }
  await run('UPDATE knowledge_points SET name=COALESCE(?,name), description=COALESCE(?,description), parent_id=COALESCE(?,parent_id), sort=COALESCE(?,sort) WHERE id=?',
    newName, b.description ?? null, b.parent_id !== undefined ? (b.parent_id ? Number(b.parent_id) : null) : null, b.sort ?? null, id)
  clearAllCache()
  return c.json({ ok: true })
})

app.delete('/api/knowledge-points/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const u = c.get('user') as any
  const kp = await get<any>('SELECT * FROM knowledge_points WHERE id=?', id)
  if (!kp) return c.json({ message: '知识点不存在' }, 404)
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, kp.subject_id))) {
    return c.json({ message: '只有超管和本学科教师可以删除知识点' }, 403)
  }
  // 【v4.8.25 对齐组卷网】原写法删父节点时把子节点 `parent_id=NULL`（**提升为一级**），
  //   会静默改变树的形状：用户以为删掉了一个章，结果它的节全变成顶级知识点。
  //   组卷网的做法是**存在子节点时不允许删除**（提示先处理下级），这里对齐该语义。
  const child = await get<any>('SELECT id, name FROM knowledge_points WHERE parent_id=? LIMIT 1', id)
  if (child) return c.json({ message: `该知识点下还有子知识点（如「${child.name}」），请先删除或移出子知识点` }, 400)
  await run('DELETE FROM question_knowledge WHERE knowledge_point_id=?', id)
  await run('DELETE FROM knowledge_points WHERE id=?', id)
  clearAllCache()
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 【v4.5.0】题目纠错反馈通道 ============
// ==============================================================================
app.post('/api/subject-questions/:id/feedback', auth, async (c) => {
  const qid = Number(c.req.param('id'))
  const uid = c.get('user').id
  const b = await c.req.json()
  if (!b.content?.trim()) return c.json({ message: '反馈内容不能为空' }, 400)
  const r = await run('INSERT INTO question_feedback (user_id,question_id,content,created_at) VALUES (?,?,?,datetime(\'now\',\'+8 hours\'))', uid, qid, b.content.trim().slice(0, 500))
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.get('/api/subjects/:id/question-feedback', auth, async (c) => {
  const sid = Number(c.req.param('id'))
  const u = c.get('user') as any
  if (!hasPerm(u, 'subjects') && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return c.json({ message: '只有超管和本学科教师可以查看纠错反馈' }, 403)
  }
  const list = await all<any>('SELECT f.*, u.real_name, sq.content AS qcontent FROM question_feedback f LEFT JOIN users u ON u.id=f.user_id LEFT JOIN subject_questions sq ON sq.id=f.question_id WHERE sq.subject_id=? ORDER BY f.id DESC', sid)
  return c.json(list)
})

app.patch('/api/question-feedback/:id', auth, requireStaff, async (c) => {
  const id = Number(c.req.param('id'))
  const b = await c.req.json()
  await run("UPDATE question_feedback SET status=?, resolved_by=?, resolved_at=datetime('now','+8 hours') WHERE id=?", b.status || 'resolved', c.get('user').id, id)
  return c.json({ ok: true })
})

// ==============================================================================
// ============ 【v4.5.0】个人题库：文件夹 + 收藏 ============
// ==============================================================================
app.get('/api/users/me/question-folders', auth, async (c) => {
  const list = await all<any>('SELECT * FROM question_folders WHERE user_id=? ORDER BY sort, id ASC', c.get('user').id)
  return c.json(list)
})

app.post('/api/users/me/question-folders', auth, async (c) => {
  const b = await c.req.json()
  if (!b.name?.trim()) return c.json({ message: '文件夹名不能为空' }, 400)
  const r = await run('INSERT INTO question_folders (user_id,name,parent_id,sort,created_at) VALUES (?,?,?,?,datetime(\'now\',\'+8 hours\'))',
    c.get('user').id, b.name.trim().slice(0, 40), b.parent_id ? Number(b.parent_id) : null, b.sort || 0)
  return c.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/question-folders/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const f = await get<any>('SELECT * FROM question_folders WHERE id=?', id)
  if (!f || f.user_id !== c.get('user').id) return c.json({ message: '无权' }, 403)
  const b = await c.req.json()
  await run('UPDATE question_folders SET name=COALESCE(?,name), parent_id=COALESCE(?,parent_id), sort=COALESCE(?,sort) WHERE id=?',
    b.name?.trim() || null, b.parent_id !== undefined ? (b.parent_id ? Number(b.parent_id) : null) : null, b.sort ?? null, id)
  return c.json({ ok: true })
})

app.delete('/api/question-folders/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const f = await get<any>('SELECT * FROM question_folders WHERE id=?', id)
  if (!f || f.user_id !== c.get('user').id) return c.json({ message: '无权' }, 403)
  await run('UPDATE question_favorites SET folder_id=NULL WHERE folder_id=?', id)
  await run('DELETE FROM question_folders WHERE id=?', id)
  return c.json({ ok: true })
})

app.post('/api/subject-questions/:id/favorite', auth, async (c) => {
  const qid = Number(c.req.param('id'))
  const uid = c.get('user').id
  const b = await c.req.json().catch(() => ({}))
  try {
    const r = await run('INSERT INTO question_favorites (user_id,question_id,folder_id,note,created_at) VALUES (?,?,?,?,datetime(\'now\',\'+8 hours\'))',
      uid, qid, b.folder_id ? Number(b.folder_id) : null, (b.note || '').slice(0, 200))
    return c.json({ id: Number(r.lastInsertRowid) })
  } catch {
    return c.json({ message: '已收藏' }, 400) // UNIQUE(user_id, question_id)
  }
})

app.get('/api/users/me/favorites', auth, async (c) => {
  const rows = await all<any>(`SELECT f.*, sq.id AS q_id, sq.subject_id, sq.qtype, sq.content, sq.options, sq.answer, sq.analysis, sq.score, sq.difficulty, sq.textbook_version, sq.region, sq.chapter, s.name AS subject_name
    FROM question_favorites f JOIN subject_questions sq ON sq.id=f.question_id LEFT JOIN subjects s ON s.id=sq.subject_id
    WHERE f.user_id=? ORDER BY f.id DESC`, c.get('user').id)
  return c.json(rows.map(r => ({ ...r, options: j(r.options) })))
})

app.delete('/api/favorites/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const f = await get<any>('SELECT * FROM question_favorites WHERE id=?', id)
  if (!f || f.user_id !== c.get('user').id) return c.json({ message: '无权' }, 403)
  await run('DELETE FROM question_favorites WHERE id=?', id)
  return c.json({ ok: true })
})

// 学生错题本：返回当前用户答错（correct=0）的去重题目，可附 subject_id 过滤（对标智学网错题卡）
app.get('/api/users/me/wrong-questions', auth, async (c) => {
  const uid = c.get('user').id
  const sid = c.req.query('subject_id')
  // 【v4.8.28 修复存量缺陷】all() 是可变参数签名 (sql, ...args)，
  //   原实现传了「数组」导致 D1 报 "Wrong number of parameter bindings"（500）。
  //   改为展开传参。
  const rows = await all<any>(`SELECT DISTINCT sq.*, s.name AS subject_name, ps.submitted_at
    FROM practice_submissions ps JOIN subject_questions sq ON sq.id=ps.question_id LEFT JOIN subjects s ON s.id=sq.subject_id
    WHERE ps.user_id=? AND ps.correct=0 ${sid ? 'AND sq.subject_id=?' : ''}
    ORDER BY ps.submitted_at DESC`, ...(sid ? [uid, Number(sid)] : [uid]))
  const out = await Promise.all(rows.map(async (r: any) => {
    const kp = await all<any>('SELECT kp.id, kp.name FROM question_knowledge qk JOIN knowledge_points kp ON kp.id=qk.knowledge_point_id WHERE qk.question_id=?', r.id)
    return { ...r, options: j(r.options), knowledge_points: kp }
  }))
  return c.json(out)
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
      await addNotice(t.id, '单题训练待批', `${stu?.real_name || '学生'}在「${subj?.name || '学科'}」提交了主观题，请及时批改。`, 'teacher')
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
// 【v4 Bug9】单题训练待批列表 - 教师只看待批自己任教学科
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
  if (me.role === 'TEACHER') {
    const sids = await teachingSubjects(me.id)
    if (!sids.length) return c.json([])
    sql += ` AND sq.subject_id IN (${sids.map(() => '?').join(',')})`; args.push(...sids)
  }
  sql += ' ORDER BY ps.id DESC'
  const rows = await all<any>(sql, ...args)
  return c.json(rows.map(r => ({ ...r, qoptions: j(r.qoptions), qattachments: j(r.qattachments) })))
})

// 【v4 Bug9】单题训练批改 - 教师必须任教该题的学科；超管可批任意
app.post('/api/practice/:id/grade', auth, requireStaff, async (c) => {
  const id = c.req.param('id')
  const reviewerId = c.get('user').id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', id)
  if (!sub) return c.json({ message: '提交不存在' }, 404)
  const reviewer = c.get('user') as any
  // 【v4.9.7】拥有 subjects 权限的管理员可批改全站
  if (!hasPerm(reviewer, 'subjects') && !(await canManageSubject({ id: reviewerId, role: reviewer.role }, sub.subject_id))) {
    return c.json({ message: '教师只能批改自己任教学科的题目' }, 403)
  }
  const { score, comment } = await c.req.json()
  const sc = Math.max(0, Math.min(sub.max_score, Number(score) || 0))
  const isCorrect = sc >= sub.max_score
  await run('UPDATE practice_submissions SET score=?, status=?, comment=?, graded_at=datetime(\'now\',\'+8 hours\'), graded_by=?, correct=? WHERE id=?',
    sc, 'graded', comment || '', reviewerId, isCorrect ? 1 : 0, id)
  await addExp(sub.user_id, undefined, 'practice_pass', `单题训练批改完成（${sc}/${sub.max_score}）`, sub.subject_id)
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', reviewerId))?.real_name || '老师'
  const msg = `✅ 你的一道单题训练主观题已被批改\n批改人：${teacherName}\n得分：${sc} / ${sub.max_score}` + (comment ? `\n评语：${comment}` : '')
  await run(`INSERT INTO messages (from_id,to_id,content,attachments,created_at) VALUES (?,?,?,?,datetime('now','+8 hours'))`, reviewerId, sub.user_id, msg, '[]')
  const subjInfo = await get<any>('SELECT name FROM subjects WHERE id=?', sub.subject_id)
  await addNotice(sub.user_id, '单题训练批改完成', `${teacherName}老师批改了你的「${subjInfo?.name || '学科'}」单题训练，得分 ${sc} / ${sub.max_score}` + (comment ? `，评语：${comment}` : ''), 'teacher')
  return c.json({ ok: true, score: sc })
})

// 学生：查看自己的单题训练历史提交记录（分页）
app.get('/api/practice/my-records', auth, async (c) => {
  const uid = c.get('user').id
  const page = Number(c.req.query('page')) || 1
  const perPage = Number(c.req.query('perPage')) || 20
  const offset = (page - 1) * perPage
  const total = await get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE user_id=?', uid)
  const rows = await all<any>(
    `SELECT ps.*, sq.content AS qcontent, sq.qtype, sq.subject_id, sq.attachments AS qattachments,
      s.name AS subject_name, s.icon AS subject_icon
     FROM practice_submissions ps
     JOIN subject_questions sq ON sq.id = ps.question_id
     JOIN subjects s ON s.id = sq.subject_id
     WHERE ps.user_id=? ORDER BY ps.id DESC LIMIT ? OFFSET ?`,
    uid, perPage, offset
  )
  return c.json({ list: rows.map(r => ({ ...r, qattachments: j(r.qattachments) })), total: total.cnt, page, perPage })
})

// 通用：删除单题训练记录（学生本人 OR 教师/超管）
app.delete('/api/practice/record/:id', auth, async (c) => {
  const uid = c.get('user').id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', c.req.param('id'))
  if (!sub) return c.json({ message: '记录不存在' }, 404)
  const me = c.get('user') as any
  const isOwner = sub.user_id === uid
  // 【v4.9.7】拥有 subjects（学科管理）权限的管理员可删全站练习记录
  const isSuperAdmin = me.role === 'SUPER_ADMIN' || hasPerm(me, 'subjects')
  const isSubjectTeacher = me.role === 'TEACHER' && me.subject_id === sub.subject_id
  if (!isOwner && !isSuperAdmin && !isSubjectTeacher) {
    return c.json({ message: '无权删除该记录' }, 403)
  }
  await run('DELETE FROM practice_submissions WHERE id=?', c.req.param('id'))
  return c.json({ ok: true })
})

// 教师/学生：取某一条单题提交详情（含学生作答内容、题目内容、学科）—— 给教师批改 UI 使用
app.get('/api/practice/submission/:id', auth, async (c) => {
  const id = Number(c.req.param('id'))
  const me = c.get('user') as any
  const row = await get<any>(
    `SELECT ps.*, sq.content AS qcontent, sq.qtype, sq.score AS qscore, sq.options AS qoptions, sq.answer AS qanswer, sq.attachments AS qattachments,
            u.real_name, u.username,
            s.id AS subject_id, s.name AS subject_name, s.icon AS subject_icon
     FROM practice_submissions ps
     JOIN subject_questions sq ON sq.id = ps.question_id
     JOIN users u ON u.id = ps.user_id
     JOIN subjects s ON s.id = sq.subject_id
     WHERE ps.id=?`, id)
  if (!row) return c.json({ message: '提交不存在' }, 404)
  // 权限：本人、本学科教师、超管
  const isOwner = row.user_id === me.id
  // 【v4.9.7】拥有 subjects 权限的管理员可查看全站提交
  const isSuperAdmin = me.role === 'SUPER_ADMIN' || hasPerm(me, 'subjects')
  const isSubjectTeacher = me.role === 'TEACHER' && me.subject_id === row.subject_id
  if (!isOwner && !isSuperAdmin && !isSubjectTeacher) {
    return c.json({ message: '无权查看该提交' }, 403)
  }
  return c.json({
    ...row,
    qoptions: j(row.qoptions),
    qattachments: j(row.qattachments || '[]'),
  })
})

// 【v4 Bug9】单题训练统计 - 教师必须任教该题学科
app.get('/api/practice/stats/:questionId', auth, requireStaff, async (c) => {
  const qid = Number(c.req.param('questionId'))
  const me: any = c.get('user')
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', qid)
  if (!q) return c.json({ message: '题目不存在' }, 404)
  if (!hasPerm(me, 'subjects') && !(await canManageSubject({ id: me.id, role: me.role }, q.subject_id))) {
    return c.json({ message: '教师只能查看自己任教学科的题目数据' }, 403)
  }
  const subject = await get<any>('SELECT id, name, icon FROM subjects WHERE id=?', q.subject_id)

  const [totalSubs, pendingCnt, gradedCnt, passCnt] = await Promise.all([
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=?', qid),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND status=?', qid, 'pending'),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND status=?', qid, 'graded'),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND correct=1', qid),
  ])

  const pendingSubs = await all<any>(
    `SELECT ps.*, u.real_name, u.username, u.id AS user_id
     FROM practice_submissions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.question_id=? AND ps.status='pending'
     ORDER BY ps.submitted_at ASC`, qid
  )

  const detailSubs = await all<any>(
    `SELECT ps.id AS sub_id, ps.score, ps.max_score, ps.status, ps.correct,
            ps.answer AS user_answer, ps.comment, ps.submitted_at, ps.graded_at,
            u.real_name, u.username
     FROM practice_submissions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.question_id=?
     ORDER BY ps.id DESC
     LIMIT 300`, qid
  )

  return c.json({
    question: { id: q.id, content: q.content, qtype: q.qtype, score: q.score, answer: q.answer, options: j(q.options), attachments: j(q.attachments || '[]') },
    subject,
    stats: {
      totalSubmissions: totalSubs.cnt || 0,
      pendingCount: pendingCnt.cnt || 0,
      gradedCount: gradedCnt.cnt || 0,
      passCount: passCnt.cnt || 0,
    },
    pendingSubs: pendingSubs.map(r => ({ ...r })),
    detailSubs: detailSubs.map(r => ({ ...r })),
  })
})

// 教师/超管：删除任意学生的单题训练记录
// 说明：上面已统一处理「本人 OR 教师/超管」的删除逻辑，这里不再重复定义

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
  if (exist) {
    await run('DELETE FROM likes_map WHERE id=?', exist.id)
    await run('UPDATE pages SET likes = MAX(0, likes - 1) WHERE id=?', id)
    return c.json({ liked: false })
  }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'page', id)
  await run('UPDATE pages SET likes = likes + 1 WHERE id=?', id)
  // 【v4.2.1】通知作者收到点赞（兼容博客/论坛帖子）
  const p = await get<any>('SELECT author_id AS user_id, title, ptype, subject_id, (SELECT slug FROM subjects WHERE id = pages.subject_id) AS slug FROM pages WHERE id=?', id)
  if (p && Number(p.user_id) !== uid) {
    const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const tUrl = p.ptype === 'blog' ? `/blog/${id}` : `/subject/${p.slug || ''}/forum/post/${id}`
    const tName = p.ptype === 'blog' ? '博客' : '论坛帖子'
    await addNotice(Number(p.user_id), `${tName}收到点赞`, `${u?.real_name || '有人'} 点赞了你的${tName}《${p.title}》`, 'like', `${tUrl}#comment-area`)
  }
  return c.json({ liked: true })
})

// ===== v4.4.16 博客论坛化：站点博客列表（镜像论坛 posts 路由，site 级）=====
app.get('/api/blog/posts', auth, async (c) => {
  const topicId = c.req.query('topicId')
  const mine = c.req.query('mine')
  const userId = c.req.query('userId')
  let sql = `SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar,
      (SELECT COUNT(*) FROM page_comments WHERE page_id=p.id) AS comment_count
    FROM pages p LEFT JOIN users u ON p.author_id=u.id
    WHERE p.ptype='blog' AND p.scope='site' AND p.status='published'`
  const args: any[] = []
  if (topicId) {
    const t = Number(topicId)
    sql += ' AND (p.topic_ids LIKE ? OR p.topic_ids LIKE ? OR p.topic_ids LIKE ? OR p.topic_ids LIKE ?)'
    args.push(`[${t},%`, `%,${t},%`, `%,${t}]`, `[${t}]`)
  }
  if (mine === '1' && userId) { sql += ' AND p.author_id=?'; args.push(userId) }
  sql += ' ORDER BY p.pinned DESC, p.id DESC'
  const list = await all<any>(sql, ...args)
  return c.json(list.map((p: any) => ({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })))
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

// 发表评论【v4.2.0】支持子评论：parent_id 可选【v4.2.1】加通知
app.post('/api/pages/:id/comments', auth, async (c) => {
  const uid = c.get('user').id
  const id = c.req.param('id')
  const body = await c.req.json()
  const content = String(body.content || '').trim()
  if (!content) return c.json({ message: '评论内容不能为空' }, 400)
  const parentId = body.parent_id != null ? Number(body.parent_id) : null
  if (parentId != null) {
    const p = await get<any>('SELECT id FROM page_comments WHERE id=? AND page_id=?', parentId, id)
    if (!p) return c.json({ message: '父评论不存在' }, 400)
  }
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(
    `INSERT INTO page_comments (page_id,user_id,user_name,avatar,content,parent_id,created_at) VALUES (?,?,?,?,?,?,datetime('now','+8 hours'))`,
    id, uid, u?.real_name || '匿名', u?.avatar || '', content, parentId
  )
  const newCommentId = Number(r.lastInsertRowid)
  // 【v4.2.1】通知：主评论通知作者，子评论通知被回复人
  const p = await get<any>('SELECT author_id AS user_id, title, ptype, subject_id, (SELECT slug FROM subjects WHERE id = pages.subject_id) AS slug FROM pages WHERE id=?', id)
  if (p) {
    const tUrl = p.ptype === 'blog' ? `/blog/${id}` : `/subject/${p.slug || ''}/forum/post/${id}`
    const tName = p.ptype === 'blog' ? '博客' : '论坛帖子'
    if (parentId == null) {
      if (Number(p.user_id) !== uid) {
        await addNotice(Number(p.user_id), `${tName}收到新评论`, `${u?.real_name || '有人'} 评论了你的${tName}《${p.title}》：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `${tUrl}#comment-${newCommentId}`)
      }
    } else {
      const parent = await get<any>('SELECT user_id FROM page_comments WHERE id=?', parentId)
      if (parent && Number(parent.user_id) !== uid) {
        await addNotice(Number(parent.user_id), '有人回复了你的评论', `${u?.real_name || '有人'} 回复了你对《${p.title}》的评论：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `${tUrl}#comment-${newCommentId}`)
      }
    }
  }
  return c.json({ id: newCommentId, page_id: Number(id), user_id: uid, user_name: u?.real_name || '匿名', avatar: u?.avatar || '', content, parent_id: parentId, created_at: datetimeNow() })
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
app.put('/api/pages/guide', auth, requirePerm('guide'), async (c) => {
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
    const r = await run("INSERT INTO pages (ptype,scope,title,content,images,attachments,author_name,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours'))", 'guide', 'site', title, content, JSON.stringify(images || []), JSON.stringify(attachments || []), '超级管理员', 'published')
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
  // 【v4.4.8 加固】过滤 undefined 字段，避免 D1 拒绝 undefined 绑定导致博客/公告发布 500（与 POST /api/articles 一致）
  const safe = (v: any, def: any = null) => (v === undefined || v === null) ? def : v
  const r = await run(
    `INSERT INTO pages (ptype,scope,class_id,title,content,cover,images,attachments,author_id,author_name,status,pinned,pinned_scope,topic_ids,recommendation,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','+8 hours'),datetime('now','+8 hours'))`,
    safe(b.ptype), safe(b.scope, 'site'), safe(b.classId, null), safe(b.title), safe(b.content), safe(b.cover, ''), JSON.stringify(Array.isArray(b.images) ? b.images : []), JSON.stringify(Array.isArray(b.attachments) ? b.attachments : []), uid, me?.real_name || '', 'published', pinned, pinnedScope, safe(b.topicIds ? JSON.stringify(b.topicIds) : '[]'), safe(b.recommendation ?? '', '')
  )
  if (b.ptype === 'blog') {
    await addExp(uid, undefined, 'blog', `发布博客《${b.title}》`)
  }
  clearAllCache()
  return c.json({ id: Number(r.lastInsertRowid) })
})

// 修改公告置顶状态
app.patch('/api/pages/:id/pin', auth, requirePerm('guide'), async (c) => {
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

// ===== v4.4.16 博客论坛化：站级话题分类（仅超管管理，对标论坛 forum_topics）=====
app.get('/api/blog/topics', auth, async (c) => {
  const list = await all<any>('SELECT * FROM site_topics ORDER BY id ASC')
  return c.json(list)
})
app.post('/api/blog/topics', auth, requirePerm('audit'), async (c) => {
  const u = c.get('user')
  const b = await c.req.json()
  const name = (b.name || '').trim()
  if (!name) return c.json({ message: '话题名称不能为空' }, 400)
  const color = b.color || '#F59E0B'
  const r = await run('INSERT INTO site_topics (name, color, created_by, created_at) VALUES (?,?,?,datetime(\'now\',\'+8 hours\'))', name, color, u.id)
  clearAllCache()
  return c.json({ id: Number(r.lastInsertRowid) })
})
app.patch('/api/blog/topics/:tid', auth, requirePerm('audit'), async (c) => {
  const tid = Number(c.req.param('tid'))
  const b = await c.req.json()
  const exist = await get<any>('SELECT id FROM site_topics WHERE id=?', tid)
  if (!exist) return c.json({ message: '话题不存在' }, 404)
  const sets: string[] = []
  const args: any[] = []
  if (b.name !== undefined) { sets.push('name=?'); args.push(String(b.name).trim()) }
  if (b.color !== undefined) { sets.push('color=?'); args.push(b.color) }
  if (!sets.length) return c.json({ ok: true })
  args.push(tid)
  await run(`UPDATE site_topics SET ${sets.join(',')} WHERE id=?`, ...args)
  clearAllCache()
  return c.json({ ok: true })
})
app.delete('/api/blog/topics/:tid', auth, requirePerm('audit'), async (c) => {
  const tid = Number(c.req.param('tid'))
  const exist = await get<any>('SELECT id FROM site_topics WHERE id=?', tid)
  if (!exist) return c.json({ message: '话题不存在' }, 404)
  // 仅解绑：博客的 topic_ids 中移除该话题，但保留博客本身
  const rows = await all<any>("SELECT id, topic_ids FROM pages WHERE ptype='blog' AND (topic_ids LIKE ? OR topic_ids LIKE ? OR topic_ids LIKE ? OR topic_ids LIKE ?)", `[${tid},%`, `%,${tid},%`, `%,${tid}]`, `[${tid}]`)
  for (const r of rows) {
    try {
      const ids: number[] = JSON.parse(r.topic_ids || '[]').filter((x: number) => Number(x) !== tid)
      await run('UPDATE pages SET topic_ids=? WHERE id=?', JSON.stringify(ids), r.id)
    } catch { /* 容错：损坏的 JSON 跳过 */ }
  }
  await run('DELETE FROM site_topics WHERE id=?', tid)
  clearAllCache()
  return c.json({ ok: true })
})

// 【v4 Bug12】编辑博客 / 公告（仅作者本人或超管；只读出后再写入）
//   修复原因：之前博客只能"删了重发"，用户体验差。
//   现在允许作者自己编辑自己发布的博客（含封面/正文/图片/附件），
//   超管可编辑任何博客；公告按 ptype 由对应权限控制（site 公告仅超管、class 公告教师/超管）。
app.patch('/api/pages/:id', auth, async (c) => {
  const id = c.req.param('id')
  const p = await get<any>('SELECT * FROM pages WHERE id=?', id)
  if (!p) return c.json({ message: '不存在' }, 404)
  const u = await get<any>('SELECT role FROM users WHERE id=?', c.get('user').id)
  const uid = c.get('user').id
  // 权限：作者本人 或 超管
  const isOwner = Number(p.author_id) === Number(uid)
  const isAdmin = u?.role === 'SUPER_ADMIN'
  // 公告按 ptype 走对应权限：site 公告仅超管；class 公告教师/超管可编辑
  if (p.ptype === 'announcement') {
    if (p.scope === 'site' && !isAdmin) return c.json({ message: '只有超级管理员可编辑全站公告' }, 403)
    if (p.scope === 'class' && !isAdmin && u?.role !== 'TEACHER') return c.json({ message: '无权限编辑该公告' }, 403)
  } else {
    // 博客：仅作者本人或超管
    if (!isOwner && !isAdmin) return c.json({ message: '只能编辑自己发布的博客' }, 403)
  }
  const b = await c.req.json()
  const fields: string[] = []
  const args: any[] = []
  if (b.title !== undefined) { fields.push('title=?'); args.push(b.title) }
  if (b.content !== undefined) { fields.push('content=?'); args.push(b.content) }
  if (b.cover !== undefined) { fields.push('cover=?'); args.push(b.cover) }
  if (b.images !== undefined) { fields.push('images=?'); args.push(JSON.stringify(b.images)) }
  if (b.attachments !== undefined) { fields.push('attachments=?'); args.push(JSON.stringify(b.attachments)) }
  if (b.classId !== undefined) { fields.push('class_id=?'); args.push(b.classId) }
  // 【v4.4.16】博客论坛化：支持编辑话题标签
  if (b.topicIds !== undefined) {
    const ids = Array.isArray(b.topicIds) ? b.topicIds.map(Number).filter(Boolean) : []
    fields.push('topic_ids=?'); args.push(JSON.stringify(ids))
  }
  if (b.recommendation !== undefined) { fields.push('recommendation=?'); args.push(b.recommendation ?? '') }
  if (!fields.length) return c.json({ ok: true, message: '无修改' })
  fields.push("updated_at=datetime('now','+8 hours')")
  args.push(id)
  await run(`UPDATE pages SET ${fields.join(',')} WHERE id=?`, ...args)
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
  // 删除前直接删除相关的经验值记录
  if (p.author_id && p.title && p.ptype === 'blog') {
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='blog' AND INSTR(description, ?) > 0", p.author_id, p.title)
    // 【v4.11.0】删除日志后按日志和全量重算缓存
    await syncUserExp(p.author_id)
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
// ============ 存储监控 & 文件轻量化优化 API（仅超管） ============
// ==============================================================================

// ------------------------------------------------------------------------------
// 【v4.3.1】文件溯源：反查 D1 各业务表，判断一个 Supabase 文件是从哪个界面上传的
// ------------------------------------------------------------------------------
// 背景：storage 的 object key 只有 3 种前缀（avatar_ / img_ / file_），
//   file_ 被资料上传、编辑器附件、题库附件等共用，光看文件名无法区分来源。
//   实测生产 20 个文件里只有 4 个能关联到 resources，其余全是孤儿 ——
//   溯源的核心价值就是告诉超管「这个文件有没有人引用、能不能删」。
// 做法：把要查的 key 列表拼成 LIKE 条件，让 D1 侧过滤；
//   再把命中的候选记录拉回来，在内存里逐个 key 精确确认归属（避免误判）。
// 复杂度：查询次数 = 固定 7 张表，与文件数量无关。
// ------------------------------------------------------------------------------
interface FileOrigin {
  type: string        // resource / avatar / article / page_blog / page_forum / page_announce / page_guide / quiz / message / comment / orphan
  label: string       // 中文来源名，如「资料上传」
  icon: string
  refId: number | null
  refTitle: string
  detailUrl: string   // 前端可跳转的详情地址
  uploader: string    // 上传人姓名
  subjectName: string
  createdAt: string
  status: string
  confident: boolean  // true = 数据库精确命中；false = 仅按文件名前缀推测
}

async function traceFileOrigins(keys: string[]): Promise<Map<string, FileOrigin>> {
  const out = new Map<string, FileOrigin>()
  const validKeys = (keys || []).filter(Boolean)
  if (!validKeys.length) return out

  // 构造「任意 key 命中任意列」的 WHERE 条件
  const where = (cols: string[]) => cols.map(c => validKeys.map(() => `${c} LIKE ?`).join(' OR ')).join(' OR ')
  const args = (cols: string[]) => cols.flatMap(() => validKeys.map(k => `%${k}%`))

  // 命中后回填：遍历 keys 精确确认是哪一个，避免 LIKE 误判
  const mark = (rec: any, blob: string, o: Omit<FileOrigin, 'refId' | 'refTitle'>, title: string) => {
    if (!blob) return
    for (const k of validKeys) {
      if (out.has(k)) continue          // 先命中的来源优先（下面按可信度顺序查）
      if (blob.includes(k)) out.set(k, { ...o, refId: rec.id ?? null, refTitle: title || '' })
    }
  }

  // 按「可信度从高到低」查，先查到的优先占位
  try {
    // 1) 资料上传（file_path 直接等于 key，最可信）
    const rows = await all<any>(
      `SELECT r.id, r.title, r.file_path, r.status, r.created_at, u.real_name, s.name AS subject_name
       FROM resources r LEFT JOIN users u ON u.id=r.user_id LEFT JOIN subjects s ON s.id=r.subject_id
       WHERE ${where(['r.file_path'])}`, ...args(['r.file_path']))
    for (const r of rows) mark(r, r.file_path || '', {
      type: 'resource', label: '资料上传', icon: '📦', detailUrl: `/resource/${r.id}`,
      uploader: r.real_name || '', subjectName: r.subject_name || '',
      createdAt: r.created_at || '', status: r.status || '', confident: true,
    }, r.title)
  } catch {}

  try {
    // 2) 用户头像
    if (out.size < validKeys.length) {
      const rows = await all<any>(`SELECT id, real_name, avatar, created_at FROM users WHERE ${where(['avatar'])}`, ...args(['avatar']))
      for (const r of rows) mark(r, r.avatar || '', {
        type: 'avatar', label: '用户头像', icon: '👤', detailUrl: `/profile/${r.id}`,
        uploader: r.real_name || '', subjectName: '', createdAt: r.created_at || '',
        status: '', confident: true,
      }, r.real_name || `用户#${r.id}`)
    }
  } catch {}

  // 3) 页面类（博客 / 学科论坛 / 公告 / 使用指南 / 班级页面）
  if (out.size < validKeys.length) {
    try {
      const rows = await all<any>(
        `SELECT p.id, p.ptype, p.title, p.cover, p.images, p.content, p.attachments, p.status, p.created_at, p.author_name, s.name AS subject_name
         FROM pages p LEFT JOIN subjects s ON s.id=p.subject_id
         WHERE ${where(['p.cover', 'p.images', 'p.content', 'p.attachments'])}`,
        ...args(['p.cover', 'p.images', 'p.content', 'p.attachments']))
      const pageMeta: Record<string, { label: string; icon: string; url: string }> = {
        blog: { label: '博客', icon: '✍️', url: '/blog' },
        forum: { label: '学科论坛', icon: '💬', url: '/subject' },
        announcement: { label: '公告', icon: '📢', url: '/announcement' },
        guide: { label: '使用指南', icon: '📖', url: '/guide' },
        class: { label: '班级页面', icon: '🏫', url: '/class' },
      }
      for (const r of rows) {
        const blob = `${r.cover || ''}|${r.images || ''}|${r.content || ''}|${r.attachments || ''}`
        const meta = pageMeta[r.ptype] || { label: `页面(${r.ptype})`, icon: '📄', url: '/pages' }
        mark(r, blob, {
          type: `page_${r.ptype}`, label: meta.label, icon: meta.icon, detailUrl: meta.url,
          uploader: r.author_name || '', subjectName: r.subject_name || '',
          createdAt: r.created_at || '', status: r.status || '', confident: true,
        }, r.title)
      }
    } catch {}
  }

  // 4) 美文（封面 / 配图 / 正文内嵌）
  if (out.size < validKeys.length) {
    try {
      const rows = await all<any>(
        `SELECT a.id, a.title, a.cover, a.images, a.content, a.status, a.created_at, u.real_name, s.name AS subject_name
         FROM articles a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN subjects s ON s.id=a.subject_id
         WHERE ${where(['a.cover', 'a.images', 'a.content'])}`,
        ...args(['a.cover', 'a.images', 'a.content']))
      for (const r of rows) {
        const blob = `${r.cover || ''}|${r.images || ''}|${r.content || ''}`
        mark(r, blob, {
          type: 'article', label: '美文', icon: '📝', detailUrl: `/article/${r.id}`,
          uploader: r.real_name || '', subjectName: r.subject_name || '',
          createdAt: r.created_at || '', status: r.status || '', confident: true,
        }, r.title)
      }
    } catch {}
  }

  // 5) 题库 / 习题附件
  if (out.size < validKeys.length) {
    try {
      const rows = await all<any>(`SELECT id, content, attachments FROM quiz_questions WHERE ${where(['content', 'attachments'])}`, ...args(['content', 'attachments']))
      for (const r of rows) mark(r, `${r.content || ''}|${r.attachments || ''}`, {
        type: 'quiz', label: '题库题目', icon: '❓', detailUrl: '/quiz',
        uploader: '', subjectName: '', createdAt: '', status: '', confident: true,
      }, (r.content || '').slice(0, 30))
    } catch {}
    try {
      const rows2 = await all<any>(`SELECT id, content, attachments FROM subject_questions WHERE ${where(['content', 'attachments'])}`, ...args(['content', 'attachments']))
      for (const r of rows2) mark(r, `${r.content || ''}|${r.attachments || ''}`, {
        type: 'quiz', label: '练习题库', icon: '❓', detailUrl: '/quiz',
        uploader: '', subjectName: '', createdAt: '', status: '', confident: true,
      }, (r.content || '').slice(0, 30))
    } catch {}
  }

  // 6) 站内信附件
  if (out.size < validKeys.length) {
    try {
      const rows = await all<any>(`SELECT id, content, attachments, created_at FROM messages WHERE ${where(['content', 'attachments'])}`, ...args(['content', 'attachments']))
      for (const r of rows) mark(r, `${r.content || ''}|${r.attachments || ''}`, {
        type: 'message', label: '站内信', icon: '✉️', detailUrl: '/messages',
        uploader: '', subjectName: '', createdAt: r.created_at || '', status: '', confident: true,
      }, (r.content || '').slice(0, 30))
    } catch {}
  }

  // 7) 评论附件（美文评论 / 页面评论）
  if (out.size < validKeys.length) {
    try {
      const rows = await all<any>(`SELECT id, content, attachments FROM article_comments WHERE ${where(['content', 'attachments'])}`, ...args(['content', 'attachments']))
      for (const r of rows) mark(r, `${r.content || ''}|${r.attachments || ''}`, {
        type: 'comment', label: '美文评论', icon: '💭', detailUrl: '/article',
        uploader: '', subjectName: '', createdAt: '', status: '', confident: true,
      }, (r.content || '').slice(0, 30))
    } catch {}
    try {
      const rows2 = await all<any>(`SELECT id, content, attachments FROM page_comments WHERE ${where(['content', 'attachments'])}`, ...args(['content', 'attachments']))
      for (const r of rows2) mark(r, `${r.content || ''}|${r.attachments || ''}`, {
        type: 'comment', label: '页面评论', icon: '💭', detailUrl: '/blog',
        uploader: '', subjectName: '', createdAt: '', status: '', confident: true,
      }, (r.content || '').slice(0, 30))
    } catch {}
  }

  // 兜底：数据库里完全查不到 → 按文件名前缀推测，并标记为「未关联」
  const guessByPrefix = (k: string): { label: string; icon: string; type: string } => {
    if (/^avatar_/.test(k)) return { label: '头像（未关联）', icon: '👤', type: 'avatar_orphan' }
    if (/^img_/.test(k)) return { label: '编辑器图片（未关联）', icon: '🖼️', type: 'img_orphan' }
    if (/^file_/.test(k)) return { label: '上传文件（未关联）', icon: '📄', type: 'file_orphan' }
    return { label: '未知来源', icon: '❓', type: 'unknown' }
  }
  for (const k of validKeys) {
    if (out.has(k)) continue
    const g = guessByPrefix(k)
    out.set(k, {
      type: g.type, label: g.label, icon: g.icon, refId: null, refTitle: '',
      detailUrl: '', uploader: '', subjectName: '', createdAt: '', status: '',
      confident: false,
    })
  }
  return out
}

// 【v4.4.10】按 file_id / object_key / original_name 解析文件元数据（B2/Supabase 通用）
async function resolveFileMeta(key: string): Promise<any | null> {
  if (!key) return null
  // 1) file_id（最精确，前端大体积列表的 fileId 也走这里）
  let m = await get<any>('SELECT * FROM file_meta WHERE file_id=?', key)
  if (m) return m
  // 2) object_key（含路径，如 resource/xxx.pdf）
  m = await get<any>('SELECT * FROM file_meta WHERE object_key=?', key)
  if (m) return m
  // 3) original_name（非唯一，取最近一个，用于老前端传文件名的兼容）
  const rows = await all<any>('SELECT * FROM file_meta WHERE original_name=? ORDER BY created_at DESC LIMIT 1', key).catch(() => [])
  return rows && rows.length ? rows[0] : null
}

// ==============================================================================
// 【v4.3.2】GET /api/admin/storage/file?key=xxx&mode=preview|download
//   超管专用：直接按存储 key 预览/下载文件（含「数据库查不到归属」的孤儿文件）
//   与下面的 DELETE /api/admin/storage/file 同路径不同 method，Hono 按 method 分发，互不干扰。
//   前端用 fetch + Blob 方式取流，token 走 Authorization header，URL 里不会出现 token。
// 【v4.4.10】B2 化：key 支持 file_id / object_key / original_name 三种解析；
//   B2 文件走 b2DownloadStream（私有桶授权下载 + CF 边缘缓存），Supabase 孤儿回退 downloadFile。
// ==============================================================================
app.get('/api/admin/storage/file', auth, requirePerm('monitor'), async (c) => {
  const rawKey = (c.req.query('key') || '').trim()
  const mode = c.req.query('mode') === 'download' ? 'download' : 'preview'
  if (!rawKey) return c.json({ message: '缺少文件 key' }, 400)
  // 防路径穿越：禁止 .. 与绝对路径
  if (rawKey.includes('..') || rawKey.startsWith('/') || rawKey.startsWith('\\')) {
    return c.json({ message: '非法的文件路径' }, 400)
  }
  const meta = await resolveFileMeta(rawKey)
  if (!meta) return c.json({ message: '文件不存在或已被删除' }, 404)

  // B2 后端：授权流式下载（私有桶也可取，CF 边缘缓存提速）
  if (meta.backend === 'b2' && meta.object_key) {
    const upstream = await b2DownloadStream(meta.object_key, Number(CACHE_TTL_PUBLIC) || 86400).catch(() => null)
    if (!upstream || !upstream.ok) return c.json({ message: '文件不存在或已被删除' }, 404)
    const maxBytes = Number(upstream.headers.get('Content-Length') || 0)
    const MAX_SIZE = 50 * 1024 * 1024
    if (maxBytes > MAX_SIZE) {
      return c.json({ message: `文件过大（${(maxBytes / 1024 / 1024).toFixed(1)}MB），超过 50MB 无法在线预览/下载` }, 413)
    }
    const ct = upstream.headers.get('Content-Type') || guessContentType(meta.object_key)
    const filename = (meta.original_name || meta.object_key.split('/').pop() || meta.object_key).replace(/"/g, '')
    const encoded = encodeURIComponent(filename)
    const disposition = (mode === 'download' ? 'attachment' : 'inline') + `; filename="${encoded}"; filename*=UTF-8''${encoded}`
    const headers = new Headers()
    headers.set('Content-Type', ct)
    headers.set('Content-Disposition', disposition)
    if (maxBytes) headers.set('Content-Length', String(maxBytes))
    headers.set('Cache-Control', 'no-store')
    headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length')
    return new Response(upstream.body, { status: 200, headers })
  }

  // 兜底：Supabase 孤儿文件
  const safeKey = extractKey(meta.object_key || rawKey)
  if (!safeKey || !getSupabase()) return c.json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' }, 500)
  const file = await downloadFile(safeKey)
  if (!file) return c.json({ message: '文件不存在或已被删除' }, 404)
  const size = file.buffer.byteLength
  const MAX_SIZE = 50 * 1024 * 1024
  if (size > MAX_SIZE) {
    return c.json({ message: `文件过大（${(size / 1024 / 1024).toFixed(1)}MB），超过 50MB 无法在线预览/下载` }, 413)
  }
  const ct = file.contentType || guessContentType(safeKey)
  const filename = (safeKey.split('/').pop() || safeKey).replace(/"/g, '')
  const encoded = encodeURIComponent(filename)
  const disposition = mode === 'download'
    ? `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`
    : `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`
  return new Response(file.buffer, {
    headers: {
      'Content-Type': ct,
      'Content-Disposition': disposition,
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': c.req.header('Origin') || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
    },
  })
})


// 文件优化：批量处理大体积文件（标记优化状态）
app.post('/api/admin/storage/optimize', auth, requirePerm('monitor'), async (c) => {
  const { action } = await c.req.json()
  // action: 'list' | 'optimize_images' | 'clean_orphaned' | 'purge_cache'

  if (action === 'purge_cache') {
    // 清除所有文件缓存
    HOT_FILE_CACHE.clear()
    try {
      // 边缘缓存按 key 逐个删除
      const resources = await all<any>('SELECT id FROM resources WHERE status=?', 'approved')
      await Promise.all(resources.map(r =>
        EDGE_CACHE.delete(fileCacheRequest(r.id, 'download')).catch(() => {})
      ))
    } catch {}
    return c.json({ ok: true, message: '已清除所有文件缓存' })
  }

  if (action === 'clean_orphaned') {
    // v4.4.1：Supabase 已废弃 —— 孤立文件判定改为扫 D1 file_meta（B2 口径）
    //   孤立 = file_meta 里有记录，但 D1 中没有任何表的字段引用这个 /api/file/{fileId}
    const referenced = new Set<string>()
    const scanFields: Array<[string, string]> = [
      ['resources', 'file_path'], ['users', 'avatar'],
      ['articles', 'cover'], ['articles', 'images'],
      ['pages', 'cover'], ['pages', 'images'], ['pages', 'attachments'],
      ['messages', 'attachments'],
      ['quiz_questions', 'attachments'], ['subject_questions', 'attachments'],
    ]
    for (const [t, col] of scanFields) {
      const rows = await all<any>(`SELECT ${col} AS v FROM ${t} WHERE ${col} LIKE '%/api/file/%' LIMIT 5000`).catch(() => [])
      for (const r of rows) {
        const m = String(r.v || '').match(/\/api\/file\/[A-Za-z0-9]+/g)
        if (m) for (const s of m) referenced.add(s.replace('/api/file/', ''))
      }
    }
    const metas = await all<any>('SELECT file_id, b2_file_id, object_key, size, backend FROM file_meta').catch(() => [])
    const orphanedFiles = metas.filter((f) => !referenced.has(f.file_id))
    let cleanedCount = 0
    let cleanedSize = 0
    for (const f of orphanedFiles) {
      try {
        if (f.backend === 'b2' && f.b2_file_id && f.object_key) await b2Delete(f.object_key, f.b2_file_id)
        await run('DELETE FROM file_meta WHERE file_id=?', f.file_id)
        cleanedCount++
        cleanedSize += f.size || 0
      } catch {}
    }
    // 清理后清空监控缓存，保证前端列表即时刷新
    clearAllCache()
    return c.json({
      ok: true,
      message: `已清理 ${cleanedCount} 个孤立文件，释放 ${fmtBytes(cleanedSize)} 空间`,
      cleanedCount, cleanedSize, cleanedSizeFmt: fmtBytes(cleanedSize),
    })
  }

  if (action === 'list') {
    // v4.4.1：优化建议改为基于 D1 file_meta（B2 口径），不再 list Supabase 桶
    const metas = await all<any>(
      `SELECT file_id, original_name, size, mime, is_convert_webp, purpose, created_at
       FROM file_meta ORDER BY size DESC LIMIT 200`).catch(() => [])
    const suggestions = metas
      .filter((f) => {
        const big = (f.size || 0) > 1024 * 1024                        // > 1MB
        const imgNotWebp = /^image\//.test(f.mime || '') && !/webp/.test(f.mime || '') && !f.is_convert_webp
        return big || imgNotWebp
      })
      .map((f) => ({
        fileId: f.file_id,
        name: f.original_name || f.file_id,
        size: f.size || 0,
        sizeFmt: fmtBytes(f.size || 0),
        mime: f.mime || '',
        isConvertWebp: !!f.is_convert_webp,
        reason: /^image\//.test(f.mime || '') && !/webp/.test(f.mime || '')
          ? '图片未使用 WebP，转码后体积通常可降 60% 以上'
          : '文件体积偏大，建议压缩或拆分',
        // 保守估算：图片按 60% 计，其它按 30% 计（仅作提示，非精确值）
        potentialSaving: Math.round((f.size || 0) * (/^image\//.test(f.mime || '') ? 0.6 : 0.3)),
      }))
    const totalPotentialSaving = suggestions.reduce((sum, s) => sum + s.potentialSaving, 0)
    return c.json({
      suggestions,
      totalPotentialSaving,
      totalPotentialSavingFmt: fmtBytes(totalPotentialSaving),
      count: suggestions.length,
    })
  }

  return c.json({ message: '未知操作' }, 400)
})

// 删除指定存储文件（超管专用，支持预览后删除）
// 【v4.4.10】B2 化：fileName 支持 file_id / object_key / original_name；
//   B2 文件真正调用 b2Delete 删除对象 + 清理 file_meta 行，Supabase 孤儿回退 deleteFile。
app.delete('/api/admin/storage/file', auth, requirePerm('monitor'), async (c) => {
  const { fileName } = await c.req.json()
  if (!fileName) return c.json({ message: '缺少文件名' }, 400)

  // 解析文件元数据（兼容前端传 original_name / file_id）
  const meta = await resolveFileMeta(fileName)
  if (!meta) return c.json({ message: '文件不存在或已被删除' }, 404)

  // 删除存储后端中的真实对象
  try {
    if (meta.backend === 'b2' && meta.object_key && meta.b2_file_id) {
      await b2Delete(meta.object_key, meta.b2_file_id)
    } else {
      await deleteFile(meta.object_key || meta.file_id)
    }
  } catch (e: any) {
    return c.json({ message: '删除文件失败: ' + (e.message || ''), error: true }, 500)
  }

  // 查找并清除关联的资源记录引用
  const linked = await get<any>('SELECT id, title, file_path, status FROM resources WHERE file_path LIKE ? LIMIT 1', `%${meta.file_id}%`)
  let resourceCleared = false
  if (linked) {
    await run('UPDATE resources SET file_path = NULL WHERE id = ?', linked.id)
    resourceCleared = true
    // 清除该资源的文件缓存
    try {
      HOT_FILE_CACHE.delete(`${linked.id}:download`)
      HOT_FILE_CACHE.delete(`${linked.id}:preview`)
      await EDGE_CACHE.delete(fileCacheRequest(linked.id, 'download')).catch(() => {})
      await EDGE_CACHE.delete(fileCacheRequest(linked.id, 'preview')).catch(() => {})
    } catch {}
  }

  // 删除 file_meta 元数据行（彻底从「大体积文件排行」等列表中移除）
  try { await run('DELETE FROM file_meta WHERE file_id=?', meta.file_id) } catch {}

  clearAllCache()
  return c.json({
    ok: true,
    message: `文件「${meta.original_name || meta.file_id}」已删除${resourceCleared ? `，关联资源「${linked.title}」的文件引用已清除` : ''}`,
    resourceCleared,
    resourceId: linked?.id || null,
    resourceTitle: linked?.title || '',
  })
})

// 获取缓存统计信息
app.get('/api/admin/cache/stats', auth, requirePerm('monitor'), async (c) => {
  let totalHotSize = 0
  let totalHotHits = 0
  const hotFileDetails: any[] = []
  for (const [k, v] of HOT_FILE_CACHE) {
    totalHotSize += v.size
    totalHotHits += v.hits
    hotFileDetails.push({
      key: k,
      size: v.size,
      sizeFmt: fmtBytes(v.size),
      hits: v.hits,
      expireIn: Math.max(0, Math.floor((v.expireAt - Date.now()) / 1000)) + 's',
    })
  }
  hotFileDetails.sort((a, b) => b.hits - a.hits)
  return c.json({
    hotFileCache: {
      count: HOT_FILE_CACHE.size,
      maxSize: HOT_FILE_MAX,
      totalSize: totalHotSize,
      totalSizeFmt: fmtBytes(totalHotSize),
      totalHits: totalHotHits,
      files: hotFileDetails.slice(0, 10),
    },
    apiCache: {
      count: API_CACHE.size,
      maxSize: API_CACHE_MAX,
    },
    version: FILE_CACHE_VERSION,
  })
})

// ==============================================================================
// ============ 需求5：超管网站运行监控（增强版 - 双库全覆盖） ============
// ==============================================================================
// ==============================================================================
// 🔧 v4.4.0 存储管理端点（超管）
// ==============================================================================

// 当前存储后端模式 + 配额/限速配置概览
app.get('/api/admin/storage/config', auth, requirePerm('monitor'), async (c) => {
  return c.json({
    backendMode: (STORAGE_BACKEND || 'B2_FREE').toUpperCase(),
    b2Configured: !!(B2_KEY_ID && B2_APPLICATION_KEY && B2_BUCKET_ID),
    b2BucketName: B2_BUCKET_NAME || '',
    quotaAlert: Number(B2_QUOTA_ALERT || 2200),
    userDailyOriginLimit: Number(B2_USER_DAILY_ORIGIN_LIMIT || 100),
    cacheTtlPublic: Number(CACHE_TTL_PUBLIC || 86400),
    cacheTtlWebp: Number(CACHE_TTL_WEBP || 2592000),
    note: '付费模式(B2_PAID)仅允许人工修改 STORAGE_BACKEND 环境变量开启；代码永不自动切换。',
  })
})

// B2 存储监控数据（供管理后台 B2 监控模块拉取）
// v4.4.1：只读 D1 快照，不发起任何 B2 请求（避免刷面板烧掉 Class C 交易）
app.get('/api/admin/storage/monitor', auth, requirePerm('monitor'), async (c) => {
  const data = await getStorageMonitor().catch((e) => ({ error: String(e?.message || e) }))
  return c.json(data)
})

// B2 官方容量盘点：实时调用 b2_list_file_names 全量列举求和（**消耗 Class A 交易**）
// 每日最多一次（force=true 可强制重扫）。这是本账户唯一能拿到官方容量的途径
// （b2_get_account_info 实测 404；b2_list_buckets 响应不含 fileCount/totalSize）。
app.post('/api/admin/storage/census', auth, requirePerm('monitor'), async (c) => {
  const { force } = await c.req.json().catch(() => ({}))
  try {
    const r = await runBucketCensus(!!force)
    return c.json({ ok: true, ...r })
  } catch (e: any) {
    return c.json({ ok: false, message: String(e?.message || e).slice(0, 200) }, 500)
  }
})

// v4.4.2 官方每日实耗（来自 B2 控制台，管理员手动核对录入）
// GET 返回当日（或最近一天）官方数字；POST 保存当日数字。
// 由于 B2 免费账户不暴露官方交易计数 API，此数据是「人工核对」而非程序拉取。
app.get('/api/admin/storage/official', auth, requirePerm('monitor'), async (c) => {
  const day = c.req.query('day')
  const off = await getOfficialDaily(day || undefined).catch(() => null)
  return c.json({ ok: true, official: off })
})

app.post('/api/admin/storage/official', auth, requirePerm('monitor'), async (c) => {
  const p = await c.req.json().catch(() => ({}))
  try {
    const saved = await setOfficialDaily({
      bClass: Number(p.bClass) || 0,
      cClass: Number(p.cClass) || 0,
      storageBytes: Number(p.storageBytes) || 0,
      downloadBytes: Number(p.downloadBytes) || 0,
    })
    return c.json({ ok: true, official: saved })
  } catch (e: any) {
    return c.json({ ok: false, message: String(e?.message || e).slice(0, 200) }, 500)
  }
})

// 管理员预热：把高频文件推送到 CF 边缘缓存
app.post('/api/admin/prewarm', auth, requirePerm('monitor'), async (c) => {
  const { fileIds } = await c.req.json()
  if (!Array.isArray(fileIds) || !fileIds.length) return c.json({ message: '缺少 fileIds' }, 400)
  const operator = c.get('user').id
  const results = []
  for (const fid of fileIds.slice(0, 50)) {
    const r = await prewarmFile(String(fid), operator)
    results.push({ fileId: fid, ...r })
  }
  return c.json({ ok: true, results })
})

// 存量迁移：Supabase → B2（全量、幂等、自动改写 D1 引用）
// v4.4.1 重写：旧版从 D1 查 `file_path LIKE '%supabase%'` —— 一条都匹配不到
//   （D1 里存的是纯文件名，不含 "supabase" 字样），导致迁移永远 total=0。
//   新版直接全量列举 Supabase 桶，逐个搬迁并改写引用，重复执行安全。
// 参数：limit（本批处理数量，默认 20）/ only（只迁某个 key，模糊匹配）/ dryRun（只盘点不搬迁）
app.post('/api/admin/migrate/to-b2', auth, requirePerm('monitor'), async (c) => {
  const { limit, only, dryRun } = await c.req.json().catch(() => ({}))
  const res = await migrateToB2({
    limit: limit ? Number(limit) : undefined,
    only: only || undefined,
    dryRun: !!dryRun,
  })
  return c.json({ ok: true, ...res })
})

// 迁移进度查询（不搬迁，只汇报已迁多少 / 还剩多少）
app.get('/api/admin/migrate/status', auth, requirePerm('monitor'), async (c) => {
  const done = await get<{ n: number; sz: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS sz FROM b2_migration_log`).catch(() => ({ n: 0, sz: 0 }))
  const last = await all<any>(
    `SELECT source_key, file_id, size, refs_updated, created_at FROM b2_migration_log
     ORDER BY id DESC LIMIT 20`).catch(() => [])
  return c.json({
    ok: true,
    migratedFiles: done?.n || 0,
    migratedBytes: done?.sz || 0,
    migratedBytesFmt: fmtBytes(done?.sz || 0),
    recent: last || [],
  })
})

app.get('/api/admin/monitor', auth, requirePerm('monitor'), async (c) => {
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
  let d1PageCount = 0
  let d1PageSize = 4096
  let d1FreePages = 0
  try {
    const [pc, ps, fp] = await D1.batch([
      D1.prepare('PRAGMA page_count'),
      D1.prepare('PRAGMA page_size'),
      D1.prepare('PRAGMA freelist_count'),
    ])
    d1PageCount = (pc?.results?.[0] as any)?.page_count || 0
    d1PageSize = (ps?.results?.[0] as any)?.page_size || 4096
    d1FreePages = (fp?.results?.[0] as any)?.freelist_count || 0
    dbSize = d1PageCount * d1PageSize
  } catch {}

  // D1 各表详细统计（含数据行大小估算）
  const d1TableDetails = tables.map((t, i) => {
    const rows = tableStats[t] || 0
    return { table: t, rows, avgRowsPerKB: rows > 0 ? (rows / Math.max(dbSize / 1024, 1)).toFixed(2) : '0' }
  })

  // D1 空数据表统计（行数为0的表）
  const emptyTables = d1TableDetails.filter(t => t.rows === 0).map(t => t.table)

  // v4.4.1：Supabase Storage 已废弃 —— 移除对 Supabase 的 list / 统计调用。
  //   旧实现每次打开监控页都会 list 整个 Supabase 桶，既慢又已无业务意义；
  //   存储口径统一改为 B2（读 D1 官方盘点快照，零外部调用、不烧交易类别）。
  const [b2Monitor, hotCacheStats] = await Promise.all([
    getStorageMonitor().catch(() => null),
    Promise.resolve().then(() => {
      let totalSize = 0, totalHits = 0
      for (const [, v] of HOT_FILE_CACHE) { totalSize += v.size; totalHits += v.hits }
      return { count: HOT_FILE_CACHE.size, totalSize, totalHits }
    }),
  ])

  // B2 容量：已用取自官方盘点快照；上限为 B2 免费档位常量（API 取不到，已实测 404）
  const b2Used = b2Monitor?.usedBytes || 0
  const b2Cap = b2Monitor?.capacityBytes || (10 * 1024 * 1024 * 1024)
  const storageUsedPercent = b2Cap ? (b2Used / b2Cap) * 100 : 0
  const storageRemaining = Math.max(b2Cap - b2Used, 0)

  // 大体积文件 TOP 10：直接查 D1 file_meta（本地元数据，零外部调用）
  const topRawFiles = await all<any>(
    `SELECT file_id, original_name, size, mime, purpose, is_public, created_at
     FROM file_meta ORDER BY size DESC LIMIT 10`).catch(() => [])
  const monitorResources = await all<any>(
    `SELECT id, title, file_path, status FROM resources WHERE file_path LIKE '/api/file/%'`).catch(() => [])
  const monitorResourceByFid = new Map<string, any>()
  for (const r of monitorResources) {
    const m = /^\/api\/file\/([A-Za-z0-9]+)/.exec(r.file_path || '')
    if (m) monitorResourceByFid.set(m[1], r)
  }
  // 【v4.4.12】全表引用扫描：与 clean_orphaned 完全一致，使前端「未关联」标签 = 一键清理实际会删的文件，
  //   避免「列表标了 N 个未关联，点清理却没清掉（其实被文章/留言/页面引用着）」的误导。
  const referencedSet = new Set<string>()
  const refScanFields: Array<[string, string]> = [
    ['resources', 'file_path'], ['articles', 'cover'], ['articles', 'images'],
    ['pages', 'cover'], ['pages', 'images'], ['pages', 'attachments'],
    ['messages', 'attachments'], ['quiz_questions', 'attachments'], ['subject_questions', 'attachments'],
  ]
  for (const [t, col] of refScanFields) {
    const rows = await all<any>(`SELECT ${col} AS v FROM ${t} WHERE ${col} LIKE '%/api/file/%' LIMIT 5000`).catch(() => [])
    for (const r of rows) {
      const m = String(r.v || '').match(/\/api\/file\/[A-Za-z0-9]+/g)
      if (m) for (const s of m) referencedSet.add(s.replace('/api/file/', ''))
    }
  }
  const topStorageFiles = topRawFiles.map(f => {
    const linked = monitorResourceByFid.get(f.file_id)
    return {
      name: f.original_name || f.file_id,
      fileId: f.file_id,
      size: f.size || 0, sizeFmt: fmtBytes(f.size || 0),
      mime: f.mime || '', purpose: f.purpose || '',
      resourceId: linked?.id || null,
      resourceTitle: linked?.title || '',
      resourceStatus: linked?.status || '',
      hasResource: !!linked,
      // 全表扫描后仍无任何引用 → 真正的孤儿文件（与 clean_orphaned 判定一致）
      isOrphan: !referencedSet.has(f.file_id),
    }
  })

  // 高频访问资源 TOP 10
  const hotDownloadResources = await all<any>(
    'SELECT id, title, file_name, file_size, downloads FROM resources WHERE downloads > 0 ORDER BY downloads DESC LIMIT 10'
  ).catch(() => [])

  // 当日上传/删除流量
  const todayUploadStats = await get<{ cnt: number; sz: number }>(
    `SELECT COUNT(*) as cnt, COALESCE(SUM(file_size),0) as sz FROM resources WHERE substr(created_at,1,10)=?`, today
  ).catch(() => ({ cnt: 0, sz: 0 }))

  // ===== 统一告警判断 =====
  const alerts: any[] = []
  // D1 容量告警
  const d1Limit = 500 * 1024 * 1024 // 500MB
  const d1UsedPercent = (dbSize / d1Limit) * 100
  if (d1UsedPercent > 80) {
    alerts.push({ level: 'danger', source: 'D1', message: `D1数据库已使用 ${d1UsedPercent.toFixed(1)}%，接近500MB上限` })
  }
  // ===== B2 存储告警（v4.4.1：Supabase 已废弃，口径全部改为 B2）=====
  if (storageUsedPercent > 80) {
    alerts.push({ level: 'danger', source: 'B2存储', message: `B2 存储已使用 ${storageUsedPercent.toFixed(1)}%，接近 10GB 免费档上限！` })
  } else if (storageUsedPercent > 60) {
    alerts.push({ level: 'warning', source: 'B2存储', message: `B2 存储已使用 ${storageUsedPercent.toFixed(1)}%，建议优化` })
  }
  // B2 回源配额告警（本地真实回源统计，非官方数字，已在面板标注）
  if (b2Monitor?.quotaAlerted) {
    alerts.push({ level: 'warning', source: 'B2回源', message: `今日 B2 回源 ${b2Monitor.quotaToday} 次，已达告警阈值 ${b2Monitor.quotaAlert}（本地统计·非官方）` })
  }
  if (b2Monitor?.quotaExhausted) {
    alerts.push({ level: 'danger', source: 'B2回源', message: `今日 B2 回源已达免费上限 ${b2Monitor.bClassFreeCap} 次，新文件将暂时拒绝回源` })
  }
  // 缓存命中率告警：命中率低说明大部分请求在跨太平洋回源，用户会明显感觉慢
  if (b2Monitor && b2Monitor.hitCount + b2Monitor.missCount >= 20 && b2Monitor.cacheHitRate < 50) {
    alerts.push({ level: 'info', source: 'B2缓存', message: `B2 缓存命中率仅 ${b2Monitor.cacheHitRate}%（回源均耗时 ${b2Monitor.missAvgMs}ms）。建议对高频文件执行「预热」以提升下载速度` })
  }
  // 空表告警
  if (emptyTables.length > 0) {
    alerts.push({ level: 'info', source: 'D1', message: `${emptyTables.length} 张数据表行数为0（${emptyTables.join(', ')}），可考虑清理` })
  }
  // 缓存命中率告警
  if (hotCacheStats.count === 0 && todayRow.resources > 0) {
    alerts.push({ level: 'info', source: '缓存', message: '热点文件缓存为空，首次访问可能较慢' })
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
    // ===== D1 数据库监控（增强） =====
    database: {
      fileSize: dbSize, fileSizeFmt: fmtBytes(dbSize),
      tables: tableStats,
      pageCount: d1PageCount, pageSize: d1PageSize,
      freePages: d1FreePages,
      freeSpace: d1FreePages * d1PageSize,
      freeSpaceFmt: fmtBytes(d1FreePages * d1PageSize),
      usedPercent: d1UsedPercent.toFixed(1),
      tableCount: tables.length,
      totalRows: Object.values(tableStats).reduce((s: number, n: any) => s + Number(n), 0),
      emptyTables,
      tableDetails: d1TableDetails,
    },
    // ===== Supabase 数据库：已废弃（v4.4.1）=====
    // 本项目主库为 Cloudflare D1，Supabase 仅曾用于对象存储且现已废弃。
    // 保留字段是为了让旧前端不报错；不再发起任何 Supabase 请求。
    supabaseDb: {
      deprecated: true,
      configured: !!SUPABASE_URL,
      note: 'Supabase 数据库未启用（本项目主库为 Cloudflare D1），此项仅作兼容占位',
    },
    // ===== B2 存储监控（v4.4.1：替代原 Supabase Storage 监控）=====
    supabaseStorage: null,   // 显式置空，提示前端不要再渲染 Supabase 卡片
    b2Storage: {
      backend: b2Monitor?.backendMode || (STORAGE_BACKEND || 'B2_FREE').toUpperCase(),
      bucket: b2Monitor?.b2?.bucketName || B2_BUCKET_NAME || '',
      bucketType: b2Monitor?.b2?.bucketType || 'allPrivate',
      totalFiles: b2Monitor?.b2?.fileCount ?? null,
      totalSize: b2Used,
      totalSizeFmt: fmtBytes(b2Used),
      capacity: b2Cap,
      capacityFmt: '10 GB',
      capacityNote: b2Monitor?.capacityNote || 'B2 免费档位 10 GB（以 B2 控制台 Billing 页为准）',
      usedPercent: storageUsedPercent.toFixed(1),
      remaining: storageRemaining,
      remainingFmt: fmtBytes(storageRemaining),
      // 官方盘点快照元信息（用于告诉管理员数据有多新鲜）
      censusDay: b2Monitor?.b2?.censusDay || null,
      censusStale: !!b2Monitor?.b2?.censusStale,
      censusSource: b2Monitor?.b2?.censusSource || 'NOT_SCANNED',
      // 回源 / 缓存 / 配额
      quotaToday: b2Monitor?.quotaToday ?? 0,
      quotaSource: b2Monitor?.quotaSource || 'LOCAL_NON_OFFICIAL',
      quotaNote: b2Monitor?.quotaNote || '',
      quotaAlert: b2Monitor?.quotaAlert ?? 2200,
      quotaExhausted: !!b2Monitor?.quotaExhausted,
      bClassFreeCap: b2Monitor?.bClassFreeCap ?? 2500,
      cacheHitRate: b2Monitor?.cacheHitRate ?? 0,
      hitCount: b2Monitor?.hitCount ?? 0,
      missCount: b2Monitor?.missCount ?? 0,
      hitAvgMs: b2Monitor?.hitAvgMs ?? 0,
      missAvgMs: b2Monitor?.missAvgMs ?? 0,
      originTop: b2Monitor?.originTop || [],
      webpCount: b2Monitor?.webpCount ?? 0,
      webpSize: b2Monitor?.webpSize ?? 0,
      migration: b2Monitor?.migration || null,
      topFiles: topStorageFiles,
      todayUploads: todayUploadStats?.cnt || 0,
      todayUploadSize: todayUploadStats?.sz || 0,
      todayUploadSizeFmt: fmtBytes(todayUploadStats?.sz || 0),
      hotResources: (hotDownloadResources || []).map((r: any) => ({
        ...r, fileSizeFmt: fmtBytes(r.file_size || 0),
      })),
    },
    // ===== 缓存监控 =====
    cache: {
      hotFile: {
        count: hotCacheStats.count,
        maxCount: HOT_FILE_MAX,
        totalSize: hotCacheStats.totalSize,
        totalSizeFmt: fmtBytes(hotCacheStats.totalSize),
        totalHits: hotCacheStats.totalHits,
      },
      api: {
        count: API_CACHE.size,
        maxCount: API_CACHE_MAX,
      },
      edgeCache: 'Cloudflare Cache API (边缘节点级)',
    },
    // ===== 统一告警 =====
    alerts,
    // ===== 平台信息 =====
    platform: {
      runtime: 'Cloudflare Workers', colo: cf?.colo || 'N/A', country: cf?.country || 'N/A',
      httpProtocol: cf?.httpProtocol || 'HTTP/2', tlsVersion: cf?.tlsVersion || 'TLSv1.3',
      isEdge: true, d1Region: 'WNAM', d1SizeLimit: '500 MB (免费套餐)',
      workerCpuLimit: '10ms CPU/请求 (免费套餐)', workerSubrequests: '50 子请求/请求',
    },
    subjectDist,
    roleDist: roleDist.map(r => ({ name: roleName(r.role), value: r.n })),
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
// 【v4.9.0 性能专项】Cron 预热 —— 消除「冷启动 8 秒」
//
// 现象（生产实测，curl 连打同一接口）：
//   home:      1.55s / 9.44s / 0.79s
//   exp_rules: 7.68s / 0.72s / 0.49s
//   themes/active: 0.63s / 11.15s / 9.07s / ...
//   → **同一个接口**耗时在 0.7s ~ 11s 之间剧烈跳动。
//
// 根因：Cloudflare 会在无流量时回收 Worker isolate / D1 连接。
//   下一个请求需要重建隔离环境 + 重新建立 D1 连接，这一跳就是 7~10s。
//   （D1 查询本身的 sql_duration_ms 只有 0.16~0.29ms，慢的不是 SQL。）
//
// 修法：用 Cron Trigger 每 **4 分钟**主动打一次关键接口，
//   让 isolate 与 D1 连接始终保持温热 → 用户永远遇不到冷启动。
//
// 为什么是 4 分钟：CF 对 Worker isolate 的保活窗口通常在数分钟量级，
//   4 分钟足够覆盖；且每 4 分钟 1 次 × 1440 分钟 = 每天 360 次调用，
//   相对免费版 10 万次/日额度可忽略不计。
//
// ⚠️ 免费版限制：每账户最多 5 个 Cron Trigger，最小粒度 1 分钟。
//   本配置只占 1 个，符合「全免费、不绑卡」铁律。
// ⚠️ Cron Trigger **没有重试与告警**，失败就等下一次 —— 对"预热"这类
//   幂等且低价值的任务完全可接受。
async function warmupCriticalPaths(env: any, origin: string) {
  // 只预热「公共只读且首屏必需」的接口；带个人数据的接口不适合预热（需要 token）
  const paths = [
    '/api/themes/active',          // 主题：首屏皮肤，实测最不稳（0.6~11.8s）
    '/api/settings/site_config',   // 站点配置：首页/导航依赖
    '/api/settings/exp_rules',     // 经验规则：实测最慢（8s）
    '/api/subjects',               // 学科列表
    '/api/feature-flags/public',   // 功能开关
  ]
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const res = await fetch(origin + p, {
        headers: { 'User-Agent': 'zg-warmup/1.0' },
        // 预热请求应当**真的回源**，因此带上 no-cache 语义
        cf: { cacheTtl: 0, cacheEverything: false },
      } as any)
      return `${p}=${res.status}`
    })
  )
  const summary = results
    .map((r) => (r.status === 'fulfilled' ? r.value : 'ERR'))
    .join(' ')
  console.log('[warmup] ' + summary)
}

const workerHandler = {
  fetch: app.fetch,
  async scheduled(event: any, env: any, ctx: any) {
    // 预热用的 origin 从请求本身推导（Cron 事件的 event 不带 URL）
    const origin = (env && env.PUBLIC_ORIGIN) || 'https://api.xkzg.de5.net'
    ctx.waitUntil(warmupCriticalPaths(env, origin))
  },
}

export default workerHandler
