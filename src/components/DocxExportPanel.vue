<script setup lang="ts">
// 【v4.5.1】Word 导出（客户端 docx.js，免费可靠）：对标组卷网/智学网
//  · 卷头（校名/年级/科目/时间/满分）+ 注意事项 + 密封线
//  · 按题型大题分组、连续编号
//  · 双向细目表（题型/题量/分值/占比/主要知识点）
//  · 学生卷 / 解析卷（答案+解析）分离
//  · 专业答题卡（选择题填涂格 + 非选择作答区）
//  · 3 套模板真正生效、字号生效、公式(KaTeX→图)/图片尽力保留
import { ref, reactive } from 'vue'
// 【v4.5.3】docx 的 Math 组件必须重命名导入：它叫 Math，会覆盖全局 Math 对象，
// 导致 Math.max/min/round/floor 全部报错（TS2339）。统一别名 MathOMML。
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle, VerticalMergeType } from 'docx'
import { saveAs } from 'file-saver'
import { htmlToMarkdown, looksLikeHtml } from '@/utils/html-to-md'
// 【v4.9.1 内核统一】原先本组件自带一整套「Markdown → Word」实现（fetchImage /
//   latexToOmml / katexToImage / inlineRuns / mdToParagraphs / buildWordTableFromHtml …）。
//   而「Word 试卷导入 · 原卷分栏编辑」的预览又自己写了一套简版 —— 两套必然漂移，
//   正是用户抱怨「网站上看着好好的、导出就错乱」的根源。
//   现在全部收敛到 `@/utils/docx-kit` 单一实现：导出器与预览共用同一套代码。
import {
  fetchImage, katexToImage, latexToOmml, mdToParagraphs,
  buildWordTable, buildWordTableFromHtml, wordCell,
  inlineRuns, unescapeMd, cleanText, textRuns,
} from '@/utils/docx-kit'
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

// ===== 富文本 → docx 行内内容（尽力保留 公式/图片/加粗） =====
// 【v4.6.0 真修】题目中的图片导不出来，根因有两点：
//   ① 题库图片存为 /api/file/{id}（私有附件），fetchImage 之前不带 token 直取 → 后端 401，
//      被 catch 静默吞掉 → 图片整张丢失。现改为「先免 token 试取，失败再带 token 重试」。
//   ② ImageRun 的 transformation.height 被写成 'auto'（非法值）→ 图片高度 0，Word 不渲染。
//      现改为：拉到图片后用 canvas 归一化为 PNG，并取真实像素尺寸，按比例限制最大宽度。
//
// 【v4.8.19】外部图床图片（i.imgs.ovh 等）无 CORS 头 → 浏览器直连 fetch 必被拦。
//   改为**先走本站后端代理** /api/proxy-image（服务端抓取，无 CORS 限制），
//   代理也失败时才降级为 [图片] 占位，并把这个 url 记进 externalImageFails 供面板提示用户。
const externalImageFails: string[] = []

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

function mdPlain(md: string): string {
  return (md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`~]/g, '')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\$\$*([^$]+)\$\$*/g, '$1')
    .replace(/\n{2,}/g, '\n').trim()
}

// ===== 【v4.9.0】HTML 表格（含合并单元格）→ Word 真表格 =====
/**
 * 把保真存储的 HTML 表格片段还原成 Word 表格，**保留 rowspan / colspan**。
 *
 * 【为什么必须单开一条路】
 *   GFM 表格语法上表达不了合并单元格（规范硬限制），所以入库时含合并的表格被
 *   原样存成了 HTML 片段（见 html-to-md.ts 的 tableToMd）。导出时若只认 GFM，
 *   这段 HTML 会被当普通文本写进 Word —— 用户看到的就是「格式错乱」。
 *
 * 【rowspan → vMerge 的 Word 规则】
 *   docx 里纵向合并是「起始格 vMerge:'restart' + 后续被合并格 vMerge:'continue'」。
 *   因此要维护一个**跨行的待补队列**：遇到 rowspan:n 的单元格，就把它后面 n-1 行
 *   的同一列位置标记为需要继续合并。colspan 则直接映射为 gridSpan（同一行内合并）。
 *
 * 时间/空间复杂度都是 O(单元格数)，与表格规模线性相关。
 */
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
      // 【v4.7.0】题干序号单独成行（加粗），题干内容用 mdToParagraphs 解析 markdown（标题/列表/换行→合理 Word 字号样式）
      out.push(new Paragraph({ children: [new TextRun({ text: `${idx}.（${grp.label}）(${scoreOf(it)}分)`, bold: true, size })], spacing: { before: 80, after: 20 } }))
      out.push(...await mdToParagraphs(it.content || '', size, { indent: 360, spacingAfter: 30 }))
      for (const o of (it.options || [])) out.push(new Paragraph({ children: await inlineRuns(`${optLetter((it.options || []).indexOf(o))}. ${o}`, size), indent: { left: 360 }, spacing: { after: 14 } }))
      if (withAnswers) {
        // 【v4.5.3】答案/解析改用 inlineRuns：保留 KaTeX 公式（转图片）与行内图片；【v4.7.0】inlineRuns 已保留换行
        out.push(new Paragraph({ children: await inlineRuns(`【答案】${it.answer || '（未填写）'}`, size, '【答案】'), indent: { left: 360 }, spacing: { before: 20, after: 14 } }))
        if (it.analysis) out.push(new Paragraph({ children: await inlineRuns(`【解析】${it.analysis}`, size, '【解析】'), indent: { left: 360 }, spacing: { after: 14 } }))
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
    // 【v4.8.19】每次导出前清空外链图失败记录，导出后统一提示
    externalImageFails.length = 0
    const student = await buildDoc('student'); await download(student, '学生卷')
    if (cfg.withAnswer) { const t = await buildDoc('teacher'); await download(t, '解析卷') }
    if (cfg.withAnswerSheet) { const s = await buildDoc('sheet'); await download(s, '答题卡') }
    ElMessage.success('已生成 Word（学生卷/解析卷/答题卡）')
    if (externalImageFails.length) {
      // 逐条提示最多 3 条，避免弹窗爆炸
      const shown = externalImageFails.slice(0, 3).map(u => {
        try { return new URL(u).host } catch { return u.slice(0, 40) }
      })
      ElMessage.warning({
        duration: 8000,
        dangerouslyUseHTMLString: false,
        message: `有 ${externalImageFails.length} 张外部图片未能下载（${shown.join('、')}${externalImageFails.length > 3 ? ' 等' : ''}），Word 中已用「[图片]」占位。建议先把这些图片重新上传到本站再导出。`,
      })
    }
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
        description="Word 导出在浏览器端完成，使用免费开源库 docx.js，零成本。公式导出为 Word 原生公式（OMML），可直接在 Word 中编辑；复杂排版建议在网页端最终校对。" />
      <el-button type="primary" :disabled="!props.items.length" @click="onExport" icon="Download">生成并下载 Word</el-button>
    </el-form>
  </div>
</template>

<style scoped>
.export-panel { padding: 4px; }
.fs-hint { margin-left: 10px; color: #b06a00; font-weight: 700; }
</style>
