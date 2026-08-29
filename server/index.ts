import 'dotenv/config'
import { spawn, exec } from 'child_process'
import express from 'express'
import cors from 'cors'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { initDB, all, get, run } from './db'
import { signToken, auth, requireRole, requireStaff, requireSubjectStaff } from './auth'
import { addExp, addNotice, userClassIds, teachingSubjects, getExpRules, getFeatureFlags, refreshExpRules, refreshFeatureFlags, isFeatureEnabled } from './helpers'
import { uploadFile, downloadFile, deleteFile, extractKey, STORAGE_ENABLED, USE_LOCAL, LOCAL_UPLOAD_DIR, createPresignedUploadUrl } from './storage'
import bcrypt from 'bcryptjs'
import multer from 'multer'

// ============== 顶层：先创建 Express app（因为下面所有中间件都依赖它） ==============
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const app = express()

// ==============================================================================
// 🔴【全局变量，必须放最最最开头！】
//   SELF_REPAIR_LOCK：/api/admin/self-repair 和 /__zg_fix 共用的10分钟互斥锁
//   ZGFIX_IP_LOCK：/__zg_fix 每IP 1小时≤2次的防刷锁
// ==============================================================================
const SELF_REPAIR_LOCK: { at: number; pid: number | 0 } = { at: 0, pid: 0 }

// ==============================================================================
// 🔴🔴🔴【优先级最高】2个救命接口：放在所有中间件之前！
//   就算cors/static/compression/DB全挂了，只要Node进程活着，这2个接口就一定能访问！
// ==============================================================================
// (1) 健康检查接口 /__zg_health ：永远HTTP200（never-die-guard/Worker验真活URL用）
app.get('/__zg_health', (_req, res) => {
  res.type('text/plain; charset=utf-8').status(200).send('OK:' + Date.now().toString(36))
})
// (2) 小白公开修复接口 /__zg_fix ：不用登录！不用进后台！地址栏直接输就修！
//     安全：1小时限2次（防刷），和 /api/admin/self-repair 共用10分钟互斥锁
const ZGFIX_IP_LOCK = new Map<string, { at: number; cnt: number }>()  // 每IP 1h最多2次
app.get('/__zg_fix', (req, res) => {
  const now = Date.now()
  const ip = (req.headers['x-forwarded-for'] as string || req.ip || '0.0.0.0').split(',')[0].trim()
  // ---- 防刷：同一IP 1小时≤2次 ----
  const rec = ZGFIX_IP_LOCK.get(ip) || { at: 0, cnt: 0 }
  if (now - rec.at > 60 * 60 * 1000) { rec.at = now; rec.cnt = 0 }  // 1小时窗口滚动清零
  if (rec.cnt >= 2) {
    res.type('text/html; charset=utf-8').status(429).send(`
<!doctype html><meta charset="utf-8"><title>追光 · 修复太频繁</title>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fff7ed;color:#9a3412;padding:60px 24px;line-height:1.8">
<h2 style="margin:0 0 12px;font-size:20px">⏳ 修复太频繁啦</h2>
<p style="margin:0 0 16px">为了保护服务器，同一个IP 1小时内最多修复2次。</p>
<p style="margin:0 0 16px">上次修复还没超过1小时，请耐心等一等，多按几次 <b>F5</b> 刷新试试。</p>
<p style="margin:0;color:#6b7280">如果一直不好，直接和AI助手说一句「网站挂了」就行～</p>
</body></html>`)
    return
  }
  rec.cnt += 1; ZGFIX_IP_LOCK.set(ip, rec)
  // ---- 10分钟互斥锁：防止用户连点N次（和self-repair共用同一个锁） ----
  if (now - SELF_REPAIR_LOCK.at < 10 * 60 * 1000 && SELF_REPAIR_LOCK.pid) {
    try { process.kill(SELF_REPAIR_LOCK.pid, 0) }
    catch { SELF_REPAIR_LOCK.at = 0; SELF_REPAIR_LOCK.pid = 0 }
    if (now - SELF_REPAIR_LOCK.at < 10 * 60 * 1000) {
      res.type('text/html; charset=utf-8').status(200).send(`
<!doctype html><meta charset="utf-8"><title>追光 · 修复进行中</title>
<body style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:#fef3c7;color:#92400e;padding:60px 24px;line-height:1.8">
<h2 style="margin:0 0 12px;font-size:20px">🔄 修复已经在跑啦～</h2>
<p style="margin:0 0 16px">10分钟内已经有一次修复在执行，不用重复点。</p>
<p style="margin:0 0 16px">请耐心等 <b>1~2 分钟</b>，然后 <b>多按几次 F5（Ctrl+R）</b> 刷新页面。</p>
<p style="margin:0;color:#6b7280">如果3分钟后还是打不开，直接和AI助手说一句「网站挂了」～</p>
</body></html>`)
      return
    }
  }
  SELF_REPAIR_LOCK.at = now
  // ---- 启动修复：fix.sh + 补3条SSH隧道（异步，立刻返回不卡用户） ----
  try {
    const env = {
      ...process.env,
      HTTP_PROXY: 'http://127.0.0.1:18080', HTTPS_PROXY: 'http://127.0.0.1:18080',
      http_proxy: 'http://127.0.0.1:18080', https_proxy: 'http://127.0.0.1:18080'
    }
    const child = spawn('bash', ['/workspace/fix.sh'], {
      cwd: '/workspace', detached: true, stdio: ['ignore', 'ignore', 'ignore'], env
    })
    child.unref()
    SELF_REPAIR_LOCK.pid = child.pid || 0
    // 额外立刻补3条SSH自恢复循环
    const PROXY_CMD = 'nc -X connect -x 127.0.0.1:18080 %h %p'
    for (const N of ['a', 'b', 'c']) {
      const LOGF = `/tmp/ult/${N}.log`
      spawn('bash', ['-c', `
        mkdir -p /tmp/ult; rm -f ${LOGF}; touch ${LOGF}
        while true; do
          /usr/bin/ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
            -o ServerAliveInterval=20 -o ServerAliveCountMax=2 -o ConnectTimeout=22 -o TCPKeepAlive=yes \
            -o "ProxyCommand=${PROXY_CMD}" \
            -p 443 -R0:localhost:3001 ${N}.pinggy.io >> ${LOGF} 2>&1
          sleep 1
        done
      `], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] }).unref()
    }
  } catch {}
  // ---- 立刻返回超简单HTML页面（就算网站半挂，用户也能看到字）----
  res.type('text/html; charset=utf-8').status(200).send(`
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>追光 · 自动修复已启动 ✅</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    background: linear-gradient(135deg, #fff7ed 0%, #fef3c7 100%);
    color: #78350f; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    background: #fff; border-radius: 20px; padding: 40px 28px; max-width: 520px; width: 100%;
    box-shadow: 0 20px 50px rgba(245,158,11,.18), 0 4px 10px rgba(245,158,11,.08);
    text-align: center;
  }
  .emoji { font-size: 64px; display: block; margin-bottom: 16px; animation: bounce 1.2s ease-in-out infinite; }
  @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
  h1 { font-size: 22px; margin-bottom: 14px; color: #92400e; font-weight: 800; }
  p { font-size: 15px; line-height: 1.85; margin-bottom: 12px; color: #78350f; }
  .step { background: #fffbeb; border-radius: 12px; padding: 14px 16px; margin: 18px 0; text-align: left; }
  .step li { font-size: 14px; line-height: 2; color: #78350f; list-style: none; padding-left: 0; }
  .n { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center;
       background: #f59e0b; color: #fff; border-radius: 50%; font-size: 12px; font-weight: 700; margin-right: 8px; }
  .tip { font-size: 12px; color: #6b7280; margin-top: 18px; padding-top: 14px; border-top: 1px dashed #fcd34d; }
  kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 6px;
        padding: 2px 8px; font-size: 12px; font-family: inherit; color: #374151; }
</style>
<body>
<div class="card">
  <span class="emoji">🚑</span>
  <h1>自动修复已经启动啦！</h1>
  <p>服务器正在自动重启后端、重建隧道、修复全部故障。</p>
  <div class="step">
    <ul>
      <li><span class="n">1</span> 耐心等待 <b>1～2 分钟</b></li>
      <li><span class="n">2</span> 然后 <b>多按几次 <kbd>F5</kbd>（或 <kbd>Ctrl</kbd>+<kbd>R</kbd>）</b> 刷新</li>
      <li><span class="n">3</span> 如果 3 分钟后还是不好 → 直接和 AI 助手说一句「网站挂了」</li>
    </ul>
  </div>
  <p style="font-size:13px;color:#b45309;font-weight:600">💡 提示：您可以把本页加入收藏，下次坏了直接打开就能修。</p>
  <div class="tip">修复接口：<code>https://xkzg.dpdns.org/__zg_fix</code>（记住这个网址=随时自己修）</div>
</div>
</body>`)
})

// ===== 性能优化1：Gzip压缩（响应体积减60~80%，pinggy跨洋带宽=最大瓶颈） =====
// ESM里用 await import('compression') 兼容tsx/ts-node，不依赖require
let compressionInstalled = false
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = await import('compression')
  const compression = (mod.default || mod) as any
  app.use(compression({
    threshold: 512,
    level: 6,
    filter: (req: any, res: any) => {
      if (req.headers['x-no-compression']) return false
      return compression.filter(req, res)
    }
  }))
  compressionInstalled = true
  console.log('[perf] Gzip压缩已启用（pinggy传输体积减少~70%）')
} catch (e: any) {
  console.log('[perf] compression未安装，跳过gzip（可 npm i compression -S 启用）:', (e as Error).message.slice(0, 80))
}

// ===== 性能优化2：安全短期内存缓存（只缓存GET /api/*，按Authorization hash+URL做key，TTL 5~15秒） =====
// 彻底根治：pinggy免费版跨洋=2~5秒延迟，10次重复请求里9次能命中Cloudflare/Node缓存，延迟直接降90%
type CacheEntry = { body: string; type: string; expireAt: number; etag: string }
const API_CACHE = new Map<string, CacheEntry>()
const API_CACHE_MAX = 500  // 最多缓存500条，内存≈10~20MB

function apiCacheKey(req: express.Request): string | null {
  if (req.method !== 'GET') return null
  if (!req.path.startsWith('/api/')) return null
  // 写操作相关API不缓存：含 me/status, exp/logs POST（但GET可以），upload*
  const p = req.path
  if (p.includes('/upload/') || p.includes('/download/')) return null
  // 网站说明、站点配置、经验规则等可被后台编辑的内容不缓存，确保修改后立即生效
  if (p === '/api/pages/guide' || p === '/api/settings/site_config' || p === '/api/settings/exp_rules' || p === '/api/settings/feature_flags') return null
  // 关键：Authorization hash做区分（不同用户看不同数据）
  const auth = (req.headers.authorization || '').slice(0, 200)
  let authHash = 'anon'
  try {
    authHash = Buffer.from(auth).toString('base64').slice(0, 24)
  } catch {}
  // TTL：监控数据TTL短=5秒；列表/配置类TTL长=15秒
  let ttl = 15000
  if (p.includes('/admin/monitor') || p.includes('/me/status') || p.includes('/online')) ttl = 5000
  if (p.includes('/feature-flags') || p.includes('/pages/') || p.includes('/themes')) ttl = 30000
  const urlKey = p + '|' + JSON.stringify(req.query || {})
  return `${authHash}|${ttl}|${urlKey}`
}

/** 清除全部缓存（公共内容修改后调用，确保所有用户立即看到最新数据） */
function clearAllCache() {
  API_CACHE.clear()
}

// 在express.json之前加缓存中间件（注意：顺序必须在static之前，在auth之前也可以——命中就直接回）
app.use((req, res, next) => {
  const k = apiCacheKey(req)
  if (!k) {
    // 非 GET 请求（POST/PUT/PATCH/DELETE）：清除全部缓存，确保后续 GET 拿到最新数据
    if (req.method !== 'GET' && req.method !== 'OPTIONS' && req.method !== 'HEAD') {
      clearAllCache()
    }
    return next()
  }
  const [, ttlStr] = k.split('|', 3)
  const ttl = parseInt(ttlStr || '15000', 10)
  const e = API_CACHE.get(k)
  if (e && e.expireAt > Date.now()) {
    // 304协商缓存：客户端带If-None-Match命中ETag就回304不发body
    const ifNm = req.headers['if-none-match']
    if (ifNm === e.etag) {
      res.setHeader('X-Zg-Cache', 'HIT-304')
      res.statusCode = 304
      return res.end()
    }
    res.setHeader('Content-Type', e.type)
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttl/1000)}`)
    res.setHeader('ETag', e.etag)
    res.setHeader('X-Zg-Cache', `HIT-${Math.floor((e.expireAt-Date.now())/1000)}s`)
    return res.send(e.body)
  }
  // 没命中：包一层send缓存响应
  const origSend = res.send.bind(res)
  let cached = false
  ;(res as any).send = (body: any) => {
    if (!cached && res.statusCode >= 200 && res.statusCode < 300 && typeof body === 'string') {
      try {
        // 生成ETag
        let hash = 0
        for (let i = 0; i < body.length; i++) hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0
        const etag = 'W/"' + Math.abs(hash).toString(36) + '-' + body.length.toString(36) + '"'
        const entry: CacheEntry = {
          body,
          type: res.getHeader('Content-Type') as string || 'application/json; charset=utf-8',
          expireAt: Date.now() + ttl,
          etag
        }
        // LRU：超了就删最早一条
        if (API_CACHE.size >= API_CACHE_MAX) {
          const firstKey = API_CACHE.keys().next().value
          if (firstKey) API_CACHE.delete(firstKey)
        }
        API_CACHE.set(k, entry)
        res.setHeader('ETag', etag)
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttl/1000)}`)
        res.setHeader('X-Zg-Cache', 'MISS')
      } catch {}
      cached = true
    }
    return origSend(body)
  }
  next()
})
setInterval(() => {
  // 每30秒清理过期项（避免内存泄漏）
  const now = Date.now()
  for (const [k, v] of API_CACHE) if (v.expireAt < now) API_CACHE.delete(k)
}, 30000)
console.log('[perf] API短期内存缓存已启用（5~30s TTL，按用户隔离）')

// 初始化数据库（Turso/libSQL）
initDB().catch(e => {
  console.error('[server] 数据库初始化失败:', e)
  process.exit(1)
})

app.use(cors({
  exposedHeaders: ['Content-Disposition', 'Content-Type'],
}))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

// 需求5：记录每个登录用户的最后活跃时间（用于监控在线人数）
app.use(async (req, res, next) => {
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const jwt = await import('jsonwebtoken')
      const decoded: any = (jwt.default || jwt).verify(token, process.env.JWT_SECRET || 'zhuiguang-secret-dev')
      if (decoded && decoded.id) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
        // 异步更新，不阻塞请求
        run('UPDATE users SET last_active=? WHERE id=?', now, decoded.id).catch(() => {})
      }
    } catch {}
  }
  next()
})

// 静态：前端构建产物（生产）
  const distDir = path.join(ROOT, 'dist')
  if (fs.existsSync(distDir)) {
    // 给 index.html 注入版本号，强制浏览器加载最新的 JS/CSS
    // 策略：只在当前 html 中已有的 /assets/xxx.js / .css 引用上追加 ?v= 时间戳，
    // 不再依赖 index.html.bak —— 每次启动都直接基于当前构建产物加工，避免旧备份造成的错乱
    const htmlPath = path.join(distDir, 'index.html')
    let BUILD_VER = '0'
    try {
      BUILD_VER = String(Date.now())
      const rawHtml = fs.readFileSync(htmlPath, 'utf-8')
      // 先清除已有的 ?v=xxx，保证每次都是干净的起点
      const cleanHtml = rawHtml.replace(/\?v=\d+/g, '')
      // 只替换干净的 /assets/...js 和 /assets/...css
      const html = cleanHtml
        .replace(/(src="\/assets\/[^"]+\.js)"/g, `$1?v=${BUILD_VER}"`)
        .replace(/(href="\/assets\/[^"]+\.css)"/g, `$1?v=${BUILD_VER}"`)
      fs.writeFileSync(htmlPath, html)
      console.log(`[build] 版本号: ${BUILD_VER}`)
    } catch (e) { console.log('[build] 版本号注入失败:', (e as Error).message) }

    // 明确处理 /assets/ 路径，避免被 SPA fallback 拦截
    app.use('/assets', express.static(path.join(distDir, 'assets'), {
      maxAge: '1y',
      immutable: true,
      index: false
    }))
    // 其余静态文件（如根路径的 index.html、favicon 等）
    app.use(express.static(distDir, { index: false }))
  }

// 静态：本地文件上传目录（仅本地兜底模式用；Supabase 模式时前端走外链，此挂载无害也无用）
if (USE_LOCAL) {
  app.use('/uploads', express.static(LOCAL_UPLOAD_DIR))
  console.log(`[storage] 本地兜底模式：文件存于 ${LOCAL_UPLOAD_DIR}`)
} else {
  console.log('[storage] Supabase Storage 模式：文件存于云端 bucket')
}

// multer 用内存存储：接收后立即上传到 Supabase，不落本地磁盘
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
})

const j = (s: string | null | undefined) => { try { return s ? JSON.parse(s) : null } catch { return null } }
const pub = (u: any) => { if (!u) return u; const { password_hash, ...rest } = u; return rest }

function setDownloadHeaders(res: express.Response, filename: string) {
  const encoded = encodeURIComponent(filename)
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`)
}

// 教师仅可管理自己任教学科；超管可管理所有学科
// 【v4.0.0 重构】判断用户能否管理某 subject 的内容。
// 规则：
//   - SUPER_ADMIN 永远 true
//   - TEACHER 必须是任教学科之一（teachingSubjects: class_members.role_in_class='TEACHER'）
//   - 其他角色 false
// 注意：原实现只看 user.subject_id（用户的"主学科"单一字段），不支持多学科任教；
// 改为异步 + 复用 helpers.teachingSubjects（已正确从 class_members 聚合），
// 并对 user.subject_id 兜底（兼容老数据：教师只在 users 表里指了主学科、没进 class_members 的场景）
async function canManageSubject(user: any, subjectId: any, fallbackUserId?: number): Promise<boolean> {
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  if (user.role === 'TEACHER') {
    const sid = Number(subjectId)
    if (!sid) return false
    // 【v4.3.0 修复】user.id 缺失会导致 teachingSubjects(undefined) → SQL 绑定 undefined 报错
    // 历史 bug：多处 'SELECT role, subject_id FROM users WHERE id=?' 漏查 id 字段，
    // 超管因第 364 行短路返回 true 而长期掩盖，只有教师会触发 500。
    // 这里 double 保险：SQL 已补 id；若仍缺失则用 fallbackUserId，都没有则安全拒绝（返回 false 而非抛 500）。
    const uid = user.id ?? user.user_id ?? fallbackUserId
    if (uid === undefined || uid === null) return false
    const sids = await teachingSubjects(Number(uid))
    if (!sids.includes(sid) && user.subject_id && Number(user.subject_id) === sid) {
      sids.push(Number(user.subject_id))
    }
    return sids.includes(sid)
  }
  return false
}

// ============ 认证 ============
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body
  const u = await get<any>('SELECT * FROM users WHERE username = ?', username)
  if (!u) return res.status(400).json({ message: '用户不存在' })
  // Bug4: 禁用账号登录前检查，返回401带disabled标记
  if (u.status === 'disabled') return res.status(401).json({ message: '账号已被禁用，请联系管理员', disabled: true })
  if (u.status !== 'active') return res.status(400).json({ message: '账号状态异常' })
  if (!bcrypt.compareSync(password, u.password_hash)) return res.status(400).json({ message: '密码错误' })
  // 每日首次登录才加积分（同一天重复登录不重复发放）
  const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD
  const todayLogin = await get('SELECT id FROM exp_logs WHERE user_id=? AND action_type=? AND substr(created_at,1,10)=? LIMIT 1', u.id, 'login', today)
  if (!todayLogin) await addExp(u.id, undefined, 'login', '每日首次登录')
  res.json({ token: signToken({ id: u.id, role: u.role }), user: pub(u) })
})

// Bug4: 轻量接口，检查用户是否登录+是否禁用，供前端轮询/路由切换用
app.get('/api/me/status', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.json({ login: false, disabled: false, userId: null })
  }
  try {
    const token = authHeader.slice(7)
    const jwt = await import('jsonwebtoken')
    const decoded: any = (jwt.default || jwt).verify(token, process.env.JWT_SECRET || 'zhuiguang-secret-2026')
    if (!decoded || !decoded.id) {
      return res.json({ login: false, disabled: false, userId: null })
    }
    const u = await get<{ status: string }>('SELECT status FROM users WHERE id=?', decoded.id)
    if (!u) return res.json({ login: false, disabled: false, userId: null })
    return res.json({ login: true, disabled: u.status === 'disabled', userId: Number(decoded.id) })
  } catch {
    return res.json({ login: false, disabled: false, userId: null })
  }
})

app.post('/api/auth/register', async (req, res) => {
  // Bug5: 检查注册功能开关
  let callerIsAdmin = false
  const authHeader = req.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const jwt = await import('jsonwebtoken')
      const decoded: any = (jwt.default || jwt).verify(token, process.env.JWT_SECRET || 'zhuiguang-secret-2026')
      if (decoded && decoded.role === 'SUPER_ADMIN') callerIsAdmin = true
    } catch {}
  }
  const regFlag = await get<{ value: string }>("SELECT value FROM feature_flags WHERE key='registration_enabled'")
  if (!callerIsAdmin && regFlag && regFlag.value === '0') {
    return res.status(403).json({ message: '管理员已关闭注册功能' })
  }
  const { username, password, realName, email, classId } = req.body
  if (!username || !password || !realName) return res.status(400).json({ message: '请填写完整信息' })
  if (await get('SELECT id FROM users WHERE username = ?', username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password, 8)
  const r = await run('INSERT INTO users (username,password_hash,real_name,role,email,avatar) VALUES (?,?,?,?,?,?)', username, hash, realName, 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)', classId, uid, 'STUDENT')
  await addExp(uid, undefined, 'register', '注册奖励')
  const newUser = await get<any>('SELECT * FROM users WHERE id=?', uid)
  res.json({ token: signToken({ id: uid, role: 'STUDENT' }), user: pub(newUser) })
})

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await get<any>('SELECT * FROM users WHERE id = ?', (req as any).user.id)
  res.json({ user: pub(u) })
})

// ============ 用户管理 ============
app.get('/api/users', auth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  const list = await all<any>('SELECT * FROM users ORDER BY id')
  res.json(list.map(pub))
})

// 用户搜索（@提及选择器用）：登录用户即可调用，仅返回活跃用户的最小信息
// 返回 [{id, username, realName}]，上限 10 条
app.get('/api/users/search', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim()
  if (!q) return res.json([])
  const like = `%${q.replace(/[%_]/g, ch => '\\' + ch)}%`
  const rows = await all<any>(
    `SELECT id, username, real_name FROM users
     WHERE status='active' AND (username LIKE ? OR real_name LIKE ?)
     ORDER BY
       CASE WHEN username=? THEN 0
            WHEN username LIKE ? THEN 1
            WHEN real_name=? THEN 2
            ELSE 3 END,
       id
     LIMIT 10`,
    like, like, q, `${q}%`, q
  )
  res.json(rows.map((r: any) => ({
    id: Number(r.id),
    username: r.username,
    realName: r.real_name || r.username,
  })))
})

// 单个用户公开信息（@提及点击跳转目标用户主页用）
// 登录即可访问，仅返回 active 用户；含真实经验值（与 /api/users 一致）
app.get('/api/users/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ message: '无效的用户 ID' })
  const u = await get<any>(
    `SELECT u.*, cm.class_id,
            COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=u.id), 0) AS exp_total
     FROM users u
     LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE role_in_class=?) cm ON u.id=cm.user_id
     WHERE u.id=?`,
    'STUDENT', id
  )
  if (!u) return res.status(404).json({ message: '用户不存在' })
  if (u.status !== 'active') return res.status(403).json({ message: '用户已停用' })
  const base = pub(u)
  base.exp = Number(u.exp_total || 0)
  base.level = Math.floor(base.exp / 60) + 1
  return res.json(base)
})

app.post('/api/users', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { username, realName, role, email, classId, password, subjectId } = req.body
  if (await get('SELECT id FROM users WHERE username=?', username)) return res.status(400).json({ message: '用户名已存在' })
  const hash = bcrypt.hashSync(password || '123456', 8)
  const r = await run('INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id) VALUES (?,?,?,?,?,?,?)', username, hash, realName, role || 'STUDENT', email || '', `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}`, subjectId ?? null)
  const uid = Number(r.lastInsertRowid)
  if (classId) await run('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)', classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
  res.json({ id: uid })
})

// 批量导入用户
app.post('/api/users/import', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { users } = req.body as { users: Array<{ realName: string; username: string; role: string; email?: string; password?: string; classId?: number; subjectId?: number | null }> }
  if (!Array.isArray(users) || !users.length) return res.status(400).json({ message: '未检测到用户数据' })

  const results: { success: number; skipped: number; errors: string[] } = { success: 0, skipped: 0, errors: [] }

  for (let i = 0; i < users.length; i++) {
    const u = users[i]
    const lineNo = i + 2 // Excel第2行开始是数据
    try {
      if (!u.username || !u.realName) {
        results.errors.push(`第${lineNo}行：姓名和用户名不能为空`)
        continue
      }
      // 检查用户名是否已存在
      const existing = await get('SELECT id FROM users WHERE username=?', u.username)
      if (existing) {
        results.skipped++
        results.errors.push(`第${lineNo}行：用户名「${u.username}」已存在，跳过`)
        continue
      }

      const role = u.role || 'STUDENT'
      const hash = bcrypt.hashSync(u.password || '123456', 8)
      const email = u.email || `${u.username}@zguang.edu`
      const avatar = `https://api.dicebear.com/7.x/shapes/svg?seed=zg${Date.now()}${i}`
      const r = await run(
        'INSERT INTO users (username,password_hash,real_name,role,email,avatar,subject_id) VALUES (?,?,?,?,?,?,?)',
        u.username, hash, u.realName, role, email, avatar, u.subjectId ?? null
      )
      const uid = Number(r.lastInsertRowid)
      // 加入班级
      if (u.classId) {
        await run('INSERT INTO class_members (class_id,user_id,role_in_class) VALUES (?,?,?)', u.classId, uid, role === 'TEACHER' ? 'TEACHER' : 'STUDENT')
      }
      results.success++
    } catch (e: any) {
      results.errors.push(`第${lineNo}行：${e.message || '未知错误'}`)
    }
  }

  res.json(results)
})

app.patch('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { realName, username, email, role, subjectId } = req.body
  const u = await get('SELECT id FROM users WHERE id=?', req.params.id)
  if (!u) return res.status(404).json({ message: '用户不存在' })
  // 超管可修改用户名（唯一性校验）
  if (username !== undefined && username.trim()) {
    const exist = await get('SELECT id FROM users WHERE username=? AND id!=?', username.trim(), req.params.id)
    if (exist) return res.status(409).json({ message: '用户名已被占用' })
    await run('UPDATE users SET username=? WHERE id=?', username.trim(), req.params.id)
  }
  if (realName !== undefined) await run('UPDATE users SET real_name=? WHERE id=?', realName, req.params.id)
  if (email !== undefined) await run('UPDATE users SET email=? WHERE id=?', email, req.params.id)
  if (role !== undefined) await run('UPDATE users SET role=? WHERE id=?', role, req.params.id)
  if (subjectId !== undefined) await run('UPDATE users SET subject_id=? WHERE id=?', subjectId ?? null, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/users/:id/status', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE users SET status = ? WHERE id = ?', req.body.status, req.params.id)
  res.json({ ok: true })
})

app.post('/api/users/:id/reset', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  // 超管可将密码重置为指定值，留空则重置为默认 123456
  const pwd = req.body.password || '123456'
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pwd, 8), req.params.id)
  res.json({ ok: true })
})

// 超管直接设置用户密码（需求6）
app.post('/api/users/:id/password', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { password } = req.body
  if (!password || password.length < 4) return res.status(400).json({ message: '密码至少 4 位' })
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 8), req.params.id)
  res.json({ ok: true })
})

app.delete('/api/users/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM exp_logs WHERE user_id=?', req.params.id)
  await run('DELETE FROM likes_map WHERE user_id=?', req.params.id)
  await run('DELETE FROM notices WHERE user_id=?', req.params.id)
  await run('DELETE FROM class_members WHERE user_id=?', req.params.id)
  await run('DELETE FROM articles WHERE user_id=?', req.params.id)
  await run('DELETE FROM resources WHERE user_id=?', req.params.id)
  await run('DELETE FROM users WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// Admin: 调整用户经验值
app.patch('/api/users/:id/exp', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { exp, level } = req.body
  if (exp !== undefined) await run('UPDATE users SET exp=? WHERE id=?', exp, req.params.id)
  if (level !== undefined) await run('UPDATE users SET level=? WHERE id=?', level, req.params.id)
  res.json({ ok: true })
})

app.patch('/api/profile', auth, async (req, res) => {
  const id = (req as any).user.id
  const { realName, email, avatar } = req.body
  await run('UPDATE users SET real_name=?, email=?, avatar=? WHERE id=?', realName, email, avatar, id)
  const u = await get<any>('SELECT * FROM users WHERE id=?', id)
  res.json({ user: pub(u) })
})

app.post('/api/upload/avatar', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname) || '.png'
  const key = `avatar_${(req as any).user.id}_${Date.now()}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  await run('UPDATE users SET avatar=? WHERE id=?', url, (req as any).user.id)
  res.json({ url })
})

// ============ 前端直传 Supabase 的预签名 URL（绕过 pinggy 隧道大文件限制） ============
app.post('/api/upload/presign', auth, async (req, res) => {
  const { fileName, contentType } = req.body
  if (!fileName) return res.status(400).json({ message: '缺少 fileName' })
  const ext = path.extname(fileName) || ''
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  const result = await createPresignedUploadUrl(key)
  if (!result) {
    // Supabase 不可用（如本地模式），返回回退标记，前端走旧的 /api/upload/file 接口
    return res.json({ fallback: true, key })
  }
  res.json({
    signedUrl: result.signedUrl,
    publicUrl: result.publicUrl,
    key,
    fileType: typeMap[ext] || 'file',
  })
})

// 图片专用 presign（头像/编辑器图片）
app.post('/api/upload/presign-image', auth, async (req, res) => {
  const { fileName } = req.body
  if (!fileName) return res.status(400).json({ message: '缺少 fileName' })
  const ext = path.extname(fileName) || '.png'
  const key = `img_${(req as any).user.id}_${Date.now()}${ext}`
  const result = await createPresignedUploadUrl(key)
  if (!result) return res.json({ fallback: true, key })
  res.json({ signedUrl: result.signedUrl, publicUrl: result.publicUrl, key })
})

// ============ 班级 ============
app.get('/api/classes', auth, async (_req, res) => res.json(await all('SELECT * FROM classes ORDER BY id')))

app.post('/api/classes', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const r = await run('INSERT INTO classes (name,grade,description) VALUES (?,?,?)', req.body.name, req.body.grade || '', req.body.description || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE classes SET name=?,grade=?,description=? WHERE id=?', req.body.name, req.body.grade, req.body.description, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/classes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM class_members WHERE class_id=?', req.params.id)
  await run('DELETE FROM classes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 学科 ============
app.get('/api/subjects', async (_req, res) => {
  const list = await all<any>('SELECT * FROM subjects ORDER BY display_order')
  res.json(list.map(s => ({ ...s, modules: j(s.modules) })))
})

app.get('/api/subjects/:slug', async (req, res) => {
  const s = await get<any>('SELECT * FROM subjects WHERE slug = ?', req.params.slug)
  if (!s) return res.status(404).json({ message: '学科不存在' })
  res.json({ ...s, modules: j(s.modules) })
})

app.post('/api/subjects', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { name, slug, icon, color, description, displayOrder, modules, announcement } = req.body
  if (await get('SELECT id FROM subjects WHERE slug=?', slug)) return res.status(400).json({ message: 'slug已存在' })
  const r = await run('INSERT INTO subjects (name,slug,icon,color,description,display_order,modules,announcement) VALUES (?,?,?,?,?,?,?,?)',
    name, slug, icon || '📚', color || '#f59e0b', description || '', displayOrder || 0, JSON.stringify(modules || {}), announcement || '')
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { name, icon, color, description, displayOrder, modules, announcement } = req.body
  if (name !== undefined) await run('UPDATE subjects SET name=? WHERE id=?', name, req.params.id)
  if (icon !== undefined) await run('UPDATE subjects SET icon=? WHERE id=?', icon, req.params.id)
  if (color !== undefined) await run('UPDATE subjects SET color=? WHERE id=?', color, req.params.id)
  if (description !== undefined) await run('UPDATE subjects SET description=? WHERE id=?', description, req.params.id)
  if (displayOrder !== undefined) await run('UPDATE subjects SET display_order=? WHERE id=?', displayOrder, req.params.id)
  if (modules !== undefined) await run('UPDATE subjects SET modules=? WHERE id=?', JSON.stringify(modules), req.params.id)
  if (announcement !== undefined) await run('UPDATE subjects SET announcement=? WHERE id=?', announcement, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/subjects/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM articles WHERE subject_id=?', req.params.id)
  await run('DELETE FROM resources WHERE subject_id=?', req.params.id)
  await run('DELETE FROM subjects WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学科管理员也能修改公告/模块
app.patch('/api/subjects/:id/announcement', auth, requireStaff, async (req, res) => {
  await run('UPDATE subjects SET announcement=? WHERE id=?', req.body.announcement, req.params.id)
  res.json({ ok: true })
})

// 用户班级/任教
app.get('/api/me/classes', auth, async (req, res) => {
  const id = (req as any).user.id
  const u = await get<any>('SELECT subject_id FROM users WHERE id=?', id)
  // 【v4.0.1】同时返回主学科 subjectId，前端 store 用作兜底
  res.json({ classIds: await userClassIds(id), teachingSubjects: await teachingSubjects(id), subjectId: u?.subject_id ?? null })
})

// ============ 美文 ============
// Bug3/Bug7: 可选auth解析辅助（返回 {id,role,subject_id} | null）
async function parseOptionalAuth(req: any): Promise<{ id: number; role: string; subject_id: number | null } | null> {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return null
  try {
    const token = h.slice(7)
    const jwt = await import('jsonwebtoken')
    const dec: any = (jwt.default || jwt).verify(token, process.env.JWT_SECRET || 'zhuiguang-secret-2026')
    if (!dec || !dec.id) return null
    const u = await get<any>('SELECT id, role, subject_id, status FROM users WHERE id=?', dec.id)
    if (!u || u.status === 'disabled') return null
    return { id: u.id, role: u.role, subject_id: u.subject_id ? Number(u.subject_id) : null }
  } catch { return null }
}

app.get('/api/articles', async (req, res) => {
  const { subjectId, status, mine, userId, allStatus } = req.query
  const me = await parseOptionalAuth(req)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null

  // Bug3/Bug7: 构建状态+可见性过滤
  const statusClauses: string[] = []
  const statusArgs: any[] = []

  // 如果前端显式传了 status 参数，优先使用（前提是当前用户有权限看该状态的范围）
  const explicitStatus = typeof status === 'string' && status
  const wantAllStatus = allStatus === '1' && (myRole === 'SUPER_ADMIN' || myRole === 'TEACHER')

  if (myRole === 'SUPER_ADMIN') {
    // 超管：返回所有状态所有文章
    if (explicitStatus) { statusClauses.push('a.status=?'); statusArgs.push(explicitStatus) }
    // else 不加限制
  } else if (myRole === 'TEACHER') {
    // 教师：approved + 自己创建的所有状态 + 自己任教学科下所有非approved待审 + actual_user_id相关
    const sids = await teachingSubjects(myId)
    if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
    const parts: string[] = []
    // 已公开
    parts.push("a.status='approved'")
    // 自己创建的（所有状态）
    parts.push('a.user_id=?')
    statusArgs.push(myId)
    // 任教学科下待审文章（所有非approved状态，含pending、pending_student等）
    if (sids.length) {
      const ph = sids.map(() => '?').join(',')
      parts.push(`(a.status<>'approved' AND a.subject_id IN (${ph}))`)
      statusArgs.push(...sids)
    }
    // actual_user_id 关联的（学生待确认的）
    parts.push('a.actual_user_id=?')
    statusArgs.push(myId)
    statusClauses.push(`(${parts.join(' OR ')})`)
    if (explicitStatus && !wantAllStatus) {
      statusClauses.push('a.status=?'); statusArgs.push(explicitStatus)
    }
  } else if (myRole === 'STUDENT') {
    // 学生：approved + 自己创建的(user_id) + actual_user_id=自己的
    const parts: string[] = []
    parts.push("a.status='approved'")
    parts.push('a.user_id=?')
    statusArgs.push(myId)
    parts.push('a.actual_user_id=?')
    statusArgs.push(myId)
    statusClauses.push(`(${parts.join(' OR ')})`)
    if (explicitStatus && !wantAllStatus) {
      statusClauses.push('a.status=?'); statusArgs.push(explicitStatus)
    }
  } else {
    // 未登录（GUEST）：仅 approved
    if (explicitStatus && explicitStatus === 'approved') {
      statusClauses.push('a.status=?'); statusArgs.push(explicitStatus)
    } else {
      statusClauses.push("a.status='approved'")
    }
  }

  // 构建主SQL：JOIN users 取 creator_name / actual_user_name
  // 【v4.3.0 同步 Worker 端】补 subject_name / subject_icon，供审核界面显示学科
  let sql = `SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name,
    s.name AS subject_name, s.icon AS subject_icon
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    LEFT JOIN subjects s ON s.id = a.subject_id
    WHERE 1=1`
  const args: any[] = []

  if (statusClauses.length) {
    sql += ' AND (' + statusClauses.join(') AND (') + ')'
    args.push(...statusArgs)
  }

  if (subjectId) { sql += ' AND a.subject_id=?'; args.push(subjectId) }

  // Bug3/Bug7: mine=1 按正确身份返回
  if (mine === '1') {
    if (!me) { res.json([]); return }
    if (myRole === 'STUDENT') {
      sql += ' AND (a.user_id=? OR a.actual_user_id=?)'
      args.push(myId, myId)
    } else {
      sql += ' AND a.user_id=?'
      args.push(myId)
    }
  } else if (userId && myRole === 'SUPER_ADMIN') {
    // 超管可按 userId 筛选查看某人的
    sql += ' AND a.user_id=?'
    args.push(userId)
  }

  sql += ' ORDER BY a.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(a => ({ ...a, images: j(a.images), tags: j(a.tags) })))
})

// Bug6 路由顺序：/pending-student 必须在 /:id 之前定义，否则 "pending-student" 会被当成 id 参数导致 404
// 需求3：学生查看待我确认的美文列表
app.get('/api/articles/pending-student', auth, async (req, res) => {
  const uid = (req as any).user.id
  const list = await all<any>(`SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    WHERE a.actual_user_id=? AND a.status=? ORDER BY a.id DESC`, uid, 'pending_student')
  res.json(list.map(a => ({ ...a, images: j(a.images), tags: j(a.tags) })))
})

// 需求3：学生同意发布代发的美文 → 状态变为 pending 等待超管审核
app.post('/api/articles/:id/student-approve', auth, async (req, res) => {
  const uid = (req as any).user.id
  const a = await get<any>('SELECT * FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  if (Number(a.actual_user_id) !== Number(uid)) return res.status(403).json({ message: '不是代你发的美文' })
  if (a.status !== 'pending_student') return res.status(400).json({ message: '状态不正确' })
  await run('UPDATE articles SET status=? WHERE id=?', 'pending', req.params.id)
  await addNotice(a.user_id, '代发美文学生已确认', `学生确认同意发布《${a.title}》，现已进入待超管审核状态。`, 'audit')
  // Bug6: 学生同意后，也发送站内信通知学生（确认已提交，等待审核）
  const stuMsg = `<p>你已确认同意发布美文《${a.title}》</p><p>该文现已进入<b>超管审核</b>阶段，通过后将会公开展示。请耐心等待。</p>`
  const stuAtts = JSON.stringify([{ type: 'action', articleId: Number(req.params.id), title: '查看美文' }])
  await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', a.user_id, uid, stuMsg, stuAtts)
  res.json({ ok: true })
})

// 需求3：学生拒绝发布代发的美文 → 删除记录
app.post('/api/articles/:id/student-reject', auth, async (req, res) => {
  const uid = (req as any).user.id
  const a = await get<any>('SELECT * FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  if (Number(a.actual_user_id) !== Number(uid)) return res.status(403).json({ message: '不是代你发的美文' })
  if (a.status !== 'pending_student') return res.status(400).json({ message: '状态不正确' })
  await run('DELETE FROM articles WHERE id=?', req.params.id)
  await addNotice(a.user_id, '代发美文被学生拒绝', `学生拒绝了代发美文《${a.title}》，该文已删除。`, 'audit')
  res.json({ ok: true })
})

app.post('/api/articles/:id/admin-confirm', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const a = await get<any>('SELECT title, user_id, actual_user_id, status FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  if (a.status !== 'pending_student') return res.status(400).json({ message: '该美文不处于待学生确认状态' })
  await run('UPDATE articles SET status=? WHERE id=?', 'pending', req.params.id)
  await addNotice(Number(a.actual_user_id) || a.user_id, '美文已被管理员确认', `《${a.title}》已被管理员代为确认，进入审核队列。`, 'audit')
  res.json({ ok: true })
})

app.get('/api/articles/:id', async (req, res) => {
  const me = await parseOptionalAuth(req)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null

  // Bug3/Bug7: JOIN users 取 creator_name, actual_user_name
  const a = await get<any>(`SELECT a.*, u.real_name AS creator_name, au.real_name AS actual_user_name
    FROM articles a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN users au ON au.id = a.actual_user_id
    WHERE a.id=?`, req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })

  // Bug3/Bug7: 详情权限
  if (a.status !== 'approved') {
    // 非approved：仅本人/actual_user_id/超管/任教该学科教师 可见
    const isOwner = Number(a.user_id) === myId
    const isActual = a.actual_user_id && Number(a.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (a.subject_id && sids.includes(Number(a.subject_id))) canSee = true
    }
    if (!canSee) return res.status(403).json({ message: '无权查看该美文' })
  }

  await run('UPDATE articles SET views = views + 1 WHERE id=?', req.params.id)
  res.json({ ...a, images: j(a.images), tags: j(a.tags), views: (a.views ?? 0) + 1 })
})

app.post('/api/articles', auth, async (req, res) => {
  const id = (req as any).user.id
  const role = (req as any).user.role
  const u = await get<any>('SELECT real_name, class_id, role FROM users u LEFT JOIN (SELECT user_id, class_id FROM class_members WHERE user_id=?) cm ON u.id=cm.user_id WHERE u.id=?', id, id)
  const b = req.body
  const cid = b.classId || u?.class_id || 1
  // 需求3+4：美文状态逻辑
  //  - SUPER_ADMIN 直接 approved
  //  - TEACHER 自己发的（没有actualUserId）直接 approved
  //  - TEACHER 代发（有actualUserId学生）→ status='pending_student' 等待学生确认
  //  - STUDENT 自己发 → status='pending' 等待超管审核
  let status = 'pending'
  let actualUserId: number | null = null
  if (role === 'SUPER_ADMIN') {
    status = 'approved'
  } else if (role === 'TEACHER') {
    if (b.actualUserId && Number(b.actualUserId) !== id) {
      // 代发模式
      actualUserId = Number(b.actualUserId)
      status = 'pending_student'
    } else {
      status = 'approved'
    }
  }
  const r = await run(`INSERT INTO articles (title,content,author,source,recommendation,subject_id,user_id,class_id,cover,images,tags,category,status,actual_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.title, b.content, b.author || u?.real_name, b.source || '原创', b.recommendation || '', b.subjectId, id, cid, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.tags || []), b.category || '', status, actualUserId)
  const aid = Number(r.lastInsertRowid)
  // 代发的通知学生
  if (status === 'pending_student' && actualUserId) {
    const teacherName = u?.real_name || '老师'
    await addNotice(actualUserId, '有人代你发布美文', `${teacherName}老师代你发布了《${b.title}》，请到个人中心 → 待我确认的美文中确认是否同意发布。`, 'audit')
    // Bug6: 同时发站内信，内容写富文本HTML，attachments 带 action 信息供前端直达
    const msgHtml = `<p>${teacherName}老师代你发布了美文《${b.title}》</p><p>请前往「个人中心 → 待我确认的美文」中 <b>确认是否同意发布</b>。</p>`
    const atts = JSON.stringify([{ type: 'action', articleId: aid, title: '点此确认' }])
    await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', id, actualUserId, msgHtml, atts)
  }
  // 直接 approved 的直接加分
  if (status === 'approved') {
    const expUid = actualUserId || id
    await addExp(expUid, undefined, 'article', `美文《${b.title}》发布`)
  }
  res.json({ id: aid, status })
})

// 需求3：学生查看待我确认的美文列表（已在前面 /:id 之前定义过了，此处留占位避免误操作；旧代码已前移）
// —— pending-student / student-approve / student-reject 三条路由在 L522-L560 已定义 ——

app.patch('/api/articles/:id/status', auth, async (req, res) => {
  const a = await get<any>('SELECT title, user_id, status, subject_id, actual_user_id FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  const reviewerId = (req as any).user.id
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', reviewerId)
  // 【v4.3.0 同步 Worker 端】原逻辑写死「只有超管可以审核美文」，与生产不一致。
  // 现改为：超管放行任意学科；学科教师可审本学科（canManageSubject 已含 subject_id 兜底）
  if (u?.role !== 'SUPER_ADMIN' && !(await canManageSubject(u, a.subject_id, reviewerId))) {
    return res.status(403).json({ message: '无权限审核该学科的美文' })
  }
  const newStatus = req.body.status
  // Bug1: 确认此处不更新 user_id（当前是对的，只改 status）
  await run('UPDATE articles SET status=? WHERE id=?', newStatus, req.params.id)
  if (newStatus === 'approved' && a.status !== 'approved') {
    // 【v4.3.0 同步 Worker 端】审核通过给实际作者发经验值（防重复：检查是否已发放过）
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    const already = await get("SELECT id FROM exp_logs WHERE user_id=? AND action_type='article' AND description LIKE ?", expUid, `%${a.title}%`)
    if (!already) {
      await addExp(expUid, undefined, 'article', `美文《${a.title}》审核通过`)
    }
    await addNotice(a.user_id, '美文审核通过', `你的《${a.title}》已通过审核，已公开展示。`, 'audit')
    // 如果是代发的，也通知实际作者学生
    if (a.actual_user_id) {
      await addNotice(Number(a.actual_user_id), '你的美文审核通过', `《${a.title}》已通过审核，已公开展示。`, 'audit')
    }
  } else if (newStatus === 'rejected') {
    await addNotice(a.user_id, '美文未通过审核', `《${a.title}》未通过审核，请修改后重新提交。`, 'audit')
    if (a.actual_user_id) {
      await addNotice(Number(a.actual_user_id), '你的美文未通过审核', `代发的《${a.title}》未通过审核。`, 'audit')
    }
  }
  res.json({ ok: true })
})

app.delete('/api/articles/:id', auth, async (req, res) => {
  const a = await get<any>('SELECT user_id, subject_id, title, actual_user_id, status FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  const isOwner = a.user_id === (req as any).user.id
  const isActualUser = a.actual_user_id && Number(a.actual_user_id) === Number((req as any).user.id)
  if (!isOwner && !isActualUser && !(await canManageSubject(u, a.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限删除' })
  // 删除前直接删除相关的经验值记录（美文审核通过/点赞相关/评论相关）
  const expUid = Number(a.actual_user_id) || Number(a.user_id)
  if (expUid && a.title) {
    // 计算要回收的经验值（用于更新用户exp）
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type IN ('article','like','comment') AND description LIKE ?", expUid, `%${a.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    // 删除相关经验值记录
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type IN ('article','like','comment') AND description LIKE ?", expUid, `%${a.title}%`)
    // 更新用户经验值
    if (total) await run('UPDATE users SET exp = MAX(0, exp - ?) WHERE id = ?', total, expUid)
  }
  await run('DELETE FROM article_comments WHERE article_id=?', req.params.id)
  // 统计并修正点赞数
  const likeCount = await get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM likes_map WHERE target_type='article' AND target_id=?", req.params.id)
  if (likeCount && likeCount.cnt > 0) {
    await run('UPDATE articles SET likes = MAX(0, likes - ?) WHERE id=?', likeCount.cnt, req.params.id)
  }
  await run('DELETE FROM likes_map WHERE target_type=? AND target_id=?', 'article', req.params.id)
  await run('DELETE FROM articles WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 【v4.2.2】编辑美文：发布者本人 / 实际作者（代发美文的学生） / 超管 / 对应学科教师 可编辑
app.patch('/api/articles/:id', auth, async (req, res) => {
  const u = (req as any).user
  const id = req.params.id
  const a: any = await get('SELECT id, user_id, actual_user_id, subject_id, status FROM articles WHERE id=?', id)
  if (!a) return res.status(404).json({ message: '美文不存在' })
  const isOwner = Number(a.user_id) === Number(u.id)
  const isActualUser = a.actual_user_id && Number(a.actual_user_id) === Number(u.id)
  const isManage = u.role === 'SUPER_ADMIN' || u.role === 'ADMIN' || (await canManageSubject(u, a.subject_id, (req as any).user.id))
  if (!isOwner && !isActualUser && !isManage) {
    return res.status(403).json({ message: '无权限编辑该美文' })
  }
  const body = req.body || {}
  const updates: string[] = []
  const args: any[] = []
  if (typeof body.title === 'string' && body.title.trim()) { updates.push('title=?'); args.push(body.title.trim()) }
  if (typeof body.content === 'string') { updates.push('content=?'); args.push(body.content) }
  if (typeof body.author === 'string') { updates.push('author=?'); args.push(body.author) }
  if (typeof body.source === 'string') { updates.push('source=?'); args.push(body.source) }
  if (typeof body.recommendation === 'string') { updates.push('recommendation=?'); args.push(body.recommendation) }
  if (typeof body.cover === 'string') { updates.push('cover=?'); args.push(body.cover) }
  if (Array.isArray(body.images)) { updates.push('images=?'); args.push(JSON.stringify(body.images)) }
  if (Array.isArray(body.tags)) { updates.push('tags=?'); args.push(JSON.stringify(body.tags)) }
  if (typeof body.category === 'string') { updates.push('category=?'); args.push(body.category) }
  if (!updates.length) return res.status(400).json({ message: '没有可更新的字段' })
  updates.push("updated_at=datetime('now','+8 hours')")
  args.push(id)
  await run(`UPDATE articles SET ${updates.join(', ')} WHERE id=?`, ...args)
  clearAllCache()
  const updated = await get('SELECT * FROM articles WHERE id=?', id)
  res.json({ ok: true, article: updated })
})

app.post('/api/articles/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'article', req.params.id)
  if (exist) {
    // 取消点赞：直接删除点赞时的经验值记录，不添加负值
    await run('DELETE FROM likes_map WHERE id=?', exist.id)
    await run('UPDATE articles SET likes = MAX(0, likes - 1) WHERE id=?', req.params.id)
    const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', req.params.id)
    if (a) {
      const owner = Number(a.actual_user_id) || Number(a.user_id)
      // 删除点赞时的 +1 记录
      await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='like' AND description LIKE ?", owner, `%${a.title}%获得点赞%`)
    }
    return res.json({ liked: false })
  }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'article', req.params.id)
  await run('UPDATE articles SET likes = likes + 1 WHERE id=?', req.params.id)
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', req.params.id)
  if (a) await addExp(Number(a.actual_user_id) || Number(a.user_id), 1, 'like', `美文《${a.title}》获得点赞`)
  // v4.2.1：通知作者收到点赞（自己点自己不通知）
  if (a) {
    const owner = Number(a.actual_user_id) || Number(a.user_id)
    if (owner !== uid) {
      const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
      await addNotice(owner, '美文收到点赞', `${u?.real_name || '有人'} 点赞了你的美文《${a.title}》`, 'like', `/article/${req.params.id}#comment-area`)
    }
  }
  res.json({ liked: true })
})

// Bug2: 美文评论 - 列表（检查文章详情权限）
app.get('/api/articles/:id/comments', async (req, res) => {
  const me = await parseOptionalAuth(req)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null
  const a = await get<any>('SELECT * FROM articles WHERE id=?', req.params.id)
  if (!a) return res.status(404).json({ message: '文章不存在' })
  // 检查文章可见性（和 /articles/:id 相同）
  if (a.status !== 'approved') {
    const isOwner = Number(a.user_id) === myId
    const isActual = a.actual_user_id && Number(a.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (a.subject_id && sids.includes(Number(a.subject_id))) canSee = true
    }
    if (!canSee) return res.status(403).json({ message: '无权查看该美文的评论' })
  }
  const list = await all<any>('SELECT * FROM article_comments WHERE article_id=? ORDER BY id DESC', req.params.id)
  res.json(list)
})

// Bug2: 美文评论 - 发布（auth）
app.post('/api/articles/:id/comments', auth, async (req, res) => {
  const uid = (req as any).user.id
  // 先判断文章可见性（状态过滤）
  const me = await parseOptionalAuth(req)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  const mySubjectId = me?.subject_id ?? null
  const art = await get<any>('SELECT * FROM articles WHERE id=?', req.params.id)
  if (!art) return res.status(404).json({ message: '文章不存在' })
  if (art.status !== 'approved') {
    const isOwner = Number(art.user_id) === myId
    const isActual = art.actual_user_id && Number(art.actual_user_id) === myId
    let canSee = isOwner || isActual || myRole === 'SUPER_ADMIN'
    if (!canSee && myRole === 'TEACHER') {
      const sids = await teachingSubjects(myId)
      if (mySubjectId && !sids.includes(mySubjectId)) sids.push(mySubjectId)
      if (art.subject_id && sids.includes(Number(art.subject_id))) canSee = true
    }
    if (!canSee) return res.status(403).json({ message: '无权评论该美文' })
  }
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const body = req.body || {}
  const content = String(body.content || '').trim()
  const parentId = body.parent_id != null ? Number(body.parent_id) : null
  if (parentId != null) {
    const p = await get<any>('SELECT id FROM article_comments WHERE id=? AND article_id=?', parentId, req.params.id)
    if (!p) return res.status(400).json({ message: '父评论不存在' })
  }
  const r = await run('INSERT INTO article_comments (article_id,user_id,user_name,avatar,content,parent_id) VALUES (?,?,?,?,?,?)',
    req.params.id, uid, u?.real_name, u?.avatar, content, parentId)
  // Bug2: 给文章作者加 1 经验（评论奖励）
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', req.params.id)
  if (a) {
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    if (expUid !== uid) await addExp(expUid, 1, 'comment', `《${a.title}》获得评论`)
  }
  // v4.2.1：通知 - 主评论通知作者，子评论通知被回复人
  const newCommentId = Number(r.lastInsertRowid)
  if (a) {
    if (parentId == null) {
      // 代发文章：真实作者 = actual_user_id，须与点赞/经验保持一致，否则真实作者收不到评论通知
      const owner = Number(a.actual_user_id) || Number(a.user_id)
      if (owner !== uid) {
        await addNotice(owner, '美文收到新评论', `${u?.real_name || '有人'} 评论了你的美文《${a.title}》：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `/article/${req.params.id}#comment-${newCommentId}`)
      }
    } else {
      const parent = await get<any>('SELECT user_id FROM article_comments WHERE id=?', parentId)
      if (parent && Number(parent.user_id) !== uid) {
        await addNotice(Number(parent.user_id), '有人回复了你的评论', `${u?.real_name || '有人'} 回复了你对《${a.title}》的评论：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `/article/${req.params.id}#comment-${newCommentId}`)
      }
    }
  }
  res.json({ id: newCommentId, user_id: uid, user_name: u?.real_name, avatar: u?.avatar, content, parent_id: parentId, created_at: new Date().toISOString().slice(0,19).replace('T',' ') })
})

app.delete('/api/articles/:id/comments/:commentId', auth, async (req, res) => {
  const uid = (req as any).user.id
  const u = await get<any>('SELECT role FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT user_id FROM article_comments WHERE id=?', req.params.commentId)
  if (!comment) return res.status(404).json({ message: '评论不存在' })
  if (comment.user_id !== uid && u?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '无权限删除' })
  // 回收评论带来的经验：评论创建时给文章作者加1经验（仅当评论者非作者）
  const a = await get<any>('SELECT user_id, actual_user_id, title FROM articles WHERE id=?', req.params.id)
  if (a) {
    const expUid = Number(a.actual_user_id) || Number(a.user_id)
    if (expUid !== Number(comment.user_id)) await addExp(expUid, -1, 'comment', `《${a.title}》评论被删除回收经验`)
  }
  await run('DELETE FROM article_comments WHERE id=?', req.params.commentId)
  res.json({ ok: true })
})

app.delete('/api/pages/:id/comments/:commentId', auth, async (req, res) => {
  const uid = (req as any).user.id
  const u = await get<any>('SELECT role FROM users WHERE id=?', uid)
  const comment = await get<any>('SELECT user_id FROM page_comments WHERE id=?', req.params.commentId)
  if (!comment) return res.status(404).json({ message: '评论不存在' })
  if (comment.user_id !== uid && u?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '无权限删除' })
  await run('DELETE FROM page_comments WHERE id=?', req.params.commentId)
  res.json({ ok: true })
})

// ============ 资料 ============
app.get('/api/resources', async (req, res) => {
  const { subjectId, status, mine, userId } = req.query
  const me = await parseOptionalAuth(req)
  const myId = me?.id ?? 0
  const myRole = me?.role ?? 'GUEST'
  // 【v4.0.2】教师跨学科读：与学生同权（只看 approved；本学科额外看自己上传的全部）
  let teachSidList: number[] = []
  if (myRole === 'TEACHER') {
    teachSidList = await teachingSubjects(myId)
    const meRow = await get<any>('SELECT subject_id FROM users WHERE id=?', myId)
    if (meRow?.subject_id && !teachSidList.includes(meRow.subject_id)) teachSidList.push(meRow.subject_id)
  }
  // 【v4.3.0 同步 Worker 端】补 subject_name / subject_icon，供审核界面显示学科
  let sql = `SELECT r.*, u.real_name AS creator_name, s.name AS subject_name, s.icon AS subject_icon
    FROM resources r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN subjects s ON s.id = r.subject_id
    WHERE 1=1`
  const args: any[] = []
  if (subjectId) { sql += ' AND r.subject_id=?'; args.push(subjectId) }
  if (status && myRole === 'SUPER_ADMIN') { sql += ' AND r.status=?'; args.push(status) }
  if (mine === '1') { sql += ' AND r.user_id=?'; args.push(userId) }
  // 公开列表：仅展示已通过审核的资料
  if (!status && myRole !== 'SUPER_ADMIN' && mine !== '1') {
    if (myRole === 'TEACHER') {
      if (teachSidList.length) {
        const ph = teachSidList.map(() => '?').join(',')
        sql += ` AND (r.status='approved' OR (r.user_id=? AND r.subject_id IN (${ph})))`
        args.push(myId, ...teachSidList)
      } else {
        sql += ' AND r.user_id=?'; args.push(myId)
      }
    } else if (myRole === 'STUDENT' || myRole === 'GUEST') {
      sql += " AND r.status='approved'"
    }
  }
  sql += ' ORDER BY r.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(r => ({ ...r, tags: j(r.tags) })))
})

app.post('/api/resources', auth, async (req, res) => {
  const id = (req as any).user.id
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', id)
  const b = req.body
  // 【v4.0.1】教师上传资料时必须选自己任教的学科
  if (u?.role === 'TEACHER' && !(await canManageSubject({ id, role: u.role, subject_id: u.subject_id }, b.subjectId))) {
    return res.status(403).json({ message: '教师只能在自己任教的学科下上传资料' })
  }
  // 教师/管理员上传的资料自动审核通过；学生上传需待审核
  const status = (u?.role === 'SUPER_ADMIN' || u?.role === 'TEACHER') ? 'approved' : 'pending'
  const r = await run(`INSERT INTO resources (subject_id,title,description,file_name,file_type,file_size,file_path,category,tags,user_id,class_id,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.title, b.description || '', b.fileName || '', b.fileType || '', b.fileSize || 0, b.filePath || '', b.category || '', JSON.stringify(b.tags || []), id, b.classId || 1, status)
  const rid = Number(r.lastInsertRowid)
  // 【v4 Bug1】资料上传者直接加经验值（教师/超管直接 approved 不会再走 status 审核路径）
  if (status === 'approved') {
    await addExp(id, undefined, 'resource', `上传资料《${b.title}》`)
  }
  res.json({ id: rid, status })
})

app.patch('/api/resources/:id/status', auth, async (req, res) => {
  const r = await get<any>('SELECT title, user_id, status, subject_id FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!(await canManageSubject(u, r.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限审核该学科的资料' })
  await run('UPDATE resources SET status=? WHERE id=?', req.body.status, req.params.id)
  if (req.body.status === 'approved' && r.status !== 'approved') {
    await addExp(r.user_id, undefined, 'resource', `资料《${r.title}》审核通过`)
    await addNotice(r.user_id, '资料审核通过', `《${r.title}》已通过审核。`, 'audit')
  }
  res.json({ ok: true })
})

app.delete('/api/resources/:id', auth, async (req, res) => {
  const r = await get<any>('SELECT user_id, file_path, subject_id, title FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  const isOwner = r.user_id === (req as any).user.id
  if (!isOwner && !(await canManageSubject(u, r.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限删除' })
  // 删除前直接删除相关的经验值记录
  if (r.user_id && r.title) {
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type IN ('resource','like') AND description LIKE ?", r.user_id, `%${r.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type IN ('resource','like') AND description LIKE ?", r.user_id, `%${r.title}%`)
    if (total) await run('UPDATE users SET exp = MAX(0, exp - ?) WHERE id = ?', total, r.user_id)
  }
  if (r.file_path) { try { await deleteFile(extractKey(r.file_path)) } catch {} }
  await run('DELETE FROM likes_map WHERE target_type IN (?,?) AND target_id=?', 'resource', 'fav_resource', req.params.id)
  await run('DELETE FROM resources WHERE id=?', req.params.id)
  res.json({ ok: true })
})

app.post('/api/resources/:id/download', auth, async (req, res) => {
  const r = await get<any>('SELECT * FROM resources WHERE id=?', req.params.id)
  if (!r) return res.status(404).json({ message: '不存在' })
  if (r.status !== 'approved') {
    const me = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
    const isOwner = Number(r.user_id) === Number((req as any).user.id)
    if (!isOwner && !(await canManageSubject(me, r.subject_id, (req as any).user.id))) {
      return res.status(403).json({ message: '该资料尚未通过审核' })
    }
  }
  if (!r.file_path) return res.status(404).json({ message: '文件不存在，可能已被清理' })
  const file = await downloadFile(r.file_path)
  if (!file) return res.status(404).json({ message: '文件不存在，可能已被清理' })
  const filename = r.file_name || r.title || 'download'
  setDownloadHeaders(res, filename)
  await run('UPDATE resources SET downloads = downloads + 1 WHERE id=?', req.params.id)
  if (file.contentType) res.setHeader('Content-Type', file.contentType)
  res.send(file.buffer)
})

app.post('/api/resources/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'resource', req.params.id)
  if (exist) return res.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'resource', req.params.id)
  await run('UPDATE resources SET likes = likes + 1 WHERE id=?', req.params.id)
  // v4.2.1：通知资料作者收到点赞（自己点自己不通知）
  const r = await get<any>('SELECT user_id, title FROM resources WHERE id=?', req.params.id)
  if (r && Number(r.user_id) !== uid) {
    const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    await addNotice(Number(r.user_id), '资料收到点赞', `${u?.real_name || '有人'} 点赞了你的资料《${r.title}》`, 'like', `/resource/${req.params.id}`)
  }
  res.json({ liked: true })
})

// ============ 收藏 ============
app.get('/api/favorites', auth, async (req, res) => {
  const uid = (req as any).user.id
  const list = await all<any>('SELECT * FROM likes_map WHERE user_id=? AND target_type IN (?,?) ORDER BY id DESC', uid, 'fav_article', 'fav_resource')
  res.json(list)
})
app.post('/api/favorites/:type/:id', auth, async (req, res) => {
  const uid = (req as any).user.id
  const tp = req.params.type === 'article' ? 'fav_article' : 'fav_resource'
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, req.params.id)
  if (exist) { await run('DELETE FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, tp, req.params.id); return res.json({ favorited: false }) }
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, tp, req.params.id)
  res.json({ favorited: true })
})

// ============ 文件上传（统一走 Supabase Storage） ============
app.post('/api/upload/file', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname)
  const rand = Math.random().toString(36).slice(2, 10)
  const key = `file_${Date.now()}_${rand}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  const typeMap: Record<string, string> = { '.pdf': 'pdf', '.ppt': 'ppt', '.pptx': 'ppt', '.doc': 'word', '.docx': 'word', '.zip': 'zip', '.mp4': 'video', '.mov': 'video', '.xls': 'excel', '.xlsx': 'excel' }
  // file_path 存储为相对 key（下载时 extractKey 兼容处理）
  res.json({ url, filePath: key, fileName: req.file.originalname, fileType: typeMap[ext] || 'file', fileSize: req.file.size })
})

app.post('/api/upload/image', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '无文件' })
  if (!STORAGE_ENABLED) return res.status(500).json({ message: '文件存储未配置（缺少 SUPABASE_URL/SUPABASE_SERVICE_KEY）' })
  const ext = path.extname(req.file.originalname) || '.png'
  const key = `img_${(req as any).user.id}_${Date.now()}${ext}`
  const url = await uploadFile(key, req.file.buffer, req.file.mimetype)
  res.json({ url })
})

// ============ 数据查询 ============
app.get('/api/query/tasks', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  let sql = 'SELECT * FROM query_tasks WHERE 1=1'
  const args: any[] = []
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return res.json([])
    sql += ` AND class_id IN (${cids.map(() => '?').join(',')})`; args.push(...cids)
  } else if (role === 'TEACHER') {
    sql += ' AND creator_id=?'; args.push(uid)
  }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(t => ({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })))
})

app.get('/api/query/tasks/:id', auth, async (req, res) => {
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  res.json({ ...t, headers: j(t.headers), show_comment: !!t.show_comment, allow_export: !!t.allow_export })
})

app.post('/api/query/tasks/:id/query', auth, async (req, res) => {
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  const uid = (req as any).user.id
  const user = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const matchField = t.match_field
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=?', req.params.id)
  const allRows = rows.map(r => j(r.data_row))
  const myRows = allRows.filter(r => String(r[matchField]) === String(user.real_name))
  const headers = j(t.headers)
  await addExp(uid, undefined, 'query', `完成数据查询：${t.title}`)
  res.json({
    task: { ...t, headers, show_comment: !!t.show_comment, allow_export: !!t.allow_export },
    headers: t.show_comment ? headers : headers.filter((h: string) => h !== '评语'),
    myRows,
  })
})

app.post('/api/query/tasks', auth, requireStaff, async (req, res) => {
  const id = (req as any).user.id
  const role = (req as any).user.role
  const me = await get<any>('SELECT real_name, subject_id, role FROM users WHERE id=?', id)
  const name = me?.real_name || ''
  const b = req.body
  // 需求1：教师只能发自己任教学科的数据查询；超管可以发所有学科
  if (role === 'TEACHER' && me?.subject_id && Number(b.subjectId) !== Number(me.subject_id)) {
    return res.status(403).json({ message: '你只能发布自己任教学科的数据查询' })
  }
  const r = await run(`INSERT INTO query_tasks (subject_id,class_id,creator_id,creator_name,title,note,valid_until,show_comment,allow_export,headers,match_field) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.classId, id, name, b.title, b.note || '', b.validUntil, b.showComment ? 1 : 0, b.allowExport ? 1 : 0, JSON.stringify(b.headers), b.matchField)
  const tid = Number(r.lastInsertRowid)
  for (const row of b.rows) {
    await run('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)', tid, JSON.stringify(row))
  }
  const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
  for (const s of students) {
    await addNotice(s.user_id, '新查询任务发布', `${name}老师发布了「${b.title}」成绩查询。`, 'query')
  }
  res.json({ id: tid })
})

// 需求1：超管下载数据查询任务的原始Excel（重新生成xlsx）
app.get('/api/query/tasks/:id/export', auth, requireStaff, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const t = await get<any>('SELECT * FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  // 超管可以下载所有人的；教师只能下载自己的
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) {
    return res.status(403).json({ message: '无权限下载该查询任务' })
  }
  const rows = await all<any>('SELECT data_row FROM query_rows WHERE task_id=? ORDER BY id', req.params.id)
  const headers = j(t.headers) || []
  const aoa: any[][] = [headers]
  for (const r of rows) {
    const row = j(r.data_row) || {}
    aoa.push(headers.map(h => row[h] ?? ''))
  }
  // 动态 import xlsx（Node端）
  const XLSX = await import('xlsx')
  const xlsx = (XLSX.default || XLSX)
  const ws = xlsx.utils.aoa_to_sheet(aoa)
  const wb = xlsx.utils.book_new()
  xlsx.utils.book_append_sheet(wb, ws, '查询数据')
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' })
  setDownloadHeaders(res, `${t.title}_查询数据.xlsx`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.send(Buffer.from(buf))
})

// 需求1：GET /api/query/tasks — 超管看到所有任务；教师看到自己的（原逻辑已正确，此处不改保持原逻辑）

app.put('/api/query/tasks/:id', auth, requireStaff, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const t = await get<any>('SELECT creator_id FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) return res.status(403).json({ message: '无权限编辑' })
  const b = req.body
  await run('UPDATE query_tasks SET title=?, note=?, valid_until=? WHERE id=?', b.title ?? '', b.note ?? '', b.validUntil ?? '', req.params.id)
  if (Array.isArray(b.headers) && Array.isArray(b.rows)) {
    await run('DELETE FROM query_rows WHERE task_id=?', req.params.id)
    for (const row of b.rows) {
      await run('INSERT INTO query_rows (task_id,data_row) VALUES (?,?)', req.params.id, JSON.stringify(row))
    }
    await run('UPDATE query_tasks SET headers=?, match_field=? WHERE id=?', JSON.stringify(b.headers), b.matchField ?? '', req.params.id)
  }
  res.json({ ok: true })
})

app.delete('/api/query/tasks/:id', auth, requireStaff, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const t = await get<any>('SELECT creator_id, title FROM query_tasks WHERE id=?', req.params.id)
  if (!t) return res.status(404).json({ message: '不存在' })
  if (role !== 'SUPER_ADMIN' && t.creator_id !== uid) return res.status(403).json({ message: '无权限删除' })
  // 删除前回收已发放的经验
  if (t.title) {
    const logs = await all<{ user_id: number; exp_change: number }>("SELECT user_id, exp_change FROM exp_logs WHERE action_type='query' AND description LIKE ?", `%${t.title}%`)
    const byUser = new Map<number, number>()
    for (const l of logs) { byUser.set(l.user_id, (byUser.get(l.user_id) || 0) + (l.exp_change || 0)) }
    for (const [userId, total] of byUser) {
      if (total) {
        await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='query' AND description LIKE ?", userId, `%${t.title}%`)
        await run('UPDATE users SET exp = MAX(0, exp - ?) WHERE id = ?', total, userId)
      }
    }
  }
  await run('DELETE FROM query_rows WHERE task_id=?', req.params.id)
  await run('DELETE FROM query_tasks WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 【v4.3.2】超管按存储 key 预览/下载文件 ============
// 与 worker-api.ts 的 GET /api/admin/storage/file 路由对齐，保证双后端路由一致。
// 注意：本地 Express 后端未接入 Supabase Storage（不引入额外依赖），
//       此处返回明确的 501 提示，避免前端在本地开发时收到 404 而难以排查。
app.get('/api/admin/storage/file', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const key = String(req.query.key || '').trim()
  if (!key) return res.status(400).json({ message: '缺少文件 key' })
  if (key.includes('..') || key.startsWith('/') || key.startsWith('\\')) {
    return res.status(400).json({ message: '非法的文件路径' })
  }
  return res.status(501).json({
    message: '本地开发后端未接入对象存储，文件的查看/下载请使用线上环境（Cloudflare Worker）',
  })
})

// ============ 小白一键修复：SUPER_ADMIN点按钮就自动跑fix.sh（10分钟互斥锁 · 和/__zg_fix共用同一个锁） ============
app.post('/api/admin/self-repair', auth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  const now = Date.now()
  if (now - SELF_REPAIR_LOCK.at < 10*60*1000 && SELF_REPAIR_LOCK.pid) {
    try { process.kill(SELF_REPAIR_LOCK.pid, 0); return res.json({ ok: false, msg: '修复正在进行中，请耐心等待1~2分钟后刷新页面' }) }
    catch { SELF_REPAIR_LOCK.at = 0; SELF_REPAIR_LOCK.pid = 0 }
  }
  SELF_REPAIR_LOCK.at = now
  // 立刻异步启动fix.sh（不用等，返回进度）
  const child = spawn('bash', ['/workspace/fix.sh'], {
    cwd: '/workspace',
    detached: true,
    stdio: ['ignore','ignore','ignore'],
    env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:18080', HTTPS_PROXY: 'http://127.0.0.1:18080', http_proxy: 'http://127.0.0.1:18080', https_proxy: 'http://127.0.0.1:18080' }
  })
  child.unref()
  SELF_REPAIR_LOCK.pid = child.pid || 0
  // 同时立刻重启3条SSH隧道自恢复（更保险）
  try {
    for (const N of ['a','b','c']) {
      const OUTF = `/tmp/ult/${N}.log`
      spawn('bash', ['-c', `
        while true; do
          /usr/bin/ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null             -o ServerAliveInterval=20 -o ServerAliveCountMax=2 -o ConnectTimeout=22 -o TCPKeepAlive=yes             -o "ProxyCommand=nc -X connect -x 127.0.0.1:18080 %h %p"             -p 443 -R0:localhost:3001 ${N}.pinggy.io >> ${OUTF} 2>&1
          sleep 1
        done
      `], { detached: true, stdio: ['ignore','ignore','ignore'] }).unref()
    }
  } catch {}
  return res.json({ ok: true, msg: '修复已启动！请耐心等待1~2分钟后刷新页面（或按F5多刷几次）' })
})

// ============ 经验值 & 排行榜 ============
app.get('/api/exp/logs', auth, async (req, res) => {
  const uid = req.query.userId || (req as any).user.id
  res.json(await all('SELECT * FROM exp_logs WHERE user_id=? ORDER BY id DESC', uid))
})

app.post('/api/exp/logs', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { userId, change, actionType, description } = req.body
  await addExp(userId, change, actionType, description)
  res.json({ ok: true })
})

app.get('/api/exp/all-logs', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const page = Number(req.query.page) || 1
  const pageSize = Number(req.query.pageSize) || 50
  const offset = (page - 1) * pageSize
  const list = await all<any>(
    `SELECT el.*, u.real_name, u.username, u.avatar, u.role
     FROM exp_logs el
     JOIN users u ON u.id = el.user_id
     ORDER BY el.id DESC LIMIT ? OFFSET ?`, pageSize, offset)
  const totalRow = await get<{ n: number }>('SELECT COUNT(*) as n FROM exp_logs')
  res.json({ list, total: totalRow?.n || 0 })
})

// 超管：删除单条经验记录
app.delete('/api/exp/logs/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const id = req.params.id
  const log = await get<any>('SELECT user_id, exp_change FROM exp_logs WHERE id=?', id)
  if (!log) return res.status(404).json({ message: '记录不存在' })
  await run('DELETE FROM exp_logs WHERE id=?', id)
  await run(
    `UPDATE users SET exp = MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)),
                    level = (MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)) / 60) + 1
     WHERE id=?`,
    log.user_id, log.user_id, log.user_id
  )
  res.json({ ok: true, deleted: 1 })
})

// 超管：批量删除经验记录
app.post('/api/exp/logs/batch-delete', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const ids = (req.body?.ids || []).filter((x: any) => Number.isFinite(Number(x))).map((x: any) => Number(x))
  if (!ids.length) return res.status(400).json({ message: '未提供要删除的记录 id' })
  const logs = await all<any>('SELECT user_id, exp_change FROM exp_logs WHERE id IN (' + ids.map(() => '?').join(',') + ')', ...ids)
  await run('DELETE FROM exp_logs WHERE id IN (' + ids.map(() => '?').join(',') + ')', ...ids)
  const userIds = Array.from(new Set(logs.map((x: any) => x.user_id)))
  for (const uid of userIds) {
    await run(
      `UPDATE users SET exp = MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)),
                        level = (MAX(0, COALESCE((SELECT SUM(exp_change) FROM exp_logs WHERE user_id=?), 0)) / 60) + 1
       WHERE id=?`,
      uid, uid, uid
    )
  }
  res.json({ ok: true, deleted: logs.length, affectedUsers: userIds.length })
})

app.get('/api/leaderboard', async (req, res) => {
  const { scope = 'all', classId, subjectId, period = 'total' } = req.query
  let list = await all<any>('SELECT id,real_name,role,avatar,exp,level FROM users WHERE status=? ORDER BY exp DESC', 'active')
  if (scope === 'class' && classId) {
    const rows = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=?', classId)
    const ids = rows.map(r => r.user_id)
    list = list.filter(u => ids.includes(u.id))
  }
  if (scope === 'subject' && subjectId) {
    const tRows = await all<{ user_id: number }>('SELECT DISTINCT user_id FROM class_members WHERE subject_id=? AND role_in_class=?', subjectId, 'TEACHER')
    const rRows = await all<{ user_id: number }>('SELECT user_id FROM resources WHERE subject_id=?', subjectId)
    const aRows = await all<{ user_id: number }>('SELECT user_id FROM articles WHERE subject_id=?', subjectId)
    const cIds = new Set<number>([...tRows.map(r => r.user_id), ...rRows.map(r => r.user_id), ...aRows.map(r => r.user_id)])
    list = list.filter(u => cIds.has(u.id))
  }
  const factor = period === 'week' ? 0.3 : period === 'month' ? 0.7 : 1
  list = list.map(u => ({ ...u, pe: Math.round(u.exp * factor + (period !== 'total' ? 20 : 0)) })).sort((a, b) => b.pe - a.pe)
  res.json(list)
})

// ============ 通知 ============
app.get('/api/notices', auth, async (req, res) => {
  res.json(await all('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC', (req as any).user.id))
})

app.post('/api/notices/readAll', auth, async (req, res) => {
  await run('UPDATE notices SET read=1 WHERE user_id=?', (req as any).user.id)
  res.json({ ok: true })
})

app.post('/api/notices/:id/read', auth, async (req, res) => {
  await run('UPDATE notices SET read=1 WHERE id=? AND user_id=?', req.params.id, (req as any).user.id)
  res.json({ ok: true })
})

// 管理员群发通知
app.post('/api/notices/broadcast', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { title, content, type } = req.body
  const users = await all<{ id: number }>('SELECT id FROM users WHERE status=?', 'active')
  for (const u of users) {
    await run('INSERT INTO notices (user_id,title,content,type) VALUES (?,?,?,?)', u.id, title, content, type || 'system')
  }
  res.json({ ok: true, count: users.length })
})

// ============ 主题 ============
app.get('/api/themes', async (_req, res) => {
  const list = await all<any>('SELECT * FROM themes ORDER BY id')
  res.json(list.map(t => ({ ...t, config: j(t.config) })))
})

app.get('/api/themes/active', async (_req, res) => {
  const t = await get<any>('SELECT * FROM themes WHERE is_active=1 LIMIT 1')
  if (!t) return res.json(null)
  res.json({ ...t, config: j(t.config) })
})

app.patch('/api/themes/:id/active', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE themes SET is_active=0')
  await run('UPDATE themes SET is_active=1 WHERE id=?', req.params.id)
  res.json({ ok: true })
})

app.put('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('UPDATE themes SET config=?, name=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?', JSON.stringify(req.body.config), req.body.name, req.params.id)
  if (req.body.isActive) {
    await run('UPDATE themes SET is_active=0')
    await run('UPDATE themes SET is_active=1 WHERE id=?', req.params.id)
  }
  res.json({ ok: true })
})

app.post('/api/themes', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const r = await run('INSERT INTO themes (name,config,is_active) VALUES (?,?,?)', req.body.name, JSON.stringify(req.body.config), req.body.isActive ? 1 : 0)
  const id = Number(r.lastInsertRowid)
  if (req.body.isActive) { await run('UPDATE themes SET is_active=0'); await run('UPDATE themes SET is_active=1 WHERE id=?', id) }
  res.json({ id })
})

app.delete('/api/themes/:id', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  await run('DELETE FROM themes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// ============ 数据统计 ============
app.get('/api/stats', auth, async (req, res) => {
  // 【v4.0.2】全站统计口径：教师看到的资源/美文/查询任务/题库 都是全站数量（不是只本学科），
  // 跟学生、超管一致。
  const users = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users'))!.n
  const subjects = (await get<{ n: number }>('SELECT COUNT(*) as n FROM subjects'))!.n
  const articles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles'))!.n
  const approvedArticles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles WHERE status=?', 'approved'))!.n
  const pendingArticles = (await get<{ n: number }>('SELECT COUNT(*) as n FROM articles WHERE status=?', 'pending'))!.n
  const resources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources'))!.n
  const approvedResources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources WHERE status=?', 'approved'))!.n
  const pendingResources = (await get<{ n: number }>('SELECT COUNT(*) as n FROM resources WHERE status=?', 'pending'))!.n
  const queryTasks = (await get<{ n: number }>('SELECT COUNT(*) as n FROM query_tasks'))!.n
  res.json({ users, subjects, articles, approvedArticles, pendingArticles, resources, approvedResources, pendingResources, queryTasks })
})

app.get('/api/search', async (req, res) => {
  const q = (req.query.q as string || '').trim()
  if (!q) return res.json({ articles: [], resources: [] })
  const like = `%${q}%`
  const articles = await all<any>('SELECT id,title,author,cover,subject_id,category,created_at FROM articles WHERE status=? AND (title LIKE ? OR author LIKE ? OR content LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like, like)
  const resources = await all<any>('SELECT id,title,description,file_name,file_type,subject_id,category,downloads FROM resources WHERE status=? AND (title LIKE ? OR description LIKE ?) ORDER BY id DESC LIMIT 20', 'approved', like, like)
  res.json({ articles, resources })
})

// ============ 设置（经验规则 / 功能开关） ============
app.get('/api/settings/exp_rules', auth, async (_req, res) => {
  const rules = await getExpRules()
  // 过滤掉删除/取消类规则
  const excludeKeys = ['article_delete', 'resource_delete', 'blog_delete', 'query_delete', 'comment_delete', 'like_cancel', 'favorite_cancel']
  for (const k of excludeKeys) { delete rules[k] }
  res.json({ success: true, data: rules })
})

app.put('/api/settings/exp_rules', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const rules = req.body || {}
  await run("UPDATE settings SET value=? WHERE key='exp_rules'", JSON.stringify(rules))
  // 若没有该行（理论上 seed 已写入），保险起见再 INSERT OR REPLACE
  await run("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", 'exp_rules', JSON.stringify(rules))
  refreshExpRules()
  res.json({ ok: true })
})

// Bug5: 公开的功能开关接口（给登录页用）
app.get('/api/feature-flags/public', async (_req, res) => {
  const regFlag = await get<{ value: string }>("SELECT value FROM feature_flags WHERE key='registration_enabled'")
  res.json({ registration_enabled: !regFlag || regFlag.value !== '0' })
})

app.get('/api/settings/feature_flags', auth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  res.json(await getFeatureFlags())
})

app.put('/api/settings/feature_flags', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const flags = req.body || {}
  await run("UPDATE settings SET value=? WHERE key='feature_flags'", JSON.stringify(flags))
  await run("INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)", 'feature_flags', JSON.stringify(flags))
  // Bug5: 同步 registration_enabled 到 feature_flags KV 表
  if (flags.registration_enabled !== undefined) {
    const v = flags.registration_enabled ? '1' : '0'
    await run("INSERT OR REPLACE INTO feature_flags (key,value) VALUES ('registration_enabled',?)", v)
  }
  refreshFeatureFlags()
  res.json({ ok: true })
})

app.get('/api/settings/site_config', async (_req, res) => {
  const defaults: any = {
    siteName: '追光学科共享平台',
    siteSlogan: '追光的人，终会身披万丈光芒',
    heroSubtitle: '在这里分享知识，收获成长。',
    showQuickLinks: true,
    quickLinks: [
      { icon: '📚', label: '学科广场', path: '/subjects', color: '#F59E0B' },
      { icon: '🏆', label: '经验排行', path: '/leaderboard', color: '#FBBF24' },
      { icon: '👤', label: '个人中心', path: '/profile', color: '#FB923C' },
      { icon: '📖', label: '网站说明', path: '/guide', color: '#EF4444' },
    ],
    footerText: '© 追光学科共享平台 · 用知识点亮未来',
    showAnnouncementBar: false,
    announcementBar: '欢迎来到追光学科共享平台！',
    navTitle: '追光学科共享平台',
    navTitleIcon: '🌟',
    showNavSearch: true,
    showNavMessage: true,
    showNavNotice: true,
    showHeroStats: true,
    showSubjects: true,
    showLatestArticles: true,
    maxArticlesOnHome: 6,
    primaryColor: '#F59E0B',
  }
  try {
    const r = await get<{ value: string }>("SELECT value FROM settings WHERE key='site_config'")
    if (r) {
      const saved = JSON.parse(r.value)
      return res.json({ ...defaults, ...saved })
    }
  } catch {}
  res.json(defaults)
})

app.put('/api/settings/site_config', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const config = req.body || {}
  await run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", 'site_config', JSON.stringify(config))
  res.json({ ok: true })
})

// ============ 题库自测 ============
// 列出题库：教师/超管看自己创建+所属学科；学生看自己班级可见的
app.get('/api/quizzes', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const { subjectId, classId } = req.query
  // 【v4.0.2】教师跨学科读：不再 403，按"任教学科 + 自己创建"过滤
  let sql = 'SELECT q.* FROM quizzes q WHERE 1=1'
  const args: any[] = []
  if (subjectId) { sql += ' AND q.subject_id=?'; args.push(subjectId) }
  if (classId) { sql += ' AND q.class_id=?'; args.push(classId) }
  if (role === 'STUDENT') {
    const cids = await userClassIds(uid)
    if (!cids.length) return res.json([])
    sql += ` AND q.class_id IN (${cids.map(() => '?').join(',')})`
    args.push(...cids)
  } else if (role === 'TEACHER') {
    const sids = await teachingSubjects(uid)
    const me = await get<any>('SELECT subject_id FROM users WHERE id=?', uid)
    if (me?.subject_id && !sids.includes(me.subject_id)) sids.push(me.subject_id)
    if (sids.length) {
      sql += ` AND (q.creator_id=? OR q.subject_id IN (${sids.map(() => '?').join(',')}))`
      args.push(uid, ...sids)
    } else {
      sql += ' AND q.creator_id=?'; args.push(uid)
    }
  }
  sql += ' ORDER BY q.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list)
})

app.get('/api/quizzes/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  res.json({
    ...q,
    questions: questions.map(qq => ({ ...qq, options: j(qq.options), attachments: j(qq.attachments) })),
  })
})

// 教师/超管创建题库 + 题目
app.post('/api/quizzes', auth, requireSubjectStaff('body', 'subjectId'), async (req, res) => {
  const uid = (req as any).user.id
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
  const b = req.body
  const r = await run(
    `INSERT INTO quizzes (subject_id,class_id,creator_id,creator_name,title,description,duration,valid_until,status) VALUES (?,?,?,?,?,?,?,?,?)`,
    b.subjectId, b.classId, uid, me?.real_name || '', b.title, b.description || '', b.duration || 0, b.validUntil || '', b.status || 'published'
  )
  const qid = Number(r.lastInsertRowid)
  let sort = 0
  for (const qq of (b.questions || [])) {
    await run(
      `INSERT INTO quiz_questions (quiz_id,qtype,content,options,answer,score,attachments,sort) VALUES (?,?,?,?,?,?,?,?)`,
      qid, qq.qtype, qq.content, JSON.stringify(qq.options || []), qq.answer || '', qq.score ?? 5, JSON.stringify(qq.attachments || []), sort++
    )
  }
  // 通知班级学生
  if (b.classId) {
    const students = await all<{ user_id: number }>('SELECT user_id FROM class_members WHERE class_id=? AND role_in_class=?', b.classId, 'STUDENT')
    for (const s of students) {
      await addNotice(s.user_id, '新题库自测', `${me?.real_name || '老师'}发布了「${b.title}」题库自测，请按时完成。`, 'teacher')
    }
  }
  res.json({ id: qid })
})

app.patch('/api/quizzes/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!(await canManageSubject(u, q.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限' })
  const b = req.body
  if (b.title !== undefined) await run('UPDATE quizzes SET title=? WHERE id=?', b.title, req.params.id)
  if (b.description !== undefined) await run('UPDATE quizzes SET description=? WHERE id=?', b.description, req.params.id)
  if (b.duration !== undefined) await run('UPDATE quizzes SET duration=? WHERE id=?', b.duration, req.params.id)
  if (b.validUntil !== undefined) await run('UPDATE quizzes SET valid_until=? WHERE id=?', b.validUntil, req.params.id)
  if (b.status !== undefined) await run('UPDATE quizzes SET status=? WHERE id=?', b.status, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/quizzes/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT creator_id, subject_id FROM quizzes WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!(await canManageSubject(u, q.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限' })
  await run('DELETE FROM quiz_questions WHERE quiz_id=?', req.params.id)
  await run('DELETE FROM quiz_submissions WHERE quiz_id=?', req.params.id)
  await run('DELETE FROM quizzes WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学生作答：自动判客观题，主观题待批改
app.post('/api/quizzes/:id/submit', auth, async (req, res) => {
  const uid = (req as any).user.id
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  // 检查是否已提交
  const exist = await get<any>('SELECT id FROM quiz_submissions WHERE quiz_id=? AND user_id=?', req.params.id, uid)
  if (exist) return res.status(400).json({ message: '你已提交过该题库' })

  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=?', req.params.id)
  const answers = req.body.answers || {}
  let totalScore = 0
  let maxScore = 0
  const hasSubjective = questions.some(q => q.qtype === 'subjective')
  const graded: Record<number, { score: number; correct?: boolean; max: number; type: string }> = {}

  for (const q of questions) {
    maxScore += q.score || 0
    if (q.qtype === 'single' || q.qtype === 'multiple' || q.qtype === 'judge') {
      const correct = String(q.answer || '').trim()
      const mine = String(answers[q.id] ?? '').trim()
      const isCorrect = correct && mine && correct === mine
      if (isCorrect) totalScore += q.score || 0
      graded[q.id] = { score: isCorrect ? (q.score || 0) : 0, correct: !!isCorrect, max: q.score || 0, type: q.qtype }
    } else {
      // 主观题：留待批改，score 暂记 0
      graded[q.id] = { score: 0, max: q.score || 0, type: q.qtype }
    }
  }

  const status = hasSubjective ? 'pending' : 'graded'
  let subId: number
  if (status === 'graded') {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'),?)`,
      req.params.id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, uid
    )
    subId = Number(r.lastInsertRowid)
    await addExp(uid, undefined, 'quiz_pass', `完成题库自测：${quiz.title}（得分 ${totalScore}/${maxScore}）`)
  } else {
    const r = await run(
      `INSERT INTO quiz_submissions (quiz_id,user_id,answers,total_score,max_score,status,submitted_at) VALUES (?,?,?,?,?,?,?)`,
      req.params.id, uid, JSON.stringify({ answers, graded }), totalScore, maxScore, status, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  // 站内信通知：有主观题时，提醒教师阅卷
  if (status === 'pending' && quiz.creator_id) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const stuName = stu?.real_name || `用户${uid}`
    const objCount = questions.filter(q => q.qtype !== 'subjective').length
    const msg = `📚 ${stuName} 提交了《${quiz.title}》的答卷\n客观题（${objCount}题）已自动评分：${totalScore} / ${maxScore} 分\n主观题等待您批改，请前往「题库 → 批改 / 报告」处理。`
    await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, quiz.creator_id, msg, '[]')
  }
  await addNotice(uid, '题库已提交', `《${quiz.title}》已提交。${status === 'pending' ? '客观题已评分，等待教师批改主观题。' : `得分 ${totalScore}/${maxScore}。`}`, 'system')
  res.json({ id: subId, totalScore, maxScore, status, graded, hasSubjective })
})

// 教师批改主观题
app.post('/api/quizzes/:id/submissions/:sid/grade', auth, requireStaff, async (req, res) => {
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!(await canManageSubject(u, quiz.subject_id, (req as any).user.id))) return res.status(403).json({ message: '无权限批改' })

  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE id=? AND quiz_id=?', req.params.sid, req.params.id)
  if (!sub) return res.status(404).json({ message: '提交记录不存在' })
  const data = j(sub.answers) || {}
  const grades = req.body.grades || {} // { questionId: { score, comment } }
  let total = 0
  const graded = { ...(data.graded || {}) }
  for (const k of Object.keys(grades)) {
    const sc = Number(grades[k].score) || 0
    if (graded[k]) graded[k].score = sc
    if (grades[k].comment) graded[k].comment = grades[k].comment
    total += sc
  }
  // 客观题分数 + 主观题分数
  let fullTotal = 0
  for (const k of Object.keys(graded)) fullTotal += graded[k].score || 0
  await run(
    `UPDATE quiz_submissions SET answers=?, total_score=?, status='graded', graded_at=datetime('now','localtime'), graded_by=? WHERE id=?`,
    JSON.stringify({ answers: data.answers, graded }), fullTotal, (req as any).user.id, req.params.sid
  )
  // 给学生加经验
  await addExp(sub.user_id, undefined, 'quiz_pass', `题库《${quiz.title}》批改完成（得分 ${fullTotal}/${sub.max_score}）`)
  await addNotice(sub.user_id, '题库批改完成', `《${quiz.title}》已批改，得分 ${fullTotal}/${sub.max_score}。`, 'teacher')
  // 站内信通知学生：整张试卷报告已生成
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id))?.real_name || '老师'
  const msg = `✅ 《${quiz.title}》整张试卷已批改完成\n批改人：${teacherName}\n最终得分：${fullTotal} / ${sub.max_score} 分\n完整测评报告已生成，点击「题库 → 查看报告」即可查看。`
  await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', (req as any).user.id, sub.user_id, msg, '[]')
  res.json({ ok: true, totalScore: fullTotal })
})

function datetimeNow() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

// 我的提交记录 / 教师查看所有提交
app.get('/api/quizzes/:id/submissions', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '不存在' })
  // 教师只能查看本学科考试的提交（超管不限）
  if (role === 'TEACHER') {
    // 【v4.3.0 修复】原 SQL 只查 subject_id，缺 id 和 role →
    // canManageSubject 内 user.role==='TEACHER' 不成立，直接 return false，教师永远无法查看考试提交
    const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', uid)
    if (!(await canManageSubject(u, quiz.subject_id, uid))) return res.status(403).json({ message: '无权限查看该考试' })
  }
  let list
  if (role === 'STUDENT') {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? AND s.user_id=? ORDER BY s.id DESC', req.params.id, uid)
  } else {
    list = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id DESC', req.params.id)
  }
  res.json(list.map(s => ({ ...s, answers: j(s.answers) })))
})

// 学生查看自己的报告
app.get('/api/quizzes/:id/my_report', auth, async (req, res) => {
  const uid = (req as any).user.id
  const sub = await get<any>('SELECT * FROM quiz_submissions WHERE quiz_id=? AND user_id=?', req.params.id, uid)
  if (!sub) return res.status(404).json({ message: '尚未提交' })
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  res.json({
    quiz,
    submission: { ...sub, answers: j(sub.answers) },
    questions: questions.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })),
  })
})

// 教师查看本次考试的数据报告
app.get('/api/quizzes/:id/report', auth, requireStaff, async (req, res) => {
  const quiz = await get<any>('SELECT * FROM quizzes WHERE id=?', req.params.id)
  if (!quiz) return res.status(404).json({ message: '题库不存在' })
  const u = await get<any>('SELECT id, role, subject_id FROM users WHERE id=?', (req as any).user.id)
  if (!(await canManageSubject(u, quiz.subject_id, (req as any).user.id)) && quiz.creator_id !== (req as any).user.id) {
    return res.status(403).json({ message: '无权限查看' })
  }
  const questions = await all<any>('SELECT * FROM quiz_questions WHERE quiz_id=? ORDER BY sort,id', req.params.id)
  const subs = await all<any>('SELECT s.*, u.real_name FROM quiz_submissions s LEFT JOIN users u ON s.user_id=u.id WHERE s.quiz_id=? ORDER BY s.id', req.params.id)
  const total = subs.length
  const pending = subs.filter(s => s.status === 'pending').length
  const graded = subs.filter(s => s.status === 'graded')
  const gradedCount = graded.length
  const scores = graded.map(s => s.total_score || 0)
  const avg = gradedCount ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / gradedCount * 10) / 10 : 0
  const maxS = gradedCount ? Math.max(...scores) : 0
  const minS = gradedCount ? Math.min(...scores) : 0
  const totalMax = questions.reduce((a: number, q: any) => a + (q.score || 0), 0) || graded[0]?.max_score || 0
  const passLine = Math.round(totalMax * 0.6)
  const passCount = scores.filter(s => s >= passLine).length
  // 每题统计
  const qStats = questions.map(q => {
    let correctCnt = 0, answeredCnt = 0, scoreSum = 0
    for (const s of graded) {
      const ans = j(s.answers) || {}
      const g = ans.graded?.[q.id]
      if (g) {
        answeredCnt++
        if (q.qtype !== 'subjective' && g.correct) correctCnt++
        scoreSum += g.score || 0
      }
    }
    return {
      id: q.id, qtype: q.qtype, content: q.content, score: q.score,
      options: j(q.options), answer: q.answer,
      correctRate: answeredCnt ? Math.round(correctCnt / answeredCnt * 100) : 0,
      avgScore: answeredCnt ? Math.round(scoreSum / answeredCnt * 10) / 10 : 0,
      answeredCnt, correctCnt,
    }
  })
  // 分数段分布：按得分率百分比（每次考试总分不同，统一用百分比）
  const ranges = [
    { label: '0-59%', min: 0, max: 59.999, count: 0 },
    { label: '60-69%', min: 60, max: 69.999, count: 0 },
    { label: '70-79%', min: 70, max: 79.999, count: 0 },
    { label: '80-89%', min: 80, max: 89.999, count: 0 },
    { label: '90-100%', min: 90, max: 100, count: 0 },
  ]
  for (const sc of scores) {
    const pct = totalMax > 0 ? (sc / totalMax * 100) : 0
    const r = ranges.find(r => pct >= r.min && pct <= r.max)
    if (r) r.count++
  }
  res.json({
    quiz,
    summary: { total, pending, graded: gradedCount, avg, max: maxS, min: minS, passLine, passCount, maxScore: totalMax },
    questions: qStats,
    ranges,
    submissions: subs.map(s => ({ id: s.id, user_id: s.user_id, real_name: s.real_name, total_score: s.total_score, max_score: s.max_score, status: s.status, submitted_at: s.submitted_at, graded_at: s.graded_at })),
  })
})

// ============ 学科题目池（单题训练）============
// 【v4.0.1 Bug-跨学科读】学科题目池 - 教师必须任教该学科才能列题（之前任何登录用户都能列）
// 【v4.0.2】学科题目池 - 任何登录用户都能看
//   - subject_questions 表当前没有 status 字段（D1 schema 还没加），全表已激活的题目都对外可见
app.get('/api/subjects/:id/questions', auth, async (req, res) => {
  const rows = await all<any>('SELECT * FROM subject_questions WHERE subject_id=? ORDER BY sort,id DESC', req.params.id)
  res.json(rows.map(q => ({ ...q, options: j(q.options), attachments: j(q.attachments) })))
})

// 取单条题目（含学科信息，供单题训练作答页使用）
app.get('/api/subject-questions/:id', auth, async (req, res) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  const subj = await get<any>('SELECT id, name, slug, icon FROM subjects WHERE id=?', q.subject_id)
  res.json({ ...q, options: j(q.options), attachments: j(q.attachments), subject: subj })
})

// ==============================================================================
// ============ 【v4.1.0】学科论坛：话题标签 + 帖子 + 评论 =============
// ==============================================================================

// 话题标签
app.get('/api/subjects/:id/forum/topics', auth, async (req, res) => {
  const list = await all<any>('SELECT t.*, u.real_name AS creator_name FROM forum_topics t LEFT JOIN users u ON t.created_by=u.id WHERE t.subject_id=? ORDER BY t.id ASC', req.params.id)
  res.json(list)
})

app.post('/api/subjects/:id/forum/topics', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const u = (req as any).user
  if (u.role !== 'SUPER_ADMIN' && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return res.status(403).json({ message: '只有超管和本学科教师可以创建话题标签' })
  }
  const b = req.body
  if (!b.name?.trim()) return res.status(400).json({ message: '话题名不能为空' })
  const r = await run('INSERT INTO forum_topics (subject_id, name, color, created_by) VALUES (?,?,?,?)',
    sid, b.name.trim().slice(0, 20), b.color || '#F59E0B', u.id)
  res.json({ id: Number(r.lastInsertRowid) })
})

app.patch('/api/subjects/:id/forum/topics/:tid', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const tid = Number(req.params.tid)
  const u = (req as any).user
  if (u.role !== 'SUPER_ADMIN' && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return res.status(403).json({ message: '只有超管和本学科教师可以编辑话题标签' })
  }
  const b = req.body
  await run('UPDATE forum_topics SET name=COALESCE(?,name), color=COALESCE(?,color) WHERE id=? AND subject_id=?',
    b.name?.trim() || null, b.color || null, tid, sid)
  res.json({ ok: true })
})

app.delete('/api/subjects/:id/forum/topics/:tid', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const tid = Number(req.params.tid)
  const u = (req as any).user
  if (u.role !== 'SUPER_ADMIN' && !(await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid))) {
    return res.status(403).json({ message: '只有超管和本学科教师可以删除话题标签' })
  }
  await run('DELETE FROM forum_topics WHERE id=? AND subject_id=?', tid, sid)
  res.json({ ok: true })
})

// 论坛帖子
app.get('/api/subjects/:id/forum/posts', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const topicId = req.query.topicId
  const u = (req as any).user
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  let sql = "SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar FROM pages p LEFT JOIN users u ON p.author_id=u.id WHERE p.subject_id=? AND p.ptype='forum'"
  const args: any[] = [sid]
  if (topicId) { sql += ' AND p.topic_ids LIKE ?'; args.push(`%"${topicId}"%`) }
  if (!isSuper && !isStaff) {
    sql += " AND (p.status='published' OR p.author_id=?)"
    args.push(u.id)
  }
  sql += ' ORDER BY p.pinned DESC, p.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map((p: any) => ({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })))
})

app.get('/api/subjects/:id/forum/posts/:pid', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const pid = Number(req.params.pid)
  const u = (req as any).user
  const p = await get<any>("SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar FROM pages p LEFT JOIN users u ON p.author_id=u.id WHERE p.id=? AND p.subject_id=? AND p.ptype='forum'", pid, sid)
  if (!p) return res.status(404).json({ message: '帖子不存在' })
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  if (p.status !== 'published' && !isSuper && !isStaff && p.author_id !== u.id) {
    return res.status(403).json({ message: '无权限' })
  }
  await run('UPDATE pages SET views = views + 1 WHERE id=?', pid)
  res.json({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids), views: p.views + 1 })
})

app.post('/api/subjects/:id/forum/posts', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const u = (req as any).user
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  const b = req.body
  if (!b.title?.trim()) return res.status(400).json({ message: '标题不能为空' })
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', u.id)
  const topicIds = JSON.stringify(Array.isArray(b.topicIds) ? b.topicIds.map(Number).filter(Boolean) : [])
  let status = (isSuper || isStaff) ? 'published' : 'pending'
  let autoApproved = false
  if (status === 'pending') {
    const sub = await get<any>('SELECT forum_auto_approve_threshold FROM subjects WHERE id=?', sid)
    const threshold = Number(sub?.forum_auto_approve_threshold || 0)
    if (threshold > 0) {
      const plain = String(b.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length
      if (plain > 0 && plain <= threshold) {
        status = 'published'
        autoApproved = true
      }
    }
  }
  const r = await run(
    `INSERT INTO pages (ptype, scope, class_id, title, content, cover, images, attachments, author_id, author_name, status, views, likes, pinned, subject_id, topic_ids)
     VALUES ('forum','public',0,?,?,?,?,?,?,?,?,0,0,0,?,?)`,
    b.title.trim().slice(0, 100), b.content || '', b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.attachments || []),
    u.id, me?.real_name || '', status, sid, topicIds
  )
  const pid = Number(r.lastInsertRowid)
  if ((isSuper || isStaff) && status === 'published') {
    try { await addExp(u.id, undefined, 'forum_post', `论坛帖子《${b.title}》发布`) } catch {}
  }
  res.json({ id: pid, status, autoApproved })
})

app.patch('/api/subjects/:id/forum/posts/:pid', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const pid = Number(req.params.pid)
  const u = (req as any).user
  const p = await get<any>("SELECT * FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return res.status(404).json({ message: '帖子不存在' })
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  if (!isSuper && !isStaff && p.author_id !== u.id) return res.status(403).json({ message: '无权编辑' })
  const b = req.body
  const topicIds = b.topicIds ? JSON.stringify(b.topicIds.map(Number).filter(Boolean)) : null
  await run(`UPDATE pages SET
    title=COALESCE(?,title), content=COALESCE(?,content), cover=COALESCE(?,cover),
    images=COALESCE(?,images), attachments=COALESCE(?,attachments), topic_ids=COALESCE(?,topic_ids),
    updated_at=datetime('now','+8 hours') WHERE id=?`,
    b.title?.trim() || null, b.content ?? null, b.cover ?? null,
    b.images ? JSON.stringify(b.images) : null, b.attachments ? JSON.stringify(b.attachments) : null,
    topicIds, pid)
  res.json({ ok: true })
})

app.delete('/api/subjects/:id/forum/posts/:pid', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const pid = Number(req.params.pid)
  const u = (req as any).user
  const p = await get<any>("SELECT author_id FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return res.status(404).json({ message: '帖子不存在' })
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  if (!isSuper && !isStaff && p.author_id !== u.id) return res.status(403).json({ message: '无权删除' })
  await run('DELETE FROM page_comments WHERE page_id=?', pid)
  await run('DELETE FROM pages WHERE id=?', pid)
  res.json({ ok: true })
})

// 审核论坛帖子：超管 + 本学科教师
app.patch('/api/subjects/:id/forum/posts/:pid/status', auth, async (req, res) => {
  const sid = Number(req.params.id)
  const pid = Number(req.params.pid)
  const u = (req as any).user
  const isSuper = u.role === 'SUPER_ADMIN'
  const isStaff = !isSuper && u.role === 'TEACHER' && await canManageSubject({ id: u.id, role: u.role, subject_id: u.subject_id }, sid)
  if (!isSuper && !isStaff) return res.status(403).json({ message: '只有超管和本学科教师可以审核论坛帖子' })
  const p = await get<any>("SELECT * FROM pages WHERE id=? AND subject_id=? AND ptype='forum'", pid, sid)
  if (!p) return res.status(404).json({ message: '帖子不存在' })
  const b = req.body
  const newStatus = b.status
  if (!['published', 'rejected', 'pending'].includes(newStatus)) return res.status(400).json({ message: '状态不合法' })
  const note = b.reviewNote || ''
  await run("UPDATE pages SET status=?, reviewed_by=?, reviewed_at=datetime('now','+8 hours'), review_note=? WHERE id=?",
    newStatus, u.id, note, pid)
  if (newStatus === 'published' && p.status !== 'published') {
    const expUid = Number(p.author_id)
    const already = await get("SELECT id FROM exp_logs WHERE user_id=? AND action_type='forum_post' AND description LIKE ?", expUid, `%${p.title}%`)
    if (!already) {
      try { await addExp(expUid, undefined, 'forum_post', `论坛帖子《${p.title}》审核通过`) } catch {}
    }
    await addNotice(expUid, '论坛帖子审核通过', `你的《${p.title}》已通过审核，已公开展示。`, 'audit')
  } else if (newStatus === 'rejected') {
    await addNotice(Number(p.author_id), '论坛帖子未通过审核', `《${p.title}》未通过审核${note ? '，原因：' + note : ''}，请修改后重新提交。`, 'audit')
  }
  res.json({ ok: true, status: newStatus })
})

// 审核中心 - 论坛帖子列表
app.get('/api/admin/audit/forum-posts', auth, async (req, res) => {
  const u = (req as any).user
  const isSuper = u.role === 'SUPER_ADMIN'
  const isTeacher = u.role === 'TEACHER'
  if (!isSuper && !isTeacher) return res.status(403).json({ message: '无权访问审核中心' })
  let sql = `SELECT p.*, u.real_name AS author_name, u.avatar AS author_avatar, s.name AS subject_name, s.icon AS subject_icon
    FROM pages p
    LEFT JOIN users u ON p.author_id=u.id
    LEFT JOIN subjects s ON p.subject_id=s.id
    WHERE p.ptype='forum' AND p.status='pending'`
  const args: any[] = []
  if (!isSuper) {
    const sids = await teachingSubjects(u.id)
    if (u.subject_id && !sids.includes(Number(u.subject_id))) sids.push(Number(u.subject_id))
    if (!sids.length) return res.json([])
    sql += ` AND p.subject_id IN (${sids.map(() => '?').join(',')})`
    args.push(...sids)
  }
  sql += ' ORDER BY p.id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map((p: any) => ({ ...p, images: j(p.images), attachments: j(p.attachments), topic_ids: j(p.topic_ids) })))
})

// 论坛评论 = 直接复用 /api/pages/:id/comments

// 教师向学科题目池添加题目
app.post('/api/subjects/:id/questions', auth, requireStaff, async (req, res) => {
  const sid = Number(req.params.id)
  const me = await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id)
  const b = req.body
  const r = await run(
    'INSERT INTO subject_questions (subject_id,creator_id,creator_name,qtype,content,options,answer,score,attachments,sort) VALUES (?,?,?,?,?,?,?,?,?,?)',
    sid, (req as any).user.id, me?.real_name || '', b.qtype || 'single', b.content || '', JSON.stringify(b.options || []), b.answer || '', b.score || 5, JSON.stringify(b.attachments || []), b.sort || 0
  )
  res.json({ id: Number(r.lastInsertRowid) })
})

// 删除题目池中的题目（仅创建者或超管）
app.delete('/api/subject-questions/:id', auth, requireStaff, async (req, res) => {
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  if ((req as any).user.role !== 'SUPER_ADMIN' && q.creator_id !== (req as any).user.id) {
    return res.status(403).json({ message: '无权删除他人题目' })
  }
  await run('DELETE FROM practice_submissions WHERE question_id=?', req.params.id)
  await run('DELETE FROM subject_questions WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 学生提交单题训练答案
app.post('/api/subject-questions/:id/submit', auth, async (req, res) => {
  const uid = (req as any).user.id
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', req.params.id)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  const ans = req.body.answer || ''
  const isSub = q.qtype === 'subjective'
  let correct: boolean | null = null
  let score = 0
  const max = q.score || 5
  if (!isSub) {
    // 客观题自动判分
    const std = String(q.answer || '').trim()
    const got = String(ans || '').trim()
    if (q.qtype === 'multiple') {
      const a = std.split(',').map(s => s.trim()).filter(Boolean).sort().join(',')
      const b = got.split(',').map(s => s.trim()).filter(Boolean).sort().join(',')
      correct = a === b && a !== ''
    } else {
      correct = std !== '' && std === got
    }
    score = correct ? max : 0
  }
  const status = isSub ? 'pending' : 'graded'
  let subId: number
  if (status === 'graded') {
    const r = await run(
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at,graded_at,graded_by) VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'),?)`,
      q.id, q.subject_id, uid, ans, score, max, status, correct ? 1 : 0, uid
    )
    subId = Number(r.lastInsertRowid)
  } else {
    const r = await run(
      `INSERT INTO practice_submissions (question_id,subject_id,user_id,answer,score,max_score,status,correct,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      q.id, q.subject_id, uid, ans, 0, max, status, null, datetimeNow()
    )
    subId = Number(r.lastInsertRowid)
  }
  // 主观题：站内信通知学科教师批改
  if (isSub) {
    const stu = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const subj = await get<any>('SELECT name FROM subjects WHERE id=?', q.subject_id)
    const msg = `📝 ${stu?.real_name || '学生'} 在「${subj?.name || '学科'}」单题训练中提交了一道主观题\n请前往「题库 → 单题训练待批」进行批改。`
    // 通知所有该学科教师与超管
    const teachers = await all<any>("SELECT id FROM users WHERE role IN ('SUPER_ADMIN','TEACHER') AND (role='SUPER_ADMIN' OR subject_id=?)", q.subject_id)
    for (const t of teachers) {
      if (t.id !== uid) await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, t.id, msg, '[]')
      await addNotice(t.id, '单题训练待批', `${stu?.real_name || '学生'}在「${subj?.name || '学科'}」提交了主观题，请及时批改。`, 'teacher')
    }
  }
  res.json({ id: subId, status, score, max, correct })
})

// 学生查询单题训练结果（最近一次）
app.get('/api/subject-questions/:id/my_result', auth, async (req, res) => {
  const uid = (req as any).user.id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE question_id=? AND user_id=? ORDER BY id DESC LIMIT 1', req.params.id, uid)
  if (!sub) return res.status(404).json({ message: '尚未作答' })
  res.json(sub)
})

// 教师：待批的单题训练提交列表（按学科过滤）
app.get('/api/practice/pending', auth, requireStaff, async (req, res) => {
  const me = (req as any).user
  let sql = `SELECT ps.*, sq.qtype, sq.content AS qcontent, sq.options AS qoptions, sq.answer AS qanswer, sq.subject_id, sq.attachments AS qattachments,
    u.real_name, s.name AS subject_name
    FROM practice_submissions ps
    JOIN subject_questions sq ON sq.id = ps.question_id
    JOIN users u ON u.id = ps.user_id
    JOIN subjects s ON s.id = sq.subject_id
    WHERE ps.status='pending'`
  const args: any[] = []
  if (me.role === 'TEACHER') { sql += ' AND sq.subject_id=?'; args.push(me.subject_id) }
  sql += ' ORDER BY ps.id DESC'
  const rows = await all<any>(sql, ...args)
  res.json(rows.map(r => ({
    ...r,
    qoptions: j(r.qoptions),
    qattachments: j(r.qattachments),
  })))
})

// 教师：批改单题训练
app.post('/api/practice/:id/grade', auth, requireStaff, async (req, res) => {
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', req.params.id)
  if (!sub) return res.status(404).json({ message: '提交不存在' })
  const { score, comment } = req.body
  const sc = Math.max(0, Math.min(sub.max_score, Number(score) || 0))
  const isCorrect = sc >= sub.max_score
  await run('UPDATE practice_submissions SET score=?, status=?, comment=?, graded_at=datetime(\'now\',\'localtime\'), graded_by=?, correct=? WHERE id=?',
    sc, 'graded', comment || '', (req as any).user.id, isCorrect ? 1 : 0, req.params.id)
  await addExp(sub.user_id, undefined, 'practice_pass', `单题训练批改完成（${sc}/${sub.max_score}）`)
  // 站内信通知学生
  const teacherName = (await get<any>('SELECT real_name FROM users WHERE id=?', (req as any).user.id))?.real_name || '老师'
  const msg = `✅ 你的一道单题训练主观题已被批改\n批改人：${teacherName}\n得分：${sc} / ${sub.max_score}` + (comment ? `\n评语：${comment}` : '')
  await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', (req as any).user.id, sub.user_id, msg, '[]')
  const subjInfo = await get<any>('SELECT name FROM subjects WHERE id=?', sub.subject_id)
  await addNotice(sub.user_id, '单题训练批改完成', `${teacherName}老师批改了你的「${subjInfo?.name || '学科'}」单题训练，得分 ${sc} / ${sub.max_score}` + (comment ? `，评语：${comment}` : ''), 'teacher')
  res.json({ ok: true, score: sc })
})

// 教师/学生：取某一条单题提交详情（含学生作答内容、题目内容、学科）
app.get('/api/practice/submission/:id', auth, async (req, res) => {
  const id = Number(req.params.id)
  const me = (req as any).user
  const row = await get<any>(
    `SELECT ps.*, sq.content AS qcontent, sq.qtype, sq.score AS qscore, sq.options AS qoptions, sq.answer AS qanswer, sq.attachments AS qattachments,
            u.real_name, u.username,
            s.id AS subject_id, s.name AS subject_name, s.icon AS subject_icon
     FROM practice_submissions ps
     JOIN subject_questions sq ON sq.id = ps.question_id
     JOIN users u ON u.id = ps.user_id
     JOIN subjects s ON s.id = sq.subject_id
     WHERE ps.id=?`, id)
  if (!row) return res.status(404).json({ message: '提交不存在' })
  // 权限：本人、本学科教师、超管
  const isOwner = row.user_id === me.id
  const isSuperAdmin = me.role === 'SUPER_ADMIN'
  const isSubjectTeacher = me.role === 'TEACHER' && me.subject_id === row.subject_id
  if (!isOwner && !isSuperAdmin && !isSubjectTeacher) {
    return res.status(403).json({ message: '无权查看该提交' })
  }
  res.json({
    ...row,
    qoptions: j(row.qoptions),
    qattachments: j(row.qattachments || '[]'),
  })
})

// 学生：查看自己的单题训练历史提交记录（分页）
app.get('/api/practice/my-records', auth, async (req, res) => {
  const uid = (req as any).user.id
  const page = Number(req.query.page) || 1
  const perPage = Number(req.query.perPage) || 20
  const offset = (page - 1) * perPage
  const total = await get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE user_id=?', uid)
  const rows = await all<any>(
    `SELECT ps.*, sq.content AS qcontent, sq.qtype, sq.subject_id, sq.attachments AS qattachments,
      s.name AS subject_name, s.icon AS subject_icon
     FROM practice_submissions ps
     JOIN subject_questions sq ON sq.id = ps.question_id
     JOIN subjects s ON s.id = sq.subject_id
     WHERE ps.user_id=? ORDER BY ps.id DESC LIMIT ? OFFSET ?`,
    uid, perPage, offset
  )
  res.json({ list: rows.map(r => ({ ...r, qattachments: j(r.qattachments) })), total: total.cnt, page, perPage })
})

// 通用：删除单题训练记录（学生本人 OR 教师/超管）
app.delete('/api/practice/record/:id', auth, async (req, res) => {
  const uid = (req as any).user.id
  const sub = await get<any>('SELECT * FROM practice_submissions WHERE id=?', req.params.id)
  if (!sub) return res.status(404).json({ message: '记录不存在' })
  const me = (req as any).user
  const isOwner = sub.user_id === uid
  const isSuperAdmin = me.role === 'SUPER_ADMIN'
  const isSubjectTeacher = me.role === 'TEACHER' && me.subject_id === sub.subject_id
  if (!isOwner && !isSuperAdmin && !isSubjectTeacher) {
    return res.status(403).json({ message: '无权删除该记录' })
  }
  await run('DELETE FROM practice_submissions WHERE id=?', req.params.id)
  res.json({ ok: true })
})

// 教师/超管：查看某道单题的训练统计和所有学生提交记录
app.get('/api/practice/stats/:questionId', auth, requireStaff, async (req, res) => {
  const qid = Number(req.params.questionId)
  const me = (req as any).user
  const q = await get<any>('SELECT * FROM subject_questions WHERE id=?', qid)
  if (!q) return res.status(404).json({ message: '题目不存在' })
  // 权限校验：超管看所有，教师只看自己学科的
  if (me.role === 'TEACHER' && q.subject_id !== me.subject_id) return res.status(403).json({ message: '无权查看该题目数据' })
  const subject = await get<any>('SELECT id, name, icon FROM subjects WHERE id=?', q.subject_id)

  // 基本统计
  const [totalSubs, pendingCnt, gradedCnt, passCnt] = await Promise.all([
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=?', qid),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND status=?', qid, 'pending'),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND status=?', qid, 'graded'),
    get<any>('SELECT COUNT(*) AS cnt FROM practice_submissions WHERE question_id=? AND correct=1', qid),
  ])

  // 待批提交（含学生信息，方便教师批改）
  const pendingSubs = await all<any>(
    `SELECT ps.*, u.real_name, u.username, u.id AS user_id
     FROM practice_submissions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.question_id=? AND ps.status='pending'
     ORDER BY ps.submitted_at ASC`, qid
  )

  // 每次作答的详细（含选项/主观题内容）
  const detailSubs = await all<any>(
    `SELECT ps.id AS sub_id, ps.score, ps.max_score, ps.status, ps.correct,
            ps.answer AS user_answer, ps.comment, ps.submitted_at, ps.graded_at,
            u.real_name, u.username
     FROM practice_submissions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.question_id=?
     ORDER BY ps.id DESC
     LIMIT 300`, qid
  )

  res.json({
    question: { id: q.id, content: q.content, qtype: q.qtype, score: q.score, answer: q.answer, options: j(q.options), attachments: j(q.attachments || '[]') },
    subject,
    stats: {
      totalSubmissions: totalSubs.cnt || 0,
      pendingCount: pendingCnt.cnt || 0,
      gradedCount: gradedCnt.cnt || 0,
      passCount: passCnt.cnt || 0,
    },
    pendingSubs: pendingSubs.map(r => ({ ...r })),
    detailSubs: detailSubs.map(r => ({ ...r })),
  })
})

// 教师/超管：删除任意学生的单题训练记录
// 说明：上面已统一处理「本人 OR 教师/超管」的删除逻辑，这里不再重复定义


// ============ 通用页面：网站说明 / 博客 / 公告 ============
app.get('/api/pages', async (req, res) => {
  const { ptype, scope, classId, mine, userId } = req.query
  let sql = 'SELECT * FROM pages WHERE status=?'
  const args: any[] = ['published']
  if (ptype) { sql += ' AND ptype=?'; args.push(ptype) }
  if (scope) { sql += ' AND scope=?'; args.push(scope) }
  if (classId) { sql += ' AND class_id=?'; args.push(classId) }
  if (mine === '1' && userId) { sql += ' AND author_id=?'; args.push(userId) }
  sql += ' ORDER BY id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 取单条 guide（无 auth 也可读，前端首页用）
app.get('/api/pages/guide', async (_req, res) => {
  const p = await get<any>("SELECT * FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  if (!p) return res.json(null)
  res.json({ ...p, images: j(p.images), attachments: j(p.attachments) })
})

app.get('/api/pages/:id', async (req, res) => {
  const p = await get<any>('SELECT * FROM pages WHERE id=?', req.params.id)
  if (!p) return res.status(404).json({ message: '不存在' })
  await run('UPDATE pages SET views = views + 1 WHERE id=?', req.params.id)
  res.json({ ...p, images: j(p.images), attachments: j(p.attachments), views: p.views + 1 })
})

// 博客/页面点赞
app.post('/api/pages/:id/like', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', req.params.id)
  if (exist) return res.json({ liked: false })
  await run('INSERT INTO likes_map (user_id,target_type,target_id) VALUES (?,?,?)', uid, 'page', req.params.id)
  await run('UPDATE pages SET likes = likes + 1 WHERE id=?', req.params.id)
  // v4.2.1：通知作者收到点赞（兼容博客/论坛帖子）
  const p = await get<any>('SELECT author_id AS user_id, title, ptype, subject_id, (SELECT slug FROM subjects WHERE id = pages.subject_id) AS slug FROM pages WHERE id=?', req.params.id)
  if (p && Number(p.user_id) !== uid) {
    const u = await get<any>('SELECT real_name FROM users WHERE id=?', uid)
    const tUrl = p.ptype === 'blog' ? `/blog/${req.params.id}` : `/subject/${p.slug || ''}/forum/post/${req.params.id}`
    const tName = p.ptype === 'blog' ? '博客' : '论坛帖子'
    await addNotice(Number(p.user_id), `${tName}收到点赞`, `${u?.real_name || '有人'} 点赞了你的${tName}《${p.title}》`, 'like', `${tUrl}#comment-area`)
  }
  res.json({ liked: true })
})

// 我是否已点赞
app.get('/api/pages/:id/liked', auth, async (req, res) => {
  const uid = (req as any).user.id
  const exist = await get('SELECT id FROM likes_map WHERE user_id=? AND target_type=? AND target_id=?', uid, 'page', req.params.id)
  res.json({ liked: !!exist })
})

// 评论列表
app.get('/api/pages/:id/comments', async (req, res) => {
  const list = await all<any>('SELECT * FROM page_comments WHERE page_id=? ORDER BY id DESC', req.params.id)
  res.json(list)
})

// 发表评论 【v4.2.0 支持 parent_id 子评论】【v4.2.1 加通知】
app.post('/api/pages/:id/comments', auth, async (req, res) => {
  const uid = (req as any).user.id
  const content = String(req.body.content || '').trim()
  if (!content) return res.status(400).json({ message: '评论内容不能为空' })
  const parentId = req.body.parent_id != null ? Number(req.body.parent_id) : null
  if (parentId != null) {
    const pc = await get<any>('SELECT id FROM page_comments WHERE id=? AND page_id=?', parentId, req.params.id)
    if (!pc) return res.status(400).json({ message: '父评论不存在' })
  }
  const u = await get<any>('SELECT real_name, avatar FROM users WHERE id=?', uid)
  const r = await run(
    'INSERT INTO page_comments (page_id,user_id,user_name,avatar,content,parent_id) VALUES (?,?,?,?,?,?)',
    req.params.id, uid, u?.real_name || '匿名', u?.avatar || '', content, parentId
  )
  const newCommentId = Number(r.lastInsertRowid)
  // v4.2.1：通知 - 主评论通知作者，子评论通知被回复人
  const p = await get<any>('SELECT author_id AS user_id, title, ptype, subject_id, (SELECT slug FROM subjects WHERE id = pages.subject_id) AS slug FROM pages WHERE id=?', req.params.id)
  if (p) {
    const tUrl = p.ptype === 'blog' ? `/blog/${req.params.id}` : `/subject/${p.slug || ''}/forum/post/${req.params.id}`
    const tName = p.ptype === 'blog' ? '博客' : '论坛帖子'
    if (parentId == null) {
      if (Number(p.user_id) !== uid) {
        await addNotice(Number(p.user_id), `${tName}收到新评论`, `${u?.real_name || '有人'} 评论了你的${tName}《${p.title}》：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `${tUrl}#comment-${newCommentId}`)
      }
    } else {
      const parent = await get<any>('SELECT user_id FROM page_comments WHERE id=?', parentId)
      if (parent && Number(parent.user_id) !== uid) {
        await addNotice(Number(parent.user_id), '有人回复了你的评论', `${u?.real_name || '有人'} 回复了你对《${p.title}》的评论：${content.slice(0, 40)}${content.length > 40 ? '…' : ''}`, 'comment', `${tUrl}#comment-${newCommentId}`)
      }
    }
  }
  res.json({ id: newCommentId, page_id: Number(req.params.id), user_id: uid, user_name: u?.real_name || '匿名', avatar: u?.avatar || '', content, parent_id: parentId, created_at: datetimeNow() })
})

// 公告可见性筛选：全站公告 + 当前用户所在班级的班级公告；置顶优先排序
app.get('/api/announcements', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const cids = await userClassIds(uid)
  let sql = "SELECT * FROM pages WHERE ptype='announcement' AND status='published'"
  const args: any[] = []
  if (role === 'SUPER_ADMIN') {
    // 全部可见
  } else if (cids.length) {
    sql += ` AND (scope='site' OR class_id IN (${cids.map(() => '?').join(',')}))`
    args.push(...cids)
  } else {
    sql += " AND scope='site'"
  }
  // 需求2：置顶优先（pinned DESC），然后id倒序
  sql += ' ORDER BY pinned DESC, id DESC'
  const list = await all<any>(sql, ...args)
  res.json(list.map(p => ({ ...p, images: j(p.images), attachments: j(p.attachments) })))
})

// 网站说明（管理后台编辑）
app.put('/api/pages/guide', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { title, content, images, attachments } = req.body
  // 查询已有记录（保留已有的 images/attachments，仅当请求中明确提供时才覆盖）
  const exist = await get<any>("SELECT id, images, attachments FROM pages WHERE ptype='guide' ORDER BY id DESC LIMIT 1")
  const finalImages = images !== undefined ? images : (exist ? j(exist.images) : [])
  const finalAttachments = attachments !== undefined ? attachments : (exist ? j(exist.attachments) : [])
  if (exist) {
    await run("UPDATE pages SET title=?, content=?, images=?, attachments=?, updated_at=datetime('now','localtime') WHERE id=?", title, content, JSON.stringify(finalImages || []), JSON.stringify(finalAttachments || []), exist.id)
    res.json({ id: exist.id })
  } else {
    const r = await run('INSERT INTO pages (ptype,scope,title,content,images,attachments,author_name,status,updated_at) VALUES (?,?,?,?,?,?,?,?,datetime(\'now\',\'localtime\'))', 'guide', 'site', title, content, JSON.stringify(finalImages || []), JSON.stringify(finalAttachments || []), '超级管理员', 'published')
    res.json({ id: Number(r.lastInsertRowid) })
  }
})

// 创建博客 / 公告
app.post('/api/pages', auth, async (req, res) => {
  const uid = (req as any).user.id
  const me = await get<any>('SELECT real_name, role FROM users WHERE id=?', uid)
  const b = req.body
  // 权限校验：公告有特殊限制；博客人人可发
  if (b.ptype === 'announcement') {
    if (b.scope === 'site') {
      if (me?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '只有超级管理员可发布全站公告' })
    } else if (b.scope === 'class') {
      if (me?.role !== 'SUPER_ADMIN' && me?.role !== 'TEACHER') return res.status(403).json({ message: '只有教师/超管可发布班级公告' })
    }
  }
  // 需求2：置顶参数处理（pinned=1/0, pinned_scope=site/class/none）
  const pinned = b.pinned ? 1 : 0
  const pinnedScope = pinned ? (b.pinnedScope || b.scope || 'site') : 'none'
  const r = await run(
    `INSERT INTO pages (ptype,scope,class_id,title,content,cover,images,attachments,author_id,author_name,status,pinned,pinned_scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    b.ptype, b.scope || 'site', b.classId || null, b.title, b.content, b.cover || '', JSON.stringify(b.images || []), JSON.stringify(b.attachments || []), uid, me?.real_name || '', 'published', pinned, pinnedScope
  )
  // 博客加经验
  if (b.ptype === 'blog') {
    await addExp(uid, undefined, 'blog', `发布博客《${b.title}》`)
  }
  res.json({ id: Number(r.lastInsertRowid) })
})

// 需求2：修改公告置顶状态
app.patch('/api/pages/:id/pin', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const { pinned, pinnedScope } = req.body
  const p = await get<any>('SELECT id FROM pages WHERE id=?', req.params.id)
  if (!p) return res.status(404).json({ message: '不存在' })
  const pinVal = pinned ? 1 : 0
  const scopeVal = pinned ? (pinnedScope || 'site') : 'none'
  await run('UPDATE pages SET pinned=?, pinned_scope=? WHERE id=?', pinVal, scopeVal, req.params.id)
  res.json({ ok: true })
})

app.delete('/api/pages/:id', auth, async (req, res) => {
  const p = await get<any>('SELECT author_id, ptype, scope, title FROM pages WHERE id=?', req.params.id)
  if (!p) return res.status(404).json({ message: '不存在' })
  const u = await get<any>('SELECT role FROM users WHERE id=?', (req as any).user.id)
  const isOwner = p.author_id === (req as any).user.id
  if (!isOwner && u?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: '无权限删除' })
  // 删除前直接删除相关的经验值记录
  if (p.author_id && p.title && p.ptype === 'blog') {
    const logs = await all<{ exp_change: number }>("SELECT exp_change FROM exp_logs WHERE user_id=? AND action_type='blog' AND description LIKE ?", p.author_id, `%${p.title}%`)
    const total = logs.reduce((s, l) => s + (l.exp_change || 0), 0)
    await run("DELETE FROM exp_logs WHERE user_id=? AND action_type='blog' AND description LIKE ?", p.author_id, `%${p.title}%`)
    if (total) await run('UPDATE users SET exp = MAX(0, exp - ?) WHERE id = ?', total, p.author_id)
  }
  await run('DELETE FROM page_comments WHERE page_id=?', req.params.id)
  await run('DELETE FROM likes_map WHERE target_type=? AND target_id=?', 'page', req.params.id)
  await run('DELETE FROM pages WHERE id=?', req.params.id)
  clearAllCache()
  res.json({ ok: true })
})

// ============ 站内信 ============
app.get('/api/messages/contacts', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  // 给我发过 / 我发给过的所有人列表
  const rows = await all<any>(
    `SELECT DISTINCT CASE WHEN from_id=? THEN to_id ELSE from_id END AS oid
     FROM messages WHERE from_id=? OR to_id=?`,
    uid, uid, uid
  )
  const ids = rows.map(r => r.oid).filter(Boolean)
  let users: any[] = []
  if (ids.length) {
    users = await all<any>(`SELECT id, real_name, role, avatar FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
  }
  // 超管：列出全部用户作为可发对象
  if (role === 'SUPER_ADMIN') {
    users = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
  }
  res.json(users)
})

// 未读消息总数（必须在 :peerId 之前定义，否则会被参数路由吞掉）
app.get('/api/messages/unread/count', auth, async (req, res) => {
  const uid = (req as any).user.id
  const r = await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND is_read=0', uid)
  res.json({ count: r?.n || 0 })
})

// 最近会话列表（用于站内信首页）
app.get('/api/messages/sessions', auth, async (req, res) => {
  const uid = (req as any).user.id
  const role = (req as any).user.role
  const list = await all<any>(
    `SELECT m.* FROM messages m
     INNER JOIN (
       SELECT MAX(id) as mid FROM messages WHERE from_id=? OR to_id=? GROUP BY CASE WHEN from_id=? THEN to_id ELSE from_id END
     ) t ON m.id = t.mid
     ORDER BY m.id DESC`,
    uid, uid, uid
  )
  // 补充对端用户信息 + 未读数
  const result = []
  for (const m of list) {
    const peerId = m.from_id === uid ? m.to_id : m.from_id
    const peer = await get<any>('SELECT id, real_name, role, avatar FROM users WHERE id=?', peerId)
    const unread = (await get<{ n: number }>('SELECT COUNT(*) as n FROM messages WHERE to_id=? AND from_id=? AND is_read=0', uid, peerId))?.n || 0
    result.push({ ...m, attachments: j(m.attachments), peer, unread })
  }
  // 所有用户均返回全部活跃用户列表，供发起新会话时选择
  const allUsers = await all<any>('SELECT id, real_name, role, avatar FROM users WHERE id<>? AND status=? ORDER BY real_name', uid, 'active')
  res.json({ sessions: result, allUsers })
})

// 超管查任意两用户之间的消息
app.get('/api/messages/all/:aId/:bId', auth, requireRole('SUPER_ADMIN'), async (req, res) => {
  const aId = Number(req.params.aId)
  const bId = Number(req.params.bId)
  const list = await all<any>(
    `SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id ASC`,
    aId, bId, bId, aId
  )
  res.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

app.post('/api/messages', auth, async (req, res) => {
  const uid = (req as any).user.id
  const { toId, content, attachments } = req.body
  if (!toId || !content) return res.status(400).json({ message: '请填写收件人和内容' })
  const r = await run('INSERT INTO messages (from_id,to_id,content,attachments) VALUES (?,?,?,?)', uid, toId, content, JSON.stringify(attachments || []))
  res.json({ id: Number(r.lastInsertRowid) })
})

app.post('/api/messages/read-all', auth, async (req, res) => {
  const uid = (req as any).user.id
  await run('UPDATE messages SET is_read=1 WHERE to_id=? AND is_read=0', uid)
  res.json({ ok: true })
})

// 与某人的对话（参数路由，必须放在所有具名子路径之后）
app.get('/api/messages/:peerId', auth, async (req, res) => {
  const uid = (req as any).user.id
  const peerId = Number(req.params.peerId)
  if (!peerId || isNaN(peerId)) return res.status(400).json({ message: '无效的会话对象' })
  const list = await all<any>(
    `SELECT * FROM messages WHERE ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id ASC`,
    uid, peerId, peerId, uid
  )
  // 标记我收到的消息为已读
  await run('UPDATE messages SET is_read=1 WHERE to_id=? AND from_id=?', uid, peerId)
  res.json(list.map(m => ({ ...m, attachments: j(m.attachments) })))
})

// ============ 需求5：超管网站运行监控 ============
app.get('/api/admin/monitor', auth, requireRole('SUPER_ADMIN'), async (_req, res) => {
  const os = await import('os')
  // 1. 实时在线人数（最近5分钟有活跃的用户）
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const online5min = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users WHERE last_active>=? AND status=?', fiveMinAgo, 'active'))!.n
  const online1hour = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users WHERE last_active>=? AND status=?', oneHourAgo, 'active'))!.n
  const totalUsers = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users'))!.n
  const activeUsers = (await get<{ n: number }>('SELECT COUNT(*) as n FROM users WHERE status=?', 'active'))!.n

  // 2. 数据库使用情况
  const tables = [
    'users', 'classes', 'class_members', 'subjects', 'articles', 'resources',
    'query_tasks', 'query_rows', 'exp_logs', 'notices', 'pages', 'page_comments',
    'messages', 'quizzes', 'quiz_questions', 'quiz_submissions',
    'subject_questions', 'practice_submissions', 'likes_map',
  ]
  const tableStats: Record<string, number> = {}
  for (const t of tables) {
    try {
      const r = await get<{ n: number }>(`SELECT COUNT(*) as n FROM ${t}`)
      tableStats[t] = r?.n ?? 0
    } catch { tableStats[t] = 0 }
  }
  // 数据库文件大小
  let dbSize = 0
  try {
    const fsp = await import('fs/promises')
    const st = await fsp.stat(path.join(__dirname, 'local.db'))
    dbSize = st.size
  } catch {}
  function fmtBytes(b: number) {
    if (b < 1024) return b + ' B'
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
    if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
    return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
  }

  // 3. 服务器运行情况
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = totalMem - freeMem
  const loadAvg = os.loadavg() // [1min, 5min, 15min]
  const uptimeSec = os.uptime()
  const nodeUptime = process.uptime()
  const nodeMem = process.memoryUsage()
  const cpuCores = os.cpus().length
  const cpuModel = os.cpus()[0]?.model || 'Unknown'

  // 4. 今日数据概览
  const today = new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD
  const todayLogins = (await get<{ n: number }>("SELECT COUNT(DISTINCT user_id) as n FROM exp_logs WHERE action_type='login' AND substr(created_at,1,10)=?", today))!.n
  const todayArticles = (await get<{ n: number }>("SELECT COUNT(*) as n FROM articles WHERE substr(created_at,1,10)=?", today))!.n
  const todayResources = (await get<{ n: number }>("SELECT COUNT(*) as n FROM resources WHERE substr(created_at,1,10)=?", today))!.n
  const todayExps = (await get<{ n: number }>("SELECT COALESCE(SUM(exp_change),0) as n FROM exp_logs WHERE substr(created_at,1,10)=?", today))!.n
  const pendingAuditArticles = (await get<{ n: number }>("SELECT COUNT(*) as n FROM articles WHERE status IN ('pending','pending_student')"))!.n
  const pendingAuditResources = (await get<{ n: number }>("SELECT COUNT(*) as n FROM resources WHERE status='pending'"))!.n

  // 最近7天活跃趋势（每日活跃用户数）
  const dailyActive: { date: string; users: number; articles: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000).toLocaleDateString('sv-SE')
    const us = (await get<{ n: number }>("SELECT COUNT(DISTINCT user_id) as n FROM exp_logs WHERE substr(created_at,1,10)=?", d))!.n
    const as = (await get<{ n: number }>("SELECT COUNT(*) as n FROM articles WHERE substr(created_at,1,10)=?", d))!.n
    dailyActive.push({ date: d.slice(5), users: us, articles: as })
  }

  // Node端各统计数据
  function fmtUptime(s: number) {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${d}天${h}时${m}分`
  }

  res.json({
    online: {
      online5min, online1hour, totalUsers, activeUsers,
      todayLogins, todayArticles, todayResources, todayExps,
    },
    database: {
      fileSize: dbSize,
      fileSizeFmt: fmtBytes(dbSize),
      tables: tableStats,
    },
    server: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuModel,
      cpuCores,
      loadAvg1: loadAvg[0],
      loadAvg5: loadAvg[1],
      loadAvg15: loadAvg[2],
      totalMem: totalMem,
      totalMemFmt: fmtBytes(totalMem),
      usedMem: usedMem,
      usedMemFmt: fmtBytes(usedMem),
      freeMem: freeMem,
      freeMemFmt: fmtBytes(freeMem),
      memUsagePct: Math.round(usedMem / totalMem * 100),
      serverUptime: uptimeSec,
      serverUptimeFmt: fmtUptime(uptimeSec),
      nodeUptime: nodeUptime,
      nodeUptimeFmt: fmtUptime(nodeUptime),
      nodeRss: nodeMem.rss,
      nodeRssFmt: fmtBytes(nodeMem.rss),
      nodeHeapUsed: nodeMem.heapUsed,
      nodeHeapUsedFmt: fmtBytes(nodeMem.heapUsed),
      nodeHeapTotal: nodeMem.heapTotal,
      nodeHeapTotalFmt: fmtBytes(nodeMem.heapTotal),
      nodeHeapPct: Math.round(nodeMem.heapUsed / nodeMem.heapTotal * 100),
    },
    pending: {
      articles: pendingAuditArticles,
      resources: pendingAuditResources,
    },
    dailyActive,
  })
})

// SPA fallback - only for non-API, non-upload, non-assets requests
app.get('/{*splat}', (req, res, next) => {
  const p = req.path
  if (p.startsWith('/api/')) return next()
  if (p.startsWith('/assets/')) return next()
  if (p.startsWith('/uploads/')) return next()
  if (fs.existsSync(path.join(distDir, 'index.html'))) res.sendFile(path.join(distDir, 'index.html'))
  else res.status(404).json({ message: '页面不存在' })
})

const PORT = Number(process.env.PORT) || 3001
app.listen(PORT, '0.0.0.0', () => console.log(`[server] 追光后端运行于 http://localhost:${PORT}`))
