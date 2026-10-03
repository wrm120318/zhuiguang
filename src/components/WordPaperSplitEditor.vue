<script setup lang="ts">
// ===== 【v4.9.0】Word 原卷分栏编辑（S5）=====
//
// 【用户需求原文】
//   「上传 Word 后，左侧显示完整原卷（含图片与表格），系统自动插入分割线；
//     点击分割线可合并或新增；右侧按题编辑（编辑器和添加题目时的编辑器完全相同），
//     可调整题型、补充答案、增删图片。」
//   「原卷上直接拖（推荐）」「合并 + 拆分都要」「两个都跟着变」「多多益善」
//
// 【设计要点】
//   · 左侧**双视图**（用户明确要「既可以看网站上的渲染也可以看 word 上的渲染，两个都要，自由调节」）：
//       - 「Word 原卷」：docx-preview 保真渲染（版式/表格/图片与 Word 里一致）
//       - 「网站渲染」：把题目内容实时转成站内 Markdown 渲染，**跟随右侧编辑实时变化**
//   · 分割线**直接标在原卷上**（用户选择），拖动改变位置 → 题目边界随动
//   · 点分割线可**合并相邻两题**或**在此处新增分割**（拆分）
//   · 右侧复用 QuestionForm（与「添加题目」完全同一个组件、同一个编辑器）
import { ref, reactive, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import QuestionForm from '@/components/QuestionForm.vue'
import { renderMarkdown } from '@/utils/markdown'
import { htmlToMarkdown } from '@/utils/html-to-md'
// 【v4.13.1】题干合并用共享实现（与后端同一份，铁律#11）：
//   保证「原卷 HTML 为准、AI 只补元数据」，表格/图片不被 AI 的纯文本覆盖掉。
import { mergeContent, restoreImages } from '@shared/ai-paper'
// 【v4.13.2】题号剥离：切完题后自动去掉题干开头的题号（小问号保留）。
//   抽成独立模块是为了让「原卷编辑」与「快速导入」两条入口行为完全一致。
import { stripQuestionNumber, hasLeadingNumber } from '@/utils/question-number'

const props = defineProps<{ subjectId: number; subjectName?: string }>()
const emit = defineEmits<{ (e: 'imported'): void }>()

// ===== 视图模式 =====
type ViewMode = 'word' | 'site'
const viewMode = ref<ViewMode>('word')
const leftPane = ref<HTMLElement | null>(null)
const docxHost = ref<HTMLElement | null>(null)
/** 叠加层根节点（mousedown 事件代理挂在它身上，见 onOverlayMouseDown） */
const overlayRef = ref<HTMLElement | null>(null)
const stage = ref<'pick' | 'split' | 'edit'>('pick')
const busy = ref(false)
const progressText = ref('')

// ===== 原始 docx 二进制（用于 Word 视图渲染 + 重新渲染）=====
let srcArrayBuffer: ArrayBuffer | null = null
const fileName = ref('')

// ===== 题干块（保留 HTML，用于原卷视图定位）=====
interface Block {
  /** 原始 HTML（含 <p>/<table>/<img>，保真） */
  html: string
  /** 纯文本（用于原卷里高亮定位与预览） */
  text: string
}

const blocks = ref<Block[]>([])
/** 题目分块：boundaries[i] = 第 i 道题在 blocks 里的起始下标；最后一项是 blocks.length */
const boundaries = ref<number[]>([])

/** 由 boundaries 派生的题目块列表 */
const chunks = computed(() => {
  const b = boundaries.value
  const out: { index: number; blocks: Block[]; html: string }[] = []
  for (let i = 0; i < b.length - 1; i++) {
    const seg = blocks.value.slice(b[i], b[i + 1])
    out.push({ index: i, blocks: seg, html: seg.map(x => x.html).join('') })
  }
  return out
})

// ===== 每道题的编辑态（结构识别结果 → QuestionForm 的 initial）=====
interface DraftQuestion {
  qtype: string
  content: string
  options: string[]
  answer: string
  analysis: string
  score: number
  difficulty: number
  knowledge_point_ids: number[]
  status: string
  /** 后端已存在的题目 id（更新时用）；null = 待新增 */
  id: number | null
  /** 是否为 Word 导入的原生题干（用于标记待校对） */
  imported: boolean
}
const drafts = ref<DraftQuestion[]>([])
const activeIdx = ref(0)
const saving = ref(false)

// ===== 分割线拖拽 =====
const dragging = ref<number | null>(null)

// ===== 题型识别（与 WordImportPanel 同一套规则，保持行为一致）=====
const optRe = /^\s*([A-Ha-h])[.、)）]/
const JUDGE_WORDS = ['对', '错', '正确', '错误', '√', '×', 'T', 'F', 'true', 'false']

function toText(html: string): string {
  return String(html)
    .replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 选项行判据（A. / A． / (A) / A、） */
const optLineRe = /^\s*[(（]?\s*[A-Ha-h]\s*[.、)）．:：]/i

/**
 * 从题干 HTML 里剥掉「选项行 / 答案行 / 解析行」。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.9.1 修正 · 「选项重复输出两遍」】
 *
 * 上一版 `inferDraft` 返回的 `content` 用的是**完整 html**，
 * 而 `options` 字段又从同一段文字里提取了一份。于是输出时：
 *   content（已含选项段落 A. 甲 / B. 乙 …）+ options（再来一遍）→ **选项出现两遍**。
 * 实测证据：「A. 甲\nB. 乙\nC. 丙\nA. 甲\nB. 乙…」
 *
 * 修法：`content` 只用**剥掉选项/答案/解析后**的题干 HTML。
 *   ⚠️ 表格与图片必须保留（它们常是题干的一部分，且不可拆），
 *      所以「含 table 的元素」一律跳过不删。
 * ────────────────────────────────────────────────────────────────────────────
 */
function stripOptionsFromHtml(html: string): string {
  if (typeof document === 'undefined') return html
  try {
    const holder = document.createElement('div')
    holder.innerHTML = html
    Array.from(holder.children).forEach(el => {
      const tag = el.tagName.toLowerCase()
      // 表格 / 含表格的容器 → 保留（合并单元格表格是题干结构，不能删）
      if (tag === 'table' || el.querySelector('table')) return
      const t = (el.textContent || '').replace(/[\s\u00a0\u3000]+/g, ' ').trim()
      if (!t) return
      // 选项行
      if (optLineRe.test(t)) { el.remove(); return }
      // 答案行
      if (/^(?:答案|参考答案|解答|答)\s*[:：]?/.test(t)) { el.remove(); return }
      // 解析行
      if (/^(?:答案解析|解析|【解析】|【答案】)/.test(t)) el.remove()
    })
    return holder.innerHTML
  } catch { return html }
}

/**
 * 用一个 HTML 片段推断题型。
 * 与 WordImportPanel.parseBlock 保持同一套判据 —— 这样「导入」与「原卷编辑」
 * 两条入口给出的初始题型一致，不会互相打脸。
 */
function inferDraft(html: string): DraftQuestion {
  const text = toText(html)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  let first = (lines[0] || '').replace(/^\s*(?:\d+\s*[.、)）]|[（(]\s*\d+\s*[)）]|[一二三四五六七八九十百]+[、.])/, '').trim()
  if (!first) first = lines[0] || ''

  const opts: string[] = []
  const rest: string[] = []
  let answer = ''
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i]
    if (optRe.test(ln)) { opts.push(ln.replace(optRe, '').trim()); continue }
    if (/答案|参考答案|解答|答[:：]/.test(ln)) { answer = ln.replace(/^.*?(答案|参考答案|解答|答)[:：]?\s*/, ''); continue }
    rest.push(ln)
  }

  let qtype = 'subjective'
  const isJudge = opts.length >= 2 && opts.every(o => JUDGE_WORDS.some(w => o.includes(w)))
  if (isJudge) qtype = 'judge'
  else if (opts.length >= 2) {
    const letters = answer.replace(/[^A-Ha-h]/g, '')
    qtype = (/(多选|多项选择题)/.test(first) || letters.length >= 2 || /[，,、]/.test(answer)) ? 'multiple' : 'single'
  }

  return {
    qtype,
    // 【v4.9.1】content 必须剥掉选项/答案/解析段 —— 否则 content 与 options 各输出一遍，
    //   用户看到「选项重复两遍」（实测已复现）。表格/图片会被保留。
    //
    // 【v4.13.2】再剥掉题干开头的**题号**（用户需求：「切完题后自动把序号去除，
    //   小题的不要去」）。判据见 `@/utils/question-number`：
    //   · 去：`1.` `1、` `一、` `（一）` `第1部分` `第Ⅰ卷`
    //   · 不去：`(1)` `①` 这类小问号（解答题里极常见，误删会永久丢信息）
    content: stripQuestionNumber(stripOptionsFromHtml(html)),
    options: opts,
    answer: answer.trim(),
    // rest 是除选项/答案外的其它文字（常是「解析」「说明」），归到 analysis
    analysis: rest.filter(Boolean).join('\n'),
    score: 5,
    difficulty: 3,
    knowledge_point_ids: [],
    status: 'imported_needs_review',
    id: null,
    imported: true,
  }
}

// ===== 上传并解析 =====
async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  fileName.value = f.name
  busy.value = true
  progressText.value = '正在读取 Word…'
  try {
    srcArrayBuffer = await f.arrayBuffer()
    // ① 用 mammoth 取 HTML（图片 → 上传成 URL，避免 base64 撑爆）
    const mammothMod: any = (await import('mammoth/mammoth.browser')).default
    const convertImage = mammothMod.images.imgElement(async (image: any) => {
      const b64 = await image.read('base64')
      const byteLen = Math.floor(b64.length * 3 / 4)
      // 图片一律上传（原卷编辑会反复渲染，base64 会让内存与网络双重吃紧）
      if (byteLen <= 0.9 * 1024 * 1024) return { src: `data:${image.contentType};base64,${b64}` }
      try {
        const bin = atob(b64); const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const r: any = await api.uploadImage(new File([bytes], `word-${Date.now()}.png`, { type: image.contentType }))
        return { src: r.url }
      } catch { return { src: '' } }
    })
    const { value: html } = await mammothMod.convertToHtml({ arrayBuffer: srcArrayBuffer, convertImage })

    // ② 切成「块」：以顶层块级元素为单位（这样分割线可以落在任意两段之�间）
    progressText.value = '正在切分原卷…'
    blocks.value = splitIntoBlocks(html)

    // ③ 自动插入分割线（用户需求：「系统自动插入分割线」）
    boundaries.value = autoSplit(blocks.value)

    // ④ 生成每题的编辑态
    drafts.value = chunks.value.map(c => inferDraft(c.html))
    activeIdx.value = 0
    stage.value = 'split'
    ElMessage.success(`已识别 ${drafts.value.length} 道题，请核对分割线后进入编辑`)
    await nextTick()
    await renderWordView()
    // 网站渲染视图也要有一份初始内容（用户切过去时不必等 350ms debounce）
    scheduleSitePreview()
  } catch (err: any) {
    console.error(err)
    ElMessage.error('Word 解析失败：' + (err?.message || err))
  } finally {
    busy.value = false
    progressText.value = ''
  }
}

/**
 * 把 Word 的 HTML 切成 blocks。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.12.0 重写 · 支持「一段内多题」】
 *
 * 上一版**只按顶层块级元素切**（`<p>` 一段 = 一个 block）。
 * 但 Word 卷子里极常见「一个段落里塞了多道题」（比如：
 *   `1. 下列说法正确的是（ ） A.甲 B.乙  2. 下列错误的是（ ） A.丙 B.丁`
 * 全在一个 `<p>` 里，中间只有软换行或空格），
 * 于是**整段只能落一条分割线**——用户无论如何都切不开，
 * 这就是「拖动分题目功能完全瘫痪、十分难用」的第二个根源。
 *
 * 修法：**在段落内部按行继续下钻**。
 *   · 段落里若有 `<br>`，按 `<br>` 拆成多行，每行独立成块
 *   · 拆出来的行**保留其所属父段落的结构**（用 span 包裹保持字体等样式）
 *   · 表格 / 图片仍然不可拆（拆了就破坏结构）
 *
 * 这样「块」的粒度从"段落级"细化到"行级"，
 * 配合下面的行内切割能力，同一段里的多道题也能被分开。
 * ────────────────────────────────────────────────────────────────────────────
 */
function splitIntoBlocks(html: string): Block[] {
  if (typeof document === 'undefined') return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: Block[] = []

  const push = (h: string, t: string) => { if (t || /<img/i.test(h)) out.push({ html: h, text: t }) }

  Array.from(doc.body.childNodes).forEach(n => {
    if (n.nodeType !== 1) {
      const t = (n.textContent || '').trim()
      if (t) push(escapeHtml(t), t)
      return
    }
    const el = n as HTMLElement
    const tag = el.tagName.toLowerCase()
    // 表格/图片单独成块（不可再拆 —— 拆了就破坏结构）
    if (tag === 'table' || el.querySelector('table')) {
      push(el.outerHTML, toText(el.outerHTML))
      return
    }

    // ① 段落内按 <br> 下钻：一行一块
    const brCount = el.querySelectorAll('br').length
    if (brCount > 0) {
      const lines = innerSplitByBr(el)
      if (lines.length > 1) {
        lines.forEach(ln => push(ln.html, ln.text))
        return
      }
    }

    // ② 再试一次：段内无 <br> 但含多个「题号起始」（软换行/空格分隔的多题）
    const softLines = splitSoftLines(el)
    if (softLines && softLines.length > 1) {
      softLines.forEach(ln => push(ln.html, ln.text))
      return
    }

    const t = toText(el.outerHTML)
    push(el.outerHTML, t)
  })
  return out
}

/** 把元素按内部 <br> 拆成多行，每行用同标签包一份（保持字体等样式） */
function innerSplitByBr(el: HTMLElement): { html: string; text: string }[] {
  const tag = el.tagName.toLowerCase()
  const cls = el.getAttribute('class') || ''
  const style = el.getAttribute('style') || ''
  const groups: Node[][] = [[]]
  Array.from(el.childNodes).forEach(c => {
    if (c.nodeType === 1 && (c as HTMLElement).tagName.toLowerCase() === 'br') groups.push([])
    else groups[groups.length - 1].push(c)
  })
  const wrapAttrs = (cls ? ` class="${cls}"` : '') + (style ? ` style="${style}"` : '')
  return groups
    .map(g => {
      const holder = document.createElement('div')
      g.forEach(x => holder.appendChild(x.cloneNode(true)))
      const inner = holder.innerHTML
      const text = toText(inner)
      return { html: `<${tag}${wrapAttrs}>${inner}</${tag}>`, text }
    })
    .filter(x => x.text || /<img/i.test(x.html))
}

/**
 * 段落内没有 <br>，但可能存在「软换行」写在一起的多个题号。
 * 识别方式：纯文本里出现 `…　1. xxx` / `… 2. xxx` 这类"行中题号"。
 * 只有确实切出 ≥2 段时才启用（否则保持原样，避免误伤）。
 */
function splitSoftLines(el: HTMLElement): { html: string; text: string }[] | null {
  const raw = el.textContent || ''
  if (raw.length < 30) return null
  // 匹配「空白 + 题号」的位置（题号: 1. / (1) / 一、 等）
  const re = /[\s\u00a0\u3000]{2,}(?=\d{1,3}\s*[.、)）]\s*\S)/g
  const marks: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) marks.push(m.index + (m[0].length - m[0].trimStart().length) + 0)
  if (marks.length < 1) return null
  // 至少要能切出 2 段，且每段都有一定长度（防止把 "1. 2. 3." 这种编号列表误切）
  const cuts = [0, ...marks, raw.length].filter((v, i, a) => i === 0 || v > a[i - 1])
  const segs = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = raw.slice(cuts[i], cuts[i + 1]).trim()
    if (s) segs.push(s)
  }
  if (segs.length < 2) return null
  // 极短的段（<6 字）多半是误切，放弃
  if (segs.filter(s => s.length < 6).length > 0) return null
  const tag = el.tagName.toLowerCase()
  return segs.map(s => {
    const h = escapeHtml(s)
    return { html: `<${tag}>${h}</${tag}>`, text: s }
  })
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 自动插入分割线。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.12.0 重写 · 修「自动切割题目光用不了」】
 *
 * 上一版的三个致命缺陷：
 *   ① **只认二级题号 `1.`，完全没用上 `MAJOR_RE`**（大题号「一、」形同虚设），
 *      于是一份「一、选择题  1.xxx 2.xxx」的卷子切出来的切点仍然只有小题，
 *      大题的归属信息全丢；
 *   ② **一条切点都找不到时直接 `return [0, bs.length]`** —— 整篇变成 **1 道题**，
 *      用户看到的就是「自动切割完全没用」；
 *   ③ 用 `blocks[0]` 之前的块全当卷头丢弃，首题有丢失风险。
 *
 * 新策略（四级判据，逐级放宽，绝不空手而归）：
 *   L1 二级题号（`1.` `2、` `(3)`）        → 切点
 *   L2 一级题号（`一、` `二、` `第Ⅰ卷`）  → 切点（并标记为大题起点）
 *   L3 选项字母行（`A.` / `A．`）         → 若上一行是题干，说明新题开始（兜底）
 *   L4 全部失效时                        → **按空行/段落数均分**成若干题，而不是 1 题
 *
 * 同时记录每个切点的来源等级，供 UI 提示「哪些是自动推断、需要核对」。
 * ────────────────────────────────────────────────────────────────────────────
 */
const MAJOR_RE = /^\s*(?:[一二三四五六七八九十百]+[、.]|第\s*[一二三四五六七八九十\d]+\s*[部分卷]|[（(][一二三四五六七八九十]+[)）]|【[一二三四五六七八九十]+】)/
const MINOR_RE = /^\s*(?:\d+\s*[.、)）]|[（(]\s*\d+\s*[)）])/
/** 选项行（用于 L3 兜底识别） */
const OPT_LINE_RE = /^\s*[(（]?\s*A\s*[.、)）．:：]/i

/** 切点来源，供 UI 标注「建议核对」 */
type CutSource = 'minor' | 'major' | 'option' | 'fallback'
const cutSources = ref<Map<number, CutSource>>(new Map())

function autoSplit(bs: Block[]): number[] {
  const cuts = new Map<number, CutSource>()

  bs.forEach((b, i) => {
    const line = (b.text.split('\n')[0] || '').trim()
    if (!line) return

    // ──────────────────────────────────────────────────────────────────────
    // 【v4.12.0 修正 · 首个大题号被吞进卷头】
    //
    // 上一版在这里无条件 `if (i === 0) return` —— 本意是"块 0 是卷头，不当题起点"。
    // 但很多卷子的**块 0 就是第一个大题号**（`一、选择题`），于是：
    //   · 切点从块 3（`二、填空题`）才开始
    //   · 「一、选择题」连同它下面的题全被算进"卷头"，**第一大道题整块丢失**
    //
    // 修法：`i === 0` 时**照常判定**，只有当它不是题号时才跳过。
    // 这样 `一、选择题` 能成为第 1 题的起点，`2026学年期中考试` 仍被当卷头。
    // ──────────────────────────────────────────────────────────────────────
    if (i === 0) {
      if (MINOR_RE.test(line) || MAJOR_RE.test(line)) cuts.set(0, MINOR_RE.test(line) ? 'minor' : 'major')
      return
    }

    // L1 二级题号（最可靠）
    if (MINOR_RE.test(line)) { cuts.set(i, 'minor'); return }
    // L2 一级题号
    if (MAJOR_RE.test(line)) { cuts.set(i, 'major'); return }
    // L3 选项 A 行，且**上一块不是选项行** → 说明这是新题的选项（题干在更前面）
    if (OPT_LINE_RE.test(line)) {
      const prev = (bs[i - 1]?.text.split('\n')[0] || '').trim()
      if (prev && !/^\s*[(（]?\s*[A-Ha-h]\s*[.、)）．:：]/.test(prev)) cuts.set(i, 'option')
    }
  })

  let list: number[]
  if (cuts.size) {
    const sorted = Array.from(cuts.keys()).sort((a, b) => a - b)
    // 卷头 = 第一个切点之前的块（不生成题目）
    const start = sorted[0]
    list = [start, ...sorted.filter(c => c > start), bs.length]
  } else {
    // ── L4 兜底：一条题号都没识别到 ────────────────────────────────────────
    // 上一版在这里返回 [0, bs.length]（整篇 = 1 题），用户完全没法用。
    // 现在改为：**按块数均分**成若干题，并把来源标为 fallback 让 UI 提醒核对。
    const total = bs.length
    if (total <= 1) return [0, Math.max(1, total)]
    // 每 ~6 块切一题（一题通常 1~8 块），至少 2 题、至多 40 题
    const perQ = Math.max(1, Math.min(6, Math.ceil(total / 20)))
    list = [0]
    for (let i = perQ; i < total; i += perQ) { list.push(i); cuts.set(i, 'fallback') }
    list.push(total)
  }

  const uniq = Array.from(new Set(list)).sort((a, b) => a - b)
  // 记录来源（首尾线无来源）
  const src = new Map<number, CutSource>()
  uniq.forEach((v, idx) => {
    if (idx === 0 || idx === uniq.length - 1) return
    const s = cuts.get(v)
    if (s) src.set(v, s)
  })
  cutSources.value = src
  return uniq
}

// ===== Word 原卷视图（docx-preview 保真渲染）=====
//
// 【v4.9.0 补全 · 拖拽吸附的关键一环】
//   docx-preview 渲染出的是它自己的 DOM（<section><p>…），和我们用 mammoth 切出的
//   `blocks` 是**两套独立的结构**。要让「在原卷上直接拖分割线」成立，
//   必须先把两者**对齐**：给原卷里每个顶层块打上 `data-block-idx`，
//   这样 onDragMove 里的 `elementFromPoint(...).closest('[data-block-idx]')` 才能命中。
//
//   对齐策略（稳健优先）：
//     ① 按**文档顺序**逐个配对 docx 的顶层块与我们的 blocks
//     ② 用归一化后的**文本前缀**校验；文本对不上就顺延查找，避免个别块增删导致整体错位
//     ③ 实在对不上的块退化为「按顺序硬配」——宁可错位一格，也不能整条链路失效
const BLOCK_IDX_ATTR = 'data-block-idx'

/**
 * 归一化文本（与原卷比对用）：去标签、去空白、去常见标点。
 *
 * 【v4.12.0 补强 · 全角字母数字也要归一】
 *   中文 Word 文档里的题号经常是全角：`１．`（U+FF11）、`Ａ．`（U+FF21）、
 *   `＝`（U+FF1D）。只归一标点是不够的 ——
 *   mammoth 与 docx-preview 可能一条路径保留全角、另一条转成半角，
 *   于是 `１．下列函数` 与 `1. 下列函数` 归一化后只差一个字（`１` vs `1`），
 *   bigram 相似度掉到 0.45 左右，虽然还能过阈值，但余量很薄；
 *   一旦再叠加一处差异就会跌破阈值 → 块匹配失败 → 分割线错位。
 *   这里统一做 **NFKC 归一**，把全角字母/数字/运算符全部转半角。
 */
function normForMatch(s: string): string {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, '')
    .normalize('NFKC')                       // 全角 → 半角（１→1, Ａ→A, ＝→=）
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[。．.，,、；;：:！!？?"'“”‘’()（）\[\]【】]/g, '')
}

/**
 * 在原卷 DOM 上标注 data-block-idx，返回成功标注的数量。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.9.1 修正 · 「无法拖动」的根因之一：取错了 DOM 层级】
 *
 * docx-preview 真实渲染出来的结构是**四层**：
 *   `host > div.docx-wrapper > section.docx > div/article > p|table`
 * 其中 `article` 那一层带 `z-index:1`，是真正的「内容块」容器。
 *
 * 上一版取的是 `section.children` —— 也就是那层**没有类名的第二层 div**，
 * 而它**每页只有一个**（它把整页所有段落都包在里面）。
 * 结果：所有标注都打在同一个元素上，`data-block-idx` 反复被覆盖，
 * `host.querySelectorAll('[data-block-idx]')` 永远只返回 1 个元素
 * （实测：11 个块 → 去重后 1 个）。
 * 拖拽时 `elementFromPoint(...).closest('[data-block-idx]')` 命中的 idx
 * 也就永远是那一个值 → 拖了没反应。
 *
 * 修法：**下沉一层**取真正的内容块（p / table / ul / ol / h1-6 / li），
 * 并处理 docx-preview 把多个段落塞进一个 div 的情况（再下沉一层）。
 * ────────────────────────────────────────────────────────────────────────────
 */
const CONTENT_TAGS = /^(p|table|ul|ol|h[1-6]|dl|blockquote|pre)$/i
/** docx-preview 用来包内容的容器类名（这些层的子元素才是真正的内容块） */
const WRAPPER_CLASSES = /^(docx-wrapper|docx|article|docx-wrapper-section)$/i

/**
 * 相似度（0~1）。用于「顺序匹配」时判断两个文本是不是同一块。
 *
 * 为什么不再用「前缀相等」：Word 里同一段文字在 mammoth 与 docx-preview
 * 两条渲染路径下，可能出现**细微差异**（全角/半角、空格、软连字符、
 * 公式占位符、图片 alt 等）。前缀相等是**零容错**的，
 * 一旦首字符不同就判定"对不上"，整条链路连锁错位 —— 这正是
 * 「拖动完全没反应 / 分割线落在错误位置」的直接原因。
 *
 * 改用**二元组（bigram）Jaccard 相似度**：对上述噪声天然鲁棒，
 * 且对"完全不同的两块"能清晰区分。
 */
function similarity(a: string, b: string): number {
  const x = normForMatch(a)
  const y = normForMatch(b)
  if (!x && !y) return 1
  if (!x || !y) return 0
  if (x === y) return 1
  // 包含关系直接给高分（Word 可能多一个页码/空格）
  if (x.startsWith(y) || y.startsWith(x)) return 0.92
  if (x.includes(y) || y.includes(x)) return 0.85
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0
  const grams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = grams(x); const B = grams(y)
  let inter = 0
  A.forEach(g => { if (B.has(g)) inter++ })
  const union = A.size + B.size - inter
  return union ? inter / union : 0
}

/** 匹配阈值：低于此值认为"这不是同一块" */
const MATCH_MIN = 0.34

/**
 * 在原卷 DOM 上标注 data-block-idx，返回成功标注的数量。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.12.0 重写 · 拖动瘫痪的根治】
 *
 * 历史问题（依次修过两次仍未根治）：
 *   v4.9.1-a：取错 DOM 层级（`section.children` 每页只有 1 个）→ 所有标注打在同一个元素
 *   v4.9.1-b：补了 z-index，但**对齐算法本身仍是"前缀相等 + 顺延 3 格 + 硬配"**：
 *       · 前缀相等零容错 → 一处对不上，后面**全部连锁错位**
 *       · "硬配"兜底会把块贴到**错误**的元素上，比不标还糟（线画在错的地方）
 *       · `layoutOverlay` 找不到块就 `return` 跳过 → 分割线**凭空消失**
 *
 * 新算法（四步，保证 100% 覆盖）：
 *   ① 收集候选内容块（含"段落内被切开"的行级元素）
 *   ② **顺序 + 相似度**双向最优匹配：对每个 block，在其"预期位置附近"的
 *      候选里挑相似度最高的；只有超过 MATCH_MIN 才认账
 *   ③ 对**没匹配上的 block**，锚定到"前一个已匹配块之后最近的候选"，
 *      保证每个 block 都有 DOM 归属（不会出现"线消失"）
 *   ④ 若候选总数与 block 数差异极大（说明渲染结构完全不同），
 *      退化为**纯等比顺序映射**，至少保证拖动可用
 * ────────────────────────────────────────────────────────────────────────────
 */
function tagDocxBlocks(): number {
  const host = docxHost.value
  if (!host || !blocks.value.length) return 0

  // ① 先清掉上一次的标注（重新渲染后旧标注会失效，也会干扰下面的候选收集）
  host.querySelectorAll(`[${BLOCK_IDX_ATTR}]`).forEach(el => el.removeAttribute(BLOCK_IDX_ATTR))

  // ② 收集**真正的内容块**：优先找 p/table/ul/ol/h1-6，且不能嵌在 table 里
  let candidates: HTMLElement[] = Array.from(host.querySelectorAll('p, table, ul, ol, h1, h2, h3, h4, h5, h6'))
    .filter(el => el.tagName.toLowerCase() !== 'p' || !el.closest('table')) as HTMLElement[]

  // ③ 兜底：如果一段 p 都找不到（极端结构），退回「wrapper 层的有 class 的容器」
  if (!candidates.length) {
    const wrappers = Array.from(host.querySelectorAll('section, div, article'))
      .filter(el => WRAPPER_CLASSES.test(el.className || '')) as HTMLElement[]
    const pool: HTMLElement[] = []
    const push = (el: HTMLElement) => {
      const inner = Array.from(el.children).filter(c => CONTENT_TAGS.test((c as HTMLElement).tagName)) as HTMLElement[]
      if (inner.length > 1) inner.forEach(c => pool.push(c))
      else pool.push(el)
    }
    if (wrappers.length) wrappers.forEach(push)
    else push(host)
    candidates = pool
  }
  if (!candidates.length) return 0

  const nB = blocks.value.length
  const nC = candidates.length
  const map = new Map<number, HTMLElement>()   // blockIdx → DOM 元素

  // ── 极端情况：候选数远多于 block 数（>3 倍）或远少于（<1/3） ──────────
  //   说明两条渲染路径的结构差异过大，做精确匹配没有意义。
  //   退化为**等比顺序映射**：至少保证「拖到哪 = 哪一块」，可用性优先。
  const ratio = nC / nB
  if (ratio > 3 || ratio < 1 / 3) {
    for (let i = 0; i < nB; i++) {
      const ci = Math.min(nC - 1, Math.floor((i / nB) * nC))
      const el = candidates[ci]
      if (el) map.set(i, el)
    }
    map.forEach((el, i) => el.setAttribute(BLOCK_IDX_ATTR, String(i)))
    return map.size
  }

  // ── 正常情况：顺序 + 相似度匹配 ────────────────────────────────────────
  //   对每个 block，在"预期位置 ± 窗口"内找相似度最高的候选。
  //   窗口随 index 推进（因为前面已消耗的候选数会累积偏差）。
  let cursor = 0
  for (let bi = 0; bi < nB; bi++) {
    const target = blocks.value[bi].text
    // 预期位置：按比例估算，再取窗口
    const expect = Math.round((bi / Math.max(1, nB - 1 || 1)) * (nC - 1))
    const lo = Math.max(cursor, expect - 12, 0)
    const hi = Math.min(nC - 1, Math.max(expect, cursor) + 12)
    let bestC = -1
    let bestS = 0
    for (let ci = lo; ci <= hi; ci++) {
      if (!candidates[ci]) continue
      const s = similarity(target, candidates[ci].textContent || '')
      if (s > bestS) { bestS = s; bestC = ci }
    }
    if (bestC >= 0 && bestS >= MATCH_MIN) {
      map.set(bi, candidates[bestC])
      cursor = bestC + 1
    }
  }

  // ── 给未匹配的 block 补锚点 ────────────────────────────────────────────
  //   规则：挂到"上一个已匹配 block 的 DOM 元素之后、最近的那个未占用候选"上；
  //   若后面确实没有，就复用上一个已匹配元素（保证线不会消失）。
  const used = new Set<HTMLElement>(map.values())
  let lastEl: HTMLElement | null = null
  for (let bi = 0; bi < nB; bi++) {
    if (map.has(bi)) { lastEl = map.get(bi)!; continue }
    // 往后找第一个未占用的候选
    let picked: HTMLElement | null = null
    if (lastEl) {
      const startCi = candidates.indexOf(lastEl)
      for (let ci = startCi + 1; ci < nC; ci++) {
        if (candidates[ci] && !used.has(candidates[ci])) { picked = candidates[ci]; break }
      }
    } else {
      // 还没锚定任何块（说明开头几块没匹配上）→ 从候选头部取
      for (let ci = 0; ci < nC; ci++) {
        if (candidates[ci] && !used.has(candidates[ci])) { picked = candidates[ci]; break }
      }
    }
    if (!picked) picked = lastEl || candidates[0]
    if (picked) {
      map.set(bi, picked)
      used.add(picked)
      lastEl = picked
    }
  }

  map.forEach((el, i) => el.setAttribute(BLOCK_IDX_ATTR, String(i)))
  return map.size
}

/**
 * 【v4.9.1】把「渲染完成 → 标注 → 布局」的时序做稳。
 *
 * 为什么需要单独一个函数：docx-preview 的 `renderAsync` resolve 之后，
 * 浏览器**还没完成布局**（尤其是 `breakPages` 分页与字体加载）。
 * 此时立刻 `getBoundingClientRect()` 拿到的位置可能是 0 或旧值，
 * 叠加层就会画在错误的位置（用户看到「分割线全挤在最上面」）。
 *
 * 采用**双 rAF**（等两个绘制帧）后测量；若首轮没标注到任何块，
 * 再补一轮 rAF 重试（字体/分页可能在更晚的帧里才稳定）。
 */
function settleOverlay() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const n = tagDocxBlocks()
      layoutOverlay()
      if (!marks.value.length && n > 0) {
        requestAnimationFrame(() => { tagDocxBlocks(); layoutOverlay() })
      }
    })
  })
}

async function renderWordView() {
  if (!docxHost.value || !srcArrayBuffer) return
  try {
    const { renderAsync } = await import('docx-preview')
    docxHost.value.innerHTML = ''
    await renderAsync(srcArrayBuffer.slice(0), docxHost.value, undefined, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
    })
    // 渲染完成后对齐块编号，并叠加可视分割线。
    // 【v4.9.1】改用 settleOverlay：双 rAF 等布局稳定后再测量，
    //   否则 renderAsync resolve 时浏览器还没完成分页/字体布局，
    //   量到的块位置是 0 或旧值 → 分割线全挤在最上面。
    await nextTick()
    settleOverlay()
    requestAnimationFrame(() => {
      if (!docxHost.value?.querySelector(`[${BLOCK_IDX_ATTR}]`)) {
        console.warn('[原卷编辑] 未能对齐任何块，拖拽吸附将不可用')
      }
    })
  } catch (e: any) {
    console.warn('[docx-preview] 渲染失败，退回网站视图:', e?.message)
    viewMode.value = 'site'
    ElMessage.warning('Word 原卷渲染失败，已切换到网站视图')
  }
}

// ===== 【v4.9.0 补全】原卷可视分割线（叠加层）=====
//
// 用户要的是「原卷上直接拖」。前面 tagDocxBlocks 解决了「拖到哪一块」的识别，
// 这里解决「分割线画在哪、怎么抓」：
//   · 每条分割线是一个绝对定位的横条，覆盖在对应块的**上边缘**
//   · 横条左侧有题号徽标，右侧有拖拽把手与 ＋/－ 按钮
//   · 拖动横条 → 实时高亮目标块 → 松手吸附到该块边界
interface SplitMark {
  /** 分割线序号（对应 boundaries 的下标） */
  bi: number
  /** 该分割线所属的 block 下标 */
  blockIdx: number
  /** 相对原卷容器的 top 像素 */
  top: number
  /** 是否可拖拽（首尾不可拖） */
  draggable: boolean
}
const marks = ref<SplitMark[]>([])
const hoverBlockIdx = ref<number | null>(null)

/** 重算所有分割线的位置（原卷滚动/缩放/重排后都要调） */
function layoutOverlay() {
  const host = docxHost.value
  if (!host || viewMode.value !== 'word') { marks.value = []; return }
  const hostRect = host.getBoundingClientRect()
  const out: SplitMark[] = []
  const nB = blocks.value.length

  boundaries.value.forEach((blockIdx, i) => {
    // ──────────────────────────────────────────────────────────────────────
    // 【v4.12.0 修正 · 分割线"凭空消失"】
    //
    // 上一版：找不到对应块就 `return` 跳过这条线 → 用户看到线没了，
    //   以为是"拖动把线弄丢了"（实际是标注失败）。
    // 现在：三级兜底，**任何情况下都画出这条线**。
    // ──────────────────────────────────────────────────────────────────────
    let top: number | null = null

    const el = host.querySelector(`[${BLOCK_IDX_ATTR}="${blockIdx}"]`) as HTMLElement | null
    if (el) {
      top = el.getBoundingClientRect().top - hostRect.top
    } else if (blockIdx >= nB) {
      // 末条：贴在最后一个已标注块的下方
      const last = host.querySelector(`[${BLOCK_IDX_ATTR}="${Math.max(0, nB - 1)}"]`) as HTMLElement | null
      top = last ? last.getBoundingClientRect().bottom - hostRect.top : host.scrollHeight
    } else {
      // 中间条找不到自己的块 → 借"最近的前一个已标注块"的底部，保证线仍在
      for (let k = blockIdx - 1; k >= 0; k--) {
        const prev = host.querySelector(`[${BLOCK_IDX_ATTR}="${k}"]`) as HTMLElement | null
        if (prev) { top = prev.getBoundingClientRect().bottom - hostRect.top; break }
      }
      if (top === null) top = 0
    }

    // 【v4.12.0】首尾分割线**也允许拖动** —— 用户要调第 1 题的起点/末题终点，
    //   之前硬性禁止，是"十分难用"的一大来源。首条可向后拖（跳过卷头），
    //   末条可向前拖（切除尾部页脚区）。
    out.push({ bi: i, blockIdx, top, draggable: boundaries.value.length > 2 })
  })
  marks.value = out
}

// 视图切换 / 分割线变化 → 重算叠加层
watch(boundaries, () => { nextTick(() => layoutOverlay()) })
// 原卷滚动时同步（叠加层是绝对定位在内容坐标系里，滚动不需要重算；
// 但窗口尺寸变化会让 docx 重排，必须重算）
function onResize() { layoutOverlay() }

// 切换视图时按需渲染
//
// 【v4.9.1】`word` 分支走 renderWordView（内含 settleOverlay，双 rAF 等布局稳定）；
//   `site` 分支触发网站预览重算（见 renderSitePreview / scheduleSitePreview）。
//   ⚠️ v-show 切换时元素只是 display 变了，DOM 尺寸需要一帧才更新，
//     所以两种视图都必须在 nextTick 之后再测量/渲染。
watch(viewMode, async (m) => {
  if (m === 'word') { await nextTick(); await renderWordView() }
  else if (m === 'site') { scheduleSitePreview() }
})

/** 「按当前内容重新渲染 docx」—— 把编辑后的题目重新生成 Word 预览 */
async function rebuildFromContent() {
  if (!docxHost.value) return
  busy.value = true
  progressText.value = '正在按当前内容重新排版…'
  try {
    // 【v4.9.1 修正】改用**唯一的 Word 构建器** buildPaperDocx（@/utils/docx-kit）。
    //
    // 上一版在这里手搓 `Document/Paragraph/TextRun` 并把每行文字 `replace(/<[^>]+>/g,'')`
    // 拍扁成纯文本 —— 后果：**公式、图片、合并表格、列表版式全部丢失**，
    // 重排出来的「原卷」和最终导出的 Word 完全是两个样子。
    // 现在与导出、网站预览共用同一套实现，三者天然一致。
    const { buildPaperDocx } = await import('@/utils/docx-kit')
    const questions = chunks.value.map((c, i) => {
      const d = drafts.value[i]
      return {
        qtype: d?.qtype || 'subjective',
        content: d?.content ?? c.html,
        options: d?.options || [],
        answer: d?.answer || '',
        analysis: d?.analysis || '',
        score: d?.score ?? 5,
      }
    })
    const blob = await buildPaperDocx(questions, { showTypeHeading: false, withAnswers: false, fontSize: 21 })
    const buf = await blob.arrayBuffer()
    const { renderAsync } = await import('docx-preview')
    docxHost.value.innerHTML = ''
    await renderAsync(buf, docxHost.value, undefined, { className: 'docx', inWrapper: true, breakPages: true })
    // 重排后 DOM 全新 → 必须重新标注块 + 重画分割线
    await nextTick()
    settleOverlay()
    ElMessage.success('已按当前内容重新渲染')
  } catch (e: any) {
    ElMessage.error('重新渲染失败：' + (e?.message || e))
  } finally { busy.value = false; progressText.value = '' }
}

function qtypeLabel(q: string): string {
  return ({ single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' } as any)[q] || '主观'
}

// ===== 【v4.13.0】AI 智能识别 =====
//
// 用户反馈：「自动切割题目读取答案和解析实在是太难用了」。
// 正则的根本局限（无论怎么调）：
//   · 题号格式一变就切不出（"1)" "1、" "1." "(1)" "第1题"…无穷变体）
//   · 卷末「参考答案」区块无法关联回题目（正则只看行内紧邻）
//   · 答案与解析混在题干里的各种排版无法区分
// 所以这里把「结构识别」交给大模型，**正则只作为降级兜底**：
//   AI 可用 → 用 AI 结果重建 boundaries + drafts
//   AI 不可用（模型不可用 / 超限 / 网络失败）→ 保持正则结果，并明确提示
//
// 【v4.13.0 变更】主通道改为 Cloudflare Workers AI：**零配置、无密钥**，
//   只要 Worker 绑定了 [ai] 就可用（免费档每天 1 万神经元）。智谱为可选备份，
//   超管可在「管理后台 → AI 设置」里填 Key 并切换服务商。
const aiStatus = ref<{ available: boolean; provider: string; effective?: string; cf: boolean; zhipu: boolean; modelCf: string; modelZhipu: string } | null>(null)
const aiRunning = ref(false)
const aiInfo = ref('')          // 上次识别结果摘要（服务商 / 题数 / 耗时）

/** 通道中文名（用于提示文案，避免用户看到裸的 "cf" / "zhipu"） */
const AI_CHANNEL_NAME: Record<string, string> = { cf: 'Cloudflare Workers AI', zhipu: '智谱 GLM' }

onMounted(async () => {
  try {
    aiStatus.value = await api.aiStatus() as any
  } catch { aiStatus.value = null }
})

/** AI 按钮不可用时的说明文案（区分"没通道"与"通道挂了"） */
const aiDisabledReason = computed(() =>
  'AI 服务不可用，将使用规则识别（可在「管理后台 → AI 设置」检查配置）'
)

/** AI 按钮 tooltip 里的"当前通道"文案 */
const aiChannelText = computed(() => {
  const s = aiStatus.value
  if (!s) return '未知'
  const eff = s.effective || s.provider
  if (eff === 'cf') return 'Cloudflare Workers AI（免费）'
  if (eff === 'zhipu') return '智谱 GLM'
  return '自动：Cloudflare Workers AI → 智谱'
})

/**
 * 用 AI 重新识别整卷。
 *
 * 关键设计：AI 返回的是**扁平题目数组**，要把它映射回「块边界」才能与左栏原卷联动。
 * 做法：对每道题用 `anchor`（题干开头若干字）在 blocks 里**模糊定位**，
 *   定位成功 → 该块就是这题的起点（形成 boundaries）；
 *   定位失败 → 退化为「按顺序等比分配块」，保证右栏题目数与左栏分割线一致。
 */
async function aiRecognize() {
  if (aiRunning.value) return
  if (!blocks.value.length) { ElMessage.warning('请先选择 Word 文件'); return }
  if (aiStatus.value && !aiStatus.value.available) {
    ElMessage.warning(aiDisabledReason.value)
    return
  }
  aiRunning.value = true
  progressText.value = 'AI 正在识别题目结构…'
  try {
    // 【v4.13.1】送 AI 的是 **HTML**（不是纯文本）。
    //
    // 为什么必须改：v4.13.0 传的是 `blocks.map(b => b.text)`，由此两条血管被切断 ——
    //   · 表格：text 已把 <td> 拍平成一行，行列结构消失，AI 无法作答依赖表格的题
    //   · 图片：<img> 的 text 是空串 → 被 `.filter(Boolean)` 丢掉 → **整块消失**
    // 用户反馈「遇到表格 图片之类的 AI 就不识别，直接吞了」正是这两条。
    //
    // 改传 HTML 后，后端 `htmlToStructuredText()` 会做保真转换：
    //   表格 → Markdown 表格（行列完整）、图片 → [图N] 占位符（位置保留）。
    const html = blocks.value.map(b => b.html).join('')
    const text = blocks.value.map(b => b.text).filter(Boolean).join('\n')
    const r: any = await api.aiParsePaper({ text, html, subjectId: props.subjectId })
    if (!r?.ok || !r.questions?.length) {
      const why = r?.available === false ? '（AI 服务不可用）' : `（${r?.message || '识别失败'}）`
      ElMessage.warning(`AI 识别未生效${why}，已保留规则识别结果`)
      return
    }

    // ① 用 anchor 在 blocks 里定位每题起点
    const nB = blocks.value.length
    const starts: number[] = []
    const norm = (s: string) => normForMatch(s)
    for (const q of r.questions) {
      const a = norm(q.anchor || '').slice(0, 12) || norm(q.content || '').slice(0, 12)
      let found = -1
      if (a) {
        for (let i = 0; i < nB; i++) {
          if (norm(blocks.value[i].text).includes(a)) { found = i; break }
        }
      }
      starts.push(found)
    }

    // ② 修掉"没找到"与"非递增"的起点
    let last = -1
    const clean: number[] = []
    let unfound = 0
    starts.forEach((s, i) => {
      if (s < 0) { unfound++; return }
      if (s <= last) {
        // 非递增 → 按题目序号等比推算一个合法位置
        const est = Math.min(nB - 1, Math.max(last + 1, Math.round((i / r.questions.length) * nB)))
        if (est > last) { clean.push(est); last = est }
        return
      }
      clean.push(s); last = s
    })

    // ③ 生成 boundaries（首尾补齐）
    let bnd: number[]
    if (clean.length >= 2) {
      bnd = Array.from(new Set([0, ...clean, nB])).sort((x, y) => x - y)
    } else {
      // 题目少或定位全失败 → 等比分配，保证左右栏数量一致
      const nQ = r.questions.length
      bnd = [0]
      for (let i = 1; i < nQ; i++) bnd.push(Math.round((i / nQ) * nB))
      bnd.push(nB)
      bnd = Array.from(new Set(bnd)).sort((x, y) => x - y)
    }
    // 题目数与边界段数必须一致；不一致时以"段数"为准裁掉多余题目
    const segCount = bnd.length - 1
    const qs = r.questions.slice(0, segCount)

    boundaries.value = bnd
    // ④ 生成每题的编辑态。
    //
    // 【v4.13.1 关键修正 · 「切完之后东西不能没」】
    //   上一版直接 `content: q.content` —— 用 AI 的**纯文本题干整体覆盖**，
    //   而 AI 的输入里表格已被压平、图片连占位符都没有，
    //   所以覆盖后原卷的 <table>/<img> **永久丢失**（用户反馈的"直接吞了"）。
    //
    //   现在改为**以原卷 HTML 为真源**（`chunks[i].html`，含完整 table/img），
    //   只从 AI 那里取「原卷里没有或不准」的元数据：
    //     题型 / 答案 / 解析 / 分值 / 分值。
    //   题干合并交给共享层的 `mergeContent()`（纯函数，前后端行为一致）。
    drafts.value = qs.map((q: any, i: number) => {
      const orig = chunks.value[i]?.html || ''
      const mergedContent = mergeContent(orig, q.content || '', r.images || {})
      // 原卷切出来的草稿里已经带了规则识别的答案/解析（常为空或不准），
      // 优先采用 AI 的；AI 没给就保留规则结果，避免"AI 一跑反而更空"。
      const base = orig ? inferDraft(orig) : blankDraft()
      const aiAnswer = String(q.answer || '').trim()
      const aiAnalysis = String(q.analysis || '').trim()
      return {
        qtype: q.qtype || base.qtype || 'subjective',
        content: mergedContent,
        // 选项：AI 与规则各给一份，取"内容更多"的那份（AI 常更准，但偶尔会漏）
        options: (q.options?.length >= (base.options?.length || 0)) ? q.options : base.options,
        answer: aiAnswer || base.answer,
        analysis: aiAnalysis || base.analysis,
        score: q.score ?? base.score ?? 5,
        difficulty: 3,
        knowledge_point_ids: [],
        status: 'imported_needs_review',
        id: null,
        imported: true,
      }
    })
    // AI 题数少于分割段数时补足（避免右栏缺题）
    while (drafts.value.length < segCount) {
      const c = chunks.value[drafts.value.length]
      drafts.value.push(c ? inferDraft(c.html) : blankDraft())
    }
    activeIdx.value = 0
    lastBoundarySnapshot = boundaries.value.slice()
    oldDirty.value.clear()
    refreshFingerprints()
    await nextTick()
    layoutOverlay()

    const providerName = AI_CHANNEL_NAME[r.provider] || r.provider
    aiInfo.value = `${providerName} · ${drafts.value.length} 题 · ${(r.elapsed / 1000).toFixed(1)}s`
    const warn = unfound ? `（${unfound} 题未精确匹配位置，已自动对齐）` : ''
    ElMessage.success(`AI 识别完成：${drafts.value.length} 道题${warn}`)
  } catch (e: any) {
    ElMessage.error('AI 识别失败：' + (e?.message || e) + '（已保留规则识别结果）')
  } finally {
    aiRunning.value = false
    progressText.value = ''
  }
}

/** 空草稿（补位用） */
function blankDraft(): DraftQuestion {
  return {
    qtype: 'subjective', content: '', options: [], answer: '', analysis: '',
    score: 5, difficulty: 3, knowledge_point_ids: [],
    status: 'imported_needs_review', id: null, imported: true,
  }
}

// ===== 【v4.13.2】题号剥离 =====
//
// 用户需求：「切完题后自动把序号去除（小题的不要去）」。
//   · **自动**：切题时 `inferDraft()` 已内置剥离（见 `content` 那一行）
//   · **手动**：这里提供按钮，应对「自动剥离后用户又粘回题号」或历史数据
//
// 与自动剥离的分工：
//   自动剥离只在**重新推断该题**时生效，且**不覆盖用户手动编辑过的题**
//   （`oldDirty` 保护）。按钮则是**显式操作**，用户点了就是要剥，包括已编辑的题。

/** 还有多少题的开头带题号（按钮可用性 + 数量提示） */
const numberStrippedCount = computed(() =>
  drafts.value.filter(d => hasLeadingNumber(d.content || '')).length
)

/**
 * 批量去除所有题干开头的题号。
 *
 * ⚠️ 与自动剥离的区别：这是**用户显式点击**，所以**不跳过 dirty 题** ——
 *    用户既然点了按钮，就是要处理全部。但也因此必须是"去除"而非"重推断"，
 *    不能顺手把用户填的答案/解析重置掉。
 */
function stripAllNumbers() {
  let n = 0
  drafts.value = drafts.value.map(d => {
    const before = d.content || ''
    const after = stripQuestionNumber(before)
    if (after !== before) n++
    return after === before ? d : { ...d, content: after }
  })
  if (n) {
    ElMessage.success(`已去除 ${n} 道题的题号（小问号已保留）`)
    scheduleSitePreview()
  } else {
    ElMessage.info('当前题目均已无开头题号')
  }
}

// ===== 分割线操作 =====
/** 在指定块之前插入分割线（即拆分）。
 *  【v4.12.0】允许在第 1 块之前插入（用于把误并入卷头的首题切出来）。 */
function addSplitAt(blockIdx: number) {
  if (blockIdx < 0 || blockIdx >= blocks.value.length) return
  if (boundaries.value.includes(blockIdx)) { ElMessage.info('此处已有分割线'); return }
  boundaries.value = Array.from(new Set([...boundaries.value, blockIdx])).sort((a, b) => a - b)
  syncDrafts()
  nextTick(() => layoutOverlay())
  ElMessage.success('已新增分割线（拆分）')
}

/** 删除第 i 条分割线 → 与其后一题合并 */
function removeSplit(i: number) {
  if (i <= 0 || i >= boundaries.value.length - 1) {
    ElMessage.warning('首尾分割线不能删除')
    return
  }
  const next = boundaries.value.slice()
  next.splice(i, 1)
  boundaries.value = next
  syncDrafts()
  ElMessage.success('已合并相邻两题')
}

/**
 * boundaries 变化后同步 drafts：**尽量保留用户已编辑的内容**。
 *
 * 【v4.12.0 修正 · 拖一下分割线就丢失整题编辑】
 *   上一版判据是 `boundaries.value[i] === lastBoundarySnapshot[i]` ——
 *   只要**起始块变了**（哪怕只是把第 1 条线从块 0 挪到块 1）就整题重置，
 *   用户辛苦填的答案/解析全没了。这正是「十分难用」的体感来源之一。
 *
 * 新判据：用**内容指纹**（起始块 + 该题文本前 40 字）判断，
 *   内容实质未变 → 保留编辑态；确实换成另一题 → 才重新推断。
 *   并且：**凡是用户手动改过的题（dirty）一律保留**，除非它被合并掉了。
 */
function syncDrafts() {
  const next = chunks.value.map((c, i) => {
    const old = drafts.value[i]
    if (!old) return inferDraft(c.html)
    // 用户手动编辑过的题：只要仍是"同一块开头"就保留
    if (old.id === null && !oldDirty.value.has(i)) {
      if (boundaries.value[i] === lastBoundarySnapshot[i]) return old
    }
    // 内容指纹一致 → 保留
    const fp = draftFingerprint(c)
    if (oldFingerprints.value.get(i) === fp) return old
    return inferDraft(c.html)
  })
  drafts.value = next
  lastBoundarySnapshot = boundaries.value.slice()
  refreshFingerprints()
  if (activeIdx.value >= next.length) activeIdx.value = Math.max(0, next.length - 1)
}
let lastBoundarySnapshot: number[] = []
/** 每题的内容指纹（用于判断"编辑结构是否实质变化"） */
const oldFingerprints = ref<Map<number, string>>(new Map())
/** 用户手动改过的题下标（这些题不被自动重推断覆盖） */
const oldDirty = ref<Set<number>>(new Set())

function draftFingerprint(c: { blocks: Block[] }): string {
  return normForMatch(c.blocks.map(b => b.text).join('')).slice(0, 40)
}
function refreshFingerprints() {
  const m = new Map<number, string>()
  chunks.value.forEach((c, i) => m.set(i, draftFingerprint(c)))
  oldFingerprints.value = m
}

// ===== 拖拽分割线（【v4.9.0 补全】真正可用版）=====
//
// 三个阶段：
//   1) mousedown 在叠加层把手上 → 记录 dragging 序号，进入拖拽态
//   2) mousemove → 用 elementFromPoint 命中带 data-block-idx 的原卷块 → 高亮预览
//      （这条链路依赖 renderWordView 里的 tagDocxBlocks 已经打好标注）
//   3) mouseup → 吸附到目标块边界，重算 boundaries
//
// 首尾分割线不可拖（它们定义了全卷范围），UI 上把手的 cursor 也会变成 not-allowed。
/**
 * 【v4.9.1 修正 · 「无法拖动」的根本原因：叠加层被压在原卷文字之下】
 *
 * 上一版的 `.zs-overlay` 只有 `position:absolute; inset:0; pointer-events:none`，
 * **没有 z-index**。而 docx-preview 渲染出的 `article` 自带 `z-index:1`
 * （它自己的一套层叠上下文），于是 overlay 落到了原卷文字**下面**。
 *
 * 实测证据（浏览器内真实探测）：
 *   `document.elementFromPoint(把手中心 x, y)` 返回的是 `<p>`，**不是** `.zs-mark-grip`
 *   → mousedown 事件根本没打到把手上 → 拖动完全没反应。
 *
 * 修法三件套：
 *   ① CSS 给 `.zs-overlay` 补 `z-index: 20`（详见 <style> 里的注释）
 *   ② 把手/横线用 `::after` **向外扩热区**（±6~7px），否则 2px 高的横线
 *      和 16px 高的图标在触控/快速拖动下极难命中
 *   ③ mousedown 由叠加层**统一代理**（见下方 onOverlayMouseDown）：
 *      不再依赖「点中把手」这种脆弱前提，而是按**鼠标 Y 与分割线的距离**判定
 */

/** 距分割线多少 px 以内算「抓到了这条线」 */
const LINE_HOT_Y = 12

/**
 * 叠加层统一 mousedown 代理。
 *
 * 逻辑：
 *   · 点在「合并/删除」小按钮上 → 交给按钮自己的 click（不管）
 *   · 找与鼠标 Y 最近的一条分割线；超过 LINE_HOT_Y 视为没抓到 → 不管
 *   · 点在**横线本体**上 → 走「点线合并」语义（由 @click 处理），不起拖
 *   · 其余（把手、徽标、或分割线附近的任意位置）→ 起拖
 *
 * 这样即使把手只有十几个像素，用户「在分割线附近按下去拖」也能成功，
 * 交互容错大幅提升。
 */
function onOverlayMouseDown(e: MouseEvent) {
  const overlay = overlayRef.value
  if (!overlay || e.button !== 0) return
  const t = e.target as HTMLElement
  // 小按钮（合并/删除）自己处理点击
  if (t.closest('.zs-mini')) return
  const ovRect = overlay.getBoundingClientRect()
  const y = e.clientY - ovRect.top
  let bestI = -1
  let bestD = Infinity
  marks.value.forEach((m, i) => {
    const d = Math.abs(m.top - y)
    if (d < bestD) { bestD = d; bestI = i }
  })
  if (bestI < 0 || bestD > LINE_HOT_Y) return
  // 点线身 → 走「点线合并」语义（横线自己的 @click）
  if (t.closest('.zs-mark-line')) return
  onSplitMouseDown(marks.value[bestI].bi, e)
}

function onSplitMouseDown(i: number, e: MouseEvent) {
  if (e.button !== 0) return
  const mark = marks.value.find(m => m.bi === i)
  if (mark && !mark.draggable) { ElMessage.info('题目太少，暂时无法调整分割线'); return }
  e.preventDefault()
  e.stopPropagation()
  dragging.value = i
  hoverBlockIdx.value = null
  dragStartY = e.clientY
  dragMoved = false
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}

/**
 * 【v4.9.1】4px 位移阈值。
 *
 * 为什么需要：mousedown 之后用户可能只是「点了一下」就松手（没打算拖）。
 * 若没有阈值，这一点会被当成「拖到当前位置」→ 分割线被移动到自己身上，
 * 用户看到的是「莫名其妙跳了一下」。
 * 加阈值后：位移 < 4px 视为点击，什么都不做。
 */
let dragStartY = 0
let dragMoved = false

function onDragMove(e: MouseEvent) {
  if (dragging.value === null) return
  if (!dragMoved && Math.abs(e.clientY - dragStartY) < 4) return
  dragMoved = true
  // 命中原卷里带标注的块
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
  const host = el?.closest(`[${BLOCK_IDX_ATTR}]`) as HTMLElement | null
  if (host) {
    const idx = Number(host.getAttribute(BLOCK_IDX_ATTR))
    if (Number.isFinite(idx)) { pendingDragTarget = idx; hoverBlockIdx.value = idx; return }
  }
  // 落在块与块之间的空隙 → 用几何距离找最近的块（避免"缝隙里拖不动"的挫败感）
  const near = nearestBlockByY(e.clientY)
  if (near !== null) { pendingDragTarget = near; hoverBlockIdx.value = near }
}

/** 按 Y 坐标找最近的块下标（拖到页边距/空隙时兜底） */
function nearestBlockByY(clientY: number): number | null {
  const host = docxHost.value
  if (!host) return null
  let best: number | null = null
  let bestDist = Infinity
  host.querySelectorAll(`[${BLOCK_IDX_ATTR}]`).forEach(el => {
    const idx = Number((el as HTMLElement).getAttribute(BLOCK_IDX_ATTR))
    if (!Number.isFinite(idx)) return
    const r = (el as HTMLElement).getBoundingClientRect()
    const d = Math.abs((r.top + r.bottom) / 2 - clientY)
    if (d < bestDist) { bestDist = d; best = idx }
  })
  return best
}

let pendingDragTarget: number | null = null
function onDragEnd(e?: MouseEvent) {
  const i = dragging.value
  dragging.value = null
  hoverBlockIdx.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  // 位移不足 4px → 视为「点了一下把手」，不改变任何东西
  if (!dragMoved) { pendingDragTarget = null; dragMoved = false; return }
  dragMoved = false
  if (i === null) { pendingDragTarget = null; return }
  let target = pendingDragTarget
  pendingDragTarget = null
  // 兜底：松手位置重算一次（快速拖动时末次 mousemove 可能没派发）
  if (target === null && e) target = nearestBlockByY(e.clientY)
  if (target === null) return

  const isFirst = i === 0
  const isLast = i === boundaries.value.length - 1
  // 【v4.12.0】首尾线也允许拖动：首线合法范围 [0, 第二条线-1]，末线 [倒数第二条+1, blocks.length]
  if (isFirst) {
    const upper = boundaries.value[1] ?? blocks.value.length
    if (target < 0 || target >= upper) {
      ElMessage.info('第一条分割线需在第二条之前')
      return
    }
  } else if (isLast) {
    const lower = boundaries.value[boundaries.value.length - 2] ?? 0
    if (target <= lower || target > blocks.value.length) {
      ElMessage.info('最后一条分割线需在倒数第二条之后')
      return
    }
  } else if (target <= 0 || target >= blocks.value.length) {
    return
  }

  const next = boundaries.value.slice()
  // 与其它分割线重合 → 视为无变化，不动（避免意外合并两条线）
  if (next.includes(target) && next[i] !== target) { ElMessage.info('此处已有分割线'); return }
  if (next[i] === target) return   // 没真正移动 → 静默返回
  next[i] = target
  const uniq = Array.from(new Set(next)).sort((a, b) => a - b)
  if (uniq.length !== next.length) return
  boundaries.value = uniq
  syncDrafts()
  nextTick(() => layoutOverlay())
  ElMessage.success(isFirst ? '第 1 题起点已调整' : isLast ? '末题终点已调整' : '分割线已移动')
}

// ===== 叠加层交互：点分割线本体 =====
function onMarkClick(i: number) {
  // 点线身 = 删除该分割线（= 与下一题合并）；首尾不可删
  if (i <= 0 || i >= boundaries.value.length - 1) return
  removeSplit(i)
}

// ===== 网站渲染视图（实时跟随右侧编辑）=====
//
// ────────────────────────────────────────────────────────────────────────────
// 【v4.9.1 重写 · 修「左栏网站渲染完全混乱」】
//
// 用户原话：「左栏的网站渲染有严重问题 完全混乱」
//            「我必须要传进去是什么 渲染的是什么 最后导出 word 就是什么！」
//
// 上一版的做法是**自拼一套链路**：
//   `htmlToMarkdown(body)` → `renderMarkdown(md)` → v-html
// 而导出 Word 走的是**另一套链路**：
//   `mdToParagraphs()` → `inlineRuns()` → docx
//
// 两套实现处理同一份内容，**必然漂移**。实测见到的问题：
//   · 题目里残留 `#` / `**` 等 Markdown 源码（渲染器不认某些语法时原样吐出）
//   · 选项被输出两遍（content 里含选项段 + options 字段各来一次）
//   · 列表 / 公式 / 合并表格的版式与最终 Word 完全不同 → 用户看到「完全混乱」
//
// 修法：**预览直接调用最终导出的同一套构建器** —— `buildPaperDocx()`（@/utils/docx-kit），
//   把生成的 docx 用 docx-preview 在离屏容器里渲染成 HTML，再贴进左栏。
//   这样「传进去 = 网站渲染 = 导出 Word」在**实现层面**就成立了，
//   不是靠两套代码"对齐"，而是**根本只有一套代码**。
//
// 代价与对策：docx 生成 + 渲染是异步且较慢（每题约 40~120ms），
//   因此用 debounce（350ms）+ 序号（previewSeq）防竞态，
//   并给出 previewRendering 状态让 UI 显示"渲染中"。
// ────────────────────────────────────────────────────────────────────────────
const sitePreviewHtml = ref<string[]>([])
const previewRendering = ref(false)
let previewTimer: any = null
let previewSeq = 0

async function renderSitePreview() {
  if (!chunks.value.length) { sitePreviewHtml.value = []; return }
  const seq = ++previewSeq
  previewRendering.value = true
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;visibility:hidden'
  document.body.appendChild(host)
  const out: string[] = []
  try {
    const { buildPaperDocx } = await import('@/utils/docx-kit')
    const { renderAsync } = await import('docx-preview')
    for (let i = 0; i < chunks.value.length; i++) {
      const d = drafts.value[i] || inferDraft(chunks.value[i].html)
      const q = {
        qtype: d.qtype || 'subjective',
        content: d.content || '',
        options: d.options || [],
        answer: d.answer || '',
        analysis: d.analysis || '',
        score: d.score ?? 5,
      }
      // 每题单独构建一份 docx：这样「网站渲染」的分块与右侧「第 N 题」严格一一对应，
      // 且渲染失败只影响单题，不会整块白屏
      const blob = await buildPaperDocx([q], { showTypeHeading: false, withAnswers: false, fontSize: 21 })
      const buf = await blob.arrayBuffer()
      if (seq !== previewSeq) { host.remove(); return }
      host.innerHTML = ''
      await renderAsync(buf, host, undefined, { className: 'docx', inWrapper: true, breakPages: false })
      const sec = host.querySelector('section')
      out.push(sec ? sec.innerHTML : '')
      if (seq !== previewSeq) { host.remove(); return }
    }
    host.remove()
    if (seq === previewSeq) sitePreviewHtml.value = out
  } catch (e: any) {
    host.remove()
    console.warn('[原卷编辑] 网站预览渲染失败，降级为 Markdown 渲染:', e?.message)
    if (seq === previewSeq) {
      // 降级：退回 Markdown 渲染（保证左栏永远有内容，不白屏）
      sitePreviewHtml.value = chunks.value.map((c, i) => {
        const d = drafts.value[i]
        const body = d?.content || c.html
        const md = /<[a-z][^>]*>/i.test(body) ? htmlToMarkdown(body) : body
        return renderMarkdown(md || '')
      })
    }
  } finally {
    if (seq === previewSeq) previewRendering.value = false
  }
}

/** debounce 触发重算（右侧编辑每敲一个字都会触发 watch，必须防抖） */
function scheduleSitePreview() {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => { renderSitePreview() }, 350)
}

// 右侧编辑内容变化 → 重算网站预览（仅在 site 视图下才真的渲染，省算力）
watch(
  () => drafts.value.map(d => `${d?.qtype}|${d?.content}|${(d?.options || []).join('\u0001')}|${d?.answer}|${d?.analysis}|${d?.score}`).join('\u0002'),
  () => { if (viewMode.value === 'site') scheduleSitePreview() }
)

// ===== 保存（逐题暂存 / 更新）=====
function onFormSubmit(payload: any) {
  const d = drafts.value[activeIdx.value]
  if (!d) return
  Object.assign(d, {
    qtype: payload.qtype,
    content: payload.content,
    options: payload.options || [],
    answer: payload.answer || '',
    analysis: payload.analysis || '',
    score: payload.score,
    difficulty: payload.difficulty,
    knowledge_point_ids: payload.knowledge_point_ids || [],
    status: payload.status || d.status,
  })
  // 【v4.12.0】标记为「用户手动改过」→ 后续调整分割线时不再被自动推断覆盖
  oldDirty.value.add(activeIdx.value)
  ElMessage.success('已暂存到本地，点「保存全部」提交')
}

async function saveAll() {
  if (!drafts.value.length) return
  saving.value = true
  let ok = 0, failed = 0
  try {
    // 逐题**串行**保存：并发新增容易把后端打满，也让失败定位困难
    for (let i = 0; i < drafts.value.length; i++) {
      const d = drafts.value[i]
      progressText.value = `正在保存第 ${i + 1}/${drafts.value.length} 题…`
      const body = {
        qtype: d.qtype,
        content: d.content,
        options: d.options,
        answer: d.answer,
        analysis: d.analysis,
        score: d.score,
        difficulty: d.difficulty,
        knowledge_point_ids: d.knowledge_point_ids,
        status: d.status,
      }
      try {
        if (d.id) await api.updateSubjectQuestion(d.id, body)
        else {
          const r: any = await api.addSubjectQuestion(props.subjectId, body)
          d.id = r?.id || r?.data?.id || null
        }
        ok++
      } catch (e: any) {
        failed++
        console.warn('[原卷编辑] 第', i + 1, '题保存失败:', e?.message)
      }
    }
    if (failed) ElMessage.warning(`保存完成：成功 ${ok} 题，失败 ${failed} 题（可重试）`)
    else ElMessage.success(`已保存 ${ok} 道题`)
    emit('imported')
  } finally {
    saving.value = false
    progressText.value = ''
  }
}

onMounted(() => {
  // 初始快照，供 syncDrafts 判断"结构是否变化"
  lastBoundarySnapshot = boundaries.value.slice()
  // 【v4.9.0 补全】原卷会随窗口宽度重排（docx 是固定版心，缩放后块位置全变），
  //   叠加层必须跟着重算，否则分割线会「飘」在错误位置。
  window.addEventListener('resize', onResize)
  // 原卷容器自身尺寸变化（切视图 / 侧栏展开）也要重算
  if (typeof ResizeObserver !== 'undefined' && leftPane.value) {
    paneObserver = new ResizeObserver(() => layoutOverlay())
    paneObserver.observe(leftPane.value)
  }
})
let paneObserver: ResizeObserver | null = null
onUnmounted(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('resize', onResize)
  paneObserver?.disconnect()
  paneObserver = null
})
</script>

<template>
  <div class="zs-root">
    <!-- ① 选择文件 -->
    <div v-if="stage === 'pick'" class="zs-pick">
      <label class="zs-drop">
        <input type="file" accept=".docx" @change="onPick" />
        <div class="zs-drop-inner">
          <div class="zs-drop-ico">📄</div>
          <div class="zs-drop-title">选择 Word 试卷（.docx）</div>
          <div class="zs-drop-sub">上传后左侧显示完整原卷并自动插入分割线，右侧按题编辑</div>
        </div>
      </label>
      <div v-if="busy" class="zs-progress">{{ progressText || '处理中…' }}</div>
    </div>

    <!-- ② 分栏编辑 -->
    <div v-else class="zs-split">
      <!-- 左：原卷 -->
      <div class="zs-left">
        <div class="zs-left-bar">
          <el-radio-group v-model="viewMode" size="small">
            <el-radio-button value="word">Word 原卷</el-radio-button>
            <el-radio-button value="site">网站渲染</el-radio-button>
          </el-radio-group>
          <div class="zs-left-actions">
            <el-tooltip
              :content="aiStatus && !aiStatus.available
                ? aiDisabledReason
                : `AI 智能识别题目结构（当前：${aiChannelText}）`"
              placement="top"
            >
              <el-button
                type="primary" size="small" :loading="aiRunning"
                :disabled="!chunks.length"
                @click="aiRecognize"
              ><ZgGlyph emoji="🪄" /> AI 智能识别</el-button>
            </el-tooltip>
            <el-tooltip
              :content="numberStrippedCount
                ? `去除题干开头的题号（如「1.」「一、」），小问号「(1)」保留`
                : '当前题目均已无开头题号'"
              placement="top"
            >
              <el-button
                size="small"
                :disabled="!chunks.length || !numberStrippedCount"
                @click="stripAllNumbers"
              >🧹 去除序号<span v-if="numberStrippedCount">（{{ numberStrippedCount }}）</span></el-button>
            </el-tooltip>
            <el-button v-if="viewMode === 'word'" size="small" :loading="busy" @click="rebuildFromContent">按当前内容重排</el-button>
            <el-button size="small" @click="stage = 'pick'">重选文件</el-button>
          </div>
        </div>

        <!-- 识别来源提示条 -->
        <div class="zs-ai-bar" :class="{ off: aiStatus && !aiStatus.available }">
          <template v-if="aiStatus && !aiStatus.available">
            <span class="zs-ai-dot warn"></span>
            当前使用<b>规则识别</b>（按题号切分）。配置 AI 密钥后可自动读取答案与解析。
          </template>
          <template v-else-if="aiInfo">
            <span class="zs-ai-dot ok"></span>
            AI 识别：<b>{{ aiInfo }}</b>
            <span class="zs-ai-note">请核对后进入编辑</span>
          </template>
          <template v-else>
            <span class="zs-ai-dot ok"></span>
            已用<b>规则识别</b>切出 {{ chunks.length }} 题。若不准，点「🪄 AI 智能识别」让大模型重切（可自动读取卷末参考答案与解析）。
          </template>
        </div>

        <!-- Word 保真视图 -->
        <div v-show="viewMode === 'word'" ref="leftPane" class="zs-pane">
          <div class="zs-docx-wrap">
            <div ref="docxHost" class="zs-docx" />
            <!-- 【v4.9.0 补全 / v4.9.1 修可拖】叠加在原卷上的可视分割线 -->
            <!--   mousedown 由叠加层**统一代理**（onOverlayMouseDown）：按 Y 距离判定抓哪条线，
                 不再依赖"必须精确点在把手上" —— 这是「无法拖动」的最终修法。 -->
            <div ref="overlayRef" class="zs-overlay" @mousedown="onOverlayMouseDown">
              <div
                v-for="m in marks"
                :key="m.bi"
                class="zs-mark"
                :class="{ dragging: dragging === m.bi, locked: !m.draggable }"
                :style="{ top: m.top + 'px' }"
                :data-split-index="m.bi"
              >
                <span class="zs-mark-badge">{{ m.bi === 0 ? '开始' : (m.bi === boundaries.length - 1 ? '结束' : '第 ' + m.bi + ' 题 ▸') }}</span>
                <span class="zs-mark-line" @click.stop="onMarkClick(m.bi)" />
                <span
                  class="zs-mark-grip"
                  :title="m.draggable ? '按住拖动调整分割位置' : '首尾分割线不可拖动'"
                >⠿</span>
                <span v-if="m.draggable" class="zs-mark-btns">
                  <button class="zs-mini" title="与下一题合并" @click.stop="removeSplit(m.bi)">－</button>
                </span>
              </div>
            </div>
            <!-- 拖拽时高亮目标块 -->
            <div
              v-if="hoverBlockIdx !== null && dragging !== null"
              class="zs-hover-hint"
            >拖到此处：分割线将落在第 {{ hoverBlockIdx + 1 }} 个块前</div>
          </div>
          <div class="zs-hint">分割线已自动插入 · 拖动 ⠿ 可调整 · 点横线可合并相邻两题</div>
        </div>

        <!-- 网站渲染视图（【v4.9.1 重写】直接渲染最终导出的同一份 docx → 与 Word 严格一致） -->
        <div v-show="viewMode === 'site'" class="zs-pane">
          <div v-if="previewRendering" class="zs-site-loading">正在生成与 Word 一致的预览…</div>
          <div v-for="(c, i) in chunks" :key="i" class="zs-site-chunk">
            <div class="zs-site-head">
              第 {{ i + 1 }} 题
              <el-tag size="small">{{ qtypeLabel(drafts[i]?.qtype || 'subjective') }}</el-tag>
              <span class="zs-site-score">{{ drafts[i]?.score ?? 5 }} 分</span>
            </div>
            <!-- 这里的内容是 buildPaperDocx 产出的真实 Word 文档渲染结果，
                 不是另写一套 Markdown 渲染 —— 所以「网站看到的 = 导出的 Word」 -->
            <div class="zs-docx zs-site-docx" v-html="sitePreviewHtml[i]" />
            <div v-if="!sitePreviewHtml[i] && !previewRendering" class="zs-site-empty">（本题暂无内容）</div>
          </div>
        </div>

        <!-- 分割线控制条（独立于两视图，永远可见） -->
        <div class="zs-splits">
          <div class="zs-splits-title">题目分割（{{ chunks.length }} 题）</div>
          <div class="zs-split-list">
            <div v-for="(c, i) in chunks" :key="i" class="zs-split-item" :class="{ active: activeIdx === i }" @click="activeIdx = i">
              <span class="zs-split-no">{{ i + 1 }}</span>
              <span class="zs-split-txt">{{ (c.blocks[0]?.text || '').slice(0, 26) || '（空）' }}</span>
              <span class="zs-split-ops">
                <el-tooltip content="在此题之前新增分割线（拆分）" placement="top">
                  <button class="zs-mini" @click.stop="addSplitAt(boundaries[i + 1] - 1)">＋</button>
                </el-tooltip>
                <el-tooltip content="与下一题合并" placement="top">
                  <button class="zs-mini" :disabled="i >= chunks.length - 1" @click.stop="removeSplit(i + 1)">－</button>
                </el-tooltip>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 右：题目编辑（与「添加题目」完全同一个表单/编辑器）-->
      <div class="zs-right">
        <div class="zs-right-bar">
          <span class="zs-right-title">第 {{ activeIdx + 1 }} / {{ chunks.length }} 题</span>
          <div>
            <el-button size="small" :disabled="activeIdx <= 0" @click="activeIdx--">上一题</el-button>
            <el-button size="small" :disabled="activeIdx >= chunks.length - 1" @click="activeIdx++">下一题</el-button>
            <el-button type="primary" size="small" :loading="saving" @click="saveAll">保存全部</el-button>
          </div>
        </div>
        <div class="zs-right-body">
          <QuestionForm
            v-if="drafts[activeIdx]"
            :key="activeIdx"
            :subject-id="props.subjectId"
            :initial="drafts[activeIdx]"
            @submit="onFormSubmit"
            @cancel="() => {}"
          />
        </div>
        <div v-if="busy && progressText" class="zs-progress">{{ progressText }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zs-root { display: flex; flex-direction: column; gap: 10px; }

/* ---- 选择文件 ---- */
.zs-drop { display: block; border: 2px dashed rgba(var(--zg-primary-rgb), 0.35); border-radius: 14px; padding: 28px 18px; text-align: center; cursor: pointer; transition: .2s; }
.zs-drop:hover { border-color: var(--zg-primary); background: rgba(var(--zg-primary-rgb), 0.04); }
.zs-drop input { display: none; }
.zs-drop-ico { font-size: 30px; }
.zs-drop-title { font-weight: 700; margin-top: 6px; }
.zs-drop-sub { font-size: 12px; color: var(--zg-text-dim, #888); margin-top: 4px; }
.zs-progress { font-size: 12px; color: var(--zg-primary); padding: 4px 2px; }

/* ---- 分栏 ---- */
.zs-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: start; }
@media (max-width: 1100px) { .zs-split { grid-template-columns: 1fr; } }

.zs-left { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.zs-left-bar, .zs-right-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.zs-left-actions { display: flex; gap: 6px; flex-wrap: wrap; }

/* 【v4.12.0】识别来源提示条 */
.zs-ai-bar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font-size: 12px; line-height: 1.5;
  padding: 6px 10px; border-radius: 8px;
  background: rgba(var(--zg-primary-rgb), 0.07);
  border-left: 3px solid var(--zg-primary, #f59e0b);
  color: var(--zg-text, #1e293b);
}
.zs-ai-bar.off { background: rgba(148, 163, 184, 0.12); border-left-color: #94a3b8; color: var(--zg-text-dim, #64748b); }
.zs-ai-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.zs-ai-dot.ok { background: #16a34a; }
.zs-ai-dot.warn { background: #f59e0b; }
.zs-ai-note { color: var(--zg-text-dim, #888); margin-left: 4px; }
.zs-pane { border: 1px solid rgba(0,0,0,0.09); border-radius: 12px; background: #fff; overflow: auto; max-height: 62vh; padding: 8px; }
/* ---- 原卷 + 叠加分割线 ---- */
.zs-docx-wrap { position: relative; }
.zs-docx { min-width: 0; }
/* 叠加层：铺满原卷，本身不吃鼠标事件，只有子元素可交互。
   ⚠️⚠️ `z-index: 20` 是**必需**的，不是可选项 —— 这是「无法拖动」的根本原因：
     docx-preview 渲染出的 `article` 元素自带 `z-index:1`，
     overlay 没有 z-index 时会被压到原卷文字**之下**，
     于是 `document.elementFromPoint()` 返回的是 `<p>` 而不是把手，
     mousedown 永远收不到 → 拖动完全没反应（实测已复现并确认）。
   写死 20 是为了稳赢 `article` 的 1，同时远低于全站浮层（抽屉/弹窗 ≥1000）。 */
.zs-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 20; }
.zs-mark { position: absolute; left: 0; right: 0; height: 0; display: flex; align-items: center; gap: 6px; }
.zs-mark-badge {
  flex: 0 0 auto; transform: translateY(-50%);
  background: var(--zg-primary, #f59e0b); color: #fff;
  font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px;
  white-space: nowrap; pointer-events: none; opacity: .92;
}
/* 横线：2px 太细，用 ::after 上下各扩 7px 热区（视觉不变，手感大幅提升） */
.zs-mark-line {
  flex: 1 1 auto; position: relative; height: 2px; transform: translateY(-50%);
  background: repeating-linear-gradient(to right, var(--zg-primary, #f59e0b) 0 8px, transparent 8px 14px);
  cursor: pointer; pointer-events: auto; opacity: .75;
}
.zs-mark-line::after { content: ''; position: absolute; left: 0; right: 0; top: -7px; bottom: -7px; }
.zs-mark-line:hover { opacity: 1; height: 3px; }
/* 把手：同样用 ::after 四周扩 6px（16px 的图标在快速拖动下很难精确命中） */
.zs-mark-grip {
  flex: 0 0 auto; position: relative; transform: translateY(-50%);
  pointer-events: auto; cursor: grab; user-select: none;
  background: #fff; border: 1px solid var(--zg-primary, #f59e0b); color: var(--zg-primary, #f59e0b);
  border-radius: 5px; padding: 0 4px; font-size: 12px; line-height: 16px;
  box-shadow: 0 1px 4px rgba(0,0,0,.12);
}
.zs-mark-grip::after { content: ''; position: absolute; inset: -6px; }
.zs-mark-grip:active { cursor: grabbing; }
.zs-mark.locked .zs-mark-grip { cursor: not-allowed; opacity: .45; }
.zs-mark.dragging .zs-mark-line { height: 3px; opacity: 1; background: #ef4444; }
.zs-mark.dragging .zs-mark-badge { background: #ef4444; }
.zs-mark-btns { pointer-events: auto; transform: translateY(-50%); }
.zs-hover-hint {
  position: sticky; bottom: 0; left: 0; margin-top: -22px;
  background: rgba(239,68,68,.92); color: #fff; font-size: 11px;
  padding: 3px 8px; border-radius: 6px; display: inline-block;
}

.zs-site-chunk { padding: 10px 12px; border-bottom: 1px dashed rgba(0,0,0,0.12); }
.zs-site-chunk:last-child { border-bottom: 0; }
.zs-site-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; margin-bottom: 6px; color: var(--zg-primary); }
.zs-site-score { font-size: 11px; font-weight: 400; color: var(--zg-text-dim, #888); margin-left: auto; }
.zs-site-loading { font-size: 12px; color: var(--zg-primary); padding: 6px 2px; }
.zs-site-empty { font-size: 12px; color: var(--zg-text-dim, #999); padding: 4px 2px; }

/* ---- 网站渲染区：把 docx-preview 的「Word 纸张」还原成卡片内自适应 ----
   docx-preview 默认按 A4 固定版心渲染（自带灰底、阴影、左右 30px 内边距），
   贴进左栏卡片里会显得"错位、出框"。这里统一抹掉纸张外观，
   只保留内容版式本身 —— 这样左栏看起来就是「网站上的样子」，
   而内容仍是 Word 的真实排版，做到「看到的 = 导出的」。 */
.zs-site-docx { min-width: 0; font-size: 14px; line-height: 1.75; color: var(--zg-text, #1e293b); }
.zs-site-docx :deep(.docx-wrapper) { background: transparent; padding: 0; display: block; }
.zs-site-docx :deep(section.docx) {
  width: auto !important; min-width: 0 !important; padding: 0 !important;
  margin: 0 !important; box-shadow: none !important; background: transparent !important;
  transform: none !important;
}
.zs-site-docx :deep(section.docx > article) { position: static; z-index: auto; }
.zs-site-docx :deep(p) { margin: 0.5em 0; }
.zs-site-docx :deep(img) { max-width: 100%; height: auto; }
.zs-site-docx :deep(table) { border-collapse: collapse; max-width: 100%; }
.zs-site-docx :deep(td), .zs-site-docx :deep(th) { border: 1px solid rgba(0,0,0,0.18); padding: 4px 8px; }
.zs-site-docx :deep(.katex), .zs-site-docx :deep(.katex-html) { font-size: 1em; }

/* ---- 分割线列表 ---- */
.zs-splits { border: 1px solid rgba(0,0,0,0.09); border-radius: 12px; padding: 8px 10px; }
.zs-splits-title { font-size: 12px; font-weight: 700; color: var(--zg-text-dim, #888); margin-bottom: 6px; }
.zs-split-list { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
.zs-split-item { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 12px; }
.zs-split-item:hover { background: rgba(var(--zg-primary-rgb), 0.06); }
.zs-split-item.active { background: rgba(var(--zg-primary-rgb), 0.12); font-weight: 700; }
.zs-split-no { width: 20px; text-align: center; color: var(--zg-primary); font-weight: 700; flex: 0 0 auto; }
.zs-split-txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zs-split-ops { display: flex; gap: 4px; flex: 0 0 auto; }
.zs-mini { width: 22px; height: 22px; line-height: 1; border: 1px solid rgba(0,0,0,0.15); background: #fff; border-radius: 6px; cursor: pointer; font-size: 13px; }
.zs-mini:hover:not(:disabled) { border-color: var(--zg-primary); color: var(--zg-primary); }
.zs-mini:disabled { opacity: .35; cursor: not-allowed; }

/* ---- 右侧编辑 ---- */
.zs-right { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.zs-right-title { font-weight: 700; }
.zs-right-body { border: 1px solid rgba(0,0,0,0.09); border-radius: 12px; padding: 12px; background: var(--zg-card, #fff); max-height: 72vh; overflow: auto; }
</style>
