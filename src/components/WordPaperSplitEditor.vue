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
    content: stripOptionsFromHtml(html),
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

/** 把 Word 的 HTML 按顶层块级元素切成 blocks（保留表格/图片原样） */
function splitIntoBlocks(html: string): Block[] {
  if (typeof document === 'undefined') return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: Block[] = []
  Array.from(doc.body.childNodes).forEach(n => {
    if (n.nodeType !== 1) {
      const t = (n.textContent || '').trim()
      if (t) out.push({ html: escapeHtml(t), text: t })
      return
    }
    const el = n as HTMLElement
    const tag = el.tagName.toLowerCase()
    // 表格/图片单独成块（不可再拆 —— 拆了就破坏结构）
    if (tag === 'table' || el.querySelector('table')) {
      out.push({ html: el.outerHTML, text: toText(el.outerHTML) })
      return
    }
    const t = toText(el.outerHTML)
    if (!t && !el.querySelector('img')) return
    out.push({ html: el.outerHTML, text: t })
  })
  return out
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 自动插入分割线。
 * 判据（与 WordImportPanel 的两级题号一致，避免两套逻辑打架）：
 *   · 一级题号「一、」「第Ⅰ部分」→ 该块**之前**分割（大题起点）
 *   · 二级题号「1.」「(1)」       → 该块**之前**分割（小题起点）
 *   · 都没有 → 整篇作为 1 题（不硬拆，交给用户手动加分割线）
 */
const MAJOR_RE = /^\s*(?:[一二三四五六七八九十百]+[、.]|第\s*[一二三四五六七八九十\d]+\s*[部分卷]|[（(][一二三四五六七八九十]+[)）]|【[一二三四五六七八九十]+】)/
const MINOR_RE = /^\s*(?:\d+\s*[.、)）]|[（(]\s*\d+\s*[)）])/

function autoSplit(bs: Block[]): number[] {
  const cuts: number[] = []
  bs.forEach((b, i) => {
    const line = (b.text.split('\n')[0] || '').trim()
    if (MINOR_RE.test(line) && i > 0) cuts.push(i)
  })
  if (!cuts.length) return [0, bs.length]
  const uniqCuts = Array.from(new Set(cuts)).sort((a, b) => a - b)
  // ──────────────────────────────────────────────────────────────────────────
  // 【v4.9.1 修正 · 卷头不能混进第 1 题】
  //
  // 上一版返回的是 `[0, ...cuts, bs.length]` —— 也就是**第 0 块永远是一道题**。
  // 但试卷的第 0 块通常是**卷头**（标题 / 考试说明 / 姓名班级栏），
  // 它根本没写题号，于是被凭空当成「第 1 题」，把真正的第 1 题挤成了第 2 题。
  //
  // 实测证据：某物理卷 → 识别出「1.（主观题）(5分) 物理试卷」，即卷头成了第 1 题。
  //
  // 修法：以**第一个切点**作为第 1 题的起点；第 1 个切点之前的块全部算卷头，
  //       不生成题目（用户仍可通过「＋」按钮在任意位置手动加分割线）。
  // ──────────────────────────────────────────────────────────────────────────
  const start = uniqCuts[0]
  const list = [start, ...uniqCuts.filter(c => c > start), bs.length]
  return Array.from(new Set(list)).sort((x, y) => x - y)
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

/** 归一化文本（与原卷比对用）：去标签、去空白、去常见标点 */
function normForMatch(s: string): string {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, '')
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

  // ④ 文本前缀配对（保留上一版的稳健策略：校验 → 顺延 → 硬配三级兜底）
  let bi = 0
  let tagged = 0
  for (const el of candidates) {
    if (bi >= blocks.value.length) break
    const target = normForMatch(blocks.value[bi].text).slice(0, 20)
    const here = normForMatch(el.textContent || '').slice(0, 20)
    if (!target) { bi++; continue }
    if (here && (here === target || here.startsWith(target) || target.startsWith(here))) {
      el.setAttribute(BLOCK_IDX_ATTR, String(bi))
      bi++; tagged++
    } else {
      // 文本对不上 → 往后顺延最多 3 个块找一找（容忍块被合并/拆分的轻微差异）
      let found = -1
      for (let k = bi + 1; k < Math.min(bi + 4, blocks.value.length); k++) {
        const t = normForMatch(blocks.value[k].text).slice(0, 20)
        if (t && (here === t || here.startsWith(t) || t.startsWith(here))) { found = k; break }
      }
      if (found > -1) { bi = found; el.setAttribute(BLOCK_IDX_ATTR, String(bi)); bi++; tagged++ }
      else {
        // 兜底：按顺序硬配（保证拖拽链路不整体失效）
        el.setAttribute(BLOCK_IDX_ATTR, String(bi))
        bi++; tagged++
      }
    }
  }
  return tagged
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
  boundaries.value.forEach((blockIdx, i) => {
    // 首条分割线（题目开头）与末条（文档结尾）不可拖，但仍显示
    const el = host.querySelector(`[${BLOCK_IDX_ATTR}="${blockIdx}"]`) as HTMLElement | null
    let top: number
    if (el) {
      top = el.getBoundingClientRect().top - hostRect.top
    } else if (blockIdx >= blocks.value.length) {
      // 末条：贴在最后一个已标注块的下方
      const last = host.querySelector(`[${BLOCK_IDX_ATTR}="${blocks.value.length - 1}"]`) as HTMLElement | null
      top = last ? last.getBoundingClientRect().bottom - hostRect.top : host.scrollHeight
    } else {
      return   // 找不到对应块 → 跳过这一条（不画错的线）
    }
    out.push({ bi: i, blockIdx, top, draggable: i > 0 && i < boundaries.value.length - 1 })
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

// ===== 分割线操作 =====
/** 在原卷第 i 题之前插入分割线（即拆分） */
function addSplitAt(blockIdx: number) {
  if (blockIdx <= 0 || blockIdx >= blocks.value.length) return
  if (boundaries.value.includes(blockIdx)) return
  boundaries.value = Array.from(new Set([...boundaries.value, blockIdx])).sort((a, b) => a - b)
  syncDrafts()
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

/** boundaries 变化后同步 drafts：已有题目沿用旧编辑态，新合并的重新推断 */
function syncDrafts() {
  const next = chunks.value.map((c, i) => {
    const old = drafts.value[i]
    // 结构未变（起始块相同）→ 保留用户已编辑的内容
    if (old && old.id === null && boundaries.value[i] === lastBoundarySnapshot[i]) return old
    return inferDraft(c.html)
  })
  drafts.value = next
  lastBoundarySnapshot = boundaries.value.slice()
  if (activeIdx.value >= next.length) activeIdx.value = Math.max(0, next.length - 1)
}
let lastBoundarySnapshot: number[] = []

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
  if (mark && !mark.draggable) { ElMessage.info('首尾分割线不可拖动（它们定义了整卷范围）'); return }
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
  // 【v4.9.1 兜底】onDragMove 只在「确实移动过」时更新 pendingDragTarget。
  //   若用户在最后一刻移动很快、mousemove 没来得及派发就松手，
  //   用松手位置**重算一次**，避免"拖了却没反应"。
  if (target === null && e) target = nearestBlockByY(e.clientY)
  if (target === null) return
  // 合法区间：不能贴到文档最开头（那是第 1 题起点），也不能越界
  if (target <= 0 || target >= blocks.value.length) return
  const next = boundaries.value.slice()
  // 与其它分割线重合 → 视为无变化，不动（避免把两条线并成一条的意外合并）
  if (next.includes(target) && next[i] !== target) { ElMessage.info('此处已有分割线'); return }
  if (next[i] === target) return   // 没真正移动 → 静默返回，不弹成功提示
  next[i] = target
  const uniq = Array.from(new Set(next)).sort((a, b) => a - b)
  if (uniq.length !== next.length) return
  boundaries.value = uniq
  syncDrafts()
  nextTick(() => layoutOverlay())
  ElMessage.success('分割线已移动')
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
            <el-button v-if="viewMode === 'word'" size="small" :loading="busy" @click="rebuildFromContent">按当前内容重排</el-button>
            <el-button size="small" @click="stage = 'pick'">重选文件</el-button>
          </div>
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
.zs-left-actions { display: flex; gap: 6px; }
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
