// ============================================================================
// v4.13.0 AI 试卷识别适配层
// ============================================================================
//
// 【为什么需要这个文件】
//   Word 试卷导入的「自动切割 + 读取答案/解析」原来是**纯正则启发式**，
//   容错极低：题号格式一变就切不出、答案只在行内紧邻才认、
//   卷末「参考答案」区块完全关联不上、解析字段常年为空。
//
//   本模块把「题目结构识别」交给大模型，正则只作为**降级兜底**。
//
// 【双通道设计 —— v4.13.0 从 Gemini 迁移到 Cloudflare Workers AI】
//
//   v4.12.0 原本用 Google Gemini，但它要求用户自己去 AI Studio 申请 API Key，
//   中国用户申请困难（需科学上网 + 海外手机号）。用户明确否决。
//
//   现改为：
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ 通道 A：Cloudflare Workers AI（**默认主力，零配置**）                 │
//   │   · 走 Worker 原生绑定 env.AI，**完全不需要 API Key**                 │
//   │   · 免费额度：每天 10000 神经元（无需信用卡）                          │
//   │   · 主力模型 @cf/meta/llama-4-scout-17b-16e-instruct                  │
//   │     （**Llama 4 Scout**：Meta 最新架构、免费、131K 上下文、原生多模态）│
//   │   · 备用模型 @cf/qwen/qwen3-30b-a3b-fp8                               │
//   │     （**Qwen3** 新模型、免费、中文与 JSON 结构化输出最强）            │
//   │   · 两者都位于 Workers AI 免费档，长卷切块并行也不会触发付费           │
//   ├──────────────────────────────────────────────────────────────────────┤
//   │ 通道 B：智谱开放平台 GLM（可选，超级管理员在后台填 Key）              │
//   │   · 国内直连、中文强、glm-4-flash 免费                                │
//   │   · Key 存在 D1 settings 表（key='ai_config'），超管在管理界面配置     │
//   └──────────────────────────────────────────────────────────────────────┘
//
//   优先级由 AI_PROVIDER 决定（cf / zhipu / auto）。
//   auto 模式：先试 CF Workers AI，失败（超限/网络/模型不可用）自动切智谱。
//   两通道都不可用时**返回空结果**，由调用方回落到正则 —— 保证功能永不中断。
//
// 【安全】任何密钥都不写入本文件、不进 git、不进日志（错误信息里也不回显）。
// ============================================================================

/** 统一的环境变量读取（Worker 的 c.env / 本地 process.env 都能用） */
export interface AiEnv {
  /**
   * Cloudflare Workers AI 绑定（`env.AI`）。
   *
   * 有它就能免密钥调用 Workers AI；没有则通道 A 不可用（本地开发时没有）。
   * 类型刻意写成宽松的 `AiBindingLike` —— 避免为一个 binding 引入 @cloudflare/workers-types 依赖。
   */
  AI?: AiBindingLike
  /** 智谱开放平台 Key（超管在后台填，或从环境变量读） */
  ZHIPU_API_KEY?: string
  /** 服务商优先级：cf | zhipu | auto（默认 auto） */
  AI_PROVIDER?: string
  /** 通道 A 主力模型，默认 @cf/zai-org/glm-4.7-flash */
  AI_MODEL_CF?: string
  /** 通道 A 备用模型，默认 @cf/meta/llama-3.3-70b-instruct-fp8-fast */
  AI_MODEL_CF_FALLBACK?: string
  /** 通道 B 模型，默认 glm-4-flash */
  AI_MODEL_ZHIPU?: string
  /** 仅用于测试：把请求指向本地 mock 服务（生产不设） */
  AI_BASE_CF?: string
  AI_BASE_ZHIPU?: string
}

/**
 * Workers AI 绑定的最小结构。
 *
 * 只声明我们真正用到的方法，避免依赖 `@cloudflare/workers-types`。
 * 真实绑定的 `run()` 会返回模型原始响应（这里用 any，因为各模型结构不同）。
 */
export interface AiBindingLike {
  run(model: string, inputs: any): Promise<any>
}

/** 识别出的单道题（两通道归一后的统一结构） */
export interface AiQuestion {
  qtype: 'single' | 'multiple' | 'judge' | 'fill' | 'subjective'
  content: string          // 题干（Markdown，不含选项）
  options: string[]        // 选项文本（不含 A. 前缀）
  answer: string
  analysis: string
  score: number
  /** 该题在原文中的起始特征（用于前端定位校对） */
  anchor?: string
}

export interface AiParseResult {
  questions: AiQuestion[]
  provider: string         // 实际生效的服务名
  model: string
  /** 尝试过的服务与失败原因（便于排查与前端提示） */
  attempts: { provider: string; error?: string }[]
  usage?: { promptTokens?: number; completionTokens?: number; neurons?: number }
  /**
   * 【v4.13.1】图片占位符 → 原图 src 映射（键为 `图1` `图2`…）。
   *
   * 入参是 HTML 时，`<img>` 被替换成 `[图N]` 送进模型（模型不可能"看见"图片二进制）。
   * 模型会把 `[图N]` 原样写进题干的 `content`，前端拿这个映射把 src 换成真正的
   * `<img>` 标签 —— 这就是「切完之后图片不会没」的闭环。
   */
  images?: Record<string, string>
}

// ---------------------------------------------------------------------------
// 默认模型常量（后端与前端设置页共用，避免两处写死不一致）
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_CF = '@cf/meta/llama-4-scout-17b-16e-instruct'
export const DEFAULT_MODEL_CF_FALLBACK = '@cf/qwen/qwen3-30b-a3b-fp8'
export const DEFAULT_MODEL_ZHIPU = 'glm-4-flash'

/** 候选模型清单（供管理后台下拉选择，均位于 Workers AI 免费档内） */
export const CF_MODEL_CHOICES = [
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama-4-Scout-17B（Meta 最新 · 免费 · 多模态）' },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3-30B-A3B（通义新模型 · 免费 · 中文/JSON 强）' },
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7-Flash（智谱 · 中文强 · 最省）' },
  { id: '@cf/zai-org/glm-5.3-flash', label: 'GLM-5.3-Flash（智谱新模型 · 免费）' },
  { id: '@cf/qwen/qwq-32b', label: 'QwQ-32B（推理强 · 免费）' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek-R1-Distill-32B（推理强 · 免费）' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral-Small-3.1-24B（免费）' },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma-4-26B（Google · 256K 上下文 · 免费）' },
] as const

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 【v4.13.1】HTML → 结构化文本：保住表格与图片
// ---------------------------------------------------------------------------
//
// 【为什么需要】
//   v4.13.0 送 AI 的是**纯文本**（`blocks.map(b => b.text)`），由此两条血管被切断：
//     · 表格：`toText()` 把 `<td>` 全拍平成一行，行列结构彻底消失
//       → 「根据下表数据求……」这类题 AI 必然答错
//     · 图片：`<img>` 的 textContent 是空串 → 被 `.filter(Boolean)` 过滤
//       → **整块消失，图片位置无迹可寻**
//   用户原话：「遇到表格 图片之类的 AI 就不识别，直接吞了」。
//
// 【修法】
//   在送 AI 之前把 HTML 转成**带结构标记的文本**：
//     · `<table>` → Markdown 表格（行列关系完整保留）
//     · `<img>`   → `[图N]` 占位符（N 从 1 递增）
//   并把这些占位符的原图 src 一并交给调用方（`images` 字段），
//   供 AI 识别完成后**回填**到题目里 —— 这样「切完之后东西不会没」。
//
// 【为什么用 Markdown 表格而不是 HTML 表格】
//   实测 glm-4.7-flash 读 Markdown 表格的准确率明显更高，
//   且 token 开销远小于 HTML（`<td></td>` 的标签本身很占位置）。
// ---------------------------------------------------------------------------

/** HTML → 结构化文本的结果 */
export interface StructuredText {
  /** 转好的文本（表格已 Markdown 化、图片已占位符化） */
  text: string
  /**
   * 图片占位符 → 原图 src 的映射（键为 `图1` `图2`… 不含方括号）。
   * 调用方拿它把图片回填到 AI 返回的题目里。
   */
  images: Record<string, string>
}

/** 解 HTML 实体（只处理常见的，够用且不引入依赖） */
function decodeEntities(s: string): string {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** 去掉标签取纯文本（单元格用） */
function cellText(html: string): string {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
  ).replace(/[\s\u00a0\u3000]+/g, ' ').trim()
}

/**
 * 把一个 `<table>` 元素转成 Markdown 表格。
 *
 * 处理要点：
 *  · `<br>` → 空格（单元格内换行会破坏 Markdown 表格结构）
 *  · `|` → 转义成 `\|`（否则会被当成列分隔符）
 *  · 合并单元格（colspan/rowspan）→ 重复占位，保证每行列数对齐
 *    （不完全等价于原表格，但比"整张表拍平"强太多）
 *  · 没有 `<thead>` 时把第一行当表头
 */
function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (!rows.length) return ''

  const grid: string[][] = []
  rows.forEach(tr => {
    const cells = Array.from(tr.querySelectorAll('th,td'))
    const line: string[] = []
    cells.forEach(td => {
      const t = cellText(td.innerHTML).replace(/\|/g, '\\|')
      // colspan：按跨度重复填，保持列数对齐
      const span = Math.max(1, Math.min(20, parseInt(td.getAttribute('colspan') || '1', 10) || 1))
      for (let i = 0; i < span; i++) line.push(i === 0 ? t : '')
    })
    if (line.length) grid.push(line)
  })
  if (!grid.length) return ''

  const cols = Math.max(...grid.map(r => r.length))
  const pad = (r: string[]) => {
    const c = r.slice()
    while (c.length < cols) c.push('')
    return c
  }

  const head = pad(grid[0])
  const body = grid.slice(1).map(pad)
  const out: string[] = []
  out.push(`| ${head.join(' | ')} |`)
  out.push(`|${head.map(() => ' --- ').join('|')}|`)
  body.forEach(r => out.push(`| ${r.join(' | ')} |`))
  return out.join('\n')
}

/**
 * HTML → 结构化文本（**表格保结构、图片保位置**）。
 *
 * @param html      试卷 HTML 片段（来自 mammoth）
 * @param startIdx  图片编号起始值（分块调用时保持全局递增，避免每块都从「图1」开始）
 * @returns         结构化文本 + 图片映射
 */
export function htmlToStructuredText(html: string, startIdx = 1): StructuredText {
  const src = String(html ?? '')
  if (!src.trim()) return { text: '', images: {} }

  // 无 DOM 环境（如纯 Node 探测脚本）走正则路径 —— 行为与 DOM 路径保持一致
  const hasDom = typeof DOMParser !== 'undefined'

  if (!hasDom) {
    const images: Record<string, string> = {}
    let n = startIdx
    let out = src
      // 表格：正则版较粗糙（无法完美处理嵌套），但保住"行"的边界
      .replace(/<table[\s\S]*?<\/table>/gi, (tbl) => {
        const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        const grid = rows.map(r =>
          [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => cellText(c[1]).replace(/\|/g, '\\|'))
        ).filter(r => r.length)
        if (!grid.length) return ''
        const cols = Math.max(...grid.map(r => r.length))
        const pad = (r: string[]) => { const c = r.slice(); while (c.length < cols) c.push(''); return c }
        const head = pad(grid[0])
        const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`]
        grid.slice(1).forEach(r => lines.push(`| ${pad(r).join(' | ')} |`))
        return `\n${lines.join('\n')}\n`
      })
      .replace(/<img[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, s) => {
        const key = `图${n++}`
        images[key] = decodeEntities(s)
        return `[${key}]`
      })
      .replace(/<img[^>]*>/gi, () => { const key = `图${n++}`; images[key] = ''; return `[${key}]` })
      .replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      // 数学不等号保护：只删「合法标签」，避免把 `x < 3` 的 `< 3 ...` 当标签删掉
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    out = decodeEntities(out).replace(/\n{2,}/g, '\n').trim()
    return { text: out, images }
  }

  // 【v4.13.1 修正】DOMParser 会把数学不等号当标签吃掉。
  //
  // 实测：`1. 纯文本题目 x < 3 且 y > 2` 经 DOMParser 后变成 `1. 纯文本题目 x  2`
  // —— `DOMParser` 把 `< 3 且 y >` 当成了一个畸形标签。
  // 这在数学/物理卷里极常见（"x < 3"、"a > b"、"＜"），不修会**静默吞掉题干内容**。
  //
  // 修法：解析前把「不是合法标签开头的 `<`」转义成 `&lt;`。
  //   · 合法开头 = `<标签名` / `</标签名` / `<!--`
  //   · 其余（如 `< 3`、`<3`）→ 转义，避免被当标签
  const safeSrc = String(src).replace(/<(?![a-zA-Z/!])/g, '&lt;')
  const doc = new DOMParser().parseFromString(`<div id="__root">${safeSrc}</div>`, 'text/html')
  const root = doc.getElementById('__root')
  if (!root) return { text: cellText(src), images: {} }

  const images: Record<string, string> = {}
  let n = startIdx

  // ① 先处理表格：整体替换成 Markdown（必须在遍历文本之前做，否则行列关系已丢失）
  Array.from(root.querySelectorAll('table')).forEach(tbl => {
    const md = tableToMarkdown(tbl)
    const holder = doc.createElement('div')
    holder.textContent = md ? `\n${md}\n` : ''
    tbl.replaceWith(holder)
  })

  // ② 图片 → 占位符
  Array.from(root.querySelectorAll('img')).forEach(img => {
    const key = `图${n++}`
    images[key] = img.getAttribute('src') || ''
    img.replaceWith(doc.createTextNode(`[${key}]`))
  })

  // ③ 块级元素补换行后取文本
  const text = decodeEntities(
    String(root.innerHTML || '')
      .replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

  return { text, images }
}

/**
 * 系统提示词。
 *
 * 设计要点（每一条都是为了让模型**稳定输出可解析的 JSON**）：
 *  1. 明确"只输出 JSON、不要任何解释/代码块标记"——否则模型爱加 ```json ```
 *  2. **字段名用英文并在 prompt 里显式给出完整 JSON 骨架** —— 实测 glm-4.7-flash
 *     会根据 prompt 语言自动切换键名（曾输出「题目/选项/答案/解析」），
 *     把骨架写死能大幅降低漂移率（normalizeQuestions 仍有中文键兜底）。
 *  3. 明确选项**不带字母前缀**、且**必须是字符串数组**（不是对象）——
 *     实测模型爱输出 {"A":"...","B":"..."}，这里双重防御。
 *  4. 强调"卷末的参考答案/解析要**回填到对应题目**"——这是原正则最做不到的
 *  5. 强调"题干里不要包含选项、答案、解析"——避免内容重复输出
 *  6. 强调"忽略试卷标题、姓名班级栏"——否则会被当成题目输出
 */
const SYSTEM_PROMPT = `你是一名资深中小学试卷排版工程师，擅长把杂乱的 Word 试卷文本拆解成结构化试题。

【任务】读取用户给出的试卷原文，输出严格 JSON（不要任何解释文字，不要 markdown 代码块标记）。

【输出格式】必须严格使用下列英文键名，不要翻译成中文：
{
  "questions": [
    {
      "qtype": "single|multiple|judge|fill|subjective",
      "content": "题干原文（保留填空下划线、公式、图片占位）",
      "options": ["选项1文本", "选项2文本"],
      "answer": "参考答案",
      "analysis": "答案解析/详解",
      "score": 5,
      "anchor": "题干开头 10~20 字，用于在原文中定位"
    }
  ]
}

【关键规则】
1. 题型判定：
   - single 单选（只有一个正确选项）
   - multiple 多选（多个正确选项，或标注"多选/多项"）
   - judge 判断（答案为 对/错/正确/错误/√/×/T/F）
   - fill 填空（题干含下划线/括号待填）
   - subjective 主观题/解答题/作文
2. options **必须是字符串数组**，不要写成 {"A":"...","B":"..."} 对象；
   且**不要带 "A." "B." 等字母前缀**，只要选项内容本身。
3. content 里**不要包含**选项、答案、解析——它们各有专门字段，重复会导致导出时内容出现两遍。
4. 卷末如果有独立的「参考答案」「答案与解析」「详解」区块，**必须回填到对应题目**。
   常见格式：「1-5 BCDAC」「一、1.A 2.C 3.B」「1.【答案】A 【解析】……」
5. 如果某题没有答案或解析，对应字段填空字符串 ""，**不要编造**。
6. score 无法判断时给 5。
7. 原文中的试卷标题、考试说明、姓名班级栏、页码等**非题目内容一律忽略**，不要输出成题目。
8. 保留题干中的公式（LaTeX 用 $...$ 包裹）。
9. **表格**：原文里已是 Markdown 表格（\`| 列1 | 列2 |\`）。它属于**它前面那道题**的题干，
   必须**原样复制进 content 字段**（连同表头与分隔行），**不许省略、不许改写成一句话概括**。
   若题干依赖表格数据（如"根据下表求…"），表格缺失会导致整题无法作答。
10. **图片**：原文里以 \`[图1]\` \`[图2]\` 这样的占位符出现。它同样属于**它前面那道题**，
   必须**原样保留在 content 中**（位置也不要挪动），**绝对不要删除、不要翻译、不要改成"（见图）"**。
   占位符只是图片的代号，原图会由系统自动回填。`

// ---------------------------------------------------------------------------
// 通用：从模型输出里稳健地抠出 JSON
// ---------------------------------------------------------------------------

/**
 * 模型输出 JSON 的**容错解析**。
 *
 * 实测模型常见三种"不听话"：
 *   ① 用 ```json ... ``` 包起来（哪怕明确说了不要）
 *   ② 前后带一句"好的，以下是解析结果："
 *   ③ 末尾多一个逗号，或用了中文引号
 * 这里逐一容错，避免因为一个反引号就让整个功能失败。
 */
export function extractJson(text: string): any | null {
  if (!text) return null
  let s = String(text).trim()

  // ① 剥掉 markdown 代码块围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()

  // ② 截取第一个 { 到最后一个 } （丢掉前后寒暄）
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first > -1 && last > first) s = s.slice(first, last + 1)

  const tryParse = (str: string) => { try { return JSON.parse(str) } catch { return null } }
  let out = tryParse(s)
  if (out) return out

  // ③ 去尾逗号
  out = tryParse(s.replace(/,\s*([}\]])/g, '$1'))
  if (out) return out

  // ④ 中文引号替换再试
  out = tryParse(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'))
  return out || null
}

/**
 * 取字段值时**同时认英文键与中文键**。
 *
 * 实测 @cf/zai-org/glm-4.7-flash 会根据输入语言漂移键名：
 * 中文 prompt 下曾输出 `{"题目":"...","选项":[...],"答案":"B","解析":"..."}`。
 * 与其反复调 prompt（模型不一定听话），不如在归一化层把两种键都认了。
 */
function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return undefined
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
  }
  return undefined
}

/**
 * 把模型给的 options 归一为**纯字符串数组**。
 *
 * 实测三种形态都要接：
 *   ① ["y=-x", "y=x²"]                        —— 正常数组
 *   ② { "A": "y=-x", "B": "y=x²" }            —— 对象（glm-4.7-flash 常用）
 *   ③ [{ "选项": "A", "内容": "y=-x" }, ...]  —— 对象数组（同样是 glm 的变体）
 *
 * 统一剥掉可能残留的 "A." / "A、" / "(A)" 前缀。
 */
export function normalizeOptions(raw: any): string[] {
  const strip = (s: string) =>
    String(s ?? '').replace(/^\s*[(（]?\s*[A-Ha-h]\s*[.、)）．:：]\s*/, '').trim()

  if (Array.isArray(raw)) {
    return raw
      .map((o: any) => {
        if (typeof o === 'string') return strip(o)
        if (o && typeof o === 'object') {
          // 形态③：{选项, 内容} / {label, text} / {key, value}
          const text = pick(o, ['内容', 'text', 'value', 'option', 'content', 'label'])
          return strip(String(text ?? ''))
        }
        return ''
      })
      .filter(Boolean)
  }

  if (raw && typeof raw === 'object') {
    // 形态②：键即字母序，按 A→H 排序保证顺序稳定（对象键序不保证）
    return Object.keys(raw)
      .sort((a, b) => a.localeCompare(b))
      .map(k => strip(String(raw[k] ?? '')))
      .filter(Boolean)
  }

  return []
}

/** 把模型返回的原始条目归一成 AiQuestion（字段缺失/类型错误都不抛） */
export function normalizeQuestions(raw: any): AiQuestion[] {
  const list = Array.isArray(raw?.questions) ? raw.questions
    : Array.isArray(raw?.题目) ? raw.题目
      : (Array.isArray(raw) ? raw : [])
  const QTYPES = ['single', 'multiple', 'judge', 'fill', 'subjective']
  const out: AiQuestion[] = []
  for (const q of list) {
    if (!q || typeof q !== 'object') continue
    const content = String(pick(q, ['content', 'stem', 'question', '题干', '题目', '题目内容']) ?? '').trim()
    if (!content) continue

    const options = normalizeOptions(pick(q, ['options', 'choices', '选项']))

    let qtype = String(pick(q, ['qtype', 'type', '题型', '类型']) ?? '').toLowerCase().trim()
    if (!QTYPES.includes(qtype)) {
      // 模型给中文题型 → 映射。
      // 注意：模型常输出带「题」字后缀（多选**题** / 单项选择**题** / 计算**题**），
      // 所以查表前先剥掉尾部「题」字，避免 "多选题" 漏配而误判为单选。
      const map: Record<string, string> = {
        '单选': 'single', '单项选择': 'single', '单一选择': 'single', '选择题': 'single', '单项': 'single',
        '多选': 'multiple', '多项选择': 'multiple', '多项选择题': 'multiple', '不定项': 'multiple', '不定项选择': 'multiple',
        '判断': 'judge', '判断题': 'judge', '是非': 'judge', '正误': 'judge',
        '填空': 'fill', '填空题': 'fill',
        '解答': 'subjective', '主观': 'subjective', '主观题': 'subjective', '简答': 'subjective',
        '计算': 'subjective', '作图': 'subjective', '证明': 'subjective', '实验': 'subjective',
        '作文': 'subjective', '论述': 'subjective', '综合': 'subjective', '应用': 'subjective',
      }
      const bare = qtype.replace(/题$/u, '')          // 「多选题」→「多选」
      const hit = map[qtype] ?? map[bare]
      qtype = hit || (options.length >= 2 ? 'single' : 'subjective')
    }
    const score = Number(pick(q, ['score', 'points', '分值']) ?? 5)
    out.push({
      qtype: qtype as AiQuestion['qtype'],
      content,
      options,
      answer: String(pick(q, ['answer', 'correct', '答案', '参考答案']) ?? '').trim(),
      analysis: String(pick(q, ['analysis', 'explanation', 'solution', '解析', '详解', '答案解析']) ?? '').trim(),
      score: Number.isFinite(score) && score > 0 ? score : 5,
      anchor: String(pick(q, ['anchor', '定位']) ?? '').trim() || undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 通道 A：Cloudflare Workers AI
// ---------------------------------------------------------------------------

/**
 * 调 Cloudflare Workers AI 跑一次结构化抽取。
 *
 * 【两条调用路径，按可用性自动选】
 *   ① **绑定路径（生产首选）**：env.AI.run() —— 零密钥、零网络配置；
 *   ② **REST 路径（本地开发/探针）**：fetch 到 CF 的 OpenAI 兼容端点。
 *      本地 `server/index.ts` 没有 Worker binding，只能走这条；
 *      探针则用 AI_BASE_CF 指向本地 mock。
 *
 * 【为什么要 chat_template_kwargs.enable_thinking=false】
 *   实测 glm-4.7-flash / qwen3 默认会把大段思维链塞进 `reasoning` 字段，
 *   单题就烧掉 1000+ token（神经元消耗翻数倍）。关掉后 reasoning 归零，
 *   而 `content` 里的最终 JSON 完全不受影响。
 */
async function callCfAi(env: AiEnv, model: string, paperText: string, timeoutMs: number): Promise<{ raw: any; usage: any }> {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `【试卷原文】\n${paperText}` },
  ]
  const payload: any = {
    messages,
    temperature: 0.1,      // 结构化抽取任务，温度越低越稳
    max_tokens: 8192,
  }
  // 仅 GLM / Qwen3 / DeepSeek / QwQ 等「默认会吐思维链」的模型关掉 thinking，省 token；
  // Llama-4 等无 thinking 模式的模型传这个 kwarg 可能报错，故按模型名选择性添加。
  if (/glm|qwen|deepseek|qwq/i.test(model)) {
    payload.chat_template_kwargs = { enable_thinking: false }
  }

  // ① 绑定路径（生产首选：零密钥、不经过公网）
  //   注意：只要配了 AI_BASE_CF（测试用），就强制走 REST —— 否则探针无法拦截请求。
  if (env.AI && typeof env.AI.run === 'function' && !env.AI_BASE_CF) {
    const j = await withTimeout(env.AI.run(model, payload), timeoutMs)
    return readChatCompletion(j)
  }

  // ② REST 路径（本地开发 / 探针）
  //   【为什么 base 只替换 host，而不含 accounts 段】
  //     AI_BASE_CF 的语义是"把请求指向另一个主机"（本地 mock 或代理），
  //     而 `/accounts/{id}/ai/run/` 是 CF 的固定路径结构。
  //     早期实现把两者混在一起（有 AI_BASE_CF 就整个丢掉 accounts 段），
  //     导致本地想直连真实 CF API 时 URL 拼错 —— 探针实测抓到过。
  const base = (env.AI_BASE_CF || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')
  const accountId = readGlobal('__CF_ACCOUNT_ID')
  const token = readGlobal('__CF_API_TOKEN')
  if (!accountId || !token) {
    throw new Error('本地未配置 CF_ACCOUNT_ID / CF_API_TOKEN，Cloudflare Workers AI 通道不可用')
  }
  const url = `${base}/accounts/${accountId}/ai/run/${model}`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) throw new Error(`CF Workers AI HTTP ${res.status}: ${text.slice(0, 180)}`)
    let j: any
    try { j = JSON.parse(text) } catch { throw new Error(`CF Workers AI 返回非 JSON: ${text.slice(0, 120)}`) }
    return readChatCompletion(j)
  } finally {
    clearTimeout(timer)
  }
}

/** 读全局注入（本地后端用 process.env，Worker 用绑定；这里统一走 globalThis 以免引 process 类型） */
function readGlobal(k: string): string | undefined {
  return (globalThis as any)[k]
}

/** 轻量 sleep（用于 429 退避） */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** 命中频率限制 / 过载类错误（这类错误退避后重试常能成功） */
function isRateLimit(e: any): boolean {
  return /429|频率限制|rate.?limit|too many requests|overloaded|负载|capacity/i.test(String(e?.message || e))
}

/**
 * 从 CF Workers AI 的响应里取出正文与用量。
 *
 * CF 有两种响应外壳，都要接：
 *   · 绑定路径 / OpenAI 兼容端点 → `{ choices: [{ message: { content } }], usage }`
 *   · 少数模型的旧式端点 →        `{ response: "..." }`
 * 另外 REST 路径的响应外面还套一层 `{ result: ... }`。
 */
function readChatCompletion(j: any): { raw: any; usage: any } {
  const payload = j?.result ?? j
  const content =
    payload?.choices?.[0]?.message?.content ??
    payload?.response ??
    ''
  return {
    raw: extractJson(typeof content === 'string' ? content : JSON.stringify(content)),
    usage: payload?.usage,
  }
}

// ---------------------------------------------------------------------------
// 通道 B：智谱开放平台 GLM（OpenAI 兼容协议）
// ---------------------------------------------------------------------------

async function callZhipu(env: AiEnv, paperText: string, timeoutMs: number): Promise<{ raw: any; usage: any }> {
  const key = env.ZHIPU_API_KEY
  if (!key) throw new Error('未配置智谱 API Key')
  const model = env.AI_MODEL_ZHIPU || DEFAULT_MODEL_ZHIPU
  // 【可测】base 可被 AI_BASE_ZHIPU 覆盖，便于探针指向本地 mock。
  const base = (env.AI_BASE_ZHIPU || 'https://open.bigmodel.cn').replace(/\/+$/, '')
  const url = `${base}/api/paas/v4/chat/completions`

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `【试卷原文】\n${paperText}` },
    ],
    temperature: 0.1,
    max_tokens: 8192,
    // 智谱支持 json_object（部分模型），失败时靠 extractJson 容错
    response_format: { type: 'json_object' },
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`智谱 HTTP ${res.status}: ${t.slice(0, 180)}`)
    }
    const j: any = await res.json()
    const text = j?.choices?.[0]?.message?.content || ''
    return { raw: extractJson(text), usage: j?.usage }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 给任意 Promise 加超时（binding 路径用，因为 env.AI.run 不吃 AbortSignal） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`调用超时（${ms}ms）`)), ms)
    p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
  })
}

// ---------------------------------------------------------------------------
// 对外主入口
// ---------------------------------------------------------------------------

/**
 * 把整卷切成适合单次模型调用的小块。
 *
 * 【为什么切块】
 *   实测单次把整卷送进 GLM，输出 JSON 极长，生成时间随题量近似线性增长；
 *   60 题左右就会超过 55s 内部超时 + 70s 前端超时，于是「点 AI 转完圈、请求异常 timeout」。
 *   切块后每块更小，单次生成稳在超时内；多块**并行**执行，墙钟时间≈最慢一块而非各块之和。
 *
 * 【切块策略 —— 按"题数"而非"字符数"切（关键）】
 *   最初按 16k 字符切，但「60 题密卷仅 6.7k 字符」这类卷仍被切成单块，
 *   模型输出被 max_tokens 截断，只返回 8 题。所以必须在**题号边界**切成"题单元"，
 *   再每 ~12 题一组 —— 保证每块的 JSON 输出远小于 8192 token，既不超时又完整。
 *   短卷（≤16k 字符）直接单块，保持原行为；识别不出题号结构的卷回退字符切块。
 */
const Q_START_RE = /^\s*(?:[0-9]{1,3}[.、)）]|[（(][0-9]{1,3}[)）]|第\s*[0-9]{1,3}\s*题|①|②|③|④|⑤|[（(][一二三四五六七八九十]+\s*[)）])/

/** 在题号边界把整卷切成"题单元"；识别不出则回退 null（调用方改用字符切块）。 */
function splitIntoQuestionUnits(text: string): string[] | null {
  const lines = text.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (Q_START_RE.test(lines[i])) starts.push(i)
  }
  // 题量太少 → 不可靠，回退
  if (starts.length < 2) return null
  const units: string[] = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k]
    const e = k + 1 < starts.length ? starts[k + 1] : lines.length
    units.push(lines.slice(s, e).join('\n'))
  }
  return units
}

function splitForParse(text: string, chunkSize = 16000, maxQuestions = 12): { text: string; appendTail: string }[] {
  // 先把卷末"参考答案"区块单独切出来：它只用于回填，不应被当成题目切块/误判为题。
  const ansMarker = text.match(/(参考答案|答案与解析|答案解析|参考答案及解析|——\s*参考答案)/)
  let body = text
  let answerTail = ''
  if (ansMarker && ansMarker.index && ansMarker.index > text.length * 0.3) {
    body = text.slice(0, ansMarker.index)
    answerTail = text.slice(ansMarker.index)
  }
  // 回填尾块：优先用答案区块，退而求其次取全文末 30%
  const tail = answerTail.trim().length > 50
    ? answerTail
    : text.slice(Math.max(0, text.length - Math.min(9000, Math.floor(text.length * 0.3))))

  // ① 优先按"题数"切块 —— 专门解决「题多字少」的密卷（最初超时的主因：60 题仅 6.7k 字符）。
  //   注意：此判断必须放在"字符长度"判断之前，否则短卷会被上面的早退逻辑直接单块返回。
  const units = splitIntoQuestionUnits(body)
  if (units && units.length > maxQuestions) {
    const chunks: string[] = []
    let cur = ''
    let q = 0
    for (const u of units) {
      if (cur && (q >= maxQuestions || cur.length + u.length + 1 > chunkSize)) {
        chunks.push(cur); cur = ''; q = 0
      }
      cur += (cur ? '\n' : '') + u
      q++
    }
    if (cur) chunks.push(cur)
    if (chunks.length > 1) {
      return chunks.map((c, i) => ({
        text: c,
        appendTail: tail && i < chunks.length - 1 ? tail : '',
      }))
    }
  }

  // ② 按"字符数"切块 —— 解决「字多题少」的长卷（如每题题干极长）。
  if (text.length > chunkSize) {
    const chunks: { text: string; appendTail: string }[] = []
    let start = 0
    while (start < text.length) {
      let end = Math.min(start + chunkSize, text.length)
      if (end < text.length) {
        const lo = start + Math.floor(chunkSize * 0.6)
        const seg = text.slice(lo, end)
        const blank = seg.lastIndexOf('\n\n')
        const qmark = seg.search(/\n\s*(?:[0-9]+[.、)）]|[（(][0-9]+[）)]|第\s*[0-9]+|①|（[一二三四五六七八九十]+）)/)
        let cut = -1
        if (blank > 0) cut = lo + blank + 2
        else if (qmark >= 0) cut = lo + qmark + 1
        if (cut > start + Math.floor(chunkSize * 0.4)) end = cut
      }
      const isLast = end >= text.length
      chunks.push({ text: text.slice(start, end), appendTail: tail && !isLast ? tail : '' })
      start = end
    }
    if (chunks.length > 1) return chunks
  }

  // ③ 短卷（题少字少）：单块，保持原行为
  return [{ text, appendTail: '' }]
}

/** 去重：切块重叠边界 / 模型重复输出可能让同一题出现两次 */
function dedupeQuestions(qs: AiQuestion[]): AiQuestion[] {
  const seen = new Set<string>()
  const out: AiQuestion[] = []
  for (const q of qs) {
    const key = `${q.qtype}|${String(q.content).replace(/\s+/g, '').slice(0, 40)}|${q.answer || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

/**
 * 对「单块」跑完整双通道解析（CF 主力 → 备用，再智谱兜底）。
 * 任何失败都不抛，返回空 questions + 失败原因，由上层决定如何合并。
 */
async function parseOneChunk(
  env: AiEnv, chunkText: string, timeoutMs: number
): Promise<{ questions: AiQuestion[]; provider: string; model: string; usage?: any; attempts: { provider: string; error?: string }[] }> {
  const mode = (env.AI_PROVIDER || 'auto').toLowerCase()
  const hasCf = !!(env.AI || env.AI_BASE_CF)
  const hasZhipu = !!env.ZHIPU_API_KEY
  let order: ('cf' | 'zhipu')[] =
    mode === 'cf' ? ['cf'] : mode === 'zhipu' ? ['zhipu'] : ['cf', 'zhipu']
  if (!hasCf) order = order.filter(p => p !== 'cf')
  if (!hasZhipu) order = order.filter(p => p !== 'zhipu')
  const attempts: { provider: string; error?: string }[] = []
  for (const p of order) {
    try {
      if (p === 'cf') {
        // 通道 A 内部再降级：主力模型 → 备用模型
        const primary = env.AI_MODEL_CF || DEFAULT_MODEL_CF
        const fallback = env.AI_MODEL_CF_FALLBACK || DEFAULT_MODEL_CF_FALLBACK
        const models = primary === fallback ? [primary] : [primary, fallback]
        let lastErr = ''
        for (const m of models) {
          // 频率限制(429)/过载：退避后重试（最多 3 次），实测一次重试常能成功
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const { raw, usage } = await callCfAi(env, m, chunkText, timeoutMs)
              const questions = normalizeQuestions(raw)
              if (!questions.length) { lastErr = `模型 ${m} 未解析出题目`; break }
              return { questions, provider: 'cf', model: m, usage, attempts: [{ provider: 'cf' }] }
            } catch (e: any) {
              lastErr = String(e?.message || e).slice(0, 200)
              if (isRateLimit(e) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue }
              break
            }
          }
        }
        attempts.push({ provider: 'cf', error: lastErr || '全部模型失败' })
        continue
      }
      const { raw, usage } = await callZhipu(env, chunkText, timeoutMs)
      const questions = normalizeQuestions(raw)
      if (!questions.length) { attempts.push({ provider: 'zhipu', error: '模型返回内容无法解析出题目' }); continue }
      return { questions, provider: 'zhipu', model: env.AI_MODEL_ZHIPU || DEFAULT_MODEL_ZHIPU, usage, attempts: [{ provider: 'zhipu' }] }
    } catch (e: any) { attempts.push({ provider: p, error: String(e?.message || e).slice(0, 200) }) }
  }
  return { questions: [], provider: '', model: '', attempts }
}

/**
 * 调用 AI 解析试卷。
 *
 * @param env       环境变量 / 绑定（含 env.AI 与智谱 Key）
 * @param paperText 试卷文本。**可以是纯文本，也可以是 HTML**
 *                  —— 传 HTML 时会自动转成「表格 Markdown 化 + 图片占位符化」的
 *                  结构化文本（见 `htmlToStructuredText`），这是表格/图片不丢的前提。
 * @param opts      可选：超时、单次最大字符数、图片映射回传
 * @returns         解析结果；**两通道都失败时返回空 questions**（调用方回落正则）
 */
export async function aiParsePaper(
  env: AiEnv,
  paperText: string,
  opts: { timeoutMs?: number; maxChars?: number } = {}
): Promise<AiParseResult | null> {
  // 【v4.13.7】**不预设超时杀死 AI**：默认给到 10 分钟兜底（仅防真·失控挂死，
  //   平台自身对单次推理也有上限）。正常生成几秒~一两分钟即返回。
  //   长卷已切块并行，每块远小于整卷，单块跑完即可，绝不中途掐断让模型「转完圈没结果」。
  const timeoutMs = opts.timeoutMs ?? 600000
  // 免费档上下文够大，但整卷动辄数万字；超长截断会造成"后半卷丢失"，
  // 所以默认上限设得较高（6 万字符），并在前端提示用户可拆分上传。
  const maxChars = opts.maxChars ?? 60000

  // 【v4.13.1】入参含标签 → 先做「保结构」转换，保住表格行列与图片位置。
  //   判据用「含 < 且含 >」而不是严格的 HTML 校验 —— 试卷文本里出现
  //   `<`、`>` 作为数学符号（如 "x < 3"）很常见，但它们不会成对出现标签名，
  //   所以再用一个宽松的标签名正则二次确认，避免误伤纯文本。
  let structured: StructuredText
  if (/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(paperText)) {
    structured = htmlToStructuredText(paperText)
  } else {
    structured = { text: paperText, images: {} }
  }
  const full = structured.text
  const text = full.length > maxChars ? full.slice(0, maxChars) : full
  if (!text.trim()) return null

  // ── 切块并行解析（长卷防超时；短卷退化为单块，行为不变）──
  const rawChunks = splitForParse(text)
  const total = rawChunks.length

  const buildChunkText = (c: { text: string; appendTail: string }, i: number): string => {
    const segNote = total > 1
      ? `（这是整份试卷的第 ${i + 1}/${total} 段，请只输出本段内的题目；`
        + `若某题答案在文末「卷末参考答案」区块里，请回填到对应题目，不要把该区块当成独立题目输出。）\n`
      : ''
    const body = c.appendTail
      ? `${c.text}\n\n【卷末参考答案区块（仅供回填，请勿作为独立题目输出）】\n${c.appendTail}`
      : c.text
    return segNote + body
  }

  let provider = '', model = ''
  let usageAcc: AiParseResult['usage'] | undefined
  let allAttempts: { provider: string; error?: string }[] = []
  let merged: AiQuestion[] = []

  if (total === 1) {
    // 短卷：与原逻辑一致的单次调用（保持已验证行为）
    const r = await parseOneChunk(env, buildChunkText(rawChunks[0], 0), timeoutMs)
    provider = r.provider; model = r.model; usageAcc = r.usage; allAttempts = r.attempts
    merged = r.questions
  } else {
    // 长卷：多块解析。
    // 【v4.13.7】Cloudflare Workers AI 免费档对并发调用有限流——
    // 并发过高时易触发 429/过载。故用**受限并发（≤2）**压住墙钟时间
    // （≈ ⌈N/2⌉ × 单块耗时），且每块内已对 429 做退避重试，避开限流。
    const CONCURRENCY = 2
    const runPool = async (items: { text: string; appendTail: string }[]) => {
      const out: Awaited<ReturnType<typeof parseOneChunk>>[] = new Array(items.length)
      let cursor = 0
      const worker = async () => {
        while (cursor < items.length) {
          const i = cursor++
          const r = await parseOneChunk(env, buildChunkText(items[i], i), timeoutMs)
          out[i] = r
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()))
      return out
    }
    const results = await runPool(rawChunks)
    for (const r of results) {
      if (r.provider && !provider) { provider = r.provider; model = r.model; usageAcc = r.usage }
      allAttempts.push(...r.attempts)
      merged.push(...r.questions)
    }
  }

  const questions = dedupeQuestions(merged)
  if (!questions.length) {
    return { questions: [], provider, model, attempts: allAttempts, images: structured.images }
  }
  return { questions, provider, model, attempts: allAttempts, usage: usageAcc, images: structured.images }
}

/**
 * AI 是否可用。
 *
 * ⚠️ 口径变化（v4.13.0）：**只要有 Cloudflare Workers AI 绑定就算可用**，
 * 不再要求用户配任何 Key —— 这正是用户的核心诉求（"Google 这个我弄不了"）。
 * 前端据此决定「AI 智能识别」按钮是否置灰。
 */
export function aiAvailable(env: AiEnv): boolean {
  return !!(env.AI || env.AI_BASE_CF || env.ZHIPU_API_KEY)
}

/** 当前实际会生效的服务商（用于状态展示；空串表示都不可用） */
export function effectiveProvider(env: AiEnv): string {
  const mode = (env.AI_PROVIDER || 'auto').toLowerCase()
  const hasCf = !!(env.AI || env.AI_BASE_CF)
  const hasZhipu = !!env.ZHIPU_API_KEY
  if (mode === 'cf') return hasCf ? 'cf' : ''
  if (mode === 'zhipu') return hasZhipu ? 'zhipu' : ''
  if (hasCf) return 'cf'
  if (hasZhipu) return 'zhipu'
  return ''
}

// ---------------------------------------------------------------------------
// 后端可配置项（超管在管理界面填，存 D1 settings 表）
// ---------------------------------------------------------------------------

/**
 * 把题干里的 `[图N]` 占位符换回真正的 `<img>` 标签。
 *
 * 【为什么需要】
 *   送 AI 的文本里图片是 `[图1]` 这种占位符（模型看不见图片二进制）。
 *   模型把它原样写进 content 后，前端必须换回 `<img src="...">`
 *   才能让图片**真正显示在题目里** —— 否则用户看到的只是一串 `[图1]`。
 *
 * 容错：
 *   · 模型可能写 `[图 1]`（多一个空格）或 `［图1］`（全角方括号）→ 一并识别
 *   · 模型可能把占位符弄丢 → 此时不做任何替换，由调用方决定是否兜底补图
 *   · src 为空的（mammoth 未提取到）→ 保留原样，不生成空 img
 *
 * @param content 题干文本（含 `[图N]` 占位符）
 * @param images  占位符 → src 映射（来自 `AiParseResult.images`）
 * @param asHtml  强制按 HTML 生成 `<img>`（即使 content 看着像纯文本）。
 *                用于 `mergeContent` 的空原卷分支 —— 那种场景下题干就是要渲染成 HTML。
 * @returns       替换后的文本
 */
export function restoreImages(content: string, images?: Record<string, string>, asHtml?: boolean): string {
  if (!content) return content || ''
  if (!images || !Object.keys(images).length) return content
  const isHtmlLike = asHtml || /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(content)
  return String(content).replace(
    /[［\[]\s*图\s*(\d+)\s*[］\]]/g,
    (whole, d) => {
      const src = images[`图${d}`]
      if (!src) return whole
      // 题干已是 HTML（来自原卷）→ 生成 <img>；纯文本 → 保留可见的文字标记
      return isHtmlLike
        ? `<img src="${src}" alt="图${d}" />`
        : whole
    }
  )
}

/**
 * 把 AI 返回的纯文本题干**合并**到原卷 HTML 上，保证表格/图片不丢。
 *
 * 【v4.13.1 关键设计 · 为什么不是直接替换】
 *   v4.13.0 的做法是 `content: q.content` —— 用 AI 的纯文本**整体覆盖**原卷 HTML。
 *   而 AI 拿到的输入里表格已被压平、图片连占位符都不存在，
 *   所以覆盖之后**原卷里的 <table> / <img> 全没了**（用户反馈的"直接吞了"）。
 *
 *   现在的策略是「原卷为准，AI 只补元数据」：
 *     · 原卷 HTML 里**有** table/img —— 一律保留原样，不因 AI 的重写而丢失
 *     · AI 题干与原文差异大（表格被 AI 改写/丢失）—— 仍以原卷 HTML 为准
 *     · AI 的答案/解析/题型/分值 —— 这些原卷里常常没有或不准，采用 AI 的
 *
 * @param originalHtml 原卷切出来的 HTML（含 table/img，是内容真源）
 * @param aiContent    AI 返回的题干（用于补充原文没有的信息）
 * @param images       图片占位符映射
 * @returns            合并后的题干 HTML
 */
export function mergeContent(originalHtml: string, aiContent: string, images?: Record<string, string>): string {
  const orig = String(originalHtml || '')
  const ai = String(aiContent || '')

  // 原卷 HTML 里含表格或图片 —— 这些是最容易被 AI 弄丢的，一律以原卷为准
  const hasRich = /<table[\s>]|<img[\s>]/i.test(orig)

  if (!orig.trim()) {
    // 原卷没内容（比如块只有图片、text 为空）：用 AI 的，并回填图片。
    // ⚠️ 这里必须**强制按 HTML 处理**（restoreImages 的第 3 参）——
    //    否则纯文本走"保留文字标记"分支，用户看到的会是 "[图1]" 而不是图片。
    return restoreImages(ai, images, true)
  }
  if (hasRich) return orig

  // 原卷是纯文字：若 AI 给了更完整的题干（含表格 Markdown / 图片占位符）就用 AI 的
  const aiT = ai.trim()
  const origT = orig.replace(/<[^>]+>/g, '').replace(/\s+/g, '')
  const aiPlain = aiT.replace(/[|#*`\[\]\s]/g, '')
  if (aiT && (aiPlain.length > origT.length * 1.2 || /\[图\d+\]|\|.*\|/.test(aiT))) {
    return restoreImages(aiT, images)
  }
  return orig
}

/** 存进 settings 表的 key */
export const AI_CONFIG_KEY = 'ai_config'

/** 超管可在后台调整的 AI 配置（**不含** CF 绑定，那是基础设施） */
export interface AiConfig {
  /** 服务商优先级：cf | zhipu | auto */
  provider: 'cf' | 'zhipu' | 'auto'
  /** 通道 A 主力模型 */
  modelCf: string
  /** 通道 A 备用模型 */
  modelCfFallback: string
  /** 通道 B 智谱模型 */
  modelZhipu: string
  /** 智谱开放平台 Key（空串表示未配置） */
  zhipuKey: string
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'auto',
  modelCf: DEFAULT_MODEL_CF,
  modelCfFallback: DEFAULT_MODEL_CF_FALLBACK,
  modelZhipu: DEFAULT_MODEL_ZHIPU,
  zhipuKey: '',
}

/**
 * 把任意（可能残缺/非法的）输入规整为完整 AiConfig。
 *
 * 为什么要"规整"而不是直接用：
 *   · DB 里的历史值可能缺字段（比如升级后新增了 modelCfFallback）
 *   · 前端可能传垃圾值，直接写库会让后续逻辑拿到 undefined 而静默失效
 *   · provider 只允许三个枚举值，防止拼错导致 aiParsePaper 走空 order
 */
export function sanitizeAiConfig(raw: any): AiConfig {
  const o = (raw && typeof raw === 'object') ? raw : {}
  const prov = String(o.provider ?? '').toLowerCase()
  return {
    provider: (prov === 'cf' || prov === 'zhipu' || prov === 'auto') ? prov : 'auto',
    // ⚠️ 这里**不填默认值**，空串就是空串。
    //   原因：fill 默认值会让「后台没配」和「后台配了默认值」变得无法区分，
    //   而 mergeAiConfig 需要靠"空"来判断该不该回落到环境变量。
    //   若在此填默认值，用户在后台只改了一个字段（比如 provider），其余字段
    //   会被默认值"顺带覆盖"，导致部署时配好的环境变量静默失效。
    modelCf: String(o.modelCf ?? '').trim(),
    modelCfFallback: String(o.modelCfFallback ?? '').trim(),
    modelZhipu: String(o.modelZhipu ?? '').trim(),
    zhipuKey: String(o.zhipuKey ?? '').trim(),
  }
}

/**
 * 合并「基础设施（env）」与「后台配置（DB）」为一个可用的 AiEnv。
 *
 * 【优先级：DB 后台配置 > 环境变量 > 内置默认值】
 *   理由：后台是超管在界面上实时改的，环境变量是部署时写死的（改要重新部署）。
 *   超管在界面改了模型却因为环境变量覆盖而不生效，那是令人困惑的行为。
 *
 * ⚠️ 判断"后台配了没有"用的是**空串**，所以上游 sanitizeAiConfig 不能填默认值
 *   （否则后台配了一个字段就会连带覆盖掉其余环境变量）。真正的兜底在这里做。
 *
 * ⚠️ 唯一的例外是 `AI` 绑定本身 —— 它只能来自 c.env（基础设施），
 *   后台配置无法凭空造出一个 binding。
 */
export function mergeAiConfig(env: AiEnv, cfg: AiConfig): AiEnv {
  return {
    ...env,
    AI_PROVIDER: cfg.provider || env.AI_PROVIDER || 'auto',
    AI_MODEL_CF: cfg.modelCf || env.AI_MODEL_CF || DEFAULT_MODEL_CF,
    AI_MODEL_CF_FALLBACK: cfg.modelCfFallback || env.AI_MODEL_CF_FALLBACK || DEFAULT_MODEL_CF_FALLBACK,
    AI_MODEL_ZHIPU: cfg.modelZhipu || env.AI_MODEL_ZHIPU || DEFAULT_MODEL_ZHIPU,
    ZHIPU_API_KEY: cfg.zhipuKey || env.ZHIPU_API_KEY,
  }
}

/**
 * 智谱 Key 脱敏：只保留前 4 位与后 4 位。
 *
 * 为什么不直接返回空串：超管需要确认"我到底配了没有 / 配的是哪个"，
 * 全程打码会让界面无法自我校验。但**绝不明文回显**（前端/浏览器插件/日志都能看到）。
 */
export function maskKey(key?: string): string {
  const s = String(key || '')
  if (!s) return ''
  if (s.length <= 8) return '****'
  return `${s.slice(0, 4)}****${s.slice(-4)}`
}
