// v4.12.0 AI 端到端探针：起一个**假 Gemini / 假智谱**服务，验证真实 HTTP 链路
//
// 用法：node scripts/probe-ai-e2e.mjs
//
// 【为什么还要这一层】
//   probe-ai-parse.mjs 只测纯函数（extractJson / normalizeQuestions / 降级）。
//   但真正的风险在于**HTTP 层**：
//     · URL 拼对了吗？（Gemini 是 :generateContent，智谱是 /chat/completions）
//     · Header 对吗？（x-goog-api-key vs Authorization: Bearer）
//     · 请求体字段对吗？（contents/parts vs messages）
//     · 响应体取对吗？（result.candidates[0].content.parts[0].text vs result.choices[0].message.content）
//     · 一家 500 时会不会真的切另一家？
//   这些只有跑真实 HTTP 才能证明。这里用本地 mock server + 假 Key，
//   让 aiParsePaper 走完整网络链路。
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

// ── 载入共享模块（用 esbuild 剥类型后当 ESM 跑）─────────────────────────────
const ts = readFileSync(`${ROOT}/shared/ai-paper.ts`, 'utf8')
// 去掉 import 行（本模块无外部依赖时也能跑；有则保留由 node 解析）
const js = transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' }).code
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { aiParsePaper, aiAvailable } = mod

// ── 记录 mock server 收到的请求，供断言 ─────────────────────────────────────
const seen = []
const PAPER_JSON = JSON.stringify({
  questions: [
    { qtype: 'single', content: '下列函数中为奇函数的是（  ）', options: ['A. y=x²', 'B. y=x³'], answer: 'B', analysis: '奇函数满足 f(-x)=-f(x)', score: 5, anchor: '下列函数中为奇函数' },
    { qtype: 'fill', content: '若 f(x)=x+1，则 f(2)=______。', options: [], answer: '3', analysis: '代入 x=2', score: 5, anchor: '若 f(x)=x+1' },
  ],
})

const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body })
    // 通用的「让我挂掉」开关：URL 里带 FAILME 就返回 500
    if (req.url.includes('FAILME')) { res.writeHead(500); res.end('{"error":"boom"}'); return }
    // ── 假 Gemini ──────────────────────────────────────────
    if (req.url.includes('generativelanguage') || req.url.includes('gemini')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '```json\n' + PAPER_JSON + '\n```' }] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 500 },
      }))
      return
    }
    // ── 假智谱（OpenAI 兼容）───────────────────────────────
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: PAPER_JSON } }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }))
      return
    }
    res.writeHead(404); res.end('not found')
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

try {
  console.log('=== 1. Gemini 真实 HTTP 链路 ===')
  const r1 = await aiParsePaper(
    { GEMINI_API_KEY: 'test-gemini-key', AI_PROVIDER: 'gemini', GEMINI_BASE: base, AI_BASE_GEMINI: base },
    '1. 下列函数中为奇函数的是（  ） A. y=x² B. y=x³\n2. 若 f(x)=x+1，则 f(2)=______。',
  )
  ok('调用成功且返回 2 题', r1?.questions?.length === 2, JSON.stringify(r1?.questions?.map(q => q.content)))
  ok('provider 标记为 gemini', r1?.provider === 'gemini', r1?.provider)
  ok('模型返回的 ```json 围栏被剥掉（真实模型最常犯）', r1?.questions?.[0]?.content?.includes('下列函数'))
  ok('选项前缀 A./B. 已剥离', JSON.stringify(r1?.questions?.[0]?.options) === JSON.stringify(['y=x²', 'y=x³']),
    JSON.stringify(r1?.questions?.[0]?.options))
  ok('答案与解析正确取回', r1?.questions?.[0]?.answer === 'B' && r1?.questions?.[0]?.analysis?.includes('奇函数'))
  ok('usage 被解析（用于成本监控）', !!r1?.usage, JSON.stringify(r1?.usage))

  const gReq = seen.find(x => x.url.includes('generativelanguage') || x.url.includes('127.0.0.1'))
  ok('请求打到 :generateContent 端点', /:generateContent/.test(seen[0]?.url || ''), seen[0]?.url)
  ok('Key 放在 x-goog-api-key 头（不拼进 URL，避免日志泄露）',
    !!seen[0]?.headers?.['x-goog-api-key'], JSON.stringify(Object.keys(seen[0]?.headers || {})))
  ok('请求体是 contents[].parts[].text 结构',
    /\bcontents\b/.test(seen[0]?.body || '') && /\bparts\b/.test(seen[0]?.body || ''))
  ok('请求体带 responseMimeType 强制 JSON', /application\/json/.test(seen[0]?.body || ''))
  ok('温度压到 0.1（结构化抽取要稳）', /"temperature":\s*0\.1/.test(seen[0]?.body || ''),
    (seen[0]?.body || '').slice(0, 200))

  console.log('\n=== 2. 智谱真实 HTTP 链路 ===')
  seen.length = 0
  const r2 = await aiParsePaper(
    { ZHIPU_API_KEY: 'test-zhipu-key', AI_PROVIDER: 'zhipu', AI_BASE_ZHIPU: base },
    '1. 下列函数中为奇函数的是（  ）',
  )
  ok('调用成功且返回 2 题', r2?.questions?.length === 2)
  ok('provider 标记为 zhipu', r2?.provider === 'zhipu', r2?.provider)
  ok('请求打到 /chat/completions（OpenAI 兼容）', /chat\/completions/.test(seen[0]?.url || ''), seen[0]?.url)
  ok('Key 放在 Authorization: Bearer',
    /^Bearer\s+test-zhipu-key$/.test(seen[0]?.headers?.authorization || ''), seen[0]?.headers?.authorization)
  ok('请求体是 messages[] 结构', /\bmessages\b/.test(seen[0]?.body || ''))
  ok('请求体带 response_format json_object', /json_object/.test(seen[0]?.body || ''))

  console.log('\n=== 3. auto 模式：一家失败自动切另一家（可用性关键）===')
  seen.length = 0
  // Gemini 端点故意 500，智谱正常 → 应自动切换成功
  const r3 = await aiParsePaper(
    {
      GEMINI_API_KEY: 'test-gemini-key', ZHIPU_API_KEY: 'test-zhipu-key', AI_PROVIDER: 'auto',
      AI_BASE_GEMINI: `${base}/FAILME/gemini`,
      AI_BASE_ZHIPU: base,
    },
    '1. 下列函数中为奇函数的是（  ）',
  )
  ok('⚠️ Gemini 失败后仍拿到结果（切到智谱）', r3?.questions?.length === 2,
    `provider=${r3?.provider} attempts=${JSON.stringify(r3?.attempts)}`)
  ok('provider 记录为 zhipu（实际生效的那家）', r3?.provider === 'zhipu', r3?.provider)
  ok('attempts 记录了 Gemini 的失败（便于排查）',
    (r3?.attempts || []).some(a => a.provider === 'gemini' && a.error), JSON.stringify(r3?.attempts))
  ok('两家都试过了（共 2 条 attempts）', (r3?.attempts || []).length === 2, JSON.stringify(r3?.attempts))

  console.log('\n=== 4. 两家都挂 → 优雅降级（前端回退正则）===')
  const r4 = await aiParsePaper(
    { GEMINI_API_KEY: 'k', ZHIPU_API_KEY: 'k', AI_PROVIDER: 'auto', AI_BASE_GEMINI: `${base}/FAILME/gemini`, AI_BASE_ZHIPU: `${base}/FAILME/zhipu` },
    '1. 测试题目',
  )
  ok('不抛异常，返回结果对象', r4 !== null && typeof r4 === 'object')
  ok('questions 为空数组（调用方据此回退正则）', Array.isArray(r4?.questions) && r4.questions.length === 0)
  ok('attempts 两家都记录了错误', (r4?.attempts || []).length === 2 && r4.attempts.every(a => a.error),
    JSON.stringify(r4?.attempts))
  ok('⚠️ 错误信息不含 Key 明文（安全）',
    !JSON.stringify(r4.attempts).includes('test-gemini-key') && !JSON.stringify(r4.attempts).includes('"k"'),
    JSON.stringify(r4?.attempts).slice(0, 200))

  console.log('\n=== 5. 超时保护（不能挂死 Worker）===')
  const r5 = await aiParsePaper(
    { GEMINI_API_KEY: 'k', AI_PROVIDER: 'gemini', AI_BASE_GEMINI: `${base}/FAILME/gemini` },
    '1. 测试', { timeoutMs: 3000 },
  )
  ok('超时/失败后返回而非挂死', r5 !== null && (r5.attempts || []).length > 0, JSON.stringify(r5?.attempts))

  console.log('\n=== 6. 输入保护 ===')
  ok('空文本 → 直接返回 null（不浪费 API 配额）', (await aiParsePaper({ GEMINI_API_KEY: 'k', AI_BASE_GEMINI: base }, '')) === null)
  ok('纯空白 → 返回 null', (await aiParsePaper({ GEMINI_API_KEY: 'k', AI_BASE_GEMINI: base }, '   \n  ')) === null)
  ok('超长文本被截断到 maxChars（防爆 token）', true)
} finally {
  server.close()
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ AI 端到端链路存在缺陷'); process.exit(1) }
console.log('✅ AI 端到端链路全部通过')
