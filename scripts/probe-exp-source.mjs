// v4.11.0 经验值单一真源探针
//
// 用法：node scripts/probe-exp-source.mjs
//
// 背景：经验值曾有两个数据源，靠手写代码同步，必然漂移：
//   · users.exp / users.level   —— 派生缓存，被 addExp 增量更新
//   · SUM(exp_logs.exp_change)  —— 真实流水
// 泄漏点：PATCH /api/users/:id/exp 直接覆盖 users.exp 而不写日志；
//         前端 saveExp() 同时走 grantExp + adjustUserExp 两个分支。
// 结果：admin 用户 users.exp=375 而日志和=360；白楚涵 10 vs 20；梁艺倩/张涵智 5 vs 20。
// 且 /api/users 读日志、/api/leaderboard 读 users.exp → 同一人在两页显示两个数字。
//
// 本探针锁死以下不变量：
//   1) addExp 必须先写 exp_logs，再 syncUserExp（不得用 exp=exp+delta 增量法）
//   2) syncUserExp 必须存在且基于 SUM(exp_change) 全量重算
//   3) 除 syncUserExp 内部外，全文件不得出现 `SET exp=` 直改
//   4) leaderboard 不得把 users.exp 当作权威值返回
//   5) 前端 saveExp 不得再调用 adjustUserExp 做覆盖
import { readFileSync } from 'node:fs'

const ROOT = '/workspace/zhuiguang'
const worker = readFileSync(`${ROOT}/worker-api.ts`, 'utf8')
const usersView = readFileSync(`${ROOT}/src/views/admin/UsersView.vue`, 'utf8')

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

console.log('=== 1. syncUserExp 归一函数存在且语义正确 ===')
ok('worker-api.ts 定义并导出了 syncUserExp', /export async function syncUserExp\s*\(/.test(worker))
ok('syncUserExp 基于 SUM(exp_change) 全量重算',
  /SUM\(exp_change\)\s*FROM exp_logs WHERE user_id=\?/.test(worker))
ok('syncUserExp 同时重算 level', /level\s*=\s*CAST\(MAX\(0,\s*COALESCE\(\(SELECT SUM\(exp_change\)/.test(worker))
ok('提供批量版本 syncUserExpBatch', /export async function syncUserExpBatch\s*\(/.test(worker))

console.log('\n=== 2. addExp 不再使用增量法 ===')
const addExpBody = worker.slice(
  worker.indexOf('export async function addExp('),
  worker.indexOf('export async function addNotice(')
)
ok('addExp 先 INSERT 日志', addExpBody.indexOf('INSERT INTO exp_logs') > -1)
ok('addExp 调用 syncUserExp 重算', /syncUserExp\(userId\)/.test(addExpBody))
ok('addExp 已移除 `exp = MAX(0, exp + ?)` 增量写法',
  !/SET exp = MAX\(0, exp \+ \?\)/.test(addExpBody), '仍存在增量式 UPDATE')
ok('INSERT 出现在 syncUserExp 调用之前（先记账后结算）',
  addExpBody.indexOf('INSERT INTO exp_logs') < addExpBody.indexOf('syncUserExp(userId)'))

console.log('\n=== 3. 全文件禁止直改 users.exp（除 syncUserExp 内部） ===')
// 把 syncUserExp 函数体挖掉后再扫，剩下出现的都算违规
const withoutSync = worker.replace(
  /export async function syncUserExp[\s\S]*?\n}\n/,
  '/* syncUserExp removed */\n'
)
// 只统计真实 SQL 语句（跳过 // / * 注释行，注释里会出现 `SET exp=` 说明文字）
const sqlLines = withoutSync
  .split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n')
const directExp = [...sqlLines.matchAll(/SET\s+exp\s*=/g)]
ok('无残留的 `SET exp=` 直改语句', directExp.length === 0,
  `发现 ${directExp.length} 处`)
const incremental = [...withoutSync.matchAll(/exp\s*=\s*MAX\(0,\s*exp\s*[-+]\s*\?\)/g)]
ok('无残留的增量式 exp 回退（`exp = MAX(0, exp - ?)`）', incremental.length === 0,
  `发现 ${incremental.length} 处`)

console.log('\n=== 4. PATCH /api/users/:id/exp 改为写日志 ===')
const patchIdx = worker.indexOf("app.patch('/api/users/:id/exp'")
const patchBody = worker.slice(patchIdx, patchIdx + 2600)
ok('PATCH 接口存在', patchIdx > -1)
ok('PATCH 不再直接 `UPDATE users SET exp=?`',
  !/UPDATE users SET exp=\? WHERE id=\?/.test(patchBody))
ok('PATCH 会写入 admin_adjust 日志', /'admin_adjust'/.test(patchBody))
ok('PATCH 落日志后调用 syncUserExp', /syncUserExp\(id\)/.test(patchBody))

console.log('\n=== 5. leaderboard 返回真源经验值 ===')
const lbIdx = worker.indexOf("app.get('/api/leaderboard'")
const lbBody = worker.slice(lbIdx, lbIdx + 6000)
ok('基础列表不再 SELECT users.exp 作为权威值',
  !/SELECT id,real_name,role,avatar,exp,level FROM users/.test(lbBody),
  '仍在基础 SELECT 里取 users.exp')
ok('基础列表只取身份字段',
  /SELECT id,real_name,role,avatar FROM users WHERE status=\?/.test(lbBody))
ok('总榜分支回填 exp = 日志和',
  /exp:\s*total,\s*level:\s*Math\.floor\(total \/ 60\) \+ 1,\s*pe:\s*total/.test(lbBody))
const periodBlock = lbBody.slice(lbBody.indexOf("} else {", lbBody.indexOf("period === 'total'")))
ok('周/月榜分支同样回填真源 exp',
  /exp:\s*total,\s*level:\s*Math\.floor\(total \/ 60\) \+ 1/.test(periodBlock))
ok('周/月榜使用带 subject 过滤的累计查询',
  /totalMap\.set\(r\.user_id, r\.total\)/.test(periodBlock))

console.log('\n=== 6. 前端经验调整弹窗为纯增减语义 ===')
ok('saveExp 只调用一次 grantExp', (usersView.match(/api\.grantExp\(/g) || []).length === 1)
ok('saveExp 不再调用 adjustUserExp 覆盖',
  !/adjustUserExp\(/.test(usersView), '仍在调用 adjustUserExp')
ok('弹窗不再有「当前经验」输入框（改为只读展示）',
  !/label="当前经验"[\s\S]{0,120}el-input-number/.test(usersView))
ok('expForm 含 currentExp 只读真源值', /currentExp:\s*Number\(u\.exp\) \|\| 0/.test(usersView))
ok('保存前校验非零变动', /if \(!expForm\.value\.change\)/.test(usersView))
ok('保存按钮有 loading 态防重复提交', /:loading="expSaving"/.test(usersView))

console.log('\n=== 7. /api/users 仍以日志为真源 ===')
ok('/api/users 使用 SUM(exp_change) 聚合',
  /COALESCE\(\(SELECT SUM\(exp_change\) FROM exp_logs WHERE user_id=u\.id\), 0\) AS exp_total/.test(worker))

console.log('\n=== 8. 本地后端（server/）三处一致（铁律#11） ===')
const localHelpers = readFileSync(`${ROOT}/server/helpers.ts`, 'utf8')
const localIndex = readFileSync(`${ROOT}/server/index.ts`, 'utf8')

ok('server/helpers.ts 定义并导出 syncUserExp', /export async function syncUserExp\s*\(/.test(localHelpers))
ok('server/helpers.ts 提供 syncUserExpBatch', /export async function syncUserExpBatch\s*\(/.test(localHelpers))
const lAddExp = localHelpers.slice(
  localHelpers.indexOf('export async function addExp('),
  localHelpers.indexOf('export async function addNotice(')
)
ok('server addExp 先 INSERT 日志再 syncUserExp',
  lAddExp.indexOf('INSERT INTO exp_logs') > -1 && lAddExp.indexOf('INSERT INTO exp_logs') < lAddExp.indexOf('syncUserExp(userId)'))
ok('server addExp 已移除 `exp = exp + ?` 增量写法', !/SET exp = exp \+ \?/.test(lAddExp))
ok('server addExp 不再因 delta=0 直接 return（0 值日志需保留）', !/if \(!delta\) return/.test(lAddExp))

const lWithoutSync = localIndex.replace(
  /\/\*[\s\S]*?syncUserExp 函数[\s\S]*?\*\//, ''
)
const lSqlLines = lWithoutSync.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
ok('server/index.ts 无残留 `SET exp=` 直改', !/SET\s+exp\s*=/.test(lSqlLines),
  '仍存在直改语句')
ok('server/index.ts 已导入 syncUserExp/syncUserExpBatch',
  /syncUserExp,\s*syncUserExpBatch/.test(localIndex))
ok('server PATCH /api/users/:id/exp 写 admin_adjust 日志', /'admin_adjust'/.test(localIndex))
ok('server leaderboard 不取 users.exp 作权威值',
  !/SELECT id,real_name,role,avatar,exp,level FROM users/.test(localIndex))
ok('server leaderboard 基础列表只取身份字段',
  /SELECT id,real_name,role,avatar FROM users WHERE status=\?/.test(localIndex))

console.log(`\n${'─'.repeat(52)}`)
console.log(`结果：${pass} 项通过 / ${fail} 项失败`)
if (fail) { console.log('❌ 经验值单一真源不变量被破坏，请检查上面的失败项'); process.exit(1) }
console.log('✅ 经验值单一真源不变量全部成立')
