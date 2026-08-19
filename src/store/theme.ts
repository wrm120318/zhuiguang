import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ThemeConfig } from '@/types'
import { api } from '@/api'

interface ThemeRow { id: number; name: string; config: any; is_active: number }

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
  // BUG-01 修复：墨金模式下皮肤变量（主色/圆角/毛玻璃/背景）由 main.css 的 .zg-inkgold 作用域接管，
  // 此处不再写内联样式（内联会击穿墨金定义），并清除经典模式预览可能残留的内联值。
  // 经典模式保持原逻辑：后台色板自定义照常生效（铁律 4/5）。
  if (c.designMode === 'inkgold') {
    ;['--zg-primary', '--zg-primary-2', '--zg-accent', '--zg-bg-from', '--zg-bg-via', '--zg-bg-to', '--zg-blur', '--zg-radius',
      '--zg-primary-rgb', '--zg-primary-2-rgb', '--zg-accent-rgb'].forEach(p => root.style.removeProperty(p))
  } else {
    root.style.setProperty('--zg-primary', c.primary)
    root.style.setProperty('--zg-primary-2', c.primary2)
    root.style.setProperty('--zg-accent', c.accent)
    root.style.setProperty('--zg-bg-from', c.bgFrom)
    root.style.setProperty('--zg-bg-via', c.bgVia)
    root.style.setProperty('--zg-bg-to', c.bgTo)
    root.style.setProperty('--zg-blur', c.blur + 'px')
    root.style.setProperty('--zg-radius', c.radius + 'px')
    // RGB 通道跟随后台自定义色（失败则回落到 :root 默认，不清除旧值以外的情况不存在——写不进就保持 CSS 默认）
    const pr = hexToRgbChannels(c.primary); if (pr) root.style.setProperty('--zg-primary-rgb', pr)
    const p2 = hexToRgbChannels(c.primary2); if (p2) root.style.setProperty('--zg-primary-2-rgb', p2)
    const ac = hexToRgbChannels(c.accent); if (ac) root.style.setProperty('--zg-accent-rgb', ac)
  }
  // 设计模式（皮肤开关）：墨金加 zg-inkgold 类，经典移除 → 基础样式完全不变
  root.classList.toggle('zg-inkgold', c.designMode === 'inkgold')
  // 墨金学术深浅档：designMode==='inkgold' 且 inkgoldTone==='dark' 时叠加 zg-inkgold-dark
  root.classList.toggle('zg-inkgold-dark', c.designMode === 'inkgold' && (c.inkgoldTone || 'light') === 'dark')
  // 墨金·背景亮度档（后台界面风格可切换；soft 温和 / bright 明显）
  root.classList.toggle('zg-inkgold-bright', c.designMode === 'inkgold' && (c.bright || 'soft') === 'bright')
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