<script setup lang="ts">
// 【v4.5.1】制卡（对标智学网）：试题卡 / 错题卡 / 知识点卡，可打印复习
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api'
import { useBasketStore } from '@/stores/basket'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage } from 'element-plus'

const props = defineProps<{ subjectId: number; questions: any[] }>()
const basket = useBasketStore()

const active = ref<'exam' | 'wrong' | 'kp'>('exam')
const wrong = ref<any[]>([])
const wrongLoading = ref(false)

async function loadWrong() {
  if (wrong.value.length || wrongLoading.value) return
  wrongLoading.value = true
  try { wrong.value = (await api.myWrongQuestions(props.subjectId)) as any } catch (e: any) { ElMessage.error(e?.message || '加载错题失败') } finally { wrongLoading.value = false }
}
onMounted(() => { if (active.value === 'wrong') loadWrong() })

const examCards = computed(() => (basket.items.length ? basket.items : props.questions))
const kpGroups = computed(() => {
  const map = new Map<number, { id: number; name: string; items: any[] }>()
  for (const q of props.questions) {
    for (const k of (q.knowledge_points || [])) {
      if (!map.has(k.id)) map.set(k.id, { id: k.id, name: k.name, items: [] })
      map.get(k.id)!.items.push(q)
    }
  }
  return Array.from(map.values())
})

function onTab(v: any) { active.value = v; if (v === 'wrong') loadWrong() }
function printCards() { window.print() }
const optLetter = (i: number) => 'ABCDEFGH'[i] || '?'
const QT: Record<string, string> = { single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' }
const qtName = (t: any) => QT[t] || t
</script>

<template>
  <div class="cards">
    <div class="cards-bar no-print">
      <el-radio-group :model-value="active" @update:model-value="onTab">
        <el-radio-button value="exam">试题卡（{{ examCards.length }}）</el-radio-button>
        <el-radio-button value="wrong">错题卡（{{ wrong.length }}）</el-radio-button>
        <el-radio-button value="kp">知识点卡（{{ kpGroups.length }}）</el-radio-button>
      </el-radio-group>
      <el-button size="small" @click="printCards" icon="Printer">打印当前卡片</el-button>
    </div>

    <div class="cards-print">
      <!-- 试题卡 -->
      <template v-if="active === 'exam'">
        <div v-if="!examCards.length" class="empty">暂无题目，先到题库选入试题篮或筛选题目。</div>
        <div v-for="(q, i) in examCards" :key="q.id" class="card">
          <div class="card-head"><b>{{ i + 1 }}.</b> <span class="ct">{{ qtName(q.qtype) }}</span> <span class="cs">{{ q.basketScore || q.score || 5 }}分</span></div>
          <div class="card-q" v-html="renderMarkdown(q.content)" />
          <div v-if="['single','multiple','judge'].includes(q.qtype)" class="card-opts">
            <div v-for="(o, oi) in (q.options||[])" :key="oi"><b>{{ optLetter(oi) }}.</b> <span v-html="renderMarkdown(o)" /></div>
          </div>
          <div class="card-ans"><b>答案：</b><span v-html="renderMarkdown(q.answer || '（未填写）')" /></div>
          <div v-if="q.analysis" class="card-ana"><b>解析：</b><span v-html="renderMarkdown(q.analysis)" /></div>
          <div v-if="q.knowledge_points?.length" class="card-kp"><el-tag v-for="k in q.knowledge_points" :key="k.id" size="small" type="warning" effect="plain">{{ k.name }}</el-tag></div>
        </div>
      </template>

      <!-- 错题卡 -->
      <template v-else-if="active === 'wrong'">
        <div v-if="wrongLoading" class="empty">加载中…</div>
        <div v-else-if="!wrong.length" class="empty">暂无错题，去题库自测后会自动归集。</div>
        <div v-for="(q, i) in wrong" :key="q.id" class="card wrong">
          <div class="card-head"><b>错题 {{ i + 1 }}.</b> <span class="ct">{{ qtName(q.qtype) }}</span> <span class="cs">{{ q.subject_name }}</span></div>
          <div class="card-q" v-html="renderMarkdown(q.content)" />
          <div v-if="['single','multiple','judge'].includes(q.qtype)" class="card-opts">
            <div v-for="(o, oi) in (q.options||[])" :key="oi"><b>{{ optLetter(oi) }}.</b> <span v-html="renderMarkdown(o)" /></div>
          </div>
          <div class="card-ans"><b>正确答案：</b><span v-html="renderMarkdown(q.answer || '（未填写）')" /></div>
          <div v-if="q.analysis" class="card-ana"><b>解析：</b><span v-html="renderMarkdown(q.analysis)" /></div>
        </div>
      </template>

      <!-- 知识点卡 -->
      <template v-else>
        <div v-if="!kpGroups.length" class="empty">暂无知识点关联的题目。</div>
        <div v-for="g in kpGroups" :key="g.id" class="card kp">
          <div class="card-head kp-head"><ZgGlyph emoji="📘" /> {{ g.name }}（{{ g.items.length }} 题）</div>
          <div v-for="(q, i) in g.items" :key="q.id" class="kp-item">
            <div class="card-q" v-html="renderMarkdown(q.content)" />
            <div class="card-ans"><b>答案：</b><span v-html="renderMarkdown(q.answer || '（未填写）')" /></div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cards { padding: 4px; }
.cards-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
.card { border: 1px solid rgba(0,0,0,0.12); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; page-break-inside: avoid; background: #fff; }
.card.wrong { border-left: 4px solid #E53935; }
.card.kp { border-left: 4px solid #BA7517; }
.card-head { font-weight: 700; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; }
.kp-head { font-size: 15px; }
.ct { font-size: 12px; color: #BA7517; background: rgba(245,158,11,0.12); padding: 0 8px; border-radius: 6px; }
.cs { font-size: 12px; color: #888; }
.card-q { line-height: 1.7; }
/* 【v4.5.3】选项字母与内容同行（与题库页同一修复） */
.card-opts { margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.card-opts > div { display: flex; align-items: baseline; gap: 6px; line-height: 1.7; }
.card-opts > div > b { flex: 0 0 auto; min-width: 18px; }
.card-opts > div > span { flex: 1 1 auto; min-width: 0; }
.card-opts > div > span :deep(p) { display: inline; margin: 0; }
.card-opts > div > span :deep(.katex-display) { display: inline-block; margin: 0; vertical-align: middle; }
.card-ans { margin-top: 6px; font-weight: 600; display: flex; align-items: baseline; gap: 4px; }
.card-ans > b { flex: 0 0 auto; }
.card-ans > span { flex: 1 1 auto; min-width: 0; font-weight: 400; }
.card-ans > span :deep(p) { display: inline; margin: 0; }
.card-ana { margin-top: 4px; color: #555; display: flex; align-items: baseline; gap: 4px; }
.card-ana > b { flex: 0 0 auto; }
.card-ana > span { flex: 1 1 auto; min-width: 0; }
.card-ana > span :deep(p) { display: inline; margin: 0; }
.card-kp { margin-top: 6px; display: flex; gap: 6px; flex-wrap: wrap; }
.kp-item { border-top: 1px dashed rgba(0,0,0,0.08); padding-top: 6px; margin-top: 6px; }
.empty { padding: 30px; text-align: center; color: #999; }
</style>

<style>
@media print {
  body * { visibility: hidden !important; }
  .cards-print, .cards-print * { visibility: visible !important; }
  .cards-print { position: absolute; left: 0; top: 0; width: 100%; }
  .no-print { display: none !important; }
}
</style>
