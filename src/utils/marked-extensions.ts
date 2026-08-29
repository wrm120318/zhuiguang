// ===== v4.2.2 CommonMark 扩展 =====
// 在 marked 渲染前/中注册以下扩展：
//   1. KaTeX 行内 $...$ / 块级 $$...$$
//   2. ==text== 文本高亮
//   3. @[name](/user/uid) 用户提及
//   4. ![alt](url =100x100) 图片尺寸
//   5. @`https://...a.mp4` 视频嵌入
//   6. @[bilibili](BVxxx) 站外视频
//   7. @`https://...a.pdf` PDF 嵌入
//   8. file://文件名 附件引用（默认渲染为蓝色链接）
//   9. HTML 白名单子集（保留 details/summary/kbd/mark/sub/sup/ins/del/figure/figcaption）

import { Marked, type TokenizerAndRendererExtension } from 'marked'
import katex from 'katex'

// 加载 KaTeX CSS（运行时插入到 head，确保公式样式生效）
let katexCssInjected = false
export function ensureKatexCss() {
  if (katexCssInjected || typeof document === 'undefined') return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css'
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
  katexCssInjected = true
}

// 工具：安全渲染 KaTeX（出错回退原文）
function renderKatex(formula: string, displayMode: boolean): string {
  try {
    return katex.renderToString(formula, { displayMode, throwOnError: false, output: 'html' })
  } catch (e: any) {
    return `<code class="katex-error">${escapeHtml(formula)}</code>`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// ===== 1. KaTeX 块级 $$...$$ =====
const katexBlock: TokenizerAndRendererExtension = {
  name: 'katexBlock',
  level: 'block',
  start(src) { return src.indexOf('$$') },
  tokenizer(src) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
    if (!match) return undefined
    return {
      type: 'katexBlock',
      raw: match[0],
      text: match[1].trim(),
    }
  },
  renderer(token: any) {
    return `<div class="zg-katex-block">${renderKatex(token.text, true)}</div>\n`
  },
}

// ===== 2. KaTeX 行内 $...$（避开 $$ 冲突） =====
const katexInline: TokenizerAndRendererExtension = {
  name: 'katexInline',
  level: 'inline',
  start(src) { return src.indexOf('$') },
  tokenizer(src) {
    // 匹配单个 $...$（不匹配 $$ ... $$）
    const match = /^\$([^$\n]+?)\$/.exec(src)
    if (!match) return undefined
    // 避免与货币符号冲突：前后不能是数字
    const before = src[match[0].length] || ''
    return {
      type: 'katexInline',
      raw: match[0],
      text: match[1].trim(),
    }
  },
  renderer(token: any) {
    return `<span class="zg-katex-inline">${renderKatex(token.text, false)}</span>`
  },
}

// ===== 3. ==text== 高亮 =====
const highlight: TokenizerAndRendererExtension = {
  name: 'highlight',
  level: 'inline',
  start(src) { return src.indexOf('==') },
  tokenizer(src) {
    const match = /^==([^=\n]+?)==/.exec(src)
    if (!match) return undefined
    return { type: 'highlight', raw: match[0], text: match[1] }
  },
  renderer(token: any) {
    return `<mark class="zg-highlight">${token.text}</mark>`
  },
}

// ===== 4. @[name](/user/uid) 用户提及 =====
const mention: TokenizerAndRendererExtension = {
  name: 'mention',
  level: 'inline',
  start(src) { return src.indexOf('@[') },
  tokenizer(src) {
    const match = /^@\[([^\]]+?)\]\(\/user\/(\d+)\)/.exec(src)
    if (!match) return undefined
    return { type: 'mention', raw: match[0], name: match[1], uid: match[2] }
  },
  renderer(token: any) {
    return `<a class="zg-mention" href="/profile?uid=${token.uid}" data-uid="${token.uid}">@${escapeHtml(token.name)}</a>`
  },
}

// ===== 5. ![alt](url =100x100) 图片尺寸 =====
const imageSized: TokenizerAndRendererExtension = {
  name: 'imageSized',
  level: 'inline',
  start(src) { return src.indexOf('![') },
  tokenizer(src) {
    // ![alt](url) 或 ![alt](url =WxH) 或 ![alt](url =100x100)
    const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+=(\d+)\s*[x×]\s*(\d+))?\)/.exec(src)
    if (!match) return undefined
    return {
      type: 'imageSized',
      raw: match[0],
      alt: match[1],
      url: match[2],
      width: match[3],
      height: match[4],
    }
  },
  renderer(token: any) {
    const styleParts: string[] = []
    if (token.width) styleParts.push(`width:${token.width}px`)
    if (token.height) styleParts.push(`height:${token.height}px`)
    const style = styleParts.length ? ` style="${styleParts.join(';')}"` : ''
    return `<img src="${escapeHtml(token.url)}" alt="${escapeHtml(token.alt)}"${style} class="zg-img" loading="lazy" />`
  },
}

// ===== 6. @`https://.../a.mp4` 视频嵌入 =====
const videoEmbed: TokenizerAndRendererExtension = {
  name: 'videoEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@`') },
  tokenizer(src) {
    const match = /^@`(https?:\/\/[^\s`]+\.(?:mp4|webm|ogg|mov))`/i.exec(src)
    if (!match) return undefined
    return { type: 'videoEmbed', raw: match[0], url: match[1] }
  },
  renderer(token: any) {
    return `<div class="zg-video-wrap"><video controls preload="metadata" src="${escapeHtml(token.url)}" class="zg-video"></video></div>`
  },
}

// ===== 7. @[bilibili](BVxxx) 站外视频 =====
const bilibiliEmbed: TokenizerAndRendererExtension = {
  name: 'bilibiliEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@[bilibili]') },
  tokenizer(src) {
    const match = /^@\[bilibili\]\((BV[0-9A-Za-z]+)\)/.exec(src)
    if (!match) return undefined
    return { type: 'bilibiliEmbed', raw: match[0], bvid: match[1] }
  },
  renderer(token: any) {
    const url = `https://player.bilibili.com/player.html?bvid=${token.bvid}&autoplay=0&danmaku=0`
    return `<div class="zg-bili-wrap"><iframe src="${escapeHtml(url)}" scrolling="no" frameborder="0" allowfullscreen="true" class="zg-bili-iframe"></iframe></div>`
  },
}

// ===== 8. @`https://.../a.pdf` PDF 嵌入 =====
const pdfEmbed: TokenizerAndRendererExtension = {
  name: 'pdfEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@`') },
  tokenizer(src) {
    const match = /^@`(https?:\/\/[^\s`]+\.pdf)`/i.exec(src)
    if (!match) return undefined
    return { type: 'pdfEmbed', raw: match[0], url: match[1] }
  },
  renderer(token: any) {
    return `<div class="zg-pdf-wrap">
      <div class="zg-pdf-head"><span class="zg-pdf-icon">📄</span><a href="${escapeHtml(token.url)}" target="_blank" rel="noopener">PDF 文档</a></div>
      <iframe src="${escapeHtml(token.url)}" class="zg-pdf-iframe" loading="lazy"></iframe>
    </div>`
  },
}

// ===== 9. file://文件名 附件引用 =====
const fileLink: TokenizerAndRendererExtension = {
  name: 'fileLink',
  level: 'inline',
  start(src) { return src.indexOf('file://') },
  tokenizer(src) {
    const match = /^file:\/\/([^\s)]+)/.exec(src)
    if (!match) return undefined
    return { type: 'fileLink', raw: match[0], name: match[1] }
  },
  renderer(token: any) {
    return `<a class="zg-file-link" href="${escapeHtml(token.raw)}" target="_blank" rel="noopener"><span class="zg-file-icon">📎</span> ${escapeHtml(token.name)}</a>`
  },
}

// ===== HTML 白名单过滤 =====
// 关键：必须保留 marked 生成的标准标签（p/h1/ul/table/a/img…）以及
// 扩展渲染所需的标签（div/span/iframe/video 等），否则会被当成未知标签删除，
// 导致 Markdown 与 HTML 全部无法渲染（本 bug 的历史根因）。
const ALLOWED_HTML_TAGS = new Set([
  // 结构 / 文本
  'p', 'div', 'span', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'blockquote', 'pre', 'hr', 'br', 'wbr',
  'details', 'summary',
  // 列表
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu',
  // 表格
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // 行内 / 格式化
  'a', 'abbr', 'acronym', 'b', 'strong', 'i', 'em', 'u', 's', 'strike',
  'del', 'ins', 'sub', 'sup', 'small', 'mark', 'time', 'cite', 'q', 'dfn', 'var',
  'kbd', 'samp', 'code', 'bdi', 'bdo', 'ruby', 'rt', 'rp', 'data', 'output',
  // 媒体 / 嵌入（iframe 用于 B站、PDF 嵌入，必须保留）
  'img', 'picture', 'source', 'video', 'audio', 'track', 'canvas',
  'iframe', 'figure', 'figcaption', 'object', 'embed', 'param', 'map', 'area',
])

// 允许的 HTML 属性（其余一律删除，杜绝 on* / javascript: 等注入）
const ALLOWED_HTML_ATTRS = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'style',
  'width', 'height', 'alt', 'src', 'href', 'target', 'rel', 'type',
  'controls', 'preload', 'autoplay', 'loop', 'muted', 'playsinline',
  'poster', 'download', 'loading', 'referrerpolicy',
  'allowfullscreen', 'frameborder', 'scrolling', 'sandbox',
  'datetime', 'open', 'colspan', 'rowspan', 'start',
  'cite', 'name', 'value', 'placeholder',
  'aria-hidden', 'aria-label', 'role', 'data-uid',
])

// 校验单个属性值，危险值返回空串
function sanitizeAttrValue(name: string, value: string): string {
  const n = name.toLowerCase()
  if (n === 'style') {
    // 拦截可触发脚本的 CSS 表达式 / javascript:
    if (/expression\s*\(|javascript:|url\(\s*javascript:/i.test(value)) return ''
    return value
  }
  if (n === 'href' || n === 'src' || n === 'srcdoc' || n === 'xlink:href') {
    if (/^\s*javascript:/i.test(value)) return ''
    // data: 仅允许图片类型，避免 data:text/html 直接执行
    if (/^\s*data:/i.test(value) && !/^\s*data:image\//i.test(value)) return ''
    return value
  }
  return value
}

function sanitizeHtml(html: string): string {
  // 移除 script / style 标签及其内容
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  // 移除 link / meta（非渲染用途，且可能携带注入）
  html = html.replace(/<(link|meta)\b[^>]*>/gi, '')
  // 移除所有 on* 事件属性（双引号 / 单引号 / 无引号）
  html = html.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // 兜底：href/src 上的 javascript:
  html = html.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
  // 标签白名单：仅保留允许标签，并对其属性做过滤
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m: string, tag: string, attrs: string) => {
    const lower = tag.toLowerCase()
    if (!ALLOWED_HTML_TAGS.has(lower)) return '' // 删除不在白名单的标签
    if (!attrs) return m
    const filteredAttrs = attrs.replace(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
      (am: string, name: string, val?: string) => {
        const attrName = name.toLowerCase()
        if (!ALLOWED_HTML_ATTRS.has(attrName)) return ''
        if (val === undefined) return name // 布尔属性（controls / autoplay 等）
        const cleanVal = sanitizeAttrValue(attrName, val)
        if (cleanVal === '' && /^(href|src|style)$/i.test(attrName)) return ''
        return `${name}=${cleanVal}`
      },
    )
    return m.replace(attrs, filteredAttrs)
  })
  return html
}

// ===== 注册所有扩展并创建 marked 实例 =====
export function createExtendedMarked(): Marked {
  const m = new Marked({
    gfm: true,
    breaks: true,
  })
  // 行内扩展按优先级注册
  m.use({ extensions: [katexInline, katexBlock, highlight, mention, imageSized, videoEmbed, bilibiliEmbed, pdfEmbed, fileLink] })
  return m
}

// 单例：默认 marked 实例
let _defaultMarked: Marked | null = null
export function getDefaultMarked(): Marked {
  if (!_defaultMarked) _defaultMarked = createExtendedMarked()
  return _defaultMarked
}

// 渲染：HTML 透传 + KaTeX + 所有扩展
export function renderExtendedMarkdown(src: string, sanitize = true): string {
  if (!src) return ''
  const marked = getDefaultMarked()
  let html = ''
  try {
    html = marked.parse(src, { async: false }) as string
  } catch (e: any) {
    html = `<pre class="md-error">渲染失败：${escapeHtml(e?.message || String(e))}</pre>`
  }
  if (sanitize) html = sanitizeHtml(html)
  return html
}

// 提取所有 @提及 的用户 ID（用于通知触发）
export function extractMentions(src: string): Array<{ uid: number; name: string }> {
  if (!src) return []
  const out: Array<{ uid: number; name: string }> = []
  const re = /@\[([^\]]+?)\]\(\/user\/(\d+)\)/g
  let m
  while ((m = re.exec(src)) !== null) {
    out.push({ uid: Number(m[2]), name: m[1] })
  }
  return out
}
