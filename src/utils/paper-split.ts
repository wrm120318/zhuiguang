// ============================================================================
// 试卷切分公共规则（v4.16.0）
// ============================================================================
//
// 【为什么要这个文件（铁律#11：同一件事只允许一份实现）】
//   Word 试卷切分有**两个入口**，两处都必须给出完全一致的切分结果：
//     · `src/components/WordImportPanel.vue`      —— 快速导入面板
//     · `src/components/WordPaperSplitEditor.vue` —— 原卷分栏编辑器
//   历史上两处各写一份正则，结果**漂移**了：
//     - 导入面板的 `MINOR_RE` 认 `[.、)）]`，**漏了全角点 `．`**
//     - 编辑器同步地漏了（因为它是从导入面板复制过去的）
//   于是**真实试卷的全部题号都识别不出来**（实测：真实卷 20 道选择题
//   题号写法是 `1．（26-27九年级上·广东佛山·阶段检测）`，那个 `．` 是
//   全角句点 U+FF0E，不在 `[.、)）]` 里）。
//
// 【实测数据（真实卷 2026年10月4日初中历史作业.docx）】
//   题号字符级检视：
//     '1'  U+0031
//     '．' U+FF0E  ← 全角句点
//   旧 `MINOR_RE` 命中：MAJOR 3 条、真实题干 **0 条**（只有答案区的 `1．B` 命中）
//   → 退化成"只按大题切"，20 道选择题被揉成 1 个块（45 个选项挤在一起）
//   → 用户看到「识别出来全是乱的」。
//
// 【全角标点速查（本文件全部要认的"隐形杀手"）】
//   `．` U+FF0E 全角句点 ← 本次的真凶
//   `。` U+3002 中文句号（部分题库用它做题号分隔）
//   `、` U+3001 顿号
//   `（` U+FF08 / `）` U+FF09 全角括号
//   `１` U+FF11 全角数字
//   `　` U+3000 全角空格
//
// 【归一化优先】
//   与其在每个正则里到处塞全角字符，不如**先把全角归一化成半角**再匹配。
//   但注意：归一化只用于**识别/切分判定**，**不可用于输出内容**
//   ——否则会把用户原文里的全角标点改成半角，破坏排版。
//   所以本文件提供 `toHalfWidth()` 供「判定」使用，内容一律保留原文。
// ============================================================================

/**
 * 题号与正文之间的空白（含全角空格 U+3000、不换行空格 U+00A0）。
 * Word 里 `1．\u3000题干` 这种组合极常见。
 */
export const SP = `[\\s\\u00a0\\u3000]*`

/**
 * 题号的**分隔符**字符类。
 *
 * ⚠️ 这是本模块最核心的一个常量，所有题号正则都必须用它拼装，
 *    禁止再手写 `[.、)）]` —— 那正是本次 bug 的成因。
 *
 * 含：
 *   `.`  半角点
 *   `．` U+FF0E 全角句点 ← 真实卷在用
 *   `。` U+3002 中文句号
 *   `、` U+3001 顿号
 *   `)`  半角右括号
 *   `）` U+FF09 全角右括号
 */
export const QNO_SEP = '[.．。、)）]'

/** 中文数字（含零与百，覆盖「一、」到「一百、」）。 */
const CN_NUM = '[一二三四五六七八九十百零]'

/** 罗马数字（半角 + Ⅰ-Ⅻ 全角变体），用于「第Ⅰ卷」。 */
const ROMAN = '[0-9０-９一二三四五六七八九十IVXLCDMⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]'

/**
 * 二级小题号正则（**切题用**）：`1.` `1．` `1、` `1）` `(1)` `（1）`
 *
 * ⚠️ 这是**切题**语义：宁可多认（不漏切）。
 *   给「导入面板」用 —— 它按题号切「题块」，多认几个变体只会让题块更细，
 *   不会出错（导入面板本身还会再按 `MAJOR_RE` 分段）。
 */
export const MINOR_RE = new RegExp(
  `^${SP}(?:` +
    `[0-9０-９]{1,3}${SP}(?:[.．](?![0-9０-９])|[、。)）])` + // 1. / 1． / 1、 / 1） （1.5 排除）
    `|[（(]${SP}[0-9０-９]{1,3}${SP}[)）]` +                    // (1) / （1）
  `)`,
)

/**
 * 二级题号正则（**原卷编辑器切题用**）—— **比上面更严**。
 *
 * 【为什么不共用一份】
 *   编辑器的用户诉求是「**小问绝不能被切开**」：
 *     `(1)` `（1）` `1）` 这类**括号**编号是题目内部的小问，
 *     一旦被当切点，一道解答题会被劈成 4 道（用户实测报过的 bug）。
 *   而导入面板的诉求是「**切得全**」：它需要把 `（1）` 也算作可能的题目起点
 *   （有些卷子小题就用括号编号）。
 *
 *   两个目标**互相冲突**，强行合并必然牺牲一方。故保留两份，
 *   但**共用同一个 `QNO_SEP` 分隔符事实源**（全角点 `．` 不会再漏）。
 *
 * 只认「数字 + 点/顿号」，**明确排除括号**：
 *   · `1.` `2、` `3．` `3。` → 切点 ✅
 *   · `(1)` `（2）` `1）`    → 不是切点 ❌（小问）
 *
 * ⚠️ 点号后紧跟数字视为**小数**（`1.5 倍`），顿号不适用此判据。
 *    与 `@/utils/question-number` 的判据完全一致。
 */
export const MINOR_STRICT_RE = new RegExp(
  `^${SP}[0-9０-９]{1,3}${SP}(?:[.．。](?![0-9０-９])|[、])`,
)

/**
 * 一级大题号正则（用户可读、可扩展）：`一、` `第Ⅰ卷` `第1部分` `（一）` `【一】`
 */
export const MAJOR_RE = new RegExp(
  `^${SP}(?:` +
    `${CN_NUM}{1,4}${SP}[、．.。]` +                        // 一、 二． 三.
    `|第${SP}${ROMAN}{1,4}${SP}[部分卷]` +                  // 第Ⅰ卷 第1部分 第3卷
    `|[（(]${SP}${CN_NUM}{1,4}${SP}[)）]` +                 // （一）
    `|【${SP}${CN_NUM}{1,4}${SP}】` +                        // 【一】
  `)`,
)

/**
 * 行内选项正则（`A．` `B、` `C)` `D：`）。
 * 同样必须覆盖全角点 —— 真实卷是 `A．彼特拉克　B．但丁`。
 */
export const OPT_RE = /^[\s\u00a0\u3000]*[（(]?[\s\u00a0\u3000]*([A-Ha-h])[\s\u00a0\u3000]*[.．。、)）:：]/

/**
 * 答案区标题正则。
 *
 * 真实形态五花八门，实测语料里的样子：
 *   `《2026年10月4日初中历史作业》参考答案`
 *   `参考答案与试题解析`
 *   `参考答案` / `答案与解析` / `【答案】` / `答案解析`
 */
export const ANSWER_SECTION_RE =
  /^\s*(?:【\s*)?(?:参考答案|答案与解析|试题解析|答案解析|试卷解析|答案)(?:\s*】)?\s*(?:与?\s*(?:试题)?解析)?\s*$|^《[^》]{0,80}》\s*(?:参考答案|答案)/

/**
 * 把全角字符归一化为半角，**仅用于判定/匹配**（不要用它改内容）。
 *
 * 覆盖：
 *   · 全角句点 `．` → `.`（本次真凶）
 *   · 全角数字 `０-９` → `0-9`
 *   · 全角括号 `（）` → `()`
 *   · 全角冒号 `：` → `:`
 *   · 全角空格 `\u3000` → 半角空格
 *   · 中文句号 `。` → `.`（题号位）
 *
 * @param s 原文
 * @returns 归一化后的字符串（**新串**，原文不受影响）
 */
export function toHalfWidth(s: string): string {
  return String(s ?? '')
    .replace(/\uFF0E/g, '.')                       // ．全角句点
    .replace(/\u3002/g, '.')                       // 。中文句号
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // ０-９
    .replace(/\uFF08/g, '(')
    .replace(/\uFF09/g, ')')
    .replace(/\uFF1A/g, ':')
    .replace(/\u3000/g, ' ')
    .replace(/\u00a0/g, ' ')
}

/**
 * 判断一行文本是否为**题号行**（二级小题号）。
 *
 * 判定走归一化，避免再漏全角。
 */
export function isMinorHead(line: string): boolean {
  const t = toHalfWidth(String(line ?? '').replace(/<[^>]*>/g, '')).trim()
  if (!t) return false
  if (MINOR_RE.test(t)) return true
  return MAJOR_RE.test(t)
}

/** 判断一行是否为**大题号行**（一级）。 */
export function isMajorHead(line: string): boolean {
  const t = toHalfWidth(String(line ?? '').replace(/<[^>]*>/g, '')).trim()
  if (!t) return false
  return MAJOR_RE.test(t)
}

/**
 * 从一行文本里剥掉**开头**的题号（含全角变体）。
 *
 * 与 `question-number.ts` 的 `stripNumberFromText` 的区别：
 *   那个是「按全站统一口径剥（含中文大题号、第Ⅰ卷等）」，本函数是
 *   「切题后把这一行的题号前缀去掉」，语义更窄、更保守。
 *   实际使用中，组件应优先复用 `question-number.ts`；
 *   本函数用于**切分阶段**快速判断/清理。
 *
 * @param line 单行文本
 * @returns    去掉题号前缀的文本
 */
export function stripHeadNumber(line: string): string {
  let s = String(line ?? '')
  const norm = toHalfWidth(s)
  const m = norm.match(/^\s*(?:\d{1,3}\s*[.．。、)）]|\(\s*\d{1,3}\s*\)|[一二三四五六七八九十百]{1,4}\s*[、.．。])/)
  if (!m) return s
  // 按归一化长度映射回原文（归一化是等长替换，除 \u3000→' ' 外长度一致）
  s = s.slice(m[0].length).replace(/^[\s\u00a0\u3000]+/, '')
  return s
}

// ============================================================================
// 卷末答案区拆分
// ============================================================================
//
// 【背景（本次 bug 的原因之一）】
//   旧实现 `splitAnswerSection(blocks)` 只用 `ANSWER_SECTION_RE` 去匹配
//   **每个块的"第一行"**。真实卷里因为题号没识别出来，整卷被压成少数大块，
//   答案区标题「《…》参考答案」被埋在**第 235 块的中部**，首行是
//   「2026年10月4日初中历史作业」→ 永远匹配不上
//   → body 块数不变（94）、答案 0 条、详解 0 条 → 用户「答案解析填不回去」。
//
// 【修法】
//   两条检测路径并行：
//     ① 【块级】某块首行命中标题 → 从该块开始切；
//     ② 【行级】遍历**每一块的每一行**，首个命中标题的行 →
//        该块在**行内**被切成前后两半（前半归 body，后半归答案区）。
//   ②是本模块新增的关键能力，也是后面"行级分割线"的基础。
// ============================================================================

/** 一行文本（去标签后的纯文本）。 */
export interface SplitLine {
  html: string
  text: string
}

/** 答案区拆分结果（泛型适配两种不同的块结构）。 */
export interface AnswerSplitResult<T> {
  /** 正文块（不含答案区） */
  body: T[]
  /** 答案区原文（用于调试/兜底） */
  answerText: string
  /** 命中标题的行号信息（诊断用） */
  hit: { blockIndex: number; lineIndex: number } | null
}

/**
 * 在「行序列」里找答案区标题的**首个命中行**。
 *
 * @param lines      行文本（已去标签）
 * @param fromRatio  从全文的百分之多少开始找（默认 0.3，太靠前会误命中题干里的"答案"二字）
 * @returns          命中行下标；未命中返回 -1
 */
export function findAnswerTitleLine(lines: string[], fromRatio = 0.3): number {
  const start = Math.floor(lines.length * fromRatio)
  for (let i = start; i < lines.length; i++) {
    const t = toHalfWidth(lines[i] ?? '').trim()
    if (!t) continue
    if (ANSWER_SECTION_RE.test(t)) return i
    // 宽松补充：整行很短且含「参考答案」/「答案与解析」
    if (t.length <= 40 && /参考答案|答案与解析|答案解析|试卷解析/.test(t)) return i
  }
  return -1
}

/**
 * 从「块数组」里拆出卷末答案区（**行级检测版**）。
 *
 * @param blocks      块数组
 * @param getText     取某块的纯文本（多行用 `\n` 分隔）
 * @param getHtml     取某块的 HTML（可选，用于块内二次切分）
 * @param splitBlock  把一块按「行下标」在内部切成两半（可选）。
 *                    提供时才能处理"标题在块中部"的情况；不提供则退化为块级切分。
 * @returns           正文与答案区的拆分结果
 */
export function splitAnswerSectionEx<T>(
  blocks: T[],
  getText: (b: T) => string,
  getHtml?: (b: T) => string,
  splitBlock?: (b: T, lineIndex: number) => { before: T; after: T } | null,
): AnswerSplitResult<T> {
  if (!blocks.length) return { body: blocks.slice(), answerText: '', hit: null }

  // 【路径①-行级】逐块逐行找标题
  for (let bi = Math.floor(blocks.length * 0.3); bi < blocks.length; bi++) {
    const text = String(getText(blocks[bi]) ?? '')
    const lines = text.split(/\n+/)
    // 单行块或首行命中 → 从该块整块切
    for (let li = 0; li < lines.length; li++) {
      const t = toHalfWidth(lines[li]).trim()
      if (!t) continue
      const isTitle = ANSWER_SECTION_RE.test(t) || (t.length <= 40 && /参考答案|答案与解析|答案解析|试卷解析/.test(t))
      if (!isTitle) continue

      // 命中。若就在块首 → 整块归答案区
      if (li === 0) {
        return {
          body: blocks.slice(0, bi),
          answerText: lines.join('\n'),
          hit: { blockIndex: bi, lineIndex: 0 },
        }
      }
      // 在块中部 → 尝试块内二次切分
      if (getHtml && splitBlock) {
        const parts = splitBlock(blocks[bi], li)
        if (parts) {
          return {
            body: [...blocks.slice(0, bi), parts.before],
            answerText: lines.slice(li).join('\n'),
            hit: { blockIndex: bi, lineIndex: li },
          }
        }
      }
      // 无法块内切分 → 整块归答案区（宁可多切，不可漏切答案）
      return {
        body: blocks.slice(0, bi),
        answerText: lines.join('\n'),
        hit: { blockIndex: bi, lineIndex: li },
      }
    }
  }

  return { body: blocks.slice(), answerText: '', hit: null }
}

// ============================================================================
// 答题卡表格 → 题号/答案 映射
// ============================================================================
//
// 【背景（用户诉求）】「解析后剔除，答案回填到各题」
//
// 真实卷的答题卡是**一张 HTML 表格**：
//   <table>
//     <tr><td>题号</td><td>1</td>…<td>10</td></tr>
//     <tr><td>答案</td><td>B</td>…<td>C</td></tr>
//     <tr><td>题号</td><td>11</td>…<td>20</td></tr>
//     <tr><td>答案</td><td>D</td>…<td>B</td></tr>
//   </table>
// 旧实现把整张表 `el.outerHTML` 当成**一个不可分割的块**，既不参与切分，
// 也解析不出 `题号↔答案` 的配对 → 用户「答案填不回去」。
//
// 【解析策略】
//   把表格按行读成二维文本，逐行判断：
//     · 行首是「题号」→ 记下这一行后续单元格的数字列表
//     · 行首是「答案」→ 与最近一次「题号」行的数字配对
//   支持多组（题号行/答案行 交替出现），也支持单行合并的形态。
// ============================================================================

/** 答题卡解析结果。 */
export interface AnswerCard {
  /** 题号 → 答案，如 `1 → 'B'` */
  map: Map<number, string>
  /** 是否真的解析到内容 */
  ok: boolean
}

/** 去掉单元格里的 HTML 与空白。 */
function cellText(s: string): string {
  return toHalfWidth(String(s ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, '')
    .trim()
}

/**
 * 从一张表格的 HTML 里解析答题卡。
 *
 * @param tableHtml `<table>…</table>` 的外层 HTML
 * @returns         题号→答案 映射
 */
export function parseAnswerCard(tableHtml: string): AnswerCard {
  const map = new Map<number, string>()
  const html = String(tableHtml ?? '')
  if (!/<table/i.test(html)) return { map, ok: false }

  // 按 <tr> 切行（不依赖 DOMParser，两端环境都能跑）
  const rows = html.split(/<tr[^>]*>/i).slice(1)
  let pendingNums: number[] | null = null

  for (const row of rows) {
    const cells = row
      .split(/<t[dh][^>]*>/i)
      .slice(1)
      .map((c) => cellText(c.split(/<\/t[dh]>/i)[0] ?? c))
    if (!cells.length) continue

    const head = cells[0] ?? ''
    const rest = cells.slice(1)

    // 「题号」行 → 收集数字
    if (/^题号$/.test(head) || /^题号/.test(head)) {
      pendingNums = rest
        .map((c) => {
          const m = c.match(/\d{1,3}/)
          return m ? Number(m[0]) : NaN
        })
        .filter((n) => Number.isFinite(n))
      continue
    }

    // 「答案」行 → 与最近的题号行配对
    if (/^答案$/.test(head) || /^答案/.test(head)) {
      const vals = rest
      if (pendingNums && pendingNums.length) {
        for (let i = 0; i < pendingNums.length; i++) {
          const v = (vals[i] ?? '').trim()
          if (pendingNums[i] && v) map.set(pendingNums[i], v.toUpperCase())
        }
      }
      // 不立刻清空 pendingNums：允许「题号|答案|题号|答案」交错，也允许
      // 一行答案跟在多行题号后（少见，保守处理）
      continue
    }

    // 头格既不是题号也不是答案 → 可能是「1|2|3…」数字行紧跟「B|C|A…」值行
    const allNum = cells.length >= 3 && cells.every((c) => /^\d{1,3}$/.test(c))
    if (allNum) {
      pendingNums = cells.map((c) => Number(c))
      continue
    }
    const allAns = cells.length >= 3 && cells.every((c) => /^[A-Ha-h√×对错TF]{1,2}$/.test(c))
    if (allAns && pendingNums && pendingNums.length === cells.length) {
      cells.forEach((v, i) => {
        if (pendingNums && pendingNums[i]) map.set(pendingNums[i], v.toUpperCase())
      })
      continue
    }
  }

  // 兜底：整张表里出现「1 B」「1.B」这类相邻配对
  if (map.size === 0) {
    const flat = html
      .split(/<\/t[dh]>/i)
      .map((c) => cellText(c.replace(/^[\s\S]*?>/, '')))
      .filter(Boolean)
    for (let i = 0; i + 1 < flat.length; i++) {
      if (/^\d{1,3}$/.test(flat[i]) && /^[A-Ha-h√×]{1,2}$/.test(flat[i + 1])) {
        map.set(Number(flat[i]), flat[i + 1].toUpperCase())
      }
    }
  }

  return { map, ok: map.size > 0 }
}

/**
 * 卷末「1．B  【详解】…」答案文本 → 题号→答案 / 题号→详解。
 *
 * 真实卷形态：
 *   `1．B`                    一行一题
 *   `6．D    7．A`            一行多题（tab 或空格分隔）
 *   `【详解】A.彼特拉克…错误。`  详解另起
 *
 * @param text 答案区纯文本（多行 `\n` 分隔）
 * @returns    `{ answers, analyses }`
 */
export function parseTailAnswerText(text: string): {
  answers: Map<number, string>
  analyses: Map<number, string>
} {
  const answers = new Map<number, string>()
  const analyses = new Map<number, string>()
  const lines = String(text ?? '').split(/\n+/)
  let cur = 0
  let buf: string[] = []

  const flush = () => {
    if (cur && buf.length) {
      const s = buf.join('\n').trim()
      if (s) analyses.set(cur, s)
    }
    buf = []
  }

  for (const raw of lines) {
    const line = toHalfWidth(raw).trim()
    if (!line) continue
    // 一行可能有多个「题号+答案」对：`6．D    7．A`
    const pairs = [...line.matchAll(/(\d{1,3})\s*[.．。、)）]\s*([A-Ha-h√×]|[对错TF])(?![A-Za-z0-9])/g)]
    const hasDetail = /【详解】|【解析】|详解[:：]|解析[:：]/.test(line)

    if (pairs.length && !hasDetail) {
      flush()
      for (const p of pairs) {
        const n = Number(p[1])
        answers.set(n, p[2].toUpperCase())
        cur = n
      }
      continue
    }
    // 详解行归属最近的题号
    if (!cur) {
      // 详解前可能有「1．【详解】」形态
      const m = line.match(/^(\d{1,3})\s*[.．。、)）]/)
      if (m) cur = Number(m[1])
    }
    if (hasDetail || /^\d{1,3}\s*[.．。、)）]/.test(line)) {
      buf.push(line.replace(/^\d{1,3}\s*[.．。、)）]\s*/, ''))
    } else if (cur) {
      buf.push(line)
    }
  }
  flush()
  return { answers, analyses }
}

// ============================================================================
// 自检用例（供探针与开发期快速回归）
// ============================================================================

/** 题号识别用例：`[输入行, 是否题号]`。 */
export const HEAD_CASES: [string, boolean][] = [
  // —— 应识别为题号 ——
  ['1．他是文艺复兴运动的先驱', true],        // ← 全角句点（真凶）
  ['1. 下列说法正确的是', true],
  ['1、已知集合', true],
  ['12．计算', true],
  ['１．全角数字题号', true],
  ['(1)若 x>0', true],
  ['（1）求导', true],
  ['一、单选题', true],
  ['二、综合题', true],
  ['第Ⅰ卷', true],
  ['第1部分 选择题', true],
  // —— 不应识别为题号 ——
  ['A．彼特拉克', false],
  ['求函数 f(x)=x²-2x 的最小值', false],
  ['1.5 倍的增长', false],
  ['2020年的数据', false],
  ['【详解】A.彼特拉克…错误。', false],
]
