/**
 * 【v4.15.4 验证】用【真实 Word 试卷】端到端验证两条改动是否生效：
 *   ① 同行多选项切分（A．…\tB．…\tC．…\tD．… → 4 个选项）
 *   ② 卷末参考答案回填（1．B / 6．D 7．A → 回填到各题，不再"分出新的题"）
 *
 * 【为什么不做纯函数单测就完事】
 *   v4.13.3 有过血的教训：函数抠出来在沙箱里跑全绿，线上却白屏（TDZ）——
 *   纯函数探针看不到「真实输入下的整体行为」。所以这里**直接读用户上传的 docx**，
 *   走 mammoth 同等的 HTML 转换路径，再用真实组件的逻辑跑一遍。
 *
 * 运行：node scripts/probe-real-paper.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { transformSync } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let pass = 0, fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? `\n       → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 从 .vue 里抠出指定的顶层函数（与 probe-split-editor.mjs 同一手法）──
// ⚠️ 陷阱：返回类型里可能含 `{ letter: string; text: string }[]` 这种**对象字面量**，
//    若从 `function name` 后第一个 `{` 开始配平，会在返回类型那里就提前"配平"结束。
//    必须从**参数列表的右括号之后**的第一个 `{` 起算（那才是真正的函数体）。
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`未找到函数 ${name}`)
  // 先找到参数列表的右括号
  const parenOpen = src.indexOf('(', start)
  let pd = 0, parenClose = -1
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pd++
    else if (src[i] === ')') { pd--; if (!pd) { parenClose = i; break } }
  }
  if (parenClose < 0) throw new Error(`${name} 参数括号不配平`)
  // ⚠️ 坑②：`)` 之后可能还有**返回类型注解**，它可能是
  //    `: { letter: string }[]`（单行）或 `: {\n body: string[]\n}`（多行）两种形态。
  //    直接找 `{` 或 `{\n` 都可能命中返回类型。
  //    可靠做法：`{` 前面是 `:` 开头 → 那是返回类型，**跳过它**（配平后继续找）。
  let i = parenClose + 1
  // 跳过 `:` 与空白
  while (i < src.length && (src[i] === ':' || /\s/.test(src[i]))) i++
  if (src[i] === '{') {
    // 这是返回类型 → 配平跳过
    let d = 0
    for (; i < src.length; i++) {
      if (src[i] === '{') d++
      else if (src[i] === '}') { d--; if (!d) { i++; break } }
    }
    // 可能还有 `[]` 等后缀
    while (i < src.length && /[\[\]\s]/.test(src[i])) i++
  }
  const bodyStart = src.indexOf('{', i)
  let depth = 0
  for (let k = bodyStart; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(start, k + 1) }
  }
  throw new Error(`函数 ${name} 大括号不配平`)
}

// ── 用 python-docx 把真实 docx 转成「段落数组」（等价 mammoth 的输出粒度）──
import { execSync } from 'child_process'
const DOCX = '/root/uploads/wb-agentserver-8f25d50f-84ab-4373-8fc8-995cb6ae6c14-uploads-1791192/2026年10月4日初中历史作业.docx'
if (!fs.existsSync(DOCX)) {
  console.log(`⚠️  未找到真实试卷（${DOCX}），跳过真实文档验证`)
  process.exit(0)
}
// 写成临时 .py 文件执行 —— 避免 `python3 -c "...\n..."` 里 \n 被 shell 当字面量
const PY_PATH = '/tmp/__docx_dump.py'
fs.writeFileSync(PY_PATH, [
  'from docx import Document',
  'import json,sys',
  'd=Document(sys.argv[1])',
  'out=[]',
  'for p in d.paragraphs:',
  '    t=p.text.strip()',
  "    if 'graphicData' in p._p.xml or 'pict' in p._p.xml: t=(t+' [图]').strip()",
  '    out.append(t)',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n'))
const paras = JSON.parse(
  execSync(`python3 ${PY_PATH} ${JSON.stringify(DOCX)}`, { maxBuffer: 64 * 1024 * 1024 }).toString()
)
console.log(`📄 读取真实试卷：${paras.length} 个段落`)

// ── 抠出两个组件的 splitInlineOptions（必须逐字一致）──
const importSrc = fs.readFileSync(path.join(ROOT, 'src/components/WordImportPanel.vue'), 'utf-8')
const editorSrc = fs.readFileSync(path.join(ROOT, 'src/components/WordPaperSplitEditor.vue'), 'utf-8')
const fnImport = extractFn(importSrc, 'splitInlineOptions')
const fnEditor = extractFn(editorSrc, 'splitInlineOptions')

section('① 同行多选项切分 · 两组件实现必须一致')
const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
ok(strip(fnImport) === strip(fnEditor), 'WordImportPanel 与 WordPaperSplitEditor 的 splitInlineOptions 逻辑一致（忽略注释）',
  strip(fnImport) === strip(fnEditor) ? '' : '两处实现已漂移，必须同步')

const js = transformSync(fnImport + '\nexport {splitInlineOptions};', { loader: 'ts', format: 'esm' }).code
const TMP1 = path.join(ROOT, '.tmp-probe-opt.mjs')
fs.writeFileSync(TMP1, js)
const mod = await import('file://' + TMP1)
const split = mod.splitInlineOptions

section('② 用真实试卷的选项行验证切分（含 Tab 分隔）')
// 第 1 题真实选项行
const L1 = paras.find(l => l.startsWith('A．彼特拉克'))
ok(!!L1, '找到第 1 题的同行选项行')
if (L1) {
  const r = split(L1)
  ok(r.length === 4, `「A．彼特拉克 B．但丁 C．拉斐尔 D．莎士比亚」→ 4 个选项`, `实得 ${r.length}: ${JSON.stringify(r)}`)
  ok(r.map(x => x.text).join('|') === '彼特拉克|但丁|拉斐尔|莎士比亚',
    '四个选项内容正确且已剥去字母前缀', JSON.stringify(r))
}
// 折行 2+2 的情形（第 2、3 题）
const L2a = paras.find(l => l.startsWith('A．自给自足的生产目的'))
if (L2a) {
  const r = split(L2a)
  ok(r.length === 2, `折行 2+2 的上半行「A．… B．…」→ 2 个选项`, `实得 ${r.length}: ${JSON.stringify(r)}`)
}
const L2b = paras.find(l => l.startsWith('C．雇佣劳动与分工生产'))
if (L2b) {
  const r = split(L2b)
  ok(r.length === 2 && r[0].letter === 'C' && r[1].letter === 'D',
    `折行 2+2 的下半行「C．… D．…」→ 2 项且字母为 C、D（供续行拼接）`,
    `实得 ${JSON.stringify(r)}`)
}

section('③ 反例：不能误伤题干里的孤立字母')
ok(split('A 点的坐标是（1，2），方案 B 更优').length === 0, '题干含孤立「A」「B」但不构成 ABCD 序列 → 不切分')
ok(split('如图，△ABC 中，AB=AC').length === 0, '含 ABC 字母的数学题干 → 不切分')
ok(split('A．甲').length === 0, '只有一个选项 → 不切分（交给原有行首判据）')
ok(split('选项 A．甲 B．乙').length === 2, '字母序列 A→B 连续 → 切分（与"选项"二字无关，只看字母序列）')
ok(split('A．甲 C．丙').length === 0, '字母不连续（A→C 跳号）→ 不切分，避免误伤')
ok(split('A．甲 B．乙 C．丙').length === 3, '三选项连续 A→B→C → 切分')

section('④ 卷末参考答案解析（复用真实试卷尾部）')
const h2t = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim()
const fnAnsImport = extractFn(importSrc, 'splitAnswerSection')
const ANSWER_SECTION_RE_SRC = importSrc.match(/const ANSWER_SECTION_RE = [^\n]+/)[0]
const js2 = transformSync(
  ANSWER_SECTION_RE_SRC + '\n' +
  fnAnsImport.replace(/htmlToText/g, '__h2t') + '\nexport {splitAnswerSection};',
  { loader: 'ts', format: 'esm' }
).code
const TMP2 = path.join(ROOT, '.tmp-probe-ans.mjs')
fs.writeFileSync(TMP2, 'const __h2t = ' + h2t.toString() + ';\n' + js2)
const mod2 = await import('file://' + TMP2)
const { splitAnswerSection } = mod2

// 构造块数组：正文块 + 卷末答案块
const ansStart = paras.findIndex(l => /参考答案\s*$/.test(l.trim()) && l.includes('初中历史作业'))
ok(ansStart > paras.length * 0.3, `找到卷末「参考答案」标题（第 ${ansStart} 段 / 共 ${paras.length} 段 = ${(ansStart/paras.length*100).toFixed(1)}%，位于全文 30% 之后）`)
if (ansStart > 0) {
  // ImportPanel 版的 splitAnswerSection 接收 **string[]**（它的 htmlToText 直接吃字符串）
  const blocks = paras
  const { body, answers, analyses } = splitAnswerSection(blocks)
  ok(body.length === ansStart, `正文块数 = ${ansStart}（答案区块已被剔除）`, `实得 ${body.length}`)
  // 本卷第 1~20 题是选择题（答案形如 `1．B`），21~36 是主观题（答案为大段文字，非字母）
  // 所以 20 是**正确值**，不是漏解析。
  ok(answers.size >= 18, `解析出 ≥18 道选择题的字母答案（实得 ${answers.size}，第 1~20 题为选择题）`,
    `实得 ${answers.size}`)
  // 核对几个已知答案
  ok(answers.get(1) === 'B', '第 1 题答案 = B（原文 1．B）', `实得 ${answers.get(1)}`)
  ok(answers.get(2) === 'C', '第 2 题答案 = C（原文 2．C）', `实得 ${answers.get(2)}`)
  ok(answers.get(4) === 'B', '第 4 题答案 = B（原文 4．B）', `实得 ${answers.get(4)}`)
  // 关键：同行两题 `6．D    7．A` 必须都解析出来
  ok(answers.get(6) === 'D' && answers.get(7) === 'A',
    '同行两题「6．D    7．A」都被解析（这是旧实现必丢的格式）',
    `6=${answers.get(6)} 7=${answers.get(7)}`)
  const withAna = Array.from(analyses.values()).filter(v => v.length > 10).length
  ok(withAna > 0, `解析出了 ${withAna} 道题的【详解】`)
}

section('⑤ 结论')
console.log(`\n通过 ${pass} · 失败 ${fail}`)
if (fail) { console.log('❌ 存在失败断言'); process.exit(1) }
console.log('✅ 全部通过')
