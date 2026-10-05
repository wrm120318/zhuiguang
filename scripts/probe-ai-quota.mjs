// v4.15.0 AI 额度熔断与用量记账探针
//
// 用法：node scripts/probe-ai-quota.mjs
//
// 【为什么单独一个探针】
//   用户原话：「我今天用都没用 AI，但是居然一直提示我用量耗尽！！！
//              给我在超级管理员后台 AI 设置里面加上剩余用量 和 使用记录」。
//
//   查证（2026-10-05，直连 Cloudflare GraphQL Analytics 拉到的真实数据）：
//     · 10-03   28 次请求 /   887.0 神经元
//     · 10-04  132 次请求 / 10633.7 神经元   ← 一天吃满 10000 免费额度
//     · 10-05  120 次请求 /     0.0 神经元   ← 额度未回血，全部被拒
//   注意 10-05：用户说"没用"，但确实打了 120 次 —— 那是**被拒绝的无效重试**。
//
//   本探针守住三个新不变量，它们每一条都直接对应用户踩到的坑：
//     ① 额度耗尽必须**可识别**（HTTP 429 + 业务码 4006 + 特定文案，三者兜底）
//     ② 额度耗尽必须**立即熔断**：不重试、不换模型、不跑剩余分块
//        （旧代码按"频率限制"处理 → 一次识别最多 9 次注定失败的请求）
//     ③ 失败也**必须记账**（只记成功的话，后台数字小于账单，永远解释不了现象）
//
//   ⚠️ 这些行为纯靠 code review 极难保证：熔断逻辑散落在三层嵌套循环里，
//     少一处 break 就会退化成"重试到天荒地老"。
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

/** 把 TS 源内联成可执行模块（避免额外构建步骤） */
function loadTs(rel, exportNames) {
  const src = readFileSync(`${ROOT}/${rel}`, 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', target: 'es2020' }).code
  const mod = js
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
    .replace(/export\s*\{[^}]*\}/g, '')
  return new Function(`${mod}\nreturn { ${exportNames.join(', ')} }`)()
}

const sharedSrc = readFileSync(`${ROOT}/shared/ai-paper.ts`, 'utf8')
const workerSrc = readFileSync(`${ROOT}/worker-api.ts`, 'utf8')
const serverSrc = readFileSync(`${ROOT}/server/index.ts`, 'utf8')
const dbSrc = readFileSync(`${ROOT}/server/db.ts`, 'utf8')
const viewSrc = readFileSync(`${ROOT}/src/views/admin/AiSettingsView.vue`, 'utf8')
const apiSrc = readFileSync(`${ROOT}/src/api/index.ts`, 'utf8')
const wrangler = readFileSync(`${ROOT}/wrangler.toml`, 'utf8')

const { isQuotaExhausted, CF_FREE_DAILY_NEURONS, BUDGET_MODEL_CF, DEFAULT_MODEL_CF, aiFailureMessage } =
  loadTs('shared/ai-paper.ts', ['isQuotaExhausted', 'CF_FREE_DAILY_NEURONS', 'BUDGET_MODEL_CF', 'DEFAULT_MODEL_CF', 'aiFailureMessage'])

console.log('\n=== 1. 额度耗尽识别（实测的 CF 真实返回必须能命中）===')

// 这是 2026-10-05 实打实抓到的响应体（去掉 ray-id）
const REAL_CF_429 = 'CF Workers AI HTTP 429: {"errors":[{"message":"AiError: AiError: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.","code":4006}],"success":false,"result":{},"messages":[]}'
ok('⭐ 真实 CF 429 响应被识别为额度耗尽', isQuotaExhausted(new Error(REAL_CF_429)) === true)
ok('⭐ 纯业务码 4006 也能识别（文案被 CF 改掉时的兜底）',
  isQuotaExhausted(new Error('{"code":4006}')) === true)
ok('⭐ "daily free allocation" 英文文案能识别',
  isQuotaExhausted(new Error('you have used up your daily free allocation')) === true)
ok('⭐ 大小写不敏感（CF 文案可能变）',
  isQuotaExhausted(new Error('Used Up Your Daily Free Allocation')) === true)
ok('⭐ 直接传字符串（不只 Error 对象）也能识别',
  isQuotaExhausted('AiError: you have used up your daily free allocation of 10,000 neurons') === true)

// ⚠️ 反向：普通 429 频率限制**不能**被误判为额度耗尽，否则会错误熔断
ok('⚠️ 普通频率限制（429 rate limit）不被误判为额度耗尽',
  isQuotaExhausted(new Error('CF Workers AI HTTP 429: too many requests')) === false)
ok('⚠️ 网络超时不被误判', isQuotaExhausted(new Error('调用超时（90000ms）')) === false)
ok('⚠️ 模型过载不被误判', isQuotaExhausted(new Error('Model is overloaded')) === false)
ok('⚠️ 空错误不误判', isQuotaExhausted(new Error('')) === false)
ok('⚠️ null/undefined 不抛异常', isQuotaExhausted(null) === false && isQuotaExhausted(undefined) === false)

console.log('\n=== 2. 熔断：额度耗尽后不得继续尝试（这是 120 次无效请求的根源）===')

ok('⭐ parseOneChunk 识别到额度耗尽后置位 quotaExhausted',
  /if \(isQuota\) \{ quotaExhausted = true; break \}/.test(sharedSrc))
ok('⭐ 额度耗尽时跳出**模型循环**（不再试备用/廉价模型）',
  /if \(quotaExhausted\) break/.test(sharedSrc))
ok('⭐ 额度耗尽时不走「频率限制退避重试」分支（重试无意义）',
  /if \(isQuota\) \{ quotaExhausted = true; break \}\s*\n\s*if \(isRateLimit\(e\)/.test(sharedSrc))
ok('⭐ quotaExhausted 通过返回值上报（让上层能取消剩余分块）',
  /return \{ questions, provider: 'cf', model: m, usage, attempts, quotaExhausted \}/.test(sharedSrc)
  && /questions: \[\], provider: '', model: '', attempts, quotaExhausted/.test(sharedSrc))
ok('⭐ aiParsePaper 并发池带 breaker：一个块判定耗尽 → 全部停手',
  /let breaker = false/.test(sharedSrc) && /if \(breaker\) \{ out\[cursor\+\+\]/.test(sharedSrc))
ok('⭐ 池中熔断后仍占位（不改变结果数组长度，避免下游下标错位）',
  /out\[cursor\+\+\] = \{ questions: \[\], provider: '', model: '', attempts: \[\], quotaExhausted: true \}/.test(sharedSrc))
ok('⭐ breaker 在任一结果命中时置位',
  /if \(r\.quotaExhausted\) breaker = true/.test(sharedSrc))
ok('⭐ 短卷单次调用路径也上报 quotaExhausted',
  /quotaExhausted = !!r\.quotaExhausted/.test(sharedSrc))
ok('⭐ AiParseResult 透出 quotaExhausted 字段',
  /quotaExhausted\?: boolean/.test(sharedSrc))

console.log('\n=== 3. 关键设计：CF 额度耗尽但配了智谱时，仍应继续用智谱 ===')
// 额度是 CF 独有概念；智谱是另一套独立额度，不该被 CF 的熔断连坐
ok('⭐ CF 段额度耗尽走 continue（不 return，让 order 里的智谱继续）',
  /if \(quotaExhausted\) \{[\s\S]{0,300}?continue/.test(sharedSrc))
ok('⭐ 设计意图有注释说明（防止后人误改成 return）',
  /智谱是另一套独立额度/.test(sharedSrc))

console.log('\n=== 4. 用量记账（用户要的"使用记录"）===')

ok('⭐ 共享层定义 AI_USAGE_SINK 回调（而非直接写库，保持纯函数层可移植）',
  /AI_USAGE_SINK\?: AiUsageSink/.test(sharedSrc))
ok('⭐ AiUsageRecord 结构完备（含失败标记与额度耗尽标记）',
  /interface AiUsageRecord/.test(sharedSrc)
  && /ok: boolean/.test(sharedSrc) && /quotaExhausted\?: boolean/.test(sharedSrc)
  && /neurons\?: number/.test(sharedSrc) && /scene\?: string/.test(sharedSrc))
ok('⭐ emitUsage 有 try/catch：记账失败绝不外溢影响 AI 主流程',
  /function emitUsage[\s\S]{0,900}?catch \{ \/\* 记账失败绝不外溢 \*\/ \}/.test(sharedSrc))
ok('⭐ emitUsage 先校验 sink 是否为函数（未注入时静默返回）',
  /const sink = env\.AI_USAGE_SINK\s*\n\s*if \(typeof sink !== 'function'\) return/.test(sharedSrc))
ok('⭐ 成功路径记账', /ok: true,\s*\n\s*elapsedMs: Date\.now\(\) - t0, usage,/.test(sharedSrc))
ok('⭐ 失败路径也记账（否则无法解释"我没用却在跑"）',
  /ok: false, error: rawErr,/.test(sharedSrc))
ok('⭐ "跑通但没解析出题"也记账（它是真实消耗，不记会让后台数字小于账单）',
  /模型 \$\{m\} 未解析出题目[\s\S]{0,200}?emitUsage/.test(sharedSrc))
ok('⭐ neurons 取 CF 返回值，不本地估算',
  /CF 的 usage\.neurons 是权威值/.test(sharedSrc))
ok('⭐ 记账上报场景与触发者（供后台按用户/场景统计）',
  /scene: env\.AI_SCENE \|\| 'paper_parse'/.test(sharedSrc)
  && /actorId: env\.AI_ACTOR\?\.id/.test(sharedSrc))

console.log('\n=== 5. 后端接入（双后端必须一致）===')

for (const [name, src] of [['worker-api.ts', workerSrc], ['server/index.ts', serverSrc]]) {
  ok(`⭐ ${name} 注入 AI_USAGE_SINK`,
    /AI_USAGE_SINK: logAiUsage/.test(src))
  // ⚠️ 两后端的 run() 语义不同，不能要求同一句 catch：
  //   · worker（D1）：run() 返回 Promise → 必须 .catch 兜住异步失败
  //   · server（better-sqlite3）：run() 同步执行 → 靠外层 try/catch 兜住
  //   所以这里只断言"有 logAiUsage 且整体被 try/catch 保护"，不写死某一种写法。
  ok(`⭐ ${name} 定义 logAiUsage 且整体有 try/catch 保护`,
    /function logAiUsage\(rec: AiUsageRecord\): void \{[\s\S]{0,900}?catch \{/.test(src))
  ok(`⭐ ${name} day 取 UTC 日期（与 CF 计费口径一致）`,
    /const day = iso\.slice\(0, 10\)/.test(src))
  ok(`⭐ ${name} aiEnv 支持传 actor/scene`,
    /async function aiEnv\(actor\?: AiActor, scene\?: string\)/.test(src))
  ok(`⭐ ${name} 透出 quotaExhausted 给前端`,
    /quotaExhausted: !!result\?\.quotaExhausted/.test(src))
  ok(`⚠️ ${name} 配置区补注入 5 个高级旋钮（v4.13.8 漏接的环境变量）`,
    /AI_TEMPERATURE: num(Env|Cfg)\(/.test(src)
    && /AI_CHUNK_QUESTIONS: num(Env|Cfg)\(/.test(src)
    && /AI_MAX_TOKENS: num(Env|Cfg)\(/.test(src)
    && /AI_CONCURRENCY: num(Env|Cfg)\(/.test(src)
    && /AI_RETRY_ATTEMPTS: num(Env|Cfg)\(/.test(src))
}

ok('⭐ worker-api 建 ai_usage_log 表（幂等自愈）',
  /CREATE TABLE IF NOT EXISTS ai_usage_log/.test(workerSrc))
ok('⭐ server/db.ts 建同名同构表（双后端同步铁律）',
  /CREATE TABLE IF NOT EXISTS ai_usage_log/.test(dbSrc))
ok('⭐ 三个索引齐备（day / model / actor）',
  /idx_ai_usage_day/.test(workerSrc) && /idx_ai_usage_model/.test(workerSrc) && /idx_ai_usage_actor/.test(workerSrc)
  && /idx_ai_usage_day/.test(dbSrc) && /idx_ai_usage_model/.test(dbSrc) && /idx_ai_usage_actor/.test(dbSrc))

// 两处表结构字段必须一致（否则线上与本地行为分叉，且本地测不出线上问题）
// 表定义是**多行字符串**，且两文件的主键/换行风格略有差异，所以只提取"列名"集合比较。
const colsOf = (src) => {
  const start = src.indexOf('CREATE TABLE IF NOT EXISTS ai_usage_log')
  if (start < 0) return ''
  const seg = src.slice(start, start + 1400)
  const end = seg.indexOf('PRIMARY KEY AUTOINCREMENT')
  const body = seg.slice(end >= 0 ? end : 0, seg.indexOf(')`)'))
  return body.split('\n')
    .map(l => l.replace(/[`,]/g, ' ').trim())
    .filter(Boolean)
    .map(l => l.split(/\s+/)[0])
    // 只保留合法列名（过滤掉注释行残留、SQL 关键字残片）
    .filter(x => /^[a-z][a-z0-9_]*$/.test(x))
    .filter(x => !['id', 'PRIMARY', 'FOREIGN', 'UNIQUE'].includes(x) || x === 'id')
    .sort().join(',')
}
const wCols = colsOf(workerSrc), sCols = colsOf(dbSrc)
ok('⭐ 两后端 ai_usage_log 字段逐字一致（防双后端漂移）',
  wCols.length > 0 && wCols === sCols, `worker=[${wCols}] server=[${sCols}]`)
ok('⭐ 关键列齐备（失败标记 / 额度耗尽标记 / 神经元 / 触发者 / 场景）',
  ['ok', 'quota_exhausted', 'neurons', 'actor_id', 'scene', 'day', 'elapsed_ms', 'error']
    .every(c => wCols.includes(c)), wCols)

console.log('\n=== 6. 查询接口（用户要的"剩余用量"）===')

// ⚠️ 这一节曾经只查 workerSrc，导致 v4.15.0 首次落地时 server/index.ts
//   漏了全部 4 个端点，而探针全绿 —— 本地访问直接落进 SPA 兜底返回 HTML。
//   教训：凡是"前端会调用"的端点，必须在**两个后端**都断言存在。
for (const [name, src] of [['worker-api.ts', workerSrc], ['server/index.ts', serverSrc]]) {
  ok(`⭐ ${name} GET /api/admin/ai-usage 存在且需 ai_settings 权限`,
    /app\.get\('\/api\/admin\/ai-usage', auth, requirePerm\('ai_settings'\)/.test(src))
  ok(`⭐ ${name} GET /api/admin/ai-quota 直连 CF 查账户级真实额度`,
    /app\.get\('\/api\/admin\/ai-quota', auth, requirePerm\('ai_settings'\)/.test(src))
  ok(`⭐ ${name} PURGE 接口（防日志把库撑爆）`,
    /app\.post\('\/api\/admin\/ai-usage\/purge'/.test(src))
  ok(`⭐ ${name} 一键切省额度模型接口`,
    /app\.post\('\/api\/admin\/ai-usage\/use-budget-model'/.test(src))
  // 端点注册必须早于 SPA 兜底，否则命中不到、返回 index.html
  const idxRoute = src.search(/app\.(get|post)\('\/api\/admin\/ai-usage'/)
  const idxSplat = src.search(/app\.get\('\/(\{\*splat\}|\*|:splat\*?)'/)
  ok(`⭐ ${name} 新端点注册早于 SPA 兜底路由（否则会返回 HTML）`,
    idxRoute > 0 && (idxSplat < 0 || idxRoute < idxSplat), `route@${idxRoute} splat@${idxSplat}`)
  // utcDayMinus 是这一块内部依赖，漏了会直接 500
  ok(`⭐ ${name} 定义 utcDayMinus（额度窗口计算依赖）`,
    /function utcDayMinus\(n: number\): string \{/.test(src))
}

// ── 响应结构逐字对齐：前端只认一套字段名，两边必须给出同一形状 ──
const shapeKeys = ['quota', 'today', 'window', 'byDay', 'byModel', 'byScene', 'byActor',
  'byError', 'logs', 'logTotal', 'logPage', 'logLimit', 'currentModel', 'budgetModel']
const missingIn = (src) => shapeKeys.filter(k => !new RegExp(`\\b${k}[:(,]`).test(src))
const wMiss = missingIn(workerSrc), sMiss = missingIn(serverSrc)
ok('⭐ 两后端 ai-usage 响应字段集合一致（前端只解析一套）',
  JSON.stringify(wMiss) === JSON.stringify(sMiss), `worker缺=[${wMiss}] server缺=[${sMiss}]`)
ok('⭐ 响应字段齐备（14 项）',
  wMiss.length === 0 && sMiss.length === 0, `worker缺=[${wMiss}] server缺=[${sMiss}]`)

// ── quota 子对象的语义必须两边一致，否则"剩余用量"会算错 ──
for (const [name, src] of [['worker-api.ts', workerSrc], ['server/index.ts', serverSrc]]) {
  ok(`⭐ ${name} quota 口径正确（limit/used/remain/percent/exhausted/day）`,
    /limit: CF_FREE_DAILY_NEURONS/.test(src)
    && /remain: Math\.max\(0, CF_FREE_DAILY_NEURONS - usedToday\)/.test(src)
    && /percent: Math\.min\(100, \(usedToday \/ CF_FREE_DAILY_NEURONS\) \* 100\)/.test(src)
    && /exhausted: quotaHitToday \|\| usedToday >= CF_FREE_DAILY_NEURONS/.test(src)
    && /day: todayUtc/.test(src))
}

// ── purge 的 keepDays 夹取范围必须一致（防止一边能删光、一边不能）──
for (const [name, src] of [['worker-api.ts', workerSrc], ['server/index.ts', serverSrc]]) {
  ok(`⭐ ${name} purge 夹取 keepDays 到 7~365`,
    /Math\.min\(365, Math\.max\(7, Number\(body\?\.keepDays\) \|\| 30\)\)/.test(src))
}

// ── 降级路径：未配 CF 凭据时必须优雅返回而不是 500 ──
for (const [name, src] of [['worker-api.ts', workerSrc], ['server/index.ts', serverSrc]]) {
  ok(`⭐ ${name} ai-quota 无凭据时降级 available:false`,
    /if \(!accountId \|\| !token\) \{[\s\S]{0,200}?available: false/.test(src))
}
ok('⭐ quota 口径：limit/used/remain/percent/exhausted 全给',
  /limit: CF_FREE_DAILY_NEURONS/.test(workerSrc) && /remain: Math\.max\(0, CF_FREE_DAILY_NEURONS - usedToday\)/.test(workerSrc)
  && /exhausted: quotaHitToday \|\| usedToday >= CF_FREE_DAILY_NEURONS/.test(workerSrc))
ok('⭐ 聚合维度齐备：byDay / byModel / byScene / byActor / byError',
  /byDay: byDayRows\.map/.test(workerSrc) && /byModel: byModel\.map/.test(workerSrc)
  && /byScene: byScene\.map/.test(workerSrc) && /byActor: byActor\.map/.test(workerSrc)
  && /byError: byError\.map/.test(workerSrc))
ok('⭐ 明细支持分页 + 筛选（ok/model/scene/actorId）',
  /okFilter === '1' \|\| okFilter === '0'/.test(workerSrc) && /modelFilter/.test(workerSrc)
  && /sceneFilter/.test(workerSrc) && /actorFilter/.test(workerSrc)
  && /LIMIT \? OFFSET \?/.test(workerSrc))
ok('⭐ CF GraphQL 用 aiInferenceAdaptiveGroups（实测可用的数据集）',
  /aiInferenceAdaptiveGroups/.test(workerSrc))
ok('⭐ CF GraphQL 取 sum.totalNeurons（实测字段名，不是 neurons）',
  /sum \{ totalNeurons \}/.test(workerSrc))
ok('⭐ 未配 CF Token 时降级为 available:false 而非报错',
  /available: false,[\s\S]{0,200}?未配置 CF_ACCOUNT_ID \/ CF_API_TOKEN/.test(workerSrc))
ok('⭐ 查询失败有 try/catch 兜底',
  /读取 AI 用量失败/.test(workerSrc))

console.log('\n=== 7. 前端接入 ===')

ok('⭐ api 层暴露 aiUsage / aiQuota / purgeAiUsage / useBudgetModel',
  /aiUsage:/.test(apiSrc) && /aiQuota:/.test(apiSrc)
  && /purgeAiUsage:/.test(apiSrc) && /useBudgetModel:/.test(apiSrc))
ok('⭐ 设置页展示「用量与额度」', /用量与额度/.test(viewSrc))
ok('⭐ 设置页展示剩余额度与进度条',
  /剩余/.test(viewSrc) && /el-progress/.test(viewSrc))
ok('⭐ 设置页明确"账号级共享"（解释用户困惑的关键文案）', /账号级共享/.test(viewSrc))
ok('⭐ 设置页给出重置时间（北京时间 8 点）',
  /北京时间/.test(viewSrc))
ok('⭐ 设置页有额度耗尽告警 + 可执行补救入口',
  /今日免费额度已耗尽/.test(viewSrc) && /一键切到省额度模型/.test(viewSrc))
ok('⭐ 设置页有使用记录表格 + 分页 + 筛选',
  /使用记录/.test(viewSrc) && /el-pagination/.test(viewSrc) && /logFilter/.test(viewSrc))
ok('⭐ 设置页区分"本地记账"与"CF 实测"并解释差额原因',
  /两个数字为什么可能不同/.test(viewSrc))
ok('⭐ 失败原因 TOP 展示（能看出被拒的无效请求）', /失败原因 TOP/.test(viewSrc))
ok('⭐ 清理历史记录入口', /清理历史记录/.test(viewSrc))
ok('⭐ AI 识别前端识别到额度耗尽时给出专门提示',
  /quotaExhausted/.test(readFileSync(`${ROOT}/src/components/WordPaperSplitEditor.vue`, 'utf8'))
  && /quotaExhausted/.test(readFileSync(`${ROOT}/src/components/WordImportPanel.vue`, 'utf8')))

console.log('\n=== 8. 配置默认值自保（防止额度又被一天烧完）===')

ok('⭐ 免费额度常量 = 10000（与 CF 官方一致）', CF_FREE_DAILY_NEURONS === 10000)
ok('⭐ 默认主力模型 = 全场最省的 granite-4.0-h-micro',
  DEFAULT_MODEL_CF === '@cf/ibm-granite/granite-4.0-h-micro', DEFAULT_MODEL_CF)
ok('⭐ 省额度目标模型与默认一致（一键切换幂等）',
  BUDGET_MODEL_CF === DEFAULT_MODEL_CF, BUDGET_MODEL_CF)
ok('⭐ wrangler.toml 主力模型已改为最省模型',
  /AI_MODEL_CF = "@cf\/ibm-granite\/granite-4\.0-h-micro"/.test(wrangler))
ok('⭐ wrangler.toml 备用模型也便宜（避免主力失败后烧更贵）',
  /AI_MODEL_CF_FALLBACK = "@cf\/zai-org\/glm-4\.7-flash"/.test(wrangler))
ok('⭐ wrangler.toml 注释澄清"账号级共享"（未来维护者不会再误判）',
  /账户级共享/.test(wrangler))

console.log('\n=== 9. 错误提示必须给出可执行的下一步 ===')
// 用户踩坑的本质不是"没有报错"，而是"报错之后不知道该干什么"
const msg = aiFailureMessage([{ provider: 'cf', error: 'daily free allocation' }], true)
ok('⭐ 额度耗尽提示含"账号级共享"（解释为什么我没用却耗尽）', /账号级/.test(msg))
ok('⭐ 额度耗尽提示含具体重置时间', /UTC 0 点|北京时间/.test(msg))
ok('⭐ 额度耗尽提示给出至少两条补救路径', /AI 设置/.test(msg) && /智谱/.test(msg))
ok('⚠️ 普通频率限制仍走原提示（不误报额度耗尽）',
  /繁忙/.test(aiFailureMessage([{ provider: 'cf', error: '429 too many requests' }])))

console.log('\n' + '─'.repeat(52))
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail === 0) console.log('✅ AI 额度熔断与用量记账全部不变量成立\n')
else { console.log('❌ AI 额度相关不变量被破坏\n'); process.exit(1) }
