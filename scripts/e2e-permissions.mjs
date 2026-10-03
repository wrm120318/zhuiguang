// 【v4.9.7 端到端验证】直接调用 worker 的真实 fetch handler，配 in-memory D1 适配器
// 运行：node scripts/e2e-permissions.mjs
//
// 覆盖：登录 → /auth/me 权限 → 新建 ADMIN（勾权限） → 用该 ADMIN 访问受限接口
//       → 降级清空 → 越权防护 → 个人中心禁改姓名
import { createServer } from 'vite'
import { DatabaseSync } from 'node:sqlite'

globalThis.caches = globalThis.caches || { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } }

// ---------- D1 适配器：包 node:sqlite，实现 prepare().bind().all()/first()/run() ----------
// ⚠️ 注意：bind() 返回的新对象必须是「自带 _args 的完整对象」，且 all/first/run 必须是
//   箭头函数并通过闭包捕获该对象 —— 否则方法从其原型（未绑定的 stmt）调用，参数会丢。
function makeD1(db) {
  return {
    prepare(sql) {
      const build = (args) => {
        const o = {
          _sql: sql,
          _args: args,
          all: () => exec(sql, args, 'all'),
          first: () => exec(sql, args, 'first'),
          run: () => exec(sql, args, 'run'),
        }
        o.bind = (...a) => build(a)
        return o
      }
      return build([])
    },
    async batch(stmts) { return stmts.map(s => s.run()) },
    async exec(sql) { db.exec(sql); return { count: 0, duration: 0 } },
  }
}
function exec(sql, args, mode) {
  const s = db0.prepare(sql)
  if (mode === 'all') return { results: s.all(...args) }
  if (mode === 'first') return s.get(...args) ?? null
  const r = s.run(...args)
  return { meta: { last_row_id: Number(r.lastInsertRowid) }, success: true }
}
let db0

const db = new DatabaseSync(':memory:')
db0 = db
db.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  real_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STUDENT', email TEXT, phone TEXT,
  avatar TEXT DEFAULT '', exp INTEGER DEFAULT 0, level INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
  subject_id INTEGER DEFAULT NULL, permissions TEXT DEFAULT NULL, last_active TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE classes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, grade TEXT, description TEXT, created_at TEXT);
CREATE TABLE class_members (id INTEGER PRIMARY KEY AUTOINCREMENT, class_id INTEGER, user_id INTEGER, role_in_class TEXT, joined_at TEXT);
CREATE TABLE subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, slug TEXT, icon TEXT, color TEXT, description TEXT, display_order INTEGER, modules TEXT, announcement TEXT, forum_auto_approve_threshold INTEGER DEFAULT 0);
CREATE TABLE articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, content TEXT, author TEXT, source TEXT, recommendation TEXT, subject_id INTEGER, user_id INTEGER, class_id INTEGER, cover TEXT, images TEXT, tags TEXT, category TEXT, status TEXT DEFAULT 'pending', actual_user_id INTEGER, views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, subject_id INTEGER, creator_id INTEGER, kind TEXT DEFAULT 'exam', template TEXT DEFAULT '', export_config TEXT DEFAULT '{}');
CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, subject_id INTEGER, creator_id INTEGER);
CREATE TABLE exam_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER, user_id INTEGER, status TEXT);
CREATE TABLE quiz_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER, user_id INTEGER, status TEXT);
CREATE TABLE page_views (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE resources (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, subject_id INTEGER, user_id INTEGER, status TEXT, collects INTEGER DEFAULT 0);
CREATE TABLE exp_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, subject_id INTEGER, action_type TEXT, exp_change INTEGER, description TEXT, created_at TEXT);
CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, content TEXT, type TEXT, is_read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER, to_id INTEGER, content TEXT, attachments TEXT, created_at TEXT);
CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, value TEXT);
CREATE TABLE feature_flags (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, value TEXT);
CREATE TABLE query_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT,
  title TEXT NOT NULL, note TEXT, valid_until TEXT,
  show_comment INTEGER DEFAULT 1, allow_export INTEGER DEFAULT 0,
  headers TEXT, match_field TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE query_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, data_row TEXT);
CREATE TABLE forum_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, name TEXT, color TEXT, created_by INTEGER);
CREATE TABLE pages (id INTEGER PRIMARY KEY AUTOINCREMENT, ptype TEXT, scope TEXT, class_id INTEGER, title TEXT, content TEXT, cover TEXT, images TEXT, attachments TEXT, author_id INTEGER, author_name TEXT, status TEXT DEFAULT 'pending', views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, subject_id INTEGER, topic_ids TEXT, reviewed_by INTEGER, reviewed_at TEXT, review_note TEXT);
CREATE TABLE article_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, article_id INTEGER, user_id INTEGER, content TEXT, parent_id INTEGER, created_at TEXT);
CREATE TABLE page_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, page_id INTEGER, user_id INTEGER, content TEXT, parent_id INTEGER, created_at TEXT);
CREATE TABLE likes_map (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, target_type TEXT, target_id INTEGER);
CREATE TABLE knowledge_points (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, name TEXT, parent_id INTEGER, sort INTEGER);
CREATE TABLE subject_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, creator_id INTEGER, creator_name TEXT, qtype TEXT, content TEXT, options TEXT, answer TEXT, analysis TEXT, score INTEGER, attachments TEXT, sort INTEGER, difficulty TEXT, textbook_version TEXT, region TEXT, chapter TEXT, year TEXT, source TEXT, status TEXT DEFAULT 'active', created_at TEXT);
CREATE TABLE practice_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, question_id INTEGER, user_id INTEGER, subject_id INTEGER, status TEXT, score INTEGER, max_score INTEGER, comment TEXT, graded_by INTEGER, correct INTEGER, graded_at TEXT, created_at TEXT);
CREATE TABLE user_subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, subject_id INTEGER);
CREATE TABLE themes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, config TEXT, is_active INTEGER DEFAULT 0);
`)

const server = await createServer({
  root: '/workspace/zhuiguang',
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

const bcryptMod = await server.ssrLoadModule('bcryptjs').catch(async () => {
  const m = await import('bcryptjs'); return m.default || m
})
const bcrypt = bcryptMod.default || bcryptMod
const worker = (await server.ssrLoadModule('/worker-api.ts')).default

const env = {
  DB: makeD1(db),
  JWT_SECRET: 'test-secret-e2e',
  JWT_EXPIRES: '7d',
  SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_BUCKET: 't',
  STORAGE_BACKEND: 'SUPABASE', CACHE_TTL_PUBLIC: '0', CACHE_TTL_WEBPRI: '0',
}

// 种子：超管 + 教师 + 学生 + 一个已有的「有权限管理员」
const mk = (username, role, perms) => {
  const h = bcrypt.hashSync('pass1234', 8)
  db.prepare(`INSERT INTO users (username,password_hash,real_name,role,permissions,email,status) VALUES (?,?,?,?,?,?,'active')`)
    .run(username, h, username.toUpperCase(), role, perms ? JSON.stringify(perms) : null, `${username}@t.com`)
  return Number(db.prepare('SELECT id FROM users WHERE username=?').get(username).id)
}
const superId = mk('root', 'SUPER_ADMIN', null)
const teachId = mk('teacher1', 'TEACHER', null)
const studId = mk('student1', 'STUDENT', null)
db.prepare("INSERT INTO subjects (name,slug,icon,color,display_order,modules) VALUES ('数学','math','📐','#f59e0b',1,'{}')").run()
db.prepare("INSERT INTO classes (name,grade) VALUES ('一班','高一')").run()
db.prepare("INSERT INTO query_tasks (creator_id,title) VALUES (?,?)").run(studId, '某人的任务')
db.prepare("INSERT INTO query_tasks (creator_id,title) VALUES (?,?)").run(superId, '超管的任务')
db.prepare("INSERT INTO articles (title,content,subject_id,user_id,status) VALUES ('待审美文','x',1,3,'pending')").run()

let pass = 0, fail = 0
async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
  const r = await worker.fetch(new Request('https://t.local' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil() {}, passThroughOnException() {} })
  let data = null
  try { data = await r.clone().json() } catch { data = await r.text() }
  return { status: r.status, data }
}
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}  ${extra}`) }
}
async function login(username) {
  const r = await req('POST', '/api/auth/login', { body: { username, password: 'pass1234' } })
  if (r.status !== 200) throw new Error(`登录 ${username} 失败: ${r.status} ${JSON.stringify(r.data)}`)
  return { token: r.data.token, user: r.data.user }
}

console.log('\n=== A. 登录返回 permissions（超管恒全权）===')
const S = await login('root')
ok('超管登录成功', !!S.token)
ok('超管 /auth/me 返回 13 项权限', (S.user.permissions || []).length === 13, JSON.stringify(S.user.permissions))

console.log('\n=== B. 超管创建 ADMIN（只勾 users + audit）===')
const created = await req('POST', '/api/users', {
  token: S.token,
  body: { username: 'adm1', realName: '管理员一', role: 'ADMIN', password: 'pass1234', email: 'a@t.com', classId: null, permissions: ['users', 'audit', '不存在的key'] },
})
ok('创建管理员成功', created.status === 200, JSON.stringify(created.data))
const adm1Id = created.data.id
const row1 = db.prepare('SELECT role, permissions FROM users WHERE id=?').get(adm1Id)
ok('DB 中 role=ADMIN', row1.role === 'ADMIN')
ok('DB 权限已过滤非法 key', row1.permissions === '["users","audit"]', row1.permissions)

const A1 = await login('adm1')
ok('管理员登录后 /me 返回自己的 2 项权限', JSON.stringify(A1.user.permissions) === '["users","audit"]', JSON.stringify(A1.user.permissions))

console.log('\n=== C. 管理员访问「有权限」的接口 → 放行 ===')
const c1 = await req('GET', '/api/users', { token: A1.token })
ok('GET /api/users（有 users 权限）→ 200', c1.status === 200, `实际 ${c1.status}`)
const c2 = await req('PATCH', `/api/articles/1/status`, { token: A1.token, body: { status: 'approved' } })
ok('审核美文（有 audit 权限）→ 200', c2.status === 200, `实际 ${c2.status} ${JSON.stringify(c2.data)}`)

console.log('\n=== D. 管理员访问「无权限」的接口 → 403 ===')
const d1 = await req('GET', '/api/subjects', { token: A1.token })
ok('GET /api/subjects 是公开接口 → 200（无需权限）', d1.status === 200)
const d2 = await req('POST', '/api/subjects', { token: A1.token, body: { name: '物理', slug: 'phy' } })
ok('POST /api/subjects（无 subjects 权限）→ 403', d2.status === 403, `实际 ${d2.status}`)
const d3 = await req('GET', '/api/exp/all-logs', { token: A1.token })
ok('GET /api/exp/all-logs（无 exp_logs 权限）→ 403', d3.status === 403, `实际 ${d3.status}`)
const d4 = await req('GET', '/api/admin/monitor', { token: A1.token })
ok('GET /api/admin/monitor（无 monitor 权限）→ 403', d4.status === 403, `实际 ${d4.status}`)
const d5 = await req('GET', '/api/admin/storage/config', { token: A1.token })
ok('GET /api/admin/storage/config（无 monitor 权限）→ 403', d5.status === 403, `实际 ${d5.status}`)
const d6 = await req('POST', '/api/themes', { token: A1.token, body: { name: 'x' } })
ok('POST /api/themes（无 theme 权限）→ 403', d6.status === 403, `实际 ${d6.status}`)
const tmpU = await req('POST', '/api/users', { token: S.token, body: { username: 'tmpreset', realName: '临时', role: 'STUDENT', password: 'pass1234', classId: null } })
const d7 = await req('POST', `/api/users/${tmpU.data.id}/reset`, { token: A1.token, body: { password: 'newpwd12' } })
ok('POST /api/users/:id/reset（有 users 权限）→ 200', d7.status === 200, `实际 ${d7.status} ${JSON.stringify(d7.data)}`)

console.log('\n=== E. 教师/学生仍然保持原样 ===')
const T = await login('teacher1')
ok('教师 /api/users → 403（无 users 权限，走原 requireRole）', (await req('GET', '/api/users', { token: T.token })).status === 403)
const eq = await req('POST', '/api/query/tasks', { token: T.token, body: { title: 't', subjectId: 1, classId: null, validUntil: '2099-01-01', showComment: 1, allowExport: 0, headers: [], rows: [], matchField: '' } })
ok('教师 /api/query/tasks → 200（requireStaffOr 放行教师）', eq.status === 200, `实际 ${eq.status} ${JSON.stringify(eq.data)}`)
const ST = await login('student1')
const sq = await req('POST', '/api/query/tasks', { token: ST.token, body: { title: 't', subjectId: 1, classId: null, validUntil: '2099-01-01', showComment: 1, allowExport: 0, headers: [], rows: [], matchField: '' } })
ok('学生 /api/query/tasks → 403', sq.status === 403, `实际 ${sq.status}`)

console.log('\n=== F. 给管理员加 query 权限 → 数据查询放行 ===')
const f1 = await req('PATCH', `/api/users/${adm1Id}`, { token: S.token, body: { permissions: ['users', 'audit', 'query'] } })
ok('超管更新管理员权限 → 200', f1.status === 200, `实际 ${f1.status}`)
const A1b = await login('adm1')
ok('管理员新权限即时生效（auth 实时读库）', JSON.stringify(A1b.user.permissions) === '["users","audit","query"]', JSON.stringify(A1b.user.permissions))
const f2 = await req('DELETE', '/api/query/tasks/1', { token: A1b.token })
ok('管理员删他人查询任务（有 query 权限）→ 200', f2.status === 200, `实际 ${f2.status} ${JSON.stringify(f2.data)}`)

console.log('\n=== G. 降级 → 权限清空 ===')
const g1 = await req('PATCH', `/api/users/${adm1Id}`, { token: S.token, body: { role: 'STUDENT' } })
ok('降级为 STUDENT → 200', g1.status === 200, `实际 ${g1.status}`)
const row2 = db.prepare('SELECT role, permissions FROM users WHERE id=?').get(adm1Id)
ok('降级后 DB role=STUDENT', row2.role === 'STUDENT')
ok('降级后 permissions 被清空（NULL）', row2.permissions === null, String(row2.permissions))
const A1c = await login('adm1')
ok('降级后登录 permissions 为空数组', JSON.stringify(A1c.user.permissions) === '[]', JSON.stringify(A1c.user.permissions))
ok('降级后访问 /api/users → 403', (await req('GET', '/api/users', { token: A1c.token })).status === 403)

console.log('\n=== H. 越权防护 ===')
const h1 = await req('POST', '/api/users', { token: S.token, body: { username: 'adm2', realName: '管理员二', role: 'ADMIN', password: 'pass1234', email: 'old@t.com', classId: null, permissions: ['users'] } })
const adm2Id = h1.data.id
const A2 = await login('adm2')
ok('创建第二个 ADMIN 并只勾 users', A2.user.permissions.length === 1)
const h2 = await req('PATCH', `/api/users/${superId}`, { token: A2.token, body: { role: 'STUDENT' } })
ok('管理员改超管账号 → 403', h2.status === 403, `实际 ${h2.status}`)
const h3 = await req('PATCH', `/api/users/${adm2Id}`, { token: A2.token, body: { role: 'SUPER_ADMIN' } })
ok('管理员改自己的角色 → 403', h3.status === 403, `实际 ${h3.status}`)
const h4 = await req('PATCH', `/api/users/3`, { token: A2.token, body: { role: 'ADMIN' } })
ok('管理员把学生提为 ADMIN → 403', h4.status === 403, `实际 ${h4.status}`)
const h5 = await req('PATCH', `/api/users/${adm2Id}`, { token: A2.token, body: { permissions: ['users', 'monitor'] } })
ok('管理员改自己的权限 → 403', h5.status === 403, `实际 ${h5.status}`)
const h6 = await req('POST', '/api/users', { token: A2.token, body: { username: 'adm3', realName: 'x', role: 'ADMIN', password: 'p1234' } })
ok('管理员创建新 ADMIN → 403', h6.status === 403, `实际 ${h6.status}`)
const h7 = await req('PATCH', `/api/users/3`, { token: A2.token, body: { realName: '改名' } })
ok('管理员改普通学生资料 → 200（有 users 权限，正常业务）', h7.status === 200, `实际 ${h7.status}`)

console.log('\n=== I. 个人中心禁改姓名 ===')
const beforeEmail = db.prepare('SELECT email FROM users WHERE id=?').get(adm2Id).email
const i1 = await req('PATCH', '/api/profile', { token: A2.token, body: { realName: '我想改名字', email: 'new@t.com' } })
// 断言：email 从 old@t.com 被改为 new@t.com，而姓名保持「管理员二」
ok('改前 email 基线为 old@t.com', beforeEmail === 'old@t.com', beforeEmail)
ok('PATCH /api/profile 带 realName → 200', i1.status === 200, `实际 ${i1.status}`)
const nameAfter = db.prepare('SELECT real_name, email FROM users WHERE id=?').get(adm2Id)
ok('姓名未被修改（后端静默忽略）', nameAfter.real_name === '管理员二', nameAfter.real_name)
ok('邮箱正常更新（其他字段不受影响）', nameAfter.email === 'new@t.com', `实际 email=${JSON.stringify(nameAfter.email)}`)
ok('响应带 nameLocked 标记', i1.data.nameLocked === true)

console.log('\n=== J. 批量导入不允许提权 ===')
const j1 = await req('POST', '/api/users/import', { token: S.token, body: { users: [
  { username: 'b1', realName: '批量一', role: 'STUDENT' },
  { username: 'b2', realName: '批量二', role: 'ADMIN' },
  { username: 'b3', realName: '批量三', role: 'SUPER_ADMIN' },
] } })
ok('批量导入 1 成功 2 跳过', j1.data.success === 1 && j1.data.skipped === 2, JSON.stringify(j1.data))

console.log('\n=== K. 白名单：仅超管的接口 ===')
const k1 = await req('POST', '/api/admin/self-repair', { token: A2.token })
ok('管理员访问 self-repair → 403（保持仅超管）', k1.status === 403, `实际 ${k1.status}`)
const k2 = await req('GET', `/api/messages/all/1/2`, { token: A2.token })
ok('管理员查他人私信 → 403（保持仅超管）', k2.status === 403, `实际 ${k2.status}`)

// ============================================================================
// 【v4.10.2】角色文案回归：ADMIN 绝不能被当成「学生」
//
// 背景：v4.9.7 新增 ADMIN 后，全站 10 处角色文案是硬编码三元链
//   `r === 'SUPER_ADMIN' ? '超管' : r === 'TEACHER' ? '教师' : '学生'`
//   → ADMIN 掉进兜底分支，界面显示为「学生」。
// 本节锁定：① API 返回的 role 字段必须原样透出 'ADMIN'（前端才可能正确映射）
//          ② 前端映射函数对 'ADMIN' 必须给出「管理员」
//          ③ 后端角色分布图不能再兜底到「学生」
// ============================================================================
console.log('=== 【v4.10.2】角色文案回归（ADMIN 不得显示为学生）===')

// 造一个真实的 ADMIN 用户
const rl = await req('POST', '/api/users', {
  token: S.token,
  body: { username: 'rolechk', realName: '角色检查员', role: 'ADMIN',
    password: 'pass1234', email: 'rolechk@t.com', classId: null, permissions: ['dashboard'] },
})
ok('创建 ADMIN 用户 → 成功', rl.status === 200 && rl.data?.id, `${rl.status} ${JSON.stringify(rl.data)}`)
const roleUserId = rl.data?.id

// ① 列表接口是否原样透出 role='ADMIN'（若后端把 ADMIN 改写成 STUDENT，前端再怎么映射也没用）
const rlList = await req('GET', '/api/users', { token: S.token })
const rlRow = (rlList.data?.items || rlList.data || []).find(u => u.id === roleUserId)
ok('用户列表原样返回 role=ADMIN（未被后端改写）', rlRow?.role === 'ADMIN', `实际 ${JSON.stringify(rlRow?.role)}`)

// ② 该 USER 自己登录后用 /auth/me，role 也必须是 ADMIN
const rlLogin = await req('POST', '/api/auth/login', { body: { username: 'rolechk', password: 'pass1234' } })
ok('ADMIN 登录 → role=ADMIN', rlLogin.data?.user?.role === 'ADMIN', `实际 ${rlLogin.data?.user?.role}`)
const rlMe = await req('GET', '/api/auth/me', { token: rlLogin.data?.token })
ok('/auth/me → role=ADMIN', rlMe.data?.role === 'ADMIN' || rlMe.data?.user?.role === 'ADMIN',
  `实际 ${rlMe.data?.role ?? rlMe.data?.user?.role}`)

// ③ 前端映射：ADMIN 必须得到「管理员」而非「学生」
console.log('--- 前端映射函数（src/constants/permissions.ts）---')
const permMod = await server.ssrLoadModule('/src/constants/permissions.ts')
const { roleName, roleFullName, roleTagType } = permMod
for (const r of ['SUPER_ADMIN', 'ADMIN', 'TEACHER', 'STUDENT']) {
  const n = roleName(r)
  ok(`roleName('${r}') → ${n}`, n !== '学生' || r === 'STUDENT', n)
}
ok("roleName('ADMIN') === '管理员'（**回归本 bug**）", roleName('ADMIN') === '管理员', roleName('ADMIN'))
ok("roleName('ADMIN') !== '学生'", roleName('ADMIN') !== '学生')
ok("roleFullName('ADMIN') === '管理员'", roleFullName('ADMIN') === '管理员', roleFullName('ADMIN'))
ok("roleTagType('ADMIN') === 'warning'", roleTagType('ADMIN') === 'warning', roleTagType('ADMIN'))
ok("未知角色 roleName('BOGUS') === '未知角色'（不冒充学生）", roleName('BOGUS') === '未知角色', roleName('BOGUS'))

// ④ 后端角色分布图（worker-api.ts 的 roleName）不得把 ADMIN 计入学生
console.log('--- 后端角色分布图映射（worker-api.ts）---')
const wkSrc = (await import('node:fs')).readFileSync('/workspace/zhuiguang/worker-api.ts', 'utf8')
ok('worker-api.ts 无「? 教师 : 学生」三元链', !/^\s*[^/*].*\?\s*'教师'\s*:\s*'学生'/m.test(wkSrc))

// 清理
await req('DELETE', `/api/users/${roleUserId}`, { token: S.token })

console.log(`\n===== 端到端结果：通过 ${pass} / 失败 ${fail} =====`)
await server.close()
process.exit(fail ? 1 : 0)
