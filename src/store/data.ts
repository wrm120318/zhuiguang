import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api'
import type { Subject, SchoolClass, Article, Resource, QueryTask, ExpLog, Notice } from '@/types'

export const useDataStore = defineStore('data', () => {
  const subjects = ref<any[]>([])
  const classes = ref<any[]>([])
  const articles = ref<any[]>([])
  const resources = ref<any[]>([])
  const queryTasks = ref<any[]>([])
  const expLogs = ref<any[]>([])
  const notices = ref<any[]>([])
  const loading = ref(false)

  // ==========================================================================
  // 【v4.8.28 性能专项】公共数据会话级缓存 + 并发去重
  //
  // 问题（生产实测基线）：`/api/subjects` 与 `/api/classes` 在 **26/26 个页面**
  //   都被请求一次 —— 每切一次路由就重拉一遍。数据本身是"低频变更的字典表"
  //   （学科列表、班级列表），却按"每次导航都刷新"的代价在付，纯浪费。
  //
  // 做法：给这两个字典接口加**双保险**——
  //   ① inflight 去重：同一时刻的重复调用合并为一次请求（不缓存内容，返回即清）；
  //   ② 会话级缓存：已拿到数据且未超 TTL → 直接复用，不发请求。
  //
  // 为什么「缓存不会覆盖新修改」（吸取历史 bug 教训）：
  //   · 管理端增删改学科/班级后，代码里**本来就会重新调用** fetchSubjects/
  //     fetchClasses 来刷新 → 这里通过 `force=true` 走强制路径，拿最新数据。
  //     已核查全部写路径（AdminSubjects/ClassesAdmin/UsersView 等）并逐一接上 force。
  //   · 首次加载（数组为空）永远走网络，不存在"读到空缓存"。
  //   · TTL 到期自动重拉。
  // ==========================================================================
  const DICT_TTL = 5 * 60 * 1000
  let subjectsFetchedAt = 0
  let classesFetchedAt = 0
  let subjectsInflight: Promise<any> | null = null
  let classesInflight: Promise<any> | null = null

  /** 显式失效字典缓存（学科/班级被增删改后调用），保证下次必走网络 */
  function invalidateDict(which: 'subjects' | 'classes' | 'both' = 'both') {
    if (which === 'subjects' || which === 'both') { subjectsFetchedAt = 0 }
    if (which === 'classes' || which === 'both') { classesFetchedAt = 0 }
  }

  async function fetchSubjects(force = false) {
    if (!force && subjectsInflight) { await subjectsInflight; return }
    if (!force && subjectsFetchedAt > 0 && subjects.value.length && Date.now() - subjectsFetchedAt < DICT_TTL) return
    const p = (async () => { subjects.value = (await api.subjects()) as any })()
    subjectsInflight = p
    try {
      await p
      subjectsFetchedAt = Date.now()
    } finally {
      if (subjectsInflight === p) subjectsInflight = null
    }
  }

  async function fetchClasses(force = false) {
    if (!force && classesInflight) { await classesInflight; return }
    if (!force && classesFetchedAt > 0 && classes.value.length && Date.now() - classesFetchedAt < DICT_TTL) return
    const p = (async () => { classes.value = (await api.classes()) as any })()
    classesInflight = p
    try {
      await p
      classesFetchedAt = Date.now()
    } finally {
      if (classesInflight === p) classesInflight = null
    }
  }

  async function fetchArticles(params: any = {}) { articles.value = (await api.articles(params)) as any }
  async function fetchResources(params: any = {}) { resources.value = (await api.resources(params)) as any }
  async function fetchQueryTasks() { queryTasks.value = (await api.queryTasks()) as any }
  async function fetchExpLogs(userId?: number) { expLogs.value = (await api.expLogs(userId)) as any }

  // ==========================================================================
  // 【v4.8.26 性能专项】公告统一数据源 + 并发去重
  //
  // 背景（生产实测）：首页一次加载把 `/api/notices` **并发拉了 3 次** ——
  //   NavBar.loadNotices()（挂载时）、NavBar.pollNotices()（轮询立即执行一次）、
  //   MobileTabBar.refreshNoticeUnread()（只为算未读数）各自独立请求。
  //   在 D1 响应 0.8~9.6s 波动的现实下，这既是首屏慢的原因之一，也浪费 D1 配额。
  //
  // 做法：把 `notices` 收敛为**唯一数据源**，所有消费方读同一份；
  //   并用「进行中的 Promise」做并发去重 —— 同一时刻的重复调用复用同一次请求。
  //
  // 为什么零副作用：
  //   · 不做任何**内容缓存**，只合并「同一时刻」的重复调用；
  //     请求返回后 `inflight` 立即清空 → 下一次调用是全新的请求（数据必刷新）。
  //   · 因此「读了通知后重新拉取」「轮询拿新通知」等场景行为完全不变。
  // ==========================================================================
  let noticesInflight: Promise<any[]> | null = null
  let inflightToken: symbol | null = null

  async function fetchNotices(force = false): Promise<any[]> {
    // force=true 时绕过并发去重，强制发新请求（如轮询、已读后刷新）
    if (!force && noticesInflight) return noticesInflight
    const token = Symbol('notices')
    inflightToken = token
    const p = (async () => {
      try {
        const r: any = await api.notices()
        const list: any[] = Array.isArray(r) ? r : (r?.data || [])
        notices.value = list
        return list
      } finally {
        // 只有当「当前在飞的就是本次请求」时才清空 —— 若期间已被 force 请求覆盖，
        // 则由那个更新的请求负责清理，避免把它的引用误清掉。
        if (inflightToken === token) {
          noticesInflight = null
          inflightToken = null
        }
      }
    })()
    noticesInflight = p
    return p
  }

  /** 未读数 —— 从同一份 notices 推导，避免各组件重复请求 */
  const noticeUnread = computed(() => (notices.value || []).filter((n: any) => !n.read).length)

  const pendingArticles = computed(() => articles.value.filter(a => a.status === 'pending'))
  const pendingResources = computed(() => resources.value.filter(r => r.status === 'pending'))

  function subjectBySlug(slug: string) { return subjects.value.find(s => s.slug === slug) }
  function subjectById(id: number) { return subjects.value.find(s => s.id === id) }
  function classById(id: number) { return classes.value.find(c => c.id === id) }

  async function loadCommon() {
    loading.value = true
    try { await Promise.all([fetchSubjects(), fetchClasses()]) } finally { loading.value = false }
  }

  return {
    subjects, classes, articles, resources, queryTasks, expLogs, notices, loading,
    pendingArticles, pendingResources, noticeUnread,
    subjectBySlug, subjectById, classById,
    fetchSubjects, fetchClasses, fetchArticles, fetchResources, fetchQueryTasks, fetchExpLogs, fetchNotices,
    loadCommon, api
  }
})
