<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const unread = ref(0)

async function loadNotices() {
  if (!user.isLogin) { unread.value = 0; return }
  try { const list: any = await api.notices(); unread.value = (list || []).filter((n: any) => !n.read).length } catch { /* */ }
}
onMounted(() => { 
  loadNotices()
  window.addEventListener('zg-notice-read', loadNotices)
})

const items = computed(() => {
  const arr: ({ key: string; label: string; icon: string; to?: string; action?: string })[] = [
    { key: 'home', label: '首页', icon: 'HomeFilled', to: '/' },
    { key: 'subjects', label: '学科', icon: 'Reading', to: '/subjects' },
    { key: 'leaderboard', label: '排行', icon: 'Trophy', to: '/leaderboard' },
  ]
  if (user.isStaff) arr.push({ key: 'admin', label: '管理', icon: 'Setting', to: '/admin/users' })
  if (user.isLogin) arr.push({ key: 'notice', label: '通知', icon: 'Bell', action: 'notice' })
  arr.push({ key: 'profile', label: '我的', icon: 'User', to: '/profile' })
  return arr
})

function active(key: string) {
  if (key === 'home') return route.path === '/'
  if (key === 'subjects') return route.path.startsWith('/subject') || route.path.startsWith('/subjects')
  if (key === 'admin') return route.path.startsWith('/admin')
  return route.path.startsWith('/' + key) || (key === 'profile' && route.path === '/profile')
}

function onTab(it: any) {
  if (it.action === 'notice') { window.dispatchEvent(new CustomEvent('zg-open-notice')); loadNotices(); return }
  router.push(it.to)
}
</script>

<template>
  <nav class="tabbar">
    <div class="tabbar-inner">
      <div v-for="it in items" :key="it.key" class="tab" :class="{ on: active(it.key) }" @click="onTab(it)">
        <span class="t-dot" v-if="active(it.key)"></span>
        <span class="t-icon"><el-icon><component :is="it.icon" /></el-icon></span>
        <span class="t-label">{{ it.label }}</span>
        <span class="t-badge" v-if="it.key === 'notice' && unread">{{ unread > 99 ? '99+' : unread }}</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.tabbar { display:none; }
@media (max-width: 768px) {
  .tabbar {
    display: block;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 200;
    padding: 0 16px calc(20px + env(safe-area-inset-bottom));
    pointer-events: none;
  }

  .tabbar-inner {
    pointer-events: auto;
    display: flex;
    align-items: center;
    justify-content: space-around;
    height: 58px;
    padding: 4px 6px;
    border-radius: 29px;
    background: rgba(255,255,255,0.72);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    backdrop-filter: blur(40px) saturate(180%);
    border: 0.5px solid rgba(255,255,255,0.8);
    box-shadow:
      0 0 0 0.5px rgba(0,0,0,0.04),
      0 8px 32px rgba(0,0,0,0.08),
      0 2px 8px rgba(0,0,0,0.04);
  }

  /* 深色墨金 */
  .zg-inkgold-dark .tabbar-inner {
    background: rgba(30,25,18,0.72);
    border-color: rgba(255,243,214,0.08);
    box-shadow:
      0 0 0 0.5px rgba(255,243,214,0.06),
      0 8px 32px rgba(0,0,0,0.4),
      0 2px 8px rgba(0,0,0,0.2);
  }

  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    flex: 1;
    height: 50px;
    padding: 0 4px;
    color: var(--zg-text-dim);
    cursor: pointer;
    border-radius: 25px;
    transition: color 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    position: relative;
    -webkit-tap-highlight-color: transparent;
  }

  .tab:active { transform: scale(0.88); }
  .tab.on { color: var(--zg-primary); }

  .t-icon {
    font-size: 20px;
    transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .tab.on .t-icon {
    font-size: 22px;
    transform: translateY(-2px);
    filter: drop-shadow(0 3px 8px rgba(var(--zg-primary-rgb), 0.3));
  }

  .t-label {
    font-size: 10px;
    font-weight: 500;
    transition: all 0.2s ease;
    letter-spacing: 0.01em;
    opacity: 0.7;
  }

  .tab.on .t-label {
    font-weight: 700;
    opacity: 1;
    font-size: 10.5px;
  }

  /* 选中项顶部小点：极简指示，不用色块 */
  .t-dot {
    position: absolute;
    top: 6px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--zg-primary);
    box-shadow: 0 0 6px rgba(var(--zg-primary-rgb), 0.5);
  }

  .t-badge {
    position: absolute;
    top: 4px;
    right: 50%;
    transform: translateX(10px);
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 8px;
    background: #ff3b30;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 15px;
    text-align: center;
    box-shadow: 0 2px 6px rgba(255,59,48,0.4);
  }
}
</style>
