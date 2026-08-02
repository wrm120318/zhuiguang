import db from './db'

export function addExp(userId: number, change: number, actionType: string, desc: string) {
  db.prepare('UPDATE users SET exp = exp + ?, level = (exp / 60) + 1 WHERE id = ?').run(change, userId)
  db.prepare('INSERT INTO exp_logs (user_id,action_type,exp_change,description) VALUES (?,?,?,?)').run(userId, actionType, change, desc)
}

export function addNotice(userId: number, title: string, content: string, type: string) {
  db.prepare('INSERT INTO notices (user_id,title,content,type) VALUES (?,?,?,?)').run(userId, title, content, type)
}

// 用户所在班级 ids
export function userClassIds(userId: number): number[] {
  return (db.prepare('SELECT class_id FROM class_members WHERE user_id = ?').all(userId) as any[]).map(r => r.class_id)
}

// 用户任教的 subject ids（教师）
export function teachingSubjects(userId: number): number[] {
  return (db.prepare('SELECT DISTINCT subject_id FROM class_members WHERE user_id = ? AND role_in_class = ? AND subject_id IS NOT NULL').all(userId, 'TEACHER') as any[]).map(r => r.subject_id)
}
