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
  // 【v4.8.25 修复「首屏偶发永久卡在 splash 白屏」】
  //   原实现：`await theme.load()` / `await user.fetchProfile()` 等任一请求
  //   若因网络抖动、Worker 冷启动、接口挂死而长时间不返回，
  //   `ready` 就永远停在 false，用户看到的是「一直转圈、无任何报错」的白屏。
  //   修复：给整段初始化套一个**总超时兜底**（6s）。到点无论成败都放行首屏，
  //   后续数据由各页面自己的加载态接管——绝不让"皮肤/统计"这类非关键数据挡住整站。
  const BOOT_TIMEOUT = 6000
  // ==========================================================================
  // 【v4.8.28 性能专项】启动路径三重串行 → 全并行 + 主题移出首屏栅栏
  //
  // 原实现（每个页面首屏都要付这个代价）：
  //   await theme.load()                                     ← 串行 1
  //   await user.fetchProfile()                              ← 串行 2
  //   await Promise.all([loadCommon(), settings.fetchAll()]) ← 串行 3
  //   即：主题 → 用户 → 公共数据，三段耗时**相加**。
  //
  // 改动一（并行）：三组请求**同时**发出，只把「NavBar 真正依赖的」留作栅栏。
  // 改动二（主题不再阻塞，用户确认的取舍）：`theme.load()` 移出栅栏。
  //   理由：主题是纯皮肤（原本就有 3.5s 自愈超时，失败即用默认皮肤）；
  //   实测冷启动时它会撞上 6s 总兜底 —— 让整站首屏白等 6 秒，代价远大于收益。
  //   现在：首屏立即放行（约 1s），主题请求在后台继续，到货后 `applyTheme`
  //   自动应用（通常 100~300ms 内完成，视觉上是一次轻微渐变）。
  //
  // 保留在栅栏里的只有 `user.fetchProfile()`：
  //   NavBar 渲染依赖 `user.current`（头像/姓名/角色/等级）。
  //   注：fetchProfile 内部已把慢的 `myClasses` 剥离到后台（见 store/user.ts），
  //   所以栅栏实际只等 `api.me()`（中位 1.1s）。
  //
  // 其它保证（与原实现一致）：
  //   · 各组独立 catch，任一失败不连坐；
  //   · 未登录时不发 profile / common 请求；
  //   · 6s 总超时兜底（v4.8.25 加的防永久白屏）原样保留。
  // ==========================================================================
  // 主题：后台加载，不阻塞首屏（到货自动应用）
  theme.load().catch((e: any) => {
    console.warn('[boot] theme 加载异常（已忽略）：', e?.message || e)
  })
  const login = user.isLogin
  const profilePromise = login
    ? user.fetchProfile().catch((e: any) => {
        console.warn('[boot] profile 加载异常（已忽略）：', e?.message || e)
      })
    : Promise.resolve()
  // 公共数据（学科/班级）与设置（功能开关/经验规则/站点配置）在 profile 之外、
  //   彼此之间**完全独立**，一并并行发出。
  const commonPromise = login
    ? Promise.all([
        data.loadCommon().catch((e: any) => console.warn('[boot] 公共数据异常（已忽略）：', e?.message || e)),
        settings.fetchAll().catch((e: any) => console.warn('[boot] 设置加载异常（已忽略）：', e?.message || e)),
      ]).then(() => undefined)
    : Promise.resolve()

  const boot = (async () => {
    try {
      // 栅栏：只等 NavBar 渲染依赖的 profile（与原串行顺序的完成条件等价）
      await profilePromise
      // 公共数据/设置不阻塞首屏（NavBar 与路由页均不依赖；各页面自身有 loading 态兜底）
      await commonPromise
    } catch (e: any) {
      console.warn('[boot] 初始化异常（已忽略，放行首屏）：', e?.message || e)
    }
  })()
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!ready.value) console.warn(`[boot] 初始化超过 ${BOOT_TIMEOUT}ms，强制放行首屏`)
      resolve()
    }, BOOT_TIMEOUT)
  })
  try {
    await Promise.race([boot, timeout])
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
