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

// 本地兜底目录（绝对路径）
const LOCAL_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads')
try { fs.mkdirSync(LOCAL_DIR, { recursive: true }) } catch {}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null

// 存储是否可用（Supabase 或本地至少一个可用）
export const STORAGE_ENABLED = true

/** 判断当前是否走本地兜底模式 */
export const USE_LOCAL = !supabase

/** 本地文件目录绝对路径（供 express.static 挂载） */
export const LOCAL_UPLOAD_DIR = LOCAL_DIR

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
  // 完整 URL（Supabase 公共链接）直接返回空，本地下载会失败但前端可直接用此 URL 访问
  if (/^https?:\/\//.test(filePath)) return ''
  // /uploads/key 或 uploads/key → key
  return filePath.replace(/^\/?uploads?\//, '')
}

/**
 * 下载文件（仅本地模式需要：从磁盘读取 buffer）
 * Supabase 模式的下载走的是前端直链公共 URL，不会进这里
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
  // Supabase 模式（理论上不会走到这里，因为前端用公共 URL 直接下载）
  const { data, error } = await supabase.storage.from(BUCKET).download(key)
  if (error || !data) return null
  const buffer = Buffer.from(await data.arrayBuffer())
  return { buffer, contentType: (data as any).type }
}
