import jwt from 'jsonwebtoken'
import type { Request, Response, NextFunction } from 'express'
import { get } from './db'

const SECRET = process.env.JWT_SECRET || 'zhuiguang-secret-2026'
export const TOKEN_EXPIRES = process.env.JWT_EXPIRES || '7d'

export function signToken(payload: { id: number; role: string }) {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_EXPIRES })
}

export function auth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization
  if (!h) return res.status(401).json({ message: '未登录' })
  const token = h.startsWith('Bearer ') ? h.slice(7) : h
  try {
    const payload = jwt.verify(token, SECRET) as { id: number; role: string }
    // 【v4.0.1】同时查 subject_id，供 requireSubjectStaff 兜底
    get<{ status: string; subject_id: number | null }>('SELECT status, subject_id FROM users WHERE id=?', payload.id).then(u => {
      if (u && u.status === 'disabled') {
        return res.status(401).json({ message: '账号已被禁用，请联系管理员', disabled: true })
      }
      ;(req as any).user = { ...payload, subject_id: u?.subject_id ?? null }
      next()
    }).catch(() => {
      ;(req as any).user = { ...payload, subject_id: null }
      next()
    })
  } catch {
    return res.status(401).json({ message: '登录已过期，请重新登录' })
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const u = (req as any).user
    if (!u || !roles.includes(u.role)) return res.status(403).json({ message: '无权限' })
    next()
  }
}

// 教师或超管
export function requireStaff(req: Request, res: Response, next: NextFunction) {
  const u = (req as any).user
  if (!u || (u.role !== 'TEACHER' && u.role !== 'SUPER_ADMIN')) return res.status(403).json({ message: '需要教师或管理员权限' })
  next()
}

/**
 * 【v4.0.0】学科教师或超管中间件
 * 规则：
 *  - SUPER_ADMIN 永远放行
 *  - TEACHER 必须任教该 subject（class_members.role_in_class='TEACHER'）
 *  - 其他角色 403
 * 用法：router.post('/api/...', auth, requireSubjectStaff('id'), handler)
 *    - 'id'：取 req.params.id 当作 subjectId
 *    - 'body'：取 req.body.subjectId
 *    - 'query'：取 req.query.subjectId
 */
export function requireSubjectStaff(source: 'params' | 'body' | 'query' = 'params', key = 'id') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const u = (req as any).user
    if (!u) return res.status(401).json({ message: '未登录' })
    if (u.role === 'SUPER_ADMIN') return next()
    if (u.role !== 'TEACHER') return res.status(403).json({ message: '需要教师或管理员权限' })
    let subjectId: any
    if (source === 'params') subjectId = req.params[key]
    else if (source === 'body') subjectId = (req.body || {})[key]
    else subjectId = (req.query as any)[key]
    const sid = Number(subjectId)
    if (!sid) return res.status(400).json({ message: '缺少 subjectId' })
    // 动态 import 避免循环依赖
    const { teachingSubjects } = await import('./helpers')
    // 【v4.0.1】任教学科集合 + 主学科 users.subject_id 兜底
    const sids = await teachingSubjects(u.id)
    if (!sids.includes(sid) && u.subject_id && Number(u.subject_id) === sid) {
      sids.push(Number(u.subject_id))
    }
    if (!sids.includes(sid)) return res.status(403).json({ message: '无权管理该学科' })
    next()
  }
}
