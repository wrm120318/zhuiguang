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

  async function fetchAll() {
    try {
      // 非超管用户使用公开接口获取功能开关，避免403权限弹窗
      const [f, r] = await Promise.all([
        api.publicFeatureFlags() as any,
        api.getExpRules() as any,
      ])
      flags.value = f || {}
      expRules.value = r || {}
      loaded.value = true
    } catch (e) {
      // 未登录或加载失败时，默认全部开启；但不标记 loaded=true，以便后续重新加载
      console.warn('[settings] 加载失败，默认全部开启', e)
      flags.value = {}
      expRules.value = {}
    }
    // 站点配置独立加载，不依赖登录状态
    fetchSiteConfig()
  }

  async function fetchSiteConfig() {
    try {
      siteConfig.value = await api.getSiteConfig()
      // 应用当前主题那一套的自定义主色（分主题，互不干扰）
      applyPrimaryColor()
    } catch {
      // 配置加载失败，使用默认值
      siteConfig.value = null
    } finally {
      siteConfigLoaded.value = true
    }
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
    applyPrimaryColor()
  }

  async function saveFlags(next: Record<string, boolean>) {
    await api.saveFeatureFlags(next)
    flags.value = { ...next }
  }

  async function saveRules(next: Record<string, number>) {
    await api.saveExpRules(next)
    expRules.value = { ...next }
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
