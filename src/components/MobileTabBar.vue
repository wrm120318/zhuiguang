<script setup lang="ts">
import { computed, ref, onMounted, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import { api } from '@/api'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const settings = useSettingsStore()

const unread = ref(0)
const activeIndex = ref(0)
const tabRefs = ref<HTMLElement[]>([])

async function loadNotices() {
  if (!user.isLogin) { unread.value = 0; return }
  try { const list: any = await api.notices(); unread.value = (list || []).filter((n: any) => !n.read).length } catch { /* */ }
}
onMounted(() => { 
  loadNotices()
  window.addEventListener('zg-notice-read', loadNotices)
  nextTick(updateIndicator)
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

function setTabRef(el: any, i: number) {
  if (el) tabRefs.value[i] = el
}

function updateIndicator() {
  const idx = items.value.findIndex(it => active(it.key))
  activeIndex.value = idx >= 0 ? idx : 0
}

function onTab(it: any, idx: number) {
  activeIndex.value = idx
  if (it.action === 'notice') { window.dispatchEvent(new CustomEvent('zg-open-notice')); loadNotices(); return }
  router.push(it.to)
}

// 路由变化时更新指示器位置
import { watch } from 'vue'
watch(() => route.fullPath, () => { nextTick(updateIndicator) })
</script>

<template>
  <nav class="tabbar">
    <!-- 悬浮药丸背景 -->
    <div class="tabbar-pill"></div>
    <!-- 选中态滑动指示器 -->
    <div class="tab-indicator" :style="{ transform: `translateX(calc(${activeIndex} * 100% + ${activeIndex} * 0px))` }"></div>
    
    <div v-for="(it, i) in items" :key="it.key" :ref="(el) => setTabRef(el, i)" class="tab" :class="{ on: active(it.key) }" @click="onTab(it, i)">
      <span class="t-icon-wrap">
        <span class="t-icon"><el-icon><component :is="it.icon" /></el-icon></span>
      </span>
      <span class="t-label">{{ it.label }}</span>
      <span class="t-badge" v-if="it.key === 'notice' && unread">{{ unread > 99 ? '99+' : unread }}</span>
    </div>
  </nav>
</template>

<style scoped>
.tabbar { display:none; }
@media (max-width: 768px) {
  .tabbar {
    display: flex;
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 200;
    height: 62px;
    padding: 5px;
    width: calc(100% - 32px);
    max-width: 420px;
    justify-content: space-around;
    align-items: stretch;
    gap: 2px;
  }

  /* 悬浮药丸容器：2026高端柔光玻璃 */
  .tabbar-pill {
    position: absolute;
    inset: 0;
    border-radius: 31px;
    background: linear-gradient(155deg, rgba(255,255,255,0.92), rgba(255,253,249,0.85));
    -webkit-backdrop-filter: blur(40px) saturate(220%);
    backdrop-filter: blur(40px) saturate(220%);
    border: 1px solid rgba(255,255,255,0.8);
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.95),
      inset 0 -1px 0 rgba(255,255,255,0.4),
      0 2px 8px -2px rgba(120,90,30,0.06),
      0 12px 36px -8px rgba(120,90,30,0.12),
      0 24px 48px -16px rgba(120,90,30,0.10);
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* 深色模式适配 */
  .zg-inkgold-dark .tabbar-pill {
    background: linear-gradient(155deg, rgba(56,48,34,0.90), rgba(40,32,22,0.82));
    border-color: rgba(255,243,214,0.10);
    box-shadow:
      inset 0 1px 0 rgba(255,243,214,0.12),
      0 2px 8px -2px rgba(0,0,0,0.30),
      0 12px 36px -8px rgba(0,0,0,0.35),
      0 24px 48px -16px rgba(0,0,0,0.25);
  }

  /* 经典橙色模式适配 */
  html:not(.zg-inkgold) .tabbar-pill {
    background: linear-gradient(155deg, rgba(255,255,255,0.92), rgba(255,248,240,0.85));
    border-color: rgba(255,255,255,0.8);
  }

  /* 选中态滑动指示器 */
  .tab-indicator {
    position: absolute;
    top: 5px;
    left: 5px;
    width: calc(20% - 2px);
    height: calc(100% - 10px);
    border-radius: 26px;
    background: linear-gradient(155deg, rgba(var(--zg-primary-rgb), 0.14), rgba(var(--zg-primary-rgb), 0.08));
    box-shadow:
      inset 0 1px 0 rgba(255,255,255,0.6),
      0 2px 8px -2px rgba(var(--zg-primary-rgb), 0.10);
    transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    z-index: 0;
  }

  .zg-inkgold-dark .tab-indicator {
    background: linear-gradient(155deg, rgba(var(--zg-primary-rgb), 0.20), rgba(var(--zg-primary-rgb), 0.12));
    box-shadow:
      inset 0 1px 0 rgba(255,243,214,0.10),
      0 2px 8px -2px rgba(0,0,0,0.25);
  }

  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    flex: 1;
    padding: 8px 2px 6px;
    color: var(--zg-text-dim);
    cursor: pointer;
    border-radius: 26px;
    transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
    position: relative;
    z-index: 1;
    -webkit-tap-highlight-color: transparent;
  }

  .tab:active { transform: scale(0.92); }
  .tab.on { color: var(--zg-primary); }

  .t-icon-wrap {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .t-icon {
    font-size: 20px;
    transition: all 0.35s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .tab.on .t-icon-wrap {
    transform: translateY(-1px);
  }

  .tab.on .t-icon {
    font-size: 22px;
    filter: drop-shadow(0 3px 8px rgba(var(--zg-primary-rgb), 0.35));
  }

  .t-label {
    font-size: 10px;
    font-weight: 500;
    transition: all 0.25s ease;
    letter-spacing: 0.02em;
  }

  .tab.on .t-label {
    font-weight: 700;
    font-size: 10.5px;
  }

  .t-badge {
    position: absolute;
    top: 4px;
    right: 50%;
    transform: translateX(12px);
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 9px;
    background: linear-gradient(135deg, #ef4444, #dc2626);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    box-shadow:
      0 2px 6px rgba(239,68,68,0.45),
      inset 0 1px 0 rgba(255,255,255,0.25);
    z-index: 2;
  }

  /* 安全区域适配 */
  @supports (padding-bottom: env(safe-area-inset-bottom)) {
    .tabbar {
      bottom: calc(12px + env(safe-area-inset-bottom));
    }
  }
}
</style>
