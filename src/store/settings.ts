import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api'

// 功能开关：与后端 feature_flags 表对应；缺失视为开启
export type FlagKey =
  | 'quiz' | 'blog' | 'guide' | 'announcement' | 'message'
  | 'leaderboard' | 'favorites' | 'search' | 'subjects'

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
}

export const useSettingsStore = defineStore('settings', () => {
  const flags = ref<Record<string, boolean>>({})
  const expRules = ref<Record<string, number>>({})
  const loaded = ref(false)

  async function fetchAll() {
    try {
      const [f, r] = await Promise.all([
        api.getFeatureFlags() as any,
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
    flags, expRules, loaded, flagLabels,
    fetchAll, saveFlags, saveRules, isEnabled,
  }
})
