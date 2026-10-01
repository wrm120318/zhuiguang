import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ThemeConfig } from '@/types'
import { api } from '@/api'
import { useSettingsStore, type DesignMode } from '@/store/settings'

interface ThemeRow { id: number; name: string; config: any; is_active: number }

/**
 * 报告 §8.2 favicon 双主题切换：
 * 经典 → /favicon-classic.svg（暖橙）；墨金 → /favicon-inkgold.svg（沉稳金）。
 * 同步改写 meta[theme-color]，让移动端浏览器地址栏配色也跟随皮肤。
 */
function applyFavicon(mode: DesignMode, tone: 'light' | 'dark') {
  const href = mode === 'inkgold' ? '/favicon-inkgold.svg' : '/favicon-classic.svg'
  const icon = document.getElementById('zg-favicon') as HTMLLinkElement | null
  if (icon && icon.getAttribute('href') !== href) icon.setAttribute('href', href)
  const touch = document.getElementById('zg-favicon-touch') as HTMLLinkElement | null
  if (touch && touch.getAttribute('href') !== href) touch.setAttribute('href', href)
  const meta = document.getElementById('zg-theme-color') as HTMLMetaElement | null
  if (meta) {
    const color = mode === 'inkgold' ? (tone === 'dark' ? '#1B1710' : '#FAF8F4') : '#F59E0B'
    if (meta.getAttribute('content') !== color) meta.setAttribute('content', color)
  }
}

// hex → "r, g, b" 通道（用于 --zg-primary-rgb 等半透明底色变量跟随后台自定义色）
function hexToRgbChannels(hex: string): string | null {
  if (typeof hex !== 'string') return null
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

function applyTheme(c: any) {
  if (!c) return
  const root = document.documentElement
  // 【indirection】始终把后台主题色写到 --zg-custom-* 内联变量（墨金类规则用 var(--zg-custom-*) 兜底读取）
  // - 经典模式：同时写直接 --zg-primary 等，覆盖 :root 默认（像素级不变）
  // - 墨金模式：清除直接 --zg-primary 等，让 .zg-inkgold 类规则的 var(--zg-custom-*) 接管
  // 这样自定义色在两种模式都生效，墨金模式无自定义时仍走沉稳金默认
  const writeCustom = (p: string, v: string) => { if (v) root.style.setProperty(p, v) }
  const writeDirect = (p: string, v: string) => { if (v) root.style.setProperty(p, v) }
  const removeDirect = (p: string) => root.style.removeProperty(p)

  // RGB 通道：跟随后台自定义色（用于 rgba() 表达式）
  const pr = hexToRgbChannels(c.primary); if (pr) root.style.setProperty('--zg-custom-primary-rgb', pr)
  const p2 = hexToRgbChannels(c.primary2); if (p2) root.style.setProperty('--zg-custom-primary-2-rgb', p2)
  const ac = hexToRgbChannels(c.accent); if (ac) root.style.setProperty('--zg-custom-accent-rgb', ac)

  if (c.designMode === 'inkgold') {
    // 墨金模式：写 --zg-custom-* 供类规则 var() 读取；清除直接 --zg-primary 等让位给墨金规则
    writeCustom('--zg-custom-primary', c.primary)
    writeCustom('--zg-custom-primary-2', c.primary2)
    writeCustom('--zg-custom-accent', c.accent)
    // 圆角/毛玻璃：墨金模式仍走皮肤默认（22px/22px），不写直接值（类规则 !important 已稳控）
    // 清除直接值防止后台经典配置残留击穿墨金
    removeDirect('--zg-primary'); removeDirect('--zg-primary-2'); removeDirect('--zg-accent')
    removeDirect('--zg-bg-from'); removeDirect('--zg-bg-via'); removeDirect('--zg-bg-to')
    removeDirect('--zg-blur'); removeDirect('--zg-radius')
    removeDirect('--zg-primary-rgb'); removeDirect('--zg-primary-2-rgb'); removeDirect('--zg-accent-rgb')
  } else {
    // 经典模式：直接写 --zg-primary 等（铁律 4/5：后台自定义色板照常生效）
    writeDirect('--zg-primary', c.primary)
    writeDirect('--zg-primary-2', c.primary2)
    writeDirect('--zg-accent', c.accent)
    writeDirect('--zg-bg-from', c.bgFrom)
    writeDirect('--zg-bg-via', c.bgVia)
    writeDirect('--zg-bg-to', c.bgTo)
    writeDirect('--zg-blur', c.blur + 'px')
    writeDirect('--zg-radius', c.radius + 'px')
    // 经典档 RGB 通道也直接写
    if (pr) root.style.setProperty('--zg-primary-rgb', pr)
    if (p2) root.style.setProperty('--zg-primary-2-rgb', p2)
    if (ac) root.style.setProperty('--zg-accent-rgb', ac)
  }
  // 设计模式（皮肤开关）：墨金加 zg-inkgold 类，经典移除 → 基础样式完全不变
  root.classList.toggle('zg-inkgold', c.designMode === 'inkgold')
  // 墨金学术深浅档：designMode==='inkgold' 且 inkgoldTone==='dark' 时叠加 zg-inkgold-dark
  root.classList.toggle('zg-inkgold-dark', c.designMode === 'inkgold' && (c.inkgoldTone || 'light') === 'dark')
  // 墨金·背景亮度档（后台界面风格可切换；soft 温和 / bright 明显）
  root.classList.toggle('zg-inkgold-bright', c.designMode === 'inkgold' && (c.bright || 'soft') === 'bright')

  const mode: DesignMode = c.designMode === 'inkgold' ? 'inkgold' : 'classic'
  const tone: 'light' | 'dark' = (c.inkgoldTone || 'light') === 'dark' ? 'dark' : 'light'
  // 报告 §8.2：站点图标 / 地址栏配色跟随皮肤
  applyFavicon(mode, tone)
  // 报告 §9.3：把当前设计模式同步进 settings store，驱动 activeSiteConfig 切换到对应那一套自定义
  try { useSettingsStore().setDesignMode(mode) } catch { /* pinia 未就绪（极早期调用）时忽略 */ }
}

export const useThemeStore = defineStore('theme', () => {
  const themes = ref<ThemeRow[]>([])
  const activeTheme = ref<ThemeRow | null>(null)
  const draft = ref<any>(null)
  const loaded = ref(false)

  /**
   * 【v4.8.25 修复「首屏偶发卡在 splash」】
   * 原实现 `Promise.all([api.themes(), api.activeTheme()])` 有两个隐患：
   *   ① 任一请求慢（实测 `/api/themes/active` 冷查询 D1 可达 5~8s）→ 整体被拖住；
   *   ② 请求挂死（无响应）→ `await` 永远不返回，App.vue 的 `ready` 永远为 false，
   *      用户看到的就是「一直转圈的白屏 splash」，且无任何报错可查。
   * 修复原则：**主题是皮肤，属"锦上添花"，绝不能阻塞首屏**。
   *   · 给两个请求各加 ms 超时，超时即放弃（保留 :root 默认主题，站点照常可用）；
   *   · 任何一个失败/超时都只记警告，不向调用方抛错；
   *   · 成功后正常应用主题与 favicon。
   *
   * 【v4.8.28 性能专项】拆掉「每个页面都为后台功能买单」的冗余传输：
   *   原实现每次都拉 `/api/themes`（**全量主题列表**，实测 **11973 字节**、
   *   耗时 **3.1~10.4s**），而全站**只有后台「界面风格编辑器」**（ThemeView）
   *   才需要这个列表；前台每页真正需要的只有 `/api/themes/active`（**306 字节**）。
   *   现在 `load()` 只拉 active；全量列表改由 `loadList()` 按需加载，
   *   由 ThemeView 在进入时调用 → 前台 26 个页面每页省下一次 12KB 请求。
   *
   *   为什么零行为变更：
   *     · `activeTheme` / `draft` 的赋值逻辑一字未动，来源仍是 `/api/themes/active`；
   *     · `themes` 数组的唯一消费者是 ThemeView，它在 onMounted 里显式 `loadList()`；
   *     · `apply()` / `saveDraft()` 后原本为了刷新列表而调 `load()`，
   *       现在它们同时刷 active **和** 列表（`refreshAll()`），后台行为不变。
   */
  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T | null> =>
    new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`[theme] ${label} 超时（${ms}ms），先用本地缓存/默认皮肤兜底，后台继续等待`)
        resolve(null)
      }, ms)
      p.then((v) => { clearTimeout(timer); resolve(v) })
       .catch((e) => { clearTimeout(timer); console.warn(`[theme] ${label} 失败：`, e?.message || e); resolve(null) })
    })

  const THEME_CACHE_KEY = 'zg_theme_active'
  const THEME_CACHE_TTL = 24 * 60 * 60 * 1000   // 24h：主题是低频变更的站点级配置

  function readThemeCache(): any | null {
    try {
      const raw = localStorage.getItem(THEME_CACHE_KEY)
      if (!raw) return null
      const o = JSON.parse(raw)
      if (!o || !o.config) return null
      if (o.ts && Date.now() - o.ts > THEME_CACHE_TTL) return null
      return o
    } catch { return null }
  }
  function writeThemeCache(active: any) {
    try {
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ ...active, ts: Date.now() }))
    } catch { /* 隐私模式/配额满：忽略 */ }
  }

  /** 全量主题列表（摘要：id / name / is_active / config{primary,accent}）
   *  —— 仅后台「界面风格编辑器」需要；前台不再拉取（v4.8.28） */
  async function loadList() {
    const list = await withTimeout(api.themes() as any, 3500, 'themes')
    if (Array.isArray(list)) themes.value = list
    return themes.value
  }

  /** 单个主题的完整配置（后台点选预设时按需加载，避免全量传输） */
  async function loadOne(id: number) {
    const t: any = await api.theme(id)
    // 同步进列表，保证 themes 数组与后台显示一致
    if (t) {
      const i = themes.value.findIndex((x: any) => x.id === id)
      if (i >= 0) themes.value[i] = { ...themes.value[i], ...t }
    }
    return t
  }

  /**
   * 【v4.8.28-fix 修复「主题不生效」副作用】
   *
   * 上一版把主题移出首屏栅栏后引入了一个**比性能问题更严重的回归**：
   *   `withTimeout(api.activeTheme(), 3500ms)` 一旦超时，就 `resolve(null)`
   *   直接放弃 —— 而**没有任何重试**。实测 `/api/themes/active` 耗时
   *   **1.6s / 2.4s / 9.1s / 9.1s / 11.1s**，超过 3.5s 是常态。
   *   结果：站点生效主题是「墨金学术」，用户却看到「经典暖橘」，
   *   而且**整个会话都回不来**（load() 只被调用一次）。
   *
   * 现在改为「本地缓存秒开 + 后台必达」两层：
   *   第 1 层（同步、0ms）：读 localStorage 主题缓存，**立即** applyTheme
   *     —— 首屏拿到的就是用户上次见到的正确皮肤，不是 :root 兜底
   *   第 2 层（后台）：请求 `/api/themes/active`，**成功即覆盖**并写回缓存
   *
   * ⚠️ v4.8.28-fix2 又修掉一个隐藏缺陷（第二轮踩坑）：
   *   上一版第 2 层是「for 循环里每轮 `withTimeout(fetch())`，超时就再发一个新请求」。
   *   实测（延迟 5s 场景）发现**重试链根本没生效**：
   *     · `withTimeout` 超时只是把**等待**放弃了，**底层 HTTP 请求仍在天上飞**，
   *       它占着浏览器对同域（HTTP/1.1）的连接池槽位；
   *     · 下一轮重试的新请求排在旧请求后面，反而更晚才拿到响应；
   *     · 每轮又是**重新计时**，窗口全被浪费 → 20s 都没收敛。
   *   正确做法是**不放弃原请求**：只发**一次** `api.activeTheme()`，
   *   让它自己慢慢跑（soft timeout 只用于"先兜底显示"，不用于"放弃"），
   *   响应回来**无条件覆盖**。真正意义上的"最终放弃"只留一个很长的硬上限
   *   （HARD_TIMEOUT，50s）防止永不返回的挂死请求，正常网络永远不会触发。
   *
   * 这样同时满足三条硬要求：
   *   · 主题**一定**会生效（本地缓存秒开 + 单请求必达）
   *   · 首屏**不**被拖慢（同步缓存读完就放行，网络请求在后台进行）
   *   · 慢接口**不**再被超时丢弃（不重发、不重算窗口，等的是同一个 Promise）
   *
   * 缓存失效（杜绝"缓存覆盖新修改"）：
   *   · `apply()` / `saveDraft()` 保存后 → `refreshAll()` → 成功即 `writeThemeCache()`
   *   · `reset()` 不写缓存（它只是把 UI 还原成 activeTheme，不代表站点配置变更）
   */
  async function load() {
    // ── 第 1 层：本地缓存秒开（同步，不阻塞） ──
    const cached = readThemeCache()
    if (cached) {
      activeTheme.value = cached
      applyTheme(cached.config)
      draft.value = { ...cached.config, id: cached.id, name: cached.name }
    }

    // ── 第 2 层：单个后台请求，长等待 + 软兜底 + 硬上限 ──
    // 只发一次请求：超时只影响"是否继续等"，不影响"请求是否存在"。
    const HARD_TIMEOUT = 50000   // 真正的最终放弃线：仅防挂死，正常网络永不触发
    const SOFT_TIMEOUT = 2500    // 软兜底：超过此时长用户在首访场景会先看到 :root 默认皮肤

    let settled = false
    const req = (async (): Promise<any | null> => {
      try {
        return await api.activeTheme()
      } catch (e: any) {
        console.warn('[theme] themes/active 请求失败：', e?.message || e)
        return null
      }
    })()

    const softTimer = setTimeout(() => {
      if (!settled && !cached) {
        console.warn(`[theme] themes/active 超过 ${SOFT_TIMEOUT}ms 未返回，首访先用默认皮肤兜底，请求继续等待`)
      }
    }, SOFT_TIMEOUT)

    const hardTimer = setTimeout(() => {
      if (!settled) console.warn(`[theme] themes/active 超过 ${HARD_TIMEOUT}ms 仍未返回，放弃等待（请求可能已挂死）`)
    }, HARD_TIMEOUT)

    // 竞争：谁先到用谁。请求先到 → 应用真实主题；硬超时先到 → 沿用缓存/默认皮肤。
    const active: any = await Promise.race([
      req,
      new Promise<null>((r) => setTimeout(() => r(null), HARD_TIMEOUT)),
    ])
    settled = true
    clearTimeout(softTimer)
    clearTimeout(hardTimer)

    if (active) {
      activeTheme.value = active
      applyTheme(active.config)
      draft.value = { ...active.config, id: active.id, name: active.name }
      writeThemeCache(active)
    } else {
      console.warn('[theme] themes/active 未取到，沿用本地缓存/默认皮肤')
    }
    loaded.value = true
  }

  /** 后台专用：同时刷新「当前生效主题」与「全量主题列表」 */
  async function refreshAll() {
    await Promise.all([load(), loadList()])
  }

  function preview(c: any) { applyTheme(c) }

  async function apply(id: number) {
    await api.setActiveTheme(id)
    // 后台操作：生效主题 + 列表都要刷新（保存后回显正确）
    await refreshAll()
  }

  async function saveDraft(data: { id?: number; name: string; config: any; isActive: boolean }) {
    if (data.id) await api.updateTheme(data.id, { name: data.name, config: data.config, isActive: data.isActive })
    else await api.createTheme({ name: data.name, config: data.config, isActive: data.isActive })
    await refreshAll()
  }

  function reset() {
    if (activeTheme.value) { applyTheme(activeTheme.value.config); draft.value = { ...activeTheme.value.config, id: activeTheme.value.id, name: activeTheme.value.name } }
  }

  /**
   * 【v4.8.28-fix】极早期同步应用本地主题缓存。
   * 在 `main.ts` 里 **mount 之前** 调用 —— 这样首帧渲染就已经带着正确皮肤，
   * 不会出现「先经典暖橘、再闪成墨金」的跳变，也不受任何网络耗时影响。
   * 纯 localStorage 同步读取，零成本；无缓存时是 no-op（走 :root 默认）。
   */
  function applyCachedSync() {
    const c = readThemeCache()
    if (!c) return false
    activeTheme.value = c
    applyTheme(c.config)
    draft.value = { ...c.config, id: c.id, name: c.name }
    return true
  }

  return { themes, activeTheme, draft, loaded, load, loadList, loadOne, refreshAll, preview, apply, saveDraft, reset, applyTheme, applyCachedSync }
})