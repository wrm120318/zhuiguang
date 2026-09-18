<script setup lang="ts">
// 【v4.5.0】Word 试卷导入（客户端 mammoth 解析，尽力拆分）
// 说明：开源方案只能「尽力而为」——按题号规则切分，公式/图片尽力保留为文本/标记。
// 复杂或非标准排版可能切分不准，导入后题目标记为 imported_needs_review，教师在富文本里微调。
import { ref } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const props = defineProps<{ subjectId: number }>()
const emit = defineEmits<{ (e: 'imported'): void }>()

const file = ref<File | null>(null)
const preview = ref<any[]>([])
const importing = ref(false)
const optRe = /^\s*([A-Ha-h])[.、)）]/

function splitQuestions(text: string): string[] {
  // 以题号开头的行作为新题分割点
  const re = /(?=^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）]))/gm
  const parts = text.split(re).map(s => s.trim()).filter(Boolean)
  return parts.length ? parts : [text.trim()].filter(Boolean)
}

function parseBlock(block: string) {
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null
  // 去掉题号前缀
  let first = lines[0].replace(/^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）])\s*/, '')
  const opts: string[] = []
  const rest: string[] = []
  let answer = ''
  let hitOptions = false
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]
    if (optRe.test(ln)) { hitOptions = true; opts.push(ln.replace(optRe, '').trim()); continue }
    if (/答案|参考答案|解答|答[:：]/.test(ln)) { answer = ln.replace(/^.*?(答案|参考答案|解答|答)[:：]?\s*/, ''); continue }
    if (hitOptions) opts.push(ln) // 选项换行继续
    else rest.push(ln)
  }
  const content = [first, ...rest].join('\n').trim()
  const isChoice = opts.length >= 2
  const qtype = isChoice ? (/多选|选择(题)?.*多/.test(first + content) ? 'multiple' : 'single') : 'subjective'
  return { qtype, content, options: isChoice ? opts : [], answer: answer.trim(), analysis: '', status: 'imported_needs_review' }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  file.value = f
  const buf = await f.arrayBuffer()
  // @ts-ignore 动态导入浏览器构建，避免类型与打包问题
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
    <div class="upload">
      <input type="file" accept=".docx" @change="onFile" />
      <span v-if="file" class="fname">{{ file.name }}</span>
    </div>
    <div v-if="preview.length" class="prev-list">
      <div v-for="(p, i) in preview" :key="i" class="prev-item">
        <div class="pi-head"><b>#{{ i + 1 }}</b> <el-tag size="small">{{ p.qtype }}</el-tag></div>
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
.upload { margin: 12px 0; display: flex; gap: 10px; align-items: center; }
.fname { color: #888; }
.prev-list { max-height: 320px; overflow: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.prev-item { padding: 8px 10px; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; }
.pi-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.pi-content { line-height: 1.5; }
.pi-opts { color: #555; font-size: 13px; margin-top: 2px; }
.pi-ans { color: #b06a00; font-size: 13px; margin-top: 2px; }
</style>
