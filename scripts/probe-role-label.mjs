// v4.10.2 角色文案探针 · 驱动脚本
//
// 用法：node scripts/probe-role-label.mjs
//
// 背景：v4.9.7 新增 ADMIN 角色时，全站 10 处角色文案是硬编码三元链
//   `r === 'SUPER_ADMIN' ? '超管' : r === 'TEACHER' ? '教师' : '学生'`
//   → ADMIN 掉进兜底分支，全站显示为「学生」。
// 本探针锁死「每个角色都必须映射到正确中文名」，防止再次漏改。
//
// 这里同时做两件事：
//   1) 纯函数层：验证 constants/permissions.ts 的映射表与函数
//   2) **源码扫描层**：全量 grep src/，禁止再出现 `? '教师' : '学生'` 这类
//      三元链（防回归 —— 这是本次 bug 的真正形态）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, extra ? `→ ${extra}` : '') }
}

const server = await createServer({
  root: '/workspace/zhuiguang',
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

try {
  const mod = await server.ssrLoadModule('/src/constants/permissions.ts')
  const { roleName, roleFullName, roleTagType, roleSuffix, ALL_ROLES } = mod

  console.log('=== 1. 四个角色的短名（本次 bug 的核心）===')
  ok('SUPER_ADMIN → 超管', roleName('SUPER_ADMIN') === '超管', roleName('SUPER_ADMIN'))
  ok('ADMIN → 管理员（**曾错误显示为「学生」**）', roleName('ADMIN') === '管理员', roleName('ADMIN'))
  ok('TEACHER → 教师', roleName('TEACHER') === '教师', roleName('TEACHER'))
  ok('STUDENT → 学生', roleName('STUDENT') === '学生', roleName('STUDENT'))

  console.log('=== 2. 未知角色不冒充学生 ===')
  ok('未知角色 → 未知角色（而非「学生」）', roleName('BOGUS') === '未知角色', roleName('BOGUS'))
  ok('undefined → 未知角色', roleName(undefined) === '未知角色', roleName(undefined))
  ok('null → 未知角色', roleName(null) === '未知角色', roleName(null))
  ok('空串 → 未知角色', roleName('') === '未知角色', roleName(''))

  console.log('=== 3. 全名（个人中心 / 聊天头部）===')
  ok('SUPER_ADMIN → 超级管理员', roleFullName('SUPER_ADMIN') === '超级管理员')
  ok('ADMIN → 管理员', roleFullName('ADMIN') === '管理员')
  ok('TEACHER → 学科教师', roleFullName('TEACHER') === '学科教师')
  ok('STUDENT → 学生', roleFullName('STUDENT') === '学生')

  console.log('=== 4. 标签配色（超管红 / 管理员橙 / 教师绿 / 学生灰）===')
  ok('SUPER_ADMIN → danger', roleTagType('SUPER_ADMIN') === 'danger')
  ok('ADMIN → warning', roleTagType('ADMIN') === 'warning')
  ok('TEACHER → success', roleTagType('TEACHER') === 'success')
  ok('STUDENT → info', roleTagType('STUDENT') === 'info')
  ok('未知 → info 兜底', roleTagType('BOGUS') === 'info')
  ok('四个角色配色互不相同',
    new Set(ALL_ROLES.map(r => roleTagType(r))).size === 4)

  console.log('=== 5. 联系人后缀 ===')
  ok('TEACHER → （教师）', roleSuffix('TEACHER') === '（教师）')
  ok('ADMIN → （管理员）', roleSuffix('ADMIN') === '（管理员）')
  ok('SUPER_ADMIN → （超管）', roleSuffix('SUPER_ADMIN') === '（超管）')
  ok('未知角色 → 空串（不污染标签）', roleSuffix('BOGUS') === '')

  console.log('=== 6. ALL_ROLES 覆盖完整 ===')
  ok('ALL_ROLES 含 4 个角色', ALL_ROLES.length === 4, String(ALL_ROLES.length))
  ok('ALL_ROLES 含 ADMIN', ALL_ROLES.includes('ADMIN'))

  // ===== 7. 源码扫描：禁止再写角色三元链（防回归）=====
  console.log('=== 7. 源码扫描：禁止角色三元链（防回归）===')
  const SRC = '/workspace/zhuiguang/src'
  const files = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(vue|ts)$/.test(n)) files.push(p)
    }
  }
  walk(SRC)

  // 反模式：`? '教师' : '学生'` / `? '超管' : ... : '学生'` —— 以学生作兜底
  const badPat = /\?\s*'教师'\s*:\s*'学生'|\?\s*'超管'\s*:[^;{]{0,80}?:\s*'学生'/
  const offenders = []
  for (const f of files) {
    const txt = readFileSync(f, 'utf8')
    txt.split('\n').forEach((line, i) => {
      // 跳过 constants/permissions.ts 里的说明性注释
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (badPat.test(line)) offenders.push(`${f.replace(SRC, 'src')}:${i + 1}`)
    })
  }
  ok('src/ 下无角色硬编码三元链（学生不再作兜底）', offenders.length === 0,
    offenders.join(', '))

  // 正向：确认各页面确实改用了统一函数
  const mustUse = [
    'src/components/NavBar.vue',
    'src/components/MobileTabBar.vue',
    'src/views/ProfileView.vue',
    'src/views/LeaderboardView.vue',
    'src/views/SubjectView.vue',
    'src/views/MessagesView.vue',
    'src/views/admin/UsersView.vue',
    'src/views/admin/ExpLogsView.vue',
  ]
  const missing = mustUse.filter(rel => {
    const txt = readFileSync(join('/workspace/zhuiguang', rel), 'utf8')
    return !/from '@\/constants\/permissions'/.test(txt)
  })
  ok('8 个角色展示页均已接入统一来源', missing.length === 0, missing.join(', '))

  // 移动端「管理」入口必须包含 ADMIN
  const mtb = readFileSync(join('/workspace/zhuiguang/src/components/MobileTabBar.vue'), 'utf8')
  ok('移动端 /admin 入口 roles 含 ADMIN',
    /to: '\/admin'[^}]*roles: \[[^\]]*'ADMIN'/.test(mtb))

  // ===== 8. 后端侧：worker-api.ts 的角色名不可兜底到「学生」=====
  console.log('=== 8. 后端 worker-api.ts 角色名（角色分布图）===')
  const wk = readFileSync('/workspace/zhuiguang/worker-api.ts', 'utf8')
  ok('worker-api.ts 已定义 roleName()', /export function roleName\(/.test(wk))
  ok('worker-api.ts 角色表含 ADMIN → 管理员', /ADMIN: '管理员'/.test(wk))
  ok('worker-api.ts 未知角色返回「未知角色」', /'未知角色'/.test(wk))
  {
    const bad = []
    wk.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (/\?\s*'教师'\s*:\s*'学生'/.test(line)) bad.push(`worker-api.ts:${i + 1}`)
    })
    ok('worker-api.ts 无角色三元链兜底到学生', bad.length === 0, bad.join(', '))
  }

  console.log(`\n===== 角色探针结果：通过 ${pass} / 失败 ${fail} =====`)
  await server.close()
  process.exit(fail ? 1 : 0)
} catch (e) {
  console.error('探针执行异常：', e)
  await server.close()
  process.exit(1)
}
