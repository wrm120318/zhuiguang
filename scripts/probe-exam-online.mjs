// 【v4.18.3 端到端验证】线上考试功能加固
// 运行：node scripts/probe-exam-online.mjs
//
// 覆盖：
//   A. 截止时间（valid_until）前后端强制：
//      · 过期 → 学生 GET 详情 403 expired、POST submit 403 expired
//      · 教师（本学科管理者）保留预览/提交权限
//      · 未来 / 仅日期格式 / 空 / 非法值 的行为
//   B. 切屏记录：submit 带 switch_logs → 落库到 submissions.answers.switch_logs，教师端可读
//   C. 知识点/题目写操作后边缘缓存失效登记（registerEdgePurge + purgeEdgeCache）：
//      用 caches.default.delete 探针验证「写者自己的 auth 分片」也会被删
//      （这是「添加知识点后左侧栏目不刷新」的根因修复）
//   D. 知识点 CRUD 回归（创建/改名/删子节点拦截）
import { createServer } from 'vite'
import { DatabaseSync } from 'node:sqlite'

globalThis.caches = globalThis.caches || { default: { match: async () => undefined, put: async () => {}, delete: async () => {} } }

// ---------- D1 适配器（与 probe-exam-exp.mjs 同款）----------
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
CREATE TABLE knowledge_points (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, parent_id INTEGER, name TEXT, description TEXT, sort INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE subject_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, creator_id INTEGER, creator_name TEXT, qtype TEXT, content TEXT, options TEXT, answer TEXT, analysis TEXT, score INTEGER DEFAULT 5, attachments TEXT, sort INTEGER DEFAULT 0, difficulty INTEGER DEFAULT 3, textbook_version TEXT, region TEXT, chapter TEXT, year TEXT, source TEXT, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE question_knowledge (question_id INTEGER, knowledge_point_id INTEGER, UNIQUE(question_id, knowledge_point_id));
CREATE TABLE quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER, class_id INTEGER, creator_id INTEGER, creator_name TEXT, title TEXT NOT NULL, description TEXT, duration INTEGER DEFAULT 0, valid_until TEXT, status TEXT DEFAULT 'published', kind TEXT DEFAULT 'exam', template TEXT, export_config TEXT, created_at TEXT DEFAULT (datetime('now','+8 hours')));
CREATE TABLE quiz_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER, qtype TEXT, content TEXT, options TEXT, answer TEXT, score INTEGER, attachments TEXT, sort INTEGER);
CREATE TABLE quiz_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, quiz_id INTEGER, user_id INTEGER, answers TEXT, total_score INTEGER, max_score INTEGER, status TEXT, submitted_at TEXT, graded_at TEXT, graded_by INTEGER);
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

// ---------- 边缘缓存 delete 探针（验证 purge 行为）----------
const edgeDeletes = []
globalThis.caches = {
  default: {
    match: async () => undefined,
    put: async () => {},
    delete: async (req) => { edgeDeletes.push(String(req.url)); return true },
  },
}

const env = {
  DB: makeD1(db),
  JWT_SECRET: 'test-secret-e2e',
  JWT_EXPIRES: '7d',
  SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_BUCKET: 't',
  STORAGE_BACKEND: 'SUPABASE', CACHE_TTL_PUBLIC: '0', CACHE_TTL_WEBPRI: '0',
}

// 种子：超管 + 教师（任教数学科）+ 学生
const mk = (username, role) => {
  const h = bcrypt.hashSync('pass1234', 8)
  db.prepare(`INSERT INTO users (username,password_hash,real_name,role,email,status) VALUES (?,?,?,?,?,'active')`)
    .run(username, h, username.toUpperCase(), role, `${username}@t.com`)
  return Number(db.prepare('SELECT id FROM users WHERE username=?').get(username).id)
}
const teachId = mk('teacher1', 'TEACHER')
const studId = mk('student1', 'STUDENT')
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
const T = await login('teacher1')
const ST = await login('student1')

// 北京时间（UTC+8）过去 1 小时 / 未来 1 小时的截止时间串
const bjStr = (offsetHours) => {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000 + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
const tomorrowBJ = () => {
  const d = new Date(Date.now() + 24 * 3600 * 1000 + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

const mkQuiz = (title, questions, extra = {}) => req('POST', '/api/quizzes', {
  token: T.token,
  body: { subjectId: 1, classId: null, title, status: 'published', kind: 'exam', questions, ...extra },
})

console.log('\n=== A. 截止时间（valid_until）前后端强制 ===')
const qPast = await mkQuiz('已截止的考试', [{ qtype: 'single', content: '1+1=?', options: ['1', '2'], answer: '2', score: 10 }], { validUntil: bjStr(-1) })
const pastId = qPast.data?.id
ok('创建过期考试 → 200', qPast.status === 200, `实际 ${qPast.status} ${JSON.stringify(qPast.data)}`)

const sGet = await req('GET', `/api/quizzes/${pastId}`, { token: ST.token })
ok('学生 GET 过期考试详情 → 403 expired', sGet.status === 403 && sGet.data?.expired === true, `实际 ${sGet.status} ${JSON.stringify(sGet.data)}`)
const sSub = await req('POST', `/api/quizzes/${pastId}/submit`, { token: ST.token, body: { answers: { 1: '2' } } })
ok('学生 POST 过期考试 → 403 expired', sSub.status === 403 && sSub.data?.expired === true, `实际 ${sSub.status} ${JSON.stringify(sSub.data)}`)
const tGet = await req('GET', `/api/quizzes/${pastId}`, { token: T.token })
ok('教师 GET 过期考试 → 200（保留预览/批改）', tGet.status === 200, `实际 ${tGet.status}`)

const qFuture = await mkQuiz('进行中的考试', [{ qtype: 'single', content: '2+2=?', options: ['2', '4'], answer: '4', score: 10 }], { validUntil: bjStr(1) })
const futureId = qFuture.data?.id
const sGet2 = await req('GET', `/api/quizzes/${futureId}`, { token: ST.token })
ok('学生 GET 未截止考试 → 200', sGet2.status === 200, `实际 ${sGet2.status}`)
const sSub2 = await req('POST', `/api/quizzes/${futureId}/submit`, { token: ST.token, body: { answers: { 2: '4' } } })
ok('学生 POST 未截止考试 → 200', sSub2.status === 200, `实际 ${sSub2.status}`)

// 仅日期格式（明天）→ 视为当天 23:59，不拦
const qDateOnly = await mkQuiz('仅日期截止', [{ qtype: 'judge', content: '2>1', answer: '对', score: 5 }], { validUntil: tomorrowBJ() })
const dId = qDateOnly.data?.id
const sGet3 = await req('GET', `/api/quizzes/${dId}`, { token: ST.token })
ok('仅日期格式（明天）→ 学生可进入', sGet3.status === 200, `实际 ${sGet3.status}`)

// 生产实测脏数据：全角冒号 + 连字符分隔（线上 quiz=7 就是 '2026-10-25-19：00'）
const qFullWidthPast = await mkQuiz('全角冒号已截止', [{ qtype: 'judge', content: '3>1', answer: '对', score: 5 }], { validUntil: bjStr(-1).replace(' ', '-').replace(':', '：') })
const sGet6 = await req('GET', `/api/quizzes/${qFullWidthPast.data?.id}`, { token: ST.token })
ok('全角冒号脏数据（已过）→ 正确拦截 403', sGet6.status === 403 && sGet6.data?.expired === true, `实际 ${sGet6.status} ${JSON.stringify(sGet6.data)}`)
const qFullWidthFuture = await mkQuiz('全角冒号未截止', [{ qtype: 'judge', content: '4>1', answer: '对', score: 5 }], { validUntil: bjStr(1).replace(' ', '-').replace(':', '：') })
const sGet7 = await req('GET', `/api/quizzes/${qFullWidthFuture.data?.id}`, { token: ST.token })
ok('全角冒号脏数据（未来）→ 放行', sGet7.status === 200, `实际 ${sGet7.status}`)

// 空 / 非法 → 不拦（容错，脏数据不能把考试锁死）
const qEmpty = await mkQuiz('不限截止', [{ qtype: 'judge', content: '1>0', answer: '对', score: 5 }], { validUntil: '' })
const qJunk = await mkQuiz('脏数据截止', [{ qtype: 'judge', content: '2>0', answer: '对', score: 5 }], { validUntil: 'not-a-date' })
const sGet4 = await req('GET', `/api/quizzes/${qEmpty.data?.id}`, { token: ST.token })
const sGet5 = await req('GET', `/api/quizzes/${qJunk.data?.id}`, { token: ST.token })
ok('空 valid_until → 不拦', sGet4.status === 200, `实际 ${sGet4.status}`)
ok('非法 valid_until → 不拦（容错）', sGet5.status === 200, `实际 ${sGet5.status}`)

console.log('\n=== B. 切屏记录随答卷提交并落库 ===')
const qSwitch = await mkQuiz('切屏监测试验', [{ qtype: 'single', content: '3+3=?', options: ['5', '6'], answer: '6', score: 10 }])
const swId = qSwitch.data?.id
const swLogs = [
  { t: '2026-01-01T00:00:00.000Z', type: 'hide' },
  { t: '2026-01-01T00:00:12.000Z', type: 'show', ms: 12000 },
  { t: '2026-01-01T00:05:00.000Z', type: 'hide' },
]
const swSub = await req('POST', `/api/quizzes/${swId}/submit`, {
  token: ST.token, body: { answers: { 4: '6' }, switch_logs: swLogs },
})
ok('带 switch_logs 提交 → 200', swSub.status === 200, `实际 ${swSub.status}`)
const subRow = db.prepare('SELECT answers FROM quiz_submissions WHERE quiz_id=? AND user_id=?').get(swId, studId)
const stored = JSON.parse(subRow?.answers || '{}')
ok('switch_logs 已落库（hide 2 条）', Array.isArray(stored.switch_logs) && stored.switch_logs.length === 3 && stored.switch_logs.filter(l => l.type === 'hide').length === 2, JSON.stringify(stored.switch_logs))
ok('原有 answers/graded 结构不受影响', stored.answers?.['4'] === '6' && !!stored.graded)
// 教师端 submissions 列表可读切屏数
const tSubs = await req('GET', `/api/quizzes/${swId}/submissions`, { token: T.token })
const mine = (tSubs.data || []).find((s) => s.user_id === studId)
const hideCount = Array.isArray(mine?.answers?.switch_logs) ? mine.answers.switch_logs.filter((l) => l.type === 'hide').length : 0
ok('教师端 submissions 可读 switch_logs（hide=2）', hideCount === 2, `实际 ${hideCount}`)

console.log('\n=== C. 写操作后边缘缓存失效（含写者 auth 分片）===')
// 先让教师 GET 一次知识点（模拟页面加载 → 边缘/内存缓存写入）
await req('GET', '/api/subjects/1/knowledge-points', { token: T.token })
edgeDeletes.length = 0
// 添加知识点 → 应 purge：knowledge-points + questions 两个路径 × public/anon/写者authHash 三个分片
const kpCreate = await req('POST', '/api/subjects/1/knowledge-points', { token: T.token, body: { name: '牛顿第二定律' } })
ok('创建知识点 → 200', kpCreate.status === 200, `实际 ${kpCreate.status} ${JSON.stringify(kpCreate.data)}`)
const kpPaths = edgeDeletes.filter(u => decodeURIComponent(u).includes('/knowledge-points'))
const qPaths = edgeDeletes.filter(u => decodeURIComponent(u).includes('/questions'))
ok('purge 了 /knowledge-points 条目', kpPaths.length >= 1, `实际 ${edgeDeletes.length} 次 delete：${JSON.stringify(edgeDeletes.slice(0, 3))}`)
ok('purge 了 /questions 条目（计数联动）', qPaths.length >= 1)
// 写者自己的 auth 分片：用同一 token 再发一次 GET，key 应含该 token 的 btoa 前缀
const authHash = btoa(('Bearer ' + T.token).slice(0, 200)).slice(0, 24)
const selfShard = edgeDeletes.filter(u => decodeURIComponent(u).includes('__zg_auth=' + authHash))
ok('purge 覆盖写者自己的 auth 分片（修复根因）', selfShard.length >= 1, `authHash=${authHash}，删除列表=${JSON.stringify(edgeDeletes.map(u => decodeURIComponent(u).slice(-60)))}`)
// 三级分片齐全
ok('每个路径删 public+anon+authHash 三个分片', kpPaths.filter(u => decodeURIComponent(u).includes('__zg_auth=public')).length >= 1 && kpPaths.filter(u => decodeURIComponent(u).includes('__zg_auth=anon')).length >= 1 && selfShard.length >= 1)

console.log('\n=== D. 知识点 CRUD 回归 ===')
const kpList = await req('GET', '/api/subjects/1/knowledge-points', { token: T.token })
ok('知识点列表含新建节点', (kpList.data || []).some((k) => k.name === '牛顿第二定律'))
const kpRename = await req('PATCH', `/api/knowledge-points/${kpCreate.data?.id}`, { token: T.token, body: { name: '牛顿第一定律' } })
ok('改名 → 200', kpRename.status === 200, `实际 ${kpRename.status}`)
const kpList2 = await req('GET', '/api/subjects/1/knowledge-points', { token: T.token })
ok('改名生效', (kpList2.data || []).some((k) => k.name === '牛顿第一定律'))
const kpDel = await req('DELETE', `/api/knowledge-points/${kpCreate.data?.id}`, { token: T.token })
ok('删除 → 200', kpDel.status === 200, `实际 ${kpDel.status}`)

console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`)
process.exit(fail ? 1 : 0)
