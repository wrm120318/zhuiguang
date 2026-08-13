import { marked } from 'marked'

// 配置 marked：换行符转为 <br>，更符合输入习惯
marked.setOptions({
  breaks: true,
  gfm: true,
})

/**
 * 将 Markdown 文本渲染为 HTML。
 * 同时兼容旧的纯 HTML 内容（如网站说明编辑器插入的 <h2> 等标签）。
 * 对输出做基础 XSS 过滤：移除 <script> 标签。
 */
export function renderMarkdown(src: string): string {
  if (!src) return ''
  const html = marked.parse(src, { async: false }) as string
  // 移除脚本与事件处理，防止 XSS
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

/**
 * 将 Markdown 文本渲染为 HTML，保留空格和换行。
 * 用于公告栏和页脚等需要保留格式的场景。
 */
export function renderMarkdownPreserveSpaces(src: string): string {
  if (!src) return ''
  // 直接替换换行符为 <br>，保留所有行（包括空行）
  const result = src
    .replace(/\r\n/g, '<br>')  // Windows 换行
    .replace(/\n/g, '<br>')    // Mac/Linux 换行
    .replace(/\r/g, '<br>')    // 旧 Mac 换行
  // 移除脚本与事件处理，防止 XSS
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
