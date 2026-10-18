// 【v4.18.0 端到端验证】「参加考试」经验值条目 —— 与 quiz_pass/practice_pass 同一业务模式
// 运行：node scripts/probe-exam-exp.mjs
//
// 覆盖：
//   A. 默认经验规则含 exam_attend=10（GET /api/settings/exp_rules）
//   B. 教师创建考试（requireSubjectStaff 放行本学科教师）
//   C. 教师首次录入成绩 → exp_logs 落 exam_attend 记录、users.exp 派生缓存同步
//   D. 修订成绩（UPDATE）→ 不重复发放（防教师每改一次成绩学生重复得经验）
//   E. 另一学生录入 → 独立发放一份
//   F. PUT exp_rules 改 exam_attend=100 → 新考试录入发 100（证明可配置）+ level 联动
//   G. 删除考试 → 不回收经验（与 quiz/practice 删除行为一致）
//   H. 静态检查：后端默认值 + 前端 4 处注册（规则页/说明页/日志筛选/用户页）
import { createServer } from 'vite'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

globalThis.caches = globalThis.caches || { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } }

// ---------- D1 适配器（与 e2e-permissions.mjs 同款）----------
function makeD1(db) {
  return {
    prepare(sql) {
      const build = (args) => {
        const o = {
          _sql: sql, _args: args,
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
// 生产结构（与 worker-api.ts 自动建表一致）
db.exec(`
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  real_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'STUDENT', email TEXT, phone TEXT,
  avatar TEXT DEFAULT '', exp INTEGER DEFAULT 0, level INTEGER DEFAULT 1, status TEXT DEFAULT 'active',
  subject_id INTEGER DEFAULT NULL, permissions TEXT DEFAULT NULL, last_active TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now','+8 hours'))
);
CREATE TABLE subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, slug TEXT, icon TEXT, color TEXT, description TEXT, display_order INTEGER, modules TEXT, announcement TEXT, forum_auto_approve_threshold INTEGER DEFAULT 0);
CREATE TABLE class_members (id INTEGER PRIMARY KEY AUTOINCREMENT, class_id INTEGER, user_id INTEGER, role_in_class TEXT, subject_id INTEGER, joined_at TEXT);
CREATE TABLE user_subjects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, subject_id INTEGER);
CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL, title TEXT NOT NULL, type TEXT DEFAULT 'exam', level TEXT DEFAULT '', exam_date TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT (datetime('now','+8 hours')), status TEXT DEFAULT 'draft', release_password TEXT DEFAULT '', questions TEXT DEFAULT '[]', total_score INTEGER DEFAULT 0);
CREATE TABLE exam_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL, student_id INTEGER NOT NULL, scores TEXT DEFAULT '{}', total INTEGER DEFAULT 0, scan_url TEXT DEFAULT '', comment TEXT DEFAULT '', graded_by INTEGER, graded_at TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')), UNIQUE(exam_id, student_id));
CREATE TABLE exp_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, subject_id INTEGER, action_type TEXT, exp_change INTEGER, description TEXT, created_at TEXT);
CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, value TEXT);
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

// 种子：超管 + 教师（授数学科）+ 两名学生
const mk = (username, role) => {
  const h = bcrypt.hashSync('pass1234', 8)
  db.prepare(`INSERT INTO users (username,password_hash,real_name,role,email,status) VALUES (?,?,?,?,?,'active')`)
    .run(username, h, username.toUpperCase(), role, `${username}@t.com`)
  return Number(db.prepare('SELECT id FROM users WHERE username=?').get(username).id)
}
const superId = mk('root', 'SUPER_ADMIN')
const teachId = mk('teacher1', 'TEACHER')
const studId = mk('student1', 'STUDENT')
const stud2Id = mk('student2', 'STUDENT')
db.prepare("INSERT INTO subjects (name,slug,icon,color,display_order,modules) VALUES ('数学','math','📐','#f59e0b',1,'{}')").run()
db.prepare('INSERT INTO user_subjects (user_id,subject_id) VALUES (?,1)').run(teachId)

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
const expLogsOf = (uid) => db.prepare('SELECT * FROM exp_logs WHERE user_id=? AND action_type=? ORDER BY id').all(uid, 'exam_attend')
const userRow = (uid) => db.prepare('SELECT exp, level FROM users WHERE id=?').get(uid)

console.log('\n=== A. 默认经验规则含 exam_attend（与其他条目同源可配置）===')
const S = await login('root')
const rules = await req('GET', '/api/settings/exp_rules', { token: S.token })
ok('GET /api/settings/exp_rules → 200', rules.status === 200, `实际 ${rules.status}`)
ok('默认规则 exam_attend === 10', rules.data?.exam_attend === 10, `实际 ${rules.data?.exam_attend}`)
ok('exam_attend 与 quiz_pass/practice_pass 同为正向条目',
  [rules.data?.quiz_pass, rules.data?.practice_pass].every(v => v > 0) && rules.data?.exam_attend > 0,
  JSON.stringify({ quiz_pass: rules.data?.quiz_pass, practice_pass: rules.data?.practice_pass, exam_attend: rules.data?.exam_attend }))

console.log('\n=== B. 教师创建考试（requireSubjectStaff 放行本学科教师）===')
const T = await login('teacher1')
const exam1 = await req('POST', '/api/subjects/1/exams', {
  token: T.token,
  body: { title: '期中考试', type: 'exam', level: '', exam_date: '2026-06-01', questions: [{ id: 1, score: 10 }, { id: 2, score: 10 }] },
})
ok('创建考试 → 200', exam1.status === 200, `实际 ${exam1.status} ${JSON.stringify(exam1.data)}`)
const exam1Id = exam1.data?.id
const exam2 = await req('POST', '/api/subjects/1/exams', {
  token: T.token,
  body: { title: '期末考试', type: 'exam', questions: [{ id: 1, score: 20 }] },
})
const exam2Id = exam2.data?.id
ok('创建第二个考试（用于配置变更验证）→ 200', exam2.status === 200, `实际 ${exam2.status}`)

console.log('\n=== C. 教师首次录入成绩 → 发放 exam_attend 经验 ===')
const before = userRow(studId)
const post1 = await req('POST', `/api/exams/${exam1Id}/responses`, {
  token: T.token,
  body: { student_id: studId, scores: { 1: 8, 2: 9 }, comment: '不错' },
})
ok('录入成绩 → 200', post1.status === 200, `实际 ${post1.status} ${JSON.stringify(post1.data)}`)
ok('响应 total=17', post1.data?.total === 17, `实际 ${post1.data?.total}`)
const logs1 = expLogsOf(studId)
ok('exp_logs 落 1 条 exam_attend 记录', logs1.length === 1, `实际 ${logs1.length} 条`)
ok('经验值 = 默认规则 10', logs1[0]?.exp_change === 10, `实际 ${logs1[0]?.exp_change}`)
ok('描述含考试标题与得分', /期中考试/.test(logs1[0]?.description || '') && /得分 17/.test(logs1[0]?.description || ''), logs1[0]?.description)
ok('日志 subject_id 关联学科', logs1[0]?.subject_id === 1, `实际 ${logs1[0]?.subject_id}`)
const after = userRow(studId)
ok('users.exp 派生缓存同步为 10', after.exp === before.exp + 10, `基线 ${before.exp} → 实际 ${after.exp}`)
ok('users.level 按 exp/60+1 计算为 1', after.level === 1, `实际 ${after.level}`)
ok('exam_responses 行已写入', db.prepare('SELECT COUNT(*) c FROM exam_responses WHERE exam_id=? AND student_id=?').get(exam1Id, studId).c === 1)

console.log('\n=== D. 修订成绩（UPDATE）→ 不重复发放 ===')
const post1b = await req('POST', `/api/exams/${exam1Id}/responses`, {
  token: T.token,
  body: { student_id: studId, scores: { 1: 10, 2: 10 } },
})
ok('修订成绩 → 200', post1b.status === 200, `实际 ${post1b.status}`)
const logs1b = expLogsOf(studId)
ok('exp_logs 仍只有 1 条 exam_attend（不重复发）', logs1b.length === 1, `实际 ${logs1b.length} 条`)
ok('users.exp 不变（仍为 10）', userRow(studId).exp === 10, `实际 ${userRow(studId).exp}`)
ok('成绩总分已更新为 20', db.prepare('SELECT total FROM exam_responses WHERE exam_id=? AND student_id=?').get(exam1Id, studId).total === 20)

console.log('\n=== E. 另一名学生录入 → 独立发放一份 ===')
const post2 = await req('POST', `/api/exams/${exam1Id}/responses`, {
  token: T.token,
  body: { student_id: stud2Id, scores: { 1: 7, 2: 6 } },
})
ok('学生2 录入成绩 → 200', post2.status === 200, `实际 ${post2.status}`)
ok('学生2 exp_logs 有 1 条 exam_attend=10', expLogsOf(stud2Id).length === 1 && expLogsOf(stud2Id)[0].exp_change === 10)
ok('学生2 users.exp=10', userRow(stud2Id).exp === 10, `实际 ${userRow(stud2Id).exp}`)
ok('学生1 经验未被学生2 影响（仍为 10）', userRow(studId).exp === 10)

console.log('\n=== F. PUT exp_rules 改 exam_attend=100 → 新录入按新值发放（可配置）===')
const putRules = await req('PUT', '/api/settings/exp_rules', {
  token: S.token,
  body: { ...rules.data, exam_attend: 100 },
})
ok('PUT exp_rules → 200', putRules.status === 200, `实际 ${putRules.status} ${JSON.stringify(putRules.data)}`)
const rules2 = await req('GET', '/api/settings/exp_rules', { token: S.token })
ok('GET 回读 exam_attend=100', rules2.data?.exam_attend === 100, `实际 ${rules2.data?.exam_attend}`)
const post3 = await req('POST', `/api/exams/${exam2Id}/responses`, {
  token: T.token,
  body: { student_id: studId, scores: { 1: 20 } },
})
ok('学生1 参加期末考试录入 → 200', post3.status === 200, `实际 ${post3.status}`)
const logs3 = expLogsOf(studId)
ok('exp_logs 共 2 条 exam_attend（旧10 + 新100）', logs3.length === 2, `实际 ${logs3.length} 条`)
ok('新记录 exp_change=100（配置生效）', logs3[1]?.exp_change === 100, `实际 ${logs3[1]?.exp_change}`)
ok('users.exp = 10 + 100 = 110', userRow(studId).exp === 110, `实际 ${userRow(studId).exp}`)
ok('users.level = 110/60+1 = 2（等级联动）', userRow(studId).level === 2, `实际 ${userRow(studId).level}`)

console.log('\n=== G. 删除考试 → 不回收经验（与 quiz/practice 删除行为一致）===')
const del = await req('DELETE', `/api/exams/${exam2Id}`, { token: T.token })
ok('删除考试 → 200', del.status === 200, `实际 ${del.status}`)
ok('删除后 exp_logs 记录仍在（2 条）', expLogsOf(studId).length === 2, `实际 ${expLogsOf(studId).length} 条`)
ok('删除后 users.exp 不变（110）', userRow(studId).exp === 110, `实际 ${userRow(studId).exp}`)
ok('删除后 exam_responses 已清理', db.prepare('SELECT COUNT(*) c FROM exam_responses WHERE exam_id=?').get(exam2Id).c === 0)

console.log('\n=== H. 静态检查：后端默认值 + 前端 4 处注册 ===')
const wkSrc = readFileSync('/workspace/zhuiguang/worker-api.ts', 'utf8')
ok('worker-api.ts DEFAULT_EXP_RULES 含 exam_attend: 10', /exam_attend:\s*10/.test(wkSrc))
ok('worker-api.ts responses 路由 INSERT 分支调 addExp(..., \'exam_attend\'', /INSERT INTO exam_responses[\s\S]{0,600}?'exam_attend'/.test(wkSrc))
ok('worker-api.ts UPDATE 分支不发放（无重复发放路径）',
  !/UPDATE exam_responses[\s\S]{0,600}?'exam_attend'/.test(wkSrc))
const files = {
  'ExpRulesView（规则配置页）': '/workspace/zhuiguang/src/views/admin/ExpRulesView.vue',
  'ExpDocView（经验说明页）': '/workspace/zhuiguang/src/views/ExpDocView.vue',
  'ExpLogsView（日志筛选）': '/workspace/zhuiguang/src/views/admin/ExpLogsView.vue',
  'UsersView（用户页调整筛选）': '/workspace/zhuiguang/src/views/admin/UsersView.vue',
}
for (const [label, p] of Object.entries(files)) {
  const src = readFileSync(p, 'utf8')
  ok(`${label} 含 exam_attend`, src.includes('exam_attend'), p)
  ok(`${label} 含「参加考试」文案`, src.includes('参加考试'))
}
const ruleMeta = readFileSync(files['ExpRulesView（规则配置页）'], 'utf8')
ok('ExpRulesView RULE_META 注册图标与描述', /key:\s*'exam_attend'[\s\S]{0,200}?label:\s*'参加考试'/.test(ruleMeta))

console.log(`\n===== 探针结果：通过 ${pass} / 失败 ${fail} =====`)
await server.close()
process.exit(fail ? 1 : 0)
