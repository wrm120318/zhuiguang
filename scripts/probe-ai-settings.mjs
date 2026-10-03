// v4.13.0 AI 设置探针：超管在管理后台配置 AI 的行为不变量
//
// 用法：node scripts/probe-ai-settings.mjs
//
// 【为什么单独一个探针】
//   v4.13.0 新增「超管在管理界面填智谱 Key / 切换服务商」的能力。
//   这条路线上有三个**极易出错且后果严重**的点，纯靠 code review 看不出来：
//
//   ① **脱敏回显 + 保存即清空**
//      GET 必须脱敏（否则 Key 明文进浏览器），但前端会把脱敏串原样提交回 PUT。
//      如果 PUT 不识别 `****`，一次保存就把真 Key 覆盖成 "abcd****wxyz" —— AI 当场失效，
//      而报错信息只会说"Key 无效"，排查起来极其痛苦。
//
//   ② **配置优先级**
//      后台配置 vs 环境变量。后台空字段不能把环境变量顶掉
//      （否则超管只改 provider，部署时配好的模型全静默失效）。
//
//   ③ **三处权限键一致**
//      worker-api.ts / server/auth.ts / src/constants/permissions.ts
//      少一处就会出现"菜单看得见、接口 403"或反之。
//
// 本探针同时做**静态检查**（三处一致）+ **动态验证**（真实跑一遍 PUT/GET 逻辑）。
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

const ts = readFileSync(`${ROOT}/shared/ai-paper.ts`, 'utf8')
const js = transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' }).code
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { sanitizeAiConfig, mergeAiConfig, maskKey, DEFAULT_AI_CONFIG, AI_CONFIG_KEY } = mod

// 用真实源码模拟后端 PUT 的 Key 处理逻辑（与 worker-api.ts / server/index.ts 同构）
//   ⚠️ 这三行必须与后端**逐字对应**，否则探针会给出假绿灯。
//   本项目已实测踩到过：探针里写 `incoming === ''` 而漏了 trim，
//   于是"纯空白清空 Key"这个真实缺陷被探针放过 —— 后端修好后探针仍报错，
//   反过来逼我先修探针。这类"探针与被测代码不同步"是探针最大的失效模式，
//   所以这里刻意保持与后端一模一样的语句顺序。
function simulatePut(prevKey, incomingBody) {
  const incoming = String(incomingBody?.zhipuKey ?? '').trim()
  const looksMasked = incoming.includes('****')
  const zhipuKey = (incoming === '' || looksMasked) ? prevKey : incoming
  return sanitizeAiConfig({ ...incomingBody, zhipuKey })
}

console.log('=== 1. 脱敏（Key 绝不明文下发到浏览器）===')
ok('maskKey 只留前4后4', maskKey('1234567890abcdef') === '1234****cdef', maskKey('1234567890abcdef'))
ok('maskKey 中间是固定 4 个星号（前端据此识别"未修改"）',
  maskKey('1234567890abcdef') === '1234****cdef')
ok('maskKey 短串全打码（防通过长度侧信道猜 Key）', maskKey('short') === '****', maskKey('short'))
ok('maskKey 恰恰 8 位边界 → 全打码', maskKey('12345678') === '****', maskKey('12345678'))
ok('maskKey 9 位 → 只露前4后4',
  maskKey('123456789') === '1234****6789', maskKey('123456789'))
ok('maskKey 空串 → 空串（不能显示 **** 误导用户"配过了"）', maskKey('') === '', maskKey(''))
ok('maskKey undefined → 空串', maskKey(undefined) === '', maskKey(undefined))
ok('maskKey 结果永不含完整原文',
  !maskKey('1234567890abcdef').includes('567890ab'))

console.log('\n=== 2. 「保存即清空」防坑（最危险的一条）===')
const REAL_KEY = 'abc123def456ghi789.xyz'

// 模拟完整往返：GET（脱敏）→ 前端原样提交 → PUT
const masked = maskKey(REAL_KEY)
const afterNoEdit = simulatePut(REAL_KEY, { provider: 'auto', zhipuKey: masked })
ok('⭐ 回显脱敏串原样提交 → 保留真实 Key（不会清空）',
  afterNoEdit.zhipuKey === REAL_KEY, afterNoEdit.zhipuKey)
ok('回显脱敏串原样提交 → provider 仍能正常更新',
  afterNoEdit.provider === 'auto')

const afterEmpty = simulatePut(REAL_KEY, { provider: 'auto', zhipuKey: '' })
ok('前端提交空串（未填）→ 保留真实 Key', afterEmpty.zhipuKey === REAL_KEY, afterEmpty.zhipuKey)

const afterNew = simulatePut(REAL_KEY, { provider: 'auto', zhipuKey: 'brand.new.key.9999' })
ok('⭐ 用户填了新 Key → 正确覆盖', afterNew.zhipuKey === 'brand.new.key.9999', afterNew.zhipuKey)

const firstTime = simulatePut('', { provider: 'auto', zhipuKey: 'first.key.1234' })
ok('此前没配过 Key → 首次填写能存进去', firstTime.zhipuKey === 'first.key.1234', firstTime.zhipuKey)

const afterClearAttempt = simulatePut(REAL_KEY, { provider: 'auto', zhipuKey: '   ' })
ok('提交纯空白 → 视为未修改，保留原 Key（防误清空）',
  afterClearAttempt.zhipuKey === REAL_KEY, afterClearAttempt.zhipuKey)

console.log('\n=== 3. 配置优先级（后台 > 环境变量 > 默认）===')
const env = { AI_MODEL_CF: '@cf/env-primary', AI_MODEL_CF_FALLBACK: '@cf/env-fb', AI_MODEL_ZHIPU: 'env-glm', ZHIPU_API_KEY: 'env-key' }

const dbWins = mergeAiConfig(env, sanitizeAiConfig({
  provider: 'zhipu', modelCf: '@cf/db-primary', modelCfFallback: '@cf/db-fb', modelZhipu: 'db-glm', zhipuKey: 'db-key',
}))
ok('后台配了的字段 → 后台优先（modelCf）', dbWins.AI_MODEL_CF === '@cf/db-primary', dbWins.AI_MODEL_CF)
ok('后台配了的字段 → 后台优先（provider）', dbWins.AI_PROVIDER === 'zhipu', dbWins.AI_PROVIDER)
ok('后台配了的字段 → 后台优先（zhipuKey）', dbWins.ZHIPU_API_KEY === 'db-key', dbWins.ZHIPU_API_KEY)

const envWins = mergeAiConfig(env, sanitizeAiConfig({ provider: 'auto' }))
ok('⚠️ 后台只改 provider → 环境变量的 modelCf 不被顶掉（防空覆盖）',
  envWins.AI_MODEL_CF === '@cf/env-primary', envWins.AI_MODEL_CF)
ok('⚠️ 后台只改 provider → 环境变量的 modelCfFallback 不被顶掉',
  envWins.AI_MODEL_CF_FALLBACK === '@cf/env-fb', envWins.AI_MODEL_CF_FALLBACK)
ok('⚠️ 后台只改 provider → 环境变量的 zhipuKey 不被顶掉',
  envWins.ZHIPU_API_KEY === 'env-key', envWins.ZHIPU_API_KEY)
ok('⚠️ 后台只改 provider → 环境变量的 modelZhipu 不被顶掉',
  envWins.AI_MODEL_ZHIPU === 'env-glm', envWins.AI_MODEL_ZHIPU)

const defaults = mergeAiConfig({}, sanitizeAiConfig({}))
ok('两者都空 → 内置默认值兜底（provider=auto）', defaults.AI_PROVIDER === 'auto', defaults.AI_PROVIDER)
ok('两者都空 → 内置默认值兜底（modelCf）',
  defaults.AI_MODEL_CF === '@cf/zai-org/glm-4.7-flash', defaults.AI_MODEL_CF)

console.log('\n=== 4. 配置规整（脏输入不能穿透）===')
ok('非法 provider → 回落 auto', sanitizeAiConfig({ provider: 'gpt-5' }).provider === 'auto')
ok('provider 大小写不敏感', sanitizeAiConfig({ provider: 'ZHIPU' }).provider === 'zhipu')
ok('null 输入 → 全默认且不抛', sanitizeAiConfig(null).provider === 'auto')
ok('字符串输入 → 不抛', typeof sanitizeAiConfig('garbage') === 'object')
ok('模型字段带空格 → 被 trim',
  sanitizeAiConfig({ modelCf: '  @cf/x  ' }).modelCf === '@cf/x', sanitizeAiConfig({ modelCf: '  @cf/x  ' }).modelCf)
ok('DEFAULT_AI_CONFIG 合法（provider 是枚举之一）',
  ['cf', 'zhipu', 'auto'].includes(DEFAULT_AI_CONFIG.provider))
ok('AI_CONFIG_KEY 是稳定的表键名', AI_CONFIG_KEY === 'ai_config', AI_CONFIG_KEY)

console.log('\n=== 5. 三处权限键一致（铁律#11）===')
const worker = readFileSync(`${ROOT}/worker-api.ts`, 'utf8')
const localAuth = readFileSync(`${ROOT}/server/auth.ts`, 'utf8')
const localIdx = readFileSync(`${ROOT}/server/index.ts`, 'utf8')
const fPerm = readFileSync(`${ROOT}/src/constants/permissions.ts`, 'utf8')

ok("ai_settings 在 worker-api.ts PERM_KEYS", /'ai_settings'/.test(worker))
ok('ai_settings 在 server/auth.ts PERM_KEYS', /'ai_settings'/.test(localAuth))
ok('ai_settings 在 src/constants/permissions.ts', /'ai_settings'/.test(fPerm))
ok('ai_settings 在前端 PERM_LABELS 有中文名', /ai_settings:\s*'AI 设置'/.test(fPerm))
ok('ai_settings 在前端 PERM_DESC 有说明',
  /ai_settings:\s*'[^']{6,}'/.test(fPerm))

// 提取三处的 key 列表并逐一比对 —— 比"是否包含 ai_settings"更严格
function extractKeys(src, marker) {
  const i = src.indexOf(marker)
  if (i < 0) return []
  const seg = src.slice(i, i + 900)
  const j = seg.indexOf('] as const')
  const body = j > 0 ? seg.slice(0, j) : seg
  return [...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}
const wKeys = extractKeys(worker, 'export const PERM_KEYS')
const aKeys = extractKeys(localAuth, 'export const PERM_KEYS')
const fKeys = extractKeys(fPerm, 'export const PERM_KEYS')
ok(`worker 与 server 权限键集合完全一致（各 ${wKeys.length} 个）`,
  JSON.stringify([...wKeys].sort()) === JSON.stringify([...aKeys].sort()),
  `worker=[${wKeys}] server=[${aKeys}]`)
ok(`worker 与前端权限键集合完全一致（各 ${wKeys.length} 个）`,
  JSON.stringify([...wKeys].sort()) === JSON.stringify([...fKeys].sort()),
  `worker=[${wKeys}] front=[${fKeys}]`)

console.log('\n=== 6. 后端接口实现要点 ===')
for (const [name, src, path] of [
  ['worker', worker, "worker-api.ts"],
  ['server', localIdx, "server/index.ts"],
]) {
  ok(`${name}: GET /api/settings/ai_config 挂在 auth 之后`, /'\/api\/settings\/ai_config',\s*auth/.test(src))
  ok(`${name}: 三个 AI 设置接口都要求 ai_settings 权限`,
    (src.match(/requirePerm\('ai_settings'\)/g) || []).length >= 3,
    `实际 ${(src.match(/requirePerm\('ai_settings'\)/g) || []).length} 处`)
  ok(`${name}: GET 用 maskKey 脱敏后再下发`, /ai_config[\s\S]{0,700}maskKey\(/.test(src))
  ok(`${name}: PUT 识别 **** 并保留原 Key`, /looksMasked/.test(src))
  ok(`${name}: PUT 写入 D1 settings 表（key=ai_config）`,
    /INSERT OR REPLACE INTO settings[\s\S]{0,120}AI_CONFIG_KEY/.test(src))
  ok(`${name}: 有「测试连接」接口`, src.includes("'/api/settings/ai_config/test'"))
  ok(`${name}: 测试接口会真实调用 aiParsePaper`, /ai_config\/test'[\s\S]{0,900}aiParsePaper\(/.test(src))
  ok(`${name}: 读配置失败不会让 AI 整体垮掉（try/catch 兜底）`,
    /function readAiConfig[\s\S]{0,500}catch/.test(src))
}

console.log('\n=== 7. 前端设置页要点 ===')
const view = readFileSync(`${ROOT}/src/views/admin/AiSettingsView.vue`, 'utf8')
ok('设置页存在且是 Vue SFC', /<script setup lang="ts">/.test(view) && /<template>/.test(view))
ok('设置页有 Key 输入框且默认 password 类型', /type="password"/.test(view) || /showKey \? 'text' : 'password'/.test(view))
ok('设置页提供「显示/隐藏」切换', /showKey/.test(view))
ok('设置页有「测试连接」按钮', /测试连接/.test(view))
ok('设置页有「保存设置」按钮', /保存设置/.test(view))
ok('设置页调用 getAiConfig', /api\.getAiConfig\(/.test(view))
ok('设置页调用 saveAiConfig', /api\.saveAiConfig\(/.test(view))
ok('设置页调用 testAiConfig', /api\.testAiConfig\(/.test(view))
ok('设置页展示四种状态（可用性/生效通道/CF/智谱）',
  /AI 服务/.test(view) && /实际生效通道/.test(view) && /Workers AI/.test(view) && /智谱 GLM/.test(view))
ok('⚠️ 设置页说明「CF 零配置」这一关键信息（用户核心诉求）',
  /零配置/.test(view) && /不需要任何 API Key/.test(view))
ok('设置页有服务商三选项', /自动（推荐）/.test(view) && /仅 Cloudflare/.test(view) && /仅智谱/.test(view))
ok('设置页候选模型与后端常量一致（GLM-4.7-Flash 在列）', /@cf\/zai-org\/glm-4\.7-flash/.test(view))

const api = readFileSync(`${ROOT}/src/api/index.ts`, 'utf8')
ok('api 层有 getAiConfig/saveAiConfig/testAiConfig',
  /getAiConfig:/.test(api) && /saveAiConfig:/.test(api) && /testAiConfig:/.test(api))
ok('testAiConfig 超时足够长（AI 调用慢）', /testAiConfig:[\s\S]{0,120}timeout:\s*4[05]000/.test(api))

console.log('\n=== 8. 菜单与路由接入 ===')
const layout = readFileSync(`${ROOT}/src/layouts/AdminLayout.vue`, 'utf8')
const router = readFileSync(`${ROOT}/src/router/index.ts`, 'utf8')
ok('后台菜单含 AI 设置项', /admin-ai-settings/.test(layout))
ok('菜单项的 perm 是 ai_settings', /admin-ai-settings'[\s\S]{0,160}perm:\s*'ai_settings'/.test(layout))
ok('路由注册了 admin-ai-settings', /name:\s*'admin-ai-settings'/.test(router))
ok('路由指向 AiSettingsView.vue', /admin-ai-settings[\s\S]{0,160}AiSettingsView\.vue/.test(router))

console.log('\n=== 9. 用户管理页能勾选新权限（自动跟随 PERM_KEYS）===')
const usersView = readFileSync(`${ROOT}/src/views/admin/UsersView.vue`, 'utf8')
ok('用户管理页遍历 PERM_KEYS 生成勾选框（新增权限自动出现）',
  /PERM_KEYS\.map\(/.test(usersView))
ok('用户管理页用 PERM_LABELS 取中文名', /PERM_LABELS/.test(usersView))
ok('用户管理页用 PERM_DESC 取说明', /PERM_DESC/.test(usersView))

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ AI 设置不变量被破坏'); process.exit(1) }
console.log('✅ AI 设置全部不变量成立')
