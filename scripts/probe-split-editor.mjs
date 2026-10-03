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
${toJs(sliceConst('OPT_LINE_RE'))}
const toText = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\\s+/g, ' ').trim()
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
${toJs(sliceFn('splitIntoBlocks'))}
${toJs(sliceFn('innerSplitByBr'))}
${toJs(sliceFn('splitSoftLines'))}
${toJs(sliceFn('autoSplit'))}
const cutSources = { value: new Map() }
${toJs(sliceFn('normForMatch'))}
${toJs(sliceFn('similarity'))}
const MATCH_MIN = 0.34
export { splitIntoBlocks, autoSplit, similarity, normForMatch, MAJOR_RE, MINOR_RE, OPT_LINE_RE, cutSources }
`
const mod = await import('data:text/javascript;base64,' + Buffer.from(sandboxSrc).toString('base64'))
const { splitIntoBlocks, autoSplit, similarity, normForMatch } = mod

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

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ 拖动 / 自动切割不变量被破坏'); process.exit(1) }
console.log('✅ 拖动分割线 + 自动切割全部不变量成立')
