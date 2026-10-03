// ============================================================================
// v4.12.0 AI 试卷识别适配层
// ============================================================================
//
// 【为什么需要这个文件】
//   Word 试卷导入的「自动切割 + 读取答案/解析」原来是**纯正则启发式**，
//   容错极低：题号格式一变就切不出、答案只在行内紧邻才认、
//   卷末「参考答案」区块完全关联不上、解析字段常年为空。
//
//   本模块把「题目结构识别」交给大模型，正则只作为**降级兜底**。
//
// 【双服务设计（用户决策：两家都接、可切换）】
//   · Google Gemini 2.0 Flash —— 免费额度慷慨（1500 次/天），上下文 1M，
//     整篇试卷一次性丢进去也能处理；综合能力最强
//   · 智谱 GLM-4-Flash —— 国内直连、中文题干理解好、免费
//
//   优先级由 AI_PROVIDER 环境变量决定（gemini / zhipu / auto）。
//   auto 模式下：先试主服务，失败（超限/网络/无 Key）自动切备用。
//   两家都不可用时**返回 null**，由调用方回落到正则 —— 保证功能永不中断。
//
// 【安全】密钥只从 Worker 环境变量读取，不落任何文件、不进 git。
// ============================================================================

/** 统一的环境变量读取（Worker 的 c.env / 本地 process.env 都能用） */
export interface AiEnv {
  GEMINI_API_KEY?: string
  ZHIPU_API_KEY?: string
  AI_PROVIDER?: string          // gemini | zhipu | auto（默认 auto）
  AI_MODEL_GEMINI?: string      // 默认 gemini-2.0-flash
  AI_MODEL_ZHIPU?: string       // 默认 glm-4-flash
  /** 仅用于测试：把请求指向本地 mock 服务（生产不设） */
  AI_BASE_GEMINI?: string
  AI_BASE_ZHIPU?: string
}

/** 识别出的单道题（两家服务归一后的统一结构） */
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
  usage?: { promptTokens?: number; completionTokens?: number }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * 系统提示词。
 *
 * 设计要点（每一条都是为了让模型**稳定输出可解析的 JSON**）：
 *  1. 明确"只输出 JSON、不要任何解释/代码块标记"——否则模型爱加 ```json ```
 *  2. 明确字段名与取值枚举，避免模型自由发挥
 *  3. 明确选项**不带字母前缀**，避免前端二次清洗
 *  4. 强调"卷末的参考答案/解析要**回填到对应题目**"——这是原正则最做不到的
 *  5. 强调"题干里不要包含选项、答案、解析"——避免内容重复输出
 */
const SYSTEM_PROMPT = `你是一名资深中小学试卷排版工程师，擅长把杂乱的 Word 试卷文本拆解成结构化试题。

【任务】读取用户给出的试卷原文，输出严格 JSON（不要任何解释文字，不要 markdown 代码块标记）。

【输出格式】
{
  "questions": [
    {
      "qtype": "single|multiple|judge|fill|subjective",
      "content": "题干原文（保留题号之前的序号可去掉，但保留填空下划线、公式、图片占位）",
      "options": ["选项1文本", "选项2文本", "..."],
      "answer": "参考答案",
      "analysis": "答案解析/详解",
      "score": 分值数字,
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
2. **options 里不要带 "A." "B." 等字母前缀**，只要选项内容本身。
3. **content 里不要包含选项、答案、解析**——它们各有专门字段，重复会导致导出时内容出现两遍。
4. **卷末如果有独立的「参考答案」「答案与解析」「详解」区块，必须回填到对应题目**。
   常见格式：「1-5 BCDAC」「一、1.A 2.C 3.B」「1.【答案】A 【解析】……」
5. 如果某题没有答案或解析，对应字段填空字符串 ""，**不要编造**。
6. score 无法判断时给 5。
7. 如果原文包含试卷标题、考试说明、姓名班级栏等**非题目内容，忽略它们，不要输出成题目**。
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

  // ③ 中文引号 → 英文引号（只在作为 JSON 分隔符时可能出问题，粗暴替换收益大于风险）
  const tryParse = (str: string) => { try { return JSON.parse(str) } catch { return null } }
  let out = tryParse(s)
  if (out) return out

  // ④ 去尾逗号
  out = tryParse(s.replace(/,\s*([}\]])/g, '$1'))
  if (out) return out

  // ⑤ 引号替换再试
  out = tryParse(s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, '$1'))
  return out || null
}

/** 把模型返回的原始条目归一成 AiQuestion（字段缺失/类型错误都不抛） */
export function normalizeQuestions(raw: any): AiQuestion[] {
  const list = Array.isArray(raw?.questions) ? raw.questions : (Array.isArray(raw) ? raw : [])
  const QTYPES = ['single', 'multiple', 'judge', 'fill', 'subjective']
  const out: AiQuestion[] = []
  for (const q of list) {
    if (!q || typeof q !== 'object') continue
    const content = String(q.content ?? q.stem ?? q.question ?? '').trim()
    if (!content) continue
    let options: string[] = []
    if (Array.isArray(q.options)) {
      options = q.options.map((o: any) => {
        const s = typeof o === 'string' ? o : String(o?.text ?? o?.content ?? '')
        // 剥掉可能残留的 "A." / "A、" / "(A)" 前缀
        return s.replace(/^\s*[(（]?\s*[A-Ha-h]\s*[.、)）．:：]\s*/, '').trim()
      }).filter(Boolean)
    }
    let qtype = String(q.qtype ?? q.type ?? '').toLowerCase().trim()
    if (!QTYPES.includes(qtype)) {
      // 模型给中文题型 → 映射。
      // 注意：模型常输出带「题」字后缀（多选**题** / 单项选择**题** / 计算**题**），
      // 所以查表前先剥掉尾部「题」字，避免 "多选题" 漏配而误判为单选。
      const map: Record<string, string> = {
        '单选': 'single', '单项选择': 'single', '单一选择': 'single', '选择题': 'single',
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
    const score = Number(q.score ?? q.points ?? 5)
    out.push({
      qtype: qtype as AiQuestion['qtype'],
      content,
      options,
      answer: String(q.answer ?? q.correct ?? '').trim(),
      analysis: String(q.analysis ?? q.explanation ?? q.solution ?? '').trim(),
      score: Number.isFinite(score) && score > 0 ? score : 5,
      anchor: String(q.anchor ?? '').trim() || undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

async function callGemini(env: AiEnv, paperText: string, timeoutMs: number): Promise<{ raw: any; usage: any }> {
  const key = env.GEMINI_API_KEY
  if (!key) throw new Error('未配置 GEMINI_API_KEY')
  const model = env.AI_MODEL_GEMINI || 'gemini-2.0-flash'
  // 【安全】Key 走 **x-goog-api-key 请求头**，不拼进 URL。
  //   拼 URL（`?key=...`）会把密钥写进所有中间层日志：CF 请求日志、反代 access.log、
  //   浏览器 DevTools 历史、以及任何错误上报。请求头不会。
  // 【可测】base 可被 AI_BASE_GEMINI 覆盖，便于探针指向本地 mock。
  const base = env.AI_BASE_GEMINI || 'https://generativelanguage.googleapis.com'
  const url = `${base.replace(/\/+$/, '')}/v1beta/models/${model}:generateContent`

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: `【试卷原文】\n${paperText}` }] }],
    generationConfig: {
      temperature: 0.1,          // 结构化抽取任务，温度越低越稳
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',  // Gemini 原生支持强制 JSON 输出
    },
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`Gemini HTTP ${res.status}: ${t.slice(0, 180)}`)
    }
    const j: any = await res.json()
    const text = j?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') || ''
    return { raw: extractJson(text), usage: j?.usageMetadata }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 智谱 GLM（OpenAI 兼容协议）
// ---------------------------------------------------------------------------

async function callZhipu(env: AiEnv, paperText: string, timeoutMs: number): Promise<{ raw: any; usage: any }> {
  const key = env.ZHIPU_API_KEY
  if (!key) throw new Error('未配置 ZHIPU_API_KEY')
  const model = env.AI_MODEL_ZHIPU || 'glm-4-flash'
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
// 对外主入口
// ---------------------------------------------------------------------------

/**
 * 调用 AI 解析试卷。
 *
 * @param env       环境变量（含密钥）
 * @param paperText 试卷纯文本
 * @param opts      可选：超时、单次最大字符数
 * @returns         解析结果；**两家都失败时返回 null**（调用方回落正则）
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
  // auto：优先 Gemini（上下文大、免费额度高），失败切智谱
  let order: ('gemini' | 'zhipu')[] =
    mode === 'gemini' ? ['gemini']
      : mode === 'zhipu' ? ['zhipu']
        : ['gemini', 'zhipu']

  // 没配 Key 的服务直接跳过（不算失败，避免误导）
  if (!env.GEMINI_API_KEY) order = order.filter(p => p !== 'gemini')
  if (!env.ZHIPU_API_KEY) order = order.filter(p => p !== 'zhipu')
  if (!order.length) return null

  const attempts: { provider: string; error?: string }[] = []
  for (const p of order) {
    try {
      const { raw, usage } = p === 'gemini'
        ? await callGemini(env, text, timeoutMs)
        : await callZhipu(env, text, timeoutMs)
      const questions = normalizeQuestions(raw)
      if (!questions.length) {
        attempts.push({ provider: p, error: '模型返回内容无法解析出题目' })
        continue
      }
      attempts.push({ provider: p })
      return {
        questions,
        provider: p,
        model: p === 'gemini' ? (env.AI_MODEL_GEMINI || 'gemini-2.0-flash') : (env.AI_MODEL_ZHIPU || 'glm-4-flash'),
        attempts,
        usage: {
          promptTokens: usage?.promptTokenCount ?? usage?.prompt_tokens,
          completionTokens: usage?.candidatesTokenCount ?? usage?.completion_tokens,
        },
      }
    } catch (e: any) {
      attempts.push({ provider: p, error: String(e?.message || e).slice(0, 200) })
    }
  }
  // 全部失败
  return { questions: [], provider: '', model: '', attempts }
}

/** AI 是否可用（至少配了一家的 Key）——前端据此决定按钮是否置灰 */
export function aiAvailable(env: AiEnv): boolean {
  return !!(env.GEMINI_API_KEY || env.ZHIPU_API_KEY)
}
