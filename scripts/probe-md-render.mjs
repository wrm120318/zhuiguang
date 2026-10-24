// 【v4.18.2】Markdown 渲染修复探针
// 背景：用户报 `$\boldsymbol{\underline{\quad\quad}}$ 的markdown格式没有被渲染`。
// 根因：7 处选项/题干用 `{{ }}` 裸插值（不过 md），另有多处「先 slice 再
//   renderMarkdown」会把公式从中间截断导致 KaTeX 渲染失败。
// 本探针通过 vite SSR 直接加载前端 markdown 工具链验证：
//   ① renderMarkdown 对 LaTeX 公式产出完整 katex 结构（渲染链本身没问题）
//   ② mdExcerpt 公式整体降级为（公式）占位，不泄漏 $ 源码、不截断
//   ③ mdExcerpt 图片降级（图）、HTML 标签清除、长度截断正常
//   ④ 静态扫描：全站无「选项/题干裸插值」「renderMarkdown(...slice...))」残留
import { createServer } from 'vite'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/workspace/zhuiguang'
let pass = 0, fail = 0
const ok = (label, cond) => { cond ? (pass++, console.log(`  ✓ ${label}`)) : (fail++, console.log(`  ✗ ${label}`)) }

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const md = await server.ssrLoadModule('/src/utils/markdown.ts')
const ext = await server.ssrLoadModule('/src/utils/marked-extensions.ts')

console.log('== ① renderMarkdown 公式渲染链 ==')
const formula = String.raw`$\boldsymbol{\underline{\quad\quad}}$`
const rendered = md.renderMarkdown(formula)
ok('renderMarkdown 产出 katex 结构', rendered.includes('class="katex"'))
ok('renderMarkdown 无源码残留（无 $ 泄漏）', !rendered.includes('\\boldsymbol'))
ok('renderExtendedMarkdown(sanitize=true) 同样完整', ext.renderExtendedMarkdown(formula, true).includes('class="katex"'))
const mixed = `题干：求 $x^2+1$ 的值\n\n${String.raw`$$\int_0^1 x\,dx = \frac{1}{2}$$`}`
const mixedRendered = md.renderMarkdown(mixed)
ok('行内+块级公式混合渲染', (mixedRendered.match(/class="katex"/g) || []).length >= 2)

console.log('== ② mdExcerpt 公式降级 ==')
const ex1 = md.mdExcerpt(formula, 120)
ok('公式整体替换为（公式）', ex1.includes('（公式）'))
ok('摘要无 $ 源码泄漏', !ex1.includes('$') && !ex1.includes('boldsymbol'))
const longFormula = `第1题 ${'很长的题干前缀'.repeat(20)} ${formula} 结尾`
const ex2 = md.mdExcerpt(longFormula, 60)
ok('长文+公式摘要截断正常', ex2.length <= 61 && ex2.endsWith('…'))
ok('截断后仍无 $ 泄漏', !ex2.includes('$'))
const formulaAtBoundary = `题干 ${'x'.repeat(58)} ${String.raw`$\int_a^b f(x)dx$`} 后续文字`
const ex3 = md.mdExcerpt(formulaAtBoundary, 60)
ok('公式位于截断边界不破损（纯文本无从截断）', !ex3.includes('$') && ex3.length <= 61)

console.log('== ③ mdExcerpt 其他降级 ==')
const exImg = md.mdExcerpt('看图 ![图注](https://a.com/b.png) 作答', 120)
ok('图片替换为（图）', exImg.includes('（图）') && !exImg.includes('!['))
const exHtml = md.mdExcerpt('<p>题干</p><script>alert(1)</script>继续', 120)
ok('HTML 标签清除', !exHtml.includes('<p>') && !exHtml.includes('<script>'))
const exMd = md.mdExcerpt('## 标题 **加粗** `代码`', 120)
ok('Markdown 符号清除', !/[#*`]/.test(exMd))
ok('空值安全', md.mdExcerpt('', 50) === '' && md.mdExcerpt(null, 50) === '')

console.log('== ④ 静态扫描：危险模式清零 ==')
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.vue')) out.push(p)
  }
  return out
}
const files = walk(join(ROOT, 'src'))
let bareOpt = [], sliceRender = [], badVhtml = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const rel = f.replace(ROOT + '/', '')
  // 选项裸插值（v-html 同行的除外）
  for (const m of src.matchAll(/<span>\{\{\s*(opt|o|option)\s*\}\}<\/span>/g)) bareOpt.push(`${rel}`)
  // 先 slice 再渲染
  for (const m of src.matchAll(/renderMarkdown\([^)]*\.slice\(/g)) sliceRender.push(`${rel}`)
  // v-html 直接切 content
  for (const m of src.matchAll(/v-html="[^"]*content[^"]*\.slice\(/g)) badVhtml.push(`${rel}`)
}
ok('无选项裸插值残留（{{opt}}/{{o}}）', bareOpt.length === 0)
if (bareOpt.length) console.log('    残留:', bareOpt.join(', '))
ok('无「renderMarkdown(...slice...)」残留', sliceRender.length === 0)
if (sliceRender.length) console.log('    残留:', sliceRender.join(', '))
ok('无「v-html 直接 slice content」残留', badVhtml.length === 0)
if (badVhtml.length) console.log('    残留:', badVhtml.join(', '))

// 修复点文件必须 import 对应工具
const expectImports = [
  ['src/views/quiz/QuizTakeView.vue', 'renderMarkdown as renderMd'],
  ['src/views/quiz/PracticeTakeView.vue', 'renderMarkdown as md'],
  ['src/views/quiz/QuizReportView.vue', 'renderMarkdown as renderMd'],
  ['src/views/quiz/ExamManageView.vue', 'renderMarkdown'],
  ['src/views/quiz/AssembleView.vue', 'renderMarkdown, mdExcerpt'],
  ['src/views/quiz/WrongBookView.vue', 'renderMarkdown, mdExcerpt'],
  ['src/views/quiz/AnalyticsView.vue', 'mdExcerpt'],
  ['src/views/admin/AiSettingsView.vue', 'renderMarkdown'],
  ['src/components/GradingWorkbench.vue', 'renderMarkdown'],
  ['src/components/StudentReport.vue', 'renderMarkdown, mdExcerpt'],
  ['src/views/AnnouncementsView.vue', 'mdExcerpt'],
]
for (const [f, imp] of expectImports) {
  const src = readFileSync(join(ROOT, f), 'utf8')
  ok(`${f} import ${imp}`, src.includes(`import { ${imp} } from '@/utils/markdown'`))
}

await server.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
