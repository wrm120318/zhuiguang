// ===== 【v4.14.0】Word 导入题干内容收敛工具 =====
//
// 【为什么需要这个文件（铁律#11：同一件事只允许一份实现）】
//   Word 导入有**两个入口**，两处都要把「原卷 HTML 题干」收敛成全站统一的
//   Markdown 格式后再交给右侧编辑器 / 入库：
//     · `WordPaperSplitEditor.vue`（原卷分栏编辑）
//     · `WordImportPanel.vue`（快速导入）
//   以前两处各自把题干 HTML 直接塞进 content，问题有二：
//     ① 右侧 `QuestionForm` → `MarkdownEditor` 的**编辑区是 textarea**，
//        只认 Markdown 源码；直接塞 HTML 时用户看到的是
//        `<img src="data:image/...">` 一串源码文本，**图片不显示**
//        （用户反馈的「右边编辑框里没有图」）。
//     ② 全站标准入库格式是 Markdown（粘贴入口也经 `htmlToMarkdown` 收敛），
//        这里直接存 HTML 属于格式不一致，污染下游渲染 / 导出。
//
//   故抽成独立模块，两个入口共用，杜绝再次漂移。
//
// 【图片会丢吗？不会】
//   `htmlToMarkdown` 会把 `<img>` 转成 `![alt](src)`：
//     · `src` 是真实 URL 或 `data:image/...;base64` → **原样保留**（见 html-to-md.ts 注释）
//     · 仅「本地磁盘路径（file:/// / C:\\...）」会被丢弃（浏览器本就读不到）
//   mammoth 已在解析阶段把大图上传成 URL、小图内联 base64，两类都能保住。

import { htmlToMarkdown, looksLikeHtml } from '@/utils/html-to-md'

/**
 * 把题干内容收敛成全站标准的 Markdown。
 *
 * · 已经是 Markdown（不含块级 HTML 标签）→ 原样返回，**不做二次转换**
 *   （二次转换可能损伤 LaTeX / 表格等结构）。
 * · 是 HTML → 走 `htmlToMarkdown`；转换失败（返回空）则退回原文，宁可粗糙也不丢内容。
 *
 * @param s 题干内容（HTML 或 Markdown）
 * @returns 收敛后的 Markdown
 */
export function toMarkdownContent(s: string): string {
  if (!s) return ''
  if (!looksLikeHtml(s)) return s
  return htmlToMarkdown(s) || s
}
