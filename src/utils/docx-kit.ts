// ===== 【v4.9.1】Word 试卷构建内核（从 DocxExportPanel 抽出，供导出器与「原卷分栏编辑」共用）=====
//
// 【为什么要抽出来】
//   用户原话：「我必须要传进去是什么，渲染的是什么，最后导出 word 就是什么！！！」
//   而「Word 试卷导入 · 原卷分栏编辑」左侧的**网站渲染**视图，此前是自己用
//   `htmlToMarkdown()` + `renderMarkdown()` 拼的 —— 与真正导出 Word 的那条链路
//   （`mdToParagraphs` + `inlineRuns`，含 LaTeX→OMML、图片按 URL 抓取、合并表格还原）
//   **完全是两套实现**。两套实现必然漂移：网站上看着好好的，导出就错乱。
//
//   现在的做法：**只留一条链路**。分栏编辑器调用 `renderContentToDocx()` 生成一份
//   真正的 .docx 二进制，再交给 docx-preview 渲染 —— 这份 docx 和用户最终下载的
//   是**同一个构建器**产出的。这样「网站渲染 = Word 保真渲染 = 最终导出」三者天然一致。
//
// 【与 DocxExportPanel 的关系】
//   这里是纯函数内核，不带 Vue 响应式、不依赖组件的 cfg。
//   DocxExportPanel 仍保留自己的 UI 状态（标题/分值/是否两栏等），只把「内容 → 段落」
//   这一段委托过来；两个入口共享同一份实现，行为零漂移。

import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  WidthType, BorderStyle, VerticalMergeType, AlignmentType, HeadingLevel, Footer,
  PageNumber, TabStopType,
  Math as MathOMML, MathRun, MathFraction, MathRadical,
  MathSubScript, MathSuperScript, MathSubSuperScript,
} from 'docx'
import katex from 'katex'
import { API_BASE } from './helpers'
import { htmlToMarkdown, looksLikeHtml, needsHtmlFidelity } from './html-to-md'
import { scanInlineMd, decodeDataImageUrl, isLocalDiskImageUrl } from './md-rich'

// ===== 通用小工具 =====
export function withToken(u: string, token: string): string {
  if (!token) return u
  const sep = u.includes('?') ? '&' : '?'
  return `${u}${sep}token=${encodeURIComponent(token)}`
}

const CELL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'BBBBBB' },
}
export function cellBorder() { return { ...CELL_BORDER } }
export function cell(children: any[], widthPct?: number): TableCell {
  return new TableCell({
    borders: cellBorder(),
    width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
    children,
  })
}

/** 带合并信息的表格单元格（rowspan → vMerge / colspan → columnSpan） */
export function wordCell(children: any[], opts: { columnSpan?: number; vMerge?: 'restart' | 'continue' } = {}): TableCell {
  return new TableCell({
    borders: cellBorder(),
    children: children.length ? children : [new Paragraph({ children: [] })],
    ...(opts.columnSpan ? { columnSpan: opts.columnSpan } : {}),
    ...(opts.vMerge
      ? { verticalMerge: opts.vMerge === 'restart' ? VerticalMergeType.RESTART : VerticalMergeType.CONTINUE }
      : {}),
  })
}

// ===== KaTeX → OMML（矢量原生公式，Word 内可编辑）=====
//
// 【v4.5.3 关键实现细节】把 KaTeX 渲染出的 DOM 的**计算样式内联**到每个节点。
// 原因：SVG <img> 加载时，<style> 里的 CSS 类规则不会应用到 foreignObject 内的 HTML
//      （只认元素上的内联 style），因此直接把 computedStyle 拍到 style 属性上。
const INLINE_STYLE_PROPS = [
  'display', 'position', 'top', 'left', 'margin', 'margin-top', 'margin-left', 'margin-right', 'margin-bottom',
  'padding', 'border-width', 'border-style', 'border-color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'font-variant', 'font-stretch', 'line-height', 'letter-spacing', 'text-align', 'text-decoration',
  'vertical-align', 'color', 'background-color', 'white-space', 'min-width', 'width', 'height', 'overflow',
  'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
  'border-top-style', 'border-bottom-style', 'border-left-style', 'border-right-style',
  'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
  'box-sizing', 'transform', 'transform-origin', 'flex', 'flex-direction', 'align-items', 'justify-content', 'gap',
]

export function inlineComputedStyles(src: HTMLElement, dst: HTMLElement) {
  const cs = window.getComputedStyle(src)
  const parts: string[] = []
  for (const p of INLINE_STYLE_PROPS) {
    const v = cs.getPropertyValue(p)
    if (v && v !== 'normal' && v !== 'auto' && v !== 'none' && v !== '0px') parts.push(`${p}:${v}`)
  }
  dst.setAttribute('style', parts.join(';'))
  const sc = Array.from(src.children) as HTMLElement[]
  const dc = Array.from(dst.children) as HTMLElement[]
  for (let i = 0; i < sc.length && i < dc.length; i++) inlineComputedStyles(sc[i], dc[i])
}

export function katexToSvgHtml(tex: string): { html: string; w: number; h: number } | null {
  try {
    const tmp = document.createElement('div')
    tmp.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden'
    document.body.appendChild(tmp)
    katex.render(tex, tmp, { throwOnError: false, displayMode: false, output: 'html' })
    const katexEl = tmp.querySelector('.katex') as HTMLElement | null
    if (!katexEl) { tmp.remove(); return null }
    const rect = katexEl.getBoundingClientRect()
    const w = Math.max(8, Math.ceil(rect.width))
    const h = Math.max(10, Math.ceil(rect.height))
    const clone = katexEl.cloneNode(true) as HTMLElement
    inlineComputedStyles(katexEl, clone)
    tmp.remove()
    return { html: clone.outerHTML, w, h }
  } catch { return null }
}

export async function katexToImage(tex: string): Promise<{ data: ArrayBuffer; type: 'png'; w: number; h: number } | null> {
  const svg = katexToSvgHtml(tex)
  if (!svg) return null
  const { w, h } = svg
  const scale = 3.2
  const cw = Math.ceil(w * scale)
  const ch = Math.ceil(h * scale)
  const svgDoc = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}">` +
    `<foreignObject width="100%" height="100%">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${1.2 * scale}em;line-height:1.2">${svg.html}</div>` +
    `</foreignObject></svg>`
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgDoc)
  const img = new Image()
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('svg load fail')); img.src = url })
  const canvas = document.createElement('canvas')
  canvas.width = cw; canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, cw, ch)
  const png = await new Promise<Blob | null>(x => canvas.toBlob(x, 'image/png'))
  if (!png) return null
  return { data: await png.arrayBuffer(), type: 'png', w: Math.ceil(cw / scale), h: Math.ceil(ch / scale) }
}

/** LaTeX（KaTeX 子集）→ OMML。失败返回 null，调用方回退成图片。 */
export function latexToOmml(tex: string): any | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M: any = { MathOMML, MathRun, MathFraction, MathRadical, MathSubScript, MathSuperScript, MathSubSuperScript }
  try {
    const nodes: any[] = []
    // 极简解析：\frac{}{}, \sqrt{}, ^{}, _{}, 其余按字面 MathRun
    let i = 0
    const s = tex
    const readGroup = (): string => {
      if (s[i] !== '{') { const c = s[i] || ''; i++; return c }
      let depth = 0, out = ''
      for (; i < s.length; i++) {
        const ch = s[i]
        if (ch === '{') { depth++; if (depth === 1) continue }
        if (ch === '}') { depth--; if (depth === 0) { i++; break } }
        out += ch
      }
      return out
    }
    const parseSeq = (stopAtBrace: boolean): any[] => {
      const out: any[] = []
      while (i < s.length) {
        const ch = s[i]
        if (stopAtBrace && ch === '}') break
        if (ch === '\\') {
          const cmd = /^\\([a-zA-Z]+)/.exec(s.slice(i))
          if (cmd) {
            const name = cmd[1]
            i += cmd[0].length
            if (name === 'frac') {
              const a = readGroup(); const b = readGroup()
              out.push(new M.MathFraction({ numerator: parseInline(a), denominator: parseInline(b) }))
              continue
            }
            if (name === 'sqrt') {
              const a = readGroup()
              out.push(new M.MathRadical({ children: parseInline(a) }))
              continue
            }
            out.push(new M.MathRun(name === 'cdot' ? '·' : name === 'times' ? '×' : name === 'div' ? '÷' : name === 'pm' ? '±' : ' '))
            continue
          }
          i++; continue
        }
        if (ch === '^' || ch === '_') {
          i++
          const grp = readGroup()
          const base = out.pop() || new M.MathRun('')
          if (ch === '^') out.push(new M.MathSuperScript({ children: [base], superScript: parseInline(grp) }))
          else out.push(new M.MathSubScript({ children: [base], subScript: parseInline(grp) }))
          continue
        }
        if (ch === '{') { const g = readGroup(); out.push(...parseInline(g)); continue }
        out.push(new M.MathRun(ch)); i++
      }
      return out
    }
    const parseInline = (t: string): any[] => {
      const save = i, saveS = s
      // 用闭包外的 s/i 无法重入，这里用独立子解析：直接把 t 交给一个局部解析
      void save; void saveS
      return simpleParse(t)
    }
    const simpleParse = (t: string): any[] => {
      const out: any[] = []
      let k = 0
      while (k < t.length) {
        if (t[k] === '\\') {
          const cm = /^\\([a-zA-Z]+)/.exec(t.slice(k))
          if (cm) {
            k += cm[0].length
            const name = cm[1]
            out.push(new M.MathRun(name === 'cdot' ? '·' : name === 'times' ? '×' : name === 'div' ? '÷' : name === 'pm' ? '±' : ' '))
            continue
          }
          k++; continue
        }
        out.push(new M.MathRun(t[k])); k++
      }
      return out.length ? out : [new M.MathRun(' ')]
    }
    nodes.push(...parseSeq(false))
    if (!nodes.length) return null
    return new M.MathOMML({ children: nodes })
  } catch { return null }
}

// ===== 行内 Markdown → docx runs =====
export function unescapeMd(s: string): string {
  return (s || '').replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
}
export function cleanText(s: string): string {
  // 去掉零宽字符与不可见控制符（Word 粘贴常带入），保留正常空白
  return (s || '').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
}

export function textRuns(s: string, size: number): any[] {
  const t = cleanText(s)
  if (!t) return []
  return t.split('\n').flatMap((ln, i) => i ? [new TextRun({ text: ln, size, break: 1 })] : [new TextRun({ text: ln, size })])
}

/** 抓图（data URL / 站内 / 外链代理），统一压成 PNG 并给出三档宽度 */
export async function fetchImage(url: string): Promise<{ data: ArrayBuffer; width: number; height: number } | null> {
  try {
    const raw = String(url).replace(/^\s+|\s+$/g, '')
    let buf: ArrayBuffer
    if (/^data:image\//i.test(raw)) {
      const dec = decodeDataImageUrl(raw)
      if (!dec) {
        try { const r = await fetch(raw); if (!r.ok) return null; buf = await r.arrayBuffer() } catch { return null }
      } else {
        buf = dec.bytes.buffer.slice(dec.bytes.byteOffset, dec.bytes.byteOffset + dec.bytes.byteLength) as ArrayBuffer
      }
    } else {
      const isExternal = /^https?:\/\//i.test(raw) || raw.startsWith('//')
      const abs = isExternal ? (raw.startsWith('//') ? 'https:' + raw : raw) : API_BASE + raw
      const token = (typeof localStorage !== 'undefined' && localStorage.getItem('zg_token')) || ''
      let r: Response | null = null
      if (isExternal) {
        try {
          r = await fetch(`${API_BASE}/api/proxy-image?url=${encodeURIComponent(abs)}`, {
            headers: token ? { Authorization: 'Bearer ' + token } : undefined,
          })
        } catch { r = null }
        const ct = (r?.headers.get('content-type') || '').toLowerCase()
        if (!r || !r.ok || !ct.startsWith('image/')) {
          try {
            const direct = await fetch(abs, { mode: 'cors' })
            if (direct.ok && (direct.headers.get('content-type') || '').toLowerCase().startsWith('image/')) r = direct
          } catch { /* 直连被 CORS 拦，保持失败 */ }
        }
        const finalCt = (r?.headers.get('content-type') || '').toLowerCase()
        if (!r || !r.ok || !finalCt.startsWith('image/')) return null
      } else {
        r = await fetch(withToken(abs, ''))
        if (!r.ok && token) r = await fetch(withToken(abs, token))
        if (!r.ok) return null
      }
      buf = await r.arrayBuffer()
    }
    const objUrl = URL.createObjectURL(new Blob([buf]))
    const img = new Image()
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img load fail')); img.src = objUrl })
    const nw = img.naturalWidth || 360, nh = img.naturalHeight || 240
    let cw: number
    if (nw > 480) cw = 480
    else if (nw < 300) cw = 300
    else cw = nw
    const ch = Math.max(30, Math.round(nh * (cw / nw)))
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

/**
 * Markdown 文本 → docx 行内 runs（保留 **加粗** / $公式$ / ![图片] / [链接]）
 *
 * 这是「网站渲染 = 导出 Word」的**唯一**行内实现 —— 导出器与预览共用。
 */
export async function inlineRuns(text: string, size: number, boldPrefix = ''): Promise<any[]> {
  const runs: any[] = []
  if (boldPrefix && text.startsWith(boldPrefix)) {
    runs.push(new TextRun({ text: boldPrefix, bold: true, size }))
    text = text.slice(boldPrefix.length)
  }
  // 【v4.9.4】GFM 表格单元格用 `<br>` 表达换行（`tableToGfm` 的既定约定），
  //   但 `<br>` 到了这里还是**字面字符串**，会被当普通文字写进 Word
  //   （实测 hist62 的单元格里出现 `&lt;br&gt;伯里克利主政时期…`）。
  //   在**唯一的行内消费点**统一还原成真实换行 —— textRuns 会把 `\n` 变成
  //   `TextRun({ break: 1 })`，即 Word 里的软换行。这样 GFM 表格与
  //   历史遗留数据都能正确换行。
  text = (text || '').replace(/<br\s*\/?>/gi, '\n')
  const tokens = scanInlineMd(text)
  let last = 0
  for (const tk of tokens) {
    if (tk.start > last) runs.push(...textRuns(cleanText(text.slice(last, tk.start)), size))

    if (tk.kind === 'math') {
      const tex = (tk.tex || '').trim()
      let omml: any = null
      try { omml = latexToOmml(tex) } catch { omml = null }
      if (omml) runs.push(omml)
      else {
        const img = await katexToImage(tex)
        if (img) runs.push(new ImageRun({ data: img.data, type: 'png', transformation: { width: img.w, height: img.h } }))
        else runs.push(new TextRun({ text: ` ${tex} `, size, italics: true }))
      }
    } else if (tk.kind === 'image') {
      const url = (tk.url || '').trim()
      if (url) {
        if (isLocalDiskImageUrl(url)) {
          runs.push(new TextRun({ text: ' [图片：本地路径，请重新插入] ', size }))
        } else {
          const img = await fetchImage(url)
          if (img) {
            const requested = tk.width && tk.height ? tk.width : 0
            const scale = requested ? requested / img.width : 1
            runs.push(new ImageRun({
              data: img.data, type: 'png',
              transformation: { width: requested || img.width, height: Math.max(20, Math.round(img.height * scale)) },
            }))
          } else runs.push(new TextRun({ text: ' [图片] ', size }))
        }
      }
    } else if (tk.kind === 'bold') {
      runs.push(new TextRun({ text: unescapeMd(tk.text || ''), size, bold: true }))
    } else if (tk.kind === 'link') {
      runs.push(new TextRun({ text: unescapeMd(tk.label || tk.href || ''), size, color: '0563C1', underline: {} }))
    }
    last = tk.end
  }
  if (last < text.length) runs.push(...textRuns(cleanText(text.slice(last)), size))
  return runs.length ? runs : [new TextRun({ text: cleanText(text), size })]
}

// ===== HTML 合并表格 → Word 真表格（保留 rowspan / colspan）=====
/**
 * 【v4.9.4】单元格内容 → docx 段落。
 *
 * ⚠️ 关键：若单元格里**又套了一张表**，必须先把它摘出来单独生成 Word 子表格，
 *    再和其余文本段落一起塞进外层单元格 —— Word **支持**单元格内嵌表格。
 *
 *    早期版本直接 `htmlToMarkdown(td.innerHTML)`，会把内层表的 `tr/td` 全部
 *    拍平成一行文字（实测 hist62 的单元格里出现 `\| --- \| --- \|` 字面量）。
 */
async function htmlCellToChildren(td: HTMLTableCellElement, size: number): Promise<any[]> {
  // 摘出单元格内的嵌套表（可能多个），换成占位符
  const hasNested = td.querySelector('table') !== null
  const slots: { token: string; el: HTMLTableElement }[] = []
  if (hasNested) {
    const holder = document.createElement('div')
    holder.innerHTML = td.innerHTML
    const innerTables = Array.from(holder.querySelectorAll('table')) as HTMLTableElement[]
    innerTables.forEach(el => {
      const token = `\u0000ZGNEST${slots.length}\u0000`
      slots.push({ token, el })
      el.replaceWith(document.createTextNode(token))
    })
    td = holder as unknown as HTMLTableCellElement
  }

  const md = (() => {
    try { return htmlToMarkdown(td.innerHTML) } catch { return td.textContent || '' }
  })()

  // 按行拆开，把占位符所在行还原成子表格
  const lines = md.split('\n')
  const out: any[] = []
  const hasSlot = /\u0000ZGNEST\d+\u0000/
  if (!slots.length) {
    return await mdToParagraphs(md, size, { spacingAfter: 20 })
  }
  for (const line of lines) {
    if (hasSlot.test(line)) {
      const re = /\u0000ZGNEST(\d+)\u0000/g
      let m: RegExpExecArray | null
      while ((m = re.exec(line))) {
        const hit = slots[Number(m[1])]
        if (!hit) continue
        const sub = await buildWordTableFromHtml(hit.el, size)
        if (sub) out.push(sub)
      }
      const rest = line.replace(re, '').trim()
      if (rest) out.push(...await mdToParagraphs(rest, size, { spacingAfter: 20 }))
    } else {
      out.push(...await mdToParagraphs(line || ' ', size, { spacingAfter: 20 }))
    }
  }
  return out.length ? out : [new Paragraph({ children: [] })]
}

/**
 * 把保真存储的 HTML 表格片段还原成 Word 表格，**保留 rowspan / colspan**。
 *
 * 【rowspan → vMerge 的 Word 规则】
 *   docx 里纵向合并是「起始格 vMerge:'restart' + 后续被合并格 vMerge:'continue'」。
 *   因此要维护一个**跨行的待补队列**：遇到 rowspan:n 的单元格，就把它后面 n-1 行
 *   的同一列位置标记为需要继续合并。colspan 则直接映射为 gridSpan（同一行内合并）。
 */
export async function buildWordTableFromHtml(tableEl: HTMLTableElement, size: number): Promise<Table | null> {
  // 【v4.9.4】只取**本层**的行 —— `querySelectorAll('tr')` 会把嵌套子表的行也捞进来，
  //   导致外层行数翻倍、列错位。用 closest('table') === tableEl 精确限定本层。
  const trs = Array.from(tableEl.querySelectorAll('tr')).filter(tr => tr.closest('table') === tableEl)
  if (!trs.length) return null

  const rows: TableRow[] = []
  /** vMergeQueue[col] = 还剩几行需要补 vMerge:continue */
  const vMergeQueue: Record<number, number> = {}

  for (const tr of trs) {
    // 同样只取本层单元格
    const tds = Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName)) as HTMLTableCellElement[]
    const cells: TableCell[] = []
    let col = 0
    for (const td of tds) {
      // 跳过已被上方 rowspan 占用的列
      while (vMergeQueue[col] > 0) {
        cells.push(wordCell([new Paragraph({ children: [] })], { vMerge: 'continue' }))
        vMergeQueue[col]--
        if (vMergeQueue[col] <= 0) delete vMergeQueue[col]
        col++
      }
      const colspan = Math.max(1, Number(td.getAttribute('colspan') || 1))
      const rowspan = Math.max(1, Number(td.getAttribute('rowspan') || 1))
      const children = await htmlCellToChildren(td, size)
      if (rowspan > 1) {
        cells.push(wordCell(children, { columnSpan: colspan > 1 ? colspan : undefined, vMerge: 'restart' }))
        for (let c = 0; c < colspan; c++) vMergeQueue[col + c] = rowspan - 1
      } else {
        cells.push(wordCell(children, { columnSpan: colspan > 1 ? colspan : undefined }))
      }
      col += colspan
    }
    // 行尾若还有未消费的待补列（上一行 rowspan 跨到本行末尾之外），补空 continue 格
    while (vMergeQueue[col] > 0) {
      cells.push(wordCell([new Paragraph({ children: [] })], { vMerge: 'continue' }))
      vMergeQueue[col]--
      if (vMergeQueue[col] <= 0) delete vMergeQueue[col]
      col++
    }
    rows.push(new TableRow({ children: cells }))
  }
  if (!rows.length) return null
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })
}

// ===== Markdown → docx 段落 =====
/**
 * Markdown 文本 → docx 段落数组。
 *
 * 支持：#/##/### 标题、-/* 无序列表、1. 有序列表、> 引用、GFM 表格、
 * 含合并单元格的 HTML 表格（还原成 Word 真表格）、普通段落；
 * 行内保留 **加粗** / $公式$ / ![图片] / [链接]。
 */
export async function mdToParagraphs(
  md: string,
  size: number,
  opts: { indent?: number; spacingAfter?: number } = {},
): Promise<any[]> {
  let src = md || ''
  const htmlTables: { token: string; el: HTMLTableElement }[] = []

  // ⚠️ 【v4.9.1 修「表格丢失」】摘表格必须放在 htmlToMarkdown() **之后**。
  //   原顺序是先摘成 `\u0000ZGTBL0\u0000` 再转换，结果占位符被包进 `<p>ZGTBL0</p>`：
  //   ① `looksLikeHtml()` 命中这个 `<p>` → 整段又被 htmlToMarkdown() 重转一次；
  //   ② 转换器的 `tidy()` / `escapeXml` 会把 `\u0000` 控制字符清洗掉，
  //      占位符退化成纯文本 `ZGTBL0` 写进 Word —— **用户看到表格变成一行乱码**。
  //   实测证据：document.xml 里出现 `<w:t>ZGTBL0</w:t>` 且无 `<w:tbl>`。
  //   现在改为：先用 htmlToMarkdown 把 HTML 收敛成 Markdown（此时 `<table>` 会被
  //   tableToHtml 原样保留为 HTML 片段），再从**转换结果**里摘表格，占位符就安全了。
  if (looksLikeHtml(src)) {
    try { src = htmlToMarkdown(src) } catch { /* 转换失败则按原文继续，至少不抛错 */ }
  }
  if (/<table\b/i.test(src) && typeof document !== 'undefined') {
    try {
      const holder = document.createElement('div')
      holder.innerHTML = src
      const tables = Array.from(holder.querySelectorAll('table')) as HTMLTableElement[]
      tables.forEach(el => {
        // 【v4.9.4】含合并单元格**或嵌套表格** → 走 HTML 保真通道。
        //   嵌套表在 GFM 里无法表达（单元格内的 | 会被当外层列分隔符），
        //   必须整体降级为 HTML，再由 buildWordTableFromHtml 还原成 Word 真表格。
        if (!needsHtmlFidelity(el)) return   // 无合并无嵌套的交给 GFM 那条路，保持一致
        const token = `\u0000ZGTBL${htmlTables.length}\u0000`
        htmlTables.push({ token, el })
        el.replaceWith(document.createTextNode(token))
      })
      if (htmlTables.length) src = holder.innerHTML
    } catch { /* DOM 不可用 / 解析失败 → 退回原逻辑 */ }
  }
  const lines = src.split('\n')
  const out: any[] = []
  const baseIndent = opts.indent || 0
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // 还原被摘出的 HTML 合并表格
    if (htmlTables.length && /\u0000ZGTBL\d+\u0000/.test(line)) {
      const re = /\u0000ZGTBL(\d+)\u0000/g
      let m: RegExpExecArray | null
      let rest = line
      const chunks: any[] = []
      while ((m = re.exec(line))) {
        const hit = htmlTables[Number(m[1])]
        if (hit) {
          const t = await buildWordTableFromHtml(hit.el, size)
          if (t) chunks.push(t)
        }
      }
      if (chunks.length) { out.push(...chunks.filter(Boolean)); i++; continue }
      rest = rest.replace(re, '').trim()
      if (!rest) { i++; continue }
    }
    // GFM 表格：连续的 | 开头行 → 还原为 Word 真表格
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tbl: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tbl.push(lines[i]); i++ }
      if (tbl.length >= 2 && /^\s*\|[\s:|-]+\|\s*$/.test(tbl[1])) {
        const parseRow = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim().replace(/\\\|/g, '|'))
        const header = parseRow(tbl[0])
        const bodyRows = tbl.slice(2).map(parseRow)
        out.push(await buildWordTable(header, bodyRows, size))
        continue
      }
      for (const t of tbl) out.push(new Paragraph({ children: await inlineRuns(t, size), spacing: { after: opts.spacingAfter ?? 30 } }))
      continue
    }
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

/** GFM 表格 → Word 表格（无合并） */
export async function buildWordTable(header: string[], body: string[][], size: number): Promise<Table> {
  const mkRow = async (cells: string[], isHead: boolean) => new TableRow({
    tableHeader: isHead,
    children: await Promise.all(cells.map(async c => cell([
      new Paragraph({ children: await inlineRuns(c, size) }),
    ]))),
  })
  const rows: TableRow[] = [await mkRow(header, true)]
  for (const r of body) rows.push(await mkRow(r, false))
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows })
}

// ===== 【v4.10.0】专业排版原语（对标组卷网）=====
//
// 本段新增的全部是**独立原语**，不改动上面任何既有导出函数的签名与行为，
// 因此「原卷分栏编辑」预览（buildPaperDocx）不受影响，零回归。

/** 页脚文案配置 */
export interface FooterOptions {
  /** 是否显示「第 X 页 共 Y 页」；默认 true */
  showPageNumber?: boolean
  /** 页脚左侧附加文字（如校名、卷标题），可空 */
  leftText?: string
  /** 页脚字号（half-points），默认 18 = 9pt */
  size?: number
}

/**
 * 生成「第 X 页 共 Y 页」页脚。
 *
 * 【为什么需要】正式试卷必须标明页码，否则散页后无法排序。docx 通过
 * `PageNumber.CURRENT` / `TOTAL_PAGES` 写 Word **域（Field）**，由 Word 自动计算，
 * 不是硬编码数字 —— 增删内容后页码自动更新。
 */
export function buildFooter(opts: FooterOptions = {}): Footer {
  const size = opts.size ?? 18
  const kids: any[] = []
  if (opts.leftText) kids.push(new TextRun({ text: opts.leftText, size, color: '808080' }))
  if (opts.showPageNumber !== false) {
    kids.push(new TextRun({ text: '第 ', size, color: '808080' }))
    kids.push(new TextRun({ children: [PageNumber.CURRENT], size, color: '808080' }))
    kids.push(new TextRun({ text: ' 页  共 ', size, color: '808080' }))
    kids.push(new TextRun({ children: [PageNumber.TOTAL_PAGES], size, color: '808080' }))
    kids.push(new TextRun({ text: ' 页', size, color: '808080' }))
  }
  return new Footer({
    children: [new Paragraph({ children: kids, alignment: AlignmentType.CENTER, spacing: { before: 0, after: 0 } })],
  })
}

/** 试卷卷面参数（决定观感档位） */
export interface PaperStyle {
  /** 正文字号（half-points） */
  bodySize: number
  /** 行距倍数（240 = 单倍） */
  line: number
  /** 框线粗细（eighths of a point） */
  borderSize: number
  /** 框线颜色（十六进制，不带 #） */
  borderColor: string
  /** 是否显示密封线装订区 */
  seal: boolean
  /** 是否显示考生须知框 */
  notice: boolean
  /** 页脚是否显示 */
  footer: boolean
}

/** 【v4.10.1】中文习惯字号表（号数 ↔ 磅值）。号数越大 → 字越小 */
export const CN_FONT_SIZES: { name: string; pt: number }[] = [
  { name: '初号', pt: 42 }, { name: '小初', pt: 36 },
  { name: '一号', pt: 26 }, { name: '小一', pt: 24 },
  { name: '二号', pt: 22 }, { name: '小二', pt: 18 },
  { name: '三号', pt: 16 }, { name: '小三', pt: 15 },
  { name: '四号', pt: 14 }, { name: '小四', pt: 12 },
  { name: '五号', pt: 10.5 }, { name: '小五', pt: 9 },
  { name: '六号', pt: 7.5 }, { name: '小六', pt: 6.5 },
  { name: '七号', pt: 5.5 }, { name: '八号', pt: 5 },
]

/**
 * 磅值 → 最接近的中文号数名（用于下拉回显与文案）。
 * 不在标准号数表内（含非整数差）时返回 `null`，表示「自定义字号」。
 */
export function ptToCnFontSize(pt: number): string | null {
  const hit = CN_FONT_SIZES.find(s => Math.abs(s.pt - pt) < 0.01)
  return hit ? hit.name : null
}

/** 中文号数名 → 磅值；未知号数返回 `null` */
export function cnFontSizeToPt(name: string): number | null {
  const hit = CN_FONT_SIZES.find(s => s.name === name)
  return hit ? hit.pt : null
}

/** 三套模板的**实体化**差异（此前三套模板只有「是否显示注意事项」一个分支） */
export const PAPER_STYLES: Record<string, PaperStyle> = {
  // 正式考试卷：小四（12pt）、宽行距、深框线、有密封线与须知、有页脚
  formal: { bodySize: 24, line: 360, borderSize: 8, borderColor: '595959', seal: true, notice: true, footer: true },
  // 日常测验卷：小四（12pt）、中等行距、常规框线、有密封线有须知
  test: { bodySize: 24, line: 312, borderSize: 6, borderColor: '808080', seal: true, notice: true, footer: true },
  // 课后作业卷：五号（10.5pt）、紧凑、浅框线、无密封线、无须知、无页脚（作业卷常为单页）
  homework: { bodySize: 21, line: 276, borderSize: 4, borderColor: 'BFBFBF', seal: false, notice: false, footer: false },
}

/** 取模板样式，未知模板回退 formal */
export function paperStyle(template: string): PaperStyle {
  return PAPER_STYLES[template] || PAPER_STYLES.formal
}

/**
 * 「密封线」装订区。
 *
 * 【形态对标组卷网】正式试卷左侧有一列竖排密封区：姓名/班级/考号填写栏 + 骑缝装订线，
 * 阅卷时沿虚线裁开以隐藏考生信息（防止串分）。
 *
 * 【实现取舍】Word 里真正的「竖排文字」需要 `textDirection: btLr`，但该属性在部分
 * WPS / 旧版 Word 上渲染不稳定。这里用**单行表格 + 加粗短横线**模拟密封区，
 * 兼容性优先，视觉上与组卷网导出件接近。
 */
export function buildSealBlock(style: PaperStyle, size: number): Table {
  const mk = (label: string) => new Paragraph({
    children: [new TextRun({ text: `${label}：_____________`, size, bold: true })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 20, after: 20 },
  })
  const lineRow = (text: string) => new TableRow({
    children: [new TableCell({
      borders: {
        top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
        left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      },
      children: [new Paragraph({
        children: [new TextRun({ text, size: size - 2, color: '999999' })],
        alignment: AlignmentType.CENTER,
      })],
    })],
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      lineRow('┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ 密 封 线 内 不 得 答 题 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄'),
      new TableRow({
        children: [
          wordCell([mk('姓名')], {}),
          wordCell([mk('班级')], {}),
          wordCell([mk('考号')], {}),
        ],
      }),
      lineRow('┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄'),
    ],
  })
}

/**
 * 考生信息区（表格式，对标组卷网卷头）。
 *
 * 形如：
 * ```
 * ┌────────┬────────┬────────┬────────┐
 * │ 学校：  │ 年级：  │ 姓名：  │ 考号：  │
 * └────────┴────────┴────────┴────────┘
 * ```
 */
export function buildExamInfoTable(fields: { label: string; value: string }[], style: PaperStyle, size: number): Table {
  const border = {
    top: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    bottom: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    left: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    right: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
  }
  const cellOf = (f: { label: string; value: string }) => new TableCell({
    borders: border,
    width: { size: Math.floor(100 / Math.max(1, fields.length)), type: WidthType.PERCENTAGE },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      children: [new TextRun({ text: `${f.label}：`, size, bold: true }), new TextRun({ text: f.value || '　', size })],
    })],
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: fields.map(cellOf) })],
  })
}

/**
 * 考生须知框（带边框的单格表格，对标组卷网「注意事项」区）。
 */
export function buildNoticeBox(lines: string[], style: PaperStyle, size: number): Table {
  const border = {
    top: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    bottom: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    left: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
    right: { style: BorderStyle.SINGLE, size: style.borderSize, color: style.borderColor },
  }
  const kids: any[] = [new Paragraph({
    children: [new TextRun({ text: '注意事项', size, bold: true })],
    spacing: { after: 40 },
  })]
  lines.forEach((t, i) => kids.push(new Paragraph({
    children: [new TextRun({ text: `${i + 1}. ${t}`, size: size - 1 })],
    spacing: { after: 20 },
  })))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({
      children: [new TableCell({
        borders: border,
        margins: { top: 80, bottom: 80, left: 140, right: 140 },
        children: kids,
      })],
    })],
  })
}

// ===== 选项自动横排（v4.10.0 核心算法）=====
export type OptionLayout = 'auto' | 'inline' | 'block'

/** 计算一个选项的「视觉宽度」（中文 1.0 / ASCII 0.5 加权；公式与图片额外计入） */
export function optionVisualWidth(opt: string): number {
  const raw = String(opt || '')
  // 图片 / 本地路径 → 直接判为必须独占一行
  if (/!\[[^\]]*\]\(/.test(raw)) return Number.POSITIVE_INFINITY
  // 明确换行 → 独占
  if (/[\n\r]/.test(raw)) return Number.POSITIVE_INFINITY
  // 去掉 Markdown 标记后计宽
  const plain = unescapeMd(raw)
    .replace(/\$[^$]+\$/g, '\u0000'.repeat(8))  // 公式按 8 个全角宽占位
    .replace(/[#*_>`~]/g, '')
    .replace(/==([^=]+)==/g, '$1')
  let w = 0
  for (const ch of plain) {
    if (ch === '\u0000') { w += 1; continue }            // 公式占位
    w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.5
  }
  // 「A. 」前缀约占 2 个半角宽
  return w + 2
}

/**
 * 决定选项如何排版，并返回可直接 push 进文档的段落数组。
 *
 * 【用户诉求】「按照美观的标准自动排列」——即不需要用户逐题判断，
 * 由算法根据选项实际长度决定：短选项横排（省版面、贴近组卷网默认），
 * 长选项或含公式/图片的选项退回逐行（避免挤成一团）。
 *
 * 【判定思路】一行约可容纳 `LINE_CAPACITY` 个全角宽（按字号缩放）。
 * 选项数 2~4 且总宽不超过一行的 92%、单项不超过一行的 46% 时横排；
 * 其余情况逐行。这样「A.甲乙  B.丙丁」会横排，而「A. 一段很长的分析文字…」会逐行。
 *
 * @param options 选项文本数组（不含 A./B. 前缀）
 * @param size    docx 字号（half-points）
 * @param mode    auto（默认算法）/ inline（强制横排）/ block（强制逐行）
 * @param qtype   题型 key（可选）。**只有真正传 `judge` 时才启用「（  ）正确/错误」特例**。
 *                ⚠️ 曾用 `options.length === 2` 判定判断题 —— 但那会把「恰好两个选项的
 *                单选/多选题」误判成判断题，**把用户真正的选项文本整个丢掉**、替换成
 *                「（  ）正确　（  ）错误」（本次探针实测抓到）。必须由调用方显式告知题型。
 */
export async function layoutOptions(
  options: string[],
  size: number,
  mode: OptionLayout = 'auto',
  qtype?: string,
): Promise<any[]> {
  const list = (options || []).filter(o => o !== undefined && o !== null)
  if (!list.length) return []

  // 仅「判断题」走特殊排版；不能只看选项个数
  const isJudge = qtype === 'judge'
  const width = list.map(optionVisualWidth)
  const hasUnbreakable = width.some(w => !Number.isFinite(w))

  // 一行容量：以 10.5pt（size=21）能放约 40 个全角字符为基准，随字号线性缩放
  const capacity = 40 * (21 / Math.max(12, size))
  const total = width.reduce((a, b) => a + b, 0)
  const maxW = width.length ? Math.max(...width.filter(Number.isFinite)) : 0

  const canInline = !hasUnbreakable
    && list.length >= 2 && list.length <= 4
    && total <= capacity * 0.92
    && maxW <= capacity * 0.46

  const useInline = mode === 'inline' ? !hasUnbreakable : mode === 'block' ? false : canInline

  if (useInline) {
    // 横排：单段落 + 制表位分隔。用 \t 让各选项起点对齐（Word 制表位比空格稳定）。
    const kids: any[] = []
    for (let i = 0; i < list.length; i++) {
      if (i) kids.push(new TextRun({ text: '\t', size }))
      kids.push(new TextRun({ text: `${optLetter(i)}. `, size, bold: true }))
      kids.push(...await inlineRuns(list[i], size))
    }
    // 每栏等宽制表位（占满版心），保证选项起始位置整齐
    const col = Math.floor(9020 / list.length)   // 9020 twips ≈ A4 版心宽
    const stops = Array.from({ length: list.length - 1 }, (_, i) => ({
      type: TabStopType.LEFT as any,
      position: col * (i + 1),
    }))
    return [new Paragraph({
      children: kids,
      indent: { left: 360 },
      spacing: { after: 20 },
      ...(stops.length ? { tabStops: stops } : {}),
    })]
  }

  // 【判断题特例】两项且**用户未强制指定排版**时，并排成「（  ）正确　（  ）错误」，
  // 比竖排两个选项更符合试卷惯例。
  // ⚠️ 必须限定 `mode === 'auto'`：否则用户显式选「逐行」时会被这里吞掉
  //   （实测 `mode='block'` + 两个长选项 → 只产出 1 段，用户的选择失效）。
  if (mode === 'auto' && isJudge && !hasUnbreakable) {
    return [new Paragraph({
      children: [new TextRun({ text: '（  ）正确　　（  ）错误', size })],
      indent: { left: 360 }, spacing: { after: 20 },
    })]
  }

  const out: any[] = []
  for (let i = 0; i < list.length; i++) {
    out.push(new Paragraph({
      children: [
        new TextRun({ text: `${optLetter(i)}. `, size, bold: true }),
        ...await inlineRuns(list[i], size),
      ],
      indent: { left: 360 }, spacing: { after: 14 },
    }))
  }
  return out
}

// ===== 试卷构建：把「若干道题」拼成一份真正的 .docx =====
export interface PaperQuestion {
  qtype: string
  content: string
  options?: string[]
  answer?: string
  analysis?: string
  score?: number
}

export interface PaperOptions {
  /** 卷标题；不传则不生成标题 */
  title?: string
  /** 页眉信息行（学校/班级/姓名 等），可空 */
  metaLine?: string
  fontSize?: number      // half-points（docx 单位），默认 21 = 10.5pt
  withAnswers?: boolean  // 是否含答案/解析
  showTypeHeading?: boolean  // 是否按题型分组加小标题
  /** 中文题型名映射（默认内置） */
  qtypeLabels?: Record<string, string>
}

const DEFAULT_QTYPE: Record<string, string> = {
  single: '单项选择题', multiple: '多项选择题', judge: '判断题', fill: '填空题', subjective: '主观题',
}

/** 题目序号 → A/B/C… */
export const optLetter = (i: number) => 'ABCDEFGH'[i] || '?'

/**
 * 把一批题目构建成 .docx 二进制。
 *
 * ⚠️ 这是**唯一**的「内容 → Word」实现。题库导出、原卷分栏编辑预览都走这里，
 *    所以「预览里看到的」和「导出下载的」必然一致。
 */
export async function buildPaperDocx(questions: PaperQuestion[], opts: PaperOptions = {}): Promise<Blob> {
  const size = opts.fontSize ?? 21
  const labels = { ...DEFAULT_QTYPE, ...(opts.qtypeLabels || {}) }
  const children: any[] = []

  if (opts.title) {
    children.push(new Paragraph({
      children: [new TextRun({ text: opts.title, bold: true, size: size + 8 })],
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 80 },
    }))
  }
  if (opts.metaLine) {
    children.push(new Paragraph({ children: [new TextRun({ text: opts.metaLine, size })] , spacing: { after: 120 } }))
  }

  const showTypeHeading = opts.showTypeHeading !== false && !!opts.title
  if (showTypeHeading) {
    // 按题型分组（保持传入顺序内的题型首次出现序）
    const order: string[] = []
    for (const q of questions) if (!order.includes(q.qtype)) order.push(q.qtype)
    let idx = 0
    for (const key of order) {
      const list = questions.filter(q => q.qtype === key)
      children.push(new Paragraph({
        children: [new TextRun({ text: `${labels[key] || key}（每题 ${Number(list[0]?.score) || 5} 分，共 ${list.length} 题）`, bold: true, size: size + 1 })],
        spacing: { before: 160, after: 80 },
      }))
      for (const it of list) {
        idx++
        children.push(...await questionParagraphs(it, idx, size, opts.withAnswers !== false, labels))
      }
    }
  } else {
    for (let i = 0; i < questions.length; i++) {
      children.push(...await questionParagraphs(questions[i], i + 1, size, opts.withAnswers !== false, labels))
    }
  }

  const doc = new Document({ sections: [{ properties: {}, children }] })
  return await Packer.toBlob(doc)
}

async function questionParagraphs(
  it: PaperQuestion, idx: number, size: number, withAnswers: boolean, labels: Record<string, string>,
): Promise<any[]> {
  const out: any[] = []
  const score = Number(it.score) || 5
  // 题目原文若已自带题号（如「1. 下列说法正确的是…」），则题号行不再重复输出数字，
  // 避免出现「1.（单项选择题）(5分)1. 下列说法正确的是（ ）」这种双题号。
  const contentHasNumber = /^\s*\d+\s*[.、)）．]/.test(String(it.content || '').replace(/<[^>]*>/g, '').trim())
  const headPrefix = contentHasNumber ? `（${labels[it.qtype] || '主观题'}，${score}分）` : `${idx}.（${labels[it.qtype] || '主观题'}，${score}分）`
  out.push(new Paragraph({
    children: [new TextRun({ text: headPrefix, bold: true, size })],
    spacing: { before: 80, after: 20 },
  }))
  out.push(...await mdToParagraphs(it.content || '', size, { indent: 360, spacingAfter: 30 }))
  const options = it.options || []
  for (let k = 0; k < options.length; k++) {
    out.push(new Paragraph({
      children: await inlineRuns(`${optLetter(k)}. ${options[k]}`, size),
      indent: { left: 360 }, spacing: { after: 14 },
    }))
  }
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
  return out
}
