// v4.12.0 AI 试卷识别探针
//
// 用法：node scripts/probe-ai-parse.mjs
//
// 背景：用户反馈 Word 导入的两个功能「完全瘫痪 / 太难用」：
//   ① 拖动分割题目完全瘫痪
//   ② 自动切割题目 + 读取答案和解析太难用
// 修复方案：① 重写拖动（见 probe-split-editor.mjs）
//          ② 接入 AI 做结构识别，正则降级兜底
//
// 本探针验证 ② 的核心不变量，**不需要真实 API Key**：
//   · JSON 容错解析（模型最爱加 ```json ``` 围栏 / 前后寒暄 / 尾逗号）
//   · 字段归一（中文题型 → 英文枚举、选项剥字母前缀、缺失字段不抛）
//   · 降级逻辑（无 Key → 返回 null 而非抛错；一家失败 → 切另一家）
//   · 安全（错误信息不回显 key；密钥只从 env 读）
//   · 前后端一致性（worker-api 与 server 走同一个共享模块）
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

const server = await createServer({
  root: ROOT, logLevel: 'error',
  server: { middlewareMode: true }, appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/shared/ai-paper.ts')
  const { extractJson, normalizeQuestions, aiAvailable, aiParsePaper } = mod

  console.log('=== 1. JSON 容错解析（模型不听话的三种典型形态）===')
  ok('裸 JSON 可解析',
    extractJson('{"questions":[{"content":"x"}]}')?.questions?.[0]?.content === 'x')

  const fenced = '```json\n{"questions":[{"content":"y"}]}\n```'
  ok('```json 围栏可剥掉（模型最常犯）',
    extractJson(fenced)?.questions?.[0]?.content === 'y')

  const fencedNoLang = '```\n{"questions":[{"content":"z"}]}\n```'
  ok('无语言标记的围栏也能剥',
    extractJson(fencedNoLang)?.questions?.[0]?.content === 'z')

  const chatty = '好的，以下是根据您提供的试卷解析出的结果：\n{"questions":[{"content":"a"}]}\n希望对您有帮助！'
  ok('前后带寒暄可裁剪出 JSON',
    extractJson(chatty)?.questions?.[0]?.content === 'a')

  ok('尾逗号可容错', extractJson('{"questions":[],}') !== null)
  ok('中文引号可容错',
    extractJson('{“questions”:[{“content”:“q”}]}')?.questions?.[0]?.content === 'q')
  ok('完全非 JSON → 返回 null 而不抛异常', extractJson('抱歉我无法处理') === null)
  ok('空输入 → null', extractJson('') === null)

  console.log('\n=== 2. 字段归一（模型输出千奇百怪，必须都收敛）===')
  const qs1 = normalizeQuestions({
    questions: [
      { qtype: 'single', content: '题干A', options: ['A. 甲', 'B. 乙'], answer: 'A', analysis: '解析A', score: 3 },
    ],
  })
  ok('标准输入 → 1 题', qs1.length === 1)
  ok('选项剥掉 A./B. 前缀', qs1[0].options[0] === '甲' && qs1[0].options[1] === '乙', JSON.stringify(qs1[0].options))
  ok('答案/解析/分值保留', qs1[0].answer === 'A' && qs1[0].analysis === '解析A' && qs1[0].score === 3)

  const qs2 = normalizeQuestions({ questions: [{ qtype: '多选题', content: '题干B', options: ['甲', '乙'] }] })
  ok('中文题型「多选题」→ multiple', qs2[0].qtype === 'multiple', qs2[0]?.qtype)

  const qs3 = normalizeQuestions({ questions: [{ qtype: '判断', content: '题干C' }] })
  ok('中文题型「判断」→ judge', qs3[0].qtype === 'judge')

  const qs4 = normalizeQuestions({ questions: [
    { content: '题干D', options: ['(A) 甲', '（B）乙', 'C、丙', 'D．丁'] },
  ] })
  ok('四种选项前缀写法都能剥（(A) （B） C、 D．）',
    JSON.stringify(qs4[0].options) === JSON.stringify(['甲', '乙', '丙', '丁']), JSON.stringify(qs4[0].options))

  const qs5 = normalizeQuestions({ questions: [
    { content: '' },            // 空题干 → 丢弃
    { content: '有效题' },
    null,                        // 脏数据 → 跳过
    'not-an-object',
  ] })
  ok('空题干/脏数据被跳过而不抛', qs5.length === 1, `实际 ${qs5.length}`)

  const qs6 = normalizeQuestions({ questions: [{ content: '缺字段题' }] })
  ok('缺 answer/analysis/score → 填空值不抛',
    qs6[0].answer === '' && qs6[0].analysis === '' && qs6[0].score === 5)

  ok('模型用 stem/solution 等别名也能识别',
    normalizeQuestions({ questions: [{ stem: '别名题干', solution: '别名解析' }] })[0]?.analysis === '别名解析')

  ok('无 options 且非选择题 → subjective',
    normalizeQuestions({ questions: [{ content: '解答题' }] })[0].qtype === 'subjective')

  console.log('\n=== 3. 降级逻辑（没有 Key 时功能不能崩）===')
  ok('无任何 Key → aiAvailable=false', aiAvailable({}) === false)
  ok('只有 Gemini Key → available', aiAvailable({ GEMINI_API_KEY: 'x' }) === true)
  ok('只有智谱 Key → available', aiAvailable({ ZHIPU_API_KEY: 'x' }) === true)

  const r1 = await aiParsePaper({}, '试卷文本')
  ok('无 Key 调 aiParsePaper → 返回 null（不抛异常，调用方好降级）', r1 === null, String(r1))

  const r2 = await aiParsePaper({ GEMINI_API_KEY: 'invalid-key-for-test' }, '题目1. 测试', { timeoutMs: 8000 })
  ok('Key 无效 → 不抛异常，返回结果对象', r2 !== null && typeof r2 === 'object')
  ok('Key 无效 → questions 为空数组', Array.isArray(r2?.questions) && r2.questions.length === 0)
  ok('Key 无效 → attempts 记录失败原因（便于排查）',
    Array.isArray(r2?.attempts) && r2.attempts.length > 0 && !!r2.attempts[0].error)
  const errText = JSON.stringify(r2?.attempts || [])
  ok('⚠️ 安全：失败信息里不回显 Key 值', !errText.includes('invalid-key-for-test'), errText.slice(0, 120))

  console.log('\n=== 4. 前后端共用同一实现（铁律#11）===')
  const worker = readFileSync(`${ROOT}/worker-api.ts`, 'utf8')
  const local = readFileSync(`${ROOT}/server/index.ts`, 'utf8')
  const shared = readFileSync(`${ROOT}/shared/ai-paper.ts`, 'utf8')

  ok('worker-api.ts 从共享模块导入', /from '\.\/shared\/ai-paper'/.test(worker))
  ok('server/index.ts 从共享模块导入', /from '\.\.\/shared\/ai-paper'/.test(local))
  ok('两端都提供 GET /api/ai/status', worker.includes("'/api/ai/status'") && local.includes("'/api/ai/status'"))
  ok('两端都提供 POST /api/ai/parse-paper', worker.includes("'/api/ai/parse-paper'") && local.includes("'/api/ai/parse-paper'"))
  ok('worker 接口有权限校验（requireSubjectStaff 或 role 判断）',
    /ai\/parse-paper[\s\S]{0,2500}无权操作该学科/.test(worker))
  ok('server 接口有权限校验', /无权操作该学科/.test(local))

  // ── 铁律#11 的延伸：字段不能漂移 ────────────────────────────────────────
  //   共享模块 AiEnv 的每个字段，两端都必须能注入进来；少一个就会出现
  //   「本地能跑、线上不生效」这种极难排查的问题（v4.12.0 实测踩到过：
  //   AI_BASE_* 忘了在 readAiEnv 里转发，mock 收不到请求）。
  const aiEnvFields = [...shared.matchAll(/readonly|^\s{2}([A-Z_]+)\??:/gm)]
    .map(m => m[1]).filter(Boolean)
    .filter((f, i, a) => a.indexOf(f) === i && /AI|GEMINI|ZHIPU|PROVIDER|MODEL|BASE/.test(f))
  const missingWorker = aiEnvFields.filter(f => !worker.includes(f))
  const missingLocal = aiEnvFields.filter(f => !local.includes(f))
  ok('⚠️ 共享模块的每个 AiEnv 字段都被 worker 注入（防字段漂移）',
    missingWorker.length === 0, `worker 缺: ${missingWorker.join(',')}`)
  ok('⚠️ 共享模块的每个 AiEnv 字段都被 server 注入（防字段漂移）',
    missingLocal.length === 0, `server 缺: ${missingLocal.join(',')}`)

  console.log('\n=== 5. 共享模块的关键设计 ===')
  ok('双服务都实现：callGemini + callZhipu',
    /async function callGemini/.test(shared) && /async function callZhipu/.test(shared))
  ok('auto 模式默认顺序 Gemini → 智谱',
    /mode === 'gemini' \? \['gemini'\]/.test(shared) && /\['gemini', 'zhipu'\]/.test(shared))
  ok('一家失败自动切换另一家（for 循环 attempts）', /for \(const p of order\)/.test(shared))
  ok('Gemini 用 responseMimeType 强制 JSON 输出',
    shared.includes("responseMimeType: 'application/json'"))
  ok('两服务都有超时控制（AbortController）',
    (shared.match(/AbortController/g) || []).length >= 2)
  ok('prompt 明确要求「卷末参考答案回填到题目」（正则做不到的关键点）',
    /卷末如果有独立的「参考答案」/.test(shared))
  ok('prompt 明确「content 不含选项/答案/解析」（避免内容重复输出）',
    /content 里不要包含选项、答案、解析/.test(shared))
  ok('prompt 明确「不要编造答案」', /不要编造/.test(shared))
  ok('温度压到 0.1（结构化抽取要稳）', /temperature: 0\.1/.test(shared))

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
  if (fail) { console.log('❌ AI 试卷识别不变量被破坏'); process.exit(1) }
  console.log('✅ AI 试卷识别全部不变量成立')
} finally {
  await server.close()
}
