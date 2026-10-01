import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api'

// 功能开关：与后端 feature_flags 表对应；缺失视为开启
export type FlagKey =
  | 'quiz' | 'blog' | 'guide' | 'announcement' | 'message'
  | 'leaderboard' | 'favorites' | 'search' | 'subjects'
  | 'registration_enabled'

const LABELS: Record<FlagKey, string> = {
  quiz: '题库自测',
  blog: '网站博客',
  guide: '网站说明',
  announcement: '网站公告',
  message: '站内信',
  leaderboard: '经验排行榜',
  favorites: '我的收藏',
  search: '搜索',
  subjects: '学科子站',
  registration_enabled: '自助注册',
}

// hex → "r, g, b" 通道（供 rgba(var(--zg-*-rgb), a) 半透明表达式跟随自定义主色，守铁律9）
function hexToRgbChannels(hex: string): string | null {
  if (typeof hex !== 'string') return null
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

export type DesignMode = 'classic' | 'inkgold'

export const useSettingsStore = defineStore('settings', () => {
  const flags = ref<Record<string, boolean>>({})
  const expRules = ref<Record<string, number>>({})
  // 原始配置：报告 §9 升级为双主题结构 { classic: {...}, inkgold: {...} }
  const siteConfig = ref<any>(null)
  const siteConfigLoaded = ref(false)
  const loaded = ref(false)
  // 当前设计模式（由 theme.ts applyTheme 同步写入，驱动 activeSiteConfig 响应式切换）
  const designMode = ref<DesignMode>('classic')

  function setDesignMode(m: DesignMode) {
    if (designMode.value === m) return
    designMode.value = m
    // 模式切换后主色归属随之变化，重新应用一次（墨金走 --zg-custom-*，经典走直接变量）
    applyPrimaryColor()
  }

  /**
   * 报告 §9.3 前台消费入口：按当前 designMode 取对应主题的那一套完整配置。
   * - 双主题结构 → 取 classic / inkgold 子对象（各自独立，互不覆盖）
   * - 旧单份结构（后端未升级 / 接口降级）→ 原样返回，保证向后兼容不白屏
   */
  const activeSiteConfig = computed<any>(() => {
    const raw = siteConfig.value
    if (!raw) return null
    if (raw.classic || raw.inkgold) {
      return raw[designMode.value] || raw.classic || raw.inkgold || null
    }
    return raw
  })

  /**
   * 应用当前主题那一套的自定义主色。
   * 铁律11 indirection：
   * - 经典模式 → 直接写 --zg-primary（历史行为，像素级不变）
   * - 墨金模式 → 写 --zg-custom-primary，由 .zg-inkgold 类规则的 var(--zg-custom-primary, 金) 读取；
   *   同时清掉直接值，避免经典橙击穿金色学术皮肤（根治"墨金下橙色打架"）。
   */
  function applyPrimaryColor() {
    const root = document.documentElement
    const color = activeSiteConfig.value?.primaryColor
    const rgb = hexToRgbChannels(color)
    if (designMode.value === 'inkgold') {
      root.style.removeProperty('--zg-primary')
      root.style.removeProperty('--zg-primary-rgb')
      if (color) root.style.setProperty('--zg-custom-primary', color)
      else root.style.removeProperty('--zg-custom-primary')
      if (rgb) root.style.setProperty('--zg-custom-primary-rgb', rgb)
      else root.style.removeProperty('--zg-custom-primary-rgb')
    } else {
      if (color) root.style.setProperty('--zg-primary', color)
      if (rgb) root.style.setProperty('--zg-primary-rgb', rgb)
    }
  }

  // ==========================================================================
  // 【v4.8.28 性能专项】功能开关 / 经验规则 会话级缓存 + 并发去重
  //
  // 问题（生产实测基线）：`/api/feature-flags/public` 与 `/api/settings/exp_rules`
  //   在 **26/26 个页面** 都被请求 —— 每切一次路由重拉一遍。
  //   而这两个接口的数据只会由**超管在后台手动保存**时才变（变动极低频）。
  //
  // 做法：inflight 去重（合并同一时刻的重复调用）+ 会话级缓存（TTL 内直接复用）。
  //
  // 为什么「缓存不会覆盖新修改」：
  //   · saveFlags / saveRules 保存成功后**显式置新鲜度**（数据以刚保存的为准）；
  //   · 后台保存页重新加载时用 `force=true` 走网络；
  //   · TTL 到期自动重拉；
  //   · 首次加载（loaded=false）永远走网络。
  // ==========================================================================
  const SETTINGS_TTL = 5 * 60 * 1000
  let settingsFetchedAt = 0
  let settingsInflight: Promise<void> | null = null

  async function fetchAll(force = false) {
    // 并发去重：同一时刻多处调用只发一次
    if (!force && settingsInflight) return settingsInflight
    // 会话级缓存：已加载且新鲜 → 不重复请求
    if (!force && loaded.value && settingsFetchedAt > 0 && Date.now() - settingsFetchedAt < SETTINGS_TTL) {
      // 站点配置仍需保证已加载（它有自己的 inflight 去重与 loaded 标记）
      if (!siteConfigLoaded.value) fetchSiteConfig()
      return
    }
    const p = (async () => {
      try {
        // 非超管用户使用公开接口获取功能开关，避免403权限弹窗
        const [f, r] = await Promise.all([
          api.publicFeatureFlags() as any,
          api.getExpRules() as any,
        ])
        flags.value = f || {}
        expRules.value = r || {}
        loaded.value = true
        settingsFetchedAt = Date.now()
      } catch (e) {
        // 未登录或加载失败时，默认全部开启；但不标记 loaded=true，以便后续重新加载
        console.warn('[settings] 加载失败，默认全部开启', e)
        flags.value = {}
        expRules.value = {}
      }
      // 站点配置独立加载，不依赖登录状态
      fetchSiteConfig()
    })()
    settingsInflight = p
    try {
      await p
    } finally {
      if (settingsInflight === p) settingsInflight = null
    }
  }

  // 【v4.8.26 性能专项】站点配置并发去重
  //   实测首页一次加载 `/api/settings/site_config` 被并发请求 **3 次**
  //   （App.vue 的 fetchAll、NavBar 的独立调用、以及其他组件的 ensure 逻辑）。
  //   该接口数据对所有人一致、且由管理员手动编辑（变动极低频），
  //   因此并发窗口内复用同一 Promise 是最优解。
  //   注意：只去重「进行中」的请求，返回后立即清空 → 后续调用仍能拿到最新数据。
  //
  // 【v4.8.28 性能专项】在原有「并发去重」之上再叠加「会话级缓存」：
  //   基线实测该接口在 **26/26 个页面** 都被请求一次（每切路由重拉）。
  //   现在已加载且 TTL（5min）内 → 直接复用，零请求。
  //   不覆盖新修改的保证：
  //     · saveSiteConfig() 保存后 siteConfig.value 已是保存后的值，并刷新新鲜度；
  //     · 后台站点配置页保存后调 fetchSiteConfig(true) 强制走网络回显；
  //     · TTL 到期自动重拉；首次（siteConfigLoaded=false）永远走网络。
  let siteConfigInflight: Promise<any> | null = null
  let siteConfigFetchedAt = 0
  const SITE_CONFIG_TTL = 5 * 60 * 1000

  async function fetchSiteConfig(force = false) {
    if (!force && siteConfigInflight) return siteConfigInflight
    if (!force && siteConfigLoaded.value && siteConfigFetchedAt > 0 && Date.now() - siteConfigFetchedAt < SITE_CONFIG_TTL) return
    const p = (async () => {
      try {
        siteConfig.value = await api.getSiteConfig()
        // 应用当前主题那一套的自定义主色（分主题，互不干扰）
        applyPrimaryColor()
      } catch {
        // 配置加载失败，使用默认值
        siteConfig.value = null
      } finally {
        siteConfigLoaded.value = true
        siteConfigFetchedAt = Date.now()
        siteConfigInflight = null
      }
    })()
    siteConfigInflight = p
    return p
  }

  /**
   * 保存某一套主题的配置（报告 §9.3）。
   * @param config 该主题的完整配置对象
   * @param mode   目标主题；省略时保存到当前 designMode 对应的那一套
   * 保存后本地 siteConfig 同步更新 → 前台立即生效、后台回显正确（全链路闭环）。
   */
  async function saveSiteConfig(config: any, mode?: DesignMode) {
    const m: DesignMode = mode || designMode.value
    const raw = siteConfig.value || {}
    let next: any
    if (raw.classic || raw.inkgold) {
      next = { ...raw, [m]: { ...(raw[m] || {}), ...config } }
    } else {
      // 首次从旧单份结构升级：两套均以现有值为初值，仅目标主题应用本次改动（不丢数据）
      const legacy = { ...raw }
      next = {
        classic: m === 'classic' ? { ...legacy, ...config } : { ...legacy },
        inkgold: m === 'inkgold' ? { ...legacy, ...config } : { ...legacy },
      }
    }
    await api.saveSiteConfig(next)
    siteConfig.value = next
    // 【v4.8.28】本地已是保存后的最新值 → 刷新新鲜度，避免下次进入被旧缓存覆盖
    siteConfigLoaded.value = true
    siteConfigFetchedAt = Date.now()
    applyPrimaryColor()
  }

  async function saveFlags(next: Record<string, boolean>) {
    await api.saveFeatureFlags(next)
    flags.value = { ...next }
    // 【v4.8.28】刚保存的就是最新数据 → 标记新鲜度，避免随后的 fetchAll 又拉一次旧值
    loaded.value = true
    settingsFetchedAt = Date.now()
  }

  async function saveRules(next: Record<string, number>) {
    await api.saveExpRules(next)
    expRules.value = { ...next }
    loaded.value = true
    settingsFetchedAt = Date.now()
  }

  function isEnabled(key: FlagKey): boolean {
    // 未加载或字段缺失时，视为开启
    if (!loaded.value) return true
    if (!(key in flags.value)) return true
    return flags.value[key] !== false
  }

  const flagLabels = LABELS

  return {
    flags, expRules, siteConfig, siteConfigLoaded, loaded, flagLabels,
    // 双主题分套（报告 §9）
    designMode, activeSiteConfig, setDesignMode, applyPrimaryColor,
    fetchAll, fetchSiteConfig, saveSiteConfig, saveFlags, saveRules, isEnabled,
  }
})
