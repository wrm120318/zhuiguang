import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { User } from '@/types'
import { api } from '@/api'
import { sanitizePerms, type PermKey } from '@/constants/permissions'

/** 【v4.9.7】把后端 permissions 归一化为合法 key 数组（兼容 JSON 字符串 / 数组 / NULL） */
function normalizePermissions(raw: any): PermKey[] {
  if (Array.isArray(raw)) return sanitizePerms(raw)
  if (typeof raw === 'string' && raw) {
    try { return sanitizePerms(JSON.parse(raw)) } catch { return [] }
  }
  return []
}

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
    // 【v4.9.7】管理员权限（每个 ADMIN 各自一套；超管恒全权）
    permissions: normalizePermissions(u.permissions),
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
  // 【v4.9.7】管理员：权限逐个配置，与超管有明确区别
  const isAdmin = computed(() => current.value?.role === 'ADMIN')
  const isTeacher = computed(() => current.value?.role === 'TEACHER')
  const isStudent = computed(() => current.value?.role === 'STUDENT')
  // 能进入后台的角色集合（超管 / 管理员 / 教师）
  const isStaff = computed(() => isSuperAdmin.value || isAdmin.value || isTeacher.value)

  /**
   * 【v4.9.7】是否有某后台模块权限
   *  - 超管恒 true（后端 hasPerm 也是同样规则，前后端一致）
   *  - 管理员看自己的 permissions 数组
   *  - 教师/学生恒 false（教师的后台能力由 AdminLayout 的 teacherVisible 单独控制）
   */
  function hasPerm(key: PermKey): boolean {
    if (isSuperAdmin.value) return true
    if (!isAdmin.value) return false
    return current.value?.permissions?.includes(key) ?? false
  }

  function setAuth(t: string, u: any) {
    const nu = normalizeUser(u)
    token.value = t; current.value = nu
    localStorage.setItem('zg_token', t); localStorage.setItem('zg_user', JSON.stringify(nu))
  }

  async function login(username: string, password: string) {
    const r: any = await api.login({ username, password })
    setAuth(r.token, r.user)
    // 【v4.8.28】身份已切换 → 清掉上一账号的缓存新鲜度，强制重拉
    invalidateProfile()
    await fetchProfile(true)
    return r.user
  }

  async function register(data: any) {
    const r: any = await api.register(data)
    setAuth(r.token, r.user)
    invalidateProfile()
    await fetchProfile(true)
    return r.user
  }

  // ==========================================================================
  // 【v4.8.28 性能专项】fetchProfile 三项优化
  //
  // 优化 1（并行）：原实现 `await api.me()` → `await api.myClasses()` 严格串行。
  //   `myClasses` 的入参不依赖 `me` 的返回（两者都只依赖 Authorization 头），
  //   串行等于把两个 RTT 相加。改为 `Promise.all` 同时发出。
  //
  // 优化 2（不再让「慢的那一个」拖住首屏）：
  //   App.vue 的启动栅栏会 await 本函数（NavBar 渲染依赖 user.current）。
  //   实测 `me` 中位 1.1s、`me/classes` 中位 2.0s（冷启可到 8.8s）——
  //   若两个都等，首屏要付「较慢者」的代价，经常撞上 6s 兜底超时。
  //   而 NavBar 只读 `current`（头像/姓名/角色/等级），**完全不读** classIds /
  //   teachingSubjects —— 后者仅用于「能否管理某学科」的权限判断（进入学科页才用）。
  //   因此：`me` 落地后立即 resolve（栅栏放行），`myClasses` 继续在后台跑完再写入。
  //
  //   为什么零行为变更：
  //     · `current` / localStorage 的写入时机与内容**完全不变**（仍以 me 为准）；
  //     · `classIds` / `teachingSubjects` 的最终值**完全不变**，只是晚几百毫秒落地；
  //       它们是响应式的，落地后依赖它们的 UI（学科编辑入口等）会自动更新。
  //     · `me` 失败时仍向外抛（与原实现一致，App.vue 已 catch）。
  //
  // 优化 3（会话级缓存）：避免每次路由切换重拉
  //   `me` + `me/classes` 属于 11 个「每页都拉」的接口。实测 26 页切换 → 各拉 26 次。
  //   现在：数据已在内存且未超 TTL（5 分钟）→ 直接复用，零请求。
  //
  //   为什么「缓存不会覆盖新修改」（吸取历史 bug 教训）：
  //   · invalidateProfile() 是**显式失效开关** —— updateProfile / 登录 / 登出
  //     / 学生确认代发美文（等级变化）等都会调用它，下一次 fetchProfile 必然走网络；
  //   · 首次进入（数据尚未加载）永远走网络，不存在读到空缓存的窗口；
  //   · TTL 到期自动重拉，长会话也不会用陈旧数据。
  // ==========================================================================
  const PROFILE_TTL = 5 * 60 * 1000
  let profileFetchedAt = 0
  let profileVersion = 0
  let profileInflight: Promise<void> | null = null

  /** 显式失效用户缓存：任何写操作后调用，保证下一次 fetchProfile 拿最新数据 */
  function invalidateProfile() {
    profileVersion++
    profileFetchedAt = 0
  }

  /** 拉取「我的班级 + 可任教科目」并写入 store（不阻塞首屏，可独立调用）
   *  @param meUser 可选：已拿到的 me.user，用于 subject_id 兜底（与 v4.0.1 逻辑一致） */
  function fetchMyClasses(meUser?: any): Promise<void> {
    return (async () => {
      try {
        const mc: any = await api.myClasses()
        classIds.value = mc?.classIds || []
        const sids = (mc?.teachingSubjects || []).slice()
        // 【v4.0.1 兜底】后端 class_members 缺记录的教师，teachingSubjects 为空；
        //   用 users.subject_id 兜底，否则教师永远进不去本学科编辑入口
        const mainSid = mc?.subjectId ?? (meUser && meUser.subject_id)
        if (mainSid && !sids.includes(Number(mainSid))) sids.push(Number(mainSid))
        teachingSubjects.value = sids
      } catch (e: any) {
        console.warn('[user] myClasses 加载失败（已忽略，不影响首屏）：', e?.message || e)
      }
    })()
  }

  async function fetchProfile(force = false) {
    // 并发去重：同一时刻的重复调用复用同一次请求
    if (!force && profileInflight) return profileInflight
    // 会话级缓存：数据新鲜（TTL 内）且已加载过 → 直接返回，零请求
    if (!force && profileFetchedAt > 0 && current.value && Date.now() - profileFetchedAt < PROFILE_TTL) {
      return
    }
    const ver = profileVersion
    const p = (async () => {
      // ① me 与 myClasses **同时发出**（互不依赖，避免串行叠加 RTT）
      const mePromise = api.me() as any
      const classesPromise = api.myClasses() as any
      // ② 只等 me —— 它是 NavBar 渲染的唯一依赖，落地即放行首屏
      const r: any = await mePromise
      const nu = normalizeUser(r.user)
      current.value = nu
      localStorage.setItem('zg_user', JSON.stringify(nu))
      // ③ myClasses 的写入保持原逻辑与原字段，只是不再阻塞本函数 resolve
      classesPromise.then((mc: any) => {
        classIds.value = mc?.classIds || []
        const sids = (mc?.teachingSubjects || []).slice()
        // 【v4.0.1 兜底】顺序与原实现完全一致：mc.subjectId → me.subjectId → me.user.subject_id
        const mainSid = mc?.subjectId ?? nu?.subjectId ?? (r.user && r.user.subject_id)
        if (mainSid && !sids.includes(Number(mainSid))) sids.push(Number(mainSid))
        teachingSubjects.value = sids
      }).catch((e: any) => {
        console.warn('[user] myClasses 加载失败（已忽略，不影响首屏）：', e?.message || e)
      })
      // 只有本次请求期间没有发生「显式失效」时才记录新鲜度，
      // 否则保持 0 → 下一次调用仍走网络（绝不拿旧数据覆盖刚改的内容）
      if (ver === profileVersion) profileFetchedAt = Date.now()
    })()
    profileInflight = p
    try {
      await p
    } finally {
      if (profileInflight === p) profileInflight = null
    }
  }

  async function updateProfile(data: any) {
    const r: any = await api.updateProfile(data)
    const nu = normalizeUser(r.user || r)
    current.value = nu
    localStorage.setItem('zg_user', JSON.stringify(nu))
    // 【v4.8.28】资料已变更 → 显式失效缓存，下一次 fetchProfile 必须走网络拿最新值
    invalidateProfile()
  }

  function logout() {
    token.value = null; current.value = null
    classIds.value = []; teachingSubjects.value = []
    // 【v4.8.28】登出即失效缓存，避免下个账号复用上一账号的数据窗口
    invalidateProfile()
    localStorage.removeItem('zg_token'); localStorage.removeItem('zg_user')
  }

  function canManageSubject(subjectId: number): boolean {
    if (isSuperAdmin.value) return true
    // 【v4.9.7】拥有 subjects 权限的管理员可管全学科（与后端 requireSubjectStaff 放行一致）
    if (isAdmin.value && hasPerm('subjects')) return true
    if (!isTeacher.value) return false
    if (teachingSubjects.value.includes(subjectId)) return true
    // 【v4.0.1 兜底】主学科也可管理（兼容老数据）
    if (current.value && (current.value as any).subjectId && Number((current.value as any).subjectId) === subjectId) return true
    return false
  }

  return {
    current, token, classIds, teachingSubjects,
    isLogin, isSuperAdmin, isAdmin, isTeacher, isStudent, isStaff,
    hasPerm,
    login, register, fetchProfile, updateProfile, logout, canManageSubject,
    // 【v4.8.28】供写操作方（如学生确认代发美文后等级变化）显式失效缓存；
    //   fetchMyClasses 供需要「班级/任教科目」的页面显式等待（如个人中心）
    invalidateProfile, fetchMyClasses,
  }
})
