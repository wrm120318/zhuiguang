// v4.10.0 Word 导出排版探针 · TS 入口
//
// ⚠️ 必须由 `scripts/probe-docx-layout.mjs` 通过 `vite.ssrLoadModule()` 加载本文件，
//    不能直接用 node 跑。原因（本次实测踩坑，已定位）：
//      `docx` 这个包如果被加载两次（一次由 docx-kit 内部 `import from 'docx'`，
//      一次由探针 `await import('docx')`），会得到**两份模块实例**。
//      docx-kit 造出的 Table/TableCell 不被另一份实例的序列化器识别，于是产物
//      退化成 `<rootKey>w:tbl</rootKey>`，断言全部失败但代码其实是对的。
//    解法：让本入口与 docx-kit 处在**同一个 vite 模块图**里，
//      两边 `import { Table } from 'docx'` 命中同一实例（已用 instanceof 验证）。
import JSZip from 'jszip'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import {
  paperStyle, layoutOptions, buildFooter, buildSealBlock,
  CN_FONT_SIZES, ptToCnFontSize, cnFontSizeToPt,
  buildExamInfoTable, buildNoticeBox,
} from '@/utils/docx-kit'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

async function docXml(doc: any): Promise<{ zip: any; xml: string }> {
  const blob = await Packer.toBlob(doc)
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return { zip, xml: await zip.file('word/document.xml').async('string') }
}

export async function run() {
  console.log('=== 1. paperStyle 三套模板实体化差异 ===')
  const f = paperStyle('formal'), h = paperStyle('homework')
  ok('formal 有密封线', f.seal === true)
  ok('homework 无密封线', h.seal === false)
  ok('formal 行距 > homework 行距', f.line > h.line, `${f.line} vs ${h.line}`)
  ok('formal 框线粗于 homework', f.borderSize > h.borderSize, `${f.borderSize} vs ${h.borderSize}`)
  ok('formal 有页脚 / homework 无页脚', f.footer === true && h.footer === false)
  ok('formal 与 homework 字号不同', f.bodySize !== h.bodySize)
  ok('未知模板回退 formal', paperStyle('nope').seal === true)
  // 【v4.10.1】模板默认字号对齐中文习惯号数
  ok('formal 默认小四（12pt = 24 half-pt）', f.bodySize === 24, String(f.bodySize))
  ok('homework 默认五号（10.5pt = 21 half-pt）', h.bodySize === 21, String(h.bodySize))

  console.log('=== 1b. 中文习惯字号映射（v4.10.1）===')
  ok('号数表含 16 档', CN_FONT_SIZES.length === 16, String(CN_FONT_SIZES.length))
  ok('小四 = 12pt', cnFontSizeToPt('小四') === 12)
  ok('五号 = 10.5pt', cnFontSizeToPt('五号') === 10.5)
  ok('初号 = 42pt', cnFontSizeToPt('初号') === 42)
  ok('八号 = 5pt', cnFontSizeToPt('八号') === 5)
  ok('号数越大字号越小（三号 16 > 四号 14 > 五号 10.5）',
    (cnFontSizeToPt('三号') ?? 0) > (cnFontSizeToPt('四号') ?? 0)
    && (cnFontSizeToPt('四号') ?? 0) > (cnFontSizeToPt('五号') ?? 0))
  ok('pt 反查回号数：12 → 小四', ptToCnFontSize(12) === '小四')
  ok('pt 反查回号数：10.5 → 五号', ptToCnFontSize(10.5) === '五号')
  ok('非标准磅值返回 null（13pt 自定义）', ptToCnFontSize(13) === null)
  ok('未知号数返回 null', cnFontSizeToPt('九号') === null)
  ok('号数表无重复名', new Set(CN_FONT_SIZES.map(s => s.name)).size === CN_FONT_SIZES.length)
  ok('号数表无重复磅值', new Set(CN_FONT_SIZES.map(s => s.pt)).size === CN_FONT_SIZES.length)
  ok('往返一致性：每个号数 pt→name→pt 恒定',
    CN_FONT_SIZES.every(s => cnFontSizeToPt(ptToCnFontSize(s.pt) ?? '') === s.pt))

  console.log('=== 2. 选项自动横排算法 ===')
  const short = ['甲乙', '丙丁', '戊己', '庚辛']
  ok('短选项横排 → 只产出 1 个段落', (await layoutOptions(short, 24, 'auto')).length === 1)
  const long = [
    '这是一段非常长的选项文字用来模拟真实考试中出现的冗长表述应该独占一行显示才合理',
    '另一段同样很长的选项文字内容也不短需要独立成行显示才能保证阅读体验良好',
    '第三段长文本选项同样需要独立成行避免挤在一起难以阅读辨识',
    '第四段长文本选项也是这样处理的不能横排',
  ]
  ok('长选项逐行 → 产出 4 个段落', (await layoutOptions(long, 24, 'auto')).length === 4)
  ok('含图片 → 强制逐行', (await layoutOptions(['见图 ![x](http://a/b.png)', '乙'], 24, 'auto')).length === 2)
  ok('判断题 → 单段落', (await layoutOptions(['正确', '错误'], 24, 'auto', 'judge')).length === 1)
  // ⚠️ 回归：两个选项但**不是**判断题（如二选一单选），绝不能套用「正确/错误」特例
  const twoChoice = await layoutOptions(['甲选项内容', '乙选项内容'], 24, 'auto', 'single')
  ok('两选项选择题不被误判为判断题', twoChoice.length === 1 && !JSON.stringify(twoChoice.map((x:any)=>x?.constructor?.name)).includes('undefined'))
  ok('mode=inline 强制横排（长选项也 1 段）', (await layoutOptions(long, 24, 'inline')).length === 1)
  ok('mode=block 强制逐行（短选项也 4 段）', (await layoutOptions(short, 24, 'block')).length === 4)
  ok('空数组 → 0 段', (await layoutOptions([], 24, 'auto')).length === 0)
  ok('单选项 → 1 段', (await layoutOptions(['甲'], 24, 'auto')).length === 1)

  console.log('=== 3. 页脚（第 X 页 共 Y 页，Word 域）===')
  const docFooter = new Document({
    sections: [{
      properties: {},
      footers: { default: buildFooter({ leftText: '测试卷' }) },
      children: [new Paragraph({ children: [new TextRun({ text: '正文', size: 24 })] })],
    }],
  })
  const { zip: z1, xml: x1 } = await docXml(docFooter)
  const footerName = Object.keys(z1.files).find((n: string) => /^word\/footer\d*\.xml$/.test(n))
  ok('存在 footer XML 文件', !!footerName, footerName || '未找到')
  if (footerName) {
    const fx = await z1.file(footerName).async('string')
    ok('页脚含 PAGE 域（当前页）', /PAGE/.test(fx))
    ok('页脚含 NUMPAGES 域（总页数）', /NUMPAGES/.test(fx))
    ok('页脚含「第」与「共」文案', fx.includes('第') && fx.includes('共'))
    ok('页脚含左侧文字「测试卷」', fx.includes('测试卷'))
  }
  ok('正文含 footerReference 引用', /footerReference/.test(x1))

  console.log('=== 4. 卷头三件套（信息表 / 须知框 / 密封线）===')
  const st = paperStyle('formal')
  const docHead = new Document({
    sections: [{
      properties: {},
      children: [
        buildExamInfoTable([{ label: '学校', value: 'XX中学' }, { label: '姓名', value: '' }], st, 24),
        buildNoticeBox(['答题前请填写姓名'], st, 24),
        buildSealBlock(st, 24),
      ],
    }],
  })
  const { xml: x2 } = await docXml(docHead)
  ok('信息表含「学校」标签', x2.includes('学校'))
  ok('信息表含学校值 XX中学', x2.includes('XX中学'))
  ok('须知框含「注意事项」', x2.includes('注意事项'))
  ok('须知框含条目文本', x2.includes('答题前请填写姓名'))
  ok('密封线含「密封线」字样', /密\s*封\s*线/.test(x2))
  ok('密封线含姓名/班级/考号栏', x2.includes('姓名') && x2.includes('班级') && x2.includes('考号'))
  ok('产出真表格 <w:tbl>', /<w:tbl>/.test(x2))
  ok('无序列化退化（rootKey 零命中）', !/rootKey/.test(x2))

  console.log('=== 5. 选项横排确实落在同一 <w:p> ===')
  const docOpt = new Document({
    sections: [{ properties: {}, children: await layoutOptions(short, 24, 'inline') }],
  })
  const { xml: x3 } = await docXml(docOpt)
  const paras = x3.match(/<w:p\b[^>]*>/g) || []
  ok('横排选项只占 1 个段落', paras.length === 1, `实际 ${paras.length}`)
  ok('横排段落含 A./D. 前缀', x3.includes('A. ') && x3.includes('D. '))
  ok('横排含制表位（<w:tab 或 <w:tabs>）', /<w:tab\b|<w:tabs>/.test(x3))
  ok('横排 4 选项同段（甲乙…庚辛都在）', x3.includes('甲乙') && x3.includes('庚辛'))

  console.log('=== 5b. 选项逐行确实分成多个 <w:p> ===')
  const docOpt2 = new Document({
    sections: [{ properties: {}, children: await layoutOptions(['甲甲甲甲甲', '乙乙乙乙乙'], 24, 'block') }],
  })
  const { xml: x3b } = await docXml(docOpt2)
  const paras2 = x3b.match(/<w:p\b[^>]*>/g) || []
  ok('逐行选项占 2 个段落', paras2.length === 2, `实际 ${paras2.length}`)
  ok('两选项选择题内容未被替换成「正确/错误」', !/（  ）正确/.test(x3b))

  console.log('=== 6. 合并导出（多 section 单一文件）===')
  const docMerge = new Document({
    sections: [
      { properties: {}, children: [new Paragraph({ children: [new TextRun({ text: '学生卷内容', size: 24 })] })], footers: { default: buildFooter({}) } },
      { properties: {}, children: [new Paragraph({ children: [new TextRun({ text: '解析卷内容', size: 24 })] })], footers: { default: buildFooter({}) } },
      { properties: {}, children: [new Paragraph({ children: [new TextRun({ text: '答题卡内容', size: 24 })] })], footers: { default: buildFooter({}) } },
    ],
  })
  const { zip: z4, xml: x4 } = await docXml(docMerge)
  const sectCount = (x4.match(/<w:sectPr\b[^>]*>/g) || []).length
  ok('合并文档含 3 个 section', sectCount === 3, `实际 ${sectCount}`)
  ok('合并文档含全部三段内容',
    x4.includes('学生卷内容') && x4.includes('解析卷内容') && x4.includes('答题卡内容'))
  const footers4 = Object.keys(z4.files).filter((n: string) => /^word\/footer\d*\.xml$/.test(n))
  ok('合并文档含 3 个页脚部件', footers4.length === 3, `实际 ${footers4.length}`)

  console.log(`\n===== 探针结果：通过 ${pass} / 失败 ${fail} =====`)
  return { pass, fail }
}
