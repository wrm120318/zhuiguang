<script setup lang="ts">
// 【v4.5.1】Word 导出（客户端 docx.js，免费可靠）：对标组卷网/智学网
//  · 卷头（校名/年级/科目/时间/满分）+ 注意事项 + 密封线
//  · 按题型大题分组、连续编号
//  · 双向细目表（题型/题量/分值/占比/主要知识点）
//  · 学生卷 / 解析卷（答案+解析）分离
//  · 专业答题卡（选择题填涂格 + 非选择作答区）
//  · 3 套模板真正生效、字号生效、公式(KaTeX→图)/图片尽力保留
import { ref, reactive } from 'vue'
import { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, HeadingLevel, PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle } from 'docx'
import { saveAs } from 'file-saver'
import katex from 'katex'
import { API_BASE } from '@/utils/helpers'
import { ElMessage } from 'element-plus'

const props = defineProps<{ subjectName: string; items: any[] }>()
const emit = defineEmits<{ (e: 'done'): void }>()

const templates: Record<string, string> = { formal: '正式考试卷', test: '日常测验卷', homework: '课后作业卷' }

const cfg = reactive({
  title: `${props.subjectName} 测验卷`,
  school: '',
  grade: '',
  duration: 90,
  template: 'formal' as 'formal' | 'test' | 'homework',
  withAnswer: true,
  withAnswerSheet: true,
  withBlueprint: true,
  withSeal: true,
  twoColumn: false,
  fontSize: 12,
})

const QTYPES = [
  { key: 'single', label: '单选题', short: '一、单项选择题' },
  { key: 'multiple', label: '多选题', short: '二、多项选择题' },
  { key: 'judge', label: '判断题', short: '三、判断题' },
  { key: 'fill', label: '填空题', short: '四、填空题' },
  { key: 'subjective', label: '主观题', short: '五、主观题' },
]

// ===== 工具 =====
function cellBorder() {
  return { top: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' } }
}
function cell(children: any[], widthPct?: number): TableCell {
  return new TableCell({ borders: cellBorder(), width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined, children })
}
function P(text: string, size = cfg.fontSize, extra: any = {}): Paragraph {
  const { bold, ...rest } = extra
  return new Paragraph({ children: [new TextRun({ text, size, bold })], ...rest })
}
const scoreOf = (it: any) => Number(it.basketScore) || Number(it.score) || 5
const optLetter = (i: number) => 'ABCDEFGH'[i] || '?'

// ===== 富文本 → docx 行内内容（尽力保留 公式/图片/加粗） =====
async function fetchImage(url: string): Promise<{ data: ArrayBuffer; type: 'png' | 'jpg' } | null> {
  try {
    const abs = url.startsWith('http') ? url : API_BASE + url
    const r = await fetch(abs)
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    const ext = (url.split('?')[0].split('.').pop() || 'png').toLowerCase()
    return { data: buf, type: ext === 'jpg' || ext === 'jpeg' ? 'jpg' : 'png' }
  } catch { return null }
}

let _katexCss = ''
function collectKatexCss() {
  if (_katexCss) return _katexCss
  try {
    for (const ss of Array.from(document.styleSheets)) {
      let rules: any[] = []
      try { rules = Array.from(ss.cssRules) } catch { continue }
      for (const rule of rules) { const t = (rule as any).cssText || ''; if (t.includes('katex')) _katexCss += t + '\n' }
    }
  } catch { /* ignore */ }
  return _katexCss
}
async function katexToImage(tex: string): Promise<{ data: ArrayBuffer; type: 'png'; w: number; h: number } | null> {
  try {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-99999px;top:0;background:#fff;padding:2px;'
    document.body.appendChild(host)
    katex.render(tex, host, { throwOnError: false, displayMode: false })
    const ke = host.querySelector('.katex') as HTMLElement
    if (!ke) { document.body.removeChild(host); return null }
    const w = Math.max(ke.offsetWidth, 12), h = Math.max(ke.offsetHeight, 12)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><style>${collectKatexCss()}</style><foreignObject x="0" y="0" width="${w}" height="${h}">${ke.outerHTML}</foreignObject></svg>`
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const u = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = u })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = w * scale; canvas.height = h * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) { URL.revokeObjectURL(u); document.body.removeChild(host); return null }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    URL.revokeObjectURL(u); document.body.removeChild(host)
    if (!png) return null
    return { data: await png.arrayBuffer(), type: 'png', w: Math.min(w, 360), h: Math.round(h * Math.min(w, 360) / w) }
  } catch { return null }
}

const INLINE_RE = /(\$\$[\s\S]+?\$\$)|(\$[^$\n]+?\$)|(\!\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)/g
async function inlineRuns(text: string, size: number): Promise<any[]> {
  const runs: any[] = []
  let last = 0, m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index), size }))
    const t = m[0]
    if (t.startsWith('$') && t.length > 2) {
      const tex = t.replace(/^\$\$?|\$\$?$/g, '').trim()
      const img = await katexToImage(tex)
      if (img) runs.push(new ImageRun({ data: img.data, type: 'png', transformation: { width: img.w, height: img.h } }))
      else runs.push(new TextRun({ text: ` ${tex} `, size, italics: true }))
    } else if (t.startsWith('![')) {
      const url = (t.match(/\(([^)]+)\)/) || [])[1]
      if (url) { const img = await fetchImage(url); if (img) runs.push(new ImageRun({ data: img.data, type: img.type, transformation: { width: 360, height: 'auto' as any } })) }
    } else if (t.startsWith('**')) {
      runs.push(new TextRun({ text: t.slice(2, -2), size, bold: true }))
    }
    last = INLINE_RE.lastIndex
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last), size }))
  return runs.length ? runs : [new TextRun({ text, size })]
}
function mdPlain(md: string): string {
  return (md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`~]/g, '')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\$\$*([^$]+)\$\$*/g, '$1')
    .replace(/\n{2,}/g, '\n').trim()
}

// ===== 双向细目表 =====
function buildBlueprint(items: any[]): Table {
  const groups = QTYPES.map(q => {
    const list = items.filter(i => i.qtype === q.key)
    const pts = list.reduce((s, i) => s + scoreOf(i), 0)
    const kps = new Set<string>()
    list.forEach(i => (i.knowledge_points || []).forEach((k: any) => kps.add(k.name)))
    return { ...q, count: list.length, pts, kps: Array.from(kps).slice(0, 3).join('、') }
  }).filter(g => g.count > 0)
  const total = items.reduce((s, i) => s + scoreOf(i), 0)
  const header = new TableRow({ tableHeader: true, children: ['大题', '题型', '题量', '分值', '占比', '主要知识点'].map(h => cell([P(h, 9, { bold: true })])) })
  const rows = groups.map(g => new TableRow({ children: [
    cell([P(g.short, 9)]), cell([P(g.label, 9)]), cell([P(String(g.count), 9)]), cell([P(String(g.pts), 9)]),
    cell([P(total ? ((g.pts / total) * 100).toFixed(0) + '%' : '0%', 9)]), cell([P(g.kps || '—', 9)]),
  ] }))
  rows.push(new TableRow({ children: [
    cell([P('合计', 9, { bold: true })]), cell([P('—', 9)]), cell([P(String(items.length), 9, { bold: true })]),
    cell([P(String(total), 9, { bold: true })]), cell([P('100%', 9)]), cell([P('—', 9)]),
  ] }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] })
}

// ===== 卷头 + 注意事项 + 密封线 =====
function paperHeader(title: string): Paragraph[] {
  const out: Paragraph[] = []
  out.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 80 } }))
  const total = props.items.reduce((s, i) => s + scoreOf(i), 0)
  out.push(P(`${cfg.school || '学校'}：__________　${cfg.grade || '年级/班级'}：__________　姓名：__________　学号：__________`, cfg.fontSize, { alignment: AlignmentType.CENTER, spacing: { after: 40 } }))
  out.push(P(`科目：${props.subjectName}　满分：${total} 分　限时：${cfg.duration} 分钟　共 ${props.items.length} 题`, cfg.fontSize, { alignment: AlignmentType.CENTER, spacing: { after: 120 } }))
  if (cfg.template !== 'homework') {
    out.push(P('注意事项：1. 答题前请先填写学校、班级、姓名、学号。2. 选择题用 2B 铅笔将答案填涂在答题卡对应位置。3. 非选择题用黑色签字笔在答题卡上作答。', cfg.fontSize - 1, { spacing: { after: 60 } }))
  }
  if (cfg.withSeal && (cfg.template === 'formal' || cfg.template === 'test')) {
    out.push(P('┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ 装 订 线 内 不 得 答 题 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄', cfg.fontSize - 2, { alignment: AlignmentType.CENTER, color: '999999', spacing: { after: 120 } }))
  }
  return out
}

// ===== 大题分组 + 连续编号 =====
async function buildQuestions(withAnswers: boolean): Promise<Paragraph[]> {
  const out: Paragraph[] = []
  let idx = 0
  const size = cfg.fontSize
  for (const grp of QTYPES) {
    const list = props.items.filter(i => i.qtype === grp.key)
    if (!list.length) continue
    out.push(P(`${grp.short}（每题 ${scoreOf(list[0])} 分，共 ${list.length} 题）`, size + 1, { bold: true, spacing: { before: 160, after: 80 } }))
    for (const it of list) {
      idx++
      out.push(new Paragraph({
        children: [new TextRun({ text: `${idx}.（${grp.label}）`, bold: true, size }), new TextRun({ text: ` ${mdPlain(it.content)}（${scoreOf(it)}分）`, size })],
        spacing: { before: 80, after: 30 },
      }))
      for (const o of (it.options || [])) out.push(new Paragraph({ children: await inlineRuns(`${optLetter((it.options || []).indexOf(o))}. ${o}`, size), indent: { left: 360 }, spacing: { after: 14 } }))
      if (withAnswers) {
        out.push(new Paragraph({ children: [new TextRun({ text: `【答案】${mdPlain(it.answer)}`, size, bold: true })], indent: { left: 360 }, spacing: { before: 20, after: 14 } }))
        if (it.analysis) out.push(P(`【解析】${mdPlain(it.analysis)}`, size, { indent: { left: 360 }, spacing: { after: 14 } }))
      }
    }
  }
  return out
}

// ===== 专业答题卡 =====
function buildAnswerSheet(): any[] {
  const out: any[] = []
  out.push(new Paragraph({ text: `${cfg.title} · 答题卡`, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 60 } }))
  out.push(P('班级：__________ 姓名：__________ 学号：__________', cfg.fontSize, { spacing: { after: 40 } }))
  out.push(P('填涂说明：请用 2B 铅笔将对应选项方框涂满；修改时用橡皮擦净。', cfg.fontSize - 1, { spacing: { after: 120 } }))
  const size = cfg.fontSize
  let idx = 0
  for (const it of props.items) {
    idx++
    if (['single', 'multiple', 'judge'].includes(it.qtype)) {
      const opts: string[] = it.qtype === 'judge' ? ['正确', '错误'] : (it.options || []).map((_: any, i: number) => optLetter(i))
      const cells = [
        cell([P(String(idx), 9)], 12),
        ...opts.map(o => cell([P(String(o), 9, { alignment: AlignmentType.CENTER })], Math.floor(88 / opts.length))),
      ]
      out.push(new Paragraph({ text: '', spacing: { after: 20 } }))
      out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: cells })] }))
    } else {
      out.push(P(`${idx}.（${scoreOf(it)}分）`, size, { spacing: { before: 60, after: 20 } }))
      out.push(P('答：________________________________________________________________________', size, { spacing: { after: 80 } }))
    }
  }
  return out
}

// ===== 组装文档 =====
async function buildDoc(mode: 'student' | 'teacher' | 'sheet'): Promise<Blob> {
  const children: any[] = []
  if (mode === 'sheet') {
    children.push(...buildAnswerSheet())
  } else {
    const withAns = mode === 'teacher'
    children.push(...paperHeader(cfg.title))
    if (cfg.withBlueprint) { children.push(P('双向细目表', cfg.fontSize + 1, { bold: true, spacing: { before: 80, after: 40 } }), buildBlueprint(props.items)); children.push(new Paragraph({ children: [new PageBreak()], spacing: { before: 120 } })) }
    children.push(...await buildQuestions(withAns))
  }
  const doc = new Document({
    sections: [{
      properties: cfg.twoColumn && mode !== 'sheet' ? { column: { count: 2, space: 360 } } : {},
      children,
    }],
  })
  return await Packer.toBlob(doc)
}

async function download(blob: Blob, name: string) { saveAs(blob, `${cfg.title}-${name}.docx`) }

async function onExport() {
  if (!props.items.length) { ElMessage.warning('试题篮为空'); return }
  try {
    const student = await buildDoc('student'); await download(student, '学生卷')
    if (cfg.withAnswer) { const t = await buildDoc('teacher'); await download(t, '解析卷') }
    if (cfg.withAnswerSheet) { const s = await buildDoc('sheet'); await download(s, '答题卡') }
    ElMessage.success('已生成 Word（学生卷/解析卷/答题卡）')
    emit('done')
  } catch (e: any) { ElMessage.error('生成失败：' + (e?.message || e)) }
}
</script>

<template>
  <div class="export-panel">
    <el-form label-position="top">
      <el-form-item label="试卷标题"><el-input v-model="cfg.title" /></el-form-item>
      <el-row :gutter="10">
        <el-col :span="12"><el-form-item label="学校"><el-input v-model="cfg.school" placeholder="如：XX 中学" /></el-form-item></el-col>
        <el-col :span="12"><el-form-item label="年级/班级"><el-input v-model="cfg.grade" placeholder="如：高一(3)班" /></el-form-item></el-col>
      </el-row>
      <el-form-item label="考试时长（分钟）"><el-input-number v-model="cfg.duration" :min="10" :max="300" /></el-form-item>
      <el-form-item label="试卷模板">
        <el-radio-group v-model="cfg.template">
          <el-radio-button v-for="(l, v) in templates" :key="v" :value="v">{{ l }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="导出选项">
        <el-checkbox v-model="cfg.withAnswer">生成解析卷（含答案+解析）</el-checkbox><br />
        <el-checkbox v-model="cfg.withAnswerSheet">附加专业答题卡</el-checkbox>
        <el-checkbox v-model="cfg.withBlueprint">生成双向细目表</el-checkbox>
        <el-checkbox v-model="cfg.withSeal">加密封线（正式/测验卷）</el-checkbox>
        <el-checkbox v-model="cfg.twoColumn">双栏排版</el-checkbox>
      </el-form-item>
      <el-form-item label="字号"><el-slider v-model="cfg.fontSize" :min="10" :max="16" /> <span class="fs-hint">{{ cfg.fontSize }}pt</span></el-form-item>
      <el-alert type="info" :closable="false" title="说明"
        description="Word 导出在浏览器端完成，使用免费开源库 docx.js，零成本。公式通过 KaTeX 渲染为图片、图片内嵌进文档；复杂排版建议在网页端最终校对。" />
      <el-button type="primary" :disabled="!props.items.length" @click="onExport" icon="Download">生成并下载 Word</el-button>
    </el-form>
  </div>
</template>

<style scoped>
.export-panel { padding: 4px; }
.fs-hint { margin-left: 10px; color: #b06a00; font-weight: 700; }
</style>
