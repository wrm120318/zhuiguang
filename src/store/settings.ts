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

export const useSettingsStore = defineStore('settings', () => {
  const flags = ref<Record<string, boolean>>({})
  const expRules = ref<Record<string, number>>({})
  const siteConfig = ref<any>(null)
  const siteConfigLoaded = ref(false)
  const loaded = ref(false)

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
      // 未登录或加载失败时，默认全部开启
      console.warn('[settings] 加载失败，默认全部开启', e)
      flags.value = {}
      expRules.value = {}
      loaded.value = true
    }
    // 站点配置独立加载，不依赖登录状态
    fetchSiteConfig()
  }

  async function fetchSiteConfig() {
    try {
      siteConfig.value = await api.getSiteConfig()
      // 应用自定义主色调
      if (siteConfig.value?.primaryColor) {
        document.documentElement.style.setProperty('--zg-primary', siteConfig.value.primaryColor)
      }
    } catch {
      // 配置加载失败，使用默认值
      siteConfig.value = null
    } finally {
      siteConfigLoaded.value = true
    }
  }

  async function saveSiteConfig(config: any) {
    await api.saveSiteConfig(config)
    siteConfig.value = { ...siteConfig.value, ...config }
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
    fetchAll, fetchSiteConfig, saveSiteConfig, saveFlags, saveRules, isEnabled,
  }
})
