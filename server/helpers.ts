import { run, all } from './db'

export async function addExp(userId: number, change: number, actionType: string, desc: string) {
  await run('UPDATE users SET exp = exp + ?, level = (exp / 60) + 1 WHERE id = ?', change, userId)
  await run('INSERT INTO exp_logs (user_id,action_type,exp_change,description) VALUES (?,?,?,?)', userId, actionType, change, desc)
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
