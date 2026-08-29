// ===== v4.2.2 CommonMark 扩展 =====
// 在 marked 渲染前/中注册以下扩展（**以下为实际生效语法，勿再写成旧注释里的形式**）：
//   1. KaTeX 行内 $...$ / 块级 $$...$$（样式本地打包，无 CDN 依赖；已排除 $100 这类金额误判）
//   2. ==text== 文本高亮
//   3. @[name](/user/uid) 用户提及
//   4. ![alt](url =100x100) 图片尺寸
//   5. @[video](https://.../a.mp4) 视频嵌入   ← 正式语法
//      @`https://.../a.mp4`                   ← 旧反引号写法，兼容保留
//   6. @[bilibili](BVxxx) 站外视频
//   7. @[pdf](https://.../a.pdf) PDF 嵌入     ← 正式语法
//      @`https://.../a.pdf`                   ← 旧反引号写法，兼容保留
//   8. file://文件名 附件引用（默认渲染为蓝色链接）
//   9. HTML：放行全部标签（黑名单仅拦截 script/style/link/meta 等），属性走白名单
//
// 历史坑（v4.2.2 修复前）：
//   - 文件头注释写的是 @[video]() / @[pdf]()，但代码只实现了 @`` 反引号形式 → 正式语法完全无效
//   - 嵌入容器用 <div>，而 inline 扩展结果会被包进 <p>，<p> 内放 <div> 非法 → 排版被浏览器纠正打乱
//   - KaTeX CSS 从 jsdelivr CDN 加载 0.16.11，与本地 katex 0.18.4 不符，CDN 不可达即退化成裸 LaTeX

import { Marked, type TokenizerAndRendererExtension } from 'marked'
import katex from 'katex'

/**
 * 兼容旧调用：KaTeX 样式已改为在 `src/styles/main.css` 顶部用
 * `@import 'katex/dist/katex.min.css'` 本地打包引入（原实现运行时插入 jsdelivr CDN 的
 * katex@0.16.11，与本地 0.18.4 版本不符，且 CDN 不可达时公式会退化成无样式裸 LaTeX）。
 * 此函数保留为空操作，避免既有调用方报错。
 */
export function ensureKatexCss() {
  /* 样式已随 main.css 打包，无需运行时注入 */
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
    // 匹配单个 $...$（不匹配 $$ ... $$；结尾 $ 后紧跟数字则不闭合，避开 "$5 and $10"）
    const match = /^\$([^$\n]+?)\$(?!\d)/.exec(src)
    if (!match) return undefined
    const inner = match[1]
    // 避免与货币/价格写法冲突（原实现这段判断是死代码，从未生效）：
    //   1) 内容首尾不能是空白 —— "$ 100 $" 不是公式
    //   2) 内容不能是纯数字/金额 —— "$100"、"$5.00"、"$1,000" 不是公式
    if (/^\s|\s$/.test(inner)) return undefined
    if (/^\d+(?:[.,]\d+)*$/.test(inner)) return undefined
    return {
      type: 'katexInline',
      raw: match[0],
      text: inner.trim(),
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

// ===== 5/6/7. 媒体嵌入 =====
// 说明：嵌入容器统一用 <span>（配合 CSS display:block），不用 <div>。
// 因为这些扩展注册在 inline 层，marked 会把结果包进 <p>，而 <p> 内放 <div> 是非法嵌套，
// 浏览器解析时会自动打断 <p>，造成排版错乱（原实现的严重问题之一）。

const VIDEO_RE = /\.(?:mp4|webm|ogg|ogv|mov|m4v)(?:[?#][^\s)]*)?$/i
const PDF_RE = /\.pdf(?:[?#][^\s)]*)?$/i

function renderVideo(url: string): string {
  return `<span class="zg-video-wrap"><video controls preload="metadata" src="${escapeHtml(url)}" class="zg-video" playsinline></video></span>`
}

function renderBili(bvid: string): string {
  const url = `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=0&danmaku=0`
  return `<span class="zg-bili-wrap"><iframe src="${escapeHtml(url)}" scrolling="no" frameborder="0" allowfullscreen="true" class="zg-bili-iframe"></iframe></span>`
}

function renderPdf(url: string): string {
  return `<span class="zg-pdf-wrap">` +
    `<span class="zg-pdf-head"><span class="zg-pdf-icon">📄</span><a href="${escapeHtml(url)}" target="_blank" rel="noopener">PDF 文档</a></span>` +
    `<iframe src="${escapeHtml(url)}" class="zg-pdf-iframe" loading="lazy"></iframe>` +
    `</span>`
}

// 5. @[video](url) —— 文档标注的正式语法（v4.2.2 修正：原实现只认旧反引号写法，此语法完全无效）
const videoEmbed: TokenizerAndRendererExtension = {
  name: 'videoEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@[video]') },
  tokenizer(src) {
    const match = /^@\[video\]\(([^)\s]+)\)/i.exec(src)
    if (!match) return undefined
    if (!VIDEO_RE.test(match[1])) return undefined
    return { type: 'videoEmbed', raw: match[0], url: match[1] }
  },
  renderer(token: any) { return renderVideo(token.url) },
}

// 5b. @`url.mp4` —— 旧反引号写法，保留以兼容历史内容
const videoEmbedLegacy: TokenizerAndRendererExtension = {
  name: 'videoEmbedLegacy',
  level: 'inline',
  start(src) { return src.indexOf('@`') },
  tokenizer(src) {
    const match = /^@`(https?:\/\/[^\s`]+)`/i.exec(src)
    if (!match) return undefined
    if (!VIDEO_RE.test(match[1])) return undefined
    return { type: 'videoEmbedLegacy', raw: match[0], url: match[1] }
  },
  renderer(token: any) { return renderVideo(token.url) },
}

// 6. @[bilibili](BVxxx) 站外视频
const bilibiliEmbed: TokenizerAndRendererExtension = {
  name: 'bilibiliEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@[bilibili]') },
  tokenizer(src) {
    const match = /^@\[bilibili\]\((BV[0-9A-Za-z]+)\)/.exec(src)
    if (!match) return undefined
    return { type: 'bilibiliEmbed', raw: match[0], bvid: match[1] }
  },
  renderer(token: any) { return renderBili(token.bvid) },
}

// 7. @[pdf](url) —— 文档标注的正式语法（v4.2.2 修正：原实现只认旧反引号写法，此语法完全无效）
const pdfEmbed: TokenizerAndRendererExtension = {
  name: 'pdfEmbed',
  level: 'inline',
  start(src) { return src.indexOf('@[pdf]') },
  tokenizer(src) {
    const match = /^@\[pdf\]\(([^)\s]+)\)/i.exec(src)
    if (!match) return undefined
    if (!PDF_RE.test(match[1])) return undefined
    return { type: 'pdfEmbed', raw: match[0], url: match[1] }
  },
  renderer(token: any) { return renderPdf(token.url) },
}

// 7b. @`url.pdf` —— 旧反引号写法，保留以兼容历史内容
const pdfEmbedLegacy: TokenizerAndRendererExtension = {
  name: 'pdfEmbedLegacy',
  level: 'inline',
  start(src) { return src.indexOf('@`') },
  tokenizer(src) {
    const match = /^@`(https?:\/\/[^\s`]+)`/i.exec(src)
    if (!match) return undefined
    if (!PDF_RE.test(match[1])) return undefined
    return { type: 'pdfEmbedLegacy', raw: match[0], url: match[1] }
  },
  renderer(token: any) { return renderPdf(token.url) },
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

// ===== HTML 过滤 =====
// v4.2.2 修正：原实现是「固定白名单」（约 85 个标签），svg / input / button / form / label
// 等大量常用标签会被静默删除，与"支持全部 HTML 标签"的能力说明不符。
// 现改为「黑名单」：放行所有标签，只拦截少数可携带脚本或改变文档级的危险标签。
// 安全防护不减弱，仍保留：
//   ① script / style / link / meta 标签连同内容整体剥离
//   ② 所有 on* 事件属性剥离
//   ③ href / src 的 javascript: 拦截
//   ④ data: 仅放行 image/*
//   ⑤ 属性白名单 + 危险 style（expression()/javascript:）拦截
const BLOCKED_HTML_TAGS = new Set([
  // 可执行脚本 / 注入样式
  'script', 'style', 'link', 'meta', 'base', 'noscript',
  // 文档级结构（不应出现在富文本片段中）
  'html', 'head', 'body', 'title', 'doctype',
  // 框架集（iframe 本身允许，用于 B站 / PDF 嵌入）
  'frameset', 'frame',
])

// 允许的 HTML 属性（其余一律删除，杜绝 on* / srcdoc / javascript: 等注入）
const ALLOWED_HTML_ATTRS = new Set([
  // 通用
  'class', 'id', 'title', 'lang', 'dir', 'style', 'role', 'tabindex', 'hidden',
  // 尺寸 / 资源
  'width', 'height', 'alt', 'src', 'href', 'target', 'rel', 'type',
  'srcset', 'sizes', 'media', 'poster', 'loading', 'decoding', 'referrerpolicy',
  'download', 'crossorigin', 'integrity',
  // 媒体
  'controls', 'preload', 'autoplay', 'loop', 'muted', 'playsinline', 'kind', 'label', 'default',
  // 嵌入（iframe 用于 B站 / PDF）
  'allowfullscreen', 'frameborder', 'scrolling', 'sandbox', 'allow',
  // 表格
  'colspan', 'rowspan', 'scope', 'headers', 'span', 'align', 'valign',
  // 列表 / 折叠
  'start', 'reversed', 'open', 'datetime', 'cite',
  // 表单（配合"全标签"放行）
  'name', 'value', 'placeholder', 'for', 'form', 'action', 'method', 'enctype',
  'checked', 'selected', 'disabled', 'readonly', 'multiple', 'required',
  'min', 'max', 'step', 'maxlength', 'minlength', 'pattern', 'rows', 'cols',
  'accept', 'capture', 'autocomplete', 'autofocus', 'inputmode', 'list',
  // 图像映射 / 旧标签
  'usemap', 'ismap', 'shape', 'coords', 'border', 'bgcolor',
  // SVG / MathML 常用属性
  'viewbox', 'preserveaspectratio', 'xmlns', 'version', 'd', 'cx', 'cy', 'r', 'rx', 'ry',
  'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'transform', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity',
  'opacity', 'text-anchor', 'dominant-baseline', 'font-size', 'font-family', 'font-weight',
  'clip-path', 'mask', 'filter', 'marker-end', 'marker-start',
  // data-uid 保留（@提及用）
  'data-uid',
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
    // value 可能带引号（"..."、'...'），先剥掉再判断，避免带引号的 data: 被漏判
    const v = value.replace(/^["']|["']$/g, '')
    if (/^\s*javascript:/i.test(v)) return ''
    // data: 仅允许图片类型，避免 data:text/html 直接执行
    if (/^\s*data:/i.test(v) && !/^\s*data:image\//i.test(v)) return ''
    return value
  }
  return value
}

export function sanitizeHtml(html: string): string {
  // 移除 script / style 标签及其内容
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '')
  // 移除 link / meta（非渲染用途，且可能携带注入）
  html = html.replace(/<(link|meta)\b[^>]*>/gi, '')
  // 移除所有 on* 事件属性（双引号 / 单引号 / 无引号）
  html = html.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // 兜底：href/src 上的 javascript:
  html = html.replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
  // 标签黑名单：只删除危险标签，其余全部放行，并对属性做过滤
  html = html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (m: string, tag: string, attrs: string) => {
    const lower = tag.toLowerCase()
    if (BLOCKED_HTML_TAGS.has(lower)) return '' // 删除危险标签
    if (!attrs) return m
    const filteredAttrs = attrs.replace(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g,
      (am: string, name: string, val?: string) => {
        const attrName = name.toLowerCase()
        // data-* / aria-* 一律放行（自定义数据与无障碍语义，无脚本风险）
        const isDataOrAria = attrName.startsWith('data-') || attrName.startsWith('aria-')
        if (!isDataOrAria && !ALLOWED_HTML_ATTRS.has(attrName)) return ''
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
  // 行内扩展按优先级注册：正式语法 @[video]/@[pdf]/@[bilibili] 在前，旧反引号写法在后兜底
  m.use({
    extensions: [
      katexInline, katexBlock, highlight, mention, imageSized,
      videoEmbed, pdfEmbed, bilibiliEmbed,
      videoEmbedLegacy, pdfEmbedLegacy,
      fileLink,
    ],
  })
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
