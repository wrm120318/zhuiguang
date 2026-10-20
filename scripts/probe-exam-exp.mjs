// 【v4.18.1 端到端验证】「参加考试」经验值条目 —— 业务纠正版
// 运行：node scripts/probe-exam-exp.mjs
//
// 背景（v4.18.1 用户纠正）：「参加考试」指**题库功能中组织的线上考试**
//   （教师在 QuizEditView 创建、学生在 QuizTakeView 在线提交答卷），
//   **不是**考试管理模块中教师录入扫描成绩（exam_responses 网阅打分）。
//
// 覆盖：
//   A. 默认经验规则含 exam_attend=10
//   B. 教师创建线上考试（quizzes）
//   C. 学生提交客观题答卷 → 发 exam_attend（参加即得，不看批改状态）
//   D. 重复提交 → 400 拦截，不重复发放
//   E. 含主观题的考试（pending 分支）→ exam_attend 照发
//   F. PUT exp_rules 改 exam_attend=100 → 新考试按新值发放（可配置）
//   G. 教师录入扫描成绩（exams/:id/responses）→ 不再发 exam_attend（业务纠正）
//   H. 删除线上考试 → 不回收经验（与 quiz_pass 一致）
//   I. 静态检查：ProfileView 中文映射 + 6 个前端文件注册
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
// 生产结构（与 worker-api.ts 实际使用字段一致）
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
CREATE TABLE quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT, title TEXT NOT NULL, description TEXT, duration INTEGER DEFAULT 0, valid_until TEXT, status TEXT DEFAULT 'published', kind TEXT DEFAULT 'exam', template TEXT DEFAULT '', export_config TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE quiz_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER, qtype TEXT, content TEXT, options TEXT, answer TEXT, score INTEGER, attachments TEXT, sort INTEGER);
CREATE TABLE quiz_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER, user_id INTEGER, answers TEXT, total_score INTEGER, max_score INTEGER, status TEXT, submitted_at TEXT, graded_at TEXT, graded_by INTEGER);
CREATE TABLE exams (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER NOT NULL, title TEXT NOT NULL, type TEXT DEFAULT 'exam', level TEXT DEFAULT '', exam_date TEXT DEFAULT '', created_by INTEGER, created_at TEXT DEFAULT (datetime('now','+8 hours')), status TEXT DEFAULT 'draft', release_password TEXT DEFAULT '', questions TEXT DEFAULT '[]', total_score INTEGER DEFAULT 0);
CREATE TABLE exam_responses (id INTEGER PRIMARY KEY AUTOINCREMENT, exam_id INTEGER NOT NULL, student_id INTEGER NOT NULL, scores TEXT DEFAULT '{}', total INTEGER DEFAULT 0, scan_url TEXT DEFAULT '', comment TEXT DEFAULT '', graded_by INTEGER, graded_at TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')), UNIQUE(exam_id, student_id));
CREATE TABLE exp_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, subject_id INTEGER, action_type TEXT, exp_change INTEGER, description TEXT, created_at TEXT);
CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, title TEXT, content TEXT, type TEXT, target_url TEXT, is_read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER, to_id INTEGER, content TEXT, attachments TEXT, created_at TEXT);
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

// 种子：超管 + 教师（任教数学科）+ 两名学生
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
const expLogsOf = (uid, action) => db.prepare('SELECT * FROM exp_logs WHERE user_id=? AND action_type=? ORDER BY id').all(uid, action)
const userRow = (uid) => db.prepare('SELECT exp, level FROM users WHERE id=?').get(uid)

console.log('\n=== A. 默认经验规则含 exam_attend ===')
const S = await login('root')
const T = await login('teacher1')
const ST = await login('student1')
const ST2 = await login('student2')
const rules = await req('GET', '/api/settings/exp_rules', { token: S.token })
ok('默认规则 exam_attend === 10', rules.data?.exam_attend === 10, `实际 ${rules.data?.exam_attend}`)
ok('exam_attend 与 quiz_pass/practice_pass 同为正向条目',
  [rules.data?.quiz_pass, rules.data?.practice_pass].every(v => v > 0) && rules.data?.exam_attend > 0)

const mkQuiz = (title, questions) => req('POST', '/api/quizzes', {
  token: T.token,
  body: { subjectId: 1, classId: null, title, status: 'published', kind: 'exam', questions },
})

console.log('\n=== B. 教师创建线上考试（quizzes，kind=exam）===')
const q1 = await mkQuiz('期中线上考试', [
  { qtype: 'single', content: '1+1=?', options: ['1', '2', '3', '4'], answer: '2', score: 10 },
  { qtype: 'judge', content: '2>1', answer: '对', score: 10 },
])
ok('创建考试1（纯客观题）→ 200', q1.status === 200, `实际 ${q1.status} ${JSON.stringify(q1.data)}`)
const quiz1Id = q1.data?.id
ok('题目已写入 quiz_questions', db.prepare('SELECT COUNT(*) c FROM quiz_questions WHERE quiz_id=?').get(quiz1Id).c === 2)
const q2 = await mkQuiz('期末线上考试', [
  { qtype: 'single', content: '2+2=?', options: ['2', '4', '6', '8'], answer: '4', score: 10 },
  { qtype: 'subjective', content: '简述理由', answer: '', score: 10 },
])
const quiz2Id = q2.data?.id
ok('创建考试2（含主观题，pending 分支）→ 200', q2.status === 200, `实际 ${q2.status}`)

console.log('\n=== C. 学生提交客观题答卷 → 发 exam_attend（参加即得）===')
const before = userRow(studId)
const sub1 = await req('POST', `/api/quizzes/${quiz1Id}/submit`, {
  token: ST.token, body: { answers: { 1: '2', 2: '对' } },
})
ok('提交答卷 → 200', sub1.status === 200, `实际 ${sub1.status} ${JSON.stringify(sub1.data)}`)
ok('自动判分 status=graded、满分 20', sub1.data?.status === 'graded' && sub1.data?.totalScore === 20, JSON.stringify(sub1.data))
const logsAttend = expLogsOf(studId, 'exam_attend')
ok('exp_logs 落 1 条 exam_attend', logsAttend.length === 1, `实际 ${logsAttend.length} 条`)
ok('经验值 = 默认规则 10', logsAttend[0]?.exp_change === 10, `实际 ${logsAttend[0]?.exp_change}`)
ok('描述含考试标题', /期中线上考试/.test(logsAttend[0]?.description || ''), logsAttend[0]?.description)
ok('日志 subject_id 关联学科', logsAttend[0]?.subject_id === 1, `实际 ${logsAttend[0]?.subject_id}`)
const logsQuiz = expLogsOf(studId, 'quiz_pass')
ok('同场考试 quiz_pass 也发放（原逻辑不回归）', logsQuiz.length === 1 && logsQuiz[0]?.exp_change === 10)
const after = userRow(studId)
ok('users.exp = 5(登录) + 10 + 10 = 25（两个条目叠加）', after.exp === before.exp + 20, `基线 ${before.exp} → 实际 ${after.exp}`)

console.log('\n=== D. 重复提交 → 400 拦截，不重复发放 ===')
const sub1b = await req('POST', `/api/quizzes/${quiz1Id}/submit`, {
  token: ST.token, body: { answers: { 1: '2', 2: '对' } },
})
ok('重复提交 → 400「你已提交过该题库」', sub1b.status === 400, `实际 ${sub1b.status}`)
ok('exam_attend 仍只有 1 条', expLogsOf(studId, 'exam_attend').length === 1, `实际 ${expLogsOf(studId, 'exam_attend').length} 条`)
ok('users.exp 不变（25）', userRow(studId).exp === 25, `实际 ${userRow(studId).exp}`)

console.log('\n=== E. 含主观题的考试（pending 分支）→ exam_attend 照发 ===')
const sub2 = await req('POST', `/api/quizzes/${quiz2Id}/submit`, {
  token: ST.token, body: { answers: { 3: '4', 4: '因为对称' } },
})
ok('提交答卷 → 200', sub2.status === 200, `实际 ${sub2.status}`)
ok('status=pending（含主观题待批改）', sub2.data?.status === 'pending', `实际 ${sub2.data?.status}`)
const logsAttend2 = expLogsOf(studId, 'exam_attend')
ok('exam_attend 累计 2 条（pending 也发，不看批改状态）', logsAttend2.length === 2, `实际 ${logsAttend2.length} 条`)
ok('新记录 exp_change=10', logsAttend2[1]?.exp_change === 10, `实际 ${logsAttend2[1]?.exp_change}`)
ok('描述含考试2标题', /期末线上考试/.test(logsAttend2[1]?.description || ''), logsAttend2[1]?.description)
ok('quiz_pass 不重复发（仍 1 条，等教师批改才发）', expLogsOf(studId, 'quiz_pass').length === 1)
ok('users.exp = 25 + 10 = 35', userRow(studId).exp === 35, `实际 ${userRow(studId).exp}`)

console.log('\n=== F. 另一名学生提交 → 独立发放 ===')
const stud1ExpBeforeF = userRow(studId).exp
const sub3 = await req('POST', `/api/quizzes/${quiz1Id}/submit`, {
  token: ST2.token, body: { answers: { 1: '4', 2: '错' } },
})
ok('学生2 提交（全答错）→ 200', sub3.status === 200, `实际 ${sub3.status} ${JSON.stringify(sub3.data)}`)
ok('学生2 exam_attend 照发 1 条（参加即得，不论对错）', expLogsOf(stud2Id, 'exam_attend').length === 1)
ok('学生2 users.exp = 5(登录) + 10(exam_attend) + 10(quiz_pass) = 25', userRow(stud2Id).exp === 25, `实际 ${userRow(stud2Id).exp}`)
ok('学生1 经验不受影响', userRow(studId).exp === stud1ExpBeforeF, `${stud1ExpBeforeF} → ${userRow(studId).exp}`)

console.log('\n=== G. PUT exp_rules 改 exam_attend=100 → 新考试按新值发放 ===')
const putRules = await req('PUT', '/api/settings/exp_rules', {
  token: S.token, body: { ...rules.data, exam_attend: 100 },
})
ok('PUT exp_rules → 200', putRules.status === 200, `实际 ${putRules.status}`)
const rules2 = await req('GET', '/api/settings/exp_rules', { token: S.token })
ok('GET 回读 exam_attend=100', rules2.data?.exam_attend === 100, `实际 ${rules2.data?.exam_attend}`)
const q3 = await mkQuiz('练兵线上考试', [{ qtype: 'single', content: '3+3=?', options: ['3', '6', '9'], answer: '6', score: 5 }])
const quiz3Id = q3.data?.id
const sub4 = await req('POST', `/api/quizzes/${quiz3Id}/submit`, {
  token: ST.token, body: { answers: { 5: '6' } },
})
ok('学生1 参加新考试提交 → 200', sub4.status === 200, `实际 ${sub4.status}`)
const logsAttend3 = expLogsOf(studId, 'exam_attend')
ok('新记录 exp_change=100（配置生效）', logsAttend3[2]?.exp_change === 100, `实际 ${logsAttend3[2]?.exp_change}`)
ok('users.exp = 35 + 100(exam_attend) + 10(quiz_pass) = 145', userRow(studId).exp === 145, `实际 ${userRow(studId).exp}`)
ok('users.level = 145/60+1 = 3（等级联动）', userRow(studId).level === 3, `实际 ${userRow(studId).level}`)

console.log('\n=== H. 教师录入扫描成绩（exams/:id/responses）→ 不再发 exam_attend（业务纠正）===')
const exam1 = await req('POST', '/api/subjects/1/exams', {
  token: T.token,
  body: { title: '线下月考', type: 'exam', questions: [{ id: 1, score: 10 }] },
})
const exam1Id = exam1.data?.id
ok('创建考试管理记录 → 200', exam1.status === 200, `实际 ${exam1.status}`)
const attendBefore = expLogsOf(studId, 'exam_attend').length
const resp1 = await req('POST', `/api/exams/${exam1Id}/responses`, {
  token: T.token, body: { student_id: studId, scores: { 1: 8 } },
})
ok('教师录入成绩 → 200', resp1.status === 200, `实际 ${resp1.status}`)
ok('exam_attend 条数不变（录入成绩不发经验）', expLogsOf(studId, 'exam_attend').length === attendBefore,
  `${attendBefore} → ${expLogsOf(studId, 'exam_attend').length}`)
ok('users.exp 不变（145）', userRow(studId).exp === 145, `实际 ${userRow(studId).exp}`)
const resp1b = await req('POST', `/api/exams/${exam1Id}/responses`, {
  token: T.token, body: { student_id: studId, scores: { 1: 10 } },
})
ok('修订成绩 → 200 且仍不发', resp1b.status === 200 && expLogsOf(studId, 'exam_attend').length === attendBefore)

console.log('\n=== I. 删除线上考试 → 不回收经验（与 quiz_pass 一致）===')
const del = await req('DELETE', `/api/quizzes/${quiz3Id}`, { token: T.token })
ok('删除考试 → 200', del.status === 200, `实际 ${del.status}`)
ok('删除后 exam_attend 记录仍在', expLogsOf(studId, 'exam_attend').length === 3, `实际 ${expLogsOf(studId, 'exam_attend').length} 条`)
ok('删除后 users.exp 不变（145）', userRow(studId).exp === 145, `实际 ${userRow(studId).exp}`)

console.log('\n=== J. 静态检查：ProfileView 中文映射 + 6 个前端文件 ===')
const profSrc = readFileSync('/workspace/zhuiguang/src/views/ProfileView.vue', 'utf8')
ok('ProfileView 不再裸输出 action_type', !/\{\{\s*log\.action_type\s*\}\}/.test(profSrc))
ok('ProfileView 使用 expActionLabel 映射', /\{\{\s*expActionLabel\(log\.action_type\)\s*\}\}/.test(profSrc))
ok('ProfileView 映射表含全部 25 个 action 键',
  ['login', 'register', 'article', 'resource', 'query', 'quiz_pass', 'exam_attend', 'practice_pass',
   'blog', 'forum_post', 'announcement_read', 'message_reply', 'comment', 'like', 'favorite',
   'quiz_fail', 'practice_fail', 'admin_adjust', 'article_delete', 'resource_delete', 'blog_delete',
   'query_delete', 'comment_delete', 'like_cancel', 'favorite_cancel']
   .every(k => profSrc.includes(`'${k}'`)))
const files = {
  'GuideView（经验说明页·真实入口）': '/workspace/zhuiguang/src/views/GuideView.vue',
  'ExpRulesView（规则配置页）': '/workspace/zhuiguang/src/views/admin/ExpRulesView.vue',
  'ExpDocView（遗留说明页）': '/workspace/zhuiguang/src/views/ExpDocView.vue',
  'ExpLogsView（日志筛选）': '/workspace/zhuiguang/src/views/admin/ExpLogsView.vue',
  'UsersView（用户页调整筛选）': '/workspace/zhuiguang/src/views/admin/UsersView.vue',
}
for (const [label, p] of Object.entries(files)) {
  const src = readFileSync(p, 'utf8')
  ok(`${label} 含 exam_attend`, src.includes('exam_attend'), p)
  ok(`${label} 含「参加考试」文案`, src.includes('参加考试'))
}
for (const [label, p] of [['ExpLogsView', '/workspace/zhuiguang/src/views/admin/ExpLogsView.vue'], ['UsersView', '/workspace/zhuiguang/src/views/admin/UsersView.vue']]) {
  ok(`${label} 筛选表含 forum_post（既有遗漏补齐）`, readFileSync(p, 'utf8').includes("value: 'forum_post'"))
}
const wkSrc = readFileSync('/workspace/zhuiguang/worker-api.ts', 'utf8')
ok('worker-api.ts 默认规则含 exam_attend: 10', /exam_attend:\s*10/.test(wkSrc))
ok('worker-api.ts quiz submit 路由发放 exam_attend', /\/api\/quizzes\/:id\/submit[\s\S]{0,3000}?'exam_attend'/.test(wkSrc))
ok('worker-api.ts exams responses 路由不再发 exam_attend', !/\/api\/exams\/:id\/responses[\s\S]{0,1200}?'exam_attend'/.test(wkSrc))

console.log(`\n===== 探针结果：通过 ${pass} / 失败 ${fail} =====`)
await server.close()
process.exit(fail ? 1 : 0)
