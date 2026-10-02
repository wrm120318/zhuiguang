// ===== Markdown 富内容行内解析（v4.9.0）=====
//
// 【为什么需要这个文件】
// 「我必须要传进去是什么、渲染的是什么，最后导出 Word 就是什么」—— 用户对全链路
// 格式保真的核心诉求。要满足它，前提是**同一种语法在所有端只被解释一次、且解释一致**。
//
// 现状是：入库（html-to-md）→ 渲染（marked + 扩展）→ 导出（docx）三处各自实现，
// 于是同一个 `![图片](data:image/png;base64,AAAA…)` 在三处的行为不同：
//   · 渲染端：能正常显示（浏览器原生支持 data: URL）
//   · 导出端：正则 `\!\[[^\]]*\]\([^)]*\)` 里的 `[^)]*` 会被 **base64 数据中的 `)` 字符**截断
//     → 图片语法只匹配到一半 → 剩下的几十 KB base64 落进普通文本 → Word 里呈现"乱码"
//
// 【本文件提供什么】
// 一套**正确、边界安全**的行内 Markdown 扫描器，以及 data: URL 的解码工具。
// 导出端与内容洗涤端共用它，从根上消除"各写一套正则、各踩一个坑"的问题。

/** 行内 Markdown token 类型 */
export type MdInlineKind = 'math' | 'image' | 'bold' | 'link'

export interface MdInlineToken {
  kind: MdInlineKind
  /** 原始匹配文本（含语法符号） */
  raw: string
  /** 起始下标 */
  start: number
  /** 结束下标（不含） */
  end: number
  /** 图片：URL 部分 */
  url?: string
  /** 图片：alt 文本 */
  alt?: string
  /** 图片：显式尺寸（平台扩展语法 `![alt](url =WxH)`） */
  width?: number
  height?: number
  /** 公式：LaTeX 源码 */
  tex?: string
  /** 加粗：内部文本 */
  text?: string
  /** 链接：目标与文案 */
  href?: string
  label?: string
}

/**
 * 扫描一段文本里的行内 Markdown 语法。
 *
 * 与旧实现（`DocxExportPanel.vue` 的 `INLINE_RE`）的区别：
 *   · 图片 URL 用**括号配平**扫描（`matchBalancedParen`），而不是 `[^)]*`
 *     → `data:image/png;base64,iVBORw0KGgo…(…)…` 里的 `)` 不再截断匹配
 *   · 图片/公式/加粗三者按**出现位置**排序，谁在前谁先切，避免嵌套导致的错乱
 *   · 返回结构化 token，调用方不需要再写第二套正则去"二次解析"
 *
 * ⚠️ 有意**不**在这里处理转义（`\_` 等）—— 那是渲染层的职责，
 *    扫描器只负责"切分"，保持单一职责。
 */
export function scanInlineMd(src: string): MdInlineToken[] {
  const tokens: MdInlineToken[] = []
  const s = src || ''
  let i = 0

  while (i < s.length) {
    const ch = s[i]

    // ── 公式：`$$…$$`（块）或 `$…$`（行内）──
    if (ch === '$') {
      const isBlock = s[i + 1] === '$'
      const openLen = isBlock ? 2 : 1
      const close = isBlock ? '$$' : '$'
      const closeIdx = s.indexOf(close, i + openLen)
      // 行内公式不允许跨行（避免把两个独立的 $ 误配成一对）
      if (closeIdx > -1 && (isBlock || s.slice(i + openLen, closeIdx).indexOf('\n') === -1)) {
        const end = closeIdx + close.length
        tokens.push({
          kind: 'math',
          raw: s.slice(i, end),
          start: i,
          end,
          tex: s.slice(i + openLen, closeIdx).trim(),
        })
        i = end
        continue
      }
      i++
      continue
    }

    // ── 图片：`![alt](url)` 或 `![alt](url =WxH)` ──
    if (ch === '!' && s[i + 1] === '[') {
      const altEnd = s.indexOf(']', i + 2)
      if (altEnd > -1 && s[altEnd + 1] === '(') {
        const urlStart = altEnd + 2
        const urlEnd = matchBalancedParen(s, altEnd + 1)
        if (urlEnd > -1) {
          const inner = s.slice(urlStart, urlEnd)
          // 尺寸扩展语法：`url =WxH`（末尾的空格 + = 数字 x 数字）
          const sized = /^([\s\S]*?)\s*=\s*(\d+)\s*[x×]\s*(\d+)\s*$/.exec(inner)
          const url = (sized ? sized[1] : inner).trim()
          const end = urlEnd + 1
          tokens.push({
            kind: 'image',
            raw: s.slice(i, end),
            start: i,
            end,
            alt: s.slice(i + 2, altEnd),
            url,
            width: sized ? Number(sized[2]) : undefined,
            height: sized ? Number(sized[3]) : undefined,
          })
          i = end
          continue
        }
      }
      i++
      continue
    }

    // ── 加粗：`**…**`（内部不允许再出现 `*`，与原行为保持一致）──
    if (ch === '*' && s[i + 1] === '*') {
      const closeIdx = s.indexOf('**', i + 2)
      if (closeIdx > -1 && closeIdx > i + 2) {
        const end = closeIdx + 2
        tokens.push({
          kind: 'bold',
          raw: s.slice(i, end),
          start: i,
          end,
          text: s.slice(i + 2, closeIdx),
        })
        i = end
        continue
      }
      i++
      continue
    }

    // ── 链接：`[文案](href)` ──
    if (ch === '[') {
      const labelEnd = s.indexOf(']', i + 1)
      if (labelEnd > -1 && s[labelEnd + 1] === '(') {
        const hrefEnd = matchBalancedParen(s, labelEnd + 1)
        if (hrefEnd > -1) {
          const end = hrefEnd + 1
          tokens.push({
            kind: 'link',
            raw: s.slice(i, end),
            start: i,
            end,
            label: s.slice(i + 1, labelEnd),
            href: s.slice(labelEnd + 2, hrefEnd).trim(),
          })
          i = end
          continue
        }
      }
      i++
      continue
    }

    i++
  }

  return tokens
}

/**
 * 从 `openIdx`（指向 `(` ）开始找配对的 `)`，返回其下标；找不到返回 -1。
 *
 * 【为什么不能用 `[^)]*`】—— 本轮「导出 Word 全是乱码」的**直接根因**之一。
 * base64 字母表包含 `+` `/` `=`，data URL 的 MIME 段还可能带 `(...)`（如 `image/svg+xml`），
 * 更关键的是**自由文本类 data URL**（`data:image/svg+xml;utf8,<svg ... ( ... ) ...>`）
 * 本身就会含 `)`。用 `[^)]*` 会在第一个 `)` 处提前闭合，导致：
 *   · 匹配到的"URL"只是一小段 → fetch 必然失败
 *   · 剩下的整串 base64/svg 落进普通文本 → 写进 Word 就是用户看到的"乱码"
 *
 * 这里做括号深度配平：遇到 `(` 深度 +1，`)` 深度 -1，归零即为闭合。
 */
export function matchBalancedParen(s: string, openIdx: number): number {
  if (s[openIdx] !== '(') return -1
  let depth = 0
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** data: URL 解码结果 */
export interface DataUrlPayload {
  /** MIME 类型，如 `image/png` */
  mime: string
  /** 图片字节 */
  bytes: Uint8Array
  /** 原始 data URL */
  raw: string
}

/** data URL 的宽松识别（大小写不敏感、允许 base64 前后有空白） */
export const DATA_IMAGE_RE = /^\s*data:image\/[a-zA-Z0-9.+-]+/i

/** 判断是否为 data: 图片 URL */
export function isDataImageUrl(u: string): boolean {
  return DATA_IMAGE_RE.test(u || '')
}

/**
 * 严格解析 data: 图片 URL。
 *
 * ⚠️ **必须用 `indexOf(',')` 定位数据起始，不能用 `split(',')`。**
 * base64 数据本身可能包含 `,`（罕见但合法），`split` 会在错误位置切断 → 半个文件 → 乱码。
 *
 * 支持两种编码：
 *   · `data:image/png;base64,AAAA…`     → base64 解码
 *   · `data:image/svg+xml;utf8,<svg…>`  → percent-decode 后转 UTF-8 字节
 */
export function decodeDataImageUrl(url: string): DataUrlPayload | null {
  const u = (url || '').trim()
  if (!/^data:/i.test(u)) return null
  const comma = u.indexOf(',')
  if (comma < 0) return null

  const meta = u.slice(5, comma)                     // `image/png;base64`
  const body = u.slice(comma + 1)
  const mime = (meta.split(';')[0] || 'image/png').trim()
  const isB64 = /;base64/i.test(meta)

  try {
    if (isB64) {
      // 去掉 base64 里可能出现的空白（Word / 剪贴板偶发插入换行）
      const clean = body.replace(/\s+/g, '')
      const bin = atob(clean)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return { mime, bytes, raw: url }
    }
    // 非 base64：percent-decode 后按 UTF-8 编码成字节
    const text = decodeURIComponent(body)
    return { mime, bytes: new TextEncoder().encode(text), raw: url }
  } catch {
    return null
  }
}

/**
 * 把字节数格式化成人类可读字符串（错误提示用）。
 */
export function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

// ===== 内容格式体检（「传进去什么 = 导出什么」的质量闸门）=====

export interface ContentIssue {
  /** 问题类型 */
  type: 'file-path-image' | 'inline-data-image' | 'lossy-table' | 'html-leak'
  /** 严重级别：error 会破坏导出，warning 只是不够理想 */
  level: 'error' | 'warning'
  /** 面向用户的中文说明 */
  message: string
  /** 命中数量 */
  count: number
}

/** 本地磁盘绝对路径特征：`file://` 或 Windows 盘符 `C:\` / `C:/` */
const LOCAL_PATH_RE = /^(?:file:[\\/]+|[a-zA-Z]:[\\/])/

/**
 * 判断图片 URL 属于本地磁盘路径（**永远不该入库**）。
 *
 * 用户反馈「粘进去之后图片成了带着 C 盘绝对路径的」即此类 ——
 * 浏览器出于安全**无法**读取本地文件，这种 URL 在网页上是裂图、
 * 在 Word 里是一串 `C:\Users\...\image1.png` 文字，必须丢弃并明确告知用户。
 */
export function isLocalDiskImageUrl(u: string): boolean {
  return LOCAL_PATH_RE.test((u || '').trim())
}

/**
 * 扫描 Markdown 内容，报告会影响「渲染 = 导出」一致性的问题。
 *
 * 用途有二：
 *   ① 粘贴时体检 + 洗涤（见 MarkdownEditor 的粘贴流程）
 *   ② 导出前体检，把问题暴露给用户，而不是让它默默变成 Word 里的乱码
 */
export function inspectRichContent(md: string): ContentIssue[] {
  const src = md || ''
  const issues: ContentIssue[] = []

  const tokens = scanInlineMd(src)
  const images = tokens.filter(t => t.kind === 'image')

  let localCount = 0
  let dataCount = 0
  for (const img of images) {
    const u = img.url || ''
    if (!u) continue
    if (isLocalDiskImageUrl(u)) localCount++
    else if (isDataImageUrl(u)) dataCount++
  }
  if (localCount) {
    issues.push({
      type: 'file-path-image', level: 'error', count: localCount,
      message: `有 ${localCount} 张图片指向本地磁盘路径，浏览器无法读取，导出会变成文字。请重新用「粘贴」或「上传」插入这些图片。`,
    })
  }
  if (dataCount) {
    issues.push({
      type: 'inline-data-image', level: 'warning', count: dataCount,
      message: `有 ${dataCount} 张图片以 base64 内联存储，会让题目体积膨胀（单题可达数百 KB）。建议重新上传为图片文件。`,
    })
  }

  if (looksLikeRawHtml(src)) {
    issues.push({
      type: 'html-leak', level: 'warning', count: 1,
      message: '内容里残留 HTML 标签，可能导致渲染与 Word 导出效果不一致。',
    })
  }

  if (hasLossyTable(src)) {
    issues.push({
      type: 'lossy-table', level: 'warning', count: 1,
      message: '表格包含合并单元格（rowspan/colspan），导出 Word 时会丢失合并效果。',
    })
  }

  return issues
}

/** 残留 HTML 块级标签的粗判（行内 `<br>` 不算问题） */
function looksLikeRawHtml(s: string): boolean {
  return /<(table|tbody|thead|tr|td|th|div|p|h[1-6]|ul|ol|li|blockquote)\b[^>]*>/i.test(s)
}

/** 合并单元格的粗判（仅用于体检提示；渲染侧已按 HTML 直出保真） */
function hasLossyTable(s: string): boolean {
  return /<t[dh]\b[^>]*\b(rowspan|colspan)\s*=/i.test(s)
}
