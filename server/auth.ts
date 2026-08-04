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
    // Bug4: 检查账号是否被禁用
    get<{ status: string }>('SELECT status FROM users WHERE id=?', payload.id).then(u => {
      if (u && u.status === 'disabled') {
        return res.status(401).json({ message: '账号已被禁用，请联系管理员', disabled: true })
      }
      ;(req as any).user = payload
      next()
    }).catch(() => {
      ;(req as any).user = payload
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
