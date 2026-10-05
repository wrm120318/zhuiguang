<script setup lang="ts">
// 【v4.5.1】Word 试卷导入（客户端 mammoth 解析，尽力拆分 + 增强题型识别）
// 说明：开源方案只能「尽力而为」——按题号规则切分，公式/图片尽力保留为文本/标记。
// 导入后题目标记为「待校对」，教师在富文本里微调。
import { ref, reactive, computed } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
// 【v4.13.1】与后端共用同一份合并逻辑（铁律#11）：
//   题干以原卷 HTML 为准，表格/图片不被 AI 的纯文本覆盖；[图N] 占位符换回 <img>。
import { mergeContent, restoreImages } from '@shared/ai-paper'
// 【v4.13.2】题号剥离（与「原卷编辑」入口共用同一实现，保证两条路径结果一致）
import { stripQuestionNumber } from '@/utils/question-number'
// 【v4.14.0】题干 HTML → Markdown 统一收敛（与「原卷编辑」入口共用一份实现，铁律#11）：
//   右侧编辑器编辑区只认 Markdown，直接存 HTML 会导致「编辑框显示源码、图片不显示」。
import { toMarkdownContent } from '@/utils/paper-content'

const props = defineProps<{ subjectId: number }>()
const emit = defineEmits<{ (e: 'imported'): void }>()

const file = ref<File | null>(null)
const preview = ref<any[]>([])
const importing = ref(false)
const defaults = reactive({ score: 5, difficulty: 3 })

// 【v4.13.6 修正 · 选项判据覆盖全形态】与 WordPaperSplitEditor 同一套（A. A． A、 A) A） (A) （A） A: A：），
// 旧版只认 A. A、 A) A），漏掉中文 Word 常见全角点 `A．`，导致选择题选项填不进。
const optRe = /^\s*[（(]?\s*([A-Ha-h])\s*[.．、)）:：]/i

// HTML → 纯文本（保留块级换行，便于按行识别题型/选项/答案）
function htmlToText(html: string): string {
  return html
    // 【v4.13.6 补强】`<td>`/`<th>` 末尾也补换行，避免同行多列被拍平连成「A. 甲B. 乙」
    .replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

// ===== 两级题号识别（v4.8.16 重写）=====
//
// 【原实现的 bug】下级 `marker` 正则把「一、二、三」与「1. 2. 3.」塞进同一个模式，
// 于是两者被同等对待：既把「一、选择题（每题3分）」当成一道题的起点，
// 又把其下的「1. …」「2. …」各自当成新题起点。
// 结果一份卷子被切得七零八落 —— 大题标题单独成"题"，小题各成"题"，
// 用户反馈「只有看到 1.2.3 阿拉伯数字才截断题目，一二三 是大题截断」正是此意。
//
// 【正确模型】两级：
//   · 一级（大题）：一、二、三 … / 第一部分 / 第Ⅰ卷 / （一）
//   · 二级（小题）：1. / 1、 / (1) / （1）
// 切分策略：先按一级切「大题段」，再在每个大题段内按二级切「小题」；
// 若整份文档不含一级题号，则退化为仅按二级切（兼容纯小题的练习卷）。
const MAJOR_RE = /^\s*(?:[一二三四五六七八九十百]+[、.]|第\s*[一二三四五六七八九十\d]+\s*[部分卷]|[（(][一二三四五六七八九十]+[)）]|【[一二三四五六七八九十]+】)/
const MINOR_RE = /^\s*(?:\d+\s*[.、)）]|[（(]\s*\d+\s*[)）])/

/** 取节点的题号文本（取首行，避免题面正文里的序号误判） */
function markerLine(el: Element): string {
  const t = (el.textContent || '').replace(/\u00a0/g, ' ').trim()
  return t.split('\n')[0] || ''
}

/**
 * 将 Word 转换出的 HTML 切分为题目块。
 * 两级切分：一级大题内的多个小题会被正确拆开；大题标题与紧随其后的首题合并，
 * 避免"光秃秃一行『一、选择题』"成为一道空题。
 * 卷首的标题/说明（题号之前的内容）作为「前言」并入第一道题，不单独成块。
 */
function splitHtmlToQuestions(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const blocks = Array.from(doc.body.childNodes).filter(n => n.nodeType === 1) as Element[]
  if (!blocks.length) return []

  // ---- 第零遍：剥离卷首前言（首个题号标记之前的标题/说明）----
  // 原实现把卷首 <h1>/<h2> 也当成一个块推入 out，导致「标题」单独成一道"题"，
  // 而且兜底分支还会把内部子节点再拆一遍 → 标题被重复计入（实测切出 9 块含 2 块标题）。
  let preamble: Element[] = []
  let firstMarkerIdx = blocks.findIndex(el => {
    const line = markerLine(el)
    return MAJOR_RE.test(line) || MINOR_RE.test(line)
  })
  if (firstMarkerIdx > 0) {
    preamble = blocks.slice(0, firstMarkerIdx)
    blocks.splice(0, firstMarkerIdx)
  }
  if (!blocks.length) {
    // 整篇都没有题号 → 按前言整体返回 1 块（避免"导入 0 题"）
    return preamble.length ? [preamble.map(e => (e as HTMLElement).outerHTML).join('')] : []
  }

  // ---- 第一遍：按一级（大题）分段 ----
  const majorSegs: { titleEl: Element | null; body: Element[] }[] = []
  let curSeg: { titleEl: Element | null; body: Element[] } = { titleEl: null, body: [] }
  for (const el of blocks) {
    const line = markerLine(el)
    if (MAJOR_RE.test(line)) {
      if (curSeg.titleEl || curSeg.body.length) majorSegs.push(curSeg)
      curSeg = { titleEl: el, body: [] }
    } else {
      curSeg.body.push(el)
    }
  }
  if (curSeg.titleEl || curSeg.body.length) majorSegs.push(curSeg)

  // ---- 第二遍：每段内按二级（小题）切分 ----
  const out: string[] = []
  const pushChunk = (els: Element[]) => {
    const h = els.map(e => (e as HTMLElement).outerHTML).join('')
    if (htmlToText(h).trim()) out.push(h)
  }

  majorSegs.forEach((seg, segIdx) => {
    // 大题标题并入该段的第一道小题（题干里保留「一、选择题（本大题共10小题）」这类必要信息）；
    // 卷首前言只并入**全卷第一道**题，后续大题不再重复。
    let pending: Element[] = segIdx === 0 ? [...preamble] : []
    if (seg.titleEl) pending.push(seg.titleEl)
    let cur: Element[] = []
    let startedMinor = false

    const flushMinor = () => {
      if (cur.length) pushChunk([...pending, ...cur])
      pending = []
      cur = []
    }

    for (const el of seg.body) {
      const line = markerLine(el)
      if (MINOR_RE.test(line)) {
        if (startedMinor && cur.length) flushMinor()
        cur.push(el)
        startedMinor = true
      } else {
        cur.push(el)
      }
    }
    const beforeLen = out.length
    if (cur.length) flushMinor()

    // 该大题下没有任何二级题号、且本段尚未产出任何块 → 整段作为一道题（如材料分析题）。
    // 用「本段产出前后的长度差」判断，避免把已输出的内容再推一遍
    //（实测 bug：材料题被拆成 1 份正确 + 1 份重复）。
    if (!startedMinor && out.length === beforeLen) {
      pushChunk([...pending, ...seg.body])
      pending = []
    }
  })

  // 兜底：仅当「整份文档被包在一个外层容器里」才降级（Word 偶发把全部内容塞进一个 <div>）。
  // 原条件是 `out.length <= 1`，过宽 —— 材料题（合法地只有 1 题）也会被误拆成多块。
  // 现在加两道更严格的闸门：
  //   ① 必须完全没有二级题号（hasMinor === false），否则二级切分已经生效，无需兜底；
  //   ② 顶层块必须极少先（<= 2），且**存在嵌套结构**（有元素包含 >1 个子元素），
  //      这才符合"被一层容器包裹"的特征。顶层就是一堆平铺 <p> 的情况不属于此列。
  const hasMinor = blocks.some(el => MINOR_RE.test(markerLine(el)))
  const hasNesting = blocks.some(el => el.children.length > 1)
  if (!hasMinor && out.length <= 1 && blocks.length <= 2 && hasNesting) {
    const flat: Element[] = []
    blocks.forEach(el => {
      const kids = Array.from(el.children)
      if (kids.length > 1) kids.forEach(k => flat.push(k))
      else flat.push(el)
    })
    const alt: string[] = []
    let acc: Element[] = []
    for (const el of flat) {
      if (MINOR_RE.test(markerLine(el))) {
        if (acc.length) { const h = acc.map(e => (e as HTMLElement).outerHTML).join(''); if (htmlToText(h).trim()) alt.push(h) }
        acc = [el]
      } else acc.push(el)
    }
    if (acc.length) { const h = acc.map(e => (e as HTMLElement).outerHTML).join(''); if (htmlToText(h).trim()) alt.push(h) }
    if (alt.length > out.length) return alt
  }
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
  // 剥离题首的题号前缀（两级题号都要认：小题 1. / (1)，大题 一、/ 第Ⅰ部分）
  let first = lines[0].replace(/^\s*(?:\d+\s*[.、)）]|[（(]\s*\d+\s*[)）]|[一二三四五六七八九十百]+[、.])/, '').trim()
  // 若剥完变空（整行就是"一、选择题"这种大题标题），保留原文本，避免空题干
  if (!first) first = lines[0].trim()
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
    qtype,
    // 【v4.13.2】剥掉题干开头的题号（「1.」「一、」），与「原卷编辑」入口行为一致
    //   （用户需求：「切完题后自动把序号去除，小题的不要去」）。
    //   小问号 `(1)` `①` 保留 —— 判据见 @/utils/question-number。
    // 【v4.14.0】再统一收敛为 Markdown（图片转 `![](url)`，编辑框才显示得出图）。
    content: toMarkdownContent(stripQuestionNumber(raw)),
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

// ===== 【v4.13.0】AI 智能识别 =====
//
// 用户反馈「自动切割题目读取答案和解析实在是太难用了」。
// 正则版的两个硬伤在这里体现得最明显：
//   ① `analysis: ''` **恒为空** —— 解析根本没被提取过
//   ② 答案只认"行内紧邻"，卷末独立「参考答案」区块完全关联不上
// 所以新增 AI 通道：识别时优先走大模型，失败/不可用则回落下面的正则。
//
// 【v4.13.0】主通道改为 Cloudflare Workers AI：零配置、无需密钥。
const aiStatus = ref<{ available: boolean; provider: string; effective?: string } | null>(null)
const aiRunning = ref(false)
const aiInfo = ref('')

/** 通道中文名（避免用户看到裸的 "cf" / "zhipu"） */
const AI_CHANNEL_NAME: Record<string, string> = { cf: 'Cloudflare Workers AI', zhipu: '智谱 GLM' }

/** AI 不可用时的说明文案 */
const aiDisabledReason = computed(() =>
  'AI 服务不可用，将使用规则识别（可在「管理后台 → AI 设置」检查配置）'
)

async function loadAiStatus() {
  try { aiStatus.value = await api.aiStatus() as any } catch { aiStatus.value = null }
}
loadAiStatus()

async function aiRecognize() {
  if (aiRunning.value) return
  if (aiStatus.value && !aiStatus.value.available) {
    ElMessage.warning(aiDisabledReason.value)
    return
  }
  aiRunning.value = true
  try {
    // 【v4.13.1】同时送 text 与 html：
    //   后端优先用 html 做「表格 Markdown 化 + 图片占位符化」的结构保真转换，
    //   避免表格被拍平、图片因 text 为空而整块消失。
    const html = preview.value.map(p => p.content).filter(Boolean).join('')
    const text = preview.value.map(p => htmlToText(p.content)).filter(Boolean).join('\n')
    if (!text.trim()) { ElMessage.warning('请先上传 Word 文件'); return }
    const r: any = await api.aiParsePaper({ text, html, subjectId: props.subjectId })
    if (!r?.ok || !r.questions?.length) {
      // 【v4.15.0】额度耗尽要单独说清楚：重试无意义，需去后台换模型/等重置
      if (r?.quotaExhausted) {
        ElMessage.error({ message: '今日 AI 额度已耗尽（账号级共享，每日北京时间 8 点重置）。可在「管理后台 → AI 设置」切换到更省额度的模型。', duration: 7000 })
      } else {
        ElMessage.warning(`AI 识别未生效${r?.available === false ? '（AI 服务不可用）' : ''}，已保留规则识别结果`)
      }
      return
    }
    // 【v4.13.1】题干以**原卷 HTML 为准**（含 table/img），AI 只补元数据；
    //   并把 AI 文本里的 [图N] 占位符换回真正的 <img>，保证图片不丢。
    preview.value = r.questions.map((q: any) => {
      const idx = preview.value.findIndex((p: any) =>
        q.anchor && htmlToText(p.content).includes(String(q.anchor).slice(0, 10)))
      const orig = idx >= 0 ? String(preview.value[idx].content || '') : ''
      return {
        qtype: q.qtype || 'subjective',
        // 【v4.14.0】mergeContent 返回原卷 HTML / restoreImages 返回 HTML，
        //   统一收敛为 Markdown 再交给编辑器（否则编辑框显示源码、看不到图）。
        content: toMarkdownContent(
          orig ? mergeContent(orig, q.content || '', r.images || {}) : restoreImages(q.content || '', r.images || {})
        ),
        options: q.options || [],
        answer: q.answer || '',
        analysis: q.analysis || '',
        difficulty: defaults.difficulty,
        score: q.score ?? defaults.score,
        status: 'imported_needs_review',
      }
    })
    const providerName = AI_CHANNEL_NAME[r.provider] || r.provider
    aiInfo.value = `${providerName} · ${preview.value.length} 题 · ${(r.elapsed / 1000).toFixed(1)}s`
    ElMessage.success(`AI 识别完成：${preview.value.length} 道题（含答案与解析）`)
  } catch (e: any) {
    ElMessage.error('AI 识别失败：' + (e?.message || e) + '（已保留规则识别结果）')
  } finally {
    aiRunning.value = false
  }
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
      <el-tooltip
        :content="aiStatus && !aiStatus.available
          ? aiDisabledReason
          : '用大模型重新识别：自动读取卷末参考答案与解析'"
        placement="top"
      >
        <el-button
          size="small" type="primary" :loading="aiRunning"
          :disabled="!preview.length"
          @click="aiRecognize"
        ><ZgGlyph emoji="🪄" /> AI 智能识别</el-button>
      </el-tooltip>
    </div>
    <div v-if="aiInfo" class="ai-info">AI 识别：{{ aiInfo }}</div>
    <div v-if="preview.length" class="prev-list">
      <div v-for="(p, i) in preview" :key="i" class="prev-item">
        <div class="pi-head"><b>#{{ i + 1 }}</b> <el-tag size="small">{{ p.qtype === 'judge' ? '判断' : p.qtype === 'multiple' ? '多选' : p.qtype === 'single' ? '单选' : '主观' }}</el-tag> <span class="pi-meta">{{ p.score }}分/难度{{ p.difficulty }}</span></div>
        <div class="pi-content">{{ plainPreview(p.content) }}</div>
        <div v-if="p.options.length" class="pi-opts">{{ p.options.join(' / ') }}</div>
        <div v-if="p.answer" class="pi-ans">答案：{{ p.answer }}</div>
        <div v-if="p.analysis" class="pi-ana">解析：{{ p.analysis }}</div>
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
.pi-ana { color: #4b5563; font-size: 12.5px; margin-top: 2px; line-height: 1.5; }
.ai-info { font-size: 12px; color: var(--zg-primary, #f59e0b); margin: -6px 0 10px; }
</style>
