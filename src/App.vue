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
  // 【v4.8.28 性能专项】启动路径三重串行 → 全并行
  //
  // 原实现（每个页面首屏都要付这个代价）：
  //   await theme.load()                                     ← 串行 1
  //   await user.fetchProfile()                              ← 串行 2
  //   await Promise.all([loadCommon(), settings.fetchAll()]) ← 串行 3
  //   即：主题 → 用户 → 公共数据，三段耗时**相加**。
  //
  // 改动一（并行）：三组请求**同时**发出，只把「NavBar 真正依赖的」留作栅栏。
  //
  // 改动二（主题不再阻塞首屏）：
  //   ⚠️ 这里曾经踩过一个坑（v4.8.28-fix 已修）：
  //   最初把主题移出栅栏后，`withTimeout(3500ms)` 一超时就 `resolve(null)` 且
  //   **没有任何重试** —— 而该接口实测 1.6s / 2.4s / 9.1s / 9.1s / 11.1s，
  //   超时是常态 → 站点生效的「墨金学术」被降级成「经典暖橘」且整会话回不来。
  //
  //   现在主题走**两层**，既有速度又有确定性：
  //     · 第 1 层（`main.ts` mount 之前）：`applyCachedSync()` 同步读 localStorage
  //       主题缓存并 applyTheme → **首帧就带正确皮肤**，0ms 成本
  //     · 第 2 层（这里调用 `theme.load()`）：后台拉 `/api/themes/active`，
  //       成功即覆盖并回写缓存；失败/超时**带退避重试 3 次**（1s/2s/4s），不再静默放弃
  //
  //   效果：主题**一定**生效，且首屏**不**被网络拖慢。
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
  // 主题：第 2 层（后台拉最新，成功覆盖 + 回写缓存，失败自动重试）
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
  //
  // 【v4.9.0 性能专项】这一组从栅栏里**彻底摘除**。
  //   原实现 `await commonPromise` 在栅栏内，而 `settings.fetchAll()` 包含
  //   `/api/settings/site_config` 与 `/api/settings/exp_rules` —— 这两个接口
  //   在 Worker 冷启动时实测 **7~10s**（curl 连打可见 8s/0.7s 交替）。
  //   后果：`ready` 被拖到 7s+ → 首页路由晚渲染 → 首页的「美文/资料/收藏」
  //   要等到 7s 后才开始发请求（实测 /api/articles 在 7465ms 才发出）。
  //   它们对 NavBar 渲染**毫无贡献**，页面各自都有 loading 态与可选链兜底，
  //   因此改为纯后台加载，成功与否都不影响 ready。
  if (login) {
    data.loadCommon().catch((e: any) => console.warn('[boot] 公共数据异常（已忽略）：', e?.message || e))
    settings.fetchAll().catch((e: any) => console.warn('[boot] 设置加载异常（已忽略）：', e?.message || e))
  }

  const boot = (async () => {
    try {
      // 栅栏：**只**等 NavBar 渲染依赖的 profile（`api.me()`，中位 1.1s）
      await profilePromise
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
      <!-- 【v4.9.0】NavBar 未就绪时的顶部细进度条占位：不挡内容，仅告知「还在初始化导航」 -->
      <div v-else class="zg-topbar-skeleton"><div class="zg-splash-bar"><span></span></div></div>
      <main class="app-main" :class="{ 'has-tabbar': ready && user.isLogin && !isAdminRoute }">
        <!-- 【v4.9.0 性能专项】页面不再被 ready 门控 -->
        <!--   原实现：v-if="!ready" 显示 splash、v-else 渲染 router-view。
        <!--   后果：首页 HomeView 的 onMounted(load) 必须等 ready=true 才执行，
        <!--   而 ready 要等 App.vue 的启动栅栏（profile + loadCommon + settings.fetchAll），
        <!--   其中 settings.fetchAll 含 /api/settings/site_config 与 /api/settings/exp_rules，
        <!--   这两个接口冷启动实测 7~10s → 首页的「美文/资料/收藏」被白白拖到 7s 后才发请求。
        <!--   实测时间线（首访）：/api/subjects 1188ms 就回来了，
        <!--   而 /api/articles 7465ms 才发出 —— 它不是自己慢，是根本没被允许早发。
        <!--   修法：router-view 立即渲染（各页面自身都有 loading 态与可选链兜底），
        <!--   splash 改为「只在 NavBar 还没就绪时」作为顶部占位显示，不阻塞内容区。 -->
        <router-view v-slot="{ Component }">
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
        <router-view v-slot="{ Component }">
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
/* 【v4.9.0】NavBar 未就绪时的顶部占位细条 —— 只在「NavBar 还没出来」的极短窗口内显示，
   不遮挡内容区（页面此时已可交互）。高度与 NavBar 对齐，避免加载完成后布局跳动。 */
.zg-topbar-skeleton { height: 60px; display:flex; align-items:center; justify-content:center; }
.zg-topbar-skeleton .zg-splash-bar { width: 120px; height: 2px; }
@media (max-width: 720px) { .zg-topbar-skeleton { height: 52px; } }
@keyframes zgSplashMove { 0% { transform: translateX(-120%); } 100% { transform: translateX(360%); } }
@media (max-width: 768px) {
  .app-main:not(.public-page) { min-height: calc(100vh - 56px); min-height: calc(100dvh - 56px); }
  /* 移动端：悬浮dock高58px + 底部32px留白 = 90px */
  .has-tabbar { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
}
</style>
