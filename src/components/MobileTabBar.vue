<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const items = computed(() => {
  const arr = [
    { key: 'home', label: '首页', icon: 'HomeFilled', to: '/' },
    { key: 'subjects', label: '学科', icon: 'Reading', to: '/subjects' },
    { key: 'leaderboard', label: '排行', icon: 'Trophy', to: '/leaderboard' },
  ]
  if (user.isStaff) arr.push({ key: 'admin', label: '管理', icon: 'Setting', to: '/admin/users' })
  arr.push({ key: 'profile', label: '我的', icon: 'User', to: '/profile' })
  return arr
})

function active(key: string) {
  if (key === 'home') return route.path === '/'
  if (key === 'subjects') return route.path.startsWith('/subject') || route.path.startsWith('/subjects')
  if (key === 'admin') return route.path.startsWith('/admin')
  return route.path.startsWith('/' + key) || (key === 'profile' && route.path === '/profile')
}
</script>

<template>
  <nav class="tabbar">
    <div v-for="it in items" :key="it.key" class="tab" :class="{ on: active(it.key) }" @click="router.push(it.to)">
      <span class="t-icon"><el-icon><component :is="it.icon" /></el-icon></span>
      <span class="t-label">{{ it.label }}</span>
      <span class="t-dot" v-if="active(it.key)"></span>
    </div>
  </nav>
</template>

<style scoped>
.tabbar { display:none; }
@media (max-width: 768px) {
  .tabbar {
    display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 200;
    height: 64px; padding: 0 6px;
    background: rgba(255,251,235,0.92);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border-top: 1px solid rgba(245,158,11,0.15);
    box-shadow: 0 -4px 20px rgba(245,158,11,0.08);
    justify-content: space-around; align-items: center;
    padding-bottom: env(safe-area-inset-bottom);
  }
  .tab {
    display:flex; flex-direction:column; align-items:center; gap:3px;
    flex:1; padding:8px 0 6px;
    color: var(--zg-text-dim); cursor:pointer;
    border-radius:14px; transition:all .25s cubic-bezier(.2,.8,.2,1);
    position: relative;
  }
  .tab:active { transform: scale(0.9); }
  .tab.on { color: var(--zg-primary); }
  .t-icon { font-size:22px; transition: transform .3s cubic-bezier(.2,.8,.2,1); }
  .t-label { font-size:10px; font-weight:500; }
  .tab.on .t-icon { transform: translateY(-3px) scale(1.15); filter: drop-shadow(0 4px 8px rgba(245,158,11,0.4)); }
  .tab.on .t-label { font-weight:700; }
  .t-dot {
    position: absolute; bottom: 2px;
    width: 4px; height: 4px; border-radius: 50%;
    background: var(--zg-primary);
    animation: zgDotPulse 1.5s ease infinite;
  }
  @keyframes zgDotPulse { 0%,100% { opacity: .5; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }
}
</style>
