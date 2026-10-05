// v4.13.0 AI 端到端探针：验证 CF Workers AI（REST+绑定）与智谱的真实链路
//
// 用法：node scripts/probe-ai-e2e.mjs
//
// 【为什么还要这一层】
//   probe-ai-parse.mjs 只测纯函数（extractJson / normalizeQuestions / 降级）。
//   但真正的风险在于**HTTP 层 / 绑定层**：
//     · CF 的 URL 拼对了吗？（/accounts/{id}/ai/run/{model}）
//     · CF 的 Header 对吗？（Authorization: Bearer + /ai/run/ 前缀的 model）
//     · 请求体字段对吗？（messages + chat_template_kwargs）
//     · 响应体取对吗？（result.choices[0].message.content — **外面多套了一层 result**）
//     · CF 挂了会不会真的切智谱？
//     · 绑定路径（env.AI.run）能不能正确解析响应？
//   这些只有跑真实链路才能证明。
//
// 【两条路径都要测的原因】
//   生产走**绑定路径**（env.AI.run，零密钥）；本地开发与探针走 **REST 路径**。
//   两条路径的响应解析必须一致，否则会出现"线上好好的、本地测不出来"或反之。
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
const js = transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' }).code
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { aiParsePaper, aiAvailable, effectiveProvider } = mod

// 本地 REST 路径需要 CF 账号/令牌，走 globalThis 注入
globalThis.__CF_ACCOUNT_ID = 'test-account-id'
globalThis.__CF_API_TOKEN = 'test-cf-token'

// ── 记录 mock server 收到的请求，供断言 ─────────────────────────────────────
const seen = []
const PAPER_JSON = JSON.stringify({
  questions: [
    { qtype: 'single', content: '下列函数中为奇函数的是（  ）', options: ['A. y=x²', 'B. y=x³'], answer: 'B', analysis: '奇函数满足 f(-x)=-f(x)', score: 5, anchor: '下列函数中为奇函数' },
    { qtype: 'fill', content: '若 f(x)=x+1，则 f(2)=______。', options: [], answer: '3', analysis: '代入 x=2', score: 5, anchor: '若 f(x)=x+1' },
  ],
})

// CF 真实响应外壳：REST 路径外面套一层 result（这是最容易写错的地方）
const CF_ENVELOPE = (content) => JSON.stringify({
  result: {
    choices: [{ index: 0, message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, neurons: 3.42 },
  },
  success: true,
})

const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body })
    // 通用的「让我挂掉」开关：URL 里带 FAILME 就返回 500
    if (req.url.includes('FAILME')) { res.writeHead(500); res.end('{"error":"boom"}'); return }
    // ── 假 Cloudflare Workers AI ────────────────────────────────────────
    if (req.url.includes('/ai/run/')) {
      // 模拟真实模型爱加 ```json 围栏
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(CF_ENVELOPE('```json\n' + PAPER_JSON + '\n```'))
      return
    }
    // ── 假智谱（OpenAI 兼容）───────────────────────────────────────────
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
  console.log('=== 1. Cloudflare Workers AI · REST 路径真实 HTTP 链路 ===')
  const r1 = await aiParsePaper(
    { AI_BASE_CF: base, AI_PROVIDER: 'cf' },
    '1. 下列函数中为奇函数的是（  ） A. y=x² B. y=x³\n2. 若 f(x)=x+1，则 f(2)=______。',
  )
  ok('调用成功且返回 2 题', r1?.questions?.length === 2, JSON.stringify(r1?.questions?.map(q => q.content)))
  ok('provider 标记为 cf', r1?.provider === 'cf', r1?.provider)
  ok('⚠️ 响应外壳 result.choices[].message.content 被正确解析',
    r1?.questions?.[0]?.content?.includes('下列函数'), r1?.questions?.[0]?.content)
  ok('模型返回的 ```json 围栏被剥掉（真实模型最常犯）',
    !String(r1?.questions?.[0]?.content || '').includes('```'))
  ok('选项前缀 A./B. 已剥离', JSON.stringify(r1?.questions?.[0]?.options) === JSON.stringify(['y=x²', 'y=x³']),
    JSON.stringify(r1?.questions?.[0]?.options))
  ok('答案与解析正确取回', r1?.questions?.[0]?.answer === 'B' && r1?.questions?.[0]?.analysis?.includes('奇函数'))
  ok('usage 被解析（用于成本监控）', !!r1?.usage, JSON.stringify(r1?.usage))
  ok('⚠️ neurons 用量被解析出来（CF 计费口径）',
    r1?.usage?.neurons === 3.42, JSON.stringify(r1?.usage))

  ok('请求打到 /ai/run/{model} 端点', /\/ai\/run\//.test(seen[0]?.url || ''), seen[0]?.url)
  ok('⚠️ URL 里 model 带 @cf/ 前缀（写错就 404）',
    /\/ai\/run\/@cf\//.test(seen[0]?.url || ''), seen[0]?.url)
  ok('⚠️ URL 包含 accounts/{account_id}（REST 路径必需，早期实现会漏）',
    /accounts\/test-account-id\/ai\/run\//.test(seen[0]?.url || ''), seen[0]?.url)
  ok('Key 放在 Authorization: Bearer（不拼进 URL）',
    /^Bearer\s+test-cf-token$/.test(seen[0]?.headers?.authorization || ''), seen[0]?.headers?.authorization)
  ok('请求体是 messages[] 结构（OpenAI 兼容）', /\bmessages\b/.test(seen[0]?.body || ''))
  // 【v4.15.0 断言修正】enable_thinking 是**按模型名条件添加**的：
  //   只有 GLM / Qwen3 / DeepSeek / QwQ 这类"默认会吐思维链"的模型才加，
  //   Llama / Granite 等无 thinking 模式的模型传了可能报错，故**故意不加**。
  //
  //   旧断言写成"请求体必须带 enable_thinking"，在默认模型是 GLM 时巧合成立；
  //   现在默认模型改为 IBM Granite-4.0-H-Micro（最省），该断言就假失败了。
  //   正确做法：分别验证两条分支，而不是只看一次请求。
  //   ① 当前默认模型（granite）→ 不应带该字段
  ok('⚠️ 默认模型（Granite，无思维链）不带 enable_thinking',
    !/"enable_thinking"/.test(seen[0]?.body || ''),
    (seen[0]?.body || '').slice(0, 200))
  //   ② 显式指定 GLM 模型 → 必须带上（这才是"省神经元"的真正生效路径）
  {
    seen.length = 0
    await aiParsePaper(
      { AI_BASE_CF: base, AI_PROVIDER: 'cf', AI_MODEL_CF: '@cf/zai-org/glm-4.7-flash' },
      '1. 测（  ） A. 甲 B. 乙',
    )
    ok('⚠️ GLM 模型请求体带 enable_thinking=false（关思维链省神经元）',
      /"enable_thinking":\s*false/.test(seen[0]?.body || ''),
      (seen[0]?.body || '').slice(0, 240))
  }
  ok('请求体带 system prompt（含「试卷排版工程师」）',
    /试卷排版工程师/.test(seen[0]?.body || ''))
  ok('温度压到 0.1（结构化抽取要稳）', /"temperature":\s*0\.1/.test(seen[0]?.body || ''),
    (seen[0]?.body || '').slice(0, 200))

  console.log('\n=== 2. Cloudflare Workers AI · 绑定路径（生产路径）===')
  // 生产走 env.AI.run()，不经过公网、不需要任何 Key
  let boundModel = ''
  const binding = {
    run: async (model, payload) => {
      boundModel = model
      // 模拟绑定返回**未经 result 包裹**的响应（真实绑定就是这样）
      return {
        choices: [{ message: { content: PAPER_JSON } }],
        usage: { prompt_tokens: 800, completion_tokens: 400, neurons: 2.1 },
      }
    },
  }
  const r2 = await aiParsePaper({ AI: binding, AI_PROVIDER: 'cf' }, '1. 绑定路径测试题')
  ok('⭐ 绑定路径（零密钥）调用成功', r2?.questions?.length === 2, JSON.stringify(r2?.questions?.length))
  ok('provider 标记为 cf', r2?.provider === 'cf', r2?.provider)
  ok('⚠️ 绑定返回的裸 choices[].message.content 也能解析（与 REST 外壳不同）',
    r2?.questions?.[0]?.content?.includes('下列函数'), r2?.questions?.[0]?.content)
  ok('绑定路径解析出 neurons 用量', r2?.usage?.neurons === 2.1, JSON.stringify(r2?.usage))
  ok('⚠️ 绑定路径传给模型的是模型 ID（不能带 URL 前缀）',
    boundModel.startsWith('@cf/'), boundModel)

  console.log('\n=== 3. 智谱真实 HTTP 链路（可选备份通道）===')
  seen.length = 0
  const r3 = await aiParsePaper(
    { ZHIPU_API_KEY: 'test-zhipu-key', AI_PROVIDER: 'zhipu', AI_BASE_ZHIPU: base },
    '1. 下列函数中为奇函数的是（  ）',
  )
  ok('调用成功且返回 2 题', r3?.questions?.length === 2)
  ok('provider 标记为 zhipu', r3?.provider === 'zhipu', r3?.provider)
  ok('请求打到 /chat/completions（OpenAI 兼容）', /chat\/completions/.test(seen[0]?.url || ''), seen[0]?.url)
  ok('Key 放在 Authorization: Bearer',
    /^Bearer\s+test-zhipu-key$/.test(seen[0]?.headers?.authorization || ''), seen[0]?.headers?.authorization)
  ok('请求体是 messages[] 结构', /\bmessages\b/.test(seen[0]?.body || ''))
  ok('请求体带 response_format json_object', /json_object/.test(seen[0]?.body || ''))

  console.log('\n=== 4. auto 模式：CF 失败自动切智谱（可用性关键）===')
  seen.length = 0
  const r4 = await aiParsePaper(
    {
      AI_BASE_CF: `${base}/FAILME/cf`,   // CF 端故意 500
      ZHIPU_API_KEY: 'test-zhipu-key',
      AI_PROVIDER: 'auto',
      AI_BASE_ZHIPU: base,
    },
    '1. 下列函数中为奇函数的是（  ）',
  )
  ok('⚠️ CF 失败后仍拿到结果（切到智谱）', r4?.questions?.length === 2,
    `provider=${r4?.provider} attempts=${JSON.stringify(r4?.attempts)}`)
  ok('provider 记录为 zhipu（实际生效的那家）', r4?.provider === 'zhipu', r4?.provider)
  ok('attempts 记录了 cf 的失败（便于排查）',
    (r4?.attempts || []).some(a => a.provider === 'cf' && a.error), JSON.stringify(r4?.attempts))
  ok('两个通道都试过了（共 2 条 attempts）', (r4?.attempts || []).length === 2, JSON.stringify(r4?.attempts))

  console.log('\n=== 5. 两通道都挂 → 优雅降级（前端回退正则）===')
  const r5 = await aiParsePaper(
    {
      AI_BASE_CF: `${base}/FAILME/cf`, ZHIPU_API_KEY: 'secret-zhipu-key',
      AI_PROVIDER: 'auto', AI_BASE_ZHIPU: `${base}/FAILME/zhipu`,
    },
    '1. 测试题目',
  )
  ok('不抛异常，返回结果对象', r5 !== null && typeof r5 === 'object')
  ok('questions 为空数组（调用方据此回退正则）', Array.isArray(r5?.questions) && r5.questions.length === 0)
  ok('attempts 两通道都记录了错误', (r5?.attempts || []).length === 2 && r5.attempts.every(a => a.error),
    JSON.stringify(r5?.attempts))
  ok('⚠️ 错误信息不含 Key 明文（安全）',
    !JSON.stringify(r5.attempts).includes('secret-zhipu-key'),
    JSON.stringify(r5?.attempts).slice(0, 200))

  console.log('\n=== 6. 绑定路径超时保护（不能挂死 Worker）===')
  const hangBinding = { run: () => new Promise(() => {}) }  // 永不 resolve
  const t0 = Date.now()
  const r6 = await aiParsePaper({ AI: hangBinding, AI_PROVIDER: 'cf' }, '1. 测试', { timeoutMs: 1500 })
  const took = Date.now() - t0
  ok('⚠️ 绑定永不返回时超时兜底（不挂死）', r6 !== null && (r6.attempts || []).length > 0,
    JSON.stringify(r6?.attempts))
  ok('超时时间在预期范围内（1.5s~8s）', took < 8000, `${took}ms`)

  console.log('\n=== 7. 输入保护 ===')
  ok('空文本 → 直接返回 null（不浪费 AI 额度）',
    (await aiParsePaper({ AI: binding }, '')) === null)
  ok('纯空白 → 返回 null',
    (await aiParsePaper({ AI: binding }, '   \n  ')) === null)

  console.log('\n=== 8. 可用性口径（用户核心诉求回归）===')
  ok('⭐ 只绑 CF、零密钥 → 可用（用户要的"不用申请 Key"）',
    aiAvailable({ AI: binding }) === true)
  ok('有智谱 Key → 可用', aiAvailable({ ZHIPU_API_KEY: 'k' }) === true)
  ok('什么都没有 → 不可用', aiAvailable({}) === false)
  ok('auto + 只绑 CF → 实际生效 cf', effectiveProvider({ AI: binding }) === 'cf')
} finally {
  server.close()
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ AI 端到端链路存在缺陷'); process.exit(1) }
console.log('✅ AI 端到端链路全部通过')
