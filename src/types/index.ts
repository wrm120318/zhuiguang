// ===== 全局类型定义 =====
export type Role = 'SUPER_ADMIN' | 'TEACHER' | 'STUDENT'

export interface User {
  id: number
  username: string
  realName: string
  role: Role
  email: string
  phone: string
  avatar: string
  exp: number
  level: number
  status: 'active' | 'disabled'
  classIds: number[]
  teachingSubjects?: Record<number, number[]> // classId -> subjectIds
  // 【v4.0.1】主学科：教师只在 users 表里指了主学科、没进 class_members 时，前端用这个做兜底
  subjectId?: number | null
  createdAt: string
}

export interface Subject {
  id: number
  name: string
  slug: string
  icon: string
  color: string
  description: string
  displayOrder: number
  modules: {
    announcement: boolean
    resources: boolean
    articles: boolean
    query: boolean
    quiz: boolean
    leaderboard: boolean
  }
  announcement: string
}

export interface SchoolClass {
  id: number
  name: string
  grade: string
  description: string
}

export interface Article {
  id: number
  title: string
  content: string
  author: string
  source: string
  recommendation: string
  subjectId: number // 仅语文/英语
  userId: number
  userName: string
  classId: number
  cover: string
  images: string[]
  tags: string[]
  category: string
  status: 'pending' | 'approved' | 'rejected'
  likes: number
  views: number
  createdAt: string
}

export interface Resource {
  id: number
  subjectId: number
  title: string
  description: string
  fileName: string
  fileType: string
  fileSize: number
  filePath: string
  category: string
  tags: string[]
  userId: number
  userName: string
  classId: number
  status: 'pending' | 'approved' | 'rejected'
  downloads: number
  likes: number
  collects: number
  version: number
  createdAt: string
}

export interface QueryTask {
  id: number
  subjectId: number
  classId: number
  creatorId: number
  creatorName: string
  title: string
  note: string
  validUntil: string
  showComment: boolean
  allowExport: boolean
  headers: string[]
  rows: Record<string, string | number>[]
  matchField: string // 用于匹配学生姓名/学号的列名
  createdAt: string
}

export interface ExpLog {
  id: number
  userId: number
  actionType: string
  expChange: number
  description: string
  createdAt: string
}

export interface Notice {
  id: number
  userId: number
  title: string
  content: string
  type: 'audit' | 'query' | 'system' | 'teacher'
  read: boolean
  createdAt: string
}

export interface ThemeConfig {
  id: number
  name: string
  primary: string
  primary2: string
  accent: string
  bgFrom: string
  bgVia: string
  bgTo: string
  blur: number
  radius: number
  isActive: boolean
}
