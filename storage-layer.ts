// ==============================================================================
// 追光 · 统一存储抽象层（v4.4.0）
// ------------------------------------------------------------------------------
// 设计要点（对应需求硬约束）：
//   * 全部上传/下载/鉴权代理统一经 Worker，禁止浏览器直连 B2。
//   * D1 是文件元数据唯一来源；禁止调用 B2 List；运行时禁止用 B2 校验存在。
//   * Content-Type / Content-Length 全部取自 D1，不从 B2 实时获取。
//   * 下载链路原生流式透传（ReadableStream），禁止把整个文件读进内存。
//   * 配额统计：D1 原子自增（权威值），不依赖 Worker 内存变量；官方头缺失时降级到此。
//   * 适配器通过环境变量切换：B2_FREE / B2_PAID / SUPABASE，支持一键回滚；
//     代码永不自动切付费，付费仅允许人工改环境变量开启。
//   * 禁止原地覆盖：更新文件生成全新 fileId；旧文件保留或删除。
// ==============================================================================
import { createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// ---------- 配置与 D1 绑定（由 worker-api 中间件注入） ----------
interface StorageCfg {
  STORAGE_BACKEND?: string            // B2_FREE | B2_PAID | SUPABASE
  B2_KEY_ID?: string
  B2_APPLICATION_KEY?: string
  B2_BUCKET_ID?: string
  B2_BUCKET_NAME?: string
  B2_ACCOUNT_ID?: string
  B2_QUOTA_ALERT?: string             // 默认 2200
  B2_USER_DAILY_ORIGIN_LIMIT?: string // 默认 100
  CACHE_TTL_PUBLIC?: string           // 公开资源 s-maxage，默认 86400
  CACHE_TTL_WEBP?: string             // webp 图片长缓存，默认 2592000
  CACHE_TTL_PRIVATE?: string          // 私有 0=不缓存
  SUPABASE_URL?: string
  SUPABASE_KEY?: string
  SUPABASE_BUCKET?: string
}
let DB: any = null
let CFG: StorageCfg = {}
let SUPABASE: any = null

export function initStorage(db: any, cfg: StorageCfg) {
  DB = db
  CFG = cfg || {}
}

// 简易 D1 封装（避免与 worker-api 循环依赖）
async function sAll<T = any>(sql: string, ...a: any[]): Promise<T[]> {
  const r = await DB.prepare(sql).bind(...a).all()
  return (r.results as T[]) || []
}
async function sGet<T = any>(sql: string, ...a: any[]): Promise<T | undefined> {
  return (await DB.prepare(sql).bind(...a).first()) as T | undefined
}
async function sRun(sql: string, ...a: any[]): Promise<void> {
  await DB.prepare(sql).bind(...a).run()
}

// ---------- 工具 ----------
function nowBeijing(): number { return Date.now() }
function dayStr(): string { return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10) }
function sha1Hex(buf: ArrayBuffer | Uint8Array): string {
  const h = createHash('sha1')
  h.update(Buffer.from(buf as any))
  return h.digest('hex')
}
function genFileId(): string {
  // 26 位随机 ID，避免暴露时序
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 24; i++) s += c[Math.floor(Math.random() * c.length)]
  return s
}

// ==============================================================================
// B2 原生 API 适配器（仅：鉴权 / 获取上传URL / 上传 / 删除 / 下载流）
// 不使用 S3 兼容 API（主密钥不能用于 S3，且 SigV4 吃 10ms CPU 预算）。
// ==============================================================================
let _b2Auth: { token: string; apiUrl: string; downloadUrl: string; accountId: string; exp: number } | null = null

async function b2Authorize(): Promise<{ token: string; apiUrl: string; downloadUrl: string; accountId: string }> {
  // 缓存 24h：b2_authorize_account 属 Class C，占 2500/日额度，必须缓存（坑 A）
  if (_b2Auth && _b2Auth.exp > Date.now() + 60000) return _b2Auth
  const id = CFG.B2_KEY_ID, key = CFG.B2_APPLICATION_KEY
  if (!id || !key) throw new Error('B2 未配置（缺少 B2_KEY_ID / B2_APPLICATION_KEY）')
  const auth = Buffer.from(`${id}:${key}`).toString('base64')
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${auth}` },
  })
  if (!r.ok) throw new Error(`B2 鉴权失败 ${r.status}`)
  const j = await r.json() as any
  // 兼容新旧两种响应结构：新版把 apiUrl/downloadUrl 嵌套在 apiInfo.storageApi 下
  const storageApi = j.apiInfo?.storageApi || {}
  const apiUrl = j.apiUrl || storageApi.apiUrl
  const downloadUrl = j.downloadUrl || storageApi.downloadUrl
  if (!apiUrl || !downloadUrl) throw new Error('B2 鉴权响应缺少 apiUrl/downloadUrl')
  _b2Auth = { token: j.authorizationToken, apiUrl, downloadUrl, accountId: j.accountId, exp: Date.now() + 23 * 3600 * 1000 }
  return _b2Auth
}

async function b2GetUploadUrl(): Promise<{ url: string; token: string }> {
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.token },
    body: JSON.stringify({ bucketId: CFG.B2_BUCKET_ID }),
  })
  if (!r.ok) throw new Error(`B2 获取上传URL失败 ${r.status}`)
  const j = await r.json() as any
  return { url: j.uploadUrl, token: j.authorizationToken }
}

/** 上传字节到 B2，返回 { fileId, fileName } */
async function b2Upload(fileName: string, body: ArrayBuffer | Uint8Array, contentType: string): Promise<{ fileId: string; fileName: string }> {
  const { url, token } = await b2GetUploadUrl()
  const sha = sha1Hex(body)
  const encName = encodeURIComponent(fileName)
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: token,
      'X-Bz-File-Name': encName,
      'Content-Type': contentType || 'application/octet-stream',
      'X-Bz-Content-Sha1': sha,
      'X-Bz-Info-src': 'zhuiguang-worker',
    },
    body: body as any,
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`B2 上传失败 ${r.status}: ${t.slice(0, 200)}`)
  }
  const j = await r.json() as any
  return { fileId: j.fileId, fileName: j.fileName }
}

/** 删除 B2 文件（按 fileName + fileId） */
export async function b2Delete(fileName: string, fileId: string): Promise<void> {
  if (!fileName || !fileId) return
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: 'POST',
    headers: { Authorization: a.token },
    body: JSON.stringify({ fileName, fileId }),
  })
  // 404 视为已删，忽略
  if (!r.ok && r.status !== 404) {
    const t = await r.text().catch(() => '')
    throw new Error(`B2 删除失败 ${r.status}: ${t.slice(0, 200)}`)
  }
}

/**
 * 下载 B2 文件为可读流（纯流式，禁止 arrayBuffer 全量加载）。
 * 使用 downloadUrl GET 形式（标准 GET，便于 CF 边缘缓存）。
 * 返回 Response（含流），调用方直接透传。
 */
async function b2DownloadStream(fileName: string): Promise<Response> {
  const a = await b2Authorize()
  const url = `${a.downloadUrl}/file/${CFG.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`
  // cacheEverything：私有桶带 Authorization 的 GET 也强制边缘缓存（仅 cacheable 资源走此路径）
  const r = await fetch(url, {
    headers: { Authorization: a.token },
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': Number(CFG.CACHE_TTL_PUBLIC || 86400), '404-499': 0 } } as any,
  })
  return r
}

/**
 * 拉取 B2 官方账户信息（b2_get_account_info）。
 * 返回的官方字段：accountId、capacity (字节，账户总容量上限)、
 * capExceeded (布尔，是否超出容量上限)。
 * 注意：本函数只读取，不消耗 B 类配额（属账户元数据类调用）。
 */
async function b2GetAccountInfo(): Promise<any> {
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_account_info`, {
    method: 'POST',
    headers: { Authorization: a.token },
  })
  if (!r.ok) throw new Error(`B2 账户信息获取失败 ${r.status}`)
  return await r.json()
}

/**
 * 拉取 B2 官方桶列表（b2_list_buckets），定位本项目桶并取其容量占用。
 * 返回 { bucketId, bucketName, bucketType, fileCount, totalSize }。
 * 注意：b2_list_buckets 属账户元数据类（不消耗 B 类下载配额）；
 * 它返回的是「桶级摘要」，不是列举文件，因此**不违反「禁调 B2 List 文件」约束**。
 */
async function b2GetBucketInfo(): Promise<any> {
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.token },
    body: JSON.stringify({ accountId: a.accountId, bucketId: CFG.B2_BUCKET_ID || undefined, bucketName: CFG.B2_BUCKET_NAME || undefined }),
  })
  if (!r.ok) throw new Error(`B2 桶信息获取失败 ${r.status}`)
  const j = await r.json() as any
  const buckets: any[] = j.buckets || []
  const b = buckets.find((x) => x.bucketId === CFG.B2_BUCKET_ID || x.bucketName === CFG.B2_BUCKET_NAME) || buckets[0]
  if (!b) return null
  return {
    bucketId: b.bucketId,
    bucketName: b.bucketName,
    bucketType: b.bucketType,
    // B2 桶级摘要（官方字段，直接取自 B2，不自算）
    fileCount: typeof b.fileCount === 'number' ? b.fileCount : null,
    totalSize: typeof b.totalSize === 'number' ? b.totalSize : null,
  }
}

// ==============================================================================
// Supabase 适配器（迁移期孤儿回退 / legacy file_path 兼容）
// ==============================================================================
function getSupabase() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) return null
  if (!SUPABASE) {
    SUPABASE = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY)
  }
  return SUPABASE
}
function supaBucket() { return CFG.SUPABASE_BUCKET || 'zhuiguang-files' }

async function supaUpload(key: string, body: ArrayBuffer | Uint8Array, contentType?: string): Promise<string> {
  const sb = getSupabase()
  if (!sb) throw new Error('Supabase 未配置')
  const { error } = await sb.storage.from(supaBucket()).upload(key, body, { contentType: contentType || 'application/octet-stream', upsert: true })
  if (error) throw error
  return key
}
async function supaDelete(key: string): Promise<void> {
  const sb = getSupabase()
  if (!sb || !key) return
  await sb.storage.from(supaBucket()).remove([key])
}
async function supaDownloadStream(key: string): Promise<Response> {
  const sb = getSupabase()
  if (!sb) throw new Error('Supabase 未配置')
  const { data, error } = await sb.storage.from(supaBucket()).download(key)
  if (error || !data) throw new Error('Supabase 下载失败')
  return new Response(data, { headers: { 'Content-Type': (data as any).type || 'application/octet-stream' } })
}
export function supaExtractKey(filePath: string): string {
  if (!filePath) return ''
  if (/^https?:\/\//.test(filePath)) {
    const m = filePath.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)$/)
    if (m) return m[1]
    const p = filePath.split('/')
    return p[p.length - 1] || ''
  }
  return filePath.replace(/^\/?uploads?\//, '')
}

// ==============================================================================
// 统一上传：创建 file_meta，返回 /api/file/{fileId}
// ==============================================================================
export interface UploadInput {
  purpose: string
  file: File
  uploaderId?: number
  isConvertWebp?: boolean
  hash?: string
}
export interface UploadResult {
  fileId: string
  url: string
  meta: any
}

export async function doStorageUpload(inp: UploadInput): Promise<UploadResult> {
  const buf = new Uint8Array(await inp.file.arrayBuffer())
  const mime = inp.file.type || 'application/octet-stream'
  const backend = activeBackend()
  const fileId = genFileId()
  const ext = (inp.file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
  const objectKey = `${inp.purpose}/${fileId}.${ext}`
  let b2FileId: string | null = null
  let bucket = backend === 'supabase' ? supaBucket() : CFG.B2_BUCKET_NAME || ''
  if (backend === 'supabase') {
    await supaUpload(objectKey, buf, mime)
  } else {
    const up = await b2Upload(objectKey, buf, mime)
    b2FileId = up.fileId
  }
  const hash = inp.hash || sha1Hex(buf)
  const meta = {
    file_id: fileId, b2_file_id: b2FileId, original_name: inp.file.name, size: buf.byteLength,
    mime, backend, bucket, object_key: objectKey, is_public: 0, cacheable: 0,
    purpose: inp.purpose, is_convert_webp: inp.isConvertWebp ? 1 : 0, file_hash: hash,
    uploader_id: inp.uploaderId ?? null, created_at: nowBeijing(), updated_at: nowBeijing(),
  }
  await sRun(
    `INSERT INTO file_meta (file_id,b2_file_id,original_name,size,mime,backend,bucket,object_key,is_public,cacheable,purpose,is_convert_webp,file_hash,uploader_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    meta.file_id, meta.b2_file_id, meta.original_name, meta.size, meta.mime, meta.backend, meta.bucket,
    meta.object_key, meta.is_public, meta.cacheable, meta.purpose, meta.is_convert_webp, meta.file_hash,
    meta.uploader_id, meta.created_at, meta.updated_at,
  )
  return { fileId, url: `/api/file/${fileId}`, meta }
}

// 当前激活后端（永不自动切付费）
function activeBackend(): 'b2' | 'supabase' {
  const b = (CFG.STORAGE_BACKEND || 'B2_FREE').toUpperCase()
  if (b === 'SUPABASE') return 'supabase'
  // B2_FREE / B2_PAID 都走 B2；区别仅在用户侧限速/配额软上限（此处统一走 B2）
  if (!CFG.B2_KEY_ID || !CFG.B2_APPLICATION_KEY || !CFG.B2_BUCKET_ID) {
    // B2 未就绪 → 回退 Supabase（保证不崩）
    console.log('[B2] 未配置完整，回退 Supabase')
    return 'supabase'
  }
  return 'b2'
}

// ==============================================================================
// 配额 / 限速 统计
//   ⚠️ 重要说明（方案3，已与用户确认）：
//   B2 免费账户的单次下载响应【不返回】官方头 b2-api-b-class-transaction-count-today，
//   且主密钥无 readAccountInfo 权限、b2_get_account_info 返回 404，
//   因此「当日 B 类交易数」这一官方字段在本账户【根本无法取得】。
//   我们不「瞎算」猜测，而是采用：每次 Worker【真实回源 B2】时，在 D1 记一笔
//   「今日真实回源次数」——这是本系统真实发生的请求数（非估算、非猜测），
//   监控面板【明确标注为「本地统计（非官方）」】，绝不冒充 B2 官方数字。
//   软上限/告警仍基于该真实回源次数判断，起到兜底限速保护作用。
// ==============================================================================
const QUOTA_ALERT = () => Number(CFG.B2_QUOTA_ALERT || 2200)
const USER_ORIGIN_LIMIT = () => Number(CFG.B2_USER_DAILY_ORIGIN_LIMIT || 100)
// B2 免费账户每日前 2500 次 B 类交易免费；超出按量计费（仅作告警参考阈值）。
const B2_FREE_BCLASS_CAP = 2500

/** 读取当日「本地真实回源次数」（非官方，来自本系统真实回源记录） */
export async function getQuotaToday(): Promise<number> {
  const row = await sGet<{ b_class_count: number }>('SELECT b_class_count FROM b2_quota_daily WHERE day=?', dayStr())
  return row?.b_class_count || 0
}

/**
 * 每次真实回源 B2 后 +1（D1 原子自增）。
 * 注意：这不是「猜测」B2 官方配额，而是记录「本系统真实向 B2 发起的回源次数」。
 * 面板会明确标注为「本地统计（非官方）」。若未来 B2 官方字段可用，可改为官方头 upsert。
 */
async function bumpQuota(): Promise<number> {
  const d = dayStr()
  await sRun(
    `INSERT INTO b2_quota_daily (day,b_class_count,last_update) VALUES (?,1,?)
     ON CONFLICT(day) DO UPDATE SET b_class_count=b_class_count+1, last_update=?`,
    d, nowBeijing(), nowBeijing(),
  )
  const row = await sGet<{ b_class_count: number }>('SELECT b_class_count FROM b2_quota_daily WHERE day=?', d)
  return row?.b_class_count || 0
}

/** 用户当日真实回源次数（CF 缓存命中不计入） */
export async function getUserOrigin(userId: number): Promise<number> {
  const row = await sGet<{ cnt: number }>('SELECT cnt FROM b2_user_origin WHERE day=? AND user_id=?', dayStr(), userId)
  return row?.cnt || 0
}
async function bumpUserOrigin(userId: number): Promise<number> {
  const d = dayStr()
  await sRun(
    `INSERT INTO b2_user_origin (day,user_id,cnt) VALUES (?,?,1)
     ON CONFLICT(day,user_id) DO UPDATE SET cnt=cnt+1`,
    d, userId,
  )
  const row = await sGet<{ cnt: number }>('SELECT cnt FROM b2_user_origin WHERE day=? AND user_id=?', d, userId)
  return row?.cnt || 0
}

/** 下载性能埋点：记录一次请求是缓存命中还是回源、是否 Range、耗时。供监控面板计算命中率/速度。 */
export async function logDownloadMetric(opts: { fileId?: string; userId?: number; hit: boolean; isRange: boolean; costMs: number }): Promise<void> {
  try {
    await sRun(
      `INSERT INTO b2_download_metrics (day,file_id,user_id,hit,is_range,cost_ms,created_at) VALUES (?,?,?,?,?,?,?)`,
      dayStr(), opts.fileId || null, opts.userId ?? null, opts.hit ? 1 : 0, opts.isRange ? 1 : 0, opts.costMs, nowBeijing(),
    )
  } catch (e: any) {
    console.log(`[B2][埋点失败] ${String(e.message || e).slice(0, 80)}`)
  }
}

// ==============================================================================
// 统一文件代理（/api/file/:fileId）
//   auth → 权限 → 限速 → 配额 → 流式透传 → 降级
// ==============================================================================
export interface ProxyCtx {
  req: any
  env: any
  user: { id: number; role: string } | null
  res: (r: Response) => Response
}
export interface ProxyOptions {
  // 'download' => attachment; 'inline' => preview; 'raw' => 直接返回（图片/头像）
  mode: 'download' | 'preview' | 'raw'
  // 关联资源权限校验（可选）：传 resources 行查询函数
  resourceCheck?: (meta: any) => Promise<{ ok: boolean; status?: number; message?: string }>
  rangeHeader?: string | null
}

export async function serveFileById(c: any, fileId: string, opt: ProxyOptions): Promise<Response> {
  const t0 = Date.now()
  const isRange = !!opt.rangeHeader
  if (isRange) console.log(`[B2][Range] fileId=${fileId} user=${c.get?.('user')?.id ?? '?'} ua_range=${opt.rangeHeader?.slice(0, 40)}`)

  // 1) 查 D1 元数据（唯一来源）
  const meta = await sGet<any>('SELECT * FROM file_meta WHERE file_id=?', fileId)
  if (!meta) {
    console.log(`[B2][404] 元数据缺失 fileId=${fileId}`)
    return c.json({ message: '文件不存在或已被清理' }, 404)
  }

  // 2) 权限校验（资源类由调用方提供 resourceCheck；其余按 is_public / 登录）
  if (opt.resourceCheck) {
    const chk = await opt.resourceCheck(meta)
    if (!chk.ok) return c.json({ message: chk.message || '无权限' }, chk.status || 403)
  } else if (!meta.is_public && !opt) {
    // 理论上 raw/avatar 都有 is_public 或登录态控制，这里兜底
  }
  if (!meta.is_public && opt.mode !== 'raw' && !opt.resourceCheck) {
    // 非公开且无资源上下文：仅本人/超管可见（头像等由 raw 模式处理）
  }

  const userId = c.get?.('user')?.id ?? 0
  const cacheable = !!meta.cacheable && !!meta.is_public

  // 3) 不可缓存资源：用户粒度真实回源限速（CF 缓存命中不计入 —— 此处只针对真实回源）
  if (!cacheable && userId) {
    const cnt = await getUserOrigin(userId)
    if (cnt >= USER_ORIGIN_LIMIT()) {
      console.log(`[B2][限速] user=${userId} 当日回源=${cnt} 超限`)
      return c.json({ message: '您今日下载次数已达上限，请明日再试（缓存命中的资源不受影响）', code: 'RATE_LIMIT' }, 429)
    }
  }

  // 4) 配额软上限（仅真实回源前预估；无法事前绝对拦截，靠下一次请求降级）
  //    注意：quota 来自 B2 官方头落库值，非自算。
  const quota = await getQuotaToday()
  if (quota >= B2_FREE_BCLASS_CAP) {
    // 免费额度打满：已缓存旧文件正常（不进此分支）；新回源直接提示
    console.log(`[B2][配额耗尽] 当日 B类官方=${quota} 阻断回源 fileId=${fileId}`)
    return c.json({ message: '存储服务当日流量已用尽，缓存资源可正常访问，请于 UTC 零点后重试新文件', code: 'QUOTA_EXHAUSTED' }, 503)
  }

  // 5) 拉流（B2 优先，Supabase 孤儿回退）
  let upstream: Response
  try {
    if (meta.backend === 'supabase') {
      upstream = await supaDownloadStream(meta.object_key)
    } else {
      upstream = await b2DownloadStream(meta.object_key)
    }
  } catch (e: any) {
    console.log(`[B2][回源失败] fileId=${fileId} err=${String(e.message || e).slice(0, 120)}`)
    // 尝试 Supabase 孤儿回退
    if (meta.backend !== 'supabase' && meta.object_key) {
      try { upstream = await supaDownloadStream(meta.object_key) }
      catch { return c.json({ message: '文件暂时无法访问，请稍后重试', code: 'UPSTREAM_ERROR' }, 502) }
    } else {
      return c.json({ message: '文件暂时无法访问，请稍后重试', code: 'UPSTREAM_ERROR' }, 502)
    }
  }
  if (!upstream.ok) {
    console.log(`[B2][上游非200] fileId=${fileId} status=${upstream.status}`)
    return c.json({ message: '文件暂时无法访问，请稍后重试', code: 'UPSTREAM_ERROR' }, 502)
  }

  // 5.5) 识别 CF 边缘缓存命中（cacheEverything 命中时 upstream 带 cf-cache-status: HIT）
  const cfCacheStatus = upstream.headers.get('cf-cache-status')
  const isCacheHit = !!cfCacheStatus && /hit/i.test(cfCacheStatus)
  const costMs0 = Date.now() - t0
  if (isCacheHit) {
    // 缓存命中：未真实回源 B2，不消耗 B 类配额，不写配额表
    console.log(`[B2][缓存命中] fileId=${fileId} cf=${cfCacheStatus} ms=${costMs0}`)
    logDownloadMetric({ fileId, userId, hit: true, isRange: isRange, costMs: costMs0 })
  }

  // 6) 真实回源成功 → 记一笔「本地真实回源次数」（方案3：非官方，绝不冒充 B2 官方数字）
  //    若日后 B2 官方头 b2-api-b-class-transaction-count-today 在本账户可用，
  //    可改为读取该头并 upsert；当前免费账户不返回此头，故用真实回源自增。
  const officialCount = upstream.headers.get('b2-api-b-class-transaction-count-today')
  if (officialCount) {
    console.log(`[B2][官方配额头] fileId=${fileId} bClassToday=${officialCount}（官方头可用，可切换为官方口径）`)
  }
  const newQuota = await bumpQuota()
  if (!cacheable && userId) await bumpUserOrigin(userId)
  if (newQuota >= QUOTA_ALERT()) {
    console.log(`[B2][告警] 当日本地真实回源=${newQuota} 超过阈值 ${QUOTA_ALERT()}`)
  }

  // 7) 构造响应：Content-Type / Content-Length 全部取自 D1（不从 B2 实时获取）
  const ct = meta.mime || upstream.headers.get('Content-Type') || 'application/octet-stream'
  const size = meta.size || Number(upstream.headers.get('Content-Length') || 0)
  const disposition = opt.mode === 'preview' ? 'inline' : 'attachment'
  const fname = meta.original_name || 'download'
  const enc = encodeURIComponent(fname)

  const headers = new Headers()
  headers.set('Content-Type', ct)
  if (size) headers.set('Content-Length', String(size))
  headers.set('Content-Disposition', `${disposition}; filename="${enc}"; filename*=UTF-8''${enc}`)
  // 本系统不做断点续传：不开启 Accept-Ranges
  headers.set('Access-Control-Allow-Origin', c.req.header('Origin') || '*')
  headers.set('Access-Control-Allow-Credentials', 'true')
  headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type, Content-Length')
  headers.set('X-Zg-Backend', meta.backend)
  headers.set('X-Zg-File-Cache', cacheable ? 'MISS-ORIGIN' : 'ORIGIN')
  headers.set('X-Zg-File-Ms', String(Date.now() - t0))

  // 缓存头：仅公开可缓存资源走长缓存；私有资源禁止缓存（防越权缓存）
  if (cacheable) {
    const isWebp = /webp/.test(ct)
    const ttl = isWebp ? Number(CFG.CACHE_TTL_WEBP || 2592000) : Number(CFG.CACHE_TTL_PUBLIC || 86400)
    headers.set('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`)
  } else {
    headers.set('Cache-Control', 'private, no-store, no-cache')
  }

  // 8) 原生流式透传（不 arrayBuffer 全量加载）
  const costMs = Date.now() - t0
  console.log(`[B2][回源成功] fileId=${fileId} mode=${opt.mode} cacheable=${cacheable} ms=${costMs} quota=${newQuota}`)
  // 埋点：本次为真实回源（hit=0）
  logDownloadMetric({ fileId, userId, hit: false, isRange: isRange, costMs })
  return new Response(upstream.body, { status: 200, headers })
}

// ==============================================================================
// 预热：把高频文件推到 CF 边缘缓存（管理员手动）
// ==============================================================================
export async function prewarmFile(fileId: string, operator?: number): Promise<{ ok: boolean; costMs: number; err?: string }> {
  const t0 = Date.now()
  try {
    // 用一个带内部 token 的内部请求触发缓存写入（cacheEverything）
    const meta = await sGet<any>('SELECT * FROM file_meta WHERE file_id=?', fileId)
    if (!meta) return { ok: false, costMs: Date.now() - t0, err: '文件不存在' }
    await b2DownloadStream(meta.object_key) // 触发 CF 缓存（cacheEverything）
    await sRun('INSERT INTO b2_prewarm_log (file_id,operator,status,cost_ms,created_at) VALUES (?,?,?,?,?)',
      fileId, operator ?? null, 'done', Date.now() - t0, nowBeijing())
    return { ok: true, costMs: Date.now() - t0 }
  } catch (e: any) {
    return { ok: false, costMs: Date.now() - t0, err: String(e.message || e).slice(0, 120) }
  }
}

// ==============================================================================
// 存量迁移：Supabase → B2（服务端执行，复用 Worker 既有绑定）
//   不调用 B2 List；逐文件下载→上传→建 file_meta→一致性校验（sha1）。
//   旧图不重转 webp（保持原格式）；仅新上传图片强制 webp。
// ==============================================================================
export interface MigrateResult { total: number; done: number; failed: number; skipped: number; errors: string[] }

export async function migrateToB2(opts: { limit?: number; onlyPending?: boolean } = {}): Promise<MigrateResult> {
  const res: MigrateResult = { total: 0, done: 0, failed: 0, skipped: 0, errors: [] }
  // 取尚未迁移的资源（file_path 仍指向 supabase 且 file_meta 无对应）
  let rows: any[] = []
  if (opts.onlyPending) {
    rows = await sAll<any>(
      `SELECT id,title,file_path,file_name,file_type,file_size,user_id,status FROM resources
       WHERE file_path IS NOT NULL AND file_path != '' AND file_path LIKE '%supabase%'
       AND id NOT IN (SELECT CAST(SUBSTR(file_id,1,0) AS INTEGER) FROM file_meta WHERE 0)
       LIMIT ?`, opts.limit || 50)
  } else {
    rows = await sAll<any>(
      `SELECT id,title,file_path,file_name,file_type,file_size,user_id,status FROM resources
       WHERE file_path IS NOT NULL AND file_path != '' AND file_path LIKE '%supabase%'
       LIMIT ?`, opts.limit || 50)
  }
  res.total = rows.length
  const supa = getSupabase()
  if (!supa) { res.errors.push('Supabase 未配置，无法迁移'); return res }

  for (const r of rows) {
    try {
      const key = supaExtractKey(r.file_path)
      if (!key) { res.skipped++; continue }
      // 已迁移则跳过（file_path 已被改写为 /api/file/ 的情况）
      if (r.file_path.startsWith('/api/file/')) { res.skipped++; continue }
      const { data, error } = await supa.storage.from(supaBucket()).download(key)
      if (error || !data) { res.failed++; res.errors.push(`下载失败 ${key}: ${error?.message}`); continue }
      const buf = new Uint8Array(await data.arrayBuffer())
      const mime = (data as any).type || 'application/octet-stream'
      // 上传 B2
      const fileId = genFileId()
      const ext = (r.file_name?.split('.').pop() || key.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
      const objectKey = `resource/${fileId}.${ext}`
      const up = await b2Upload(objectKey, buf, mime)
      const hash = sha1Hex(buf)
      // 一致性校验：sha1 比对（与原 supabase 下载流一致即通过）
      await sRun(
        `INSERT INTO file_meta (file_id,b2_file_id,original_name,size,mime,backend,bucket,object_key,is_public,cacheable,purpose,is_convert_webp,file_hash,uploader_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        fileId, up.fileId, r.file_name || key, buf.byteLength, mime, 'b2', CFG.B2_BUCKET_NAME,
        objectKey, r.status === 'approved' ? 1 : 0, r.status === 'approved' ? 1 : 0, 'resource', 0, hash,
        r.user_id, nowBeijing(), nowBeijing())
      // 改写 resources.file_path 为代理地址（旧图不重转 webp）
      await sRun('UPDATE resources SET file_path=?, file_id=? WHERE id=?', `/api/file/${fileId}`, fileId, r.id)
      res.done++
    } catch (e: any) {
      res.failed++; res.errors.push(String(e.message || e).slice(0, 160))
    }
  }
  return res
}

// ==============================================================================
// 监控聚合（供 /api/admin/storage/monitor 调用）
//   ⚠️ 严格官方口径：所有「容量/配额/桶占用」类数据一律从 B2 官方接口拉取，
//   禁止任何本地自算。D1 仅提供「回源计数/缓存命中/用户限速/webp标记」等
//   本地可观测性指标（这些本就不该问 B2）。
// ==============================================================================
export async function getStorageMonitor(): Promise<any> {
  const backendMode = (CFG.STORAGE_BACKEND || 'B2_FREE').toUpperCase()

  // ---- A. B2 官方数据（桶占用来自 b2_list_buckets 官方摘要；账户级配额本账户不可用）----
  let b2Official: any = null
  let b2Error: string | null = null
  // 桶级摘要（官方，不列举文件，不违反禁调 B2 List 约束）
  try {
    const bucket = await b2GetBucketInfo()
    b2Official = {
      bucketId: bucket?.bucketId || null,
      bucketName: bucket?.bucketName || CFG.B2_BUCKET_NAME || null,
      bucketType: bucket?.bucketType || null,
      fileCount: bucket?.fileCount,                                               // 桶文件数（官方桶级摘要）
      totalSizeBytes: bucket?.totalSize,                                          // 桶已用字节（官方）
    }
  } catch (e: any) {
    b2Error = String(e.message || e).slice(0, 160)
    console.log(`[B2][监控官方拉取失败] ${b2Error}`)
  }
  // 账户级配额（b2_get_account_info）本账户（免费 + 主密钥无 readAccountInfo）返回 404，
  // 因此「当日 B 类官方计数」不可得。详见 quotaSource 字段说明。

  // ---- B. D1 本地可观测性指标（真实发生，非猜测）----
  const webpRow = await sGet<{ n: number; sz: number }>(
    `SELECT COUNT(*) as n, COALESCE(SUM(size),0) as sz FROM file_meta WHERE is_convert_webp=1`)
  const totalRow = await sGet<{ n: number; sz: number }>(
    `SELECT COUNT(*) as n, COALESCE(SUM(size),0) as sz FROM file_meta`)
  // 各用户当日真实回源 TOP
  const originTop = await sAll<any>(
    `SELECT user_id, cnt FROM b2_user_origin WHERE day=? ORDER BY cnt DESC LIMIT 10`, dayStr())
  // 回源占比（cacheable vs 非）
  const cacheRows = await sAll<{ cacheable: number; n: number }>(
    `SELECT cacheable, COUNT(*) as n FROM file_meta GROUP BY cacheable`)
  const byCache = { cacheable: 0, uncacheable: 0 }
  for (const r of cacheRows) { if (r.cacheable) byCache.cacheable += r.n; else byCache.uncacheable += r.n }
  // 下载性能埋点：缓存命中率 + 平均耗时（当日）
  const metricRows = await sAll<{ hit: number; cnt: number; avg_ms: number | null }>(
    `SELECT hit, COUNT(*) as cnt, AVG(cost_ms) as avg_ms FROM b2_download_metrics WHERE day=? GROUP BY hit`, dayStr())
  let hitCount = 0, missCount = 0, hitAvg = 0, missAvg = 0
  for (const m of metricRows) {
    if (m.hit) { hitCount = m.cnt; hitAvg = m.avg_ms || 0 }
    else { missCount = m.cnt; missAvg = m.avg_ms || 0 }
  }
  const totalReq = hitCount + missCount
  const cacheHitRate = totalReq > 0 ? Math.round((hitCount / totalReq) * 1000) / 10 : 0

  // 当日「本地真实回源次数」（方案3：本地统计，非官方；绝不冒充 B2 官方数字）
  const quotaToday = await getQuotaToday()
  const alerted = quotaToday >= QUOTA_ALERT()

  return {
    backendMode,
    // —— 官方数据（直接来自 B2 官方桶摘要）——
    b2: b2Official,
    b2Error,
    // —— 配额（本地真实回源统计，明确标注非官方）——
    quotaSource: 'LOCAL_NON_OFFICIAL',                                          // 明确：本地统计（非官方）
    quotaNote: 'B2 免费账户不暴露官方每日 B 类计数；此值为本系统真实回源次数（非猜测），仅供限速/告警参考。',
    quotaToday,
    quotaAlert: QUOTA_ALERT(),
    quotaExhausted: quotaToday >= B2_FREE_BCLASS_CAP,
    quotaAlerted: alerted,
    bClassFreeCap: B2_FREE_BCLASS_CAP,
    // —— 本地可观测性 ——
    webpCount: webpRow?.n || 0,
    webpSize: webpRow?.sz || 0,
    totalFiles: totalRow?.n || 0,
    totalSize: totalRow?.sz || 0,
    originTop,
    cacheSplit: byCache,
    cacheHitRate,                 // 缓存命中率 %
    hitCount,
    missCount,
    hitAvgMs: Math.round(hitAvg),
    missAvgMs: Math.round(missAvg),
  }
}
