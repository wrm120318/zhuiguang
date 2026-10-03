// 【v4.9.7 验证】真实链路验证：加载 worker-api.ts，验证权限核心逻辑
// 运行：node scripts/verify-permissions.mjs
//
// 说明：worker-api.ts 依赖 Workers 运行时全局（caches / D1Database 等）。
//   这里只做最小 polyfill —— 我们测的是「纯函数」parsePerms / hasPerm / PERM_KEYS，
//   不触发任何请求，D1 等只要不报 ReferenceError 即可。
globalThis.caches = globalThis.caches || { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } }
globalThis.D1Database = globalThis.D1Database || class {}

import { createServer } from 'vite'

const server = await createServer({
  root: '/workspace/zhuiguang',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

let mod
try {
  mod = await server.ssrLoadModule('/worker-api.ts')
} catch (e) {
  console.error('加载 worker-api.ts 失败：', e.message)
  await server.close()
  process.exit(1)
}

const { PERM_KEYS, parsePerms, hasPerm } = mod
let pass = 0, fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log('\n=== 1. PERM_KEYS 定义 ===')
ok('PERM_KEYS 是数组且 13 项', Array.isArray(PERM_KEYS) && PERM_KEYS.length === 13, `实际 ${PERM_KEYS?.length}`)
const expectKeys = ['dashboard','users','subjects','classes','audit','query','guide','site_config','exp_rules','exp_logs','feature_flags','theme','monitor']
ok('13 个 key 与方案完全一致', JSON.stringify([...PERM_KEYS]) === JSON.stringify(expectKeys), JSON.stringify([...PERM_KEYS]))

console.log('\n=== 2. parsePerms 解析健壮性 ===')
ok('null → []', JSON.stringify(parsePerms(null)) === '[]')
ok('undefined → []', JSON.stringify(parsePerms(undefined)) === '[]')
ok("空字符串 → []", JSON.stringify(parsePerms('')) === '[]')
ok("合法 JSON 数组正常解析", JSON.stringify(parsePerms('["users","audit"]')) === '["users","audit"]')
ok("已是数组也接受", JSON.stringify(parsePerms(['theme'])) === '["theme"]')
ok("非法 JSON → []", JSON.stringify(parsePerms('{bad json')) === '[]')
ok("JSON 对象（非数组）→ []", JSON.stringify(parsePerms('{"a":1}')) === '[]')
ok("过滤未知 key", JSON.stringify(parsePerms('["users","hacker","audit"]')) === '["users","audit"]')
ok("数字/布尔值 → []", JSON.stringify(parsePerms(123)) === '[]' && JSON.stringify(parsePerms(true)) === '[]')

console.log('\n=== 3. hasPerm 语义（超管恒真 + 管理员按数组 + 其他角色拒绝）===')
const superU = { id: 1, role: 'SUPER_ADMIN', permissions: [] }
const adminU = { id: 2, role: 'ADMIN', permissions: ['users', 'audit'] }
const adminEmpty = { id: 3, role: 'ADMIN', permissions: [] }
const teacherU = { id: 4, role: 'TEACHER', permissions: ['users'] }  // 教师即便带了权限也不认
const studentU = { id: 5, role: 'STUDENT', permissions: ['users'] }

ok('超管 permissions 为空仍全权（users）', hasPerm(superU, 'users') === true)
ok('超管权限被清空仍全权（monitor）', hasPerm(superU, 'monitor') === true)
ok('管理员有 users → true', hasPerm(adminU, 'users') === true)
ok('管理员有 audit → true', hasPerm(adminU, 'audit') === true)
ok('管理员无 subjects → false', hasPerm(adminU, 'subjects') === false)
ok('管理员无 monitor → false', hasPerm(adminU, 'monitor') === false)
ok('空权限管理员任何 key → false', expectKeys.every(k => hasPerm(adminEmpty, k) === false))
ok('教师虽是 TEACHER 但有 users 也不认 → false', hasPerm(teacherU, 'users') === false)
ok('学生不认 → false', hasPerm(studentU, 'users') === false)
ok('null 用户 → false', hasPerm(null, 'users') === false)
ok('permissions 非数组（脏数据）→ false', hasPerm({ role: 'ADMIN', permissions: 'users' }, 'users') === false)

console.log('\n=== 4. 前端常量与后端 key 一致性 ===')
try {
  const fe = await server.ssrLoadModule('/src/constants/permissions.ts')
  ok('前端 PERM_KEYS 与后端完全一致', JSON.stringify([...fe.PERM_KEYS]) === JSON.stringify([...PERM_KEYS]),
    `前端=${JSON.stringify([...fe.PERM_KEYS])}`)
  ok('每个 key 都有中文名', fe.PERM_KEYS.every(k => typeof fe.PERM_LABELS[k] === 'string' && fe.PERM_LABELS[k]))
  ok('每个 key 都有说明', fe.PERM_KEYS.every(k => typeof fe.PERM_DESC[k] === 'string' && fe.PERM_DESC[k]))
  ok('sanitizePerms 过滤未知 key', JSON.stringify(fe.sanitizePerms(['users', 'x', 'audit'])) === '["users","audit"]')
  console.log('  中文名：', fe.PERM_KEYS.map(k => fe.PERM_LABELS[k]).join(' / '))
} catch (e) {
  fail++
  console.log('  ❌ 加载前端常量失败：', e.message)
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`)
await server.close()
process.exit(fail ? 1 : 0)
