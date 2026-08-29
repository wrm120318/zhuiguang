import { ref, watch, onUnmounted, type WatchSource } from 'vue'

export interface AutoSaveOptions {
  /** localStorage 键，建议带用户/页面维度以避免串稿 */
  key: string
  /** 需要监听的响应式源（任意 ref / reactive），深度监听 */
  sources: WatchSource | WatchSource[]
  /** 生成草稿快照（返回可 JSON 序列化的对象） */
  snapshot: () => any
  /** 从草稿恢复：把字段写回对应响应式源（含富文本 DOM 等自定义逻辑） */
  restore: (draft: any) => void
  /** 防抖毫秒，默认 1500 */
  debounce?: number
}

/**
 * useAutoSave — 长表单草稿自动保存
 * - 监听 sources 变化，防抖写入 localStorage
 * - restoreDraft() 进入页面时调用，返回是否有草稿
 * - clear() 在发布/保存成功后调用，清除草稿
 * 仅做本地兜底，不影响任何后台保存/发布链路（铁律4）
 */
export function useAutoSave(opts: AutoSaveOptions) {
  const { key, sources, snapshot, restore, debounce = 1500 } = opts
  const lastSaved = ref<number | null>(null)
  const hasDraft = ref(false)
  let timer: any = null

  function persist() {
    try {
      localStorage.setItem(key, JSON.stringify(snapshot()))
      lastSaved.value = Date.now()
      hasDraft.value = true
    } catch {
      /* 忽略配额/隐私模式异常 */
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, debounce)
  }
  function restoreDraft(): boolean {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return false
      restore(JSON.parse(raw))
      hasDraft.value = true
      return true
    } catch {
      return false
    }
  }
  function clear() {
    localStorage.removeItem(key)
    hasDraft.value = false
    lastSaved.value = null
  }

  watch(sources as any, schedule, { deep: true })
  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })

  return { lastSaved, hasDraft, restoreDraft, clear, saveNow: persist }
}
