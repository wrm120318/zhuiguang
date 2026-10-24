// ===== v4.2.2 增强的 Markdown 渲染 =====
// 兼容：纯 Markdown / CommonMark / HTML 子集 / KaTeX / 用户提及 / 文本高亮 / 视频嵌入 / B站 / PDF / file://附件
// 所有 marked-extensions 中的扩展已默认启用

import { renderExtendedMarkdown, ensureKatexCss, extractMentions } from './marked-extensions'
import { signFileLinks } from './helpers'

// 加载 KaTeX CSS（确保公式样式生效）
if (typeof window !== 'undefined') {
  ensureKatexCss()
}

/**
 * 将 Markdown 文本渲染为 HTML。
 * - 兼容 CommonMark / GFM / HTML 子集
 * - 支持 KaTeX 公式、@提及、==高亮==、视频、PDF、B站、file://附件
 * - 渲染后自动 XSS 过滤（保留白名单 HTML）
 * - 【v4.9.2】出口自动给 `/api/file/{id}` 链接补当前用户 token，
 *   修「编辑器里上传的附件点了提示『请先登录后下载』」。
 */
export function renderMarkdown(src: string): string {
  return signFileLinks(renderExtendedMarkdown(src, true))
}

/**
 * 不做 XSS 过滤的版本（用于受信内容，如后台预览）
 * 【v4.9.2】同样补 token，保证预览里附件也能点
 */
export function renderMarkdownRaw(src: string): string {
  return signFileLinks(renderExtendedMarkdown(src, false))
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

// ===== 【v4.18.4】选择题选项的裸 LaTeX 自动包裹 =====
// 背景（用户原话：「智能题库里面选择题选项没有渲染」）：
//   Word/AI 导入与早期手录的选项常是**裸 LaTeX**——如 ` \angle BAD=\angle CAE`、
//   `\dfrac{AB}{BC}=\dfrac{AD}{DE}`——没有 `$...$` 定界符。
//   marked/KaTeX 只渲染带 `$` 的公式，于是这些选项在题库列表/详情/练习/考试
//   各处**原样显示 LaTeX 源码**，用户看到的就是「选项没有渲染」。
// 修法：渲染选项前做一次「数学味」嗅探——整段**不含中文、不含 `$`**、且含
//   LaTeX 命令（\frac \angle \triangle…）或数学符号（∠ △ ∽ √ ⊥ ∥ …）时，
//   按行内公式 `$…$` 包裹后再走 renderMarkdown。
// 安全性：含中文/已含 `$`/纯文字（如「正确」「以上都不对」）一律原样返回，
//   不会把文本硬塞进 KaTeX（那会渲染报错或丢内容）。
const OPT_MATH_CMD = /\\[a-zA-Z]+/                       // \frac \angle \triangle \backsim …
const OPT_MATH_SYM = /[∠△▽⊙⊥∥≡≌∽√∞π∏∑∫∈∉⊂⊃∪∩∀∃]/     // 常见数学符号
const OPT_HAS_CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/
export function wrapBareLatex(text: string): string {
  const t = String(text ?? '')
  if (!t.trim() || t.includes('$')) return t              // 空 / 已有公式定界符 → 不动
  if (OPT_HAS_CJK.test(t)) return t                       // 含中文 → 混合内容，不能整段入公式
  if (!OPT_MATH_CMD.test(t) && !OPT_MATH_SYM.test(t)) return t  // 纯文字选项 → 不动
  // 【v4.18.4 补丁】必须 trim：marked-extensions 的 katexInline 判定
  //   `if (/^\s|\s$/.test(inner)) return undefined`（内容首尾是空白就不认公式，
  //   防 "$ 100 $" 误判）。Word/AI 导入的选项普遍带前导空格（" \\angle BAD=..."），
  //   不 trim 会被整段判为非公式 → 源码裸奔（实测 math #71 四个选项只渲染了
  //   唯一没有前导空格的那个，1/4）。
  return `$${t.trim()}$`
}

/**
 * 截取 markdown 纯文本摘要。
 * 【v4.18.2】公式/图片整体替换为占位符（（公式）（图）），避免：
 *   ① 摘要里泄漏 `$\boldsymbol{...}$` LaTeX 源码；
 *   ② 先 slice 再渲染把公式从中间截断（KaTeX 渲染失败裸奔）——
 *      本函数只产纯文本，从根上没有「截断半个公式」的问题。
 */
export function mdExcerpt(src: string, len = 120): string {
  if (!src) return ''
  const text = (src as string)
    .replace(/<[^>]+>/g, '')                     // HTML 标签
    .replace(/\$\$[\s\S]*?\$\$/g, '（公式）')      // 块级公式
    .replace(/\$[^$\n]*\$/g, '（公式）')           // 行内公式
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '（图）')     // 图片
    .replace(/[#*`>\-!\[\]()]/g, '')
    .replace(/\s+/g, ' ').trim()
  return text.length > len ? text.slice(0, len) + '…' : text
}

// 重新导出
export { ensureKatexCss, extractMentions }
