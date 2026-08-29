// ===== v4.2.2 增强的 Markdown 渲染 =====
// 兼容：纯 Markdown / CommonMark / HTML 子集 / KaTeX / 用户提及 / 文本高亮 / 视频嵌入 / B站 / PDF / file://附件
// 所有 marked-extensions 中的扩展已默认启用

import { renderExtendedMarkdown, ensureKatexCss, extractMentions } from './marked-extensions'

// 加载 KaTeX CSS（确保公式样式生效）
if (typeof window !== 'undefined') {
  ensureKatexCss()
}

/**
 * 将 Markdown 文本渲染为 HTML。
 * - 兼容 CommonMark / GFM / HTML 子集
 * - 支持 KaTeX 公式、@提及、==高亮==、视频、PDF、B站、file://附件
 * - 渲染后自动 XSS 过滤（保留白名单 HTML）
 */
export function renderMarkdown(src: string): string {
  return renderExtendedMarkdown(src, true)
}

/**
 * 不做 XSS 过滤的版本（用于受信内容，如后台预览）
 */
export function renderMarkdownRaw(src: string): string {
  return renderExtendedMarkdown(src, false)
}

/**
 * 保留换行的简单版本（用于公告栏、页脚等短文本）
 */
export function renderMarkdownPreserveSpaces(src: string): string {
  if (!src) return ''
  // 直接替换换行符为 <br>，保留所有行（包括空行）
  const result = src
    .replace(/\r\n/g, '<br>')
    .replace(/\n/g, '<br>')
    .replace(/\r/g, '<br>')
  // XSS 过滤
  return result
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

/** 截取 markdown 纯文本摘要 */
export function mdExcerpt(src: string, len = 120): string {
  if (!src) return ''
  const text = (src as string).replace(/<[^>]+>/g, '').replace(/[#*`>\-!\[\]()]/g, '').replace(/\s+/g, ' ').trim()
  return text.length > len ? text.slice(0, len) + '…' : text
}

// 重新导出
export { ensureKatexCss, extractMentions }
