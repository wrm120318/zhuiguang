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

function load(): BasketItem[] {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}

export const useBasketStore = defineStore('basket', () => {
  const items = ref<BasketItem[]>(load())

  function persist() { localStorage.setItem(KEY, JSON.stringify(items.value)) }

  function has(id: number) { return items.value.some(i => i.id === id) }

  function add(q: any, subjectId: number) {
    if (has(q.id)) return false
    items.value.push({
      id: q.id, qtype: q.qtype, content: q.content, options: q.options || [],
      answer: q.answer || '', analysis: q.analysis || '', score: q.score || 5,
      basketScore: q.score || 5, subjectId, knowledge_points: q.knowledge_points || []
    })
    persist()
    return true
  }

  function remove(id: number) {
    items.value = items.value.filter(i => i.id !== id)
    persist()
  }

  function setScore(id: number, score: number) {
    const it = items.value.find(i => i.id === id)
    if (it) { it.basketScore = score; persist() }
  }

  function reorder(from: number, to: number) {
    const arr = items.value
    if (from < 0 || to < 0 || from >= arr.length || to >= arr.length) return
    const [m] = arr.splice(from, 1)
    arr.splice(to, 0, m)
    persist()
  }

  function clear() { items.value = []; persist() }

  const totalScore = () => items.value.reduce((s, i) => s + (Number(i.basketScore) || 0), 0)
  const count = () => items.value.length

  return { items, has, add, remove, setScore, reorder, clear, totalScore, count, persist }
})
