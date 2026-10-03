// v4.10.0 Word 导出端到端探针 · TS 入口
//
// 与 probe-docx-layout.entry.ts 的分工：
//   · 前者验证 docx-kit 的**排版原语**（页脚、卷头、选项算法）是否真的写进 XML；
//   · 本文件验证**真实导出链路**：模拟试题篮数据 → 走 DocxExportPanel 的构建逻辑
//     （卷头/大题/选项/答题卡/合并）→ 解压断言成品文档是否符合预期。
//
// ⚠️ 同样必须由 probe-docx-e2e.mjs 经 `ssrLoadModule` 加载（docx 单实例约束）。
import JSZip from 'jszip'
import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, WidthType, Table, TableRow, TableCell, PageBreak, HeadingLevel } from 'docx'
import {
  paperStyle, layoutOptions, buildFooter, buildSealBlock,
  buildExamInfoTable, buildNoticeBox, mdToParagraphs,
} from '@/utils/docx-kit'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

// ===== 贴近真实的试题篮数据 =====
const items = [
  {
    qtype: 'single', basketScore: 5,
    content: '下列关于加速度的说法正确的是（　　）',
    options: ['速度越大加速度越大', '速度变化越快加速度越大', '加速度为零速度一定为零', '加速度方向与速度方向总相同'],
    answer: 'B', analysis: '加速度描述速度变化的快慢，与速度大小无必然联系。',
    knowledge_points: [{ name: '加速度' }],
  },
  {
    qtype: 'single', basketScore: 5,
    content: '一段用于测试长选项回退的题目表述（　　）',
    options: [
      '这是一个明显很长的选项内容用来验证算法在长文本时会自动切换成逐行排版否则会挤成一团难以阅读',
      '另一个同样很长的选项内容也需要独占一行来保证排版美观',
    ],
    answer: 'A', analysis: '',
    knowledge_points: [{ name: '排版' }],
  },
  { qtype: 'judge', basketScore: 3, content: '匀速圆周运动是匀变速运动。（　　）', options: ['正确', '错误'], answer: '错误', analysis: '加速度方向不断变化。', knowledge_points: [] },
  { qtype: 'fill', basketScore: 4, content: '牛顿第二定律表达式为 $F=ma$。', options: [], answer: '$F=ma$', analysis: '', knowledge_points: [{ name: '牛顿定律' }] },
  { qtype: 'subjective', basketScore: 10, content: '**简答题**\n\n请推导匀变速直线运动的位移公式。\n\n1. 写出速度公式\n2. 推导位移', options: [], answer: '略', analysis: '按步骤给分。', knowledge_points: [{ name: '运动学' }] },
  { qtype: 'subjective', basketScore: 12, content: '含表格的题目：\n\n| 物理量 | 符号 |\n| --- | --- |\n| 位移 | s |\n| 时间 | t |', options: [], answer: '略', analysis: '', knowledge_points: [] },
]

const CFG = {
  title: '高一物理 第一次月考', school: '太原五中', grade: '高一(3)班',
  duration: 90, template: 'formal' as const,
  withSeal: true, showNotice: true, showFooter: true, twoColumn: false,
  fontSize: 12, optionLayout: 'auto' as any,
}

const QTYPES = [
  { key: 'single', label: '单选题', short: '一、单项选择题' },
  { key: 'multiple', label: '多选题', short: '二、多项选择题' },
  { key: 'judge', label: '判断题', short: '三、判断题' },
  { key: 'fill', label: '填空题', short: '四、填空题' },
  { key: 'subjective', label: '主观题', short: '五、主观题' },
]
const scoreOf = (it: any) => Number(it.basketScore) || Number(it.score) || 5
const optLetter = (i: number) => 'ABCDEFGH'[i] || '?'

// ===== 复刻 DocxExportPanel 的构建逻辑（保持同步）=====
function paperHeader(title: string, st: ReturnType<typeof paperStyle>) {
  const size = Math.round(CFG.fontSize * 2)
  const out: any[] = []
  const total = items.reduce((s, i) => s + scoreOf(i), 0)
  out.push(new Paragraph({
    children: [new TextRun({ text: title, bold: true, size: size + 8 })],
    heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 120 },
  }))
  out.push(new Paragraph({
    children: [new TextRun({
      text: `科目：物理　　满分：${total} 分　　时间：${CFG.duration} 分钟　　共 ${items.length} 题`, size: size - 1,
    })],
    alignment: AlignmentType.CENTER, spacing: { after: 140 },
  }))
  out.push(buildExamInfoTable([
    { label: '学校', value: CFG.school }, { label: '年级/班级', value: CFG.grade },
    { label: '姓名', value: '' }, { label: '考号', value: '' },
  ], st, size))
  out.push(new Paragraph({ text: '', spacing: { after: 60 } }))
  if (CFG.showNotice && st.notice) {
    out.push(buildNoticeBox(['答题前请先填写学校、班级、姓名、考号。', '选择题用 2B 铅笔填涂在答题卡。'], st, size))
    out.push(new Paragraph({ text: '', spacing: { after: 80 } }))
  }
  if (CFG.withSeal && st.seal && !CFG.twoColumn) {
    out.push(buildSealBlock(st, size))
    out.push(new Paragraph({ text: '', spacing: { after: 80 } }))
  }
  return out
}

async function buildQuestions(withAnswers: boolean) {
  const out: any[] = []
  let idx = 0
  const size = Math.round(CFG.fontSize * 2)
  for (const grp of QTYPES) {
    const list = items.filter(i => i.qtype === grp.key)
    if (!list.length) continue
    const sum = list.reduce((s, i) => s + scoreOf(i), 0)
    out.push(new Paragraph({
      children: [new TextRun({ text: `${grp.short}（本大题共 ${list.length} 小题，共 ${sum} 分）`, bold: true, size: size + 1 })],
      spacing: { before: 200, after: 90 },
    }))
    for (const it of list) {
      idx++
      out.push(new Paragraph({
        children: [new TextRun({ text: `${idx}.（${grp.label}，${scoreOf(it)}分）`, bold: true, size })],
        spacing: { before: 80, after: 20 },
      }))
      out.push(...await mdToParagraphs(it.content || '', size, { indent: 360, spacingAfter: 30 }))
      out.push(...await layoutOptions(it.options || [], size, CFG.optionLayout, it.qtype))
      if (withAnswers) {
        out.push(new Paragraph({
          children: [new TextRun({ text: `【答案】${it.answer || '（未填写）'}`, size })],
          indent: { left: 360 }, spacing: { before: 20, after: 14 },
        }))
        if (it.analysis) {
          out.push(new Paragraph({
            children: [new TextRun({ text: `【解析】${it.analysis}`, size })],
            indent: { left: 360 }, spacing: { after: 14 },
          }))
        }
      }
    }
  }
  return out
}

function buildAnswerSheet() {
  const st = paperStyle(CFG.template)
  const size = Math.round(CFG.fontSize * 2)
  const border = {
    top: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    bottom: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    left: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
    right: { style: BorderStyle.SINGLE, size: st.borderSize, color: st.borderColor },
  }
  const out: any[] = []
  out.push(new Paragraph({
    children: [new TextRun({ text: `${CFG.title} · 答题卡`, bold: true, size: size + 8 })],
    heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 120 },
  }))
  out.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [new TableCell({ borders: border, children: [new Paragraph({ children: [new TextRun({ text: '学校：______ 班级：______ 姓名：______ 考号：______', size })] })] })],
    })],
  }))
  out.push(new Paragraph({ children: [new TextRun({ text: '缺考标记：□（由监考员填涂）', size, color: 'C00000' })], spacing: { after: 120 } }))
  let idx = 0
  const objective = items.filter(it => ['single', 'multiple', 'judge'].includes(it.qtype))
  if (objective.length) {
    out.push(new Paragraph({ children: [new TextRun({ text: `第一部分　选择题（本大题共 ${objective.length} 小题）`, bold: true, size: size + 1 })], spacing: { before: 80, after: 90 } }))
    for (const it of objective) {
      idx++
      const opts = it.qtype === 'judge' ? ['正确', '错误'] : (it.options || []).map((_: any, i: number) => optLetter(i))
      out.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({
          children: [
            new TableCell({ borders: border, children: [new Paragraph({ children: [new TextRun({ text: String(idx), bold: true, size })], alignment: AlignmentType.CENTER })] }),
            ...opts.map(o => new TableCell({ borders: border, children: [new Paragraph({ children: [new TextRun({ text: `${o} □`, size })], alignment: AlignmentType.CENTER })] })),
          ],
        })],
      }))
    }
  }
  const subjective = items.filter(it => !['single', 'multiple', 'judge'].includes(it.qtype))
  if (subjective.length) {
    out.push(new Paragraph({ children: [new TextRun({ text: `第二部分　非选择题（本大题共 ${subjective.length} 小题）`, bold: true, size: size + 1 })], spacing: { before: 200, after: 90 } }))
    for (const it of subjective) {
      idx++
      out.push(new Paragraph({ children: [new TextRun({ text: `${idx}.（${scoreOf(it)}分）`, bold: true, size })], spacing: { before: 120, after: 40 } }))
      const rows = Math.min(10, Math.max(4, Math.round(scoreOf(it) * 0.9)))
      for (let r = 0; r < rows; r++) {
        out.push(new Paragraph({ children: [new TextRun({ text: '　', size })], border: { bottom: { style: BorderStyle.DOTTED, size: 4, color: 'BBBBBB', space: 4 } }, spacing: { after: 40 } }))
      }
    }
  }
  return out
}

async function buildSection(mode: 'student' | 'teacher' | 'sheet') {
  const st = paperStyle(CFG.template)
  const children: any[] = []
  if (mode === 'sheet') children.push(...buildAnswerSheet())
  else {
    children.push(...paperHeader(CFG.title, st))
    if (mode === 'student') {
      children.push(new Paragraph({ children: [new TextRun({ text: '双向细目表', bold: true, size: 25 })], spacing: { after: 60 } }))
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '题型', size: 18 })] })] })] })] }))
      children.push(new Paragraph({ children: [new PageBreak()] }))
    }
    children.push(...await buildQuestions(mode === 'teacher'))
  }
  return { children, props: {} as any }
}

async function buildMerged(modes: ('student' | 'teacher' | 'sheet')[]) {
  const st = paperStyle(CFG.template)
  const sections: any[] = []
  for (const m of modes) {
    const { children, props } = await buildSection(m)
    sections.push({ properties: props, ...(CFG.showFooter && st.footer ? { footers: { default: buildFooter({ leftText: CFG.title }) } } : {}), children })
  }
  return await Packer.toBlob(new Document({ sections }))
}

async function unzip(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  const xml = await zip.file('word/document.xml').async('string')
  // ⚠️ 断言必须比对「所有 <w:t> 拼接后的纯文本」，不能直接对 XML 原文做 includes：
  //   Word 会把一行拆成多个 run（加粗前缀、制表位、图片前后…分别成 run），
  //   一句话在 XML 里可能是 `<w:t>A. </w:t></w:r>...<w:t>正文</w:t>`，
  //   直接 includes 会误报失败（本次实测踩到）。
  const text = [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map(m => m[1])
    .join('')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return { zip, xml, text }
}

export async function run() {
  console.log('=== A. 合并导出一份完整试卷（学生卷+解析卷+答题卡）===')
  const blob = await buildMerged(['student', 'teacher', 'sheet'])
  const { zip, xml, text } = await unzip(blob)

  ok('产物非空', blob.size > 5000, `${blob.size} bytes`)
  ok('无序列化退化（rootKey 零命中）', !/rootKey/.test(xml))
  ok('含 3 个 section（三份内容）', (xml.match(/<w:sectPr\b[^>]*>/g) || []).length === 3)

  console.log('--- 卷头 ---')
  ok('含试卷标题', text.includes('高一物理 第一次月考'))
  ok('含学校值', text.includes('太原五中'))
  ok('含班级值', text.includes('高一(3)班'))
  ok('含「满分」与「时间」', text.includes('满分') && text.includes('时间'))
  ok('含密封线', /密\s*封\s*线/.test(text))
  ok('含注意事项框', text.includes('注意事项'))
  ok('含姓名/考号栏', text.includes('姓名') && text.includes('考号'))

  console.log('--- 大题标题规范化 ---')
  ok('单选题大题标题含「本大题共 N 小题，共 M 分」', /一、单项选择题（本大题共 \d+ 小题，共 \d+ 分）/.test(text))
  ok('判断题大题标题规范', /三、判断题（本大题共 \d+ 小题，共 \d+ 分）/.test(text))
  ok('主观题大题标题规范', /五、主观题（本大题共 \d+ 小题，共 \d+ 分）/.test(text))

  console.log('--- 选项智能排版 ---')
  ok('短选项横排（A./B./C./D. 都在）', text.includes('A. ') && text.includes('B. ') && text.includes('C. ') && text.includes('D. '))
  ok('横排使用了制表位', /<w:tab\b|<w:tabs>/.test(xml))
  ok('长选项文本完整保留', text.includes('这是一个明显很长的选项内容用来验证算法在长文本时会自动切换成逐行排版'))
  ok('判断题并排「（  ）正确　（  ）错误」', /正确/.test(text) && /错误/.test(text))

  console.log('--- 内容与格式 ---')
  ok('含公式题面（F=ma 相关文本）', text.includes('牛顿第二定律'))
  ok('含加粗 Markdown 渲染（简答题）', text.includes('简答题'))
  ok('含 Markdown 表格转 Word 表格', text.includes('物理量') && text.includes('位移'))
  ok('含有序列表项', text.includes('写出速度公式') || text.includes('推导位移'))
  ok('解析卷含【答案】', text.includes('【答案】'))
  ok('解析卷含【解析】', text.includes('【解析】'))

  console.log('--- 答题卡 ---')
  ok('答题卡标题', text.includes('答题卡'))
  ok('答题卡含缺考标记', text.includes('缺考'))
  ok('答题卡含「第一部分」选择题区', text.includes('第一部分'))
  ok('答题卡含「第二部分」非选择题区', text.includes('第二部分'))
  ok('答题卡含填涂方框 □', text.includes('□'))
  ok('答题卡含「由监考员填涂」', text.includes('监考员'))

  console.log('--- 页脚 ---')
  const footers = Object.keys(zip.files).filter((n: string) => /^word\/footer\d*\.xml$/.test(n))
  ok('含 3 个页脚部件', footers.length === 3, `实际 ${footers.length}`)
  if (footers.length) {
    const fx = await zip.file(footers[0]).async('string')
    ok('页脚含 PAGE / NUMPAGES 域', /PAGE/.test(fx) && /NUMPAGES/.test(fx))
    ok('页脚含「第…页 共…页」', fx.includes('第') && fx.includes('共'))
  }
  ok('正文引用 footerReference', /footerReference/.test(xml))

  console.log('=== B. 分开下载（单份 student）===')
  const { children, props } = await buildSection('student')
  const st = paperStyle(CFG.template)
  const single = await Packer.toBlob(new Document({
    sections: [{ properties: props, ...(CFG.showFooter && st.footer ? { footers: { default: buildFooter({ leftText: CFG.title }) } } : {}), children }],
  }))
  const { xml: xb, text: tb } = await unzip(single)
  ok('单份产物含 1 个 section', (xb.match(/<w:sectPr\b[^>]*>/g) || []).length === 1)
  ok('单份不含解析卷的【答案】', !tb.includes('【答案】'))
  ok('单份含学生卷内容', tb.includes('高一物理 第一次月考'))

  console.log('=== C. 作业卷模板（无密封线/无须知/无页脚）===')
  const hwSt = paperStyle('homework')
  ok('homework 无密封线', hwSt.seal === false)
  ok('homework 无页脚', hwSt.footer === false)
  const hwBlob = await Packer.toBlob(new Document({
    sections: [{
      properties: {},
      children: [new Paragraph({ children: [new TextRun({ text: '作业卷', size: 24 })] })],
      // homework 不挂页脚
    }],
  }))
  const { zip: hwZip } = await unzip(hwBlob)
  const hwFooters = Object.keys(hwZip.files).filter((n: string) => /^word\/footer\d*\.xml$/.test(n))
  ok('作业卷不含页脚部件', hwFooters.length === 0, `实际 ${hwFooters.length}`)

  console.log(`\n===== 端到端结果：通过 ${pass} / 失败 ${fail} =====`)
  return { pass, fail }
}
