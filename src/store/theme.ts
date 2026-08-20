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

  async function load() {
    const [list, active]: any = await Promise.all([api.themes(), api.activeTheme()])
    themes.value = list
    activeTheme.value = active
    if (active) { applyTheme(active.config); draft.value = { ...active.config, id: active.id, name: active.name } }
    loaded.value = true
  }

  function preview(c: any) { applyTheme(c) }

  async function apply(id: number) {
    await api.setActiveTheme(id)
    await load()
  }

  async function saveDraft(data: { id?: number; name: string; config: any; isActive: boolean }) {
    if (data.id) await api.updateTheme(data.id, { name: data.name, config: data.config, isActive: data.isActive })
    else await api.createTheme({ name: data.name, config: data.config, isActive: data.isActive })
    await load()
  }

  function reset() {
    if (activeTheme.value) { applyTheme(activeTheme.value.config); draft.value = { ...activeTheme.value.config, id: activeTheme.value.id, name: activeTheme.value.name } }
  }

  return { themes, activeTheme, draft, loaded, load, preview, apply, saveDraft, reset, applyTheme }
})