#!/usr/bin/env node
/**
 * 【v4.16.0】真实试卷回归探针 —— **持久不变量守卫**
 *
 * 【为什么要长期留着这个探针】
 *   用户连续两次报同一组症状（"识别全是乱的 / 答案填不回去 / 拖动不行"）。
 *   第一次（v4.15.4）我改错了层 —— 没拿真实文件验证就下了结论。
 *   第二次改成"先取证、再动手"，这个探针就是那次取证的产物。
 *
 *   它守的是**四条最容易再犯的错**：
 *     ① 题号漏全角点 `．`(U+FF0E) → 全卷识别退化成"只按大题切"（本次真凶）
 *     ② 答案区检测只看块首行 → 标题被埋在块中部时永远匹配不上
 *     ③ 答题卡 `<table>` 被当不可分割块 → 题号/答案揉成一团、解析不出配对
 *     ④ 表格不能按行切 → 用户无法"在任何位置放分割线"
 *
 * 【它怎么工作（关键：测的是**线上那份实现**）】
 *   真实 docx → mammoth 转 HTML（与浏览器路径完全一致）
 *   → 从 `.vue` **源码字符串**里按词法抽取真实函数体（esbuild 转 TS→JS）
 *   → 在 node + jsdom 里跑完整流程，断言 9 条不变量。
 *
 *   ⚠️ `@/utils/paper-split` 注入的是**真实源码**（加 `PS_` 命名空间避免同名冲突），
 *      绝不用替身 —— 否则探针会把 bug 一起复制过来，测了个寂寞。
 *
 * 运行：`node scripts/probe-real-paper2.mjs`
 * 期望：`通过 9 · 失败 0`
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { transformSync } from 'esbuild'
import { JSDOM } from 'jsdom'

const ROOT = '/workspace/zhuiguang'
const DOCX = '/root/uploads/wb-agentserver-8f25d50f-84ab-4373-8fc8-995cb6ae6c14-uploads-1791192/2026年10月4日初中历史作业.docx'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name) }
  else { fails.push(name); console.log('  ❌ ' + name + (extra ? '\n       ' + extra : '')) }
}

// ────────────────────────────────────────────────────────────────────────────
// ① 取真实 HTML（mammoth，与前端同库同路径）
// ────────────────────────────────────────────────────────────────────────────
async function realHtml() {
  const mammoth = (await import(path.join(ROOT, 'node_modules/mammoth/lib/index.js'))).default
  const r = await mammoth.convertToHtml({ path: DOCX })
  return r.value
}

// ────────────────────────────────────────────────────────────────────────────
// ② 从 .vue 源码里抽取函数体（TS → JS）
//    坑：函数返回类型里可能含对象字面量 `: { a: string }[]`，
//        必须先配平跳过返回类型，才能找到真正的函数体 `{`。
// ────────────────────────────────────────────────────────────────────────────
/**
 * 找到函数体结束位置。
 * 【最大的坑】源码里 `{` / `}` 会出现在**字符串、模板字符串、正则、注释**里，
 *   例如 `ElMessage.info('此处已有分割线')`、注释里的 `[b[i], b[i+1])`。
 *   天真的花括号计数会被它们带偏 → 抽出来的函数尾巴拖到几百行外
 *   （实测 `applyTailAnswers` 抽出了 4358 字符、把 `inferDraft` 也吞进去了）。
 *   所以这里必须做**词法感知**扫描：跳过字符串/模板/正则/注释。
 */
function findBodyEnd(code, k) {
  let d = 0
  let started = false
  for (; k < code.length; k++) {
    const c = code[k]
    const n = code[k + 1]
    // 注释
    if (c === '/' && n === '/') { while (k < code.length && code[k] !== '\n') k++; continue }
    if (c === '/' && n === '*') { k += 2; while (k < code.length && !(code[k] === '*' && code[k + 1] === '/')) k++; k++; continue }
    // 字符串
    if (c === "'" || c === '"') {
      const q = c; k++
      while (k < code.length && code[k] !== q) { if (code[k] === '\\') k++; k++ }
      continue
    }
    // 模板字符串（含 ${} 嵌套，简单处理即可）
    if (c === '`') {
      k++
      while (k < code.length && code[k] !== '`') { if (code[k] === '\\') k++; k++ }
      continue
    }
    // 正则字面量：判断 `/` 是否处于"表达式位置"
    if (c === '/') {
      // 往前看第一个非空白字符，若是 ) ] } 标识符 或数字 → 是除法；否则是正则
      let p = k - 1
      while (p >= 0 && /\s/.test(code[p])) p--
      const prev = code[p]
      const isDiv = prev && /[\w)\]}]/.test(prev) && !/^return$/.test('') // 简化：关键字后是正则
      if (!isDiv) {
        k++
        while (k < code.length && code[k] !== '/') { if (code[k] === '\\') k++; if (code[k] === '[') { while (k < code.length && code[k] !== ']') { if (code[k] === '\\') k++; k++ } } k++ }
        k++
        while (k < code.length && /[a-z]/i.test(code[k])) k++
        k--
        continue
      }
    }
    if (c === '{') { d++; started = true; continue }
    if (c === '}') { d--; if (started && d === 0) return k + 1 }
  }
  return k
}

function extractFn(code, name) {
  // 【坑】必须取**顶层**声明。`inferDraft` 内部还有个同名嵌套函数，
  //      单纯 indexOf 会命中内层 → 抽出半个函数 → esbuild 报重复声明。
  //      做法：按行扫描，只接受行首（列 0）的 `function name`。
  // 【坑】名字后面可能紧跟泛型 `<T>` 或 `(`，所以边界用 `(?=[<(]|\s)` 而不是 `\b`
  const re = new RegExp('^function ' + name + '(?=[<(\\s])', 'm')
  const m = re.exec(code)
  if (!m) throw new Error('未找到顶层函数：' + name)
  const i = m.index
  let k = code.indexOf('(', i)
  // 【坑】泛型参数 `<T extends { ... }>` 里也可能出现 `(`，所以要先跳过 `<...>`
  if (code.slice(i + 'function '.length + name.length, k).trim().startsWith('<')) {
    let ang = code.indexOf('<', i + 'function '.length + name.length)
    let a = 0
    for (; ang < code.length; ang++) {
      if (code[ang] === '<') a++
      else if (code[ang] === '>') { a--; if (a === 0) { ang++; break } }
    }
    k = code.indexOf('(', ang)
  }
  let depth = 0
  for (; k < code.length; k++) {
    if (code[k] === '(') depth++
    else if (code[k] === ')') { depth--; if (depth === 0) break }
  }
  k++
  // 【坑③】`:` 只有在**同一行内**紧跟参数表时才是返回类型（`: number {`）。
  //   若 `:` 之后跨了换行才遇到 `{`，那这个 `{` 根本不是返回类型的开头，
  //   而可能是**下一个函数**的函数体 —— 旧写法会一路吞到下一个函数里去
  //   （实测 `applyTailAnswers` 因此把整个 `inferDraft` 吞了进来）。
  // 找出「函数体 {」。
  // ────────────────────────────────────────────────────────────────────────
  // 【为什么不能靠 `{` 的特征判断】返回类型与函数体的 `{` 完全同形：
  //     `function f(): {\n a: T\n} {`   ← 第一个 { 是类型，第二个是体
  //     `function f() {\n ... \n}`      ← 这个 { 直接就是体
  //   仅凭「后面是否换行」无法区分。唯一可靠的信号是：**在 `)` 之后、函数体之前
  //   是否出现过 `:`（返回类型标记）**。
  //
  //   所以策略：从 `)` 之后开始，若在遇到第一个 `{` 之前先遇到 `:` → 说明有返回类型，
  //   此时从 `:` 起把「类型表达式」整体吃掉：
  //     · 类型表达式可能含配平的 `{}`（对象类型）、`<>`（泛型）、`[]`、`|`、`&`
  //     · 吃掉过程中一旦遇到「配平块之后跟着的 `{`」或「简单类型后的 `{`」就是体
  //   实现上更省事的等价写法：**从 `)` 之后一路扫描，跳过所有「类型字面量 {}」，
  //   保留最后一个 `{`**（因为函数体永远在返回类型之后，是最后一个 `{` 之前那个起点）。
  //   注意：函数体内的 `{` 也在其后 —— 所以必须**在第一次判定为"非类型"时停下**。
  //   判定为"非类型"的依据：该 `{` 的配平块结束后，`while` 跳过 `[]|>&,;:` 与空白后，
  //   **若下一个字符仍是 `{`，则前者是类型；否则前者就是函数体**。这一条对下列都成立：
  //     `: number {`                  → { 之后跳过空白是换行/体内容，不是 { → 是体 ✅
  //     `: {\n a: T\n} {`             → 前者 { 配平后跳过空白遇 `{` → 是类型 ✅
  //     `: { a: T }[] {`              → {} 配平后跳过 `[]` 空白遇 `{` → 是类型 ✅
  //     `: { a: T }[] | null {`       → 同理 ✅
  let p = k
  {
    let bodyStart = -1
    // 先确认 `)` 之后到第一个 `{` 之间是否有 `:`（有无返回类型）
    let firstBrace = code.indexOf('{', k)
    const between = code.slice(k, firstBrace < 0 ? code.length : firstBrace)
    if (between.includes(':')) {
      let i2 = k
      for (; i2 < code.length; i2++) {
        if (code[i2] !== '{') continue
        const e = findBodyEnd(code, i2)
        let r = e
        // 跳过类型表达式里的记号：`[]`、`|`、`&`、`>`、`,`、`;`、`:`、
        // 空白，以及**标识符**（如 `| null`、`| undefined`、`keyof X`）。
        while (r < code.length && /[\s\[\]\|&>,;:\w$]/.test(code[r])) r++
        if (code[r] === '{') { i2 = r - 1; continue }   // 前者是类型 → 继续
        bodyStart = i2; break                            // 前者就是函数体
      }
    }
    p = bodyStart >= 0 ? bodyStart : (firstBrace >= 0 ? firstBrace : k)
  }
  k = p
  const end = findBodyEnd(code, k)
  return code.slice(i, end)
}

function extractConst(code, name) {
  const i = code.indexOf('const ' + name)
  if (i < 0) throw new Error('未找到常量：' + name)
  // 到该行语句结束（含正则字面量里的 /\n 不算换行）
  let k = i
  let inRe = false
  for (; k < code.length; k++) {
    const c = code[k]
    if (c === '/' && code[k - 1] === '=') { inRe = true; continue }
    if (inRe && c === '\\') { k++; continue }
    if (inRe) { if (c === '/') { inRe = false; while (code[k + 1] && /[a-z]/i.test(code[k + 1])) k++ } continue }
    if (c === '\n') break
  }
  return code.slice(i, k)
}

// ────────────────────────────────────────────────────────────────────────────
// ③ 生成可执行模块：把抽出来的函数拼成一个 .mjs，import 进 jsdom 环境
// ────────────────────────────────────────────────────────────────────────────
function buildModule(vuePath, tmpName, fnNames, constNames, minorVariant = 'MINOR_RE') {
  const src = fs.readFileSync(vuePath, 'utf8')
  const pieces = []
  for (const c of constNames) pieces.push(extractConst(src, c))
  // 【v4.16.0】编辑器用「严格版」（不认括号小问），导入面板用「宽松版」（括号也认）。
  //   探针必须按组件真实引用注入，否则测的不是线上那份。
  if (!constNames.includes('MINOR_RE'))
    pieces.push(`const MINOR_RE = ${minorVariant === 'MINOR_RE' ? 'PS_MINOR_RE' : 'PS_MINOR_STRICT_RE'}`)
  if (!constNames.includes('MAJOR_RE'))
    pieces.push('const MAJOR_RE = PS_MAJOR_RE')
  for (const f of fnNames) pieces.push(extractFn(src, f))

  const ts = pieces.join('\n\n') + '\n\nexport { ' + fnNames.join(', ') + ' }\n'
  // 【坑】esbuild 默认会 tree-shake + 重排，泛型函数可能被整个丢掉
  //      （实测 `splitAnswerSectionBlocks` 在 export 里消失了）。
  //      关掉 minify/treeShaking，保持函数原样。
  // 【坑】`WordImportPanel` 里的函数依赖 `@/utils/*` 的导入；探针只关心
  //      选项/答案切分，故用等价替身注入，避免去解析整个 utils 目录。
  // 【v4.16.0】`paper-split` 用**真实实现**——那正是被验证的对象，
  //      绝不能用替身，否则探针会把 bug 一起复制过来。
  const psSrc = fs.readFileSync(path.join(ROOT, 'src/utils/paper-split.ts'), 'utf8')
  const stripImports = (s) =>
    s.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '')
  // 【坑】组件与 paper-split 源里存在**大量同名**常量/函数
  //      （MINOR_RE / MAJOR_RE / OPT_RE / ANSWER_SECTION_RE / toHalfWidth / isMinorHead…），
  //      直接拼接必然 "has already been declared"。
  //      解决：给注入的 paper-split 那份整体加 `PS` 前缀命名空间，逐个重命名导出符号。
  const PS_EXPORTS = [
    'SP', 'QNO_SEP', 'MINOR_RE', 'MAJOR_RE', 'OPT_RE', 'ANSWER_SECTION_RE',
    'toHalfWidth', 'isMinorHead', 'isMajorHead', 'stripHeadNumber',
    'findAnswerTitleLine', 'splitAnswerSectionEx', 'parseAnswerCard', 'parseTailAnswerText',
    'HEAD_CASES',
  ]
  let paperSplit = stripImports(psSrc).replace(/\bexport\s+/g, '')
  // ⚠️ 先替换长的 `MINOR_STRICT_RE`，再替换 `MINOR_RE`，否则前者会被后者截胡成 `PS_MINOR_STRICT_PS_MINOR_RE`。
  for (const name of ['MINOR_STRICT_RE', ...PS_EXPORTS]) {
    paperSplit = paperSplit.replace(new RegExp(`\\b${name}\\b`, 'g'), `PS_${name}`)
  }
  // 内部私有的 CN_NUM / ROMAN 之类不在导出表里，但也不会与组件冲突，保持原样即可。
  // 组件里以**原名**引用 paper-split 的导入符号（`import { parseAnswerCard } from ...`），
  // 所以要把 PS_ 前缀的版本再别名回原名 —— 只给组件**真正用到**的那几个。
  // ⚠️ 不要给 MINOR_RE/MAJOR_RE/OPT_RE/ANSWER_SECTION_RE 加别名：组件自己已声明同名。
  const PS_ALIAS_BACK = ['parseAnswerCard', 'isMinorHead', 'QNO_SEP', 'toHalfWidth']
  const psPrefix = PS_ALIAS_BACK.map((n) => `const ${n} = PS_${n}`).join('\n')

  const stubs = `
${paperSplit}
${psPrefix}
function toMarkdownContent(s){ return String(s ?? '') }
function stripQuestionNumber(s){ return String(s ?? '').replace(/^\\s*\\d+\\s*[.．。、)）]\\s*/, '') }
const defaults = { difficulty: 3, grade: '', subject: '', tags: [] }
`
  const js = transformSync(stubs + ts, {
    loader: 'ts', format: 'esm', target: 'es2020',
    treeShaking: false, minify: false,
  }).code

  // jsdom 提供 document / DOMParser
  // 【坑】临时模块必须写在**项目目录内**，否则 node 从 /tmp 向上找
  //       node_modules 找不到 jsdom（ERR_MODULE_NOT_FOUND）。
  const tmp = path.join(ROOT, tmpName)
  const header = `
import { JSDOM } from 'jsdom'
const __dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.DOMParser = __dom.window.DOMParser
globalThis.document = __dom.window.document
globalThis.Node = __dom.window.Node
`
  fs.writeFileSync(tmp, header + js)
  return tmp
}

// ────────────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────────────
const html = await realHtml()
console.log('真实文档 HTML 长度：', html.length)

// ---------- 模块 A：编辑器（WordPaperSplitEditor）----------
const modPath = buildModule(
  path.join(ROOT, 'src/components/WordPaperSplitEditor.vue'),
  '__probe_editor.mjs',
  ['toText', 'isSubQuestion', 'innerSplitByBr', 'splitSoftLines', 'escapeHtml',
   'splitInlineOptions', 'stripOptionsFromHtml', 'stripLinesInElement', 'decideStripLine',
   'splitIntoBlocks', 'splitTableByRows', 'splitAnswerSectionBlocks', 'spliceBlockAtLine',
   'applyTailAnswers', 'inferDraft', 'isMediaBlock'],
  ['ANSWER_SECTION_RE', 'OPT_RE', 'optRe', 'JUDGE_WORDS'],
  'MINOR_STRICT_RE'   // 编辑器用严格版（括号小问不算切点）
)
const E = await import('file://' + modPath)

// ---------- 模块 B：导入面板（WordImportPanel）----------
const modPath2 = buildModule(
  path.join(ROOT, 'src/components/WordImportPanel.vue'),
  '__probe_panel.mjs',
  ['htmlToText', 'markerLine', 'splitHtmlToQuestions', 'parseBlock', 'splitInlineOptions',
   'splitAnswerSection', 'applyAnswers', 'isJudge', 'sliceBlockAtLine'],
  ['ANSWER_SECTION_RE', 'JUDGE_WORDS', 'optRe', 'MAJOR_RE', 'MINOR_RE']
)
const P = await import('file://' + modPath2)

console.log('\n【A】编辑器路径：splitIntoBlocks 块切分')
const blocks = E.splitIntoBlocks(html)
console.log('   块数 =', blocks.length)
const answerTableIdx = blocks.findIndex(b => /题号[\s\S]{0,80}答案/.test(b.text.replace(/\s+/g, '')))
console.log('   答题卡表格所在块 =', answerTableIdx)
if (answerTableIdx >= 0) {
  console.log('   该块 text 前 120 字 =', JSON.stringify(blocks[answerTableIdx].text.slice(0, 120)))
  console.log('   该块 text 长度 =', blocks[answerTableIdx].text.length)
}
ok('⭐ 答题卡表格不应被压成一个"揉在一起"的块（题号/答案混在一行）',
  answerTableIdx < 0 || !/^题号1?[\s\S]*答案/.test(blocks[answerTableIdx].text.replace(/\s+/g, '')),
  '实际：' + (blocks[answerTableIdx]?.text || '').slice(0, 100))

console.log('\n【B】编辑器路径：splitAnswerSectionBlocks 卷末答案拆分')
const r1 = E.splitAnswerSectionBlocks(blocks)
console.log('   body 块数 =', r1.body.length, '（原', blocks.length, '）')
console.log('   解析到答案 =', r1.answers.size, '题  详解 =', r1.analyses.size, '题')
console.log('   答案样本 =', JSON.stringify([...r1.answers.entries()].slice(0, 8)))
ok('⭐ 应从答题卡表格解析出 20 题答案（1~20）', r1.answers.size >= 18, '实得 ' + r1.answers.size)
ok('⭐ 第 1 题答案 = B', r1.answers.get(1) === 'B', '实得 ' + r1.answers.get(1))
ok('⭐ 第 20 题答案 = B', r1.answers.get(20) === 'B', '实得 ' + r1.answers.get(20))
ok('⭐ 应解析出 ≥18 题的【详解】', r1.analyses.size >= 18, '实得 ' + r1.analyses.size)

console.log('\n【C】导入面板**真实流程**：splitHtmlToQuestions → parseBlock')
// 这才是线上真正跑的那条路：先按题号切成"题块"，再逐块 parseBlock。
// ⚠️ 上一轮我在【C】里直接拿 splitIntoBlocks 的块去 parseBlock，
//    那是编辑器的块（一行一块），不是导入面板的块（一题一块）—— 结论会完全不同。
const qBlocks = P.splitHtmlToQuestions(html)
console.log('   splitHtmlToQuestions 切出题块 =', qBlocks.length)
console.log('   第 1 块文本 =', JSON.stringify(P.htmlToText(qBlocks[0] || '').slice(0, 120)))
console.log('   第 4 块文本 =', JSON.stringify(P.htmlToText(qBlocks[3] || '').slice(0, 120)))
const { body: paBody, answers: paAns, analyses: paAna } = P.splitAnswerSection(qBlocks)
console.log('   分离答案区后 body =', paBody.length, ' 答案 =', paAns.size, ' 详解 =', paAna.size)
const preview = paBody.map(b => P.parseBlock(b)).filter(Boolean)
console.log('   parseBlock 出题 =', preview.length)
preview.slice(0, 5).forEach((d, i) => {
  console.log(`   [${i}] 选项=${d.options?.length} 题型=${d.qtype} 答案=${JSON.stringify(d.answer)} 内容=${JSON.stringify(String(d.content||'').replace(/<[^>]+>/g,'').slice(0,30))}`)
})
const with4 = preview.filter(d => (d.options || []).length === 4).length
const withOpt = preview.filter(d => (d.options || []).length > 0).length
console.log('   有选项的题 =', withOpt, ' 其中 4 选项的 =', with4)
ok('⭐【真实流程】应有大量选择题带选项（≥15 题）', withOpt >= 15, '实得 ' + withOpt)
ok('⭐【真实流程】同行多选项切分生效（≥10 题为 4 选项）', with4 >= 10, '实得 ' + with4)
const filled2 = P.applyAnswers(preview, paAns, paAna)
const withAns2 = preview.filter(d => d.answer).length
console.log('   回填 =', filled2, ' 有答案的题 =', withAns2)
ok('⭐【真实流程】应有题回填到答案', withAns2 >= 15, '实得 ' + withAns2)

console.log('\n【C2】编辑器块 vs 导入面板块 对比（说明两条路径不同）')
console.log('   splitIntoBlocks（编辑器，一行一块） =', blocks.length)
console.log('   splitHtmlToQuestions（导入面板，一题一块） =', qBlocks.length)

console.log('\n【D】回填（编辑器路径）：applyTailAnswers')
const draftFromEditor = r1.body.map(b => E.inferDraft(b.html)).filter(Boolean)
const filled = E.applyTailAnswers(draftFromEditor, r1.answers, r1.analyses)
const withAns = draftFromEditor.filter(d => d.answer).length
console.log('   编辑器草稿 =', draftFromEditor.length, ' 回填题数 =', filled, ' 有答案 =', withAns)
ok('⭐ 编辑器路径应有草稿被回填答案', withAns > 0, '实得 ' + withAns)

// 清理
try { fs.unlinkSync(modPath) } catch {}
try { fs.unlinkSync(modPath2) } catch {}

console.log('\n' + '─'.repeat(60))
console.log(`通过 ${pass} · 失败 ${fails.length}`)
if (fails.length) { fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1) }
console.log('✅ 全部通过')
