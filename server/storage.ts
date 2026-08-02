// ===== 追光 · 文件存储（Supabase Storage） =====
// 免费层：1GB 存储 + 1GB/月 出站流量，无需绑卡
// Bucket 设计：
//   zhuiguang-files  —— 资料、图片、头像等所有上传文件（公共读，方便 CDN 加速 + 前端直链显示）
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL || ''
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || ''
const BUCKET = process.env.SUPABASE_BUCKET || 'zhuiguang-files'

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : null

export const STORAGE_ENABLED = !!supabase

/**
 * 上传文件到 Supabase Storage
 * @param key 存储路径（如 avatar_1_123.png）
 * @param buffer 文件内容
 * @param contentType MIME 类型
 * @returns 公共可访问 URL；若 Supabase 未配置则返回空字符串
 */
export async function uploadFile(key: string, buffer: Buffer, contentType?: string): Promise<string> {
  if (!supabase) return ''
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, buffer, { contentType, upsert: true })
  if (error) {
    console.error('[storage] upload failed:', key, error.message)
    throw error
  }
  // 返回公共 URL（bucket 需在 Supabase 控制台设为 public）
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key)
  return data.publicUrl
}

/** 删除文件（不存在时静默忽略） */
export async function deleteFile(key: string): Promise<void> {
  if (!supabase) return
  await supabase.storage.from(BUCKET).remove([key])
}

/** 从 file_path 字段（兼容旧格式 uploads/xxx）提取存储 key */
export function extractKey(filePath: string): string {
  return filePath.replace(/^uploads?\//, '')
}

/**
 * 获取文件下载流（用于鉴权下载：后端流式转发给客户端）
 * 兼容两种返回值：旧的本地 URL 或新的完整 https URL
 */
export async function downloadFile(filePath: string): Promise<{ buffer: Buffer; contentType?: string } | null> {
  if (!supabase) return null
  const key = extractKey(filePath)
  const { data, error } = await supabase.storage.from(BUCKET).download(key)
  if (error || !data) return null
  const buffer = Buffer.from(await data.arrayBuffer())
  return { buffer, contentType: (data as any).type }
}
