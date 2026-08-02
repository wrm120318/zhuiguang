import { run, all, get } from './db'

// 经验规则缓存（启动后首次 addExp 时加载；管理员改规则后调用 refreshExpRules）
let expRulesCache: Record<string, number> | null = null

export async function getExpRules(): Promise<Record<string, number>> {
  if (expRulesCache) return expRulesCache
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='exp_rules'")
    expRulesCache = r ? JSON.parse(r.value) : {}
  } catch { expRulesCache = {} }
  return expRulesCache!
}

export function refreshExpRules() { expRulesCache = null }

// 给指定行为加分。change 为 0 或 undefined 时，按规则表查 actionType 对应的经验值
export async function addExp(userId: number, change: number | undefined, actionType: string, desc: string) {
  let delta = change
  if (!delta) {
    const rules = await getExpRules()
    delta = rules[actionType] ?? 0
  }
  if (!delta) return
  await run('UPDATE users SET exp = exp + ?, level = (exp / 60) + 1 WHERE id = ?', delta, userId)
  await run('INSERT INTO exp_logs (user_id,action_type,exp_change,description) VALUES (?,?,?,?)', userId, actionType, delta, desc)
}

export async function addNotice(userId: number, title: string, content: string, type: string) {
  await run('INSERT INTO notices (user_id,title,content,type) VALUES (?,?,?,?)', userId, title, content, type)
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
  } catch { flagsCache = {} }
  return flagsCache!
}
export function refreshFeatureFlags() { flagsCache = null }
export async function isFeatureEnabled(key: string): Promise<boolean> {
  const f = await getFeatureFlags()
  return f[key] !== false
}
