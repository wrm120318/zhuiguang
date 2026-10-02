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
import { htmlToMarkdown, takeHtmlToMdIssues, isLocalDiskSrc } from '@/utils/html-to-md'
// 【v4.9.0】图片路径分流 / data URL 解码 —— 「传进去什么 = 导出什么」的基础设施
import { decodeDataImageUrl } from '@/utils/md-rich'

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
let dragging = false           // 是否正在拖拽图片（供手柄 hover 显隐逻辑判断）

/**
 * 给预览区所有图片包一层带手柄的容器
 * 【v4.8.23】原来只选 `img.zg-img`（marked 的 imageSized 扩展产出），
 *   但**裸 HTML `<img src=... width=300>` 不会带这个类**（数学/物理题里很常见），
 *   导致那些图完全没有手柄 —— 用户的反馈「图片自适应到现在还没做」正是这个漏网之鱼。
 *   现在改为覆盖预览区所有 img，再排除掉不该拖的（KaTeX 公式图、极小图标、表情）。
 *
 * 【v4.8.23 二修｜手柄点了没反应】
 *   本组件 `<style scoped>`，scoped 会给选择器编译出 `[data-v-xxx]` 属性要求，
 *   而这些节点是**原生 JS 动态创建**的、拿不到 `data-v-*` 属性 → 样式全部落空
 *   （实测 handle 的 display 仍是 inline、position 仍是 static、宽高 0 → 根本点不到）。
 *   故这里改为**直接写内联样式**，彻底绕开 scoped 作用域问题。
 */
const HANDLE_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  width: '14px',
  height: '14px',
  borderRadius: '3px',
  background: '#f59e0b',
  border: '2px solid #fff',
  boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
  cursor: 'nwse-resize',
  opacity: '0',
  transition: 'opacity .15s ease',
  zIndex: '3',
  boxSizing: 'border-box',
  pointerEvents: 'auto',
  userSelect: 'none',
}

function decorateImages() {
  const pane = previewPaneRef.value
  if (!pane) return
  pane.querySelectorAll<HTMLImageElement>('img').forEach(img => {
    const parent = img.parentElement
    if (!parent) return
    // 已包装过（父级就是 box）→ 跳过，避免重复渲染时层层嵌套
    if (parent.classList.contains('zg-img-box')) return
    // KaTeX 公式渲染出的 SVG/图片不参与拖拽
    if (img.closest('.katex, .katex-display, .katex-html')) return
    if (img.classList.contains('katex-img')) return
    // 排除 emoji / 表情等小图（内容小图另说，这里按 src 特征判断）
    const cls = img.className || ''
    if (/emoji|emojione|twemoji|icon/i.test(cls)) return
    // 宽高都极小（< 24px）的多半是图标，不挂手柄
    const r = img.getBoundingClientRect()
    if ((r.width && r.width < 24) || (r.height && r.height < 24)) return

    const box = document.createElement('span')
    box.className = 'zg-img-box'
    Object.assign(box.style, {
      position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: '0',
    } as Partial<CSSStyleDeclaration>)
    parent.insertBefore(box, img)
    box.appendChild(img)
    Object.assign(img.style, { display: 'block', maxWidth: '100%' } as Partial<CSSStyleDeclaration>)

    const mkHandle = (tl: boolean) => {
      const h = document.createElement('span')
      h.className = tl ? 'zg-img-handle tl' : 'zg-img-handle'
      h.title = '拖动调整图片大小'
      h.dataset.role = tl ? 'resize-tl' : 'resize'
      Object.assign(h.style, HANDLE_STYLE)
      if (tl) { h.style.left = '-6px'; h.style.top = '-6px' }
      else { h.style.right = '-6px'; h.style.bottom = '-6px' }
      // hover 显隐：直接绑事件，不依赖 CSS
      h.addEventListener('mouseenter', () => { h.style.opacity = '1' })
      h.addEventListener('mouseleave', () => { if (!dragging) h.style.opacity = '0' })
      box.addEventListener('mouseenter', () => { box.querySelectorAll<HTMLElement>('.zg-img-handle').forEach(x => { x.style.opacity = '1' }) })
      box.addEventListener('mouseleave', () => { if (!dragging) box.querySelectorAll<HTMLElement>('.zg-img-handle').forEach(x => { x.style.opacity = '0' }) })
      box.appendChild(h)
    }
    mkHandle(false)
    mkHandle(true)
  })
}

/** 鼠标按下手柄 → 开始拖拽 */
function onPreviewMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target?.classList?.contains('zg-img-handle')) return
  e.preventDefault()
  e.stopPropagation()

  const box = target.parentElement
  const img = box?.querySelector<HTMLImageElement>('img')
  if (!box || !img) return

  dragging = true
  target.style.opacity = '1'
  // 拖拽期间禁掉文本选中，避免拖出蓝色选区
  const prevUserSelect = document.body.style.userSelect
  document.body.style.userSelect = 'none'
  if (previewPaneRef.value) previewPaneRef.value.style.userSelect = 'none'

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
  // 拖拽过程中先去掉 max-width 限制，否则改不动（CSS max-width:100% 会压住内联宽度）
  const prevMaxW = img.style.maxWidth
  img.style.maxWidth = 'none'

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
    dragging = false
    document.body.style.userSelect = prevUserSelect
    if (previewPaneRef.value) previewPaneRef.value.style.userSelect = ''
    img.style.maxWidth = prevMaxW || ''
    const w = Number(box.dataset.curW || 0)
    const h = Number(box.dataset.curH || 0)
    // 【v4.8.23】优先用**原始 src 属性**（源码里写的那个），而不是 img.src
    //   （后者是浏览器解析后的绝对 URL，源码里可能是相对路径 → 反查会失败）
    if (w && h) applyImageSize(img.getAttribute('src') || img.src, w, h)
    // 收起手柄
    box.querySelectorAll<HTMLElement>('.zg-img-handle').forEach(x => { x.style.opacity = '0' })
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

/**
 * 把新的 W×H 写回 Markdown 源码
 *
 * 【v4.8.25 重写 —— 修复「拖了尺寸不生效 / 尺寸只在编辑器里生效」】
 * ----------------------------------------------------------------------------
 * 旧实现有三个致命缺陷：
 *   ① **分三步正则改属性**：先删 `width`/`height` 属性 → 再改 style → 最后在
 *      `<img` 后插属性。任何一步的正则没匹配上（属性带引号 / 换行 / 属性顺序不同），
 *      前一步的「删除」就已经生效了 → **旧尺寸被删掉、新尺寸没写进去 = 尺寸彻底丢失**。
 *   ② 匹配用的是「第一个命中即止」的 `matched` 标志，但 `String.replace` 的回调
 *      是在**整串扫描中**逐次调用的；一旦前面的候选恰好同 src（同一张图被引用多次）
 *      或匹配失败，就会错改 / 漏改。
 *   ③ 只认 `<img ...>` 的 `src="…"` 双/单引号形式，**无引号写法**、带 `\n` 的多行标签
 *      都会漏（Word 粘贴来的 HTML 恰恰是多行 + 无引号）。
 *
 * 新实现改为「**整段精确替换**」：先用一个容忍度更高的正则找到**目标 img 标签的完整
 * 文本**，再对这一段文本做原位重建 —— 重建时统一输出「属性 + 内联样式」双保险，
 * 并保留 style 里除 width/height 之外的其它声明（如 max-width）。
 */
function applyImageSize(src: string, w: number, h: number) {
  const md = content.value
  // 归一化：还原 HTML 实体 + 去掉空白，便于跨表示形式比对
  const norm = (s: string) => String(s)
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, '')
  const targetNorm = norm(src)
  // 相对/绝对等价的候选（源码写 /api/xxx，浏览器 src 是 https://api.../api/xxx）→ 取路径后缀比对
  const tail = (s: string) => {
    try { const u = new URL(s, location.origin); return norm(u.pathname + u.search) } catch { return norm(s) }
  }
  const targetTail = tail(src)
  /** 判断源码里写的 url 是否就是要调整的那张图 */
  const isTarget = (raw: string) => norm(raw) === targetNorm || tail(raw) === targetTail

  // ① Markdown 语法 ![alt](url) / ![alt](url =WxH)
  const re = /!\[([^\]]*)\]\(([^)\s]+)(\s*=\s*\d+\s*[x×]\s*\d+\s*)?\)/g
  let out = md.replace(re, (full, alt, url) => {
    if (!isTarget(url)) return full
    return `![${alt}](${url} =${w}x${h})`
  })
  if (out !== md) {
    content.value = out
    ElMessage.success(`图片已调整为 ${w}×${h}`)
    return
  }

  // ② 裸 HTML <img ...>（数学/物理题里常见，也是「图片拖不动」的原发场景）
  //    正则容忍：多行标签、属性无引号、属性顺序任意、自闭合斜杠可选
  const imgRe = /<img\b[^>]*>/gi
  let hit = false
  out = md.replace(imgRe, (tag) => {
    if (hit) return tag
    const m = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || tag.match(/\bsrc\s*=\s*([^\s>]+)/i)
    if (!m || !isTarget(m[1])) return tag
    hit = true

    // —— 重建这个 img 标签 ——
    // 1) 取出旧 style，剥掉 width/height 声明，其余保留（max-width / border 等不能被吞）
    const styleM = tag.match(/\sstyle\s*=\s*["']([^"']*)["']/i)
    const keptDecls = styleM
      ? styleM[1]
          .split(';')
          .map(s => s.trim())
          .filter(s => s && !/^width\s*:/i.test(s) && !/^height\s*:/i.test(s))
      : []
    // 2) 剥掉所有 width / height 属性（含无引号、含内联 style 形式）
    let rest = tag
      .replace(/\s+width\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+height\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    // 3) 在新样式里写回尺寸（追加到保留声明的末尾），并把 width/height 属性一起补上
    //    —— 双写的原因：属性形式给「按属性判断」的 CSS 与 Word 导出器用，
    //       内联样式给「按 style 判断」的分支用，两边都能命中，避免任一侧失效。
    const newStyle = [...keptDecls, `width:${w}px`, `height:${h}px`].join(';')
    rest = rest.replace(/<img\b/i, `<img width="${w}" height="${h}" style="${newStyle}"`)
    // 4) 兜底：若原标签以 /> 结尾，保持自闭合形态（XHTML 风格，Word 里常见）
    return rest
  })

  if (!hit) {
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
  // 【v4.8.25 修复「从 Word/PPT/Excel 复制粘贴被自动转成图片 / 丢格式」】
  //   本次改动要点：
  //     ① 原来「图片文件优先」放在最前面 —— PPT/Excel 复制时剪贴板常常**同时**带
  //        `image/png`（整块截屏）和 `text/html`（真实表格），而 `cd.items` 的顺序
  //        并不保证 html 在前。旧逻辑一旦先命中 image 就 `return`，
  //        于是**表格被整块当成一张图片贴进来**（正是用户抱怨的"自动转成图片"）。
  //        现在改为：**先取 text/html，只有确实没有 HTML 才退化为图片/纯文本**。
  //     ② 补 `text/rtf` 分支：Excel / 部分 Word 场景只提供 RTF，旧实现直接走浏览器
  //        默认粘贴 → 粘成纯文本，表格与加粗全丢。
  //     ③ `text/plain` 也做一次「表格感」嗅探：Excel 复制出来的纯文本是
  //        `a\tb\tc\n1\t2\t3` 的制表符网格，转成 GFM 表格能保住结构。
  const html = cd.getData('text/html')
  const rtf = cd.getData('text/rtf') || (cd as any).getData('application/rtf') || ''
  const plain = cd.getData('text/plain')

  // 2) 富文本 HTML（Word / PPT / Excel / 网页复制）→ 转 Markdown 后插入
  //    【v4.8.16 重写】原实现把剪贴板的 HTML 原样塞进 content，引发三个连锁问题：
  //      · 题库卡片：HTML 表格无列宽约束 → 列被压成"竖排单字"；样式与 Markdown 题目不一致
  //      · Word 导出：导出器只认 Markdown，遇到 `<table><tbody><tr><td>` 原样写进文档 = 乱码
  //      · base64 图片：一段 Word 题面可达 60KB，撑爆存储与卡片布局
  //    现在统一走 htmlToMarkdown() 收敛成 Markdown，并在转换前把图片规整成可入库的 URL。
  if (html && html.trim()) {
    const cleaned = sanitizeHtml(html)
    if (isMeaningfulHtml(cleaned)) {
      e.preventDefault()
      try {
        // ① 图片路径分流：
        //    · base64 内联图 → 上传成短 URL（Word 粘贴的图都是这种）
        //    · 本地盘符路径（C:\…、file:///…）→ **丢弃**（浏览器读不到，落库就是乱码）
        const { html: withUrls, droppedLocal } = await normalizeInlineImages(cleaned)
        // ② HTML → Markdown（表格转 GFM 表格，strong→**，KaTeX span→$..$ 等）
        let md = htmlToMarkdown(withUrls)
        if (!md.trim()) md = htmlToMarkdown(cleaned)
        // ③ 取走转换器收集到的问题（如转换阶段又发现的本地盘符图）
        const issues = takeHtmlToMdIssues()
        const droppedInConvert = issues.find(i => i.type === 'localImageDropped')?.count || 0
        insertAtCursor(md)
        const dropped = droppedLocal + droppedInConvert
        if (dropped) {
          // 明确告知，而不是让用户几天后在 Word 里发现一堆路径文字
          ElMessage.warning(`已粘贴，但有 ${dropped} 张图片指向本地磁盘路径（浏览器无法读取），已自动移除。请用「上传图片」或截图后直接粘贴重新插入。`)
        } else {
          ElMessage.success('已粘贴并转为标准格式')
        }
      } catch (err: any) {
        // 转换失败不阻塞用户：退回纯文本粘贴，避免"粘贴后什么都没有"
        ElMessage.warning('粘贴内容解析失败，已按纯文本插入')
      }
      return
    }
  }

  // 3) RTF（Excel / 部分 Word 只给 RTF）→ 尽力提取纯文本与表格感
  if (rtf && rtf.trim()) {
    const fromRtf = rtfToMarkdown(rtf)
    if (fromRtf.trim()) {
      e.preventDefault()
      insertAtCursor(fromRtf)
      ElMessage.success('已粘贴并转为标准格式')
      return
    }
  }

  // 4) 纯文本：若呈「制表符网格」（Excel 复制特征）则转成 GFM 表格，
  //    否则交给浏览器默认粘贴（保持 Markdown 源码原样，不吞空格）
  if (plain && plain.trim()) {
    const asTable = tabGridToMd(plain)
    if (asTable) {
      e.preventDefault()
      insertAtCursor(asTable)
      ElMessage.success('已按表格粘贴')
      return
    }
  }

  // 5) 兜底：剪贴板里只有图片文件（截图 / 从图片复制）→ 上传入文
  for (const item of Array.from(cd.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (file) await uploadFile(file, 'image')
      return
    }
  }
  // 6) 其余（纯文本 / 代码）→ 走浏览器默认粘贴
}

/**
 * 【v4.8.25】按名字剥掉 RTF 目标组（支持嵌套花括号）
 *
 * RTF 的组形如 `{\fonttbl{\f0\fnil Arial;}}` —— 目标名紧跟 `{` 或 `{\*`，
 * 组体内部还可能再有若干层 `{...}`。正则的非贪婪匹配无法正确处理嵌套，
 * 因此这里手工做**括号配平扫描**：找到组起始后，逐字符计数 `{` / `}`，
 * 计数归零的位置就是组结束位置，整段删除。
 *
 * 同时处理 `\\*` 前缀（可忽略目标组标记）与未转义的 `\{` `\}`（不算配对）。
 */
function stripRtfGroup(src: string, names: string[]): string {
  const nameSet = new Set(names.map(n => n.toLowerCase()))

  /** 递归处理一段 RTF：命中黑名单的组整组丢弃，其余组**进入内部继续扫描** */
  const drop = (s: string): string => {
    let out = ''
    let i = 0
    while (i < s.length) {
      if (s[i] !== '{') { out += s[i]; i++; continue }
      // 1) 先找本组的配平结束位置（`\{` / `\}` 是转义字符，不参与配对）
      let depth = 0
      let k = i
      while (k < s.length) {
        const ch = s[k]
        if (ch === '\\' && (s[k + 1] === '{' || s[k + 1] === '}')) { k += 2; continue }
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { k++; break } }
        k++
      }
      const group = s.slice(i, k)
      // 2) 读组头名字
      //    ⚠️ 这里最容易写错：`{\fonttbl` 的形式是 `{` + `\` + `fonttbl`，
      //       必须先跳过那个反斜杠，否则读出来的是空名字 → 一个组都剥不掉
      //       （实测症状：字体表残留，表格首格变成 `Arial;姓名`）。
      let j = i + 1
      if (s[j] === '\\' && s[j + 1] === '*') j += 2   // `{\*\generator ...}`
      else if (s[j] === '\\') j += 1                  // `{\fonttbl ...}`
      let name = ''
      while (j < s.length && /[a-zA-Z]/.test(s[j])) { name += s[j]; j++ }
      // 3) 命中黑名单 → 整组丢弃
      if (name && nameSet.has(name.toLowerCase())) { i = k; continue }
      // 4) 未命中 → 保留花括号，递归处理组内（这样才能剥掉嵌套在 rtf1 里的 fonttbl）
      out += '{' + drop(group.slice(1, -1)) + '}'
      i = k
    }
    return out
  }

  return drop(src)
}

/**
 * 【v4.8.25】RTF → Markdown（轻量实现）
 *
 * 背景：Excel 与部分 Word 版本复制时**只提供 `text/rtf`**，旧实现直接落到浏览器默认粘贴，
 * 于是表格/加粗/换行全部丢失，用户看到「粘出来是一坨纯文本」。
 *
 * 策略：不做完整 RTF 解析器（RTF 规范过于庞大，且引入新依赖违反"全免费、不重构"原则），
 * 只做**够用的结构化提取**：
 *   · 剥掉控制字（`\word`）、控制符号（`\{` `\}` `\\`）、字体表/颜色表/样式表等目标块
 *   · `\par` / `\line` / `\row` → 换行；`\cell` → 制表符；`\tab` → 制表符
 *   · `\b ... \b0` → **粗体**
 * 提取出带制表符的纯文本后，复用 tabGridToMd() 还原表格。
 */
function rtfToMarkdown(rtf: string): string {
  let s = rtf
  // 【v4.8.25 修正】剥掉「不参与正文」的 RTF 目标组。
  //   ⚠️ 这些组是**嵌套**的：`{\fonttbl{\f0\fnil Arial;}}` 有两层花括号，
  //   原来用非贪婪 `[\s\S]*?\}\}` 只吃一层 → 残留 `Arial;` 混进正文
  //   （实测表格首格变成了 `Arial;姓名`）。这里改为**括号配平**扫描，一次吃干净。
  s = stripRtfGroup(s, ['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict',
    'generator', 'listtable', 'listoverridetable', 'rsidtbl',
    'latentstyles', 'datastore', 'themedata', 'colorschememapping'])
  // 其它 `{\*\...}` 自定义目标组
  s = s.replace(/\{\\\*\\[a-z]+[\s\S]*?\}/gi, '')
  // 转义序列 → 字面量
  s = s.replace(/\\([\\{}])/g, '$1')
  // 粗体开关 → Markdown
  s = s.replace(/\\b\s/g, '**').replace(/\\b0\s?/g, '**')
  s = s.replace(/\\i\s/g, '*').replace(/\\i0\s?/g, '*')
  // 结构控制字 → 文本
  s = s.replace(/\\row\b/g, '\n')
  s = s.replace(/\\cell\b/g, '\t')
  s = s.replace(/\\tab\b/g, '\t')
  s = s.replace(/\\(?:par|line)\b/g, '\n')
  // 十六进制转义 \'xx → 字符（按 latin1 近似即可，中文在 RTF 里通常是 \uN?）
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
  // Unicode 转义 \uNNNN? → 字符
  s = s.replace(/\\u(-?\d+)\s?\??/g, (_m, n) => String.fromCharCode(Number(n) < 0 ? Number(n) + 65536 : Number(n)))
  // 清掉剩余控制字与花括号
  s = s.replace(/\\[a-z]+-?\d*\s?/gi, '')
  s = s.replace(/[{}]/g, '')
  // 收尾：多余空行压平
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

  // 若提取结果呈制表符网格 → 转 GFM 表格；否则按普通文本返回
  return tabGridToMd(s) || s
}

/**
 * 【v4.8.25】制表符网格 → GFM 表格
 *
 * Excel / Numbers 复制出来的纯文本形如：
 *   `姓名\t语文\t数学\n张三\t90\t95\n`
 * 转换成 GFM 表格可保住行列结构，而不是压成一串带空格的文字。
 * 判据：至少 2 行，且**每行都含制表符**（避免把普通含 Tab 的文本误转）。
 */
function tabGridToMd(text: string): string {
  const raw = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (!raw.includes('\t')) return ''
  const lines = raw.split('\n').filter(l => l.trim() !== '')
  if (lines.length < 2) return ''
  // 必须每一行都有制表符，且列数 >= 2 —— 才认定是表格
  const grids = lines.map(l => l.split('\t'))
  if (!grids.every(g => g.length >= 2)) return ''
  const cols = Math.max(...grids.map(g => g.length))
  const norm = grids.map(g => {
    const c = g.map(x => x.trim().replace(/\|/g, '\\|'))
    while (c.length < cols) c.push('')
    return c
  })
  const head = norm[0]
  const body = norm.slice(1)
  return '\n\n'
    + `| ${head.join(' | ')} |\n`
    + `| ${Array(cols).fill('---').join(' | ')} |\n`
    + body.map(r => `| ${r.join(' | ')} |`).join('\n')
    + '\n\n'
}

/**
 * 【v4.9.0 重写】把 HTML 里的内联 base64 / 本地盘符图片规整成可入库的 URL。
 *
 * 【旧实现的两个硬伤】
 *   ① 正则 `<img\b[^>]*\bsrc="data:image/([a-zA-Z0-9.+-]+);base64,([^"]+)"[^>]*>`：
 *      · `[^>]*` 在 src **之前**是贪婪匹配，一旦前面的属性里含 `>`（或 `/>` 写法）
 *        就整体失配 → **整批 base64 图片一张都上传不了**，全部原样落库 →
 *        用户在 Word 导出时看到的就是几十 KB 的 base64 "乱码"。
 *      · 只认双引号 src，单引号 / 无引号的 Word 变体漏掉。
 *   ② 完全没处理**本地磁盘路径**（`file:///C:/…`、`C:\…`）—— 这是用户反馈的
 *      「图片成了带着 C 盘绝对路径的」来源。这种 URL 浏览器永远读不到，必须丢弃。
 *
 * 【新实现】交给 DOMParser 解析 DOM 再按属性判断，不再和 HTML 属性语法搏斗：
 *   · `data:image/*`   → 上传成真实 URL（失败则保留原 base64，宁可图大不可丢图）
 *   · 本地磁盘路径      → **删除该 <img>** 并计数（由调用方提示用户）
 *   · 其它 URL 原样保留（http/https/相对路径，交后续逻辑处理）
 *
 * @returns 规整后的 HTML 与丢弃的本地图片数
 */
async function normalizeInlineImages(html: string): Promise<{ html: string; droppedLocal: number }> {
  if (typeof document === 'undefined') return { html, droppedLocal: 0 }
  const host = document.createElement('div')
  host.innerHTML = html
  const imgs = Array.from(host.querySelectorAll('img'))
  if (!imgs.length) return { html, droppedLocal: 0 }

  let droppedLocal = 0
  // 逐张串行上传：并发上传长 base64 容易触发浏览器连接数排队，反而更慢；
  // 且串行能保证「哪张失败就保留哪张」的对应关系不串。
  let seq = 0
  for (const img of imgs) {
    const src = (img.getAttribute('src') || '').trim()
    if (!src) continue

    // ① 本地磁盘路径：浏览器读不到 → 丢弃（这是用户看到「C 盘路径」的元凶）
    if (isLocalDiskSrc(src)) {
      droppedLocal++
      img.remove()
      continue
    }

    // ② base64 内联图：上传成短 URL
    if (/^data:image\//i.test(src)) {
      const decoded = decodeDataImageUrl(src)
      if (!decoded) continue
      // 单图超过 12MB 跳过（浏览器端 canvas/请求体都会吃力）
      if (decoded.bytes.byteLength > 12 * 1024 * 1024) continue
      const ext = (decoded.mime.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg')
      const mime = `image/${ext === 'svg' ? 'svg+xml' : ext}`
      try {
        seq++
        const file = new File([decoded.bytes as any], `paste-${Date.now()}-${seq}.${ext}`, { type: mime })
        const r: any = await api.uploadImage(file)
        if (r?.url) { img.setAttribute('src', r.url); img.removeAttribute('srcset') }
      } catch {
        // 单张失败不影响其它图片与整体转换（保留 base64，至少不丢图）
      }
      continue
    }
    // ③ blob: / http(s) / 相对路径 → 原样保留
  }

  return { html: host.innerHTML, droppedLocal }
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
        <!-- 【v4.8.25】预览区改用全站统一容器 .zg-rich（与题库/详情/练习等展示位同款）
             —— 做到「编辑器所见 = 提交后所见」。原先用 .markdown-body，
             与展示端的 .q-content/.d-content 样式各写一套、互相缺项，
             是用户反馈「预览好好的、提交后不一样」的根因之一。 -->
        <div class="zg-preview-content zg-rich" v-html="previewHtml"></div>
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
/* 【v4.8.25】预览区样式改由全局 .zg-rich 提供（见 main.css），
   这里只保留字体/行高的微调，不再重复定义空白与块级规则 —— 避免两套样式打架。 */
.zg-preview-content { font-size: 15px; line-height: 1.8; }

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

<!--
  【v4.8.23】图片拖拽手柄的样式必须放在**非 scoped** 的全局块里。
  原因：手柄节点由原生 JS 动态创建（document.createElement），拿不到 Vue 编译出的
       `data-v-*` 作用域属性，scoped 样式会全部落空（实测 display 仍是 inline、
       position 仍是 static、宽高 0 → 完全点不到）。
  这里只放"纯装饰、可被覆盖"的部分（hover 描边、手柄外观兜底）；
  关键的定位/尺寸/显隐已在 decorateImages() 里写成内联样式，确保一定生效。
-->
<style>
.zg-img-box > img {
  display: block;
  max-width: 100%;
  transition: outline-color .15s ease;
}
/* hover 时给个淡金描边，提示"这张图可以拖" */
.zg-img-box:hover > img {
  outline: 2px solid rgba(245, 158, 11, 0.55);
  outline-offset: 1px;
}
.zg-img-handle:hover { transform: scale(1.15); }
/* 触屏设备没有 hover：手柄常显，否则根本拖不到 */
@media (hover: none) {
  .zg-img-handle { opacity: 1 !important; }
}
</style>
