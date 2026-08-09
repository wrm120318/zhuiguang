// ===== 追光 · 文件存储（Supabase Storage 优先，本地磁盘兜底） =====
// 生产：Supabase Storage（1GB 免费 + CDN）
// 本地开发/测试：当未配置 Supabase 时，自动回退到本地磁盘 server/uploads/
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const supabaseUrl = process.env.SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
const BUCKET = process.env.SUPABASE_BUCKET || 'zhuiguang-files'
const PROXY = process.env.HTTPS_PROXY || ''

// 本地兜底目录（绝对路径）
const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')
try { fs.mkdirSync(LOCAL_DIR, { recursive: true }) } catch {}

// 通过代理的 fetch（后端服务器需要通过 HTTP 代理访问外网）
async function proxyFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!PROXY) return fetch(url, init)
  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent')
    const agent = new (HttpsProxyAgent as any)(PROXY)
    return fetch(url as any, { ...init, agent } as any)
  } catch {
    return fetch(url, init)
  }
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      global: { fetch: proxyFetch as any }
    })
  : null

// 存储是否可用（Supabase 或本地至少一个可用）
export const STORAGE_ENABLED = true

/** 判断当前是否走本地兜底模式 */
export const USE_LOCAL = !supabase

/** 本地文件目录绝对路径（供 express.static 挂载） */
export const LOCAL_UPLOAD_DIR = LOCAL_DIR

/**
 * 生成 Supabase 签名上传 URL（前端直传用，避免大文件经过隧道）
 * 仅 Supabase 模式可用，本地模式返回 null
 */
export async function createPresignedUploadUrl(key: string): Promise<{ signedUrl: string; publicUrl: string } | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(key)
  if (error || !data?.signedUrl) {
    console.error('[storage] createSignedUploadUrl failed:', key, error?.message)
    return null
  }
  const pub = supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl
  return { signedUrl: data.signedUrl, publicUrl: pub }
}

// 通过 file_path 推断 MIME（本地模式用）
function guessContentType(key: string): string {
  const ext = path.extname(key).toLowerCase()
  const map: Record<string, string> = {
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * 上传文件
 * - Supabase 模式：上传到 Supabase Storage，返回公共 URL
 * - 本地模式：写入 LOCAL_DIR，返回形如 /uploads/key 的相对 URL（前端可通过 express.static 访问）
 */
export async function uploadFile(key: string, buffer: Buffer, contentType?: string): Promise<string> {
  // 本地兜底
  if (!supabase) {
    const filePath = path.join(LOCAL_DIR, key)
    fs.writeFileSync(filePath, buffer)
    // 返回前端可直接访问的相对路径（index.ts 会挂载 express.static('/uploads', LOCAL_DIR)）
    return `/uploads/${key}`
  }
  // Supabase
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, buffer, { contentType, upsert: true })
  if (error) {
    console.error('[storage] upload failed:', key, error.message)
    throw error
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key)
  return data.publicUrl
}

/** 删除文件（本地模式：删除磁盘文件；Supabase 模式：删除对象） */
export async function deleteFile(key: string): Promise<void> {
  if (!supabase) {
    const filePath = path.join(LOCAL_DIR, key)
    try { fs.unlinkSync(filePath) } catch {}
    return
  }
  await supabase.storage.from(BUCKET).remove([key])
}

/** 从 file_path 字段（兼容旧格式 uploads/xxx 与新的 /uploads/xxx、完整 https URL）提取存储 key */
export function extractKey(filePath: string): string {
  if (!filePath) return ''
  // 如果是完整的 Supabase URL，提取 object key
  // URL 格式: https://xxx.supabase.co/storage/v1/object/public/zhuiguang-files/file_xxx.xlsx
  if (/^https?:\/\//.test(filePath)) {
    const m = filePath.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)$/)
    if (m) return m[1]
    // 也可能是直接路径形式
    const parts = filePath.split('/')
    return parts[parts.length - 1] || ''
  }
  // /uploads/key 或 uploads/key → key
  return filePath.replace(/^\/?uploads?\//, '')
}

/**
 * 下载文件
 * - 本地模式：从磁盘读取 buffer
 * - Supabase 模式：通过 extractKey 提取的 key 从 Supabase Storage 下载 buffer
 *   （filePath 可能是完整公共 URL 或相对 key，extractKey 均可正确提取）
 */
export async function downloadFile(filePath: string): Promise<{ buffer: Buffer; contentType?: string } | null> {
  const key = extractKey(filePath)
  if (!key) return null
  // 本地模式
  if (!supabase) {
    const localPath = path.join(LOCAL_DIR, key)
    if (!fs.existsSync(localPath)) return null
    const buffer = fs.readFileSync(localPath)
    return { buffer, contentType: guessContentType(key) }
  }
  // Supabase 模式：通过 key 从 Storage 下载
  const { data, error } = await supabase.storage.from(BUCKET).download(key)
  if (error || !data) return null
  const buffer = Buffer.from(await data.arrayBuffer())
  return { buffer, contentType: (data as any).type }
}
