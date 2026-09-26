<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useThemeStore } from '@/store/theme'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { useSettingsStore } from '@/store/settings'
import { api } from '@/api'
import { ElMessageBox } from 'element-plus'
import NavBar from '@/components/NavBar.vue'
import MobileTabBar from '@/components/MobileTabBar.vue'
import LogoMark from '@/components/LogoMark.vue'

const route = useRoute()
const router = useRouter()
const theme = useThemeStore()
const user = useUserStore()
const data = useDataStore()
const settings = useSettingsStore()
const ready = ref(false)
const isPublicPage = computed(() => route.meta.public === true)
const isAdminRoute = computed(() => route.path.startsWith('/admin'))
// 【v4.8.14】题库/测验路由统一标记：这些页面按钮密集（实测 109 处 size="small"，
//   渲染为 36px 高），低于移动端 44px 触控标准。挂 body 类后由 main.css 统一抬升，
//   避免逐个改 15 个页面、109 处模板（违反"不重构"铁律）。
const isQuizRoute = computed(() =>
  route.path.startsWith('/quiz') ||
  route.path.startsWith('/practice') ||
  route.path.startsWith('/wrong-book') ||
  /\/subject\/[^/]+\/(bank|assemble|analytics|exams)/.test(route.path)
)
const designMode = computed(() => theme.activeTheme?.config?.designMode)

watchEffect(() => {
  document.body.classList.toggle('is-admin-route', isAdminRoute.value)
  document.body.classList.toggle('is-quiz-route', isQuizRoute.value)
})

let statusTimer: any = null
async function checkDisabledAndHandle() {
  try {
    const r: any = await api.meStatus()
    if (r.disabled) {
      stopStatusTimer()
      user.logout()
      await ElMessageBox.alert('您的账号已被管理员禁用，请联系管理员。', '账号已禁用', { type: 'error', showClose: false, confirmButtonText: '知道了' })
      router.push('/login')
    }
  } catch { /* ignore */ }
}

// v4.4.29 性能：30s 轮询在页面隐藏(切后台/锁屏)时暂停，回到前台再恢复，避免无谓请求与耗电
function startStatusTimer() {
  stopStatusTimer()
  statusTimer = setInterval(async () => {
    if (user.isLogin && !document.hidden) await checkDisabledAndHandle()
  }, 30000)
}
function stopStatusTimer() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
}
function handleVisibility() {
  if (document.hidden) stopStatusTimer()
  else startStatusTimer()
}

onMounted(async () => {
  try {
    await theme.load()
    if (user.isLogin) {
      await user.fetchProfile().catch(() => {})
      await Promise.all([data.loadCommon(), settings.fetchAll().catch(() => {})])
    }
  } finally {
    ready.value = true
  }
  // Bug4: 每30秒轮询账号禁用状态（页面隐藏时自动暂停）
  startStatusTimer()
  document.addEventListener('visibilitychange', handleVisibility)
})

onBeforeUnmount(() => {
  stopStatusTimer()
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <div class="zg-root">
    <div class="zg-bgimg"></div>
    <div class="zg-bg"></div>
    <div class="zg-orb a"></div>
    <div class="zg-orb b"></div>
    <div class="zg-orb c"></div>

    <!-- 非公开页面 -->
    <template v-if="!isPublicPage">
      <NavBar v-if="ready" />
      <main class="app-main" :class="{ 'has-tabbar': ready && user.isLogin && !isAdminRoute }">
        <div v-if="!ready" class="zg-splash">
          <LogoMark class="zg-splash-logo" />
          <div class="zg-splash-name zg-grad-text">追光</div>
          <div class="zg-splash-bar"><span></span></div>
        </div>
        <router-view v-else v-slot="{ Component }">
          <transition :name="designMode === 'inkgold' ? 'zg-page' : 'fade'" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </main>
      <MobileTabBar v-if="ready && user.isLogin && !isAdminRoute" />
    </template>

    <!-- 公开页面 -->
    <template v-else>
      <main class="app-main public-page">
        <div v-if="!ready" class="zg-splash">
          <LogoMark class="zg-splash-logo" />
          <div class="zg-splash-name zg-grad-text">追光</div>
          <div class="zg-splash-bar"><span></span></div>
        </div>
        <router-view v-else v-slot="{ Component }">
          <transition :name="designMode === 'inkgold' ? 'zg-page' : 'fade'" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </main>
    </template>
  </div>
</template>

<style scoped>
.zg-root { position: relative; }
/* 主题背景图层：默认隐藏（经典模式不动，铁律1）；仅墨金作用域在 main.css 显示 */
.zg-bgimg { position: fixed; inset: 0; z-index: -3; pointer-events: none; display: none; background-size: cover; background-position: center; background-repeat: no-repeat; }
.app-main { min-height: calc(100vh - 64px); min-height: calc(100dvh - 64px); }
.app-main.public-page { min-height: 100vh; min-height: 100dvh; }
.has-tabbar { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
.zg-splash { display:flex; flex-direction:column; align-items:center; justify-content:center; height:80vh; height:80dvh; gap:14px; }
.public-page .zg-splash { height:100vh; height:100dvh; }
.zg-splash-logo { font-size:56px; filter: drop-shadow(0 0 16px rgba(var(--zg-primary-rgb),0.4)); animation: zgBreath 3.2s ease-in-out infinite; }
.zg-splash-name { font-size:26px; font-weight:800; letter-spacing:3px; }
.zg-splash-bar { width:140px; height:3px; border-radius:3px; background: rgba(var(--zg-primary-rgb),0.18); overflow:hidden; }
.zg-splash-bar span { display:block; height:100%; width:40%; border-radius:3px; background: linear-gradient(90deg, transparent, var(--zg-primary), transparent); animation: zgSplashMove 1.3s ease-in-out infinite; }
@keyframes zgSplashMove { 0% { transform: translateX(-120%); } 100% { transform: translateX(360%); } }
@media (max-width: 768px) {
  .app-main:not(.public-page) { min-height: calc(100vh - 56px); min-height: calc(100dvh - 56px); }
  /* 移动端：悬浮dock高58px + 底部32px留白 = 90px */
  .has-tabbar { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
}
</style>
