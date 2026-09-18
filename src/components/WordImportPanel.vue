<script setup lang="ts">
// 【v4.5.1】Word 试卷导入（客户端 mammoth 解析，尽力拆分 + 增强题型识别）
// 说明：开源方案只能「尽力而为」——按题号规则切分，公式/图片尽力保留为文本/标记。
// 导入后题目标记为「待校对」，教师在富文本里微调。
import { ref, reactive } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const props = defineProps<{ subjectId: number }>()
const emit = defineEmits<{ (e: 'imported'): void }>()

const file = ref<File | null>(null)
const preview = ref<any[]>([])
const importing = ref(false)
const defaults = reactive({ score: 5, difficulty: 3 })

const optRe = /^\s*([A-Ha-h])[.、)）]/

function splitQuestions(text: string): string[] {
  const re = /(?=^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）]))/gm
  const parts = text.split(re).map(s => s.trim()).filter(Boolean)
  return parts.length ? parts : [text.trim()].filter(Boolean)
}

const JUDGE_WORDS = ['对', '错', '正确', '错误', '√', '×', 'T', 'F', 'true', 'false']
function isJudge(opts: string[]): boolean {
  return opts.length >= 2 && opts.every(o => JUDGE_WORDS.some(w => o.includes(w)))
}

function parseBlock(block: string) {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null
  let first = lines[0].replace(/^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）])\s*/, '')
  const opts: string[] = []
  const rest: string[] = []
  let answer = ''
  let hitOptions = false
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]
    if (optRe.test(ln)) { hitOptions = true; opts.push(ln.replace(optRe, '').trim()); continue }
    if (/答案|参考答案|解答|答[:：]/.test(ln)) { answer = ln.replace(/^.*?(答案|参考答案|解答|答)[:：]?\s*/, ''); continue }
    if (hitOptions) opts.push(ln)
    else rest.push(ln)
  }
  const content = [first, ...rest].join('\n').trim()

  let qtype = 'subjective'
  if (isJudge(opts)) qtype = 'judge'
  else if (opts.length >= 2) {
    const ansLetters = answer.replace(/[^A-Ha-h]/g, '')
    if (/(多选|多项选择题)/.test(first + content) || ansLetters.length >= 2 || /[，,、]/.test(answer)) qtype = 'multiple'
    else qtype = 'single'
  }
  return {
    qtype, content,
    options: (qtype === 'single' || qtype === 'multiple' || qtype === 'judge') ? opts : [],
    answer: answer.trim(),
    analysis: '',
    difficulty: defaults.difficulty,
    score: defaults.score,
    status: 'imported_needs_review',
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  file.value = f
  const buf = await f.arrayBuffer()
  const mammoth = (await import('mammoth/mammoth.browser')).default
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf })
  const blocks = splitQuestions(value)
  preview.value = blocks.map(parseBlock).filter(Boolean) as any[]
  ElMessage.info(`已识别 ${preview.value.length} 道题，请核对后导入`)
}

async function onConfirm() {
  if (!preview.value.length) return
  importing.value = true
  try {
    await Promise.all(preview.value.map(p => api.addSubjectQuestion(props.subjectId, p)))
    ElMessage.success(`成功导入 ${preview.value.length} 道题（待人工校对）`)
    emit('imported')
  } catch (e: any) {
    ElMessage.error('导入失败：' + (e?.response?.data?.message || e?.message || e))
  } finally { importing.value = false }
}
</script>

<template>
  <div class="word-import">
    <el-alert type="warning" :closable="false" title="尽力拆分，需人工校对">
      系统按题号规则自动切分 Word 试卷，公式/图片尽力保留为文本标记。导入后题目标记为「待校对」，请在各题富文本编辑器里微调。
    </el-alert>
    <div class="defaults">
      <span>默认分值</span>
      <el-input-number v-model="defaults.score" :min="1" :max="100" size="small" />
      <span>默认难度</span>
      <el-rate v-model="defaults.difficulty" :max="5" />
    </div>
    <div class="upload">
      <input type="file" accept=".docx" @change="onFile" />
      <span v-if="file" class="fname">{{ file.name }}</span>
    </div>
    <div v-if="preview.length" class="prev-list">
      <div v-for="(p, i) in preview" :key="i" class="prev-item">
        <div class="pi-head"><b>#{{ i + 1 }}</b> <el-tag size="small">{{ p.qtype === 'judge' ? '判断' : p.qtype === 'multiple' ? '多选' : p.qtype === 'single' ? '单选' : '主观' }}</el-tag> <span class="pi-meta">{{ p.score }}分/难度{{ p.difficulty }}</span></div>
        <div class="pi-content">{{ p.content.slice(0, 120) }}{{ p.content.length > 120 ? '…' : '' }}</div>
        <div v-if="p.options.length" class="pi-opts">{{ p.options.join(' / ') }}</div>
        <div v-if="p.answer" class="pi-ans">答案：{{ p.answer }}</div>
      </div>
    </div>
    <el-button v-if="preview.length" type="primary" :loading="importing" @click="onConfirm" icon="Check">确认导入 {{ preview.length }} 题</el-button>
  </div>
</template>

<style scoped>
.word-import { padding: 4px; }
.defaults { display: flex; gap: 10px; align-items: center; margin: 12px 0; flex-wrap: wrap; font-size: 13px; color: #666; }
.upload { margin: 12px 0; display: flex; gap: 10px; align-items: center; }
.fname { color: #888; }
.prev-list { max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.prev-item { padding: 8px 10px; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; }
.pi-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.pi-meta { font-size: 12px; color: #b06a00; }
.pi-content { line-height: 1.5; }
.pi-opts { color: #555; font-size: 13px; margin-top: 2px; }
.pi-ans { color: #b06a00; font-size: 13px; margin-top: 2px; }
</style>
