import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ThemeConfig } from '@/types'
import { api } from '@/api'

interface ThemeRow { id: number; name: string; config: any; is_active: number }

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
