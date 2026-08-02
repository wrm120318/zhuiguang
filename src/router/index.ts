import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useUserStore } from '@/store/user'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/subjects', name: 'subjects', component: () => import('@/views/SubjectsView.vue') },
  { path: '/subject/:slug', name: 'subject', component: () => import('@/views/SubjectView.vue') },
  { path: '/article/new', name: 'article-new', component: () => import('@/views/ArticleEditView.vue') },
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
  { path: '/blog/:id', name: 'blog-detail', component: () => import('@/views/BlogDetailView.vue') },
  // 网站公告
  { path: '/announcements', name: 'announcements', component: () => import('@/views/AnnouncementsView.vue') },
  { path: '/announcements/new', name: 'announcement-new', component: () => import('@/views/AnnouncementEditView.vue') },
  { path: '/announcements/:id', name: 'announcement-detail', component: () => import('@/views/AnnouncementDetailView.vue') },
  // 站内信
  { path: '/messages', name: 'messages', component: () => import('@/views/MessagesView.vue') },
  { path: '/messages/:peerId', name: 'message-thread', component: () => import('@/views/MessagesView.vue') },
  // 经验值说明
  { path: '/exp-doc', name: 'exp-doc', component: () => import('@/views/ExpDocView.vue') },
  // 题库自测
  { path: '/quizzes', name: 'quizzes', component: () => import('@/views/quiz/QuizListView.vue') },
  { path: '/quiz/new', name: 'quiz-new', component: () => import('@/views/quiz/QuizEditView.vue') },
  { path: '/quiz/:id', name: 'quiz-take', component: () => import('@/views/quiz/QuizTakeView.vue') },
  { path: '/quiz/:id/edit', name: 'quiz-edit', component: () => import('@/views/quiz/QuizEditView.vue') },
  { path: '/quiz/:id/report', name: 'quiz-report', component: () => import('@/views/quiz/QuizReportView.vue') },
  { path: '/quiz/:id/submissions', name: 'quiz-submissions', component: () => import('@/views/quiz/QuizSubmissionsView.vue') },
  // 单题训练
  { path: '/practice/:id', name: 'practice-take', component: () => import('@/views/quiz/PracticeTakeView.vue') },
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
      { path: 'feature-flags', name: 'admin-feature-flags', component: () => import('@/views/admin/FeatureFlagsView.vue') },
    ]
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() { return { top: 0 } }
})

router.beforeEach((to) => {
  const u = useUserStore()
  if (!to.meta.public && !u.isLogin) return { name: 'login', query: { redirect: to.fullPath } }
  if (to.path.startsWith('/admin') && !u.isStaff) return { name: 'home' }
  if (to.name === 'login' && u.isLogin) return { name: 'home' }
})

export default router
