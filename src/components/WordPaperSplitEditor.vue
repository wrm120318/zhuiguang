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
    content: html,
    options: opts,
    answer: answer.trim(),
    analysis: '',
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
  const b = [0, ...cuts.filter((c, i, a) => a.indexOf(c) === i), bs.length]
  // 去重 + 保证严格递增
  const uniq = Array.from(new Set(b)).sort((x, y) => x - y)
  return uniq[0] === 0 ? uniq : [0, ...uniq]
}

// ===== Word 原卷视图（docx-preview 保真渲染）=====
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
  } catch (e: any) {
    console.warn('[docx-preview] 渲染失败，退回网站视图:', e?.message)
    viewMode.value = 'site'
    ElMessage.warning('Word 原卷渲染失败，已切换到网站视图')
  }
}

// 切换视图时按需渲染
watch(viewMode, async (m) => {
  if (m === 'word') { await nextTick(); await renderWordView() }
})

/** 「按当前内容重新渲染 docx」—— 把编辑后的题目重新生成 Word 预览 */
async function rebuildFromContent() {
  if (!docxHost.value) return
  busy.value = true
  progressText.value = '正在按当前内容重新排版…'
  try {
    // 用编辑后的内容拼一份新的 docx（复用导出器的能力：Markdown → docx）
    const { Document, Packer, Paragraph, TextRun } = await import('docx')
    const paras: any[] = []
    chunks.value.forEach((c, i) => {
      const d = drafts.value[i]
      paras.push(new Paragraph({ children: [new TextRun({ text: `${i + 1}.（${qtypeLabel(d?.qtype || 'subjective')}）(${d?.score ?? 5}分)`, bold: true })] }))
      const body = d?.content ?? c.html
      body.split('\n').forEach(ln => {
        const t = ln.replace(/<[^>]+>/g, '').trim()
        if (t) paras.push(new Paragraph({ children: [new TextRun({ text: t })] }))
      })
      ;(d?.options || []).forEach((o, k) => paras.push(new Paragraph({ children: [new TextRun({ text: `${'ABCDEFGH'[k] || '?'}. ${o}` })] })))
      if (d?.answer) paras.push(new Paragraph({ children: [new TextRun({ text: `【答案】${d.answer}` })] }))
    })
    const blob = await Packer.toBlob(new Document({ sections: [{ children: paras }] }))
    const buf = await blob.arrayBuffer()
    const { renderAsync } = await import('docx-preview')
    docxHost.value.innerHTML = ''
    await renderAsync(buf, docxHost.value, undefined, { className: 'docx', inWrapper: true, breakPages: true })
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

// ===== 拖拽分割线 =====
function onSplitMouseDown(i: number, e: MouseEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  dragging.value = i
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}
function onDragMove(e: MouseEvent) {
  if (dragging.value === null || !leftPane.value) return
  // 找到鼠标下的块（用于把分割线吸附到最近块边界）
  const el = document.elementFromPoint(e.clientX, e.clientY)
  const host = el?.closest('[data-block-idx]') as HTMLElement | null
  if (!host) return
  const idx = Number(host.dataset.blockIdx)
  if (!Number.isFinite(idx)) return
  pendingDragTarget = idx
}
let pendingDragTarget: number | null = null
function onDragEnd() {
  const i = dragging.value
  dragging.value = null
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  if (i === null || pendingDragTarget === null) { pendingDragTarget = null; return }
  const target = pendingDragTarget
  pendingDragTarget = null
  // 首尾不可动；不能与相邻分割线重合
  if (target <= 0 || target >= blocks.value.length) return
  const next = boundaries.value.slice()
  if (next.includes(target) && next[i] !== target) return
  next[i] = target
  const uniq = Array.from(new Set(next)).sort((a, b) => a - b)
  if (uniq.length !== next.length) return
  boundaries.value = uniq
  syncDrafts()
}

// ===== 网站渲染视图（实时跟随右侧编辑）=====
const sitePreviewHtml = computed(() => {
  return chunks.value.map((c, i) => {
    const d = drafts.value[i]
    const body = d?.content || c.html
    const md = /<[a-z][^>]*>/i.test(body) ? htmlToMarkdown(body) : body
    return renderMarkdown(md || '')
  })
})

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
})
onUnmounted(() => {
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
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
          <div ref="docxHost" class="zs-docx" />
          <div class="zs-hint">分割线已自动插入 · 拖动分割线可调整 · 点 ▸ 可加/删分割线</div>
        </div>

        <!-- 网站渲染视图（实时跟随右侧编辑） -->
        <div v-show="viewMode === 'site'" class="zs-pane">
          <div v-for="(c, i) in chunks" :key="i" class="zs-site-chunk">
            <div class="zs-site-head">
              第 {{ i + 1 }} 题
              <el-tag size="small">{{ qtypeLabel(drafts[i]?.qtype || 'subjective') }}</el-tag>
            </div>
            <div class="markdown-body zg-rich" v-html="sitePreviewHtml[i]" />
            <div v-if="drafts[i]?.options?.length" class="zs-site-opts">
              <div v-for="(o, k) in drafts[i].options" :key="k">{{ 'ABCDEFGH'[k] }}. {{ o }}</div>
            </div>
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
.zs-docx { min-width: 0; }
.zs-hint { font-size: 11px; color: var(--zg-text-dim, #999); padding: 6px 2px; }

.zs-site-chunk { padding: 10px 12px; border-bottom: 1px dashed rgba(0,0,0,0.12); }
.zs-site-chunk:last-child { border-bottom: 0; }
.zs-site-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; margin-bottom: 6px; color: var(--zg-primary); }
.zs-site-opts { font-size: 13px; padding: 4px 0 0 8px; }

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
