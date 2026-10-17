// ============================================================================
// v4.17.0 性能专项 · Web Crypto HS256 JWT（零依赖，替代 jsonwebtoken）
// ============================================================================
//
// 【为什么换掉 jsonwebtoken】
//   生产实测：Worker bundle 3.29MB / gzip 680KB，而 workerd 冷启动要
//   **下载 + 解析 + 编译**整个包 —— 这是「同一个接口 0.7s ~ 11s 剧烈跳动」
//   的根因（D1 查询本身只要 0.16~0.29ms，慢的不是 SQL）。
//   jsonwebtoken 本身只有 ~40KB，但它拖着 jws / jwa / eccrypto / buffer
//   一整条依赖链（eccrypto 还包含 secp256k1 曲线实现，纯 JS 大整数运算），
//   对「只用 HS256」的本项目是纯粹的浪费。
//   Workers 原生提供 Web Crypto（crypto.subtle），HMAC-SHA256 签名/验签
//   是**零行数**实现，遂整条链移除。
//
// 【兼容性承诺（用户不掉登录的关键）】
//   · 算法仍是 HS256，secret 仍读同一个 JWT_SECRET —— 签名构造完全一致
//     （header {alg:'HS256',typ:'JWT'} + payload + HMAC-SHA256(base64url)）
//   · payload 形状不变：{ id, role, iat, exp }，exp 按同一 expiresIn 计算
//   · 因此**旧 token 全部继续有效**，已登录用户无需重新登录
//
// 【双端同源（铁律#11 单一事实源）】
//   worker-api.ts（CF Workers）与 server/auth.ts（Express）都 import 本模块，
//   杜绝两条路径的 token 行为漂移。两端均有全局 crypto.subtle：
//   workerd 原生提供；Node ≥ 18 提供 globalThis.crypto。
// ============================================================================

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64urlEncodeBytes(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlEncodeStr(str: string): string {
  return b64urlEncodeBytes(enc.encode(str))
}

// 返回类型显式标注 Uint8Array<ArrayBuffer>：TS 5.7+ 对 TypedArray 泛型严格化，
// 不标注的话 crypto.subtle.verify(..., sigBytes, ...) 会因 Uint8Array<ArrayBufferLike>
// 不匹配 BufferSource 而报 TS2345（运行时其实没问题，纯类型层）。
function b64urlDecodeToBytes(s: string): Uint8Array<ArrayBuffer> {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  const bin = atob(t)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 解析 jsonwebtoken 风格的 expiresIn：'7d' / '24h' / '60s' / '90'（纯秒）→ 秒数 */
export function parseExpiresIn(v: string | number): number {
  if (typeof v === 'number' && isFinite(v)) return v
  const m = /^(\d+)\s*([smhd])?$/.exec(String(v ?? '').trim())
  if (!m) return 7 * 86400
  const n = parseInt(m[1], 10)
  const unit = m[2] || 's'
  return n * (unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

/**
 * HS256 签发（与 jsonwebtoken.sign(payload, secret, { expiresIn }) 输出同构）
 * @param payload   业务 claims（如 { id, role }）；iat/exp 由本函数补齐
 * @param secret    JWT_SECRET
 * @param expiresIn '7d' / '24h' / 秒数
 */
export async function signJwt(payload: Record<string, any>, secret: string, expiresIn: string | number): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = { ...payload, iat: now, exp: now + parseExpiresIn(expiresIn) }
  const unsigned = b64urlEncodeStr(JSON.stringify(header)) + '.' + b64urlEncodeStr(JSON.stringify(body))
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(unsigned))
  return unsigned + '.' + b64urlEncodeBytes(new Uint8Array(sig))
}

/**
 * HS256 验签（与 jwt.verify(token, secret) 同语义：签名错/过期都抛错）
 * 注意：**不**校验 payload 里除 exp 以外的内容（与 jsonwebtoken 默认行为一致）。
 */
export async function verifyJwt<T = any>(token: string, secret: string): Promise<T> {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('invalid token')
  const [h, b, s] = parts
  let sigBytes: Uint8Array<ArrayBuffer>
  try { sigBytes = b64urlDecodeToBytes(s) } catch { throw new Error('invalid signature encoding') }
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sigBytes, enc.encode(h + '.' + b))
  if (!ok) throw new Error('invalid signature')
  let payload: any
  try { payload = JSON.parse(dec.decode(b64urlDecodeToBytes(b))) } catch { throw new Error('invalid payload') }
  if (typeof payload?.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired')
  }
  return payload as T
}
