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

// ===== 【v4.9.0】转换过程中的「问题收集」通道 =====
//
// 【为什么需要】用户需求原文：「我必须要传进去是什么、渲染的是什么，最后导出 Word 就是什么」。
// 要兑现这句，转换器就不能"默默丢东西" —— 凡是**无法保真**的地方（尤其是图片），
// 必须让上层能拿到，进而明确告知用户，而不是让用户过几天在 Word 里发现一堆乱码。
//
// 典型场景：从某些软件复制的 HTML 里图片 src 是**本地磁盘路径**
// （`file:///C:/...` 或 `C:\Users\...\image1.png`）。浏览器出于安全**永远读不到**它，
// 入库后网页是裂图、导出 Word 是一串路径文字 —— 用户反馈的「图片成了带着 C 盘绝对路径的」
// 就是这个。此时唯一正确的做法是：**丢弃 + 计数 + 告知**，绝不落库。
export type HtmlToMdIssueType = 'localImageDropped'

export interface HtmlToMdIssue {
  type: HtmlToMdIssueType
  count: number
}

/** 本次转换收集到的问题（每次调用 htmlToMarkdown 时重置） */
let _issues: HtmlToMdIssue[] = []

/** 取出并清空本次转换的问题列表（必须在 htmlToMarkdown 之后立刻调用） */
export function takeHtmlToMdIssues(): HtmlToMdIssue[] {
  const out = _issues
  _issues = []
  return out
}

function _noteIssue(type: HtmlToMdIssueType, n = 1) {
  const hit = _issues.find(i => i.type === type)
  if (hit) hit.count += n
  else _issues.push({ type, count: n })
}

/** 本地磁盘绝对路径：`file://` 或 Windows 盘符（`C:\` / `C:/`） */
const LOCAL_DISK_SRC_RE = /^(?:file:[\\/]+|[a-zA-Z]:[\\/])/

/**
 * 判断图片 src 是否指向**本地磁盘**（浏览器读不到、绝不能入库）。
 * 注：`data:` 与 `blob:` 不算（前者可直接落库/上传，后者由调用方自行处理）。
 */
export function isLocalDiskSrc(src: string): boolean {
  return LOCAL_DISK_SRC_RE.test((src || '').trim())
}

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
      // 【v4.8.25 修复「表格单元格内容被压成一行」】
      //   原写法 `replace(/\n+/g, ' ')` 把单元格里的**所有换行**（含显式 <br>）
      //   压成空格 —— 用户从 Excel/Word 粘贴的多行单元格内容全部塌成一行。
      //   GFM 表格支持在单元格内用 `<br>` 表达换行（pandoc / GitHub / 组卷网一致做法），
      //   故这里把换行折叠成 `<br>`，而不是空格。
      //   注意：必须先折叠「空行 / 连续换行」，再统一替换为单个 <br>，避免出现 <br><br> 堆叠。
      txt = txt
        .replace(/\n{2,}/g, '\n')
        .replace(/\s*\n\s*/g, '<br>')
        // ⚠️ `|` 必须转义成 `\|`，否则单元格里的竖线会被 GFM 解析成新的列分隔符 → 表格错位
        //    （注意顺序：先转成 <br> 再转义竖线，避免把 `<br>` 里的字符误伤）
        .replace(/\|/g, '\\|')
        .trim()
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
      // 【v4.9.0 图片路径分流】本地磁盘路径（file:// / C:\...）浏览器读不到，
      //   若原样入库，网页是裂图、导出 Word 是一串路径文字 → 用户看到的"乱码"。
      //   这里直接丢弃并计数，由上层（MarkdownEditor）明确提示用户重新插入。
      if (isLocalDiskSrc(src)) { _noteIssue('localImageDropped'); return '' }
      // 【v4.8.25】保留图片尺寸：属性 width/height 优先，其次内联 style 的 width/height。
      //   输出平台原生的 `![alt](url =WxH)` 语法（imageSized 扩展消费），
      //   否则用户从 Word 粘贴来的图尺寸会在 HTML→Markdown 转换时被丢弃。
      const attrW = Number(e.getAttribute('width')) || 0
      const attrH = Number(e.getAttribute('height')) || 0
      const st = (e.getAttribute('style') || '')
      const stW = Number((st.match(/(?:^|;)\s*width\s*:\s*(\d+)px/i) || [])[1]) || 0
      const stH = Number((st.match(/(?:^|;)\s*height\s*:\s*(\d+)px/i) || [])[1]) || 0
      const w = attrW || stW
      const h = attrH || stH
      // base64 图片保留原样（调用方可先经 uploadDataImages 换成真实 URL）
      return (w && h) ? `![${alt}](${src} =${w}x${h})` : `![${alt}](${src})`
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

/** 块级元素 → Markdown
 *
 * 【v4.9.0「空行 1:1 忠实还原」的关键约定】
 *   本函数**不再**自作主张地在前后各加 `\n\n`，而是**只负责自身内容**，
 *   段落之间的分隔符由调用方根据「紧贴 / 分段」语义统一决定。
 *
 *   为什么必须这样改：原实现每段都返回 `\n\nX\n\n`，两段拼起来就是
 *   `\n\nA\n\n` + `\n\nB\n\n` = `\n\nA\n\n\n\nB\n\n`，甚至即使用 `\nA\n` 紧贴写法，
 *   拼接处仍是 `\n`+`\n` = 空行 —— **无论怎么写都会凭空多空行**。
 *   根因是「分隔符由两端各自贡献」这个设计本身就是错的。
 *
 *   现在：`blockToMd` 返回**纯内容**（可能首尾带少量结构换行，如列表），
 *   由 `joinBlocks()` 在块之间插入正确的分隔符（`\n` 紧贴 / `\n\n` 空行）。
 */
function blockToMd(e: HTMLElement, _prev?: HTMLElement | null): string {
  const tag = e.tagName.toLowerCase()
  switch (tag) {
    case 'h1': return `# ${inlineToMd(e).trim()}`
    case 'h2': return `## ${inlineToMd(e).trim()}`
    case 'h3': return `### ${inlineToMd(e).trim()}`
    case 'h4': return `#### ${inlineToMd(e).trim()}`
    case 'h5': return `##### ${inlineToMd(e).trim()}`
    case 'h6': return `###### ${inlineToMd(e).trim()}`
    case 'p': {
      const t = inlineToMd(e).trim()
      // 空段落 → 空字符串（由 joinBlocks 依据「空块」语义补出空行）
      return t
    }
    case 'ul': case 'ol': {
      const ordered = tag === 'ol'
      let i = 1
      let out = ''
      e.querySelectorAll(':scope > li').forEach(li => {
        const t = inlineToMd(li).trim().replace(/\n+/g, ' ')
        out += (out ? '\n' : '') + (ordered ? `${i++}. ${t}` : `- ${t}`)
      })
      return out
    }
    case 'blockquote': {
      const t = inlineToMd(e).trim()
      return t ? t.replace(/\n/g, '\n> ').replace(/^/, '> ') : ''
    }
    case 'pre': {
      const code = (e.querySelector('code') || e).textContent || ''
      return '```\n' + code.replace(/\n$/, '') + '\n```'
    }
    case 'hr': return '---'
    case 'table': return tableToMd(e)
    case 'br': return '\n'
    default: {
      // div / section 等容器：递归其子节点，内部同样按块语义拼接
      const kids = Array.from(e.childNodes)
      const parts: string[] = []
      let lastBlock: HTMLElement | null = null
      kids.forEach(c => {
        if (c.nodeType === Node.ELEMENT_NODE) {
          const ce = c as HTMLElement
          const t = ce.tagName.toLowerCase()
          if (BLOCK_TAGS.has(t)) {
            parts.push(blockToMd(ce, lastBlock))
            lastBlock = ce
          } else {
            parts.push(inlineToMd(ce))
          }
        } else {
          parts.push(inlineToMd(c))
        }
      })
      return joinBlocks(parts, kids.map(k => (k.nodeType === Node.ELEMENT_NODE ? (k as HTMLElement) : null)))
    }
  }
}

/**
 * 【v4.9.0】按 Word 的真实排版意图拼接块级内容 —— 「空行 1:1 忠实还原」的核心。
 *
 * 这是本轮**最关键**的一处设计：分隔符必须由**一个地方**统一决定，
 * 不能由每个块自己"前后各加一点"（那样拼接处必然翻倍）。
 *
 * 规则（依据用户原话「我留了多少空行就是多少。我 word 只是换了个行，
 * 就不应该出现空行」）：
 *   · 当前块为空（Word 里的空段落 `<p></p>` / `<p>&nbsp;</p>`）→ 产生**一个空行**
 *   · 当前块「紧贴」前一块（`isTightParagraph`：margin 为 0，或前一块以 `<br>` 结尾）
 *     → 用**单个 `\n`** 连接（只换行，不空行）
 *   · 其余 → 用 **`\n\n`** 连接（标准 Markdown 分段 = 一个空行）
 *
 * ⚠️ 为什么「紧贴」判据要读 margin：
 *     Word 里「换行」与「分段」的视觉差异**不是靠标签区分的**（都是 `<p>`），
 *     而是靠**段落间距**表达的：`margin:0` 视觉紧贴、`margin-bottom:12pt` 才有空行。
 *     原实现只看标签名，于是把「紧贴的换行」也当成了「分段」→ 凭空多空行。
 */
function joinBlocks(parts: string[], els: (HTMLElement | null)[]): string {
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i]
    const curEl = els[i]
    const isBlankBlock = curEl !== null && isBlankElement(curEl)
    // 空块：作为「空行」输出（等价于用户真的留了一个空行）
    if (isBlankBlock) {
      if (out && !/\n\n$/.test(out)) out += '\n\n'
      continue
    }
    if (!cur.trim()) continue
    if (!out) { out = cur; continue }
    const tight = curEl ? isTightParagraph(curEl, els[i - 1]) : false
    // 紧贴 → 单换行；分段 → 空行（若 out 已经以空行结尾则不再叠加）
    if (tight) out += '\n' + cur
    else out += (/\n\n$/.test(out) ? '' : '\n\n') + cur
  }
  return out
}

/** 判断块元素是否为「空块」（Word 里的空段落 —— 用户刻意留的空行） */
function isBlankElement(e: HTMLElement): boolean {
  const txt = (e.textContent || '').replace(/[\s\u00a0\u3000]/g, '')
  if (txt) return false
  // 只有 <br> 或什么都没有，且没有图片等可视内容
  return !e.querySelector('img, table, hr, video, iframe')
}

/**
 * 【v4.9.0】判断该段落与上一段落之间**应不应该有空行**。
 *
 * 这是本轮「空行 1:1 忠实还原」的核心判据 —— 读 Word 的**真实排版意图**，
 * 而不是机械按标签名加空行。
 *
 * 三条判据（任一命中即视为"紧贴"，即用户只是换了个行）：
 *   ① 显式零间距：`margin:0` / `margin-bottom:0` / `margin-top:0`
 *      —— Word 默认段落样式 `margin:0cm;margin-bottom:.0001pt` 就是这种，
 *         用户在 Word 里看到的是**紧贴的两行**。
 *   ② `<br>` 直接结尾：上一段的最后一个元素是 `<br>`（用户敲了 Shift+Enter/回车）
 *   ③ 前一段落是「空段落」的逆：本段是纯 `<br>` 或只有空白
 *
 * ⚠️ 必须**保守**：任何判据不成立时一律按「有空行」处理（标准 Markdown 分段），
 *    否则会破坏正常的段落层次 —— 宁可多一个空行，也不要把两段粘成一段。
 */
function isTightParagraph(e: HTMLElement, prev?: HTMLElement | null): boolean {
  const style = (e.getAttribute('style') || '').toLowerCase()

  // ── 判据 ①：显式零间距 ──
  // ⚠️ **CSS 优先级**：`margin-bottom` 会覆盖简写 `margin`。
  //   Word 常见写法 `margin:0cm;margin-bottom:12.0pt` —— 视觉上**是有空行的**，
  //   若只匹配到前面的 `margin:0cm` 就判成紧贴，会出现「该空行的地方没空行」。
  //   因此**必须优先检查 margin-bottom / margin-top**，只有它们不存在时才看简写 margin。
  const mb = e.getAttribute('style')?.match(/(?:^|;)\s*margin-bottom\s*:\s*([^;]+)/i)
  const mt = e.getAttribute('style')?.match(/(?:^|;)\s*margin-top\s*:\s*([^;]+)/i)
  const mShorthand = e.getAttribute('style')?.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/i)

  const isZero = (v?: string) => {
    if (!v) return false
    const s = v.trim().toLowerCase()
    // 0 / 0px / 0cm / .0001pt（约 0.0001 磅，视觉等同 0）
    return /^0(?:\.0+)?(?:[a-z%]*)$/.test(s) || /^\.?0{3,}1pt$/.test(s)
  }

  if (mb) {
    // 显式声明了 margin-bottom → 以它为准（这是最精确的信号）
    if (isZero(mb[1])) {
      // 若同时 margin-top 明确大于 0，则仍应有空行
      if (mt && !isZero(mt[1])) return false
      return true
    }
    // 明确的大于 0 的段后间距 → 一定有空行
    return false
  }
  if (mShorthand && isZero(mShorthand[1])) {
    if (mt && !isZero(mt[1])) return false
    return true
  }
  // Word 的 mso 段落间距样式（值为 0 表示紧贴）
  if (/mso-para-margin(?:-bottom)?\s*:\s*0(?:\.0+)?(?:[a-z%]*)/.test(style)) return true

  // ── 判据 ③：上一段以 <br> 结尾（用户在 Word 里敲了换行） ──
  if (prev) {
    const last = prev.lastElementChild
    if (last && last.tagName && last.tagName.toLowerCase() === 'br') return true
    const lastNode = prev.lastChild
    if (lastNode && lastNode.nodeType === Node.ELEMENT_NODE &&
        (lastNode as HTMLElement).tagName.toLowerCase() === 'br') return true
  }

  // ── 默认：按「分段」处理（保有空行）──
  // 保守策略：判据不成立时宁可保留空行，也不要把两段粘成一段（那会破坏段落层次）
  return false
}

/** 清理转换结果里多余的换行/空格
 *
 * 【v4.9.0「空行 1:1 忠实还原」】语义调整：
 *   用户明确要求「我留了多少空行就是多少」。
 *   原实现 `.replace(/\n{3,}/g, '\n\n')` 会把用户**刻意留的多个空行**压成 1 个 ——
 *   这与用户诉求冲突，改为**只做首尾清理**，中间空行数量原样保留。
 *
 * ⚠️ 但不能完全放任：`blockToMd` 每个块级都会前后各输出 `\n\n`，
 *    相邻块拼接会产生 `\n\n\n\n`（= 2 个空行），这是**转换器的拼接副产物**，
 *    不是用户的意图。因此仍需要把「拼接边缘」的连续换行归一化。
 *
 * 做法：把 3+ 换行折叠为 **2 个**（= 1 个空行），这正是 Markdown 里
 *   「分段」的标准表达；用户真的要多个空行时，Word 里一定有对应的空段落，
 *   那些空段落会被 `blockToMd` 的 `case 'p'` 保留下来（返回 `\n\n`）。
 */
function tidy(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')      // 行尾空格
    .replace(/\n{3,}/g, '\n\n')      // 3+ 空行 → 1 空行（仅归一化拼接副产物）
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
  // 1) <img src="…" alt="…" width="…" height="…"> → ![alt](src =WxH)
  //    【v4.8.25 修复「拖拽图片大小只在编辑器里生效」】
  //      原实现注释写着「width/height 等属性丢弃，样式交给 CSS 统一约束」——
  //      后果是**粘贴进来的图片尺寸从源头就没进源码**，用户在编辑器里拖出来的宽度
  //      保存后再打开就没了（"打开智能题库看就不行了"）。
  //      这里改为保留尺寸，并输出本平台原生支持的 `![alt](url =WxH)` 语法
  //      （见 marked-extensions.ts 的 imageSized 扩展），渲染侧零改动即可生效。
  out = out.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1]
      || (attrs.match(/\bsrc\s*=\s*([^\s>]+)/i) || [])[1] || ''
    const alt = (attrs.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '图片'
    if (!src) return ''
    // 【v4.9.0 图片路径分流】同 blockToMd 的 case 'img'：本地磁盘路径丢弃并计数
    if (isLocalDiskSrc(src)) { _noteIssue('localImageDropped'); return '' }
    // 尺寸来源优先级：width/height 属性 > 内联 style 里的 width/height
    const attrW = (attrs.match(/\bwidth\s*=\s*["']?(\d+)["']?/i) || [])[1]
    const attrH = (attrs.match(/\bheight\s*=\s*["']?(\d+)["']?/i) || [])[1]
    const styleM = attrs.match(/\bstyle\s*=\s*["']([^"']*)["']/i)
    const styleW = styleM ? (styleM[1].match(/(?:^|;)\s*width\s*:\s*(\d+)px/i) || [])[1] : undefined
    const styleH = styleM ? (styleM[1].match(/(?:^|;)\s*height\s*:\s*(\d+)px/i) || [])[1] : undefined
    const w = Number(attrW || styleW) || 0
    const h = Number(attrH || styleH) || 0
    // 只有宽高都拿到才写尺寸语法（imageSized 扩展要求 W 与 H 同时存在）
    return (w && h) ? `![${alt}](${src} =${w}x${h})` : `![${alt}](${src})`
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
  // 每次转换重置问题收集，避免上一次的结果串到这一次
  _issues = []
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

  // 【v4.9.0】改为收集「块内容 + 对应元素」后统一拼接 —— 由 joinBlocks
  //   依据 Word 的真实排版意图决定块间是「换行」还是「空行」。
  //   原实现让每个块自己前后各加 `\n\n`，拼接处必然翻倍（凭空多空行）。
  const parts: string[] = []
  const els: (HTMLElement | null)[] = []
  doc.childNodes.forEach(c => {
    if (c.nodeType === Node.ELEMENT_NODE) {
      const e = c as HTMLElement
      const t = e.tagName.toLowerCase()
      if (BLOCK_TAGS.has(t)) {
        parts.push(blockToMd(e, null))
        els.push(e)
      } else {
        parts.push(inlineToMd(e))
        els.push(null)
      }
    } else {
      parts.push(inlineToMd(c))
      els.push(null)
    }
  })
  const out = joinBlocks(parts, els)
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
