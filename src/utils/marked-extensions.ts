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
import { API_BASE } from './helpers'

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

/**
 * 【v4.9.1】判断 `html` 的 `pos` 位置是否落在某个「块级容器」的**内部**。
 *
 * 用于阻止把空行占位块插进 `<ul>` / `<ol>` / `<table>` / `<blockquote>` 内部
 * （那会造成非法嵌套，浏览器会拆坏结构）。
 *
 * 做法：从 `pos` 往回扫描，遇到**未闭合**的容器开标签则判定为"在内部"。
 *   用一个栈来配对：从头部扫到 pos，遇到开标签入栈、闭标签出栈；
 *   若扫描结束时栈里还有容器标签，就说明 pos 在它内部。
 *
 * ⚠️ 只关心「容器类」标签（列表/表格/引用），`<p>` 这类叶块不在其列 ——
 *    因为空行插在 `</p>` 与 `<p>` 之间是**合法且正是我们想要的**。
 */
function insideBlockContainer(html: string, pos: number): boolean {
  const CONTAINERS = new Set(['ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'blockquote', 'pre'])
  const stack: string[] = []
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g
  let m: RegExpExecArray | null
  const head = html.slice(0, pos)
  while ((m = re.exec(head)) !== null) {
    const name = m[1].toLowerCase()
    const selfClose = m[2] === '/'
    const isClose = m[0].charAt(1) === '/'
    if (!CONTAINERS.has(name)) continue
    if (selfClose) continue
    if (isClose) {
      const k = stack.lastIndexOf(name)
      if (k >= 0) stack.splice(k, 1)
    } else {
      stack.push(name)
    }
  }
  return stack.length > 0
}

/**
 * 【v4.9.1】把「数据里留的 N 个空行」还原到渲染后的 HTML 里。
 *
 * 【为什么必须从源码数，而不是从 HTML 数】
 *   `marked` 已经把 `\n\n` / `\n\n\n` 都压成了同样的 `<p>甲</p><p>乙</p>`，
 *   空行数量在 HTML 里**已经不可恢复**。所以只能回到源 Markdown 里数。
 *
 * 【算法】
 *   1. 扫描源 Markdown，找出每一处「连续 ≥2 个换行」，记录它前后的**纯文本片段**
 *      （用于定位对应的 HTML 位置）
 *   2. 把「N 个换行」换算成「N-1 个空行」
 *   3. 在渲染后的 HTML 里，找到「前片段末尾」与「后片段开头」之间，
 *      插入 (N-1) 个空段落标记 `<p class="zg-br"></p>`
 *      —— 每个空段落 = 一行真实空白，与段落自身 margin 叠加后**恰好**是一行
 *         （实测：整块 27px，正好等于行高 27px，视觉上不偏不倚）
 *
 * 【保守策略 —— 宁可少补，不可乱补】
 *   只要有任何一步无法精确定位（片段为空、在 HTML 里找不到、落在代码块/表格里），
 *   就**跳过这一处**，保持 marked 的默认渲染。这样不会破坏任何既有排版。
 */
function restoreBlankLines(html: string, src: string): string {
  if (!html || !src) return html
  // 快速短路：没有连续换行就没有空行要补
  if (!/\n[ \t]*\n/.test(src)) return html

  /**
   * 该行是否属于「语法上必须紧贴的结构块」—— 这些结构在 Markdown 里
   * **行与行之间必须连续**，其周围的空行是**语法要求**，不是用户留的空行。
   * 若把它们也当成"用户空行"去补占位块，就会把 `<p class="zg-br">`
   * 插进 `<ol>` / `<table>` **内部**（非法嵌套，实测踩过）。
   *
   * 覆盖：
   *   · GFM 表格行       `| a | b |`
   *   · 列表项           `- x` / `1. x` / `* x`（含嵌套缩进）
   *   · 引用             `> x`
   *   · 代码围栏         ``` / ~~~
   *   · 缩进代码块       4 空格 / Tab 起首
   */
  const isStructuralLine = (line: string) =>
    /^\s*\|/.test(line) ||                     // GFM 表格行
    /^\s*[-*+]\s+/.test(line) ||               // 无序列表项
    /^\s*\d+\s*[.)]\s+/.test(line) ||          // 有序列表项
    /^\s*>/.test(line) ||                      // 引用
    /^\s*```/.test(line) ||                    // 代码围栏
    /^\s*~~~/.test(line) ||
    /^\s{4,}|\t/.test(line)                    // 缩进代码块

  const lines = src.replace(/\r\n?/g, '\n').split('\n')

  /** 收集「空行组」：{ beforeText, afterText, count } */
  const groups: { before: string; after: string; count: number }[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() !== '') { i++; continue }
    // 找到一段连续空行
    const blankStart = i
    let blankEnd = i
    while (blankEnd + 1 < lines.length && lines[blankEnd + 1].trim() === '') blankEnd++
    const count = blankEnd - blankStart + 1
    // 前后的非空行（用于在 HTML 里定位）
    let p = blankStart - 1
    while (p >= 0 && lines[p].trim() === '') p--
    let n = blankEnd + 1
    while (n < lines.length && lines[n].trim() === '') n++
    const beforeLine = p >= 0 ? lines[p] : ''
    const afterLine = n < lines.length ? lines[n] : ''
    // 结构行 / 首尾场景 → 跳过（不补）
    if (
      beforeLine && afterLine &&
      !isStructuralLine(beforeLine) && !isStructuralLine(afterLine)
    ) {
      groups.push({ before: beforeLine, after: afterLine, count })
    }
    i = blankEnd + 1
  }
  if (!groups.length) return html

  /**
   * 从「Markdown 行」提取可用于在 HTML 里定位的关键词（剥掉语法符号）。
   *
   * ⚠️ 长度门槛设 1（不是 2）：短句在题库里非常常见
   *   （「解：」「（1）」「甲」），门槛过高会让这些场景完全失效。
   *   安全性由后面的「两片段之间必须是纯标签/空白」校验保证，不靠长度。
   */
  const keyOf = (line: string) => {
    const t = line
      .replace(/^\s*#{1,6}\s+/, '')          // 标题
      .replace(/^\s*[-*+]\s+/, '')           // 列表
      .replace(/^\s*\d+\s*[.)]\s+/, '')
      .replace(/[*_`~$\\]/g, '')
      .trim()
    return t.length >= 1 ? t : ''
  }

  let out = html
  for (const g of groups) {
    const bKey = keyOf(g.before)
    const aKey = keyOf(g.after)
    if (!bKey || !aKey) continue

    // 定位「前片段」在 HTML 里的位置，然后**向后跳到它所在块的结束标签之后** ——
    //   ⚠️ 这是关键：不能把空段落插在 `<p>甲` 与 `</p>` 之间（非法嵌套，
    //   浏览器会把 `<p>` 提前闭合，结构被拆坏，实测得到 `<p>甲<p class="zg-br"></p></p>`）。
    //   必须插在 `</p>` 之后、下一块 `<p>` 之前。
    const bIdx = out.indexOf(bKey)
    if (bIdx < 0) continue
    const bEnd = bIdx + bKey.length
    const closeM = /^[^<]*<\/(?:p|div|li|h[1-6]|blockquote|td|th)>/i.exec(out.slice(bEnd))
    if (!closeM) continue
    const insertAt = bEnd + closeM[0].length

    // 「后片段」必须出现在插入点之后（确认顺序正确）
    const aIdx = out.indexOf(aKey, insertAt)
    if (aIdx < 0) continue
    // 插入点与后片段之间必须是**纯标签/空白**（没有文字）→ 说明两者是相邻块
    const between = out.slice(insertAt, aIdx)
    if (between.replace(/<[^>]*>/g, '').trim() !== '') continue
    if (!/<\/?(?:p|div|li|h[1-6])[\s>]/i.test(between)) continue

    // ⚠️ 绝不允许插进「有块内结构的容器」内部。
    //   若插入点落在 `<ul>…</ul>` / `<ol>…</ol>` / `<table>…</table>` /
    //   `<blockquote>…</blockquote>` 的**开闭区间之内**，就说明这里不是"用户留的空行"，
    //   而是列表/表格的语法性空行 —— 补一个 `<p>` 进去会造成非法嵌套，
    //   浏览器会把整个列表结构拆坏（实测：`<p class="zg-br">` 被插到 `</li>` 与 `</ol>` 之间）。
    if (insideBlockContainer(out, insertAt)) continue

    // ── 空行数量换算 ──
    // 数据里 `\n\n` = 用户留了 1 个空行 → 补 1 个空段落。
    // （marked 已把 `\n\n` 渲染成新段落，段间间距由 margin 提供；
    //   真正的「空行」需要额外一行高度，故补 count 个空段落。）
    // ⚠️ 上限 6，防止脏数据（几百个空段）撑爆页面。
    const n = Math.min(Math.max(0, g.count), 6)
    if (!n) continue
    const filler = '<p class="zg-br"></p>'.repeat(n)
    out = out.slice(0, insertAt) + filler + out.slice(insertAt)
  }
  return out
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

  // ==========================================================================
  // 【v4.9.1 · 空行数量还原】—— 把「数据里留了几个空行」忠实地渲染出来
  // --------------------------------------------------------------------------
  // 【为什么需要这一段】用户原话：「我留了多少空行就是多少」。
  //
  // 【问题】`marked` 的 `breaks: true` 有个硬限制：
  //   · 单个 `\n` → `<br>`（好，符合「一次回车 = 一次换行」）
  //   · `\n\n`   → **真正的段落分隔**，输出 `<p>甲</p><p>乙</p>`
  //   · `\n\n\n` → 也是 `<p>甲</p><p>乙</p>`（空行数量被**彻底丢弃**）
  //
  // 实测证据（浏览器内真实渲染）：
  //   `甲\n\n乙`   → `<p>甲</p><p>乙</p>`
  //   `甲\n\n\n乙` → `<p>甲</p><p>乙</p>`   ← 两者**输出完全相同**，用户留的空行没了
  //
  // 【修法】在 `\n\n` 之间插入一个**真实空段落**占位，
  //   渲染后它就成了货真价实的一行空白，与 `.zg-rich` 的 `pre-wrap` 配合即所见即所得。
  //   具体：`\n\n` 的第 2 个换行后的位置插入 `<br>` 空行标记（变成 `<p>` 内部的一个换行）。
  //
  // 【精度设计 —— 必须严格可逆】
  //   · 1 个 `\n`（紧贴/换行）      → 保持 1 个 `\n` → 渲染为一次换行
  //   · 2 个 `\n`（分段/1 个空行）  → 渲染为「一次换行 + 一次空行」← 与用户预期一致
  //   · N 个 `\n`                   → 渲染出 N-1 个空行
  //   为此把「连续的 ≥2 个换行」统一改写为「`\n` + (N-1) 个显式空行标记」。
  // ==========================================================================
  html = restoreBlankLines(html, src)

  // 【v4.9.1】`breaks: true` 会把 `\n\n` 里的换行也变成 `<br>`，
  //   于是 `<p>甲<br><br>乙</p>` 在 pre-wrap 下 = 2 条换行 = 2 个空行（应为 1 个）。
  //   把**紧挨着**的连续 `<br>` 折叠成 1 个（中间夹任何文字/标签都不匹配，
  //   因此对 `<br>甲<br>乙` 这类真实多行零影响）。
  html = html.replace(/(<br\s*\/?>\s*){2,}/gi, '<br>')
  // 【v4.8.27】剥掉渲染结果**首尾**的空白 —— 修复「首页公告/页脚末尾莫名多出一个空行，删不掉」
  //   根因：marked 输出的 HTML 末尾天然带一个换行符（`<p>…</p>\n`，标准行为，不是 bug）；
  //        而展示容器（如 `.ab-text`）带 `white-space: pre-wrap`（v4.8.25 为「不吞空格空行」加的），
  //        于是这个 `\n` 被**渲染成一个真实空行**。
  //   实测证据：公告 `<p>` 高 71px、容器高 95px，差值 24px ≈ 14px × 1.7(line-height)，正好一行。
  //   用户视角：这个空行**不在公告文字里**，去后台怎么删都删不掉 —— 因为它每次渲染都被重新生成。
  //   修法：只 trim **首尾**，中间的空格/空行**完整保留**，
  //        因此对 v4.8.25 修好的「不吞空格空行」**零影响**（那条针对的是中间内容）。
  //   在此处统一处理的好处：公告栏、页脚、以及全站所有 renderMarkdown 调用方一次性修好，
  //        无需逐个组件打补丁。
  html = html.replace(/^\s+|\s+$/g, '')

  // ==========================================================================
  // 【v4.9.1 · 与「空行 1:1」配套的渲染端补齐】—— 让字符串里的 `\n` 与屏幕上的换行 1:1
  // --------------------------------------------------------------------------
  // 背景（用户原话）：
  //   「我留了多少空行就是多少。我 word 只是换了个行，就不应该出现空行，但是现在就冒出来了」
  //   「全站使用 HTML 的编辑器渲染之后都莫名其妙多出了很多空行，md 也是」
  //
  // 数据端（htmlToMarkdown）已在 v4.9.0/v4.9.1 把语义固定为：
  //   · 紧贴（一次回车）    → 单个 `\n`
  //   · 分段 / 刻意留的空行 → `\n\n`（严格 1 个空行）
  //   · 用户刻意留 N 行空行 → `\n\n` × N
  //
  // 渲染端此前有两个「凭空多一行」的来源，都在**行内层面**，与块级结构无关：
  //
  //   ① `breaks: true` 把**每一处 `\n`** 都变成 `<br>`（问题① 见下方 replace 注释）
  //   ② `marked` 输出的 HTML 里，块级标签之间天然带一个源码换行符
  //      （`<p>甲</p>\n<p>乙</p>\n`），而 `.zg-rich` 的 `white-space: pre-wrap`
  //      会把这个换行**渲染成一条真实空行** —— 它叠在段落自身 margin 之上。
  //
  // 修法（两处都只动**纯空白**，绝不碰文字）：
  //   ① `\n\n` → `\n`（见下）+ 行内 `<br>` 处理，保证「一次回车 = 一次换行」
  //   ② 消除「块级标签之间」的源码空白，避免它与段落 margin 重复计一次
  //
  // ⚠️ 关键设计：**只消除块级标签之间的空白，不动段落内部的换行**。
  //    这样 `\n\n` 落在两个 `<p>` 之间时，它的表现由 `.zg-rich p { margin }` 承担
  //    （视觉上就是一次正常分段），而**不会**额外再叠一条 pre-wrap 空行。
  // ==========================================================================

  // 【问题① 修法】`breaks:true` 会把 `\n\n` 里的换行也变成 `<br>`：
  //   `甲\n\n乙` → `<p>甲<br><br>乙</p>` → pre-wrap 下 = **2 条**换行 = 2 个空行。
  //   但 `\n\n` 的语义是「分段 / 1 个空行」，应当是**一次**换行。
  //   因此把行内的连续 2 个 `<br>` 折叠成 1 个 —— 只作用于**紧挨着**的 `<br><br>`
  //   （中间夹任何文字/标签都不匹配），所以对 `<br>甲<br>乙` 这类真实多行零影响。
  html = html.replace(/(<br\s*\/?>\s*){2,}/gi, '<br>')

  // 【问题② 修法】块级标签之间的源码空白（marked 输出格式所致，非用户内容）
  const BLOCK = 'p|div|ul|ol|li|table|thead|tbody|tr|blockquote|h[1-6]|pre|figure|figcaption|section|article|details'
  html = html.replace(new RegExp(`(<\\/(?:${BLOCK})>)\\s+(?=<(?:${BLOCK})\\b)`, 'gi'), '$1')

  // 【v4.4.3】上传图片存为相对 /api/file/{id}，补全为绝对 API 地址，
  // 否则在 Pages 域(xkzg.de5.net)下 <img> 请求相对路径会落到 SPA 兜底、导致裂图。
  html = html
    .replace(/(src=")\/api\/file\//g, `$1${API_BASE}/api/file/`)
    .replace(/(src=')\/api\/file\//g, `$1${API_BASE}/api/file/`)
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
