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
    teachingSubjects.value = mc.teachingSubjects || []
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
    return teachingSubjects.value.includes(subjectId)
  }

  return {
    current, token, classIds, teachingSubjects,
    isLogin, isSuperAdmin, isTeacher, isStudent, isStaff,
    login, register, fetchProfile, updateProfile, logout, canManageSubject
  }
})
