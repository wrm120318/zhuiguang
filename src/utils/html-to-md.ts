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
 * 【v4.9.0 表格保真】判断表格是否含**合并单元格**（rowspan / colspan）。
 *
 * 【为什么必须单独判】
 *   GFM 表格**语法上不支持** rowspan / colspan —— 这是规范硬限制，不是实现缺陷。
 *   用户原话「粘进去之后 合并的单元格等都无法正确显示 直接格式错乱」正是这个原因：
 *   一张 `| A | B |` 形式的表格**无法表达**「A 跨两行」这件事，
 *   任何"压成 GFM"的做法都必然丢信息。
 *
 * 【本项目的解法 —— 混合存储】
 *   · 无合并 → 照常转 GFM 表格（可被 marked 渲染、可全文搜索、体积小）✅
 *   · 有合并 → **整表原样保留为 HTML 片段**，交给渲染端直出。
 *     `sanitizeHtml` 的白名单里 `colspan` / `rowspan` 都是**放行**的，
 *     全站 `.markdown-body table` 样式对 HTML 表格同样生效，渲染侧零改动。
 *     导出端（DocxExportPanel）再把这层 HTML 解析回 Word 的 vMerge / gridSpan。
 *
 * 这样「传进去什么 = 渲染什么 = 导出什么」在表格上才真正成立。
 */
export function hasMergedCells(table: HTMLElement): boolean {
  return table.querySelector('td[rowspan], th[rowspan], td[colspan], th[colspan]') !== null
}

/**
 * 把表格序列化成**干净 HTML 片段**（用于合并单元格表格的保真存储）。
 *
 * ⚠️ 只保留白名单属性（rowspan / colspan / valign / align），
 *    并剔除 Word 的垃圾属性（`class`、`mso-*`、`width` 之类会撑破版心的属性）。
 *    否则一张 Word 表格能带出几 KB 的冗余属性，既撑大存储又破坏全站样式。
 *
 * ⚠️ **根元素（table 自身）也必须洗** —— `querySelectorAll('*')` 只返回后代，
 *    不含自身。早期版本漏了这一点，导致 `<table class="MsoNormal" width="800">`
 *    的脏属性全部漏网（实测：class / width / mso-* 都还在）。
 */
function tableToHtml(table: HTMLElement): string {
  const clone = table.cloneNode(true) as HTMLElement
  // 自身 + 所有后代一起洗（clone 是根，querySelectorAll 只给后代）
  const all: HTMLElement[] = [clone, ...Array.from(clone.querySelectorAll('*')) as HTMLElement[]]
  for (const e of all) {
    for (const a of Array.from(e.attributes)) {
      const n = a.name.toLowerCase()
      // 保留：结构属性（合并）+ 对齐（Word 的居中/顶对齐是有语义的排版意图）
      const keep = n === 'rowspan' || n === 'colspan' || n === 'valign' || n === 'align'
      if (!keep) e.removeAttribute(a.name)
    }
  }
  // Word 常塞 <p> 到单元格里，保留（渲染端样式已适配，且保住了段内结构）
  return clone.outerHTML
}

/**
 * 解析 HTML 表格 → GFM 表格
 * Word 粘贴的表格常见嵌套 <p>，需先去标签再取文本。
 *
 * 【v4.9.0】含合并单元格时**不转 GFM**，改为原样输出 HTML 片段
 *   （GFM 语法无法表达 rowspan/colspan，转换必然丢信息）。
 */
function tableToMd(table: HTMLElement): string {
  // 合并单元格 → 保真优先，直接存 HTML
  if (hasMergedCells(table)) return tableToHtml(table)

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
  // ⚠️ 这里**不再**自带前后 `\n\n`。
  //   `joinBlocks` 是分隔符的**唯一决定方**（见其注释）—— 本函数若也加一份，
  //   拼接处就翻倍。实测证据：`<p>说明如下</p><table>…</table><p>结论</p>`
  //   曾经输出 `说明如下\n\n\n| 甲 | 乙 |\n…\n\n\n结论`（表格前后各多一行空行）。
  return lines.join('\n')
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
 *   · 当前块为空（Word 里的空段落 `<p></p>` / `<p>&nbsp;</p>`）
 *     → **累积计数**，在下一个非空块之前精确补出对应条数的空行
 *   · 当前块「紧贴」前一块（`isTightParagraph`：margin 为 0，或前一块以 `<br>` 结尾）
 *     → 用**单个 `\n`** 连接（只换行，不空行）
 *   · 其余 → 多个相邻非空块之间，用 **`\n\n`** 连接（标准 Markdown 分段 = 一个空行）
 *
 * ⚠️ 为什么「紧贴」判据要读 margin：
 *     Word 里「换行」与「分段」的视觉差异**不是靠标签区分的**（都是 `<p>`），
 *     而是靠**段落间距**表达的：`margin:0` 视觉紧贴、`margin-bottom:12pt` 才有空行。
 *     原实现只看标签名，于是把「紧贴的换行」也当成了「分段」→ 凭空多空行。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.9.1 修正 · 空行数量必须精确累加，不能"补齐即止"】
 *
 * 上一版对每个空块只做 `if (out && !/\n\n$/.test(out)) out += '\n\n'` ——
 * 也就是「已经以空行结尾就不再叠加」。后果是**连续多个空段落被压成一个空行**：
 *
 *   实测证据（浏览器内真实转换）：
 *     `<p>甲</p><p></p><p>乙</p>`         → `甲\n\n\n乙`（3 个换行 = 2 个空行 ❌ 应为 1 个）
 *     `<p>甲</p><p></p><p></p><p>乙</p>`  → `甲\n\n\n乙`（与上一条**完全相同** ❌ 应为 2 个）
 *   用户视角：「我留了多少空行就是多少」彻底失效 —— 留 1 行和留 2 行看起来一样。
 *
 * 修法：把空块**累积成计数 `pendingBlanks`**，等遇到下一个非空块时，
 *   一次性在它前面补出 `pendingBlanks` 条空行。
 *   这样「N 个空段落」严格对应「N 个空行」。
 *
 * ⚠️ 同时修正「空块与紧贴」的交互：空块之后的第一个非空块，
 *    其连接符**已经由空行承担**，不能再叠加「分段」或「紧贴」的换行。
 * ────────────────────────────────────────────────────────────────────────────
 */
function joinBlocks(parts: string[], els: (HTMLElement | null)[]): string {
  let out = ''
  /** 已累积但尚未输出的空行条数 */
  let pendingBlanks = 0

  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i]
    const curEl = els[i]

    // ① 空块 → 只累加，不立刻输出（数量要精确保留）
    if (curEl !== null && isBlankElement(curEl)) { pendingBlanks++; continue }
    if (!cur.trim()) continue

    // ② 第一个非空块
    if (!out) {
      out = cur
      pendingBlanks = 0   // 首部的空行无意义（会被 tidy 清掉），直接丢弃
      continue
    }

    // ③ 有空块待结算 → 精确补出对应条数的空行
    //
    //    【换算关系（务必别改错）】
    //      markdown 里的换行数 → 视觉空行数：
    //        1 个 `\n`   = 0 个空行（紧贴，只换行）
    //        2 个 `\n`   = 1 个空行
    //        N+1 个 `\n` = N 个空行
    //      而「N 个空段落」= 用户留了 N 个空行。故：
    //        `'\n'.repeat(pendingBlanks + 1)`
    //
    //    ⚠️ 不能写 `2 * pendingBlanks`：那会让 1 个空段落变成 2 个换行（对）
    //       但 2 个空段落变成 4 个换行 = 3 个空行（**多了 1 个**，实测踩过）。
    if (pendingBlanks > 0) {
      out += '\n'.repeat(pendingBlanks + 1) + cur
      pendingBlanks = 0
      continue
    }

    // ④ 无空块 → 按「紧贴 / 分段」决定连接符
    //
    //    ⚠️ 特例：**「有块内结构的块」必须用空行隔离**。
    //
    //      这些语法在 Markdown 里是「多行构成一个整体」，行与行之间有强依赖：
    //        · table        —— 表头 + 分隔行 + 数据行必须连续
    //        · ul / ol      —— 列表项必须连续（且不能与前后段落粘连）
    //        · pre          —— 代码块围栏
    //        · blockquote   —— 引用行前缀
    //
    //      一旦与相邻段落**紧贴**（只用一个 `\n`），marked 会把它们当成
    //      **同一个段落/同一个列表项的一部分**，结构直接被吃：
    //
    //      实测证据（浏览器内真实转换 + 渲染）：
    //        · `<p>说明</p><table>…</table><p>结论</p>`
    //            → 紧贴时 `结论` 被当成表格的第二行数据（表格错位）❌
    //        · `<p>条件：</p><ul><li>甲</li><li>乙</li></ul><p>结论</p>`
    //            → 紧贴时渲染成 `<li>乙<br>结论</li>`（`结论` 被吞进列表项）❌
    //
    //      这也解释了为什么 `tableToMd` 早期版本会**自带**前后 `\n\n`
    //      —— 当时的意图是对的，只是它与 `joinBlocks` 的 `\n\n` 叠加成了三连换行。
    //      现在把「哪些块需要空行隔离」这条语义**收到 joinBlocks 一处**，
    //      既不叠加（不会出现 `\n\n\n`）也不会漏（不会出现粘连）。
    //
    //    ⚠️ 判定必须用 **DOM 元素**（curEl / prevEl），不能用 `parts[i]` 的字符串 ——
    //      `blockToMd` 返回的是**转换后的 Markdown**（`| 甲 | 乙 |\n| --- |…`），
    //      里面已经没有 `<table` 前缀了。用字符串判断会全部漏判。
    const prevEl = els[i - 1]
    const NEEDS_GAP = new Set(['table', 'ul', 'ol', 'pre', 'blockquote'])
    const curNeedsGap = curEl !== null && NEEDS_GAP.has(curEl.tagName.toLowerCase())
    const prevNeedsGap = prevEl !== null && NEEDS_GAP.has(prevEl.tagName.toLowerCase())
    if (curNeedsGap || prevNeedsGap) { out += '\n\n' + cur; continue }
    const tight = curEl ? isTightParagraph(curEl, els[i - 1]) : false
    out += (tight ? '\n' : '\n\n') + cur
  }

  // 尾部残留的空块：无意义（会被 tidy 清掉），无需补出
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
 * 这是「空行 1:1 忠实还原」的核心判据 —— 读真实的**排版意图**，
 * 而不是机械按标签名加空行。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.9.1 修正 · 全站「渲染后莫名多出很多空行」回归】
 *
 * 上一版的默认分支是「判据不成立 → 按分段（一个空行）」。这在 Word 导入场景没问题，
 * 但对**全站其它入口是灾难**：HTML 编辑器 / 富文本粘贴出来的 `<p>甲</p><p>乙</p>`
 * 是**极其普通**的结构（就是敲了一次回车），它既没有 `margin:0` 也没有 `<br>`，
 * 于是每一对相邻段落都被判成「分段」，全部插进一个空行。
 * 而全站展示容器（`.zg-rich`）带 `white-space: pre-wrap` —— `\n\n` 会被渲染成
 * **一条真实的空行**。用户看到的就是「全站使用 HTML 编辑器渲染之后都莫名其妙多出很多空行」。
 *
 * 实测证据（浏览器内真实转换）：
 *   `<p>甲</p><p>乙</p>` → `甲\n\n乙`  ← 凭空多一个空行
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【修正后的判据 —— 改为「有明确排版证据才空行」】
 *
 * 「空行」在结构化 HTML 里本就不是默认语义：`<p>` 只是段落边界。
 * 真正表达「空段（= 用户刻意留的空行）」只有两种证据：
 *   ① 上一块是**空块** —— 由 `joinBlocks` 的 `isBlankElement` 分支处理，落到这里时
 *      `out` 已以 `\n\n` 结尾，下面的「不叠加」逻辑自然保证只空一行
 *   ② 本段有**明确的段前间距**（`margin-top` / `padding-top` 为正）或 `mso-para-margin-top`
 *
 * 因此「紧贴（单个 `\n`）」成为默认，只有下列情况才升级为「空行（`\n\n`）」：
 *   ① `margin-top` / `padding-top` 明确为正     —— 段前有间距 = 视觉空行
 *   ② `margin-bottom` 明确为正（且本段非最后）   —— 段后有间距 = 视觉空行
 *      ⚠️ Word 常见的 `margin:0cm;margin-bottom:.0001pt` **不算**（0.0001pt 视觉等同 0）
 *   ③ 上一段以 `<br>` 结尾                       —— 用户用换行结束上一段 = 空一行
 *
 * 这样两边的诉求同时满足：
 *   · Word 导入：`margin-bottom:12pt` 仍是空行、`.0001pt` 仍是紧贴（S2 的 21 条断言不变）
 *   · 全站 HTML/MD：普通 `<p>` 恢复「一次回车 = 一行」，不再凭空多空行
 */
function isTightParagraph(e: HTMLElement, prev?: HTMLElement | null): boolean {
  const styleAttr = e.getAttribute('style') || ''
  const style = styleAttr.toLowerCase()

  // 取值工具：优先长属性（margin-top 会覆盖简写 margin 的对应分量）
  const val = (name: string) => {
    const m = styleAttr.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i'))
    return m ? m[1].trim().toLowerCase() : ''
  }
  /** 「视觉上等于 0」：0 / 0px / 0cm / .0001pt 这类 */
  const isZero = (v: string) => {
    if (!v) return false
    return /^0(?:\.0+)?(?:[a-z%]*)$/.test(v) || /^\.?0{3,}1pt$/.test(v)
  }
  /** 「明确为正」：只有显式带单位的正值才算，避免把 `auto` / `inherit` 误判 */
  const isPositive = (v: string) => {
    if (!v) return false
    const m = /^(\d*\.?\d+)(pt|px|em|rem|cm|mm|in|%)$/.exec(v)
    if (!m) return false
    const n = parseFloat(m[1])
    if (!(n > 0)) return false
    // 0.0001pt 这类「Word 用来占位但视觉为 0」的值不算正间距
    if (m[2] === 'pt' && n < 0.01) return false
    return true
  }

  const mt = val('margin-top')
  const pt = val('padding-top')
  const mb = val('margin-bottom')
  const pb = val('padding-bottom')
  const mShort = styleAttr.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/i)?.[1].trim().toLowerCase() || ''

  // ── 证据 ①：段前有间距 → 视觉空行（不紧贴）──
  const msoBefore = /mso-para-margin-top\s*:\s*(?!0(?:\.0+)?(?:[a-z%]*)\b)[^;]+/.test(style)
  if (isPositive(mt) || isPositive(pt) || msoBefore) return false
  // 简写 margin 的第一个分量（上）为正 → 段前有间距
  if (mShort) {
    const first = mShort.split(/\s+/)[0]
    const isShorthandZero = isZero(mShort)
    if (!isShorthandZero && isPositive(first)) return false
  }

  // ── 证据 ②：段后有间距 → 视觉空行（不紧贴）──
  const msoAfter = /mso-para-margin-bottom\s*:\s*(?!0(?:\.0+)?(?:[a-z%]*)\b)[^;]+/.test(style)
  if (isPositive(mb) || isPositive(pb) || msoAfter) return false
  if (mShort && !isZero(mShort)) {
    const parts = mShort.split(/\s+/)
    // margin: 上 右 下 左 —— 只有 1 个值时上下同值（已在上面处理），
    // 这里看第 3 个分量（下）；2 值写法时第 1 个分量是上下同值
    const bottom = parts.length >= 3 ? parts[2] : (parts.length === 2 ? parts[0] : '')
    if (isPositive(bottom)) return false
  }

  // ── 证据 ③：上一段以 <br> 结尾 → **紧贴**（只换行，不空行）──
  //
  // 【v4.9.1 修正 · 这条的方向原来搞反了】
  //   上一版把它当成「有空行」的证据，理由是「用户敲了换行结束上一段」。
  //   但 `<br>` 的语义就是**一次换行**，它已经把「换行」这件事表达完了；
  //   若在它之后再加一个空行，用户看到的就比预期的多一行。
  //
  //   实测证据（浏览器内真实转换）：
  //     `<p>第一段文字<br></p><p>第二段文字</p>` → `第一段文字\n\n第二段文字`（1 个空行 ❌）
  //     期望 → `第一段文字\n第二段文字`（0 个空行 ✅）
  //
  //   ⚠️ 这正是用户抱怨「我 word 只是换了个行，就不应该出现空行，但是现在就冒出来了」
  //      的**直接原因之一** —— Word 里用 Shift+Enter 换行时，段落末尾就带 `<br>`。
  if (prev) {
    const last = prev.lastElementChild
    if (last && last.tagName && last.tagName.toLowerCase() === 'br') return true
    const lastNode = prev.lastChild
    if (lastNode && lastNode.nodeType === Node.ELEMENT_NODE &&
        (lastNode as HTMLElement).tagName.toLowerCase() === 'br') return true
  }

  // ── 默认：紧贴（单个换行）──
  // ⚠️ 这是与上一版**相反的默认值**，也是修掉「全站莫名多空行」的关键。
  //    「空行」必须由**空块**（isBlankElement）或**明确的段间距**来表达，
  //    而不是由「没找到证据」来兜底 —— 否则任何普通 `<p>甲</p><p>乙</p>`
  //    都会被塞进一条空行。
  return true
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
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 【v4.9.1 修正 · `\n{3,}` 折叠必须删掉】
 *
 * 上一版保留了 `.replace(/\n{3,}/g, '\n\n')`，理由是「归一化拼接副产物」。
 * 但 `joinBlocks` 重写之后**已经没有拼接副产物了** —— 分隔符只由它一处产出：
 *   · 紧贴 → 单个 `\n`
 *   · 分段 → `\n\n`
 *   · 空块 → 追加一组 `\n\n`
 * 也就是说，`\n\n\n` 这种形态**只可能来自用户的空块**（真的留了 2 个空行）。
 * 此时再折叠成 `\n\n` 就变成了「用户留了 N 个空行，最后只剩 1 个」——
 * 直接违背用户原话「我留了多少空行就是多少」。
 *
 * 实测证据（浏览器内真实转换）：
 *   `<p>甲</p><p></p><p></p><p>乙</p>` → 折叠前 `甲\n\n\n\n乙`、折叠后 `甲\n\n乙`
 *   渲染后前者 = 2 个空行（正确），后者 = 0 个空行（用户丢了两行）。
 *
 * 因此这里**只做首尾清理**，中间的连续换行（= 用户刻意留的空行）**原样保留**。
 * ⚠️ 但保留一个「安全上限」：连续换行最多 40 个（20 个空行），
 *    防止极端脏 HTML（几千个空段落）撑爆存储与渲染性能。
 */
function tidy(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')        // 行尾空格
    // 【v4.9.1】行首空格也要清。
    //   实测证据：`<p>甲</p>\n\n后续说明` 转出来是 `甲\n\n 后续说明`
    //   （第二行多一个前导空格）—— 来源是 `inlineToMd` 对文本节点做的
    //   `.replace(/\s+/g,' ')` 把原本作为「块间分隔」的换行符留成了一个空格。
    //   保留它会让 `.zg-rich` 的 `pre-wrap` 渲染出一格缩进（用户看到"莫名多了缩进"），
    //   也会让 Markdown 里出现 4 空格起首时被误判成**缩进代码块**。
    //   ⚠️ 只清**「纯文字行」**的行首空格：若该行以 Markdown 结构符号起首
    //      （列表 `-` / `1.`、引用 `>`、代码围栏 ``` / ~~~、表格 `|`），
    //      则缩进可能是**语义性的**（嵌套列表、缩进代码块），必须原样保留。
    .replace(/^[ \t]+(?=[^\s\-*+>|`~#\d])/gm, '')
    //   数值型有序列表（`1. x`）的行首缩进也要保留 —— 上面的否定字符类里的 \d
    //   只能挡住"数字紧跟文字"，挡不住 `1.`。这里单独兜一层：
    //   若行首缩进之后是 `数字.` 或 `数字)` 形式，同样不动。
    .replace(/^([ \t]+)(?=\d+[.)]\s)/gm, '$1')
    .replace(/\n{41,}/g, '\n'.repeat(40)) // 安全上限：≥20 个空行折叠（防脏数据）
    .replace(/^\n+/, '')               // 首部空行
    .replace(/\n+$/, '')               // 尾部空行
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
