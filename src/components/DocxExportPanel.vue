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
import { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, HeadingLevel, PageBreak, Table, TableRow, TableCell, WidthType, BorderStyle, Math as MathOMML, MathRun, MathFraction, MathRadical, MathSubScript, MathSuperScript, MathSubSuperScript } from 'docx'
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

// ===== 富文本 → docx 行内内容（尽力保留 公式/图片/加粗） =====
// 【v4.6.0 真修】题目中的图片导不出来，根因有两点：
//   ① 题库图片存为 /api/file/{id}（私有附件），fetchImage 之前不带 token 直取 → 后端 401，
//      被 catch 静默吞掉 → 图片整张丢失。现改为「先免 token 试取，失败再带 token 重试」。
//   ② ImageRun 的 transformation.height 被写成 'auto'（非法值）→ 图片高度 0，Word 不渲染。
//      现改为：拉到图片后用 canvas 归一化为 PNG，并取真实像素尺寸，按比例限制最大宽度。
async function fetchImage(url: string): Promise<{ data: ArrayBuffer; width: number; height: number } | null> {
  try {
    const clean = String(url).replace(/\s+/g, '')
    const abs = clean.startsWith('http') || clean.startsWith('//')
      ? clean.startsWith('//') ? 'https:' + clean : clean
      : API_BASE + clean
    const token = (typeof localStorage !== 'undefined' && localStorage.getItem('zg_token')) || ''
    const tryFetch = async (withToken: boolean) => {
      let u = abs
      if (withToken && abs.includes('/api/file/')) u = abs + (abs.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
      return fetch(u)
    }
    let r = await tryFetch(false)
    if (!r.ok && token) r = await tryFetch(true)
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    const objUrl = URL.createObjectURL(new Blob([buf]))
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img load fail')); img.src = objUrl })
    const nw = img.naturalWidth || 360, nh = img.naturalHeight || 240
    const scale = Math.min(1, 480 / nw) // 限制最大宽度 480，避免超宽图撑破版心
    const cw = Math.max(40, Math.round(nw * scale)), ch = Math.max(30, Math.round(nh * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    const ctx = canvas.getContext('2d')
    if (!ctx) { URL.revokeObjectURL(objUrl); return null }
    ctx.drawImage(img, 0, 0, cw, ch)
    URL.revokeObjectURL(objUrl)
    const png = await new Promise<Blob | null>(x => canvas.toBlob(x, 'image/png'))
    if (!png) return null
    return { data: await png.arrayBuffer(), width: cw, height: ch }
  } catch { return null }
}

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

/**
 * 【v4.5.3 真修】把 KaTeX 渲染出的 DOM 的**计算样式内联**到每个节点。
 * 原因：SVG <img> 加载时，<style> 里的 CSS 类规则不会应用到 foreignObject 内的 HTML
 *      （只认元素上的内联 style），因此直接把 computedStyle 拍到 style 属性上。
 * 只保留影响视觉的关键属性，避免体积爆炸。
 */
const INLINE_STYLE_PROPS = [
  'display', 'position', 'top', 'left', 'margin', 'margin-top', 'margin-left', 'margin-right', 'margin-bottom',
  'padding', 'border-width', 'border-style', 'border-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'vertical-align', 'white-space', 'letter-spacing', 'color', 'background-color', 'text-align',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'box-sizing', 'overflow', 'transform', 'top', 'bottom',
]
function inlineComputedStyles(src: HTMLElement): string {
  const clone = src.cloneNode(true) as HTMLElement
  const srcNodes = [src, ...Array.from(src.querySelectorAll<HTMLElement>('*'))]
  const cloneNodes = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))]
  for (let i = 0; i < srcNodes.length; i++) {
    const s = window.getComputedStyle(srcNodes[i])
    const cl = cloneNodes[i]
    if (!cl) continue
    const parts: string[] = []
    for (const prop of INLINE_STYLE_PROPS) {
      const v = s.getPropertyValue(prop)
      if (v && v !== 'normal' && v !== 'auto' && v !== 'none' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') parts.push(`${prop}:${v}`)
    }
    cl.setAttribute('style', parts.join(';'))
  }
  return clone.outerHTML
}

// ============================================================================
// 【v4.5.3 真修】LaTeX → OMML（Word 原生公式）
// 背景：此前用「KaTeX 渲染 → SVG(foreignObject) → canvas → PNG」，
//   ① blob: URL 会让 canvas 被污染（toBlob 抛 SecurityError）；
//   ② 改用 data: URL 后仍失败——KaTeX 字体（KaTeX_Main 等）在 SVG/canvas 上下文中
//      处于 unloaded 状态，字形画不出来 → 导出的是**空白图片**。
// 方案：直接生成 Word 原生公式（OMML），docx v9 内置 Math* 组件支持。
//   优点：矢量清晰、可在 Word 中编辑、无字体依赖、体积小。零成本。
//   仅覆盖中学题库常见语法；无法解析的退化为纯文本（绝不丢内容）。
// ============================================================================
const MATH_TEX_CMD: Record<string, string> = {
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε', '\\varepsilon': 'ε',
  '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\rho': 'ρ', '\\sigma': 'σ', '\\tau': 'τ',
  '\\phi': 'φ', '\\varphi': 'φ', '\\omega': 'ω', '\\Delta': 'Δ', '\\Omega': 'Ω', '\\Sigma': 'Σ', '\\Lambda': 'Λ',
  '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓', '\\cdot': '·', '\\ast': '∗',
  '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\ne': '≠', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
  '\\infty': '∞', '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\subseteq': '⊆', '\\cup': '∪', '\\cap': '∩',
  '\\emptyset': '∅', '\\varnothing': '∅', '\\forall': '∀', '\\exists': '∃', '\\nabla': '∇',
  '\\rightarrow': '→', '\\to': '→', '\\leftarrow': '←', '\\Rightarrow': '⇒', '\\Leftarrow': '⇐',
  '\\leftrightarrow': '↔', '\\cdots': '⋯', '\\ldots': '…', '\\dots': '…', '\\angle': '∠', '\\perp': '⊥',
  '\\parallel': '∥', '\\sim': '∼', '\\cong': '≅', '\\because': '∵', '\\therefore': '∴', '\\degree': '°',
  '\\sin': 'sin', '\\cos': 'cos', '\\tan': 'tan', '\\cot': 'cot', '\\sec': 'sec', '\\csc': 'csc',
  '\\log': 'log', '\\ln': 'ln', '\\lg': 'lg', '\\max': 'max', '\\min': 'min', '\\lim': 'lim',
  '\\circ': '∘', '\\prime': '′', '\\%': '%', '\\{': '{', '\\}': '}', '\\_': '_', '\\$': '$', '\\&': '&', '\\#': '#',
}

/** 把一段简单 LaTeX 文本转为 MathRun 序列（处理转义命令与单字符） */
function texToMathRuns(tex: string): any[] {
  const runs: any[] = []
  let buf = ''
  const flush = () => { if (buf) { runs.push(new MathRun(buf)); buf = '' } }
  let i = 0
  while (i < tex.length) {
    const ch = tex[i]
    if (ch === '\\') {
      // 命令：尽可能取最长匹配（\alpha、\leq…）
      let cmd = ch
      let j = i + 1
      if (j < tex.length && /[a-zA-Z]/.test(tex[j])) {
        while (j < tex.length && /[a-zA-Z]/.test(tex[j])) j++
        cmd = tex.slice(i, j)
      } else { j = i + 2; cmd = tex.slice(i, j) }
      flush()
      runs.push(new MathRun(MATH_TEX_CMD[cmd] ?? cmd.replace(/^\\/, '')))
      i = j
      continue
    }
    if (ch === '{' || ch === '}') { i++; continue } // 分组括号本身不出现在行内
    if (ch === ' ') { flush(); runs.push(new MathRun(' ')); i++; continue }
    buf += ch; i++
  }
  flush()
  return runs.length ? runs : [new MathRun('')]
}

/** 取出 {…} 分组内容（支持一层嵌套），返回 [内容, 新索引] */
function readGroup(tex: string, start: number): [string, number] {
  while (start < tex.length && tex[start] === ' ') start++
  if (tex[start] !== '{') {
    // 无花括号：单个字符或单个命令
    if (tex[start] === '\\') { let j = start + 1; while (j < tex.length && /[a-zA-Z]/.test(tex[j])) j++; return [tex.slice(start, j), j] }
    return [tex.slice(start, start + 1), start + 1]
  }
  let depth = 0, i = start, out = ''
  for (; i < tex.length; i++) {
    const c = tex[i]
    if (c === '{') { depth++; if (depth === 1) continue }
    else if (c === '}') { depth--; if (depth === 0) { i++; break } }
    out += c
  }
  return [out, i]
}

/**
 * LaTeX → OMML（Word 原生公式）。
 * 支持：\frac、\sqrt（含 \sqrt[n]）、上下标 _ ^、\text/\mathrm、常见符号命令。
 * 返回 Math 组件；解析异常时返回 null（调用方退化为纯文本）。
 */
function latexToOmml(tex: string): any | null {
  try {
    return new MathOMML({ children: parseTexNode(tex) })
  } catch { return null }
}

function parseTexNode(tex: string): any[] {
  const out: any[] = []
  let i = 0
  const pushRuns = (s: string) => { if (s) out.push(...texToMathRuns(s)) }
  let pending = ''
  while (i < tex.length) {
    const rest = tex.slice(i)
    // \frac{a}{b}
    if (rest.startsWith('\\frac') || rest.startsWith('\\dfrac') || rest.startsWith('\\tfrac')) {
      pushRuns(pending); pending = ''
      const cmdLen = rest.startsWith('\\dfrac') || rest.startsWith('\\tfrac') ? 6 : 5
      const [num, j1] = readGroup(tex, i + cmdLen)
      const [den, j2] = readGroup(tex, j1)
      out.push(new MathFraction({
        numerator: parseTexNode(num),
        denominator: parseTexNode(den),
      }))
      i = j2; continue
    }
    // \sqrt[n]{a} 或 \sqrt{a}
    if (rest.startsWith('\\sqrt')) {
      pushRuns(pending); pending = ''
      let j = i + 5
      let degree: any = null
      if (tex[j] === '[') { const close = tex.indexOf(']', j); if (close > -1) { degree = parseTexNode(tex.slice(j + 1, close)); j = close + 1 } }
      const [rad, j2] = readGroup(tex, j)
      const opts: any = { children: parseTexNode(rad) }
      if (degree) opts.degree = degree
      out.push(new MathRadical(opts))
      i = j2; continue
    }
    // 上标/下标：^ 与 _ 可组合
    if (tex[i] === '^' || tex[i] === '_') {
      pushRuns(pending); pending = ''
      const base = out.pop() ?? new MathRun('')
      let sup: any[] | null = null, sub: any[] | null = null
      let j = i
      for (let k = 0; k < 2 && j < tex.length && (tex[j] === '^' || tex[j] === '_'); k++) {
        const isSup = tex[j] === '^'
        const [g, j2] = readGroup(tex, j + 1)
        if (isSup) sup = parseTexNode(g); else sub = parseTexNode(g)
        j = j2
      }
      if (sup && sub) out.push(new MathSubSuperScript({ children: [base], subScript: sub, superScript: sup }))
      else if (sup) out.push(new MathSuperScript({ children: [base], superScript: sup }))
      else if (sub) out.push(new MathSubScript({ children: [base], subScript: sub }))
      else out.push(base)
      i = j; continue
    }
    // \text{…} / \mathrm{…} → 直排文字
    if (rest.startsWith('\\text') || rest.startsWith('\\mathrm') || rest.startsWith('\\operatorname')) {
      pushRuns(pending); pending = ''
      const cmd = rest.startsWith('\\operatorname') ? 13 : (rest.startsWith('\\mathrm') ? 7 : 5)
      const [g, j2] = readGroup(tex, i + cmd)
      pushRuns(g)
      i = j2; continue
    }
    pending += tex[i]; i++
  }
  pushRuns(pending)
  return out
}

async function katexToImage(tex: string): Promise<{ data: ArrayBuffer; type: 'png'; w: number; h: number } | null> {
  try {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-99999px;top:0;background:#fff;padding:2px;'
    document.body.appendChild(host)
    katex.render(tex, host, { throwOnError: false, displayMode: false })
    const ke = host.querySelector('.katex') as HTMLElement
    if (!ke) { document.body.removeChild(host); console.warn('[katexToImage] 未渲染出 .katex:', tex); return null }
    const w = Math.max(ke.offsetWidth, 12), h = Math.max(ke.offsetHeight, 12)
    // 内联计算样式后再塞进 foreignObject（<style> 类规则在 <img> 中不生效，会导致空白图）
    const inner = inlineComputedStyles(ke)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${inner}</foreignObject></svg>`
    // 【v4.5.3 真修】必须用 data: URL，绝不能用 blob: URL。
    //   blob: 加载的 SVG（含 foreignObject）会污染 canvas，toBlob 抛
    //   "SecurityError: Tainted canvases may not be exported"，导致公式转图全部失败并静默降级成 LaTeX 原文。
    const u = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg img load fail')); img.src = u })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = w * scale; canvas.height = h * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) { document.body.removeChild(host); console.warn('[katexToImage] 无 2d context'); return null }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/png'))
    document.body.removeChild(host)
    if (!png) { console.warn('[katexToImage] toBlob 返回 null:', tex); return null }
    return { data: await png.arrayBuffer(), type: 'png', w: Math.min(w, 360), h: Math.round(h * Math.min(w, 360) / w) }
  } catch (e) { console.warn('[katexToImage] 异常:', tex, String(e)); return null }
}

const INLINE_RE = /(\$\$[\s\S]+?\$\$)|(\$[^$\n]+?\$)|(\!\[[^\]]*\]\([^)]*\))|(\*\*[^*]+\*\*)/g
// 清理 file:// 附件裸引用（网页端是蓝色链接，Word 里应转成可读性文本，避免导出出一堆 file://xxx）
function cleanText(s: string): string {
  return s.replace(/file:\/\/\S+/g, (m) => {
    const name = m.replace(/^file:\/\//, '')
    return name ? `[附件:${name}]` : ''
  })
}
// 【v4.7.0 真修】把一段纯文本按 \n 拆成 TextRun，换行用 break 保留（修复「导出 Word 自动吞没换行」）
function textRuns(s: string, size: number): any[] {
  const parts = s.split('\n')
  const out: any[] = []
  parts.forEach((p, i) => {
    if (i > 0) out.push(new TextRun({ text: '', break: 1 }))
    if (p) out.push(new TextRun({ text: p, size }))
  })
  return out
}
async function inlineRuns(text: string, size: number, boldPrefix = ''): Promise<any[]> {
  const runs: any[] = []
  // 【v4.5.3】boldPrefix：句首加粗标签（如「【答案】」），避免事后对 TextRun 做内省（docx v9 无公开 text 属性）
  if (boldPrefix && text.startsWith(boldPrefix)) {
    runs.push(new TextRun({ text: boldPrefix, bold: true, size }))
    text = text.slice(boldPrefix.length)
  }
  let last = 0, m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) { runs.push(...textRuns(cleanText(text.slice(last, m.index)), size)) }
    const t = m[0]
    if (t.startsWith('$') && t.length > 2) {
      const tex = t.replace(/^\$\$?|\$\$?$/g, '').trim()
      // 【v4.5.3】优先 OMML 原生公式（矢量、Word 内可编辑，不依赖 KaTeX 字体）
      let omml: any = null
      try { omml = latexToOmml(tex) } catch (e) { console.warn('[omml] 转换失败，回退图片:', tex, String(e)); omml = null }
      if (omml) {
        runs.push(omml)
      } else {
        const img = await katexToImage(tex)
        if (img) runs.push(new ImageRun({ data: img.data, type: 'png', transformation: { width: img.w, height: img.h } }))
        else runs.push(new TextRun({ text: ` ${tex} `, size, italics: true }))
      }
    } else if (t.startsWith('![')) {
      const url = (t.match(/\(([^)]+)\)/) || [])[1]
      if (url) {
        const img = await fetchImage(url)
        if (img) runs.push(new ImageRun({ data: img.data, type: 'png', transformation: { width: img.width, height: img.height } }))
        else runs.push(new TextRun({ text: ' [图片] ', size }))
      }
    } else if (t.startsWith('**')) {
      runs.push(new TextRun({ text: t.slice(2, -2), size, bold: true }))
    }
    last = INLINE_RE.lastIndex
  }
  if (last < text.length) { runs.push(...textRuns(cleanText(text.slice(last)), size)) }
  return runs.length ? runs : [new TextRun({ text: cleanText(text), size })]
}

/**
 * 【v4.7.0 真修】Markdown → Word 段落（修复「markdown 样式未变为正常 Word 文字大小样式」）
 * 支持：#/##/### 标题（按层级放大加粗）、-/* 无序列表、1. 有序列表、> 引用、普通段落；
 * 行内保留 **加粗** / $公式$ / ![图片] / 链接；换行用 break 保留。
 */
async function mdToParagraphs(md: string, size: number, opts: { indent?: number; spacingAfter?: number } = {}): Promise<any[]> {
  const lines = (md || '').split('\n')
  const out: any[] = []
  const baseIndent = opts.indent || 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const hs = size + (4 - h[1].length) * 2
      out.push(new Paragraph({ children: await inlineRuns(h[2], hs), spacing: { before: 100, after: 40 }, ...(baseIndent ? { indent: { left: baseIndent } } : {}) }))
      i++; continue
    }
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      const items: string[] = []
      while (i < lines.length) { const mm = lines[i].match(/^[-*]\s+(.*)$/); if (!mm) break; items.push(mm[1]); i++ }
      for (const it of items) out.push(new Paragraph({ children: [new TextRun({ text: '•  ', size }), ...(await inlineRuns(it, size))], indent: { left: baseIndent + 260, hanging: 240 }, spacing: { after: 24 } }))
      continue
    }
    const num = line.match(/^(\d+)\.\s+(.*)$/)
    if (num) {
      const items: { n: string; t: string }[] = []
      while (i < lines.length) { const mm = lines[i].match(/^(\d+)\.\s+(.*)$/); if (!mm) break; items.push({ n: mm[1], t: mm[2] }); i++ }
      for (const it of items) out.push(new Paragraph({ children: [new TextRun({ text: it.n + '. ', size, bold: true }), ...(await inlineRuns(it.t, size))], indent: { left: baseIndent + 260, hanging: 240 }, spacing: { after: 24 } }))
      continue
    }
    const q = line.match(/^>\s?(.*)$/)
    if (q) {
      out.push(new Paragraph({ children: await inlineRuns(q[1], size), indent: { left: baseIndent + 260 }, spacing: { after: 24 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 6 } } }))
      i++; continue
    }
    out.push(new Paragraph({ children: await inlineRuns(line, size), spacing: { after: opts.spacingAfter ?? 30 }, ...(baseIndent ? { indent: { left: baseIndent } } : {}) }))
    i++
  }
  return out.length ? out : [new Paragraph({ children: await inlineRuns(md || '', size) })]
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
        description="Word 导出在浏览器端完成，使用免费开源库 docx.js，零成本。公式导出为 Word 原生公式（OMML），可直接在 Word 中编辑；复杂排版建议在网页端最终校对。" />
      <el-button type="primary" :disabled="!props.items.length" @click="onExport" icon="Download">生成并下载 Word</el-button>
    </el-form>
  </div>
</template>

<style scoped>
.export-panel { padding: 4px; }
.fs-hint { margin-left: 10px; color: #b06a00; font-weight: 700; }
</style>
