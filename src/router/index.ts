import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessageBox } from 'element-plus'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/subjects', name: 'subjects', component: () => import('@/views/SubjectsView.vue') },
  { path: '/subject/:slug', name: 'subject', component: () => import('@/views/SubjectView.vue') },
  // 学科论坛（嵌在学科详情页 tab 下，独立路由便于深链接）
  { path: '/subject/:slug/forum', name: 'subject-forum', component: () => import('@/views/SubjectForumView.vue') },
  { path: '/subject/:slug/forum/new', name: 'subject-forum-new', component: () => import('@/views/SubjectForumEditView.vue') },
  { path: '/subject/:slug/forum/post/:id', name: 'subject-forum-post', component: () => import('@/views/SubjectForumPostView.vue') },
  { path: '/subject/:slug/forum/post/:id/edit', name: 'subject-forum-edit', component: () => import('@/views/SubjectForumEditView.vue') },
  { path: '/article/new', name: 'article-new', component: () => import('@/views/ArticleEditView.vue') },
  { path: '/article/:id/edit', name: 'article-edit', component: () => import('@/views/ArticleEditView.vue') },
  { path: '/article/:id', name: 'article', component: () => import('@/views/ArticleView.vue') },
  { path: '/query/:taskId', name: 'query', component: () => import('@/views/QueryView.vue') },
  { path: '/profile', name: 'profile', component: () => import('@/views/ProfileView.vue') },
  { path: '/leaderboard', name: 'leaderboard', component: () => import('@/views/LeaderboardView.vue') },
  { path: '/search', name: 'search', component: () => import('@/views/SearchView.vue') },
  { path: '/favorites', name: 'favorites', component: () => import('@/views/FavoritesView.vue') },
  // 网站说明
  { path: '/guide', name: 'guide', component: () => import('@/views/GuideView.vue') },
  // 网站博客
  { path: '/blog', name: 'blog', component: () => import('@/views/BlogListView.vue') },
  { path: '/blog/new', name: 'blog-new', component: () => import('@/views/BlogEditView.vue') },
  { path: '/blog/:id/edit', name: 'blog-edit', component: () => import('@/views/BlogEditView.vue') },
  { path: '/blog/:id', name: 'blog-detail', component: () => import('@/views/BlogDetailView.vue') },
  // 网站公告
  { path: '/announcements', name: 'announcements', component: () => import('@/views/AnnouncementsView.vue') },
  { path: '/announcements/new', name: 'announcement-new', component: () => import('@/views/AnnouncementEditView.vue') },
  { path: '/announcements/:id/edit', name: 'announcement-edit', component: () => import('@/views/AnnouncementEditView.vue') },
  { path: '/announcements/:id', name: 'announcement-detail', component: () => import('@/views/AnnouncementDetailView.vue') },
  // 站内信
  { path: '/messages', name: 'messages', component: () => import('@/views/MessagesView.vue') },
  { path: '/messages/:peerId', name: 'message-thread', component: () => import('@/views/MessagesView.vue') },
  // 经验值说明（已合并到网站说明）
  { path: '/exp-doc', redirect: '/guide' },
  // 题库自测
  { path: '/quizzes', name: 'quizzes', component: () => import('@/views/quiz/QuizListView.vue') },
  { path: '/quiz/new', name: 'quiz-new', component: () => import('@/views/quiz/QuizEditView.vue') },
  { path: '/quiz/:id', name: 'quiz-take', component: () => import('@/views/quiz/QuizTakeView.vue') },
  { path: '/quiz/:id/edit', name: 'quiz-edit', component: () => import('@/views/quiz/QuizEditView.vue') },
  { path: '/quiz/:id/report', name: 'quiz-report', component: () => import('@/views/quiz/QuizReportView.vue') },
  { path: '/quiz/:id/submissions', name: 'quiz-submissions', component: () => import('@/views/quiz/QuizSubmissionsView.vue') },
  // 单题训练
  { path: '/practice/:id', name: 'practice-take', component: () => import('@/views/quiz/PracticeTakeView.vue') },
  { path: '/practice/my-records', name: 'practice-records', component: () => import('@/views/quiz/PracticeRecordsView.vue') },
  { path: '/practice/stats/:questionId', name: 'practice-stats', component: () => import('@/views/quiz/PracticeStatsView.vue') },
  // 【v4.5.0】智能题库（学科内子模块）
  { path: '/subject/:slug/bank', name: 'question-bank', component: () => import('@/views/quiz/QuestionBankView.vue') },
  { path: '/subject/:slug/bank/add', name: 'question-add', component: () => import('@/views/quiz/QuestionEditView.vue') },
  { path: '/subject/:slug/bank/:qid/edit', name: 'question-edit', component: () => import('@/views/quiz/QuestionEditView.vue') },
  // 【v4.6.0】智能组卷专业版（对标组卷网）
  { path: '/subject/:slug/assemble', name: 'assemble', component: () => import('@/views/quiz/AssembleView.vue') },
  // 【v4.6.0】学情分析中心（对标智学网）
  { path: '/subject/:slug/analytics', name: 'analytics', component: () => import('@/views/quiz/AnalyticsView.vue') },
  // 【v4.6.0】错题本（对标智学网·学生端）
  { path: '/subject/:slug/wrong-book', name: 'wrong-book', component: () => import('@/views/quiz/WrongBookView.vue') },
  { path: '/wrong-book', name: 'wrong-book-global', component: () => import('@/views/quiz/WrongBookView.vue') },
  // 【v4.8.0】考试管理（对标智学网·考试管理）
  { path: '/subject/:slug/exams', name: 'exam-manage', component: () => import('@/views/quiz/ExamManageView.vue') },

  // 【v4.5.0】教师批改新界面（侧显参考答案）
  { path: '/practice/grade/:id', name: 'practice-grade', component: () => import('@/views/quiz/PracticeGradeView.vue') },
  // 品牌 404（B5 / B10）：未匹配路由统一落地
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') },
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    redirect: { name: 'admin-users' },
    children: [
      { path: 'dashboard', name: 'admin-dashboard', component: () => import('@/views/admin/DashboardView.vue') },
      { path: 'users', name: 'admin-users', component: () => import('@/views/admin/UsersView.vue') },
      { path: 'subjects', name: 'admin-subjects', component: () => import('@/views/admin/SubjectsAdminView.vue') },
      { path: 'classes', name: 'admin-classes', component: () => import('@/views/admin/ClassesAdminView.vue') },
      { path: 'audit', name: 'admin-audit', component: () => import('@/views/admin/AuditView.vue') },
      { path: 'query', name: 'admin-query', component: () => import('@/views/admin/QueryCreateView.vue') },
      { path: 'theme', name: 'admin-theme', component: () => import('@/views/admin/ThemeView.vue') },
      { path: 'guide', name: 'admin-guide', component: () => import('@/views/admin/GuideEditView.vue') },
      { path: 'exp-rules', name: 'admin-exp-rules', component: () => import('@/views/admin/ExpRulesView.vue') },
      { path: 'exp-logs', name: 'admin-exp-logs', component: () => import('@/views/admin/ExpLogsView.vue') },
      { path: 'feature-flags', name: 'admin-feature-flags', component: () => import('@/views/admin/FeatureFlagsView.vue') },
      { path: 'site-config', name: 'admin-site-config', component: () => import('@/views/admin/SiteConfigView.vue') },
      // 需求5：网站运行监控（仅超管）
      { path: 'monitor', name: 'admin-monitor', component: () => import('@/views/admin/MonitorView.vue') },
    ]
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() { return { top: 0 } }
})

router.beforeEach(async (to) => {
  const u = useUserStore()
  if (!to.meta.public && !u.isLogin) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.path.startsWith('/admin') && !u.isStaff) return { name: 'home' }
  if (to.name === 'login' && u.isLogin) return { name: 'home' }
  // 仅在进入管理后台时检查账号禁用状态，避免每次路由切换都发请求
  if (u.isLogin && to.path.startsWith('/admin')) {
    try {
      const r: any = await api.meStatus()
      if (r.disabled) {
        u.logout()
        await ElMessageBox.alert('您的账号已被管理员禁用，请联系管理员。', '账号已禁用', { type: 'error', showClose: false, confirmButtonText: '知道了' })
        return { name: 'login' }
      }
    } catch { /* ignore network errors */ }
  }
})

export default router
