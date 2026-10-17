// JWT 双实现互兼容测试：旧(jsonwebtoken) ↔ 新(shared/jwt-crypto)
import jwt from 'jsonwebtoken'
import { signJwt, verifyJwt, parseExpiresIn } from '../shared/jwt-crypto.ts'

const SECRET = 'b537718c3056bde0b547ed7b727d2b4ada4609f698fdd5cb7d1da657196e6507'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name) } }

// ① expiresIn 解析与 jsonwebtoken 的 ms() 对齐
ok("parseExpiresIn('7d')=604800", parseExpiresIn('7d') === 604800)
ok("parseExpiresIn('24h')=86400", parseExpiresIn('24h') === 86400)
ok("parseExpiresIn('90')=90", parseExpiresIn('90') === 90)

// ② 旧实现签发 → 新实现验签（存量 token 兼容）
const oldTok = jwt.sign({ id: 42, role: 'TEACHER' }, SECRET, { expiresIn: '7d' })
const p1 = await verifyJwt(oldTok, SECRET)
ok('旧 token 新验签通过', p1.id === 42 && p1.role === 'TEACHER')
ok('旧 token iat/exp 存在', typeof p1.iat === 'number' && typeof p1.exp === 'number')

// ③ 新实现签发 → 旧实现验签（反向兼容，防双后端混用）
const newTok = await signJwt({ id: 7, role: 'STUDENT' }, SECRET, '7d')
const p2 = jwt.verify(newTok, SECRET)
ok('新 token 旧验签通过', p2.id === 7 && p2.role === 'STUDENT')

// ④ 新实现自签自验
const p3 = await verifyJwt(newTok, SECRET)
ok('新 token 新验签通过', p3.id === 7 && p3.exp > Math.floor(Date.now()/1000))

// ⑤ 过期 token 必须拒（两端都拒）
const expired = jwt.sign({ id: 1, role: 'X' }, SECRET, { expiresIn: '-10s' })
let threw = false
try { await verifyJwt(expired, SECRET) } catch { threw = true }
ok('过期 token 新验签拒绝', threw)
threw = false
try { jwt.verify(expired, SECRET) } catch { threw = true }
ok('过期 token 旧验签拒绝（对照）', threw)

// ⑥ 篡改 payload 必须拒（改 role 提权是最典型的攻击）
const parts = newTok.split('.')
const tamperedPayload = Buffer.from(JSON.stringify({ id: 7, role: 'SUPER_ADMIN', iat: p3.iat, exp: p3.exp })).toString('base64url')
const tampered = parts[0] + '.' + tamperedPayload + '.' + parts[2]
threw = false
try { await verifyJwt(tampered, SECRET) } catch { threw = true }
ok('篡改 role 提权被拒', threw)

// ⑦ 错误 secret 必须拒
threw = false
try { await verifyJwt(newTok, 'wrong-secret') } catch { threw = true }
ok('错误 secret 拒绝', threw)

// ⑧ 结构损坏必须拒（不抛未捕获异常）
for (const bad of ['', 'a.b', 'a.b.c.d', '...', newTok.slice(0, -5)]) {
  try { await verifyJwt(bad, SECRET); fail++; console.log('  ❌ 坏 token 未拒绝:', JSON.stringify(bad)) }
  catch { pass++ }
}
console.log('  ✅ 4 个结构损坏 token 全部拒绝')

// ⑨ 特殊字符 payload（中文名等）编解码不丢
const uniTok = await signJwt({ id: 99, role: '教师·A' }, SECRET, '7d')
const p9 = await verifyJwt(uniTok, SECRET)
ok('中文 payload 往返一致', p9.role === '教师·A')

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail > 0 ? 1 : 0)
