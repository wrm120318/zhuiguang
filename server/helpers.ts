import { run, all, get } from './db'

// 经验规则缓存（启动后首次 addExp 时加载；管理员改规则后调用 refreshExpRules）
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

// 给指定行为加分。change 为 undefined 时，按规则表查 actionType 对应的经验值；传数字直接用
export async function addExp(userId: number, change: number | undefined, actionType: string, desc: string) {
  let delta = change
  if (delta === undefined) {
    const rules = await getExpRules()
    delta = rules[actionType] ?? 0
  }
  if (!delta) return
  await run('UPDATE users SET exp = exp + ?, level = (exp / 60) + 1 WHERE id = ?', delta, userId)
  await run('INSERT INTO exp_logs (user_id,action_type,exp_change,description) VALUES (?,?,?,?)', userId, actionType, delta, desc)
}

export async function addNotice(userId: number, title: string, content: string, type: string, targetUrl?: string) {
  await run('INSERT INTO notices (user_id,title,content,type,target_url) VALUES (?,?,?,?,?)', userId, title, content, type, targetUrl || null)
}

// 用户所在班级 ids
export async function userClassIds(userId: number): Promise<number[]> {
  const rows = await all<{ class_id: number }>('SELECT class_id FROM class_members WHERE user_id = ?', userId)
  return rows.map(r => r.class_id)
}

// 用户任教的 subject ids（教师）
export async function teachingSubjects(userId: number): Promise<number[]> {
  const rows = await all<{ subject_id: number }>('SELECT DISTINCT subject_id FROM class_members WHERE user_id = ? AND role_in_class = ? AND subject_id IS NOT NULL', userId, 'TEACHER')
  return rows.map(r => r.subject_id)
}

// 功能开关缓存
let flagsCache: Record<string, boolean> | null = null
export async function getFeatureFlags(): Promise<Record<string, boolean>> {
  if (flagsCache) return flagsCache
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='feature_flags'")
    flagsCache = r ? JSON.parse(r.value) : {}
    // Bug5: 合并 KV 表中的 registration_enabled 注册开关（后端 KV 是权威源）
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
