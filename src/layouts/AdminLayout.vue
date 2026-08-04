<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const mobileOpen = ref(false)

const menus = computed(() => {
  const list: { name: string; label: string; icon: string; badge?: number; role?: string }[] = [
    { name: 'admin-dashboard', label: '数据看板', icon: '📊', role: 'SUPER_ADMIN' },
    { name: 'admin-users', label: '用户管理', icon: '👥', role: 'SUPER_ADMIN' },
    { name: 'admin-subjects', label: '学科管理', icon: '📚', role: 'SUPER_ADMIN' },
    { name: 'admin-classes', label: '班级管理', icon: '🏫', role: 'SUPER_ADMIN' },
    { name: 'admin-audit', label: '内容审核', icon: '✅', badge: data.pendingArticles.length + data.pendingResources.length, role: 'STAFF' },
    { name: 'admin-query', label: '数据查询', icon: '📈', role: 'STAFF' },
    { name: 'admin-guide', label: '网站说明', icon: '📖', role: 'SUPER_ADMIN' },
    { name: 'admin-exp-rules', label: '经验设置', icon: '⭐', role: 'SUPER_ADMIN' },
    { name: 'admin-feature-flags', label: '功能开关', icon: '🧩', role: 'SUPER_ADMIN' },
    { name: 'admin-theme', label: '界面风格', icon: '🎨', role: 'SUPER_ADMIN' },
    { name: 'admin-monitor', label: '运行监控', icon: '🖥️', role: 'SUPER_ADMIN' },
  ]
  return list.filter(m => {
    if (!m.role) return true
    if (m.role === 'SUPER_ADMIN') return user.isSuperAdmin
    if (m.role === 'STAFF') return user.isTeacher || user.isSuperAdmin
    return false
  })
})

function go(name: string) {
  mobileOpen.value = false
  router.push({ name })
}
</script>

<template>
  <div class="admin-layout">
    <!-- 手机端顶部栏 -->
    <div class="admin-topbar glass">
      <el-button text circle @click="mobileOpen = !mobileOpen" class="at-btn">{{ mobileOpen ? '✕' : '☰' }}</el-button>
      <div class="at-brand zg-grad-text">🎨 管理后台</div>
      <el-button text class="at-back" @click="router.push('/')">← 前台</el-button>
    </div>

    <!-- 侧边栏 PC 端固定 -->
    <aside class="sidebar glass" :class="{ open: mobileOpen }">
      <div class="sb-brand zg-grad-text">🎨 管理后台</div>
      <div class="sb-role">{{ user.isSuperAdmin ? '超级管理员' : '学科教师' }} · {{ user.current?.realName ?? '' }}</div>
      <nav class="sb-nav">
        <div v-for="m in menus" :key="m.name" class="sb-item" :class="{ on: route.name === m.name }" @click="go(m.name)">
          <span class="sb-icon">{{ m.icon }}</span>
          <span class="sb-label">{{ m.label }}</span>
          <span v-if="m.badge" class="sb-badge">{{ m.badge }}</span>
        </div>
      </nav>
      <div class="sb-back" @click="router.push('/')">← 返回前台首页</div>
    </aside>

    <!-- 手机端遮罩 -->
    <div v-if="mobileOpen" class="sb-mask" @click="mobileOpen = false"></div>

    <main class="admin-main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in"><component :is="Component" /></transition>
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.admin-layout { display:flex; flex-wrap: wrap; gap:0; min-height:calc(100vh - 64px); position: relative; }
.admin-topbar { display:none; position: sticky; top:0; z-index: 150; border-radius:0; border-left:none; border-right:none; border-top:none; align-items:center; padding: 8px 14px; height: 52px; }
.at-btn { font-size: 20px !important; color: var(--zg-text) !important; }
.at-brand { font-size: 18px; font-weight: 800; flex: 1; text-align: center; }
.at-back { color: var(--zg-primary) !important; font-size: 13px !important; }

.sidebar { width:240px; padding:20px 16px; position:sticky; top:64px; height:calc(100vh - 64px); display:flex; flex-direction:column; border-radius:0; border-top:none; border-bottom:none; border-left:none; z-index: 160; }
.sb-brand { font-size:20px; font-weight:800; padding:8px 12px; }
.sb-role { font-size:12px; color:var(--zg-text-dim); padding:0 12px 16px; border-bottom:1px solid rgba(245,158,11,.1); }
.sb-nav { flex:1; display:flex; flex-direction:column; gap:4px; padding-top:12px; overflow-y: auto; }
.sb-item { display:flex; align-items:center; gap:12px; padding:11px 14px; border-radius:10px; cursor:pointer; color:var(--zg-text-dim); font-weight:500; transition:all .2s; font-size: var(--zg-fs-sm); }
.sb-item:hover { background:rgba(245,158,11,.06); color:var(--zg-text); transform: translateX(2px); }
.sb-item.on { background: linear-gradient(135deg, rgba(245,158,11,.3), rgba(251,146,60,.22)); color: var(--zg-text); font-weight: 700; }
.sb-icon { font-size:17px; }
.sb-label { flex:1; }
.sb-badge { background:#ef4444; color:#fff; font-size:11px; padding:1px 7px; border-radius:10px; }
.sb-back { padding:12px; color:var(--zg-text-dim); cursor:pointer; font-size:13px; border-top: 1px dashed rgba(245,158,11,.12); margin-top: 8px; }
.sb-back:hover { color:var(--zg-primary); font-weight: 600; }
.admin-main { flex:1; padding:24px 28px; min-width:0; }

.sb-mask { display:none; }

@media (min-width: 1200px) {
  .sidebar { width: 260px; padding: 24px; }
  .sb-item { padding: 12px 16px; font-size: 14px; }
  .admin-main { padding: 28px 36px; }
  .sb-brand { font-size: 22px; }
  .sb-role { font-size: 14px; }
}

@media (max-width: 960px) {
  .admin-layout { min-height: 100vh; flex-direction: column; }
  .admin-topbar { display:flex; }
  .sidebar {
    position: fixed; top: 52px; left: 0; bottom: 0;
    height: calc(100vh - 52px); width: 78%; max-width: 320px;
    transform: translateX(-102%); transition: transform .3s cubic-bezier(.2,.8,.2,1);
    padding: 16px 12px; z-index: 170; border-right: 1px solid rgba(245,158,11,.18);
    border-radius: 0 16px 16px 0;
    background: rgba(255,251,235,0.98); backdrop-filter: blur(24px) saturate(180%);
    box-shadow: 4px 0 24px rgba(245,158,11,.12);
  }
  .sidebar.open { transform: translateX(0); }
  .sb-brand { font-size: 18px; padding: 4px 10px 8px; }
  .sb-role { font-size: 12px; padding: 0 10px 14px; }
  .sb-item { padding: 12px 14px; font-size: var(--zg-fs-base); }
  .sb-icon { font-size: 19px; }
  .admin-main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); }
  .sb-mask { display:block; position: fixed; inset: 0; z-index: 155; background: rgba(0,0,0,0.25); backdrop-filter: blur(2px); animation: zgFadeIn .25s; }
}
</style>
