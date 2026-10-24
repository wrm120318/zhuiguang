// 【v4.18.3 生产验证】线上考试功能 + 相邻公式渲染修复
// 运行：node scripts/probe-prod-exam.mjs
import { chromium } from 'playwright-core'

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const BASE = 'https://xkzg.de5.net'
let pass = 0, fail = 0
const ok = (label, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${label}${extra}`)) : (fail++, console.log(`  ✗ ${label}${extra}`)) }

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const consoleErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120)) })
page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 120)))

console.log('== 登录（admin）==')
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
const inputs = await page.$$('input')
await inputs[0].fill('admin')
await inputs[1].fill('admin123456')
await page.click('button[type="submit"], .el-button--primary')
await page.waitForTimeout(3500)
ok('登录成功（离开登录页）', !page.url().includes('/login'), page.url())

console.log('== 考试页 quiz/7：相邻公式渲染（v4.18.3 核心修复）==')
await page.goto(BASE + '/quiz/7', { waitUntil: 'networkidle' })
await page.waitForTimeout(3000)
const takeKatex = await page.$$eval('.katex', els => els.length)
ok('考试页渲染出 KaTeX', takeKatex > 0, `（.katex × ${takeKatex}）`)
const rawDollar = await page.evaluate(() => {
  const body = document.body.innerText
  return (body.match(/\$[^$\n]+\$/g) || []).filter(s => /boldsymbol|underline|quad/.test(s)).length
})
ok('无裸露 LaTeX 源码（$boldsymbol$ 等）', rawDollar === 0, `（残留 ${rawDollar} 处）`)

console.log('== 考试页新 UI：倒计时 / 答题卡 / 存疑 ==')
const cdBar = await page.$('.cd-bar')
ok('倒计时条显示（duration=50）', !!cdBar)
const cdText = cdBar ? await cdBar.innerText() : ''
ok('倒计时格式 mm:ss 且合理', /\d{2}:\d{2}/.test(cdText) && !/NaN/.test(cdText), `（${cdText.replace(/\n/g, ' ')}）`)
// 答题卡
const cardBtn = await page.$('text=答题卡')
ok('答题卡按钮存在', !!cardBtn)
if (cardBtn) {
  await cardBtn.click()
  await page.waitForTimeout(600)
  const cells = await page.$$('.ac-cell')
  ok('答题卡题号网格 = 题目数（6）', cells.length === 6, `（${cells.length} 个）`)
  const dots = await page.$$('.ac-dot')
  ok('答题卡图例（已答/未答/存疑）', dots.length === 3, `（${dots.length}）`)
  await page.keyboard.press('Escape')
}
// 存疑按钮
const flagBtn = await page.$('.q-flag')
ok('存疑标记按钮存在', !!flagBtn)
// 主观题工具条
const toolbar = await page.$('.subj-area .toolbar')
ok('主观题 Markdown 工具条存在', !!toolbar)
// 本地草稿 key 生成（答一题后）
const firstOpt = await page.$('.q-opt')
if (firstOpt) {
  await firstOpt.click()
  await page.waitForTimeout(900)
  const draftKeys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('zg_quiz_')))
  ok('作答后生成草稿/计时 localStorage key', draftKeys.some(k => k.includes('draft')), JSON.stringify(draftKeys))
}

console.log('== 移动端 393px：考试页响应式 ==')
const mob = await browser.newPage({ viewport: { width: 393, height: 851 } })
await mob.goto(BASE + '/login', { waitUntil: 'networkidle' })
const mInputs = await mob.$$('input')
await mInputs[0].fill('admin'); await mInputs[1].fill('admin123456')
await mob.click('button[type="submit"], .el-button--primary')
await mob.waitForTimeout(3000)
await mob.goto(BASE + '/quiz/7', { waitUntil: 'networkidle' })
await mob.waitForTimeout(2500)
const overflowX = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
ok('移动端无横向溢出', overflowX <= 1, `（溢出 ${overflowX}px）`)
const mobCd = await mob.$('.cd-bar')
ok('移动端倒计时条可见', !!mobCd)
const submitBar = await mob.$('.submit-bar')
ok('提交吸底栏可见', !!submitBar)
await mob.screenshot({ path: '/workspace/zhuiguang/.mobile-quiz.png', fullPage: false })

console.log('== 题库页：左侧知识点栏 + 管理面板 ==')
await page.goto(BASE + '/quiz', { waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
// 找到学科题库入口（导航）
const bankHref = await page.evaluate(() => {
  const els = [...document.querySelectorAll('a, .el-menu-item, [class*=nav]')]
  const hit = els.find(e => /题库/.test(e.innerText || ''))
  return hit ? (hit.getAttribute('href') || hit.innerText.trim()) : null
})
console.log('  题库入口:', bankHref)

await browser.close()
console.log(`\n生产验证：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
