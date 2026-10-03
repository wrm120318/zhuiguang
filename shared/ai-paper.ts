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
//   │   · 主力模型 @cf/zai-org/glm-4.7-flash —— 智谱 GLM，中文理解最好      │
//   │     实测单题仅耗 3.4 神经元 → 每天可跑约 2900 道题                    │
//   │   · 备用模型 @cf/meta/llama-3.3-70b-instruct-fp8-fast                │
//   │     英文 prompt 下 JSON 最规范，但耗 12.9 神经元（贵 4 倍），仅兜底   │
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
}

// ---------------------------------------------------------------------------
// 默认模型常量（后端与前端设置页共用，避免两处写死不一致）
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL_CF = '@cf/zai-org/glm-4.7-flash'
export const DEFAULT_MODEL_CF_FALLBACK = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
export const DEFAULT_MODEL_ZHIPU = 'glm-4-flash'

/** 候选模型清单（供管理后台下拉选择，均实测在免费额度内可用） */
export const CF_MODEL_CHOICES = [
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7-Flash（智谱 · 中文最强 · 最省）' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama-3.3-70B（JSON 最规范 · 耗量高）' },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5-Coder-32B（代码/公式强）' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek-R1-Distill-32B（推理强）' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral-Small-3.1-24B' },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma-4-26B（Google · 上下文 256K）' },
] as const

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

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
8. 保留题干中的公式（LaTeX 用 $...$ 包裹）、表格（Markdown 表格）、图片占位符。`

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
    chat_template_kwargs: { enable_thinking: false },
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
 * 调用 AI 解析试卷。
 *
 * @param env       环境变量 / 绑定（含 env.AI 与智谱 Key）
 * @param paperText 试卷纯文本
 * @param opts      可选：超时、单次最大字符数
 * @returns         解析结果；**两通道都失败时返回空 questions**（调用方回落正则）
 */
export async function aiParsePaper(
  env: AiEnv,
  paperText: string,
  opts: { timeoutMs?: number; maxChars?: number } = {}
): Promise<AiParseResult | null> {
  const timeoutMs = opts.timeoutMs ?? 55000
  // 免费档上下文够大，但整卷动辄数万字；超长截断会造成"后半卷丢失"，
  // 所以默认上限设得较高（6 万字符），并在前端提示用户可拆分上传。
  const maxChars = opts.maxChars ?? 60000
  const text = paperText.length > maxChars ? paperText.slice(0, maxChars) : paperText
  if (!text.trim()) return null

  const mode = (env.AI_PROVIDER || 'auto').toLowerCase()
  const hasCf = !!(env.AI || env.AI_BASE_CF)
  const hasZhipu = !!env.ZHIPU_API_KEY

  // auto：优先 CF Workers AI（零配置、免密钥），失败切智谱
  let order: ('cf' | 'zhipu')[] =
    mode === 'cf' ? ['cf']
      : mode === 'zhipu' ? ['zhipu']
        : ['cf', 'zhipu']

  // 通道不可用的直接跳过（不算失败，避免误导用户）
  if (!hasCf) order = order.filter(p => p !== 'cf')
  if (!hasZhipu) order = order.filter(p => p !== 'zhipu')
  if (!order.length) return { questions: [], provider: '', model: '', attempts: [] }

  const attempts: { provider: string; error?: string }[] = []
  for (const p of order) {
    try {
      if (p === 'cf') {
        // 通道 A 内部再降级：主力模型 → 备用模型。
        // 为什么不把备用模型放进外层 order？因为外层 order 是"通道"级降级
        // （CF 整体挂了才切智谱），而主力/备用是**模型**级降级（换个模型再试）。
        const primary = env.AI_MODEL_CF || DEFAULT_MODEL_CF
        const fallback = env.AI_MODEL_CF_FALLBACK || DEFAULT_MODEL_CF_FALLBACK
        const models = primary === fallback ? [primary] : [primary, fallback]
        let lastErr = ''
        for (const m of models) {
          try {
            const { raw, usage } = await callCfAi(env, m, text, timeoutMs)
            const questions = normalizeQuestions(raw)
            if (!questions.length) { lastErr = `模型 ${m} 未解析出题目`; continue }
            attempts.push({ provider: 'cf' })
            return {
              questions, provider: 'cf', model: m, attempts,
              usage: {
                promptTokens: usage?.prompt_tokens ?? usage?.promptTokenCount,
                completionTokens: usage?.completion_tokens ?? usage?.candidatesTokenCount,
                neurons: usage?.neurons,
              },
            }
          } catch (e: any) {
            lastErr = String(e?.message || e).slice(0, 200)
          }
        }
        attempts.push({ provider: 'cf', error: lastErr || '全部模型失败' })
        continue
      }

      const { raw, usage } = await callZhipu(env, text, timeoutMs)
      const questions = normalizeQuestions(raw)
      if (!questions.length) {
        attempts.push({ provider: 'zhipu', error: '模型返回内容无法解析出题目' })
        continue
      }
      attempts.push({ provider: 'zhipu' })
      return {
        questions, provider: 'zhipu', model: env.AI_MODEL_ZHIPU || DEFAULT_MODEL_ZHIPU, attempts,
        usage: {
          promptTokens: usage?.prompt_tokens,
          completionTokens: usage?.completion_tokens,
        },
      }
    } catch (e: any) {
      attempts.push({ provider: p, error: String(e?.message || e).slice(0, 200) })
    }
  }
  // 全部失败
  return { questions: [], provider: '', model: '', attempts }
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
// 后台可配置项（超管在管理界面填，存 D1 settings 表）
// ---------------------------------------------------------------------------

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
