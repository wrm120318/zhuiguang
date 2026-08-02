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
