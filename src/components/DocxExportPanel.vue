<script setup lang="ts">
// 【v4.10.0】Word 导出 · 对标组卷网深度重构
//  · 卷头：密封线装订区 + 表格式考生信息 + 独立「注意事项」框
//  · 大题标题规范：「一、单项选择题（本大题共 N 小题，共 M 分）」
//  · 选项智能排版：短选项横排（制表位对齐）、长选项/含公式图片自动逐行
//  · 页脚「第 X 页 共 Y 页」（Word 域，自动计算）
//  · 三套模板实体化差异（字号/行距/框线/密封线/须知/页脚）
//  · 答题卡专业化：考生信息填涂区 + 选择题区 + 非选择题区 + 缺考标记
//  · 产出面板自选：三份各自勾选，可分开下载或合并为单一 .docx
//
// 【兼容性承诺】props/emits 与下载文件名规则完全保持 v4.9.x 原样，
//   两处调用点（AssembleView / QuestionBankView）无需改动。
import { ref, reactive, computed } from 'vue'
// 【v4.5.3】docx 的 Math 组件必须重命名导入：它叫 Math，会覆盖全局 Math 对象，
// 导致 Math.max/min/round/floor 全部报错（TS2339）。统一别名 MathOMML。
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx'
import { saveAs } from 'file-saver'
// 【v4.9.1 内核统一】内容 → Word 的唯一实现在 `@/utils/docx-kit`，
//   导出器与「原卷分栏编辑」预览共用，保证「网站看到的 = 导出的」。
import {
  // 既有原语
  inlineRuns, mdToParagraphs, paperStyle, buildFooter, buildSealBlock,
  buildExamInfoTable, buildNoticeBox, layoutOptions,
  // 【v4.10.1】中文习惯字号表与换算
  CN_FONT_SIZES, ptToCnFontSize, cnFontSizeToPt,
  // 选项排版类型
  type OptionLayout,
} from '@/utils/docx-kit'
import { ElMessage } from 'element-plus'

const props = defineProps<{ subjectName: string; items: any[] }>()
const emit = defineEmits<{ (e: 'done'): void }>()

// ===== 预设方案（点选即回填整套参数）=====
interface Preset {
  key: string; label: string; desc: string
  cfg: Partial<typeof cfg>
}
const presets: Preset[] = [
  {
    key: 'formal', label: '正式考试卷', desc: '小四 · 密封线 · 须知 · 答题卡 · 页脚',
    cfg: { template: 'formal', fontSize: 12, twoColumn: false, withSeal: true, withAnswerSheet: true,
      withBlueprint: true, withAnswer: true, showNotice: true, showFooter: true, optionLayout: 'auto' },
  },
  {
    key: 'test', label: '日常测验卷', desc: '小四 · 紧凑排版 · 密封线 · 不含细目表',
    cfg: { template: 'test', fontSize: 12, twoColumn: false, withSeal: true, withAnswerSheet: true,
      withBlueprint: false, withAnswer: true, showNotice: true, showFooter: true, optionLayout: 'auto' },
  },
  {
    key: 'homework', label: '课后作业卷', desc: '五号 · 无密封线 · 无答题卡 · 无页脚',
    cfg: { template: 'homework', fontSize: 10.5, twoColumn: false, withSeal: false, withAnswerSheet: false,
      withBlueprint: false, withAnswer: true, showNotice: false, showFooter: false, optionLayout: 'auto' },
  },
]

const templates: Record<string, string> = { formal: '正式考试卷', test: '日常测验卷', homework: '课后作业卷' }

// ===== 【v4.10.1】中文习惯字号（号数 ↔ 磅值）=====
// 语文/数学中学试卷习惯用「初号 / 一号 / 小四 …… 八号」表述字号。
// 号数表与换算函数统一放在 `@/utils/docx-kit`（单一来源，探针可覆盖），
// 面板下拉直接选号数，「自定义」时可手填任意 pt，两种表述双向同步。

/** 字号下拉的选中值：能对上号数就用号数名，否则回落 'custom' */
const fontSizePreset = computed({
  get: () => ptToCnFontSize(cfg.fontSize) ?? 'custom',
  set: (v: string) => {
    if (v === 'custom') return
    const pt = cnFontSizeToPt(v)
    if (pt !== null) { cfg.fontSize = pt; markCustom() }
  },
})
/** 当前字号的完整表述，如「小四（12 pt）」*/
const fontSizeLabel = computed(() => {
  const n = ptToCnFontSize(cfg.fontSize)
  const pt = Number.isInteger(cfg.fontSize) ? String(cfg.fontSize) : cfg.fontSize.toFixed(1)
  return n ? `${n}（${pt} pt）` : `${pt} pt`
})

const cfg = reactive({
  title: `${props.subjectName} 测验卷`,
  school: '',
  grade: '',
  duration: 90,
  template: 'formal' as 'formal' | 'test' | 'homework',
  // 产出选择
  withAnswer: true,
  withAnswerSheet: true,
  withBlueprint: true,
  // 卷面
  withSeal: true,
  showNotice: true,
  showFooter: true,
  twoColumn: false,
  fontSize: 12,
  lineSpacing: 1.5,
  optionLayout: 'auto' as OptionLayout,
  // 输出方式
  mergeOutput: true,
})

const activePreset = ref('formal')
/** 导出中（防重复点击） */
const exporting = ref(false)
function applyPreset(p: Preset) {
  activePreset.value = p.key
  Object.assign(cfg, p.cfg)
}
function markCustom() { activePreset.value = 'custom' }

/** 产出份数（用于摘要与按钮文案） */
const outputCount = computed(() =>
  (1) + (cfg.withAnswer ? 1 : 0) + (cfg.withAnswerSheet ? 1 : 0))

const QTYPES = [
  { key: 'single', label: '单选题', short: '一、单项选择题' },
  { key: 'multiple', label: '多选题', short: '二、多项选择题' },
  { key: 'judge', label: '判断题', short: '三、判断题' },
  { key: 'fill', label: '填空题', short: '四、填空题' },
  { key: 'subjective', label: '主观题', short: '五、主观题' },
]

// ===== 【v4.8.19】外部图床图片无 CORS 头 → 走后端代理，失败记入此处供提示 =====
const externalImageFails: string[] = []

const scoreOf = (it: any) => Number(it.basketScore) || Number(it.score) || 5
const optLetter = (i: number) => 'ABCDEFGH'[i] || '?'

// ===== 双向细目表 =====
function buildBlueprint(items: any[], st: ReturnType<typeof paperStyle>): Table {
  const border = {
    top: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    bottom: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    left: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    right: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
  }
  const c = (children: any[]) => new TableCell({ borders: border, children })
  const P = (text: string, bold = false) => new Paragraph({
    children: [new TextRun({ text, size: 18, bold })],
    alignment: AlignmentType.CENTER,
  })
  const groups = QTYPES.map(q => {
    const list = items.filter(i => i.qtype === q.key)
    const pts = list.reduce((s, i) => s + scoreOf(i), 0)
    const kps = new Set<string>()
    list.forEach(i => (i.knowledge_points || []).forEach((k: any) => kps.add(k.name)))
    return { ...q, count: list.length, pts, kps: Array.from(kps).slice(0, 3).join('、') }
  }).filter(g => g.count > 0)
  const total = items.reduce((s, i) => s + scoreOf(i), 0)
  const header = new TableRow({
    tableHeader: true,
    children: ['大题', '题型', '题量', '分值', '占比', '主要知识点'].map(h => c([P(h, true)])),
  })
  const rows = groups.map(g => new TableRow({
    children: [
      c([P(g.short)]), c([P(g.label)]), c([P(String(g.count))]), c([P(String(g.pts))]),
      c([P(total ? ((g.pts / total) * 100).toFixed(0) + '%' : '0%')]), c([P(g.kps || '—')]),
    ],
  }))
  rows.push(new TableRow({
    children: [
      c([P('合计', true)]), c([P('—')]), c([P(String(items.length), true)]),
      c([P(String(total), true)]), c([P('100%')]), c([P('—')]),
    ],
  }))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] })
}

// ===== 卷头（专业版：密封线 + 信息表 + 须知框）=====
function paperHeader(title: string, st: ReturnType<typeof paperStyle>): any[] {
  const size = Math.round(cfg.fontSize * 2)   // pt → half-points
  const out: any[] = []
  const total = props.items.reduce((s, i) => s + scoreOf(i), 0)

  // 标题
  out.push(new Paragraph({
    children: [new TextRun({ text: title, bold: true, size: size + 8 })],
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
  }))

  // 副标题行：科目 / 满分 / 限时 / 题量
  out.push(new Paragraph({
    children: [new TextRun({
      text: `科目：${props.subjectName}　　满分：${total} 分　　时间：${cfg.duration} 分钟　　共 ${props.items.length} 题`,
      size: size - 1,
    })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 140 },
  }))

  // 考生信息表（表格式，对标组卷网）
  out.push(buildExamInfoTable([
    { label: '学校', value: cfg.school },
    { label: '年级/班级', value: cfg.grade },
    { label: '姓名', value: '' },
    { label: '考号', value: '' },
  ], st, size))
  out.push(new Paragraph({ text: '', spacing: { after: 60 } }))

  // 注意事项框
  if (cfg.showNotice && st.notice) {
    const notice = cfg.template === 'homework'
      ? ['请独立完成作业，书写工整。', '如有疑问请在课堂上提出。']
      : [
        '答题前请先填写学校、班级、姓名、考号。',
        '选择题用 2B 铅笔将答案填涂在答题卡对应位置。',
        '非选择题用黑色签字笔在答题卡指定区域内作答，超出答题区域无效。',
        '考试结束后，将试卷和答题卡一并交回。',
      ]
    out.push(buildNoticeBox(notice, st, size))
    out.push(new Paragraph({ text: '', spacing: { after: 80 } }))
  }

  // 密封线装订区（双栏模式下禁用：密封区会挤压栏宽）
  if (cfg.withSeal && st.seal && !cfg.twoColumn) {
    out.push(buildSealBlock(st, size))
    out.push(new Paragraph({ text: '', spacing: { after: 80 } }))
  }

  return out
}

// ===== 大题分组 + 连续编号 =====
async function buildQuestions(withAnswers: boolean): Promise<any[]> {
  const out: any[] = []
  let idx = 0
  const size = Math.round(cfg.fontSize * 2)
  for (const grp of QTYPES) {
    const list = props.items.filter(i => i.qtype === grp.key)
    if (!list.length) continue
    // 【v4.10.0】大题标题规范化：「一、单项选择题（本大题共 N 小题，共 M 分）」
    const sum = list.reduce((s, i) => s + scoreOf(i), 0)
    out.push(new Paragraph({
      children: [new TextRun({
        text: `${grp.short}（本大题共 ${list.length} 小题，共 ${sum} 分）`,
        bold: true, size: size + 1,
      })],
      spacing: { before: 200, after: 90 },
    }))
    for (const it of list) {
      idx++
      // 题号行：题号 + 题型 + 分值
      out.push(new Paragraph({
        children: [new TextRun({
          text: `${idx}.（${grp.label}，${scoreOf(it)}分）`,
          bold: true, size,
        })],
        spacing: { before: 80, after: 20 },
      }))
      out.push(...await mdToParagraphs(it.content || '', size, { indent: 360, spacingAfter: 30 }))
      // 【v4.10.0】选项走智能排版：短选项横排、长选项自动逐行
      // ⚠️ 必须传 qtype：否则「恰好两个选项的选择题」会被误当判断题，
      //   选项文本会被替换成「（  ）正确　（  ）错误」而整个丢失。
      const opts = await layoutOptions(it.options || [], size, cfg.optionLayout, it.qtype)
      out.push(...opts)
      if (withAnswers) {
        out.push(new Paragraph({
          children: await inlineRuns(`【答案】${it.answer || '（未填写）'}`, size, '【答案】'),
          indent: { left: 360 }, spacing: { before: 20, after: 14 },
        }))
        if (it.analysis) {
          out.push(new Paragraph({
            children: await inlineRuns(`【解析】${it.analysis}`, size, '【解析】'),
            indent: { left: 360 }, spacing: { after: 14 },
          }))
        }
      }
    }
  }
  return out
}

// ===== 专业答题卡 =====
function buildAnswerSheet(): any[] {
  const st = paperStyle(cfg.template)
  const size = Math.round(cfg.fontSize * 2)
  const border = {
    top: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    bottom: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    left: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    right: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
  }
  const out: any[] = []
  const total = props.items.reduce((s, i) => s + scoreOf(i), 0)

  // 标题
  out.push(new Paragraph({
    children: [new TextRun({ text: `${cfg.title} · 答题卡`, bold: true, size: size + 8 })],
    heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 120 },
  }))

  // 考生信息填涂区（含缺考标记，对标组卷网答题卡）
  const infoLines: any[][] = [
    [new Paragraph({ children: [new TextRun({ text: '学校：______________　　班级：______________　　姓名：______________　　考号：______________', size })] })],
    [new Paragraph({
      children: [
        new TextRun({ text: '缺考标记：', size, bold: true, color: 'C00000' }),
        new TextRun({ text: '□', size: size + 4, color: 'C00000' }),
        new TextRun({ text: '　（由监考员填涂，考生不得填涂）', size: size - 2, color: '808080' }),
      ],
    })],
  ]
  out.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [new TableCell({ borders: border, margins: { top: 100, bottom: 100, left: 140, right: 140 }, children: infoLines.flat() })],
    })],
  }))
  out.push(new Paragraph({ text: '', spacing: { after: 80 } }))

  // 填涂说明
  out.push(new Paragraph({
    children: [new TextRun({
      text: '填涂说明：请用 2B 铅笔将对应选项方框涂满、涂黑；修改时用橡皮擦净，不留痕迹。',
      size: size - 2, color: '666666',
    })],
    spacing: { after: 140 },
  }))

  // ===== 第一部分：选择题 =====
  const objective = props.items.filter(it => ['single', 'multiple', 'judge'].includes(it.qtype))
  const subjective = props.items.filter(it => !['single', 'multiple', 'judge'].includes(it.qtype))
  let idx = 0

  if (objective.length) {
    const sum = objective.reduce((s, i) => s + scoreOf(i), 0)
    out.push(new Paragraph({
      children: [new TextRun({ text: `第一部分　选择题（本大题共 ${objective.length} 小题，共 ${sum} 分）`, bold: true, size: size + 1 })],
      spacing: { before: 80, after: 90 },
    }))
    for (const it of objective) {
      idx++
      const opts: string[] = it.qtype === 'judge' ? ['正确', '错误'] : (it.options || []).map((_: any, i: number) => optLetter(i))
      const labelCell = new TableCell({
        borders: border,
        width: { size: 14, type: WidthType.PERCENTAGE },
        margins: { top: 40, bottom: 40, left: 60, right: 60 },
        children: [new Paragraph({ children: [new TextRun({ text: String(idx), size, bold: true })], alignment: AlignmentType.CENTER })],
      })
      const optCells = opts.map(o => new TableCell({
        borders: border,
        width: { size: Math.floor(86 / opts.length), type: WidthType.PERCENTAGE },
        margins: { top: 40, bottom: 40, left: 60, right: 60 },
        children: [new Paragraph({
          children: [
            new TextRun({ text: `${o} `, size }),
            new TextRun({ text: '□', size: size + 2 }),
          ],
          alignment: AlignmentType.CENTER,
        })],
      }))
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: [labelCell, ...optCells] })],
      }))
      out.push(new Paragraph({ text: '', spacing: { after: 20 } }))
    }
  }

  // ===== 第二部分：非选择题 =====
  if (subjective.length) {
    const sum = subjective.reduce((s, i) => s + scoreOf(i), 0)
    out.push(new Paragraph({
      children: [new TextRun({ text: `第二部分　非选择题（本大题共 ${subjective.length} 小题，共 ${sum} 分）`, bold: true, size: size + 1 })],
      spacing: { before: 200, after: 90 },
    }))
    for (const it of subjective) {
      idx++
      out.push(new Paragraph({
        children: [new TextRun({ text: `${idx}.（${scoreOf(it)}分）`, bold: true, size })],
        spacing: { before: 120, after: 40 },
      }))
      // 作答区：按分值给留白（4 分 → 4 行，8 分 → 7 行，上限 10 行）
      const rows = Math.min(10, Math.max(4, Math.round(scoreOf(it) * 0.9)))
      for (let r = 0; r < rows; r++) {
        out.push(new Paragraph({
          children: [new TextRun({ text: '　', size })],
          border: { bottom: { style: BorderStyle.DOTTED, size: 4, color: 'BBBBBB', space: 4 } },
          spacing: { after: 40 },
        }))
      }
      out.push(new Paragraph({ text: '', spacing: { after: 60 } }))
    }
  }

  out.push(new Paragraph({
    children: [new TextRun({ text: `本卷满分 ${total} 分`, size: size - 2, color: '808080' })],
    alignment: AlignmentType.RIGHT, spacing: { before: 140 },
  }))
  return out
}

// ===== 组装文档 =====
type Mode = 'student' | 'teacher' | 'sheet'

/** 单个交付物 → Document 实例（合并导出时作为独立 section 拼接） */
async function buildSection(mode: Mode): Promise<{ children: any[]; props: any }> {
  const st = paperStyle(cfg.template)
  const children: any[] = []
  if (mode === 'sheet') {
    children.push(...buildAnswerSheet())
  } else {
    const withAns = mode === 'teacher'
    children.push(...paperHeader(cfg.title, st))
    if (cfg.withBlueprint && cfg.template !== 'homework') {
      children.push(new Paragraph({
        children: [new TextRun({ text: '双向细目表', bold: true, size: Math.round(cfg.fontSize * 2) + 1 })],
        spacing: { before: 80, after: 60 },
      }))
      children.push(buildBlueprint(props.items, st))
      children.push(new Paragraph({ children: [new PageBreak()], spacing: { before: 120 } }))
    }
    children.push(...await buildQuestions(withAns))
  }
  const propsOut: any = {}
  if (cfg.twoColumn && mode !== 'sheet') propsOut.column = { count: 2, space: 360 }
  return { children, props: propsOut }
}

/** 本次要导出的模式列表 */
function activeModes(): Mode[] {
  const m: Mode[] = ['student']
  if (cfg.withAnswer) m.push('teacher')
  if (cfg.withAnswerSheet) m.push('sheet')
  return m
}

const MODE_LABEL: Record<Mode, string> = { student: '学生卷', teacher: '解析卷', sheet: '答题卡' }

/** 构建单个文件（分开下载用） */
async function buildSingleDoc(mode: Mode): Promise<Blob> {
  const st = paperStyle(cfg.template)
  const { children, props: secProps } = await buildSection(mode)
  const doc = new Document({
    sections: [{
      properties: secProps,
      ...(cfg.showFooter && st.footer ? { footers: { default: buildFooter({ leftText: cfg.title }) } } : {}),
      children,
    }],
  })
  return await Packer.toBlob(doc)
}

/**
 * 构建合并文件（多 section 同一 Document）。
 *
 * 【为何不用文档拼接】docx 9.7.1 未提供 `ExternalDocument`（已核实类型定义零命中），
 * 因此改用**多 section**方案：每个交付物作为一个 section，section 间自动分页。
 * 这是 docx 原生支持的做法，产物是标准单文件 .docx，无兼容性风险。
 */
async function buildMergedDoc(modes: Mode[]): Promise<Blob> {
  const st = paperStyle(cfg.template)
  const sections: any[] = []
  for (const mode of modes) {
    const { children, props: secProps } = await buildSection(mode)
    sections.push({
      properties: secProps,
      ...(cfg.showFooter && st.footer ? { footers: { default: buildFooter({ leftText: cfg.title }) } } : {}),
      children,
    })
  }
  const doc = new Document({ sections })
  return await Packer.toBlob(doc)
}

async function download(blob: Blob, name: string) { saveAs(blob, `${cfg.title}-${name}.docx`) }

async function onExport() {
  if (!props.items.length) { ElMessage.warning('试题篮为空'); return }
  if (exporting.value) return
  exporting.value = true
  try {
    externalImageFails.length = 0
    const modes = activeModes()
    const label = `Word（${modes.map(m => MODE_LABEL[m]).join('/')}）`
    if (cfg.mergeOutput) {
      const blob = await buildMergedDoc(modes)
      const stamp = new Date().toISOString().slice(0, 10)
      saveAs(blob, `${cfg.title}-${stamp}.docx`)
      ElMessage.success(`已生成 ${label}（合并为单一文件）`)
    } else {
      for (const mode of modes) {
        const blob = await buildSingleDoc(mode)
        await download(blob, MODE_LABEL[mode])
      }
      ElMessage.success(`已生成 ${label}`)
    }
    if (externalImageFails.length) {
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
  finally { exporting.value = false }
}
</script>

<template>
  <div class="export-panel">
    <!-- ===== 预设方案 ===== -->
    <div class="ep-section">
      <div class="ep-section-title">快速预设</div>
      <div class="ep-presets">
        <button
          v-for="p in presets" :key="p.key"
          type="button" class="ep-preset"
          :class="{ active: activePreset === p.key }"
          @click="applyPreset(p)"
        >
          <span class="ep-preset-label">{{ p.label }}</span>
          <span class="ep-preset-desc">{{ p.desc }}</span>
        </button>
        <div v-if="activePreset === 'custom'" class="ep-preset ep-preset-custom">
          <span class="ep-preset-label">自定义</span>
          <span class="ep-preset-desc">你已手动调整参数</span>
        </div>
      </div>
    </div>

    <!-- ===== 基本信息 ===== -->
    <div class="ep-section">
      <div class="ep-section-title">基本信息</div>
      <el-form label-position="top" @change="markCustom">
        <el-form-item label="试卷标题">
          <el-input v-model="cfg.title" placeholder="如：高一物理 第一次月考" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="12"><el-form-item label="学校"><el-input v-model="cfg.school" placeholder="如：XX 中学" /></el-form-item></el-col>
          <el-col :span="12"><el-form-item label="年级/班级"><el-input v-model="cfg.grade" placeholder="如：高一(3)班" /></el-form-item></el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="考试时长（分钟）">
              <el-input-number v-model="cfg.duration" :min="10" :max="300" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="试卷模板">
              <el-select v-model="cfg.template" style="width:100%">
                <el-option v-for="(l, v) in templates" :key="v" :value="v" :label="l" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
    </div>

    <!-- ===== 卷面结构 ===== -->
    <div class="ep-section">
      <div class="ep-section-title">卷面结构</div>
      <el-form label-position="top" @change="markCustom">
        <div class="ep-grid">
          <el-checkbox v-model="cfg.withSeal" :disabled="cfg.twoColumn">加密封线装订区</el-checkbox>
          <el-checkbox v-model="cfg.showNotice">加考生须知框</el-checkbox>
          <el-checkbox v-model="cfg.showFooter">加页脚页码</el-checkbox>
          <el-checkbox v-model="cfg.withBlueprint">生成双向细目表</el-checkbox>
          <el-checkbox v-model="cfg.twoColumn">双栏排版</el-checkbox>
        </div>
        <div v-if="cfg.twoColumn" class="ep-hint">双栏模式下密封线会自动禁用（避免挤压栏宽）。</div>
      </el-form>
    </div>

    <!-- ===== 输出设置 ===== -->
    <div class="ep-section">
      <div class="ep-section-title">输出设置</div>
      <el-form label-position="top" @change="markCustom">
        <div class="ep-grid">
          <el-checkbox v-model="cfg.withAnswer">解析卷（含答案+解析）</el-checkbox>
          <el-checkbox v-model="cfg.withAnswerSheet">专业答题卡</el-checkbox>
        </div>
        <el-form-item label="输出方式">
          <el-radio-group v-model="cfg.mergeOutput">
            <el-radio-button :value="true">合并为一个文件</el-radio-button>
            <el-radio-button :value="false">分开下载</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <div class="ep-hint">
          将生成 <b>{{ outputCount }}</b> 份内容：学生卷{{ cfg.withAnswer ? ' + 解析卷' : '' }}{{ cfg.withAnswerSheet ? ' + 答题卡' : '' }}。
          <template v-if="cfg.mergeOutput">合并模式下自动分页，便于统一打印。</template>
        </div>
      </el-form>
    </div>

    <!-- ===== 高级排版 ===== -->
    <div class="ep-section">
      <div class="ep-section-title">高级排版</div>
      <el-form label-position="top" @change="markCustom">
        <el-form-item label="正文字号">
          <div class="ep-fontsize">
            <el-select v-model="fontSizePreset" class="ep-fontsize-select" placeholder="选择字号">
              <el-option
                v-for="s in CN_FONT_SIZES" :key="s.name"
                :label="`${s.name}（${s.pt} pt）`" :value="s.name"
              />
              <el-option label="自定义…" value="custom" />
            </el-select>
            <el-input-number
              v-model="cfg.fontSize" :min="5" :max="42" :step="0.5"
              :precision="1" controls-position="right"
              class="ep-fontsize-num" @change="markCustom"
            />
          </div>
          <div class="ep-hint">
            当前：<b>{{ fontSizeLabel }}</b>。可直接选「小四/四号」这类习惯字号，也可在右侧填任意磅值（5 ~ 42 pt），两者双向同步。
          </div>
        </el-form-item>
        <el-form-item label="选择题选项排版">
          <el-radio-group v-model="cfg.optionLayout">
            <el-radio-button value="auto">自动（推荐）</el-radio-button>
            <el-radio-button value="inline">横排</el-radio-button>
            <el-radio-button value="block">逐行</el-radio-button>
          </el-radio-group>
          <div class="ep-hint">自动模式：短选项横排省版面，长选项或含公式/图片时自动逐行，避免挤成一团。</div>
        </el-form-item>
      </el-form>
    </div>

    <el-alert
      type="info" :closable="false" show-icon class="ep-note"
      title="Word 导出在浏览器端完成（docx.js，零成本）"
      description="公式导出为 Word 原生公式（可在 Word 中直接编辑）；图片自动压缩为 PNG 并等比缩放。复杂排版建议在网页端最终校对。"
    />

    <el-button
      type="primary" size="large" class="ep-submit"
      :disabled="!props.items.length" :loading="exporting"
      @click="onExport" icon="Download"
    >
      生成并下载 Word（{{ outputCount }} 份{{ cfg.mergeOutput ? ' · 合并' : '' }}）
    </el-button>
  </div>
</template>

<style scoped>
.export-panel { padding: 2px 4px 8px; max-height: 68vh; overflow-y: auto; }
.ep-section { margin-bottom: 18px; }
.ep-section-title {
  font-size: 13px; font-weight: 700; color: var(--el-text-color-primary);
  padding-left: 9px; margin-bottom: 10px;
  border-left: 3px solid var(--el-color-primary); line-height: 1.2;
}
.ep-presets { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.ep-preset {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start;
  padding: 10px 12px; border-radius: 8px; cursor: pointer; text-align: left;
  border: 1px solid var(--el-border-color); background: var(--el-fill-color-blank);
  transition: all .18s;
}
.ep-preset:hover { border-color: var(--el-color-primary-light-5); background: var(--el-fill-color-light); }
.ep-preset.active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); box-shadow: 0 0 0 1px var(--el-color-primary) inset; }
.ep-preset-custom { cursor: default; opacity: .85; }
.ep-preset-label { font-size: 13px; font-weight: 700; color: var(--el-text-color-primary); }
.ep-preset-desc { font-size: 11px; color: var(--el-text-color-secondary); line-height: 1.4; }
.ep-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 12px; margin-bottom: 6px; }
.ep-grid :deep(.el-checkbox) { margin-right: 0; height: 26px; }
.ep-hint { font-size: 11.5px; color: var(--el-text-color-secondary); line-height: 1.55; margin: 2px 0 8px; }
.ep-hint b { color: var(--el-color-primary); }
.ep-note { margin: 4px 0 14px; }
.ep-note :deep(.el-alert__title) { font-size: 12.5px; }
.ep-note :deep(.el-alert__description) { font-size: 11.5px; line-height: 1.6; }
/* 【v4.10.1】字号选择：左侧号数下拉 + 右侧磅值输入，双向同步 */
.ep-fontsize { display: flex; gap: 8px; width: 100%; align-items: center; }
.ep-fontsize-select { flex: 1 1 auto; min-width: 0; }
.ep-fontsize-num { flex: 0 0 128px; width: 128px; }
.ep-submit { width: 100%; }
.export-panel :deep(.el-form-item) { margin-bottom: 12px; }
.export-panel :deep(.el-form-item__label) { font-size: 12.5px; padding-bottom: 2px; }
@media (max-width: 640px) {
  .ep-presets { grid-template-columns: 1fr; }
  .ep-grid { grid-template-columns: 1fr; }
  .ep-fontsize { flex-direction: column; align-items: stretch; }
  .ep-fontsize-num { flex: 1 1 auto; width: 100%; }
  .export-panel { max-height: 60vh; }
}
</style>
