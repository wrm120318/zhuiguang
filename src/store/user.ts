import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import { api } from '@/api'

// 将后端 snake_case 用户对象标准化为前端 camelCase
function normalizeUser(u: any): User | null {
  if (!u) return null
  return {
    id: u.id,
    username: u.username,
    realName: u.real_name ?? u.realName ?? '',
    role: u.role,
    email: u.email ?? '',
    phone: u.phone ?? '',
    avatar: u.avatar ?? '',
    exp: u.exp ?? 0,
    level: u.level ?? 1,
    status: u.status ?? 'active',
    classIds: u.classIds ?? [],
    // 【v4.0.1】吸收后端 subject_id 字段，作为主学科兜底
    subjectId: u.subject_id ?? u.subjectId ?? null,
    createdAt: u.created_at ?? u.createdAt ?? '',
  }
}

export const useUserStore = defineStore('user', () => {
  const current = ref<User | null>(loadUser())
  const token = ref<string | null>(localStorage.getItem('zg_token'))
  const classIds = ref<number[]>([])
  const teachingSubjects = ref<number[]>([])

  function loadUser(): User | null {
    try { return normalizeUser(JSON.parse(localStorage.getItem('zg_user') || 'null')) } catch { return null }
  }

  const isLogin = computed(() => !!token.value && !!current.value)
  const isSuperAdmin = computed(() => current.value?.role === 'SUPER_ADMIN')
  const isTeacher = computed(() => current.value?.role === 'TEACHER')
  const isStudent = computed(() => current.value?.role === 'STUDENT')
  const isStaff = computed(() => isSuperAdmin.value || isTeacher.value)

  function setAuth(t: string, u: any) {
    const nu = normalizeUser(u)
    token.value = t; current.value = nu
    localStorage.setItem('zg_token', t); localStorage.setItem('zg_user', JSON.stringify(nu))
  }

  async function login(username: string, password: string) {
    const r: any = await api.login({ username, password })
    setAuth(r.token, r.user)
    await fetchProfile()
    return r.user
  }

  async function register(data: any) {
    const r: any = await api.register(data)
    setAuth(r.token, r.user)
    await fetchProfile()
    return r.user
  }

  async function fetchProfile() {
    const r: any = await api.me()
    const nu = normalizeUser(r.user)
    current.value = nu
    localStorage.setItem('zg_user', JSON.stringify(nu))
    const mc: any = await api.myClasses()
    classIds.value = mc.classIds || []
    const sids = (mc.teachingSubjects || []).slice()
    // 【v4.0.1 兜底】后端 class_members 缺记录的教师，teachingSubjects 为空；
    //   用 users.subject_id 兜底，否则教师永远进不去本学科编辑入口
    const mainSid = mc.subjectId ?? nu?.subjectId ?? (r.user && r.user.subject_id)
    if (mainSid && !sids.includes(Number(mainSid))) sids.push(Number(mainSid))
    teachingSubjects.value = sids
  }

  async function updateProfile(data: any) {
    const r: any = await api.updateProfile(data)
    const nu = normalizeUser(r.user || r)
    current.value = nu
    localStorage.setItem('zg_user', JSON.stringify(nu))
  }

  function logout() {
    token.value = null; current.value = null
    classIds.value = []; teachingSubjects.value = []
    localStorage.removeItem('zg_token'); localStorage.removeItem('zg_user')
  }

  function canManageSubject(subjectId: number): boolean {
    if (isSuperAdmin.value) return true
    if (!isTeacher.value) return false
    if (teachingSubjects.value.includes(subjectId)) return true
    // 【v4.0.1 兜底】主学科也可管理（兼容老数据）
    if (current.value && (current.value as any).subjectId && Number((current.value as any).subjectId) === subjectId) return true
    return false
  }

  return {
    current, token, classIds, teachingSubjects,
    isLogin, isSuperAdmin, isTeacher, isStudent, isStaff,
    login, register, fetchProfile, updateProfile, logout, canManageSubject
  }
})
