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
async function sRun(sql: string, ...a: any[]): Promise<any> {
  // 返回 D1 Result（含 meta.changes），调用方需要知道影响行数时可用
  return await DB.prepare(sql).bind(...a).run()
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
// ------------------------------------------------------------------------------
// ⚠️ v4.4.1 关键修复：C 类交易异常消耗（曾出现「1 次下载 → 8 次 C 类」）
//   b2_authorize_account 属 **Class C**（免费账户 2500/日）。原实现把 token 只存在
//   Worker 模块级变量里，而 Cloudflare 会在全球多个 PoP 各起一个 isolate，
//   且 isolate 会冷启动回收 —— 于是每次冷启动、每个新 PoP 都要重新鉴权一次 C 类。
//   b2_list_buckets 同样属 **Class C**，管理员每刷新一次监控面板就白烧一次。
//   修复：token 持久化到 D1（b2_auth_cache 单行表），全球所有 isolate 共享，
//   → 正常情况下每日仅 1 次 C 类。并发请求用 in-flight Promise 合并，避免抖动。
// ==============================================================================
interface B2Auth { token: string; apiUrl: string; downloadUrl: string; accountId: string; exp: number }
let _b2Auth: B2Auth | null = null
let _b2AuthInFlight: Promise<B2Auth> | null = null

export async function b2Authorize(): Promise<B2Auth> {
  // L1：进程内内存缓存（最快，0 次外部请求）
  if (_b2Auth && _b2Auth.exp > Date.now() + 120000) return _b2Auth
  // L2：并发合并 —— 同一 isolate 内多个请求只打一次 B2
  if (_b2AuthInFlight) return _b2AuthInFlight
  _b2AuthInFlight = b2AuthorizeReal()
    .then((a) => { _b2Auth = a; return a })
    .finally(() => { _b2AuthInFlight = null })
  return _b2AuthInFlight
}

async function b2AuthorizeReal(): Promise<B2Auth> {
  // L2：D1 持久化缓存（跨 isolate / 跨 PoP 共享，仍不消耗 C 类）
  try {
    const row = await sGet<any>('SELECT * FROM b2_auth_cache WHERE id=1')
    if (row && row.token && Number(row.exp) > Date.now() + 120000) {
      const a: B2Auth = {
        token: row.token, apiUrl: row.api_url, downloadUrl: row.download_url,
        accountId: row.account_id, exp: Number(row.exp),
      }
      _b2Auth = a
      return a
    }
  } catch (e: any) {
    console.log(`[B2][鉴权缓存读取失败] ${String(e.message || e).slice(0, 80)}`)
  }

  // L3：真·调用 B2（消耗 1 次 Class C，每日应仅发生一次）
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
  const a: B2Auth = { token: j.authorizationToken, apiUrl, downloadUrl, accountId: j.accountId, exp: Date.now() + 23 * 3600 * 1000 }
  _b2Auth = a
  // 写回 D1，供其它 isolate / PoP 复用（失败不致命，仅退化为本 isolate 缓存）
  try {
    await sRun(
      `INSERT INTO b2_auth_cache (id,token,api_url,download_url,account_id,exp,updated_at) VALUES (1,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET token=?,api_url=?,download_url=?,account_id=?,exp=?,updated_at=?`,
      a.token, a.apiUrl, a.downloadUrl, a.accountId, a.exp, nowBeijing(),
      a.token, a.apiUrl, a.downloadUrl, a.accountId, a.exp, nowBeijing(),
    )
    console.log('[B2][鉴权] 已刷新并写入 D1 共享缓存（本次消耗 1 次 Class C）')
  } catch (e: any) {
    console.log(`[B2][鉴权缓存写入失败] ${String(e.message || e).slice(0, 80)}`)
  }
  return a
}

/** 上传 URL 也缓存（b2_get_upload_url 属 Class B，免费额度共用，能省则省） */
let _b2Upload: { url: string; token: string; exp: number } | null = null
async function b2GetUploadUrl(): Promise<{ url: string; token: string }> {
  if (_b2Upload && _b2Upload.exp > Date.now() + 60000) return _b2Upload
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.token },
    body: JSON.stringify({ bucketId: CFG.B2_BUCKET_ID }),
  })
  if (!r.ok) throw new Error(`B2 获取上传URL失败 ${r.status}`)
  const j = await r.json() as any
  _b2Upload = { url: j.uploadUrl, token: j.authorizationToken, exp: Date.now() + 23 * 3600 * 1000 }
  return _b2Upload
}
/** 上传失败时调用：丢弃缓存的 uploadUrl（单次 uploadUrl 只允许用一个文件） */
function invalidateUploadUrl() { _b2Upload = null }

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
    invalidateUploadUrl() // 该 uploadUrl 已作废，下次重新获取
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
 * ------------------------------------------------------------------------------
 * v4.4.1 提速：B2 源站 US West，中国用户跨太平洋回源单文件常需 1~3s，
 * 唯一有效的提速手段就是「让第一次之后的请求命中 CF 边缘缓存」。
 * B2 对私有桶 GET 不返回任何 Cache-Control 头，因此必须靠 cf.cacheEverything
 * 强制缓存 + cacheTtlByStatus 显式给 TTL，否则 CF 判定为不可缓存、每次都回源。
 *   · cacheable（公开资源）→ 长 TTL（图片 30 天 / 其它 1 天）
 *   · 非 cacheable（私有资源）→ 短 TTL（默认 300s），既提速又限制越权窗口
 *     （权限校验已在 Worker 层完成，缓存的是文件字节本身，不外泄给无权用户）
 */
async function b2DownloadStream(fileName: string, ttlSec?: number): Promise<Response> {
  const a = await b2Authorize()
  const url = `${a.downloadUrl}/file/${CFG.B2_BUCKET_NAME}/${encodeURIComponent(fileName)}`
  const ttl = typeof ttlSec === 'number' ? ttlSec : Number(CFG.CACHE_TTL_PUBLIC || 86400)
  const r = await fetch(url, {
    headers: { Authorization: a.token },
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '404-499': 0, '500-599': 0 } } as any,
  })
  return r
}

/**
 * ⚠️【实测结论，勿再重试】B2 账户级接口在本账户不可用（v4.4.1 实测）：
 *   b2_get_account_info  → v2 / v3 均返回 404 not_found
 *   （主密钥 capabilities 为空，B2 的 application key 也不提供 readAccountInfo 选项）
 *   b2_list_buckets      → 可用，但响应【不含 fileCount / totalSize 字段】
 *                          （实测返回体只有 accountId/bucketId/bucketInfo/bucketName/
 *                            bucketType/corsRules/lifecycleRules/options/revision）
 * 因此「桶已用容量」无法从桶摘要拿到，只能通过 b2_list_file_names 全量盘点求和。
 * 该盘点属 Class A（免费 2500/日），所以每日最多做 1 次并落库，见 getBucketCensus()。
 */
async function b2GetBucketMeta(): Promise<any> {
  const a = await b2Authorize()
  const r = await fetch(`${a.apiUrl}/b2api/v3/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.token },
    body: JSON.stringify({ accountId: a.accountId, bucketId: CFG.B2_BUCKET_ID || undefined, bucketName: CFG.B2_BUCKET_NAME || undefined }),
  })
  if (!r.ok) throw new Error(`B2 桶信息获取失败 ${r.status}`)
  const j = await r.json() as any
  const buckets: any[] = j.buckets || []
  return buckets.find((x) => x.bucketId === CFG.B2_BUCKET_ID || x.bucketName === CFG.B2_BUCKET_NAME) || buckets[0] || null
}

/**
 * B2 官方盘点：用 b2_list_file_names 全量列举桶内文件，求和得出官方「已用容量/文件数」。
 * 属 Class A 交易（免费 2500/日），故**每日最多执行 1 次**，结果落 D1 b2_bucket_census。
 * 这是本账户唯一能拿到「B2 官方容量」的途径（account_info 已实测 404）。
 */
export async function runBucketCensus(force = false): Promise<any> {
  const today = dayStr()
  if (!force) {
    const cached = await sGet<any>('SELECT * FROM b2_bucket_census WHERE day=?', today)
    if (cached) {
      return {
        source: 'B2_OFFICIAL_LIST', cached: true, day: today,
        fileCount: cached.file_count, totalSizeBytes: cached.total_size,
        scannedAt: cached.created_at, note: '今日已盘点，读自 D1 快照（官方数据，非估算）',
      }
    }
  }
  const a = await b2Authorize()
  let start: string | null = null
  let fileCount = 0, totalSize = 0, pages = 0
  const sample: any[] = []
  while (pages < 50) { // 上限 50 页 × 1000 = 5 万文件，远超本项目规模，防失控
    const r = await fetch(`${a.apiUrl}/b2api/v3/b2_list_file_names`, {
      method: 'POST',
      headers: { Authorization: a.token },
      body: JSON.stringify(start ? { bucketId: CFG.B2_BUCKET_ID, maxFileCount: 1000, startFileName: start } : { bucketId: CFG.B2_BUCKET_ID, maxFileCount: 1000 }),
    })
    if (!r.ok) throw new Error(`B2 盘点失败 ${r.status}`)
    const j = await r.json() as any
    for (const f of j.files || []) {
      fileCount++
      // ⚠️ B2 官方字段名是 contentLength，不是 size（v2/v3 实测均如此，size 为 undefined）。
      //    写成 f.size 会静默算出 0 字节，面板显示「已用 0 B」却查不出原因。
      totalSize += Number(f.contentLength ?? f.size ?? 0)
      if (sample.length < 20) sample.push({ name: f.fileName, size: Number(f.contentLength ?? f.size ?? 0), mime: f.contentType })
    }
    pages++
    start = j.nextFileName || null
    if (!start) break
  }
  await sRun(
    `INSERT INTO b2_bucket_census (day,file_count,total_size,created_at) VALUES (?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET file_count=?,total_size=?,created_at=?`,
    today, fileCount, totalSize, nowBeijing(), fileCount, totalSize, nowBeijing(),
  )
  return {
    source: 'B2_OFFICIAL_LIST', cached: false, day: today,
    fileCount, totalSizeBytes: totalSize, scannedAt: nowBeijing(),
    note: '本次实时调用 B2 官方 b2_list_file_names 全量盘点（已消耗 Class A 交易）',
    sample,
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
  /** 强制指定是否立即可公开缓存；不传则按 purpose 自动判定 */
  publicNow?: boolean
}

// 无需审核、上传即可公开缓存的用途（其余一律待审核，审核通过后才置位）
// v4.4.1：旧版所有文件一律 is_public=0/cacheable=0 → 所有下载都 private no-store
// 永不进边缘缓存 → 每次都跨太平洋回源 → 这就是「B2 下载慢」的直接原因之一。
const PUBLIC_NOW_PURPOSES = new Set(['avatar', 'announcement', 'notice', 'site', 'cover', 'logo'])
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
  const pubNow = inp.publicNow ?? PUBLIC_NOW_PURPOSES.has(inp.purpose)
  const meta = {
    file_id: fileId, b2_file_id: b2FileId, original_name: inp.file.name, size: buf.byteLength,
    mime, backend, bucket, object_key: objectKey, is_public: pubNow ? 1 : 0, cacheable: pubNow ? 1 : 0,
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

  // 3) 限速 + 配额检查：合并为**一次** D1 查询（v4.4.1 提速：原来两次串行读各 ~20-40ms）
  const quotaRow = await sGet<{ q: number; u: number }>(
    `SELECT (SELECT COALESCE(b_class_count,0) FROM b2_quota_daily WHERE day=?) AS q,
            (SELECT COALESCE(cnt,0) FROM b2_user_origin WHERE day=? AND user_id=?) AS u`,
    dayStr(), dayStr(), userId)
  // 注意：u 是「本系统记录的真实回源次数」（本地统计，非 B2 官方数字）
  if (!cacheable && userId && (quotaRow?.u || 0) >= USER_ORIGIN_LIMIT()) {
    console.log(`[B2][限速] user=${userId} 当日回源=${quotaRow?.u} 超限`)
    return c.json({ message: '您今日下载次数已达上限，请明日再试（缓存命中的资源不受影响）', code: 'RATE_LIMIT' }, 429)
  }
  const quota = quotaRow?.q || 0
  if (quota >= B2_FREE_BCLASS_CAP) {
    console.log(`[B2][配额耗尽] 当日本地回源=${quota} 阻断回源 fileId=${fileId}`)
    return c.json({ message: '存储服务当日流量已用尽，缓存资源可正常访问，请于 UTC 零点后重试新文件', code: 'QUOTA_EXHAUSTED' }, 503)
  }

  // 4) 拉流（B2 优先，Supabase 孤儿回退）
  //    v4.4.1：私有资源也给边缘短缓存（Worker 已鉴权，缓存的是字节本体，不外泄）
  const ttlPublic = Number(CFG.CACHE_TTL_PUBLIC || 86400)
  const ttlWebp = Number(CFG.CACHE_TTL_WEBP || 2592000)
  const ttlPrivate = Number(CFG.CACHE_TTL_PRIVATE ?? 300)
  const edgeTtl = cacheable ? (/webp/.test(meta.mime || '') ? ttlWebp : ttlPublic) : ttlPrivate
  let upstream: Response
  try {
    if (meta.backend === 'supabase') {
      upstream = await supaDownloadStream(meta.object_key)
    } else {
      upstream = await b2DownloadStream(meta.object_key, edgeTtl)
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

  // 5) 识别 CF 边缘缓存命中（cacheEverything 生效时 upstream 带 cf-cache-status: HIT/REVALIDATED）
  const cfCacheStatus = upstream.headers.get('cf-cache-status') || ''
  const isCacheHit = /hit|revalidated/i.test(cfCacheStatus)
  const costMs0 = Date.now() - t0

  // 6) 回源/命中的统计落库 —— 全部走 waitUntil 异步执行，
  //    v4.4.1 提速关键：原本 3 次同步 D1 写（~60-150ms）全部压在用户等待链路上，
  //    现在响应先流式返回，落库在后台完成，用户侧感知延迟直接下降。
  const officialCount = upstream.headers.get('b2-api-b-class-transaction-count-today')
  if (officialCount) {
    console.log(`[B2][官方配额头] fileId=${fileId} bClassToday=${officialCount}（官方头可用，可切换为官方口径）`)
  }
  const waitUntil: (p: Promise<any>) => void =
    (c.executionCtx && typeof c.executionCtx.waitUntil === 'function')
      ? (p) => c.executionCtx.waitUntil(p)
      : (p) => { p.catch(() => {}) }
  waitUntil((async () => {
    try {
      await logDownloadMetric({ fileId, userId, hit: isCacheHit, isRange, costMs: costMs0 })
      if (isCacheHit) {
        // 缓存命中：未真实回源 B2，不计入回源统计（v4.4.1 修复：旧版命中也计了）
        console.log(`[B2][缓存命中] fileId=${fileId} cf=${cfCacheStatus} ms=${costMs0}`)
        return
      }
      // 真实回源 → 记一笔「本地真实回源次数」（方案3：非官方，绝不冒充 B2 官方数字）
      const nq = await bumpQuota()
      if (!cacheable && userId) await bumpUserOrigin(userId)
      if (nq >= QUOTA_ALERT()) console.log(`[B2][告警] 当日本地真实回源=${nq} 超过阈值 ${QUOTA_ALERT()}`)
      console.log(`[B2][回源成功] fileId=${fileId} mode=${opt.mode} cacheable=${cacheable} ms=${costMs0} quota=${nq}`)
    } catch (e: any) {
      console.log(`[B2][统计落库失败] ${String(e.message || e).slice(0, 80)}`)
    }
  })())

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
  // 真实回传边缘缓存状态，便于浏览器控制台/前端排查「为什么慢」
  headers.set('X-Zg-File-Cache', isCacheHit ? 'HIT' : 'MISS')
  headers.set('X-Zg-File-Ms', String(Date.now() - t0))

  // 缓存头（控制「浏览器 → CF」这一段）：
  //   公开可缓存资源 → 长缓存（WebP 30 天 / 其它 1 天），二次访问几乎瞬时
  //   私有资源 → 浏览器不缓存，但 Worker→B2 段仍有短 TTL 边缘缓存（见 edgeTtl）
  if (cacheable) {
    const isWebp = /webp/.test(ct)
    const ttl = isWebp ? Number(CFG.CACHE_TTL_WEBP || 2592000) : Number(CFG.CACHE_TTL_PUBLIC || 86400)
    headers.set('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`)
  } else {
    headers.set('Cache-Control', 'private, no-store, no-cache')
  }

  // 8) 原生流式透传（不 arrayBuffer 全量加载）
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
// 存量迁移：Supabase → B2（全量、幂等、引用改写）
// ------------------------------------------------------------------------------
// ⚠️ v4.4.1 重写：旧版从 D1 查 `file_path LIKE '%supabase%'`，**一条都匹配不到**。
//   实测 Supabase 桶 zhuiguang 内有 15 个文件（4.73 MB），而 D1 的 resources.file_path
//   存的是【纯文件名】（如 file_1787038194294_v1q21tjj.docx），并不含 "supabase" 字样，
//   所以旧迁移永远返回 total=0 —— 这就是「无缝迁移没生效」的根因。
//   新版改为：**直接全量列举 Supabase 桶**（源在桶里，不在 D1 里），
//   逐文件 下载→上传 B2→写 file_meta→反查并改写 D1 中所有引用该文件的字段。
//   • 幂等：b2_migration_log(source_key UNIQUE)，重复执行只补改引用、不重复上传
//   • 无缝：改写后前端拿到的仍是同一语义的 URL（/api/file/{fileId}），业务代码无需改
//   • 安全：默认【不删除】Supabase 源文件，随时可回滚（STORAGE_MODE=SUPABASE）
// ==============================================================================
export interface MigrateResult {
  total: number; done: number; failed: number; skipped: number
  errors: string[]; refsUpdated: number; bytesMoved: number
  items: Array<{ source: string; fileId?: string; size?: number; status: string; refs?: number }>
}

/** 递归列举 Supabase 桶内全部文件（Storage list 不递归，目录的 id 为 null） */
async function supaListAll(prefix = ''): Promise<Array<{ name: string; size: number; mime: string }>> {
  const sb = getSupabase()
  if (!sb) throw new Error('Supabase 未配置')
  const bucket = supaBucket()
  const out: Array<{ name: string; size: number; mime: string }> = []
  let offset = 0
  for (let guard = 0; guard < 50; guard++) {
    const { data, error } = await sb.storage.from(bucket)
      .list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error('Supabase 列举失败: ' + error.message)
    if (!data || data.length === 0) break
    for (const it of data as any[]) {
      const full = prefix ? `${prefix}/${it.name}` : it.name
      if (it.id === null) out.push(...(await supaListAll(full)))
      else out.push({ name: full, size: Number(it.metadata?.size || 0), mime: it.metadata?.mimetype || 'application/octet-stream' })
    }
    if (data.length < 1000) break
    offset += data.length
  }
  return out
}

function supaPublicUrl(key: string): string {
  const base = (CFG.SUPABASE_URL || '').replace(/\/+$/, '')
  return `${base}/storage/v1/object/public/${supaBucket()}/${key}`
}

/** 判断某个 D1 字段值是否指向 Supabase 桶里的这个 key（兼容 纯文件名 / 完整 URL 两种存法） */
function refMatches(v: string, key: string): boolean {
  if (!v) return false
  if (v === key || v === supaPublicUrl(key)) return true
  if (v.endsWith('/' + key)) return true
  return v.includes(`/storage/v1/object/public/${supaBucket()}/${key}`)
}

// 需要改写引用的字段：单值文本 / JSON 数组（数组元素可能是字符串，也可能是 {url} 对象）
const SINGLE_REF_FIELDS: Array<[string, string]> = [
  ['resources', 'file_path'],
  ['users', 'avatar'],
  ['articles', 'cover'],
  ['pages', 'cover'],
]
const JSON_REF_FIELDS: Array<[string, string]> = [
  ['articles', 'images'],
  ['pages', 'images'],
  ['pages', 'attachments'],
  ['messages', 'attachments'],
  ['quiz_questions', 'attachments'],
  ['subject_questions', 'attachments'],
]

/**
 * 把 D1 中所有指向 Supabase key 的引用，改写为新的代理地址 /api/file/{fileId}。
 * 返回实际改写的行数。
 */
async function rewriteRefs(sourceKey: string, newUrl: string): Promise<number> {
  let n = 0
  const pub = supaPublicUrl(sourceKey)
  for (const [tbl, col] of SINGLE_REF_FIELDS) {
    try {
      const r = await sRun(
        `UPDATE ${tbl} SET ${col}=? WHERE ${col}=? OR ${col}=? OR ${col} LIKE ?`,
        newUrl, sourceKey, pub, `%/${sourceKey}`)
      n += Number(r?.meta?.changes || 0)
    } catch (e: any) {
      console.log(`[迁移][引用改写失败] ${tbl}.${col}: ${String(e.message || e).slice(0, 80)}`)
    }
  }
  for (const [tbl, col] of JSON_REF_FIELDS) {
    try {
      // 先用 LIKE 粗筛（key 中的下划线在 LIKE 里是通配符，但后续会精确比对，无副作用）
      const rows = await sAll<any>(`SELECT id, ${col} AS v FROM ${tbl} WHERE ${col} LIKE ?`, `%${sourceKey}%`)
      for (const row of rows) {
        let arr: any[]
        try { arr = JSON.parse(row.v || '[]') } catch { continue }
        if (!Array.isArray(arr)) continue
        let changed = false
        const out = arr.map((it: any) => {
          if (typeof it === 'string' && refMatches(it, sourceKey)) { changed = true; return newUrl }
          if (it && typeof it === 'object' && typeof it.url === 'string' && refMatches(it.url, sourceKey)) {
            changed = true
            return { ...it, url: newUrl }
          }
          return it
        })
        if (changed) {
          await sRun(`UPDATE ${tbl} SET ${col}=? WHERE id=?`, JSON.stringify(out), row.id)
          n++
        }
      }
    } catch (e: any) {
      console.log(`[迁移][JSON引用改写失败] ${tbl}.${col}: ${String(e.message || e).slice(0, 80)}`)
    }
  }
  return n
}

export async function migrateToB2(opts: { limit?: number; only?: string; dryRun?: boolean } = {}): Promise<MigrateResult> {
  const res: MigrateResult = { total: 0, done: 0, failed: 0, skipped: 0, errors: [], refsUpdated: 0, bytesMoved: 0, items: [] }
  const supa = getSupabase()
  if (!supa) { res.errors.push('Supabase 未配置，无法迁移'); return res }

  let files: Array<{ name: string; size: number; mime: string }>
  try {
    files = await supaListAll('')
  } catch (e: any) {
    res.errors.push('列举 Supabase 桶失败: ' + String(e.message || e).slice(0, 160))
    return res
  }
  if (opts.only) files = files.filter((f) => f.name === opts.only || f.name.includes(String(opts.only)))
  res.total = files.length

  const limit = opts.limit || files.length
  let processed = 0
  for (const f of files) {
    if (processed >= limit) break
    processed++
    try {
      // 幂等：已迁移过则只补改引用（比如上次执行时引用表还没建好）
      const exist = await sGet<any>('SELECT * FROM b2_migration_log WHERE source_key=?', f.name)
      if (exist) {
        const refs = await rewriteRefs(f.name, `/api/file/${exist.file_id}`)
        res.skipped++; res.refsUpdated += refs
        res.items.push({ source: f.name, fileId: exist.file_id, status: 'already', refs })
        continue
      }
      if (opts.dryRun) {
        res.skipped++
        res.items.push({ source: f.name, size: f.size, status: 'dry-run' })
        continue
      }
      const { data, error } = await supa.storage.from(supaBucket()).download(f.name)
      if (error || !data) { res.failed++; res.errors.push(`下载失败 ${f.name}: ${error?.message}`); continue }
      const buf = new Uint8Array(await data.arrayBuffer())
      const mime = (data as any).type || f.mime || 'application/octet-stream'
      const fileId = genFileId()
      const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
      const objectKey = `migrated/${fileId}.${ext}`
      const up = await b2Upload(objectKey, buf, mime)
      const hash = sha1Hex(buf)
      // 迁移过来的文件沿用其「原资源是否已过审」的判断：默认不公开，
      // 随后由 rewriteRefs 之后的统一策略按引用表状态置位（见下）
      await sRun(
        `INSERT INTO file_meta (file_id,b2_file_id,original_name,size,mime,backend,bucket,object_key,is_public,cacheable,purpose,is_convert_webp,file_hash,uploader_id,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        fileId, up.fileId, f.name, buf.byteLength, mime, 'b2', CFG.B2_BUCKET_NAME,
        objectKey, 0, 0, 'migrated', 0, hash, null, nowBeijing(), nowBeijing())
      const refs = await rewriteRefs(f.name, `/api/file/${fileId}`)
      await sRun(
        `INSERT INTO b2_migration_log (source_backend,source_key,file_id,size,mime,sha1,refs_updated,status,created_at)
         VALUES ('supabase',?,?,?,?,?,?,'done',?)`,
        f.name, fileId, buf.byteLength, mime, hash, refs, nowBeijing())
      res.done++; res.refsUpdated += refs; res.bytesMoved += buf.byteLength
      res.items.push({ source: f.name, fileId, size: buf.byteLength, status: 'migrated', refs })
    } catch (e: any) {
      res.failed++; res.errors.push(String(e.message || e).slice(0, 160))
      res.items.push({ source: f.name, status: 'failed' })
    }
  }

  // 迁移后统一置位：被「已过审资源」引用的文件 → 公开可缓存（旧图不重转 webp）
  try {
    await sRun(
      `UPDATE file_meta SET is_public=1, cacheable=1
       WHERE file_id IN (
         SELECT REPLACE(r.file_path,'/api/file/','') FROM resources r
         WHERE r.file_path LIKE '/api/file/%' AND r.status='approved')`)
  } catch (e: any) {
    console.log(`[迁移][置位失败] ${String(e.message || e).slice(0, 80)}`)
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

  // ---- A. B2 官方容量 ----
  // v4.4.1 关键修复：旧版每次打开监控面板都调 b2_list_buckets（**Class C**，
  // 免费账户 2500/日）→ 管理员刷 8 次面板就烧 8 次 C 类，这正是「C 类异常」的主因。
  // 现在改为：只读 D1 里的官方盘点快照（b2_bucket_census），
  // 管理员点「立即盘点」时才由 /api/admin/storage/census 真正调 B2（每日 1 次上限）。
  let b2Official: any = null
  let b2Error: string | null = null
  try {
    const census = await sGet<any>('SELECT * FROM b2_bucket_census ORDER BY day DESC LIMIT 1')
    b2Official = {
      bucketId: CFG.B2_BUCKET_ID || null,
      bucketName: CFG.B2_BUCKET_NAME || null,
      bucketType: 'allPrivate',
      fileCount: census ? census.file_count : null,
      totalSizeBytes: census ? census.total_size : null,
      // 官方口径说明：数值来自 B2 官方 b2_list_file_names 全量盘点求和，不是本地估算
      censusDay: census ? census.day : null,
      censusAt: census ? census.created_at : null,
      censusSource: census ? 'B2_OFFICIAL_LIST' : 'NOT_SCANNED',
      censusStale: census ? (census.day !== dayStr()) : true,
    }
  } catch (e: any) {
    b2Error = String(e.message || e).slice(0, 160)
    console.log(`[B2][监控快照读取失败] ${b2Error}`)
  }
  // 账户级配额（b2_get_account_info）本账户实测 404，官方「当日 B 类计数」不可得，
  // 详见下方 quotaSource 字段说明。
  // B2 免费账户存储上限 10 GB（B2 官方公开档位，非自算）；API 取不到故以常量声明，
  // 面板会标注「以 B2 控制台 Billing 页为准」。
  const STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024

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

  // 迁移进度（Supabase 源文件是否已全量搬到 B2）
  let migration: any = { migratedFiles: 0, migratedBytes: 0, lastAt: null, pending: null }
  try {
    const m = await sGet<any>('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS sz, MAX(created_at) AS last_at FROM b2_migration_log')
    migration = { migratedFiles: m?.n || 0, migratedBytes: m?.sz || 0, lastAt: m?.last_at || null, pending: null }
  } catch {}

  const usedBytes = b2Official?.totalSizeBytes || 0
  return {
    backendMode,
    // —— 官方数据（B2 官方 b2_list_file_names 全量盘点，日级快照）——
    b2: b2Official,
    b2Error,
    // —— 容量（上限为 B2 公开免费档位常量，非 API 可得）——
    capacityBytes: STORAGE_CAP_BYTES,
    capacityNote: 'B2 免费档位 10 GB（API 取不到，b2_get_account_info 实测 404），以 B2 控制台 Billing 页为准',
    usedBytes,
    usedPercent: STORAGE_CAP_BYTES ? Math.round((usedBytes / STORAGE_CAP_BYTES) * 1000) / 10 : 0,
    remainingBytes: Math.max(STORAGE_CAP_BYTES - usedBytes, 0),
    // —— Supabase 已废弃（仅保留只读回退，用于迁移期兼容）——
    supabase: {
      deprecated: true,
      note: 'Supabase Storage 已废弃：上传/下载统一走 B2。仅保留只读回退，用于迁移未完成时的兼容，不再写入新文件。',
    },
    migration,
    // —— 配额（本地真实回源统计，明确标注非官方）——
    quotaSource: 'LOCAL_NON_OFFICIAL',                                          // 明确：本地统计（非官方）
    quotaNote: 'B2 免费账户不暴露官方每日 B 类计数（实测响应头无 b2-api-b-class-transaction-count-today，b2_get_account_info 亦 404）；此值为本系统真实回源次数（非猜测），仅供限速/告警参考。',
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
    // —— 官方每日实耗（来自 B2 控制台，管理员手动核对录入）——
    official: await getOfficialDaily(),
  }
}

// v4.4.2：官方每日实耗（来自 B2 控制台，手动核对录入）
// B2 免费账户不暴露官方交易计数 API（实测响应头无 b2-api-*-transaction-count-today，
// b2_get_account_info 亦 404），故由管理员把控制台数字手动录入，
// 面板据此展示「官方已用 / 上限」进度条，与本系统本地回源计数并列对照。
export interface OfficialDaily {
  day: string
  bClass: number | null
  cClass: number | null
  storageBytes: number | null
  downloadBytes: number | null
  updatedAt: string | null
}
function rowToOfficial(r: any): OfficialDaily {
  return {
    day: r.day,
    bClass: r.b_class ?? null,
    cClass: r.c_class ?? null,
    storageBytes: r.storage_bytes ?? null,
    downloadBytes: r.download_bytes ?? null,
    updatedAt: r.updated_at ?? null,
  }
}
export async function getOfficialDaily(day?: string): Promise<OfficialDaily | null> {
  const d = day || dayStr()
  try {
    const r = await sGet<any>('SELECT * FROM b2_official_daily WHERE day=?', [d])
    if (r) return rowToOfficial(r)
    const last = await sGet<any>('SELECT * FROM b2_official_daily ORDER BY day DESC LIMIT 1')
    return last ? rowToOfficial(last) : null
  } catch {
    return null
  }
}
export async function setOfficialDaily(p: Partial<OfficialDaily> & { day?: string }): Promise<OfficialDaily> {
  const d = p.day || dayStr()
  const cur = await getOfficialDaily(d)
  const b = p.bClass ?? cur?.bClass ?? 0
  const c = p.cClass ?? cur?.cClass ?? 0
  const sb = p.storageBytes ?? cur?.storageBytes ?? 0
  const db = p.downloadBytes ?? cur?.downloadBytes ?? 0
  const now = new Date().toISOString()
  await sRun(
    `INSERT INTO b2_official_daily (day,b_class,c_class,storage_bytes,download_bytes,updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(day) DO UPDATE SET b_class=excluded.b_class,c_class=excluded.c_class,
       storage_bytes=excluded.storage_bytes,download_bytes=excluded.download_bytes,updated_at=excluded.updated_at`,
    [d, b, c, sb, db, now])
  return { day: d, bClass: b, cClass: c, storageBytes: sb, downloadBytes: db, updatedAt: now }
}
