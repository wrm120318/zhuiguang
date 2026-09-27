// ===== HTML → Markdown 规范化（v4.8.16）=====
//
// 【为什么需要这个文件】
// 用户从 Word / 网页复制题目粘贴进编辑器时，剪贴板里是 `text/html`（含 <table>、
// <strong>、base64 <img> 等）。若原样存入 content，会同时引发三个问题：
//   ① 题库卡片：HTML 表格没有列宽约束 → 列被压成"竖排单字"，且样式与 Markdown
//      渲染的题目完全不一致（用户反馈"编辑器预览美观、提交后题库里就不是了"）；
//   ② Word 导出：导出器只认 Markdown 语法，不认识 HTML 标签，于是
//      `<table><tbody><tr><td><p><strong>` 被当普通文本原样写进文档 → 用户看到"乱码"；
//   ③ base64 图片：一段 Word 粘贴的题面能到 60KB，撑爆 D1 行、也撑爆卡片布局。
//
// 【设计原则】
// 统一收敛到 Markdown（本项目的"通用语"），让**下游只处理一种格式**：
//   粘贴 → htmlToMarkdown() → Markdown 存储 → 渲染/导出/组卷 全部走同一条链路。
// 这样不需要在每个消费端各写一套 HTML 分支，也不会出现"某处漏了 HTML 支持"。
//
// ⚠️ 存量数据里已有纯 HTML 的题目（如 id=57），规范化器不负责追溯，
//    那部分由 CSS 兜底（见 main.css 的 .markdown-body table 规则）。

/** 需要整段丢弃的标签（连同内容） */
const DROP_TAGS = /<(script|style|head|meta|link|title|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi

/** 转义 Markdown 特殊字符（仅用于纯文本节点，避免破坏结构） */
function escMd(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]])/g, '\\$1')
}

/** 块级标签 → 前后换行 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'hr',
])

/**
 * 解析 HTML 表格 → GFM 表格
 * Word 粘贴的表格常见嵌套 <p>，需先去标签再取文本。
 */
function tableToMd(table: HTMLElement): string {
  const rows: string[][] = []
  const trs = table.querySelectorAll('tr')
  trs.forEach(tr => {
    const cells: string[] = []
    tr.querySelectorAll('th,td').forEach(td => {
      // 单元格内可能有 <p><strong>文字</strong></p>，取纯文本 + 保留粗体标记
      let txt = inlineToMd(td as HTMLElement)
      txt = txt.replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim()
      cells.push(txt)
    })
    if (cells.length) rows.push(cells)
  })
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(r => r.length))
  const norm = rows.map(r => {
    const c = r.slice()
    while (c.length < cols) c.push('')
    return c
  })
  // 判断是否首行为表头：有 <th> 或首行全非空
  const hasTh = !!table.querySelector('th')
  const head = norm[0]
  const body = norm.slice(1)
  const lines: string[] = []
  lines.push(`| ${head.join(' | ')} |`)
  lines.push(`| ${Array(cols).fill('---').join(' | ')} |`)
  // 无 <th> 时，把首行也作为数据行重复一次（GFM 必须有分隔行）
  if (!hasTh) { /* 首行已作表头，保留原样 */ }
  body.forEach(r => lines.push(`| ${r.join(' | ')} |`))
  return '\n\n' + lines.join('\n') + '\n\n'
}

/** 行内元素 → Markdown（递归处理子节点） */
function inlineToMd(el: HTMLElement | ChildNode): string {
  if (el.nodeType === Node.TEXT_NODE) {
    return escMd((el.textContent || '').replace(/\s+/g, ' '))
  }
  if (el.nodeType !== Node.ELEMENT_NODE) return ''
  const e = el as HTMLElement
  const tag = e.tagName.toLowerCase()
  const children = () => Array.from(e.childNodes).map(inlineToMd).join('')

  switch (tag) {
    case 'strong': case 'b': {
      const inner = children().trim()
      return inner ? `**${inner}**` : ''
    }
    case 'em': case 'i': {
      const inner = children().trim()
      return inner ? `*${inner}*` : ''
    }
    case 'del': case 's': case 'strike': {
      const inner = children().trim()
      return inner ? `~~${inner}~~` : ''
    }
    case 'code': {
      const inner = (e.textContent || '').replace(/`/g, '')
      return inner ? '`' + inner + '`' : ''
    }
    case 'br': return '\n'
    case 'sup': {
      const inner = children().trim()
      return inner ? `^${inner}^` : ''
    }
    case 'sub': {
      const inner = children().trim()
      return inner ? `~${inner}~` : ''
    }
    case 'img': {
      const src = e.getAttribute('src') || ''
      const alt = e.getAttribute('alt') || '图片'
      if (!src) return ''
      // base64 图片保留原样（调用方可先经 uploadDataImages 换成真实 URL）
      return `![${alt}](${src})`
    }
    case 'a': {
      const href = e.getAttribute('href') || ''
      const inner = children().trim() || href
      return href ? `[${inner}](${href})` : inner
    }
    case 'span': {
      // KaTeX 渲染产物：优先还原原始 LaTeX（编辑器会把 $..$ 转成 katex span 结构）
      const tex = e.querySelector('.katex-mathml annotation[encoding="application/x-tex"]')
      if (tex) {
        const raw = (tex.textContent || '').trim()
        const display = !!e.closest('.katex-display')
        return display ? `\n\n$$ ${raw} $$\n\n` : `$${raw}$`
      }
      const ann = e.querySelector('annotation[encoding="application/x-tex"]')
      if (ann) return `$${(ann.textContent || '').trim()}$`
      return children()
    }
    case 'table': return tableToMd(e)
    default: return children()
  }
}

/** 块级元素 → Markdown */
function blockToMd(e: HTMLElement): string {
  const tag = e.tagName.toLowerCase()
  switch (tag) {
    case 'h1': return `\n\n# ${inlineToMd(e).trim()}\n\n`
    case 'h2': return `\n\n## ${inlineToMd(e).trim()}\n\n`
    case 'h3': return `\n\n### ${inlineToMd(e).trim()}\n\n`
    case 'h4': return `\n\n#### ${inlineToMd(e).trim()}\n\n`
    case 'h5': return `\n\n##### ${inlineToMd(e).trim()}\n\n`
    case 'h6': return `\n\n###### ${inlineToMd(e).trim()}\n\n`
    case 'p': {
      const t = inlineToMd(e).trim()
      return t ? `\n\n${t}\n\n` : ''
    }
    case 'ul': case 'ol': {
      const ordered = tag === 'ol'
      let i = 1
      let out = '\n'
      e.querySelectorAll(':scope > li').forEach(li => {
        const t = inlineToMd(li).trim().replace(/\n+/g, ' ')
        out += ordered ? `${i++}. ${t}\n` : `- ${t}\n`
      })
      return out + '\n'
    }
    case 'blockquote': {
      const t = inlineToMd(e).trim()
      return t ? `\n\n> ${t.replace(/\n/g, '\n> ')}\n\n` : ''
    }
    case 'pre': {
      const code = (e.querySelector('code') || e).textContent || ''
      return `\n\n\`\`\`\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`
    }
    case 'hr': return '\n\n---\n\n'
    case 'table': return tableToMd(e)
    case 'br': return '\n'
    default: {
      // div / section 等容器：递归其子节点
      let out = ''
      e.childNodes.forEach(c => {
        if (c.nodeType === Node.ELEMENT_NODE) {
          const ce = c as HTMLElement
          const t = ce.tagName.toLowerCase()
          out += BLOCK_TAGS.has(t) ? blockToMd(ce) : inlineToMd(ce)
        } else {
          out += inlineToMd(c)
        }
      })
      // 纯文本 div 需要分段
      if (!out.includes('\n\n') && out.trim()) return `\n\n${out.trim()}\n\n`
      return out
    }
  }
}

/** 清理转换结果里多余的换行/空格 */
function tidy(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')      // 行尾空格
    .replace(/\n{3,}/g, '\n\n')      // 3+ 空行 → 1 空行
    .replace(/^\n+/, '')             // 首部空行
    .replace(/\n+$/, '')             // 尾部空行
    .trim()
}

/**
 * 【v4.8.18】判断一段内容是否"以 Markdown/纯文本为主，只是混入了个别 HTML 标签"。
 *
 * 背景：生产库里存在**混合格式**题面，例如物理 id=25 —— 正文是 Markdown + 行内 LaTeX
 * `$c_水=4.2\times10^3\mathrm{J/(kg·℃)}$`，中间只夹了一个裸 `<img src="…" width="300">`。
 * 这类内容若整条丢进 `htmlToMarkdown()`，`DOMParser` 会把它当 HTML 文档重新解析，
 * 段落结构与行内 LaTeX 都有被破坏的风险（属于"杀鸡用牛刀"）。
 *
 * 判据：HTML 标签总字符数占全文比例 < 8%，且标签种类很少（只有 img / br / sup 等行内标签）。
 * 命中时走 `inlineHtmlPatch()` 只做局部替换，其余内容原样保留。
 */
export function isMostlyMarkdown(s: string): boolean {
  if (!s) return false
  const tags = s.match(/<\/?[a-zA-Z][^>]*>/g) || []
  if (!tags.length) return true
  const tagChars = tags.reduce((n, t) => n + t.length, 0)
  if (tagChars / s.length >= 0.08) return false
  // 只要出现块级结构标签（table/ul/ol/div/p/h1-6/blockquote/pre），就按纯 HTML 处理
  const hasBlock = /<\s*(table|tbody|thead|tr|td|th|div|p|h[1-6]|ul|ol|li|blockquote|pre|section|article)\b[^>]*>/i.test(s)
  return !hasBlock
}

/**
 * 【v4.8.18】混合内容的"局部标签替换"：
 * 只把散落在 Markdown 里的 HTML 标签翻译成等价 Markdown，不去解析整篇文档。
 * 这样行内 LaTeX、段落空行、列表缩进等全部原样保留。
 */
function inlineHtmlPatch(s: string): string {
  let out = s
  // 1) <img src="…" alt="…"> → ![alt](src)   （width/height 等属性丢弃，样式交给 CSS 统一约束）
  out = out.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1]
      || (attrs.match(/\bsrc\s*=\s*([^\s>]+)/i) || [])[1] || ''
    const alt = (attrs.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '图片'
    return src ? `![${alt}](${src})` : ''
  })
  // 2) <br> → 换行
  out = out.replace(/<br\s*\/?>/gi, '\n')
  // 3) 行内语义标签
  out = out
    .replace(/<\/?strong\b[^>]*>/gi, '**')
    .replace(/<\/?b\b[^>]*>/gi, '**')
    .replace(/<\/?em\b[^>]*>/gi, '*')
    .replace(/<\/?i\b[^>]*>/gi, '*')
    .replace(/<\/?u\b[^>]*>/gi, '')
    .replace(/<\/?span\b[^>]*>/gi, '')
    .replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '^$1^')
    .replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, '~$1~')
  // 4) 清掉残留的孤立标签（开/闭不成对的情况）
  out = out.replace(/<\/?[a-zA-Z][^>]*>/g, '')
  // 5) 解码常见 HTML 实体
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
  return tidy(out)
}

/**
 * HTML → Markdown 主入口
 * @param html 原始 HTML 片段（可直接来自剪贴板 text/html 或数据库中的 HTML 题面）
 * @returns 规范化后的 Markdown；无法解析时返回去标签的纯文本兜底
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let src = html.replace(DROP_TAGS, '')
  // 去掉注释、条件注释
  src = src.replace(/<!--[\s\S]*?-->/g, '')
  // Word 特有的 <o:p></o:p> 等命名空间标签
  src = src.replace(/<\/?[a-z]+:[a-z]+\b[^>]*>/gi, '')

  // 【v4.8.18】混合内容（Markdown 为主 + 个别 HTML 标签）走局部替换，
  // 避免整篇走 DOMParser 造成的段落/LaTeX 结构损失。见 isMostlyMarkdown 注释。
  if (isMostlyMarkdown(src)) return inlineHtmlPatch(src)

  if (typeof document === 'undefined') {
    // SSR / 非浏览器环境：退化为去标签
    return tidy(src.replace(/<[^>]+>/g, ''))
  }

  const doc = document.createElement('div')
  doc.innerHTML = src

  let out = ''
  doc.childNodes.forEach(c => {
    if (c.nodeType === Node.ELEMENT_NODE) {
      const e = c as HTMLElement
      const t = e.tagName.toLowerCase()
      out += BLOCK_TAGS.has(t) ? blockToMd(e) : inlineToMd(e)
    } else {
      out += inlineToMd(c)
    }
  })
  // 空结果（例如只剩一个空 div）时兜底取纯文本
  const result = tidy(out)
  if (!result) return tidy(doc.textContent || '')
  return result
}

/**
 * 判断一段内容是否"看起来是 HTML"（用于导出器等下游做格式嗅探）
 * 命中块级标签或行内标签都算，但要排除 Markdown 里合法出现的尖括号（如数学 a<b）
 */
export function looksLikeHtml(s: string): boolean {
  if (!s) return false
  return /<\s*(table|tbody|thead|tr|td|th|p|div|span|strong|b|em|i|h[1-6]|ul|ol|li|img|br|sup|sub|blockquote|pre|section|article)\b[^>]*>/i.test(s)
}

export default htmlToMarkdown
