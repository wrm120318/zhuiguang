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

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const viewMode = ref<'edit' | 'preview' | 'split'>('split')
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

onMounted(() => {
  ensureKatexCss()
  document.addEventListener('keydown', handleKeyDown)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeyDown)
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
function insertMention() {
  const uid = window.prompt('请输入用户 ID（数字）：', '1')
  const name = window.prompt('请输入用户显示名：', '某某')
  if (!uid || !name) return
  insertAtCursor(`@[${name}](/user/${uid}) `)
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
      insertAtCursor(`\n![${file.name}](${url})\n\n`)
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
  // 2) 复制的是富文本 HTML → 识别为 HTML 源码插入，避免浏览器按 text/plain
  //    把标签全脱掉、粘进来成了纯文本（历史根因）
  const html = cd.getData('text/html')
  if (html && html.trim()) {
    const cleaned = sanitizeHtml(html)
    if (isMeaningfulHtml(cleaned)) {
      e.preventDefault()
      insertAtCursor(normalizeClipboardHtml(cleaned))
      ElMessage.success('已识别为 HTML 并插入，可在预览中查看效果')
      return
    }
  }
  // 3) 纯文本 / 代码 → 走浏览器默认粘贴
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

// 归一化粘贴 HTML 的换行符（剪贴板常见 \r\n）
function normalizeClipboardHtml(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim()
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
  <div class="zg-editor" :class="{ fullscreen }">
    <div class="zg-editor-bar">
      <div class="zg-tools">
        <template v-for="(t, i) in tools" :key="i">
          <span v-if="t.group" class="zg-tool-group">{{ t.group }}</span>
          <button v-else class="zg-tool" :title="t.tip" @click="t.action" v-html="t.name"></button>
        </template>
      </div>
      <div class="zg-viewmode">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button label="edit">编辑</el-radio-button>
          <el-radio-button label="split">分屏</el-radio-button>
          <el-radio-button label="preview">预览</el-radio-button>
        </el-radio-group>
        <button class="zg-tool" @click="toggleFullscreen" :title="fullscreen ? '退出全屏' : '全屏'">
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
      <div v-show="viewMode !== 'edit'" class="zg-preview-pane">
        <div class="zg-preview-content markdown-body" v-html="previewHtml"></div>
      </div>
    </div>

    <input ref="fileInputRef" type="file" accept="image/*" multiple style="display:none" @change="onFilePicked" />

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
</style>
