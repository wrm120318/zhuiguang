<script setup lang="ts">
// ===== v4.2.2 通用 Markdown 富文本编辑器 =====
// 特性：
// - textarea + 工具栏 + 实时预览（marked 扩展）
// - 支持 KaTeX 公式、@用户提及、==文本高亮==、视频/PDF/B站嵌入、file://附件
// - 兼容 CommonMark / GFM / HTML 子集
// - 撤销/重做、拖拽上传、粘贴上传
// - 选区保留：插入后光标在插入点

import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { renderExtendedMarkdown, sanitizeHtml } from '@/utils/marked-extensions'
import { ensureKatexCss } from '@/utils/markdown'
import { api } from '@/api'
// 【v4.8.16】从 Word / 网页粘贴的富文本统一转 Markdown 后入库，
// 让下游（题库卡片、Word 导出、组卷）只处理一种格式
import { htmlToMarkdown } from '@/utils/html-to-md'

// ===== props =====
const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  minHeight?: number
  enableUploads?: boolean
  enableEmoji?: boolean
  enableHtml?: boolean
}>(), {
  placeholder: '支持 Markdown 语法 + HTML 子集 + KaTeX 公式 + 视频/PDF 嵌入',
  minHeight: 360,
  enableUploads: true,
  enableEmoji: true,
  enableHtml: true,
})

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'change', v: string): void
  (e: 'upload', payload: { url: string; type: 'image' | 'file' }): void
}>()

const rootRef = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
// 【v4.8.14】移动端默认「编辑」而不是「分屏」：
// 393px 下分屏两栏各只剩约 180px，输入和预览都不可用。
// 同时 CSS 已隐藏「分屏」选项，若初始值仍是 split 会出现
// 「高亮项与隐藏项不一致 / 两栏挤在一起」的视觉错乱。
const isNarrow = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(max-width: 768px)').matches
  : false
const viewMode = ref<'edit' | 'preview' | 'split'>(isNarrow ? 'edit' : 'split')
const content = ref(props.modelValue || '')

watch(() => props.modelValue, v => {
  if (v !== content.value) content.value = v || ''
})
watch(content, v => {
  if (v !== props.modelValue) {
    emit('update:modelValue', v)
    emit('change', v)
  }
})

// 实时预览 HTML
const previewHtml = computed(() => renderExtendedMarkdown(content.value, true))

// ============================================================================
// 【v4.8.21】图片拖拽调大小（预览区所见即所得）
//   需求由来：「自适应图片大小到现在还没做，你就给上传的用户一个拖拽大小的权力很难吗」
//   实现思路：
//     1. 预览区渲染完 → 给每张 <img class="zg-img"> 外面包一层 .zg-img-box
//     2. box 右下角放一个 .zg-img-handle 拖拽手柄
//     3. 拖动 → 实时改 img 的 width/height（保持宽高比）
//     4. 松手 → 按 src 在 Markdown 源码里定位对应的 ![alt](url)，写入/更新 `=WxH`
//   为什么按 src 定位：marked 渲染后拿不到原始位置，但 src 在本题范围内唯一，
//   用它回查是最稳的做法（同一张图重复引用时改第一处，符合直觉）。
//   四角都支持：右下角放大、左上角反向缩，拖拽方向统一按「对角锚点」处理。
// ============================================================================
const previewPaneRef = ref<HTMLElement | null>(null)
const MIN_IMG_W = 40           // 最小宽度，避免拖成一条线
const HANDLE_HIT = 14          // 手柄尺寸（px），与 CSS 保持一致

/** 给预览区所有 img.zg-img 包一层带手柄的容器 */
function decorateImages() {
  const pane = previewPaneRef.value
  if (!pane) return
  pane.querySelectorAll<HTMLImageElement>('img.zg-img').forEach(img => {
    const parent = img.parentElement
    if (!parent) return
    // 已包装过（父级就是 box）→ 跳过，避免重复渲染时层层嵌套
    if (parent.classList.contains('zg-img-box')) return
    const box = document.createElement('span')
    box.className = 'zg-img-box'
    parent.insertBefore(box, img)
    box.appendChild(img)
    const handle = document.createElement('span')
    handle.className = 'zg-img-handle'
    handle.title = '拖动调整图片大小'
    handle.dataset.role = 'resize'
    box.appendChild(handle)
    // 左上角手柄（反向缩放）
    const handleTL = document.createElement('span')
    handleTL.className = 'zg-img-handle tl'
    handleTL.title = '拖动调整图片大小'
    handleTL.dataset.role = 'resize-tl'
    box.appendChild(handleTL)
  })
}

/** 鼠标按下手柄 → 开始拖拽 */
function onPreviewMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target?.classList?.contains('zg-img-handle')) return
  e.preventDefault()
  e.stopPropagation()

  const box = target.parentElement
  const img = box?.querySelector<HTMLImageElement>('img.zg-img')
  if (!box || !img) return

  const isTL = target.classList.contains('tl')
  const startX = e.clientX
  const startW = img.getBoundingClientRect().width
  // 用原始比例算高，避免图片本身已变形
  const naturalRatio = (img.naturalHeight && img.naturalWidth)
    ? img.naturalHeight / img.naturalWidth
    : (img.getBoundingClientRect().height / Math.max(1, startW))
  // 内容区最大宽度：约等于预览区可视宽度
  const paneW = previewPaneRef.value?.clientWidth || 720
  const maxW = Math.max(MIN_IMG_W, paneW - 8)

  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX
    let w = isTL ? startW - dx : startW + dx
    w = Math.max(MIN_IMG_W, Math.min(maxW, w))
    const h = Math.round(w * naturalRatio)
    img.style.width = Math.round(w) + 'px'
    img.style.height = h + 'px'
    box.dataset.curW = String(Math.round(w))
    box.dataset.curH = String(h)
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    const w = Number(box.dataset.curW || 0)
    const h = Number(box.dataset.curH || 0)
    if (w && h) applyImageSize(img.src, w, h)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/** 把新的 W×H 写回 Markdown 源码 */
function applyImageSize(src: string, w: number, h: number) {
  const md = content.value
  // 在 Markdown 里找该图片对应的 ![alt](url) —— url 可能被 escapeHtml 过，这里做双向匹配
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 归一化：把 &amp; 等还原，便于比对
  const norm = (s: string) => s.replace(/&amp;/g, '&')
  const targetNorm = norm(src)
  let matched = false

  const re = /!\[([^\]]*)\]\(([^)\s]+)(\s*=\s*(\d+)\s*[x×]\s*(\d+)\s*)?\)/g
  const out = md.replace(re, (full, alt, url) => {
    if (matched) return full
    if (norm(url) !== targetNorm) return full
    matched = true
    return `![${alt}](${url} =${w}x${h})`
  })

  if (!matched) {
    // 兜底：源码里可能是裸 HTML <img src="..."> 或 data: URL（无法按 src 反查）
    // 这种直接改 img 标签的 width/height 属性
    const imgRe = new RegExp('<img\\b[^>]*\\bsrc\\s*=\\s*["\']' + esc(src) + '["\'][^>]*>', 'i')
    if (imgRe.test(content.value)) {
      content.value = content.value.replace(imgRe, (tag) => {
        let t = tag.replace(/\s+width\s*=\s*["']?\d+(px)?["']?/i, '')
        t = t.replace(/\s+height\s*=\s*["']?\d+(px)?["']?/i, '')
        t = t.replace(/\s+style\s*=\s*["']([^"']*)["']/i, (_m, s) => ` style="${s.replace(/(^|;)\s*width\s*:[^;]*/i, '').replace(/(^|;)\s*height\s*:[^;]*/i, '')};width:${w}px;height:${h}px"`)
        return t.replace(/<img\b/i, `<img width="${w}" height="${h}"`)
      })
      ElMessage.success(`图片已调整为 ${w}×${h}`)
      return
    }
    ElMessage.warning('没能定位到这张图片的源码，请手动调整尺寸')
    return
  }
  content.value = out
  ElMessage.success(`图片已调整为 ${w}×${h}`)
}

// 【v4.8.21】previewHtml 每次按键都会变，decorateImages 要遍历所有 img 做 DOM 操作，
// 内容大时（题库有 60KB 的题面）会拖慢输入手感 → 加 120ms 防抖。
let decorateTimer: any = null
function scheduleDecorate() {
  if (decorateTimer) clearTimeout(decorateTimer)
  decorateTimer = setTimeout(() => { decorateImages() }, 120)
}
watch(previewHtml, () => { nextTick(scheduleDecorate) })

onMounted(() => {
  ensureKatexCss()
  document.addEventListener('keydown', handleKeyDown)
  // 【v4.8.21】首屏也要挂钩手柄（模型初始值带来的图片不会触发 previewHtml 变化）
  nextTick(decorateImages)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
  if (decorateTimer) clearTimeout(decorateTimer)
})

// ===== 撤销/重做（基于快照栈） =====
const history = ref<string[]>([content.value])
const historyIndex = ref(0)
let historyTimer: any = null
function pushHistory() {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = setTimeout(() => {
    if (content.value === history.value[historyIndex.value]) return
    // 截断未来历史
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(content.value)
    // 限制栈深度
    if (history.value.length > 100) {
      history.value = history.value.slice(-100)
    }
    historyIndex.value = history.value.length - 1
  }, 400)
}
watch(content, pushHistory)
function undo() {
  if (historyIndex.value > 0) {
    historyIndex.value--
    content.value = history.value[historyIndex.value]
  }
}
function redo() {
  if (historyIndex.value < history.value.length - 1) {
    historyIndex.value++
    content.value = history.value[historyIndex.value]
  }
}

function handleKeyDown(e: KeyboardEvent) {
  // 只在 textarea focus 时响应
  if (document.activeElement !== textareaRef.value) return
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); undo()
  } else if (ctrl && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
    e.preventDefault(); redo()
  } else if (ctrl && e.key === 'b') {
    e.preventDefault(); wrap('**', '**', '加粗文字')
  } else if (ctrl && e.key === 'i') {
    e.preventDefault(); wrap('*', '*', '斜体文字')
  } else if (ctrl && e.key === 'k') {
    e.preventDefault(); insertLink()
  }
}

// ===== 工具栏操作：保留光标在插入点 =====
function getSelection() {
  const ta = textareaRef.value
  if (!ta) return { start: 0, end: 0, value: '' }
  return { start: ta.selectionStart, end: ta.selectionEnd, value: ta.value }
}
function setSelection(start: number, end: number) {
  const ta = textareaRef.value
  if (!ta) return
  nextTick(() => {
    ta.focus()
    ta.setSelectionRange(start, end)
  })
}
function replaceRange(start: number, end: number, replacement: string) {
  const before = content.value.slice(0, start)
  const after = content.value.slice(end)
  content.value = before + replacement + after
  setSelection(start + replacement.length, start + replacement.length)
}
function wrap(prefix: string, suffix: string, placeholder = '文字') {
  const { start, end, value } = getSelection()
  const selected = value.slice(start, end)
  const inner = selected || placeholder
  const replacement = prefix + inner + suffix
  replaceRange(start, end, replacement)
}
function insertAtCursor(text: string, cursorOffset?: number) {
  const { start, end } = getSelection()
  const before = content.value.slice(0, start)
  const after = content.value.slice(end)
  content.value = before + text + after
  const newCursor = start + (cursorOffset ?? text.length)
  setSelection(newCursor, newCursor)
}

// ===== 工具栏按钮 =====
function insertH(n: 1 | 2 | 3 | 4) {
  insertAtCursor(`\n${'#'.repeat(n)} 标题\n\n`, 2 + n + 1)
}
function insertBold() { wrap('**', '**', '加粗文字') }
function insertItalic() { wrap('*', '*', '斜体文字') }
function insertStrike() { wrap('~~', '~~', '删除线文字') }
function insertUl() { insertAtCursor('\n- 列表项\n- 列表项\n- 列表项\n\n') }
function insertOl() { insertAtCursor('\n1. 第一项\n2. 第二项\n3. 第三项\n\n') }
function insertTask() { insertAtCursor('\n- [ ] 待办\n- [x] 已完成\n\n') }
function insertQuote() { insertAtCursor('\n> 引用内容\n> 继续引用\n\n') }
function insertCode() {
  const { start, end, value } = getSelection()
  const selected = value.slice(start, end)
  if (selected.includes('\n')) {
    replaceRange(start, end, '\n```\n' + (selected || '代码块') + '\n```\n\n')
  } else {
    wrap('`', '`', '代码')
  }
}
function insertTable() {
  insertAtCursor('\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n\n')
}
function insertLink() {
  const { start, end, value } = getSelection()
  const selected = value.slice(start, end) || '链接文字'
  const url = window.prompt('请输入链接 URL：', 'https://')
  if (!url) return
  replaceRange(start, end, `[${selected}](${url})`)
}
function insertHr() { insertAtCursor('\n---\n\n') }

// ===== 媒体类（视频 / PDF / B站 / file） =====
function insertVideo() {
  const url = window.prompt('请输入视频 URL（mp4/webm/ogg/mov）：', 'https://')
  if (!url) return
  insertAtCursor(`@\`${url}\`\n\n`)
}
function insertPdf() {
  const url = window.prompt('请输入 PDF URL：', 'https://')
  if (!url) return
  insertAtCursor(`@\`${url}\`\n\n`)
}
function insertBilibili() {
  const bvid = window.prompt('请输入 B 站 BV 号（如 BV1xx411c7mD）：', 'BV1')
  if (!bvid || !bvid.startsWith('BV')) {
    ElMessage.warning('BV 号格式不正确')
    return
  }
  insertAtCursor(`@[bilibili](${bvid})\n\n`)
}
function insertFile() {
  const name = window.prompt('请输入附件文件名（用于 file:// 引用）：', '资料.pdf')
  if (!name) return
  insertAtCursor(`[${name}](file://${name})\n\n`)
}

// ===== 公式 =====
function insertKatexInline() {
  const formula = window.prompt('请输入行内公式（LaTeX）：', 'E=mc^2')
  if (!formula) return
  insertAtCursor(`$${formula}$\n`)
}
function insertKatexBlock() {
  const formula = window.prompt('请输入块级公式（LaTeX）：', '\\\\int_0^\\\\infty e^{-x^2} dx = \\\\frac{\\\\sqrt{\\\\pi}}{2}')
  if (!formula) return
  insertAtCursor(`\n$$${formula}$$\n\n`)
}

// ===== 提及 =====
const mentionPickerVisible = ref(false)
const mentionKeyword = ref('')
const mentionResults = ref<Array<{ id: number; username: string; realName: string }>>([])
const mentionLoading = ref(false)
let mentionSearchTimer: any = null

async function searchUsers(kw: string) {
  mentionLoading.value = true
  try {
    const r: any = await api.searchUsers(kw)
    mentionResults.value = Array.isArray(r) ? r : []
  } catch (e) {
    mentionResults.value = []
  } finally {
    mentionLoading.value = false
  }
}

function onMentionKeywordInput(v: string) {
  mentionKeyword.value = v
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer)
  if (!v.trim()) {
    mentionResults.value = []
    return
  }
  mentionSearchTimer = setTimeout(() => searchUsers(v.trim()), 250)
}

function pickMention(u: { id: number; username: string; realName: string }) {
  // 选中一个用户 → 自动拼接完整语法（带 ID），保证后续渲染与通知触发都不变
  insertAtCursor(`@[${u.realName || u.username}](/user/${u.id}) `)
  mentionPickerVisible.value = false
  mentionKeyword.value = ''
  mentionResults.value = []
}

function insertMention() {
  mentionPickerVisible.value = true
  mentionKeyword.value = ''
  mentionResults.value = []
}

// ===== 高级：图片 =====
function insertImageDialog() {
  const url = window.prompt('请输入图片 URL（可选尺寸：=100x100）：', 'https://')
  if (!url) return
  const alt = window.prompt('图片描述（alt）：', '图片') || '图片'
  const size = window.prompt('可选尺寸：宽x高（留空表示原始）：', '')
  if (size && /^\d+[x×]\d+$/.test(size)) {
    insertAtCursor(`\n![${alt}](${url} =${size})\n\n`)
  } else {
    insertAtCursor(`\n![${alt}](${url})\n\n`)
  }
}

// ===== 高亮 =====
function insertHighlight() {
  const { start, end, value } = getSelection()
  const selected = value.slice(start, end) || '高亮文字'
  replaceRange(start, end, `==${selected}==`)
}

// ===== 表情 =====
const EMOJIS = ['😀', '😂', '😍', '🤔', '😎', '😭', '🔥', '✨', '🎉', '👍', '❤️', '🌟', '💡', '📚', '✍️', '🎨', '🌈', '⚡', '💪', '🙏']
function insertEmoji(e: string) { insertAtCursor(e) }

// ===== 图片上传（按钮） =====
async function onPickImage() {
  fileInputRef.value?.click()
}
async function onFilePicked(e: Event) {
  const target = e.target as HTMLInputElement
  if (!target.files?.length) return
  for (const file of Array.from(target.files)) {
    await uploadFile(file, 'image')
  }
  target.value = ''
}

async function uploadFile(file: File, type: 'image' | 'file') {
  try {
    const r: any = type === 'image' ? await api.uploadImage(file) : await api.uploadFile(file)
    const url = r.url
    if (type === 'image') {
      insertAtCursor(`\n![${file.name}](${url})${imgSizeAttrs(r)}\n\n`)
      ElMessage.success('图片已上传并插入')
    } else {
      insertAtCursor(`\n[${file.name}](file://${file.name})\n\n实际链接：${url}\n\n`)
      ElMessage.success('附件已上传')
    }
    emit('upload', { url, type })
  } catch (e: any) {
    ElMessage.error(e?.message || '上传失败')
  }
}

// 【v4.8.15】上传题目图片后自动限制展示尺寸，避免大图撑爆编辑器/题库卡片
// 复用既有语法 ![alt](url =WxH)（见 marked-extensions.ts 的 imageSized 扩展），
// 不引入新语法，渲染侧 / Word 导出侧零改动即可生效。
const IMG_MAX_RATIO = 1      // 图片不超过内容区宽度的 100%
const IMG_MIN_PX = 120       // 兜底最小宽度，避免极端窄容器把图压成一条线

function imgSizeAttrs(r: any): string {
  let w = Number(r?.width) || 0
  let h = Number(r?.height) || 0
  if (!w || !h) return ''
  const host = textareaRef.value?.clientWidth || rootRef.value?.clientWidth || 0
  // 编辑器未挂载（极少数）时退回 720px 的经验内容宽度
  const contentW = host > 200 ? host : 720
  const maxW = Math.max(IMG_MIN_PX, Math.round(contentW * IMG_MAX_RATIO))
  if (w > maxW) {
    h = Math.round((h * maxW) / w)
    w = maxW
  }
  return ` =${Math.round(w)}x${Math.round(h)}`
}

// ===== 拖拽 / 粘贴 =====
function onDragOver(e: DragEvent) { e.preventDefault() }
async function onDrop(e: DragEvent) {
  e.preventDefault()
  const files = e.dataTransfer?.files
  if (!files) return
  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/')) {
      await uploadFile(file, 'image')
    } else {
      await uploadFile(file, 'file')
    }
  }
}
async function onPaste(e: ClipboardEvent) {
  const cd = e.clipboardData
  if (!cd) return
  // 1) 图片文件优先（保留原粘贴上传行为：图片自动入文）
  for (const item of Array.from(cd.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (file) await uploadFile(file, 'image')
      return
    }
  }
  // 2) 富文本 HTML（Word / 网页复制）→ 转 Markdown 后插入
  //    【v4.8.16 重写】原实现把剪贴板的 HTML 原样塞进 content，引发三个连锁问题：
  //      · 题库卡片：HTML 表格无列宽约束 → 列被压成"竖排单字"；样式与 Markdown 题目不一致
  //      · Word 导出：导出器只认 Markdown，遇到 `<table><tbody><tr><td>` 原样写进文档 = 乱码
  //      · base64 图片：一段 Word 题面可达 60KB，撑爆存储与卡片布局
  //    现在统一走 htmlToMarkdown() 收敛成 Markdown，并在转换前把 base64 图上传成真实 URL。
  const html = cd.getData('text/html')
  if (html && html.trim()) {
    const cleaned = sanitizeHtml(html)
    if (isMeaningfulHtml(cleaned)) {
      e.preventDefault()
      try {
        // ① 先把内联 base64 图片（Word 粘贴的图都是这种）上传，换成短 URL
        const withUrls = await uploadInlineDataImages(cleaned)
        // ② HTML → Markdown（表格转 GFM 表格，strong→**，KaTeX span→$..$ 等）
        let md = htmlToMarkdown(withUrls)
        if (!md.trim()) md = htmlToMarkdown(cleaned)
        insertAtCursor(md)
        ElMessage.success('已粘贴并转为标准格式')
      } catch (err: any) {
        // 转换失败不阻塞用户：退回纯文本粘贴，避免"粘贴后什么都没有"
        ElMessage.warning('粘贴内容解析失败，已按纯文本插入')
      }
      return
    }
  }
  // 3) 纯文本 / 代码 → 走浏览器默认粘贴
}

/**
 * 【v4.8.16】把 HTML 里的内联 base64 图片上传成真实 URL。
 * Word 复制出来的图片全部是 `src="data:image/png;base64,..."`（单张可达数百 KB），
 * 直接入库会让 D1 单行超限、且每次列表渲染都要解析巨型字符串。
 * 这里逐张上传，失败则保留原 base64（宁可图大，不能丢图）。
 */
async function uploadInlineDataImages(html: string): Promise<string> {
  const re = /<img\b[^>]*\bsrc\s*=\s*"data:image\/([a-zA-Z0-9.+-]+);base64,([^"]+)"[^>]*>/gi
  const matches = [...html.matchAll(re)]
  if (!matches.length) return html

  let out = html
  for (const m of matches) {
    const ext = (m[1] || 'png').toLowerCase().replace('jpeg', 'jpg')
    const b64 = m[2]
    // 粗略估算体积，超过 12MB 的单图跳过（避免浏览器卡死 / 请求体超限）
    if (b64.length * 0.75 > 12 * 1024 * 1024) continue
    try {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], `paste-${Date.now()}.${ext}`, { type: `image/${ext}` })
      const r: any = await api.uploadImage(file)
      if (r?.url) {
        // 用上传后的短 URL 替换该张 base64
        out = out.replace(m[0], m[0].replace(m[0].match(/src\s*=\s*"[^"]*"/i)![0], `src="${r.url}"`))
      }
    } catch {
      // 单张失败不影响其它图片与整体转换
    }
  }
  return out
}

// 判断清理后的 HTML 是否“有意义”：避免把单个 <div>文字</div> 平凡包裹误当 HTML 插入
function isMeaningfulHtml(cleaned: string): boolean {
  const t = cleaned.trim()
  const singleWrap = /^<(div|span|p|section|article)>(.*)<\/\1>$/is.exec(t)
  if (singleWrap) {
    const inner = singleWrap[2]
    if (!/<\/?[a-z]/i.test(inner)) return false // 内部已无其它标签 → 平凡包裹
  }
  return /<[a-z][\s\S]*>/i.test(cleaned)
}

// ===== 全屏 =====
const fullscreen = ref(false)
function toggleFullscreen() {
  fullscreen.value = !fullscreen.value
}

// ===== 工具栏按钮元数据 =====
const tools = computed(() => [
  { group: '撤销' }, { name: '↶ 撤销', action: undo, tip: 'Ctrl+Z' }, { name: '↷ 重做', action: redo, tip: 'Ctrl+Shift+Z' },
  { group: '标题' }, { name: 'H1', action: () => insertH(1) }, { name: 'H2', action: () => insertH(2) }, { name: 'H3', action: () => insertH(3) }, { name: 'H4', action: () => insertH(4) },
  { group: '文本' }, { name: '<b>B</b>', action: insertBold, tip: 'Ctrl+B' }, { name: '<i>I</i>', action: insertItalic, tip: 'Ctrl+I' }, { name: '<s>S</s>', action: insertStrike }, { name: '==高亮==', action: insertHighlight }, { name: '代码', action: insertCode },
  { group: '结构' }, { name: '列表', action: insertUl }, { name: '1.2.3', action: insertOl }, { name: '☑ 待办', action: insertTask }, { name: '引用', action: insertQuote }, { name: '表格', action: insertTable }, { name: '分割线', action: insertHr },
  { group: '媒体' }, { name: '🖼 图片', action: props.enableUploads ? onPickImage : insertImageDialog }, { name: '🔗 链接', action: insertLink, tip: 'Ctrl+K' }, { name: '🎬 视频', action: insertVideo }, { name: '📺 B站', action: insertBilibili }, { name: '📄 PDF', action: insertPdf }, { name: '📎 file://', action: insertFile },
  { group: '高级' }, { name: '$ 公式$', action: insertKatexInline }, { name: '$$ 块$', action: insertKatexBlock }, { name: '@提及', action: insertMention },
  ...(props.enableEmoji ? [{ group: '表情' }, ...EMOJIS.map(e => ({ name: e, action: () => insertEmoji(e) }))] : []),
])
</script>

<template>
  <div ref="rootRef" class="zg-editor" :class="{ fullscreen }">
    <div class="zg-editor-bar">
      <div class="zg-tools">
        <template v-for="(t, i) in tools" :key="i">
          <span v-if="t.group" class="zg-tool-group">{{ t.group }}</span>
          <button v-else type="button" class="zg-tool" :title="t.tip" @click="t.action" v-html="t.name"></button>
        </template>
      </div>
      <div class="zg-viewmode">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button label="edit">编辑</el-radio-button>
          <el-radio-button label="split">分屏</el-radio-button>
          <el-radio-button label="preview">预览</el-radio-button>
        </el-radio-group>
        <button type="button" class="zg-tool" @click="toggleFullscreen" :title="fullscreen ? '退出全屏' : '全屏'">
          {{ fullscreen ? '⤓' : '⤢' }}
        </button>
      </div>
    </div>

    <div class="zg-editor-body" :class="['mode-' + viewMode]">
      <div v-show="viewMode !== 'preview'" class="zg-edit-pane"
        @dragover="onDragOver" @drop="onDrop">
        <textarea
          ref="textareaRef"
          v-model="content"
          :placeholder="placeholder"
          :style="{ minHeight: minHeight + 'px' }"
          class="zg-textarea"
          @paste="onPaste"
          spellcheck="false"
        />
      </div>
      <div v-show="viewMode !== 'edit'" class="zg-preview-pane" ref="previewPaneRef" @mousedown="onPreviewMouseDown">
        <div class="zg-preview-content markdown-body" v-html="previewHtml"></div>
      </div>
    </div>

    <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="onFilePicked" />

    <!-- @提及选择器：输入关键词 → 调 /api/users/search → 点选自动写完整语法 -->
    <el-dialog v-model="mentionPickerVisible" title="@ 提及用户" width="420px" append-to-body>
      <el-input
        v-model="mentionKeyword"
        placeholder="输入用户名或姓名搜索"
        clearable
        :prefix-icon="'Search' as any"
        @input="onMentionKeywordInput"
        autofocus
      />
      <div class="zg-mention-list" v-loading="mentionLoading">
        <div
          v-for="u in mentionResults"
          :key="u.id"
          class="zg-mention-item"
          @click="pickMention(u)"
        >
          <span class="zg-mention-name">{{ u.realName || u.username }}</span>
          <span class="zg-mention-uid">@{{ u.username }} · #{{ u.id }}</span>
        </div>
        <div v-if="!mentionLoading && mentionKeyword && !mentionResults.length" class="zg-mention-empty">
          未找到匹配用户
        </div>
        <div v-if="!mentionKeyword && !mentionResults.length" class="zg-mention-empty">
          输入关键词开始搜索（按用户名或姓名模糊匹配）
        </div>
      </div>
    </el-dialog>

    <div class="zg-editor-foot">
      <span class="zg-stat">字数 {{ content.length }} · 行 {{ content.split('\n').length }}</span>
      <span class="zg-tip">支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF 嵌入 · 可拖拽图片到此</span>
    </div>
  </div>
</template>

<style scoped>
.zg-editor {
  display: flex; flex-direction: column; gap: 8px;
  background: rgba(255,255,255,0.5);
  border: 1px solid rgba(var(--zg-primary-rgb), 0.15);
  border-radius: 12px;
  padding: 8px;
  transition: all 0.2s;
}
.zg-editor.fullscreen {
  position: fixed; inset: 0; z-index: 9999; border-radius: 0;
  background: var(--zg-bg, #fff);
}
.zg-editor-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 4px 8px; flex-wrap: wrap;
  border-bottom: 1px solid rgba(var(--zg-primary-rgb), 0.1);
  padding-bottom: 8px;
}
.zg-tools { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; flex: 1; }
.zg-tool-group {
  font-size: 11px; color: var(--zg-text-dim);
  padding: 0 6px; border-left: 2px solid rgba(var(--zg-primary-rgb), 0.2);
  margin-left: 6px;
}
.zg-tool {
  background: rgba(var(--zg-primary-rgb), 0.06);
  border: 1px solid rgba(var(--zg-primary-rgb), 0.15);
  color: var(--zg-text);
  padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px;
  transition: all 0.15s; min-width: 32px;
}
.zg-tool:hover { background: rgba(var(--zg-primary-rgb), 0.18); transform: translateY(-1px); }
.zg-viewmode { display: flex; align-items: center; gap: 8px; }
.zg-editor-body { display: grid; gap: 8px; }
.zg-editor-body.mode-split { grid-template-columns: 1fr 1fr; }
.zg-editor-body.mode-edit { grid-template-columns: 1fr; }
.zg-editor-body.mode-preview { grid-template-columns: 1fr; }
.zg-edit-pane, .zg-preview-pane {
  border-radius: 8px; padding: 12px; min-height: 240px;
  background: rgba(255,255,255,0.7);
  border: 1px solid rgba(var(--zg-primary-rgb), 0.1);
  overflow: auto;
}
.zg-textarea {
  width: 100%; height: 100%; min-height: 240px;
  background: transparent; border: 0; outline: 0;
  font-family: 'JetBrains Mono', Consolas, 'Courier New', monospace;
  font-size: 14px; line-height: 1.7; resize: vertical;
  color: var(--zg-text);
}
.zg-preview-content { font-size: 15px; line-height: 1.85; }

/* 【v4.8.21】图片拖拽调大小：预览区每张图外包一层 .zg-img-box，四角带手柄 */
.zg-img-box {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 0;
}
.zg-img-box > img.zg-img { display: block; max-width: 100%; }
/* hover 时给个淡金描边，提示"这张图可拖" */
.zg-img-box:hover > img.zg-img {
  outline: 2px solid rgba(var(--zg-primary-rgb), 0.55);
  outline-offset: 1px;
}
.zg-img-handle {
  position: absolute;
  right: -6px; bottom: -6px;
  width: 14px; height: 14px;
  border-radius: 3px;
  background: var(--zg-primary, #f59e0b);
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.25);
  cursor: nwse-resize;
  opacity: 0;
  transition: opacity .15s ease;
  z-index: 3;
}
.zg-img-handle.tl {
  right: auto; bottom: auto;
  left: -6px; top: -6px;
  cursor: nwse-resize;
}
.zg-img-box:hover > .zg-img-handle { opacity: 1; }
.zg-img-handle:hover { transform: scale(1.15); }
/* 触屏设备：手柄常显，否则没法拖 */
@media (hover: none) {
  .zg-img-handle { opacity: 1; }
}

.zg-editor-foot {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; color: var(--zg-text-dim);
  padding: 4px 8px;
  border-top: 1px solid rgba(var(--zg-primary-rgb), 0.1);
}
@media (max-width: 768px) {
  .zg-editor-body.mode-split { grid-template-columns: 1fr; }
  .zg-edit-pane, .zg-preview-pane { min-height: 200px; }
}
@media (max-width: 640px) {
  .zg-editor { padding: 6px; gap: 6px; }
  .zg-editor-bar {
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 6px 8px;
  }
  /* 工具栏在手机上改为横向滚动，避免按钮挤成一团换行 */
  .zg-tools {
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    padding-bottom: 3px;
    flex: 1 1 100%;
  }
  .zg-tools::-webkit-scrollbar { display: none; }
  /* 移动端隐藏分组标签，节省横向空间 */
  .zg-tool-group { display: none; }
  .zg-tool {
    padding: 7px 10px;
    font-size: 14px;
    min-width: 38px;
    flex: 0 0 auto;
  }
  .zg-viewmode { flex-shrink: 0; }
  .zg-viewmode :deep(.el-radio-group) { flex-wrap: nowrap; }
  .zg-viewmode :deep(.el-radio-button__inner) { padding: 4px 9px; font-size: 12px; }
  /* 16px 避免 iOS 聚焦时自动缩放 */
  .zg-textarea { font-size: 16px; line-height: 1.7; padding: 4px; }
  .zg-edit-pane, .zg-preview-pane { padding: 10px; min-height: 200px; }
  .zg-preview-content { font-size: 15px; }
  .zg-editor-foot {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    font-size: 11px;
  }
  /* 全屏态下工具栏允许换行，保证可点 */
  .zg-editor.fullscreen .zg-editor-bar { flex-wrap: wrap; }
  .zg-editor.fullscreen .zg-tools { flex-wrap: nowrap; }
}

/* @提及选择器列表 */
.zg-mention-list { margin-top: 12px; max-height: 360px; overflow-y: auto; }
.zg-mention-item {
  padding: 10px 12px; border-radius: 8px; cursor: pointer;
  display: flex; flex-direction: column; gap: 2px;
  transition: background .15s;
}
.zg-mention-item:hover { background: rgba(var(--zg-primary-rgb), .1); }
.zg-mention-name { font-weight: 600; font-size: 14px; color: var(--zg-text); }
.zg-mention-uid { font-size: 12px; color: var(--zg-text-dim); }
.zg-mention-empty {
  text-align: center; padding: 24px 12px; font-size: 13px; color: var(--zg-text-dim);
}
</style>
