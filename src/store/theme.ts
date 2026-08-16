import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ThemeConfig } from '@/types'
import { api } from '@/api'

interface ThemeRow { id: number; name: string; config: any; is_active: number }

// 全局界面风格（液态玻璃 / 经典实色）—— v3.1 起以数据库 activeTheme.config.visualMode 为准，全站所有浏览器统一生效
export type VisualMode = 'liquid' | 'classic'

function applyVisualMode(mode?: string) {
  const classic = mode === 'classic'
  document.body.classList.toggle('zg-mode-classic', classic)
  // localStorage 仅作「主题未加载完成前」的兜底占位，最终以数据库 activeTheme 为准
  localStorage.setItem('zg-glass-mode', classic ? 'classic' : 'liquid')
}

function applyTheme(c: any) {
  if (!c) return
  const root = document.documentElement
  root.style.setProperty('--zg-primary', c.primary)
  root.style.setProperty('--zg-primary-2', c.primary2)
  root.style.setProperty('--zg-accent', c.accent)
  root.style.setProperty('--zg-bg-from', c.bgFrom)
  root.style.setProperty('--zg-bg-via', c.bgVia)
  root.style.setProperty('--zg-bg-to', c.bgTo)
  root.style.setProperty('--zg-blur', c.blur + 'px')
  root.style.setProperty('--zg-radius', c.radius + 'px')
  // v3.1：界面风格跟随主题，全站统一。主题未声明时默认液态玻璃（不依赖浏览器 localStorage）
  applyVisualMode(c.visualMode || 'liquid')
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

  // v3.1：超级管理员切换「界面风格」，立即全站生效（写入 activeTheme 并保存到数据库）
  async function setGlobalVisualMode(mode: VisualMode) {
    applyVisualMode(mode)
    const active = activeTheme.value
    if (!active) return
    const newConfig = { ...active.config, visualMode: mode }
    // 保存到数据库（isActive=true），所有浏览器/用户下次加载都读到
    await api.updateTheme(active.id, { config: newConfig, isActive: true })
    activeTheme.value = { ...active, config: newConfig }
    applyTheme(newConfig)
    if (draft.value) draft.value = { ...draft.value, visualMode: mode }
  }

  async function saveDraft(data: { id?: number; name: string; config: any; isActive: boolean }) {
    if (data.id) await api.updateTheme(data.id, { name: data.name, config: data.config, isActive: data.isActive })
    else await api.createTheme({ name: data.name, config: data.config, isActive: data.isActive })
    await load()
  }

  function reset() {
    if (activeTheme.value) { applyTheme(activeTheme.value.config); draft.value = { ...activeTheme.value.config, id: activeTheme.value.id, name: activeTheme.value.name } }
  }

  return { themes, activeTheme, draft, loaded, load, preview, apply, setGlobalVisualMode, saveDraft, reset, applyTheme }
})