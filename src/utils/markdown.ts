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
 *
 * @deprecated 【v4.8.25】全站已无调用方，**请勿再使用**。
 *   本函数完全不走 marked，只做 `\n` → `<br>` 替换：
 *   用户用 Markdown 写的 `**粗体**`、列表、链接、公式会被**原样输出源码**，
 *   与编辑器预览所见完全不同 —— 这是「提交后在正常界面查看就不行了」的根因之一。
 *   请统一改用 `renderMarkdown()`；它已配 `breaks: true`（单个 \n → <br>），
 *   配合 `.zg-rich` 容器的 `white-space: pre-wrap` 可完整保留空格/空行/换行。
 *   保留此导出仅为兼容可能存在的历史引用，无任何调用方时会随构建被摇树移除。
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
