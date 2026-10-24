// 【v4.18.3 生产验证】用户报障原样复现路径：「智能题库添加知识点后左侧栏目不刷新」
// 运行：node scripts/probe-prod-kp-refresh.mjs
import { chromium } from 'playwright-core'

const EXE = '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'
const BASE = 'https://xkzg.de5.net'
let pass = 0, fail = 0
const ok = (label, cond, extra = '') => { cond ? (pass++, console.log(`  ✓ ${label}${extra}`)) : (fail++, console.log(`  ✗ ${label}${extra}`)) }

const browser = await chromium.launch({ executablePath: EXE, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

console.log('== 登录（admin 超管，可管理全部学科）==')
await page.goto(BASE + '/login', { waitUntil: 'networkidle' })
const inputs = await page.$$('input')
await inputs[0].fill('admin'); await inputs[1].fill('admin123456')
await page.click('button[type="submit"], .el-button--primary')
await page.waitForTimeout(3500)

// 选一个有题目、知识点的学科：语文（chinese）
const SLUG = 'chinese'
console.log(`== 进入学科题库 /subject/${SLUG}/bank ==`)
await page.goto(`${BASE}/subject/${SLUG}/bank`, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

const leftKpNames = () => page.$$eval('.kp-aside .kp-name', els => els.map(e => e.innerText.trim()))
const before = await leftKpNames()
console.log('  左侧知识点（添加前）:', JSON.stringify(before))

// 打开「管理知识点」→ 添加一个带时间戳的新知识点
console.log('== 添加知识点（复现用户操作路径）==')
const mgrBtn = await page.$('text=管理知识点')
ok('「管理知识点」按钮存在', !!mgrBtn)
if (mgrBtn) await mgrBtn.click()
await page.waitForTimeout(500)
let panelOpen = !!mgrBtn   // 点击后面板打开；后续操作不再点该按钮（避免 toggle 关闭）

const ensurePanel = async () => {
  const visible = await page.$('.kp-add input[placeholder="知识点名称"]')
  if (!visible && mgrBtn) { await mgrBtn.click(); await page.waitForTimeout(400); panelOpen = true }
}

const addKp = async (name) => {
  await ensurePanel()
  await page.fill('.kp-add input[placeholder="知识点名称"]', name)
  await page.click('.kp-add button:has-text("添加")')
  await page.waitForTimeout(2500)   // 等 loadKp(true) + loadQuestions(true) 完成
}
const delKp = async (name) => {
  const delBtn = await page.$(`.kp-item:has-text("${name}") button[title="删除"]`)
  if (!delBtn) return false
  await delBtn.click()
  // 轮询等待左侧栏移除（DELETE 响应 + loadKp(true) 回源，容忍网络波动，上限 6s）
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(500)
    if (!(await leftKpNames()).includes(name)) return true
  }
  return true   // 按钮已点、接口应已成功；是否刷新由下一个断言单独判定
}

const newName = 'v4测试节点' + Date.now().toString().slice(-6)
await addKp(newName)

const after = await leftKpNames()
console.log('  左侧知识点（添加后）:', JSON.stringify(after))
ok('左侧知识点栏立即出现新节点（不刷新Bug已修）', after.includes(newName), after.includes(newName) ? '' : ` 缺少「${newName}」`)

// 管理面板列表也应刷新
const mgrList = await page.$$eval('.kp-list .kp-item-name', els => els.map(e => e.innerText.trim()))
ok('管理面板列表同步刷新', mgrList.some(n => n.includes(newName)))

// 清理：删掉测试节点（保持生产数据干净）
const deleted = await delKp(newName)
ok('测试节点已删除', deleted)
const cleaned = await leftKpNames()
ok('删除后左侧栏同步移除', !cleaned.includes(newName))
// 验证 fresh 参数生效：接口请求带 _t
console.log('== 缓存绕过参数检查 ==')
const freshReqs = []
page.on('request', r => { if (r.url().includes('knowledge-points') && r.url().includes('_t=')) freshReqs.push(r.url().slice(0, 100)) })
const newName2 = 'v4测试节点B' + Date.now().toString().slice(-6)
await addKp(newName2)   // 面板仍开着，不再点「管理知识点」
ok('写后重拉带 _t 缓存绕过参数', freshReqs.length > 0, `（${freshReqs.length} 次）`)

await delKp(newName2)
// 收尾：关闭管理面板，恢复页面原状
if (panelOpen && mgrBtn) { await mgrBtn.click(); await page.waitForTimeout(300) }

await browser.close()
console.log(`\n生产KP刷新验证：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
