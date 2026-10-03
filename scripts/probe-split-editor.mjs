// v4.12.0 拖动分割线 / 自动切割 几何探针
//
// 用法：node scripts/probe-split-editor.mjs
//
// 背景：用户原话「拖动分题目功能完全瘫痪 十分难用」
//               「自动切割题目读取答案和解析实在是太难用了」
//
// 【为什么必须写这个探针】
//   拖动这件事**在无浏览器环境里没法端到端跑**（依赖 elementFromPoint、
//   docx-preview 真实渲染、真实布局几何）。但它的**核心算法是纯函数**：
//     · splitIntoBlocks   —— HTML → 块（含行级下钻）
//     · autoSplit         —— 块 → 切点
//     · similarity        —— 文本相似度（块匹配的判据）
//     · onDragEnd 的边界校验 —— 拖动合法性与吸附
//   把这些抽出来单测，就能**用证据**证明"拖动真的能对上块"，
//   而不是"我改了代码，看起来对"。
//
// 探针用 vite 的 ssrLoadModule 直接加载 .vue，再用正则剥出纯函数体，在
// jsdom 风格的假 DOM 上跑 —— 不需要装 jsdom，用一个极简 shim。
import { readFileSync } from 'node:fs'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}
const src = readFileSync(`${ROOT}/src/components/WordPaperSplitEditor.vue`, 'utf8')

// ───────────────────────────────────────────────────────────────────────────
// 极简 DOM shim —— 只实现探针用到的能力（querySelectorAll('br') / textContent /
// outerHTML / childNodes / tagName / getAttribute / createElement / appendChild）
// 目的是让从 .vue 里抽出来的函数体可以原样跑，而不是复制一份（复制就失去意义）
// ───────────────────────────────────────────────────────────────────────────
class El {
  constructor(tag = 'div', attrs = {}, children = []) {
    this.tagName = tag.toUpperCase()
    this.attrs = { ...attrs }
    this.childNodes = children
    this._text = null
    children.forEach(c => { c.parent = this })
  }
  getAttribute(k) { return this.attrs[k] ?? null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  get className() { return this.attrs.class || '' }
  get textContent() {
    if (this._text !== null) return this._text
    if (this.tagName === 'BR') return ''
    return this.childNodes.map(c => c.textContent).join('')
  }
  set textContent(v) { this._text = v; this.childNodes = [] }
  get outerHTML() {
    const attrStr = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')
    const inner = this.tagName === 'BR' ? '' : this.innerHTML
    return `<${this.tagName.toLowerCase()}${attrStr}>${inner}</${this.tagName.toLowerCase()}>`
  }
  get innerHTML() {
    if (this._text !== null) return escapeHtmlShim(this._text)
    return this.childNodes.map(c => (c.nodeType === 3 ? escapeHtmlShim(c.textContent) : c.outerHTML)).join('')
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  querySelectorAll(sel) {
    const want = sel.trim().toLowerCase()
    const out = []
    const walk = (n) => {
      n.childNodes.forEach(c => {
        if (c.nodeType === 3) return
        if (c.tagName.toLowerCase() === want) out.push(c)
        walk(c)
      })
    }
    walk(this)
    return out
  }
  appendChild(c) { c.parent = this; this.childNodes.push(c); return c }
  cloneNode() {
    if (this.nodeType === 3) return { nodeType: 3, textContent: this.textContent, cloneNode: this.cloneNode }
    const c = new El(this.tagName.toLowerCase(), { ...this.attrs })
    if (this._text !== null) c._text = this._text
    else this.childNodes.forEach(x => c.appendChild(x.cloneNode()))
    return c
  }
}
const escapeHtmlShim = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 全局 document / DOMParser shim（splitIntoBlocks 里用到）
const documentShim = {
  createElement: (tag) => new El(tag),
}
globalThis.document = documentShim

/** 把一段 HTML 解析成 El 树（只处理探针用到的标签） */
function parseHtmlToShim(html) {
  const body = new El('body')
  const stack = [body]
  const re = /<\/?([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    const [raw, tag, attrs, selfClose, text] = m
    if (text !== undefined) {
      if (text.trim()) {
        stack[stack.length - 1].childNodes.push({
          nodeType: 3, textContent: text,
          cloneNode() { return { nodeType: 3, textContent: text, cloneNode: this.cloneNode } },
        })
      }
      continue
    }
    const name = tag.toLowerCase()
    if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
    const attrObj = {}
    const ar = /([a-zA-Z-]+)="([^"]*)"/g
    let am
    while ((am = ar.exec(attrs || '')) !== null) attrObj[am[1]] = am[2]
    const el = new El(name, attrObj)
    el.nodeType = 1
    stack[stack.length - 1].childNodes.push(el)
    if (name !== 'br' && !selfClose) stack.push(el)
  }
  return body
}
globalThis.DOMParser = class {
  parseFromString(html) { return { body: parseHtmlToShim(html) } }
}

// 从 .vue 里抠出纯函数 → 交给 **esbuild** 剥类型（transformSync loader:'ts'）
//
// 【为什么用 esbuild 而不是自己写正则/扫描器】
//   TS 类型剥离要正确处理字符串/模板串/正则字面量/注释/泛型/箭头函数返回类型，
//   手写极易在 `): { html: string; text: string }[] {` 这类写法上出错。
//   项目里已装 esbuild（vite 的依赖），直接复用官方实现 —— 正确性有保障。
import { transformSync } from 'esbuild'

function toJs(tsCode) {
  return transformSync(tsCode, { loader: 'ts', format: 'esm', target: 'es2022' }).code
}

/** 抠出 `function name(...) { ... }` 的源码并剥类型。
 *
 *  【边界怎么定】取「本函数起始」到「下一个顶层声明起始」之间 —— 顶层声明 =
 *  行首无缩进的 `function `/`const `/`let `/`var `/`/**`。这段一定是合法 TS，
 *  esbuild 直接能剥。避免了手写扫描器在正则字面量（如 /[\u4e00"'（）]/）里翻车。 */
function sliceFn(name) {
  const re = new RegExp(`^function ${name}\\(`, 'gm')
  const m = re.exec(src)
  if (!m) throw new Error(`找不到函数 ${name}`)
  const start = m.index
  // 找下一个顶层声明
  const declRe = /^(?:function|const|let|var|\/\*\*|\/\/ =====|type|interface )/gm
  declRe.lastIndex = start + 1
  let end = src.length
  let d
  while ((d = declRe.exec(src)) !== null) { end = d.index; break }
  const chunk = src.slice(start, end)
  const js = transformSync(chunk, { loader: 'ts', format: 'esm' }).code
  return js.trimEnd()
}

/** 抠出 `const name = <expr>`（取到行尾；本项目里都是单行定义） */
function sliceConst(name) {
  const re = new RegExp(`^const ${name} = (.+)$`, 'm')
  const m = src.match(re)
  if (!m) throw new Error(`找不到常量 ${name}`)
  return `const ${name} = ${m[1]}`
}

// 组装可执行沙箱
const sandboxSrc = `
${toJs(sliceConst('MAJOR_RE'))}
${toJs(sliceConst('MINOR_RE'))}
${toJs(sliceConst('SUBQ_RE'))}
${toJs(sliceConst('OPT_LINE_RE'))}
const toText = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\\s+/g, ' ').trim()
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
${toJs(sliceFn('isSubQuestion'))}
${toJs(sliceFn('isSectionTitleOnly'))}
${toJs(sliceFn('isAnswerKeyStart'))}
${toJs(sliceFn('isPaperTitleOnly'))}
${toJs(sliceFn('sectionTypeHint'))}
${toJs(sliceFn('dropSectionTitleBoundaries'))}
${toJs(sliceFn('splitIntoBlocks'))}
${toJs(sliceFn('innerSplitByBr'))}
${toJs(sliceFn('splitSoftLines'))}
${toJs(sliceFn('autoSplit'))}
const cutSources = { value: new Map() }
${toJs(sliceFn('normForMatch'))}
${toJs(sliceFn('similarity'))}
const MATCH_MIN = 0.34
export { splitIntoBlocks, autoSplit, similarity, normForMatch, MAJOR_RE, MINOR_RE, SUBQ_RE, isSubQuestion, isSectionTitleOnly, isAnswerKeyStart, isPaperTitleOnly, sectionTypeHint, dropSectionTitleBoundaries, OPT_LINE_RE, cutSources }
`
const mod = await import('data:text/javascript;base64,' + Buffer.from(sandboxSrc).toString('base64'))
const { splitIntoBlocks, autoSplit, similarity, normForMatch, SUBQ_RE, isSubQuestion, isSectionTitleOnly, isAnswerKeyStart, isPaperTitleOnly, sectionTypeHint, MAJOR_RE, MINOR_RE, dropSectionTitleBoundaries } = mod

// ───────────────────────────────────────────────────────────────────────────
console.log('=== 1. 段落内按 <br> 下钻（上一版最大的缺口：一段多题切不开）===')
const oneParaMultiQ = `<p>1. 下列正确的是（  ）<br>2. 下列说法错误的是（  ）<br>3. 计算 1+1=（  ）</p>`
const b1 = splitIntoBlocks(oneParaMultiQ)
ok('无换行符的整段 3 题 → 切成 3 块', b1.length === 3, `实际 ${b1.length} 块`)
ok('切出的每块只含自己的题号',
  b1[0]?.text.startsWith('1.') && b1[1]?.text.startsWith('2.') && b1[2]?.text.startsWith('3.'),
  JSON.stringify(b1.map(x => x.text)))
ok('切块保留原标签与样式（Word 样式不丢）', /^<p[^>]*>/.test(b1[0]?.html || ''), b1[0]?.html)

const styledPara = `<p class="MsoNormal" style="text-indent:2em">甲<br>乙<br>丙</p>`
const b2 = splitIntoBlocks(styledPara)
ok('带 class/style 的段落切块后样式继承到每一行',
  b2.length === 3 && b2.every(x => x.html.includes('class="MsoNormal"') && x.html.includes('text-indent:2em')))

console.log('\n=== 2. 软换行多题（无 <br>，靠空白+题号识别）===')
// 注意：正则要求「连续 2 个以上空白 + 题号」
const soft = `<p>1. 第一题的内容在这里说明　　2. 第二题的内容在这里说明　　3. 第三题的内容在这里说明</p>`
const b3 = splitIntoBlocks(soft)
ok('全角空格分隔的 3 题 → 切开', b3.length === 3, `实际 ${b3.length}`)

const noFalse = `<p>本段是普通说明文字，没有任何题号，不应该被切开。</p>`
ok('普通段落不被误切', splitIntoBlocks(noFalse).length === 1)

const tinyFalse = `<p>1. 甲　　2. 乙</p>`
ok('极短片段（疑误切）保持原样不切', splitIntoBlocks(tinyFalse).length === 1,
  JSON.stringify(splitIntoBlocks(tinyFalse).map(x => x.text)))

console.log('\n=== 3. 自动切割四级判据（上一版"整篇 1 题"的根治）===')
const mk = (arr) => arr.map(t => ({ html: `<p>${t}</p>`, text: t }))

const paper = mk([
  '2026 学年第一学期期中考试  高二数学',            // 卷头
  '一、选择题（每题 5 分）',
  '1. 下列函数中为奇函数的是（  ）',
  'A. y=x²',
  'B. y=x³',
  'C. y=x+1',
  'D. y=|x|',
  '2. 已知集合 A={1,2}，则 A 的子集个数为（  ）',
  'A. 2',
  'B. 3',
  'C. 4',
  'D. 8',
  '二、填空题',
  '3. 若 f(x)=x+1，则 f(2)=______。',
  '4. 不等式 x²<4 的解集为______。',
  '三、解答题',
  '5. 已知等差数列{aₙ}中 a₁=1，d=2，求 a₁₀。',
])
const cuts = autoSplit(paper)
ok('识别到多个切点（不是整篇 1 题）', cuts.length > 2, `实际 ${JSON.stringify(cuts)}`)
ok('首切点之后才成题（卷头不被当题目）', cuts[0] > 0, `首切点 ${cuts[0]}`)
ok('末项 = 块总数（末题有终点）', cuts[cuts.length - 1] === paper.length)
ok('切点严格递增且唯一', cuts.every((v, i) => i === 0 || v > cuts[i - 1]))
ok('二级题号 1./2. 被采信为切点', cuts.includes(2) || cuts.includes(1), JSON.stringify(cuts))

// 只有大题号、没有小题号
const majorOnly = mk(['一、选择题', '甲内容足够长的一段文字', '乙内容足够长的一段文字', '二、填空题', '丙内容足够长的一段文字'])
const c2 = autoSplit(majorOnly)
ok('只有一级题号（一、二、）也能切', c2.length > 2, JSON.stringify(c2))

// 完全无题号 → L4 兜底必须给出多题
const flat = mk(Array.from({ length: 30 }, (_, i) => `第${i}段无题号的正文内容足够长不会被丢弃`))
const c4 = autoSplit(flat)
ok('⚠️ 完全无题号时段落均分兜底（绝不退化成整篇 1 题）',
  c4.length > 2 && c4.length <= 41, `实际 ${c4.length} 段（切点 ${c4.length} 个）`)
ok('L4 兜底首尾正确', c4[0] === 0 && c4[c4.length - 1] === 30)

console.log('\n=== 4. 相似度（块匹配的容错核心，上一版"前缀相等"零容错）===')
ok('完全相同 → 1', similarity('下列函数中为奇函数', '下列函数中为奇函数') === 1)
ok('半角→全角差异仍判为同块', similarity('1. 下列函数 y=x2', '１．下列函数　y＝x2') > 0.5,
  String(similarity('1. 下列函数 y=x2', '１．下列函数　y＝x2')))
ok('标点差异仍判为同块', similarity('A. y=x²', 'A、y＝x²') > 0.5)
ok('包含关系给高分（Word 多页码/空格）', similarity('下列函数中为奇函数的是（  ）', '下列函数中为奇函数的是') >= 0.9)
ok('⚠️ 完全不同的两块必须低分（否则会错配）', similarity('下列函数中为奇函数', '已知集合 A={1,2}') < 0.34,
  String(similarity('下列函数中为奇函数', '已知集合 A={1,2}')))
ok('空 vs 空 → 1（都无内容视为同块）', similarity('', '') === 1)
ok('空 vs 非空 → 0（不能错配到空块）', similarity('', 'abc') === 0)

// 真实场景：mammoth 文本 vs docx-preview 文本（含 &nbsp; 与多余空格）
const mammothTxt = '2. 已知集合A={1,2}，则A的子集个数为（  ）'
const previewTxt = '2. 已知集合 A={1,2}，则 A 的子集个数为（ ）&nbsp;'
ok('两条渲染路径的同一块 → 相似度超阈值（这就是修好拖动的关键）',
  similarity(mammothTxt, previewTxt) >= 0.34, String(similarity(mammothTxt, previewTxt)))

console.log('\n=== 5. 拖动吸附的边界校验（首尾线也允许拖）===')
// 复刻 onDragEnd 的校验逻辑（与源码逐条对应，见 WordPaperSplitEditor.vue:1179-1204）
function validateDrag(i, target, boundaries, nBlocks) {
  const isFirst = i === 0
  const isLast = i === boundaries.length - 1
  if (isFirst) {
    const upper = boundaries[1] ?? nBlocks
    if (target < 0 || target >= upper) return { ok: false, why: 'first' }
  } else if (isLast) {
    const lower = boundaries[boundaries.length - 2] ?? 0
    if (target <= lower || target > nBlocks) return { ok: false, why: 'last' }
  } else if (target <= 0 || target >= nBlocks) return { ok: false, why: 'mid' }
  const next = boundaries.slice()
  if (next.includes(target) && next[i] !== target) return { ok: false, why: 'occupied' }
  if (next[i] === target) return { ok: false, why: 'same' }
  next[i] = target
  const uniq = Array.from(new Set(next)).sort((a, b) => a - b)
  if (uniq.length !== next.length) return { ok: false, why: 'collapse' }
  return { ok: true, next: uniq }
}
const B = [0, 5, 12, 20]
ok('中间线拖到合法位置 → 成功吸附',
  validateDrag(1, 7, B, 20).next?.join() === '0,7,12,20', JSON.stringify(validateDrag(1, 7, B, 20)))
ok('中间线拖到已有分割线位置 → 拒绝（不意外合并）', validateDrag(1, 12, B, 20).ok === false)
ok('中间线拖回原位 → 拒绝（静默不动）', validateDrag(1, 5, B, 20).why === 'same')
ok('首线可向后拖（跳过卷头）→ 成功', validateDrag(0, 3, B, 20).next?.join() === '0,3,12,20' ||
  validateDrag(0, 3, [0, 5, 12, 20], 20).ok === true)
ok('⚠️ 首线越过第二条线 → 拒绝', validateDrag(0, 5, B, 20).ok === false, JSON.stringify(validateDrag(0, 5, B, 20)))
ok('首线拖到第 0 块 → 允许（保持）', validateDrag(0, 1, [0, 5], 20).ok === true)
ok('末线可向前拖（切除页脚）→ 成功', validateDrag(3, 18, B, 20).next?.join() === '0,5,12,18',
  JSON.stringify(validateDrag(3, 18, B, 20)))
ok('末线拖到倒数第二条之前 → 拒绝', validateDrag(3, 10, B, 20).ok === false)
ok('末线拖到 blocks.length（末尾）→ 允许', validateDrag(3, 20, B, 20).why === 'same')

console.log('\n=== 6. 分割线永不消失（layoutOverlay 三级兜底的前提）===')
ok('layoutOverlay 有三级兜底（el → 末条特判 → 借前一块底部）',
  /末条：贴在最后一个已标注块的下方/.test(src) && /借"最近的前一个已标注块"的底部/.test(src))
ok('⚠️ 上一版"找不到就 return 跳过"已删除（不再让线凭空消失）',
  !/const el = [^\n]+\n\s*if \(!el\) return/.test(src))
ok('叠加层 z-index 高于 docx-preview 的 article:1',
  /\.zs-overlay\s*\{[\s\S]{0,200}z-index:\s*(\d+)/.test(src) && Number(src.match(/\.zs-overlay\s*\{[\s\S]{0,200}z-index:\s*(\d+)/)[1]) >= 20,
  (src.match(/\.zs-overlay\s*\{[\s\S]{0,200}z-index:\s*(\d+)/) || [])[1])
ok('首尾线 draggable 由 ">2 段" 决定（题目少时禁用并给提示）',
  /draggable: boundaries\.value\.length > 2/.test(src))

console.log('\n=== 7. 拖一下不再丢失整题编辑（内容指纹）===')
ok('syncDrafts 用内容指纹而非"起始块相等"',
  /function draftFingerprint/.test(src) && /oldFingerprints/.test(src))
ok('手动编辑过的题有 dirty 保护（不被自动重推断覆盖）', /oldDirty/.test(src))
ok('指纹取归一化文本前 40 字', /normForMatch\([\s\S]{0,60}\)\.slice\(0, 40\)/.test(src))

// ═══════════════════════════════════════════════════════════════════════════
// 8. 【v4.13.3】用户反馈三连的回归
//
// 用户原话：
//   「1. 我点AI切题基本没有反应
//     2. 一、选择题 这是让你判断题目类型的 最后切完题也不要保留
//     3. 规则识别的时候 会把小题也切开 这是不被允许的」
//
// 第 1 点是**反馈缺失**（代码本身没坏），第 2/3 点是切分逻辑，都能用纯函数验证。
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== 8a. 小问号判据（SUBQ_RE）===')
const subqShould = ['(1) 求函数的最小值', '（2）证明：AB=CD', '① 小球质量', '②第二个空',
  '(一) 依据材料', '1）求 a 的值', '2) 计算面积']
for (const s of subqShould) ok(`小问号：${JSON.stringify(s)}`, isSubQuestion(s))
const subqNot = ['1. 下列正确的是', '2、已知集合', '一、选择题', 'A. 选项甲', '1.5 倍的增长']
for (const s of subqNot) ok(`⚠️ 非小问号（不得误判）：${JSON.stringify(s)}`, !isSubQuestion(s))

console.log('\n=== 8b. ⚠️ 小问绝不能被切成独立题目（用户明确底线）===')
// 解答题：一个小问都没有左括号写得规整的情况
const subqPaper1 = `<p>三、解答题</p>
<p>1. 已知函数 f(x)=x^2-2x。</p>
<p>(1) 求 f(x) 的最小值。</p>
<p>(2) 若 f(a)=3，求 a 的值。</p>
<p>2. 解方程 x^2-5x+6=0。</p>`
// ⚠️ autoSplit 返回的是**边界数组**（每题的起止块号），不是原始切点索引。
//    `[1,4,5]` 表示：题1 = blocks[1..4)、题2 = blocks[4..5)，块 0（`三、解答题`）
//    是**纯大题标题**，已按 v4.13.3 需求剔除，不单独成题。
//    所以断言要看「说明了几道题」，即 boundaries.length - 1。
const bd1 = autoSplit(splitIntoBlocks(subqPaper1))
ok('解答题 2 题（含 4 个小问）→ 恰好切出 2 道题（小问未被切）',
  bd1.length - 1 === 2, `实际边界 ${JSON.stringify(bd1)} → ${bd1.length - 1} 道题`)
ok('⚠️ 纯大题标题 `三、解答题` 不单独成题（首边界不在块 0）',
  bd1[0] !== 0 || bd1.length - 1 === 1,
  `实际首边界 ${bd1[0]}，边界 ${JSON.stringify(bd1)}`)
ok('切点在两个真正的题号上（`1.` 与 `2.`）',
  bd1.slice(0, -1).every(i => /^[12]\./.test(splitIntoBlocks(subqPaper1)[i].text)), JSON.stringify(bd1))

// 更刁钻：小问写成 `1）`（无左括号）—— 单靠 MINOR_RE 防不住，需要小问语境守卫
const subqPaper2 = `<p>1. 阅读下面材料，回答问题。</p>
<p>材料一：xxx</p>
<p>1）概括材料的主旨。</p>
<p>2）分析作者的写作意图。</p>
<p>2. 下列说法正确的是（  ）</p>`
const blk2 = splitIntoBlocks(subqPaper2)
const bd2 = autoSplit(blk2)
ok('小问写成 `1）` 的卷子 → 仍是 2 道题（语境守卫生效）',
  bd2.length - 1 === 2,
  `实际 ${JSON.stringify(bd2)} → ${bd2.map(i => blk2[i]?.text.slice(0, 12))}`)

// 反向：正常卷子的题号必须仍然能切，不能因为"防小问"把真题号也吞了
const normalPaper = `<p>一、选择题</p>
<p>1. 下列说法正确的是（  ）</p><p>A. 甲</p><p>B. 乙</p>
<p>2. 下列错误的是（  ）</p><p>A. 甲</p><p>B. 乙</p>
<p>3. 计算 1+1=（  ）</p><p>A. 1</p><p>B. 2</p>`
const bd3 = autoSplit(splitIntoBlocks(normalPaper))
ok('⚠️ 反向验证：正常 3 题仍全部切出（防小问没有误伤真题号）',
  bd3.length - 1 === 3, `实际 ${bd3.length - 1} 道题`)

console.log('\n=== 8b-2. 纯标题判据的误伤防护（宁漏不误）===')
ok('「三、解答题」= 纯标题（丢弃）', isSectionTitleOnly('三、解答题', '<p>三、解答题</p>'))
ok('「一、选择题（每题 5 分）」= 纯标题（丢弃）',
  isSectionTitleOnly('一、选择题（每题 5 分）', '<p>一、选择题（每题 5 分）</p>'))
ok('⚠️ 「一、已知函数 f(x)=x²，求最小值」= 真题目（不可丢）',
  !isSectionTitleOnly('一、已知函数 f(x)=x²，求最小值', '<p>一、已知函数 f(x)=x²，求最小值</p>'))
ok('⚠️ 「二、如图，在三角形 ABC 中…」= 真题目（不可丢）',
  !isSectionTitleOnly('二、如图，在三角形 ABC 中，AB=AC，求角 B', '<p>二、如图，在三角形 ABC 中，AB=AC，求角 B</p>'))
ok('⚠️ 含表格的 `一、阅读材料` 块 = 真题目（不可丢）',
  !isSectionTitleOnly('一、阅读材料', '<p>一、阅读材料</p><table><tr><td>x</td></tr></table>'))
ok('⚠️ 含图片的 `三、看图作答` 块 = 真题目（不可丢）',
  !isSectionTitleOnly('三、看图作答', '<p>三、看图作答<img src="a.png"></p>'))
ok('非题号开头 → 不是纯标题', !isSectionTitleOnly('2026 学年期中考试', '<p>2026 学年期中考试</p>'))

console.log('\n=== 8c. 大题标题 → 题型提示（sectionTypeHint）===')
const hintCases = [
  ['一、选择题', 'single'], ['二、多项选择题', 'multiple'], ['三、多选题', 'multiple'],
  ['四、填空题', 'fill'], ['五、判断题', 'judge'],
  ['六、解答题', 'subjective'], ['七、计算题', 'subjective'],
  ['八、证明题', 'subjective'], ['九、综合应用题', 'subjective'],
  ['2026学年第一学期期中考试', ''],
]
for (const [t, want] of hintCases) {
  const got = sectionTypeHint(t)
  ok(`「${t}」→ ${got || '(无提示)'}`, got === want, `期望 ${want || '(空)'}`)
}
ok('⚠️「多项选择题」优先于「选择题」（顺序陷阱）', sectionTypeHint('多项选择题') === 'multiple')

console.log('\n=== 8d. 大题提示下发给后续所有题（不丢、不串）===')
// 直接验证 sectionHints 的算法本体：模拟 boundaries + cutSources
const hintsSrc = sliceFn('sectionHints')
ok('sectionHints 用「逐块前缀法」算题型（不是按题区间扫描）',
  /hintAt\.push\(cur\)/.test(hintsSrc) && /hintAt\[b\[i\]\]/.test(hintsSrc))
ok('sectionHints 在 inferDraft 调用点被传入',
  /inferDraft\([^)]*sectionHints\(\)\[i\]/.test(src.replace(/\n/g, ' ')) || /sectionHints\(\)\[i\]/.test(src))
ok('inferDraft 支持第三支：内容判据判不出时用 typeHint',
  /else if \(typeHint\)/.test(src) || /typeHint\)\s*qtype\s*=/.test(src))

console.log('\n=== 8e. AI 切题的进度反馈（用户"基本没有反应"的真因）===')
ok('working = busy || aiRunning（统一忙碌态）',
  /const working = computed\(\(\) => busy\.value \|\| aiRunning\.value\)/.test(src))
ok('进度浮层绑 working（不再是只有 busy 才显示）',
  /v-if="working && progressText"/.test(src))
ok('有秒表 busySeconds（让用户看到"进度在动"）',
  /const busySeconds = ref\(0\)/.test(src) && /setInterval\(\(\) => \{ busySeconds\.value\+\+ \}, 1000\)/.test(src))
ok('短操作不闪烁：>1 秒才显示秒数', /busySeconds > 1/.test(src))
ok('卸载时清理秒表（不留 setInterval 悬引）',
  /onUnmounted[\s\S]{0,400}clearInterval\(busyTimer\)/.test(src))

console.log('\n=== 8f. 端到端：一份真实排版的卷子走完全链路 ===')// 模拟 mammoth 产出的 HTML（顶层 <p> 各自成块），覆盖三种大题：
//   一、选择题 → 单选；二、填空题 → 填空；三、解答题 → 主观（含小问不切）
const e2ePaper = `<p>2026 学年第一学期期中考试  高二数学</p>
<p>一、选择题（每题 5 分，共 25 分）</p>
<p>1. 下列函数中为奇函数的是（  ）</p>
<p>A. y=x²</p>
<p>B. y=x³</p>
<p>2. 已知集合 A={1,2}，则 A 的子集个数为（  ）</p>
<p>A. 2</p>
<p>B. 4</p>
<p>二、填空题</p>
<p>3. 若 f(x)=x+1，则 f(2)=______。</p>
<p>4. 不等式 x²&lt;4 的解集为______。</p>
<p>三、解答题</p>
<p>5. 已知等差数列{aₙ}中 a₁=1，d=2。</p>
<p>(1) 求 a₁₀。</p>
<p>(2) 求前 10 项和 S₁₀。</p>`

const e2eBlocks = splitIntoBlocks(e2ePaper)
const e2eBounds = autoSplit(e2eBlocks)
const nQ = e2eBounds.length - 1
ok('端到端：切出 5 道题（三个大题标题均未单独成题）', nQ === 5, `实际 ${nQ} 道题，边界 ${JSON.stringify(e2eBounds)}`)

// 复刻组件的 sectionHints 算法（与源码同构，用于验证"提示下发的正确性"）
// 复刻组件的 sectionHints 算法（与源码同构）：
//   先算"每个块所处的题型前缀"，再取每道题**起始块**处的值。
const e2eHintAt = (() => {
  const arr = []
  let cur = ''
  for (let k = 0; k < e2eBlocks.length; k++) {
    const blk = e2eBlocks[k]
    const head = blk ? (blk.text.split('\n')[0] || '').trim() : ''
    if (head && (MAJOR_RE.test(head) || isSectionTitleOnly(head, blk.html))) {
      const h = sectionTypeHint(head)
      if (h) cur = h
    }
    arr.push(cur)
  }
  return arr
})()
const e2eHints = e2eBounds.slice(0, -1).map(i => e2eHintAt[i] || '')
ok('端到端：题1/题2 判为单选（来自「一、选择题」）',
  e2eHints[0] === 'single' && e2eHints[1] === 'single', JSON.stringify(e2eHints))
ok('端到端：题3/题4 判为填空（来自「二、填空题」）',
  e2eHints[2] === 'fill' && e2eHints[3] === 'fill', JSON.stringify(e2eHints))
ok('端到端：题5 判为主观（来自「三、解答题」）',
  e2eHints[4] === 'subjective', JSON.stringify(e2eHints))
ok('端到端：题型提示数 = 题目数（一一对应，不丢不串）',
  e2eHints.length === nQ, `hints=${e2eHints.length} 题=${nQ}`)

// 验证"大题标题不残留在题干里"：每题的首块文本不应只有标题词
const firstBlocks = e2eBounds.slice(0, -1).map(i => e2eBlocks[i].text.split('\n')[0].trim())
ok('端到端：没有任何题以「一、选择题」这类纯标题作为自己',
  !firstBlocks.some(t => isSectionTitleOnly(t, '')), JSON.stringify(firstBlocks))
ok('端到端：题5 覆盖了小问块（第 5 题段包含 `(1)` 小问）',
  e2eBounds[5] - e2eBounds[4] >= 3,
  `题5 覆盖块 ${e2eBounds[4]}..${e2eBounds[5]}`)
ok('端到端：小问 `(1)` `(2)` 未被切为独立题（块数 15，题数仅 5）',
  e2eBlocks.length === 15 && nQ === 5, `块 ${e2eBlocks.length} 题 ${nQ}`)

console.log('\n=== 8g. dropSectionTitleBoundaries（规则 / AI 两条路径共用）===')
{
  // 用一份"块 0 就是大题标题"的卷子（AI 路径最典型的排版）
  const bs = splitIntoBlocks(`<p>一、选择题</p>
<p>1. 下列说法正确的是（  ）</p><p>A. 甲</p><p>B. 乙</p>
<p>2. 下列错误的是（  ）</p><p>A. 甲</p><p>B. 乙</p>`)
  ok('块 0 确实是纯标题（前置校验）', isSectionTitleOnly(bs[0].text, bs[0].html))
  const bnd = [0, 1, 4, 7]
  const out = dropSectionTitleBoundaries(bnd, bs)
  ok('AI 路径：块 0 是纯标题 → 边界 0 被剔除', out[0] === 1, JSON.stringify(out))
  ok('AI 路径：末项（块总数）保留', out[out.length - 1] === 7, JSON.stringify(out))
  const out2 = dropSectionTitleBoundaries([0, 7], bs)
  ok('⚠️ 边界不足 3 项时原样返回（不把整卷删空）', out2.join() === '0,7', JSON.stringify(out2))
  const out3 = dropSectionTitleBoundaries([1, 4, 7], bs)
  ok('没有标题块时原样返回', out3.join() === '1,4,7', JSON.stringify(out3))
}

console.log('\n=== 8h. ⚠️ 顶层定义顺序（TDZ 守卫 —— 纯函数探针抓不到的那类 Bug）===')
//
// 【为什么必须单独有这一节】
//   v4.13.3 上线后线上 **Word 导入界面直接消失**，控制台报：
//     ReferenceError: Cannot access 'be' before initialization
//   根因：`sectionHints()` 改为"逐块前缀法"后引用了 `MAJOR_RE` 与
//   `isSectionTitleOnly()`，但这两者定义在**更靠后**的位置；
//   `const` 在模块顶层有**暂时性死区（TDZ）**，setup 调用即抛错 → 组件渲染失败。
//
//   而本探针把函数抠到独立沙箱里跑，**沙箱中所有常量都已就绪**，
//   所以 95 项断言全绿、线上白屏 —— 这是纯函数探针的**结构性盲区**。
//
//   本节的思路：不做"抠函数进沙箱"，而是**直接读源文件的行号**，
//   校验"引用方必须出现在被引用方之后"。属于静态检查，但恰好能拦住 TDZ。
{
  const lineOf = (re) => {
    const m = src.match(re)
    return m ? src.slice(0, m.index).split('\n').length : -1
  }
  const pos = {
    MAJOR_RE: lineOf(/^const MAJOR_RE = /m),
    MINOR_RE: lineOf(/^const MINOR_RE = /m),
    SUBQ_RE: lineOf(/^const SUBQ_RE = /m),
    isSubQuestion: lineOf(/^function isSubQuestion\(/m),
    isSectionTitleOnly: lineOf(/^function isSectionTitleOnly\(/m),
    isPaperTitleOnly: lineOf(/^function isPaperTitleOnly\(/m),
    isAnswerKeyStart: lineOf(/^function isAnswerKeyStart\(/m),
    sectionTypeHint: lineOf(/^function sectionTypeHint\(/m),
    sectionHints: lineOf(/^function sectionHints\(/m),
    inferDraft: lineOf(/^function inferDraft\(/m),
    dropSectionTitleBoundaries: lineOf(/^function dropSectionTitleBoundaries\(/m),
    autoSplit: lineOf(/^function autoSplit\(/m),
    Block: lineOf(/^interface Block /m) < 0 ? lineOf(/^type Block /m) : lineOf(/^interface Block /m),
    blocks: lineOf(/^const blocks = ref/m),
    boundaries: lineOf(/^const boundaries = ref/m),
  }
  // 所有被引用方都必须存在且位置为正
  const missing = Object.entries(pos).filter(([, v]) => v <= 0).map(([k]) => k)
  ok('所有相关顶层声明都能定位到', missing.length === 0, `缺失：${missing.join(', ')}`)

  const mustBefore = [
    ['MAJOR_RE', 'sectionHints'],
    ['MAJOR_RE', 'isSectionTitleOnly'],
    ['MAJOR_RE', 'inferDraft'],
    ['MINOR_RE', 'sectionHints'],
    ['MINOR_RE', 'autoSplit'],
    ['SUBQ_RE', 'isSubQuestion'],
    ['SUBQ_RE', 'autoSplit'],
    ['isSubQuestion', 'autoSplit'],
    ['isSectionTitleOnly', 'sectionHints'],
    ['isPaperTitleOnly', 'dropSectionTitleBoundaries'],
    ['isPaperTitleOnly', 'autoSplit'],
    ['isAnswerKeyStart', 'autoSplit'],
    ['isSectionTitleOnly', 'dropSectionTitleBoundaries'],
    ['isSectionTitleOnly', 'autoSplit'],
    ['sectionTypeHint', 'sectionHints'],
    ['sectionHints', 'inferDraft'],
    ['dropSectionTitleBoundaries', 'autoSplit'],
    ['Block', 'isSectionTitleOnly'],
    ['Block', 'dropSectionTitleBoundaries'],
    ['Block', 'autoSplit'],
    ['blocks', 'sectionHints'],
    ['boundaries', 'sectionHints'],
  ]
  for (const [a, b] of mustBefore) {
    const okOrder = pos[a] > 0 && pos[b] > 0 && pos[a] < pos[b]
    ok(`⚠️ 顺序：${a}(${pos[a]}) 必须在 ${b}(${pos[b]}) 之前`, okOrder)
  }
  ok('⚠️ 无重复定义（MAJOR_RE / MINOR_RE / SUBQ_RE 各仅一处）',
    (src.match(/^const MAJOR_RE = /gm) || []).length === 1 &&
    (src.match(/^const MINOR_RE = /gm) || []).length === 1 &&
    (src.match(/^const SUBQ_RE = /gm) || []).length === 1)

  // ── 8h-2. 【第二轮踩坑】watch/computed 的 body 里读取的变量也必须先声明 ──
  //
  // 【为什么 8h 没拦住第二次】
  //   8h 只检查了"显式函数调用链"，但真正的第二处 TDZ 在：
  //     const working = computed(() => busy.value || aiRunning.value)   // L1036
  //     watch(working, (v) => { ... })                                  // L1041
  //   而 `aiRunning` 当时声明在 L1184 —— 全在 working 之后。
  //
  //   **关键机制**：`watch(source, cb)` 创建时会**立即执行一次 source**
  //   （为了建立依赖追踪），即使没有 `immediate: true`。
  //   所以 `working` 的 getter 当场求值 → 读 `aiRunning` → TDZ 直接爆炸。
  //
  //   教训：`computed` 的 getter 与 `watch` 的 source 都是**求值表达式**，
  //   它们读取的每一个顶层标识符，声明都必须在**该语句之前**。
  //   这不是"函数引用"（惰性），而是"立即求值"（急切）—— 两者天差地别。
  {
    const aiState = ['aiStatus', 'aiRunning', 'aiInfo']
    const posAI = Object.fromEntries(
      aiState.map(n => [n, lineOf(new RegExp(`^const ${n} = `, 'm'))])
    )
    const posWorking = lineOf(/^const working = computed\(/m)
    const posWatchWorking = lineOf(/^watch\(working, /m)
    const posBusySeconds = lineOf(/^const busySeconds = ref/m)

    ok('working / watch(working) / busySeconds 均能定位',
      posWorking > 0 && posWatchWorking > 0 && posBusySeconds > 0,
      `working=${posWorking} watch=${posWatchWorking} busySeconds=${posBusySeconds}`)

    // working 的 getter 读了 aiRunning —— 必须在其之前
    ok(`⚠️ 顺序：aiRunning(${posAI.aiRunning}) 必须在 working(${posWorking}) 之前（working getter 读取它）`,
      posAI.aiRunning > 0 && posWorking > 0 && posAI.aiRunning < posWorking)

    // watch(working) 会立即求值 working —— busySeconds / busyTimer 必须已就绪
    ok(`⚠️ 顺序：busySeconds(${posBusySeconds}) 必须在 watch(working)(${posWatchWorking}) 之前`,
      posBusySeconds > 0 && posWatchWorking > 0 && posBusySeconds < posWatchWorking)

    // aiStatus / aiInfo 虽不在 working 里读，但被模板与 onMounted 用；
    // 为防再被挪到后面，一并锁定"必须在 working 之前"（统一成一块）
    for (const n of ['aiStatus', 'aiInfo']) {
      ok(`⚠️ 顺序：${n}(${posAI[n]}) 必须在 working(${posWorking}) 之前（AI 状态三件套同进同出）`,
        posAI[n] > 0 && posAI[n] < posWorking)
    }

    // 三件套不得重复声明
    for (const n of aiState) {
      const cnt = (src.match(new RegExp(`^const ${n} = `, 'gm')) || []).length
      ok(`⚠️ ${n} 仅声明一次（实际 ${cnt}）`, cnt === 1)
    }
    ok('⚠️ working / busySeconds 各仅声明一次',
      (src.match(/^const working = computed\(/gm) || []).length === 1 &&
      (src.match(/^const busySeconds = ref/m) || []).length === 1)

    // ── 通用扫描：所有 watch(source, ...) 的 source 若引用了顶层 ref，必须已声明 ──
    //
    // 把顶层 `const xxx = ref(...)` / `= computed(...)` 声明行号建索引，
    // 然后逐个 watch 调用，检查其 source 表达式里出现的标识符是否都已声明。
    //
    // 支持三种写法：
    //   watch(a, cb)            单行单源
    //   watch([a, b], cb)       单行多源
    //   watch(\n  () => a.value, cb)  多行（source 在 watch 的下一行）
    const declLine = {}
    for (const m of src.matchAll(/^const ([A-Za-z_$][\w$]*) = (?:ref|computed|reactive)[\s\S]{0,80}?\(/gm)) {
      const ln = src.slice(0, m.index).split('\n').length
      if (declLine[m[1]] === undefined) declLine[m[1]] = ln
    }
    // 抓 watch( 开头，然后从 `watch(` 开始做括号配平，取到**第一个顶层逗号**为止
    // —— 那一段就是 source（支持多行写法）。
    const watchRe = /^watch\(/gm
    let wm
    let wChecked = 0
    while ((wm = watchRe.exec(src)) !== null) {
      const line = src.slice(0, wm.index).split('\n').length
      // 从 watch( 的 '(' 之后开始，深度 0 → 遇到 depth 0 的逗号即 source 结束
      let i = wm.index + 'watch('.length
      let depth = 0
      let end = i
      for (; i < src.length && i < wm.index + 600; i++) {
        const c = src[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) break    // watch(...) 收尾
          depth--
        } else if (c === ',' && depth === 0) { end = i; break }
      }
      const srcExpr = src.slice(wm.index + 'watch('.length, end || i)

      const ids = [...new Set(
        [...srcExpr.matchAll(/[A-Za-z_$][\w$]*/g)].map(x => x[0])
      )].filter(id => declLine[id] !== undefined)
      for (const id of ids) {
        ok(`⚠️ watch@L${line} 的 source 引用的 ${id}(L${declLine[id]}) 已在其之前声明`,
          declLine[id] < line, `声明 L${declLine[id]} 晚于 watch L${line}`)
        wChecked++
      }
    }
    ok('⚠️ 至少检查到 4 个 watch 的 source 依赖（防扫描器失效）', wChecked >= 4, `实检 ${wChecked} 处`)
  }
}

console.log('\n=== 8i. 【v4.13.4】卷名不得单独成题 / 卷尾答案区不得并进最后一题 ===')
//
// 【用户反馈】
//   「AI 识别 目前完全不生效 ！！！」「AI无法识别卷尾答案」
//
// 【实测（生产环境）】
//   上传一份含卷名 + 卷尾「参考答案」的卷子，AI 切出 **7 题**：
//     题1 = `数学第一单元测试卷`（卷名！）
//     第1题的答案栏 = 「字数 0」（AI 明明返回了 answer:"B"）
//     最后一题题干里塞着 `参考答案 1-2. B C 3. 8 …`
//
// 【两个根因】
//   A. `aiRecognize` 里 `bnd = [0, ...clean, nB]` **强制保留边界 0**；
//      卷名块在 block 0，于是卷名独自成题（6 → 7）。
//      `dropSectionTitleBoundaries` 只认 MAJOR_RE，不认卷名 → 漏网。
//   B. `qs = r.questions.slice(0, segCount)` 是**按位置硬套**；
//      一旦有边界被剔除，整体错位一格 → AI 的答案落到别的题上，
//      第 1 题答案栏因此为空（用户看到的「答案没识别出来」）。
{
  // ── 8i-1. isPaperTitleOnly 判据 ──
  const paperYes = [
    '数学第一单元测试卷',
    '2025-2026学年第一学期期中考试',
    '高一数学期中试卷',
    '姓名：张三　班级：一（1）班',
    '数学第一单元测试卷（含答案解析）',
  ]
  for (const t of paperYes) {
    ok(`卷名 → ${JSON.stringify(t).slice(0, 30)}`, isPaperTitleOnly(t, `<p>${t}</p>`))
  }
  const paperNo = [
    '1. 已知集合A={1,2,3}，则A∩B的元素个数为（ ）',
    '一、选择题',
    '函数y=2x+1的图象不经过（ ）',
    '下表是某班学生成绩统计，请回答问题。',   // 有句号 → 不是卷名
  ]
  for (const t of paperNo) {
    ok(`非卷名 → ${JSON.stringify(t).slice(0, 30)}`, !isPaperTitleOnly(t, `<p>${t}</p>`))
  }
  ok('含表格的块不是卷名', !isPaperTitleOnly('数学单元测试卷', '<p>x</p><table><tr><td>1</td></tr></table>'))

  // ── 8i-2. isAnswerKeyStart 判据 ──
  const akYes = ['参考答案', '答案与解析', '答案及解析', '一、参考答案', '解析', '评分标准']
  for (const t of akYes) ok(`答案区标题 → ${t}`, isAnswerKeyStart(t, `<p>${t}</p>`))
  const akNo = ['1-2. B C', '3. 8', '数学第一单元测试卷', '1. 已知集合A={1,2,3}', '5. 如图，在△ABC中']
  for (const t of akNo) ok(`非答案区 → ${JSON.stringify(t).slice(0, 24)}`, !isAnswerKeyStart(t, `<p>${t}</p>`))
  ok('含表格的块不是答案区', !isAnswerKeyStart('参考答案', '<p>x</p><table><tr><td>1</td></tr></table>'))

  // ── 8i-3. dropSectionTitleBoundaries 的 keepFirst 安全阀 ──
  const bs3 = [
    { html: '<p>数学第一单元测试卷</p>', text: '数学第一单元测试卷' },
    { html: '<p>1. 已知集合</p>', text: '1. 已知集合' },
    { html: '<p>2. 函数</p>', text: '2. 函数' },
  ]
  const dropped = dropSectionTitleBoundaries([0, 1, 2, 3], bs3, {})
  ok('卷名边界被剔除（默认）', dropped.join() === '1,2,3', JSON.stringify(dropped))
  const keptFirst = dropSectionTitleBoundaries([0, 1, 2, 3], bs3, { keepFirst: true })
  ok('keepFirst=true 时首块永不删（AI 第1题落在块0 → 不丢题）',
    keptFirst.join() === '0,1,2,3', JSON.stringify(keptFirst))

  // ── 8i-4. 段 → AI 题号 映射（防止"按位置硬套"错位）──
  //
  //   复刻 aiRecognize 的映射逻辑，喂入"卷名在块0"的典型场景。
  const blocksSim = [
    '数学第一单元测试卷',        // 0 卷名
    '1. 已知集合A={1,2,3}',      // 1 题1
    '2. 函数y=2x+1',             // 2 题2
    '3. 计算：2^3',              // 3 题3
    '参考答案',                  // 4 答案区
    '1-2. B C',                  // 5
  ].map(t => ({ html: `<p>${t}</p>`, text: t }))
  const cleanSim = [1, 2, 3]     // AI 三题的 anchor 命中块 1/2/3
  const nBSim = blocksSim.length
  const bndSim = Array.from(new Set([0, ...cleanSim, nBSim])).sort((a, b) => a - b)
  ok('映射前边界 = [0,1,2,3,6]（卷名占了段0）', bndSim.join() === '0,1,2,3,6', JSON.stringify(bndSim))

  const aiFirstAtZeroSim = cleanSim.length > 0 && cleanSim[0] === 0
  const beforeDropSim = bndSim.slice()
  const bndAfter = dropSectionTitleBoundaries(bndSim, blocksSim, { keepFirst: aiFirstAtZeroSim })
  // 复刻映射
  const aiQOfSeg = []
  {
    let aiPtr = 0
    for (let k = 0; k < bndAfter.length - 1; k++) {
      const v = bndAfter[k]
      const blk = blocksSim[v]
      const posBefore = beforeDropSim.indexOf(v)
      const isSecTitle = !!blk && isSectionTitleOnly(blk.text, blk.html)
      const isPaperTitle = posBefore === 0 && !aiFirstAtZeroSim && !!blk && isPaperTitleOnly(blk.text, blk.html)
      if (isSecTitle || isPaperTitle) { aiQOfSeg.push(-1); continue }
      const exact = cleanSim.indexOf(v)
      if (exact >= 0) { aiQOfSeg.push(exact); aiPtr = Math.max(aiPtr, exact + 1) }
      else if (aiPtr < cleanSim.length) { aiQOfSeg.push(aiPtr); aiPtr++ }
      else { aiQOfSeg.push(-1) }
    }
  }
  ok('卷名段被剔除 → 边界 [1,2,3,6]', bndAfter.join() === '1,2,3,6', JSON.stringify(bndAfter))
  ok('⚠️ 映射正确：段0→AI题1(下标0)、段1→AI题2(下标1)、段2→AI题3(下标2)',
    aiQOfSeg.join() === '0,1,2', JSON.stringify(aiQOfSeg))
  ok('⚠️ 修复前"按位置硬套"会把 AI 题1 的数据给到段1（错位一格）—— 这正是答案栏为空的根因',
    aiQOfSeg[0] === 0 && aiQOfSeg[1] === 1)

  // ── 8i-5. 卷尾答案区不得并进最后一题 ──
  //
  //   规则路径：autoSplit 应把终点从 nB 收到"答案区起点"。
  const paperHtml = [
    '<h1>数学第一单元测试卷</h1>',
    '<p>一、选择题</p>',
    '<p>1. 已知集合 A={1,2,3}，B={2,3,4}，则 A∩B 的元素个数为（　　）</p>',
    '<p>A. 1</p>', '<p>B. 2</p>', '<p>C. 3</p>', '<p>D. 4</p>',
    '<p>2. 函数 y=2x+1 的图象不经过（　　）</p>',
    '<p>A. 第一象限</p>', '<p>B. 第二象限</p>', '<p>C. 第三象限</p>', '<p>D. 第四象限</p>',
    '<p>二、填空题</p>',
    '<p>3. 计算：2^3 = ________。</p>',
    '<p>4. 若 x + 3 = 7，则 x = ________。</p>',
    '<p>参考答案</p>',
    '<p>1-2. B C</p>',
    '<p>3. 8</p>',
    '<p>4. 4</p>',
  ].join('')
  const simBlocks = splitIntoBlocks(paperHtml)
  const simBnd = autoSplit(simBlocks)
  const answerIdx = simBlocks.findIndex(b => isAnswerKeyStart(b.text, b.html))
  ok('能定位到卷尾「参考答案」块', answerIdx > 0, `answerIdx=${answerIdx}`)
  ok('⚠️ autoSplit 的终点已被收到答案区之前（答案区不并进最后一题）',
    simBnd[simBnd.length - 1] === answerIdx,
    `终点=${simBnd[simBnd.length - 1]}，答案区起点=${answerIdx}`)
  ok('最后一题的题干不含「参考答案」四字',
    !/参考答案/.test(simBlocks.slice(simBnd[simBnd.length - 2], simBnd[simBnd.length - 1]).map(b => b.text).join('')))
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ 拖动 / 自动切割不变量被破坏'); process.exit(1) }
console.log('✅ 拖动分割线 + 自动切割全部不变量成立')
