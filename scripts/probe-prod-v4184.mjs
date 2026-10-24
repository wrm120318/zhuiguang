// 【v4.18.4 生产综合验证】用户 4 项报障修复实测
//   A. /file/* 同域代理：md 资料下载不再变成空 htm
//   B. 知识点无限层级：三级创建 / 防环 / 深层移动 / 递归聚合筛选
//   C. 智能题库选项渲染：KaTeX 渲染（非裸 LaTeX 源码泄漏）
//   D. 图片后「数字*数字」残留：页面零泄漏
// 运行：node scripts/probe-prod-v4184.mjs
import { chromium } from 'playwright-core'

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const BASE = 'https://xkzg.de5.net'
const API = BASE + '/api'
const MD_RESOURCE_ID = 25 // Code_20261024125158.md（生产已有 md 资料）
const SUBJECT_MATH = 2

let pass = 0, fail = 0
const ok = (label, cond, extra = '') => {
  cond ? (pass++, console.log(`  ✓ ${label}${extra}`))
        : (fail++, console.log(`  ✗ ${label}${extra}`))
}

// ---------- 登录拿 JWT ----------
const loginResp = await fetch(API + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123456' }),
})
const loginJson = await loginResp.json()
const TOKEN = loginJson.token
ok('登录成功拿到 JWT', !!TOKEN, TOKEN ? '' : ` ${JSON.stringify(loginJson).slice(0, 120)}`)
if (!TOKEN) process.exit(1)

const api = (path, opts = {}) => fetch(API + path, {
  ...opts,
  headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))

// ============================================================
console.log('\n===== A. /file/* 同域代理：md 资料下载恢复 =====')
// ============================================================
const dlResp = await fetch(`${BASE}/file/r/${MD_RESOURCE_ID}?token=${TOKEN}`, { redirect: 'manual' })
const dlCt = dlResp.headers.get('content-type') || ''
const dlBody = await dlResp.text()
ok('同域 /file/r/:id 返回 200', dlResp.status === 200, ` status=${dlResp.status}`)
ok('Content-Type 是 text/markdown（不再是 text/html 的 SPA 壳）',
  /markdown|text\/plain/i.test(dlCt), ` ct=${dlCt}`)
ok('下载内容非空且是 md 正文', dlBody.length > 50 && !dlBody.includes('<div id="app">'), ` ${dlBody.length} 字节`)
ok('Content-Disposition 带附件文件名', (dlResp.headers.get('content-disposition') || '').includes('attachment'))

// 复刻前端「fetch → blob → a.download」存盘链路（用户报障的确切路径）
const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
const inputs = await page.$$('input')
await inputs[0].fill('admin'); await inputs[1].fill('admin123456')
await page.click('button[type="submit"], .el-button--primary')
await page.waitForTimeout(3000)

const dlSave = await page.evaluate(async (rid) => {
  const r = await fetch(`/file/r/${rid}?token=${localStorage.getItem('zg_token') || ''}`)
  const blob = await r.blob()
  // 只验证 blob 的类型与内容（等价于存盘结果：Chrome 按 blob.type 补扩展名）
  return { ct: blob.type, size: blob.size, head: (await blob.slice(0, 60).text()) }
}, MD_RESOURCE_ID)
ok('前端 fetch+blob 链路拿到的类型是 markdown（Chrome 存盘不会补 .htm）',
  /markdown|plain/i.test(dlSave.ct), ` blob.type=${dlSave.ct}`)
ok('blob 大小 > 0 且开头是 md 内容', dlSave.size > 50 && !dlSave.head.includes('<div id="app">'),
  ` size=${dlSave.size} head=${JSON.stringify(dlSave.head.slice(0, 40))}`)

// ============================================================
console.log('\n===== B. 知识点无限层级（后端 API 全链） =====')
// ============================================================
const stamp = Date.now().toString().slice(-6)
const nA = `v4探针甲${stamp}`, nB = `v4探针乙${stamp}`, nC = `v4探针丙${stamp}`

const rA = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nA }) })
const idA = rA.json?.id
ok('创建一级知识点「甲」', rA.status === 200 && !!idA, ` status=${rA.status}`)

const rB = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nB, parent_id: idA }) })
const idB = rB.json?.id
ok('创建二级知识点「乙」（挂甲下）', rB.status === 200 && !!idB, ` status=${rB.status}`)

const rC = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nC, parent_id: idB }) })
const idC = rC.json?.id
ok('创建三级知识点「丙」（挂乙下）——两级封顶已解除', rC.status === 200 && !!idC,
  ` status=${rC.status} ${JSON.stringify(rC.json || {}).slice(0, 80)}`)

const kpList = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`)
const tree = kpList.json || []
const nodeC = tree.find(k => k.id === idC)
const nodeB = tree.find(k => k.id === idB)
ok('知识点列表含三级节点且父子链正确', !!nodeC && nodeC.parent_id === idB && nodeB?.parent_id === idA,
  ` 丙.parent=${nodeC?.parent_id}(期望${idB}) 乙.parent=${nodeB?.parent_id}(期望${idA})`)

// 防环：把「甲」挂到其孙子「丙」下 → 必须拒绝
const rLoop = await api(`/knowledge-points/${idA}`, { method: 'PATCH', body: JSON.stringify({ parent_id: idC }) })
ok('防环①：把「甲」移到其孙子「丙」下被拒绝', rLoop.status === 400 && /循环/.test(rLoop.json?.message || ''),
  ` status=${rLoop.status} msg=${rLoop.json?.message}`)

// 防环：把「乙」挂到其儿子「丙」下 → 同样必须拒绝（直系父子成环）
const rLoop2 = await api(`/knowledge-points/${idB}`, { method: 'PATCH', body: JSON.stringify({ parent_id: idC }) })
ok('防环②：把「乙」移到其儿子「丙」下被拒绝', rLoop2.status === 400 && /循环/.test(rLoop2.json?.message || ''),
  ` status=${rLoop2.status} msg=${rLoop2.json?.message}`)

// 合法深层移动：另建一条独立三级链 甲2→乙2→丙2，把带儿子的「乙」挂到「丙2」下
const rA2 = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nA + '2' }) })
const idA2 = rA2.json?.id
const rB2 = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nB + '2', parent_id: idA2 }) })
const idB2 = rB2.json?.id
const rC2 = await api(`/subjects/${SUBJECT_MATH}/knowledge-points`, { method: 'POST', body: JSON.stringify({ name: nC + '2', parent_id: idB2 }) })
const idC2 = rC2.json?.id
ok('独立三级链 甲2→乙2→丙2 创建成功', !!idA2 && !!idB2 && !!idC2)

const rDeep = await api(`/knowledge-points/${idB}`, { method: 'PATCH', body: JSON.stringify({ parent_id: idC2 }) })
ok('深层移动：带儿子的「乙」可挂到「丙2」下（曾因「有子节点禁设下级」被拒）', rDeep.status === 200,
  ` status=${rDeep.status} ${JSON.stringify(rDeep.json || {}).slice(0, 60)}`)
const rBack = await api(`/knowledge-points/${idB}`, { method: 'PATCH', body: JSON.stringify({ parent_id: idA }) })
ok('移回：「乙」恢复挂「甲」下', rBack.status === 200, ` status=${rBack.status}`)

// 递归聚合筛选：把 math 的 #71 临时挂到三级节点「丙」下，按「甲」筛选应命中
const origKp = await api(`/subject-questions/71`).then(r => (r.json?.knowledge_points || []).map(k => k.id))
await api(`/subject-questions/71`, { method: 'PATCH', body: JSON.stringify({ knowledge_point_ids: [...origKp, idC] }) })
const qFilter = await api(`/subjects/${SUBJECT_MATH}/questions?knowledge_point_id=${idA}`)
const qIds = (qFilter.json || []).map(q => q.id)
ok('递归聚合筛选：按一级「甲」能筛出挂在三级「丙」下的题 #71', qIds.includes(71),
  ` 命中题数=${qIds.length} 含#71=${qIds.includes(71)}`)

// 还原 #71 的原始知识点挂载
await api(`/subject-questions/71`, { method: 'PATCH', body: JSON.stringify({ knowledge_point_ids: origKp }) })

// 清理：从叶子往上删（顺便验证「有子节点禁删」语义）
const dC2 = await api(`/knowledge-points/${idC2}`, { method: 'DELETE' })
ok('删除叶子「丙2」', dC2.status === 200, ` status=${dC2.status}`)
const dB2 = await api(`/knowledge-points/${idB2}`, { method: 'DELETE' })
ok('删除「乙2」', dB2.status === 200, ` status=${dB2.status}`)
const dA2 = await api(`/knowledge-points/${idA2}`, { method: 'DELETE' })
ok('删除「甲2」', dA2.status === 200, ` status=${dA2.status}`)
const dC = await api(`/knowledge-points/${idC}`, { method: 'DELETE' })
ok('删除叶子「丙」', dC.status === 200, ` status=${dC.status}`)
const dB = await api(`/knowledge-points/${idB}`, { method: 'DELETE' })
ok('删除「乙」', dB.status === 200, ` status=${dB.status}`)
const dA = await api(`/knowledge-points/${idA}`, { method: 'DELETE' })
ok('删除「甲」', dA.status === 200, ` status=${dA.status}`)

// ============================================================
console.log('\n===== C/D. 题库页面：选项渲染 + 图片尺寸残留 =====')
// ============================================================
await page.goto(`${BASE}/subject/math/bank`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

const pageCheck = await page.evaluate(() => {
  const bodyText = document.body.innerText
  const cards = Array.from(document.querySelectorAll('.q-card'))
  let optKatex = 0, optTotal = 0, bareLatexOpt = 0, imgs = 0, brokenImgs = 0
  const brokenSrc = []
  for (const c of cards) {
    for (const o of c.querySelectorAll('.q-opt')) {
      optTotal++
      if (o.querySelector('.katex')) optKatex++
      if (/\\[a-zA-Z]+/.test(o.textContent || '')) bareLatexOpt++
    }
    for (const im of c.querySelectorAll('img')) {
      imgs++
      if (!im.naturalWidth) { brokenImgs++; brokenSrc.push(im.getAttribute('src')) }
    }
  }
  return {
    bodyHasSizeLeak: /\)\s*=\s*\d{2,5}\s*[x×]\s*\d{2,5}/.test(bodyText),
    cardCount: cards.length, optTotal, optKatex, bareLatexOpt, imgs, brokenImgs, brokenSrc,
  }
})
ok('页面无「) =数字x数字」尺寸泄漏文本', !pageCheck.bodyHasSizeLeak)
ok(`题库卡片渲染（${pageCheck.cardCount} 张）`, pageCheck.cardCount > 0)
if (pageCheck.optTotal > 0) {
  ok(`选择题选项全部 KaTeX 渲染（${pageCheck.optKatex}/${pageCheck.optTotal}）`, pageCheck.optKatex === pageCheck.optTotal)
  ok('选项无裸 LaTeX 源码泄漏', pageCheck.bareLatexOpt === 0, ` 裸源码选项数=${pageCheck.bareLatexOpt}`)
} else {
  console.log('  （列表页未展示选项区块，转详情抽屉验证）')
}
if (pageCheck.imgs > 0) ok(`卡片图片全部加载成功（${pageCheck.imgs - pageCheck.brokenImgs}/${pageCheck.imgs}）`,
  pageCheck.brokenImgs === 0, pageCheck.brokenImgs ? ` 失败: ${pageCheck.brokenSrc.join(', ')}` : '')

// 点开第一张带选项的卡，看详情抽屉
const withOpts = await page.$('.q-card:has(.q-options)')
if (withOpts) {
  await withOpts.click()
  await page.waitForTimeout(2000)
  const dCheck = await page.evaluate(() => {
    const d = document.querySelector('.detail') || document.body
    const opts = Array.from(d.querySelectorAll('.q-opt'))
    return {
      optTotal: opts.length,
      optKatex: opts.filter(o => o.querySelector('.katex')).length,
      bareLatex: opts.filter(o => /\\[a-zA-Z]+/.test(o.textContent || '')).length,
      bodyHasSizeLeak: /\)\s*=\s*\d{2,5}\s*[x×]\s*\d{2,5}/.test(d.innerText || ''),
    }
  })
  ok(`详情抽屉选项 KaTeX 渲染（${dCheck.optKatex}/${dCheck.optTotal}）`,
    dCheck.optTotal > 0 && dCheck.optKatex === dCheck.optTotal)
  ok('详情抽屉选项无裸 LaTeX 泄漏', dCheck.bareLatex === 0)
  ok('详情抽屉无尺寸泄漏文本', !dCheck.bodyHasSizeLeak)
}

await browser.close()
console.log(`\nv4.18.4 生产综合验证：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
