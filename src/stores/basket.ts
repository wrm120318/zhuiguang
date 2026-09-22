import { defineStore } from 'pinia'
import { ref } from 'vue'

// 试题篮（组卷）：跨页面保存待组卷的题目，localStorage 持久化
export interface BasketItem {
  id: number
  qtype: string
  content: string
  options: any[]
  answer: string
  analysis: string
  score: number
  basketScore: number // 组卷时自定义分值
  subjectId: number
  knowledge_points?: any[]
}

const KEY = 'zg_basket_v1'

// 【v4.7.0】各学科试题篮相互独立：结构从「全局数组」改为「按 subjectId 分区的 map」
//   { [subjectId]: BasketItem[] }
type BasketMap = Record<number, BasketItem[]>

function load(): BasketMap {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    // 旧版直接是数组 → 迁移到按学科分区的 map（每条本身带 subjectId）
    if (Array.isArray(raw)) {
      const map: BasketMap = {}
      for (const it of raw) {
        const sid = Number(it?.subjectId) || 0
        ;(map[sid] ||= []).push(it)
      }
      return map
    }
    if (raw && typeof raw === 'object') return raw as BasketMap
  } catch { /* ignore */ }
  return {}
}

export const useBasketStore = defineStore('basket', () => {
  const map = ref<BasketMap>(load())

  function persist() { localStorage.setItem(KEY, JSON.stringify(map.value)) }

  // 取某学科的题目数组（替代旧版全局 items）
  function items(subjectId: number): BasketItem[] { return map.value[subjectId] || [] }

  function has(id: number, subjectId: number) { return items(subjectId).some(i => i.id === id) }

  function add(q: any, subjectId: number) {
    if (has(q.id, subjectId)) return false
    const arr = items(subjectId).slice()
    arr.push({
      id: q.id, qtype: q.qtype, content: q.content, options: q.options || [],
      answer: q.answer || '', analysis: q.analysis || '', score: q.score || 5,
      basketScore: q.score || 5, subjectId, knowledge_points: q.knowledge_points || []
    })
    map.value = { ...map.value, [subjectId]: arr }
    persist()
    return true
  }

  function remove(id: number, subjectId: number) {
    map.value = { ...map.value, [subjectId]: items(subjectId).filter(i => i.id !== id) }
    persist()
  }

  function setScore(id: number, score: number, subjectId: number) {
    const arr = items(subjectId).map(i => i.id === id ? { ...i, basketScore: score } : i)
    map.value = { ...map.value, [subjectId]: arr }
    persist()
  }

  function reorder(from: number, to: number, subjectId: number) {
    const arr = items(subjectId).slice()
    if (from < 0 || to < 0 || from >= arr.length || to >= arr.length) return
    const [m] = arr.splice(from, 1)
    arr.splice(to, 0, m)
    map.value = { ...map.value, [subjectId]: arr }
    persist()
  }

  function clear(subjectId: number) {
    map.value = { ...map.value, [subjectId]: [] }
    persist()
  }

  function count(subjectId: number) { return items(subjectId).length }
  function totalScore(subjectId: number) { return items(subjectId).reduce((s, i) => s + (Number(i.basketScore) || 0), 0) }

  return { map, items, has, add, remove, setScore, reorder, clear, count, totalScore, persist }
})
