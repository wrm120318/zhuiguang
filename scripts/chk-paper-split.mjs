// paper-split.ts 自检（临时探针）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as esbuild from 'esbuild'
import { pathToFileURL } from 'node:url'

mkdirSync('scripts/.tmp', { recursive: true })
const src = readFileSync('src/utils/paper-split.ts', 'utf8')
const out = esbuild.transformSync(src, { loader: 'ts', format: 'esm', target: 'es2020', treeShaking: false })
writeFileSync('scripts/.tmp/paper-split.mjs', out.code)
const m = await import(pathToFileURL(process.cwd() + '/scripts/.tmp/paper-split.mjs').href)

let pass = 0, fail = 0
for (const [input, expect] of m.HEAD_CASES) {
  const got = m.isMinorHead(input)
  if (got === expect) pass++
  else { fail++; console.log(`  ✗ ${JSON.stringify(input)} 期望=${expect} 实得=${got}`) }
}
console.log(`HEAD_CASES: 通过 ${pass} · 失败 ${fail}`)

const table = `<table><tr><td>题号</td><td>1</td><td>2</td><td>3</td></tr><tr><td>答案</td><td>B</td><td>C</td><td>A</td></tr></table>`
const card = m.parseAnswerCard(table)
console.log('答题卡解析 ok=', card.ok, JSON.stringify([...card.map]))

const tail = `1．B
2．C
6．D    7．A
【详解】A.彼特拉克…错误。`
const t = m.parseTailAnswerText(tail)
console.log('卷末答案:', JSON.stringify([...t.answers]), '详解数=', t.analyses.size)
console.log('toHalfWidth(1．B) =', JSON.stringify(m.toHalfWidth('1．B')))
console.log('stripHeadNumber(1．他是先驱) =', JSON.stringify(m.stripHeadNumber('1．他是先驱')))
