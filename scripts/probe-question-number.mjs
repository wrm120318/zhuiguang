// v4.13.2 题号剥离探针
//
// 用法：node scripts/probe-question-number.mjs
//
// 【用户需求】
//   「加一个功能 就是切完题后自动把序号去除（小题的不要去）」
//   追问确认：阿拉伯数字题号 + 中文大题号都去掉；更下级的小问号保留。
//
// 【为什么这个功能特别需要探针】
//   「剥题号」看起来简单，实则极易**误伤**：
//     · `1.5 倍` 会被当成题号 `1.` → 剥出 `5 倍`（实测踩过）
//     · `(1) 小问` 若按"括号也是题号"处理 → 永久丢失"第几小问"信息
//     · 题干是 HTML，题号可能在标签内、跨标签、或被 <strong> 包裹
//   这些边界只要错一个，用户的题干就被**不可逆地改坏**。
//   所以本探针的重点是**误伤防护**，而非"能剥掉"。
import { createServer } from 'vite'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { middlewareMode: true }, appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/src/utils/question-number.ts')
  const { stripNumberFromText, stripQuestionNumber, hasLeadingNumber, NUMBER_CASES } = mod

  console.log('=== 1. 应剥离的题号形态 ===')
  const shouldStrip = [
    ['1. 下列说法正确的是', '阿拉伯数字 + 点号'],
    ['1、已知集合', '阿拉伯数字 + 顿号'],
    ['1．函数 f(x)', '阿拉伯数字 + 全角点号'],
    ['12. 计算', '两位数题号'],
    ['100. 大编号', '三位数题号'],
    ['１．全角数字', '全角数字题号（Word 常见）'],
    ['一、选择题', '中文数字 + 顿号'],
    ['二. 填空题', '中文数字 + 点号'],
    ['（一）选择题', '中文数字括号'],
    ['【一】综合题', '中文数字方括号'],
    ['第1部分 选择题', '“第N部分”'],
    ['第一部分 选择题', '“第X部分”中文'],
    ['第Ⅰ卷', '罗马数字卷号'],
    ['第1题 求下列各式的值', '“第N题”'],
    ['  1.  前后多余空格', '空白容错'],
  ]
  for (const [input, desc] of shouldStrip) {
    const out = stripNumberFromText(input)
    ok(`${desc}：${JSON.stringify(input)} → ${JSON.stringify(out)}`, out !== input)
  }

  console.log('\n=== 2. ⚠️ 绝不能误伤的形态（本探针重点）===')
  // 这组是"宁可漏剥也不能误剥"的底线
  const mustKeep = [
    ['(1) 若 x>0，求…', '阿拉伯数字括号 = 小问号'],
    ['（1）求导', '全角括号小问号'],
    ['① 第一小问', '圈数字小问号'],
    ['② 第二小问', '圈数字小问号'],
    ['A. 选项甲', '选项行（本就是独立字段）'],
    ['B、选项乙', '选项行（顿号）'],
    ['求函数 f(x)=x²-2x 的最小值', '正常题干'],
    ['如图所示，求阴影面积', '正常题干'],
  ]
  for (const [input, desc] of mustKeep) {
    ok(`${desc}：${JSON.stringify(input)} 原样保留`, stripNumberFromText(input) === input,
      JSON.stringify(stripNumberFromText(input)))
  }

  console.log('\n=== 3. ⚠️⚠️ 小数点 / 数字开头正文的误伤防护 ===')
  // 实测踩过的坑：`1.5 倍的增长` 被剥成 `5 倍的增长`
  const decimals = [
    ['1.5 倍的增长', '小数（点号后紧跟数字）'],
    ['3.14 是圆周率近似值', '圆周率'],
    ['2.0 版本的说明', '版本号'],
    ['0.5 米', '小于 1 的小数'],
    ['2020年的数据', '年份（无点号）'],
    ['12 个月的统计', '纯数字无点号'],
  ]
  for (const [input, desc] of decimals) {
    ok(`${desc}：${JSON.stringify(input)} 不被当题号`, stripNumberFromText(input) === input,
      JSON.stringify(stripNumberFromText(input)))
  }
  // 但「题号 + 空格 + 数字正文」仍应剥（不能被上一条判据误伤）
  ok('题号后带空格接数字正文 → 仍剥（1. 5倍的增长）',
    stripNumberFromText('1. 5倍的增长') === '5倍的增长', stripNumberFromText('1. 5倍的增长'))
  ok('顿号后接数字 → 仍剥（顿号不是小数点）（2、3个选项）',
    stripNumberFromText('2、3个选项都是错的') === '3个选项都是错的',
    stripNumberFromText('2、3个选项都是错的'))

  console.log('\n=== 4. HTML 题干剥离（题号可能在标签里）===')
  const h1 = stripQuestionNumber('<p>1. 下列说法正确的是（　）</p>')
  ok('普通 <p> 内题号被剥', !/1\./.test(h1) && h1.includes('下列说法'), h1)

  const h2 = stripQuestionNumber('<p><strong>2.</strong> 加粗题号</p>')
  ok('跨标签题号被剥（<strong>2.</strong>）', !/2\./.test(h2) && h2.includes('加粗题号'), h2)
  ok('剥后不残留空 <strong></strong>', !/<strong\s*>\s*<\/strong>/i.test(h2), h2)

  const h3 = stripQuestionNumber('<p>(1) 小问必须保留</p>')
  ok('HTML 里的小问号 (1) 保留', h3.includes('(1)'), h3)

  console.log('\n=== 5. ⚠️ 表格 / 图片绝不能被破坏（与 v4.13.1 的联动）===')
  const tbl = '<table><tr><td>1</td></tr></table>'
  ok('表格块原样返回', stripQuestionNumber(tbl) === tbl, stripQuestionNumber(tbl))
  const img = '<p><img src="x.png"></p>'
  ok('图片块原样返回', stripQuestionNumber(img) === img, stripQuestionNumber(img))
  const tblAfter = stripQuestionNumber('<p>1. 根据下表</p><table><tr><td>1.2</td></tr></table>')
  ok('题号剥离不影响表格内容（单元格里的 1.2 不被动）',
    tblAfter.includes('<td>1.2</td>') && !/>\s*1\.\s*根据/.test(tblAfter), tblAfter)
  const imgAfter = stripQuestionNumber('<p>2. 如图</p><p><img src="a.png"></p>')
  ok('题号剥离不影响图片', imgAfter.includes('<img src="a.png"') && !/2\./.test(imgAfter), imgAfter)

  console.log('\n=== 6. hasLeadingNumber 判定（按钮可用性依赖它）===')
  ok('「1. 题」→ true', hasLeadingNumber('1. 题') === true)
  ok('「一、题」→ true', hasLeadingNumber('一、题') === true)
  ok('「(1) 小问」→ false（小问不算题号）', hasLeadingNumber('(1) 小问') === false)
  ok('「正常题干」→ false', hasLeadingNumber('正常题干') === false)
  ok('空串 → false', hasLeadingNumber('') === false)
  ok('HTML 题号也能判定', hasLeadingNumber('<p>1. 题</p>') === true)

  console.log('\n=== 7. 案例清单自检（NUMBER_CASES 必须自洽）===')
  ok(`NUMBER_CASES 共 ${NUMBER_CASES.length} 条`, NUMBER_CASES.length >= 25, `实际 ${NUMBER_CASES.length}`)
  let bad = 0
  for (const [input, want] of NUMBER_CASES) {
    const got = stripNumberFromText(input)
    if (got !== want) {
      bad++
      console.log(`     ❌ 清单不一致：${JSON.stringify(input)} 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`)
    }
  }
  ok('清单内所有案例与实现一致', bad === 0, `${bad} 条不一致`)

  console.log('\n=== 8. 两个入口共用同一实现（铁律#11）===')
  const { readFileSync } = await import('node:fs')
  const splitEditor = readFileSync(`${ROOT}/src/components/WordPaperSplitEditor.vue`, 'utf8')
  const importPanel = readFileSync(`${ROOT}/src/components/WordImportPanel.vue`, 'utf8')
  ok('原卷编辑入口引用 stripQuestionNumber', /stripQuestionNumber/.test(splitEditor))
  ok('快速导入入口引用 stripQuestionNumber', /stripQuestionNumber/.test(importPanel))
  ok('两个入口都从同一模块导入',
    /from '@\/utils\/question-number'/.test(splitEditor) && /from '@\/utils\/question-number'/.test(importPanel))
  ok('原卷编辑入口在 inferDraft 里自动剥离',
    /content:\s*stripQuestionNumber\(stripOptionsFromHtml/.test(splitEditor))
  ok('原卷编辑入口提供手动按钮处理函数', /function stripAllNumbers/.test(splitEditor))
  ok('手动按钮不跳过用户已编辑的题（显式操作应处理全部）',
    !/oldDirty[\s\S]{0,80}stripAllNumbers/.test(splitEditor))

  console.log('\n' + '─'.repeat(52))
  if (fail === 0) console.log(`结果：${pass} 项通过 / ${fail} 项失败\n✅ 题号剥离全部不变量成立`)
  else console.log(`结果：${pass} 项通过 / ${fail} 项失败\n❌ 题号剥离不变量被破坏`)
} finally {
  await server.close()
}
process.exit(fail ? 1 : 0)
