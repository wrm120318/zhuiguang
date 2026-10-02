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
  WidthType, BorderStyle, VerticalMergeType, AlignmentType, HeadingLevel,
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
