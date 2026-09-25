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

// HTML → 纯文本（保留块级换行，便于按行识别题型/选项/答案）
function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// 将 Word 转换出的 HTML 按"题号"切分为若干题目块（每块含题干/选项/图片/表格，区块不破断）
function splitHtmlToQuestions(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks = Array.from(doc.body.childNodes).filter(n => n.nodeType === 1) as Element[]
  const marker = /^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）])/
  const out: string[] = []
  let cur: string[] = []
  let started = false
  const flush = () => { if (cur.length) { out.push(cur.join('')); cur = [] } }
  for (const el of blocks) {
    const isMarker = marker.test(el.textContent?.trim() || '')
    if (isMarker) {
      // 首个题号之前的内容（如卷首标题）并入第一题，不单独成题
      if (started && cur.length) flush()
      cur.push((el as HTMLElement).outerHTML)
      started = true
    } else {
      cur.push((el as HTMLElement).outerHTML)
    }
  }
  flush()
  return out
}

const JUDGE_WORDS = ['对', '错', '正确', '错误', '√', '×', 'T', 'F', 'true', 'false']
function isJudge(opts: string[]): boolean {
  return opts.length >= 2 && opts.every(o => JUDGE_WORDS.some(w => o.includes(w)))
}

// raw 可为 Word 导出的 HTML（含图片/表格）或纯文本；结构识别用 htmlToText，题面内容保留原 HTML
function parseBlock(raw: string) {
  const text = htmlToText(raw)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
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
    // 选项仅取匹配 optRe 的行；选项之后的表格/图片说明等归入 context，不污染选项
    rest.push(ln)
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
    qtype, content: raw,
    options: (qtype === 'single' || qtype === 'multiple' || qtype === 'judge') ? opts : [],
    answer: answer.trim(),
    analysis: '',
    difficulty: defaults.difficulty,
    score: defaults.score,
    status: 'imported_needs_review',
  }
}

// 图片处理策略：≤0.9MB 直接内联 base64（零成本、无需外部存储）；>0.9MB 上传到文件存储并引用 URL，不再丢弃
const IMG_INLINE_BYTE_CAP = 0.9 * 1024 * 1024
const IMG_PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='240' height='36'><text x='6' y='24' font-size='14' fill='%23999'>图片上传失败</text></svg>")}`

// 把 mammoth 读出的 base64 转成浏览器 File，供 uploadImage 走文件存储
function b64ToImageFile(b64: string, contentType: string): File {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  const ext = (contentType.split('/')[1] || 'png').replace('+xml', '')
  return new File([bytes], `word-img-${Date.now()}.${ext}`, { type: contentType })
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  file.value = f
  const buf = await f.arrayBuffer()
  try {
    const mammothMod: any = (await import('mammoth/mammoth.browser')).default
    // 图片内联为 base64（题面直接渲染）；超大图走文件存储（uploadImage 返回可访问 URL），避免撑爆题面 base64
    const convertImage = mammothMod.images.imgElement(async (image: any) => {
      const b64 = await image.read('base64')
      const byteLen = Math.floor(b64.length * 3 / 4)
      if (byteLen > IMG_INLINE_BYTE_CAP) {
        try {
          const r: any = await api.uploadImage(b64ToImageFile(b64, image.contentType))
          return { src: r.url }
        } catch {
          return { src: IMG_PLACEHOLDER }
        }
      }
      return { src: `data:${image.contentType};base64,${b64}` }
    })
    const { value: html } = await mammothMod.convertToHtml({ arrayBuffer: buf, convertImage })
    const blocks = splitHtmlToQuestions(html)
    preview.value = blocks.map(parseBlock).filter(Boolean) as any[]
    ElMessage.info(`已识别 ${preview.value.length} 道题（图片/表格已一并解析，请核对后导入）`)
  } catch {
    // 兜底：纯文本导入（图片/表格可能丢失）
    const mammothMod: any = (await import('mammoth/mammoth.browser')).default
    const { value } = await mammothMod.extractRawText({ arrayBuffer: buf })
    const blocks = value.split(/(?=^\s*(?:\d+[.、)）]|[一二三四五六七八九十百零]+[.、]|\(\d+\)|[（(]\d+[)）]))/gm).map((s: string) => s.trim()).filter(Boolean)
    preview.value = blocks.map(parseBlock).filter(Boolean) as any[]
    ElMessage.warning('Word 解析降级为纯文本（图片/表格可能丢失），请核对后导入')
  }
}

// 预览卡片显示纯文本（题面可能是 HTML）
function plainPreview(html: string): string {
  const t = htmlToText(html).replace(/\s+/g, ' ').trim()
  return t.length > 120 ? t.slice(0, 120) + '…' : t
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
      系统按题号规则自动切分 Word 试卷，<b>图片与表格会一并解析</b>（图片内联为可显示图片，表格转为可渲染表格），公式尽力保留。导入后题目标记为「待校对」，请在各题富文本编辑器里微调。
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
        <div class="pi-content">{{ plainPreview(p.content) }}</div>
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
