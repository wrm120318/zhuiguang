import axios from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'

// ==============================================================================
// 🚩【云端部署用】动态API BaseURL - 零代码修改适配3种环境：
//   1. 本地开发(dev)          : baseURL='' → 走 vite.config.ts proxy → localhost:3001 (原逻辑不变)
//   2. 沙箱隧道版(prod直连)   : 未配置VITE_API_BASE_URL → baseURL='' → 同源Worker转发
//   3. 云端分离部署(推荐)     : 在 Cloudflare Pages 构建时注入 VITE_API_BASE_URL=https://xxx.replit.app
//                              → 直接调用 Replit 后端公网地址，彻底告别隧道！
// 构建时注入示例(Cloudflare Pages环境变量):   VITE_API_BASE_URL=https://你的repl名.replit.app
// ==============================================================================
// 【v4.4.9 防御】VITE_API_BASE_URL 尾部若混入换行/空白，会导致 baseURL 含控制字符；
// 浏览器 fetch 虽会部分规范化，但统一 trim+去空白最稳妥，且与 helpers.ts 的 API_BASE 保持一致。
const PROD_API_BASE = String(import.meta.env.VITE_API_BASE_URL ?? 'https://api.xkzg.dpdns.org').trim().replace(/\s+/g, '')
const http = axios.create({
  baseURL: PROD_API_BASE,
  timeout: 30000,
  // 云端跨域带Cookie(如果后端加了鉴权Cookie也能用)
  withCredentials: !!PROD_API_BASE,
})

http.interceptors.request.use(config => {
  const token = localStorage.getItem('zg_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  // 【v4.4.7 BUG #2 真修】过滤 data 中所有 undefined 字段（避免 axios 序列化为非标准 JSON：
  //   JSON.stringify({a:1, b:undefined}) === '{"a":1}' —— 但某些 axios 版本会原样发送
  //   'b:undefined'，后端 c.req.json() 解析失败 → 500 "Unexpected token 'u' ..."。
  //   稳妥起见：递归 strip undefined/null 字段。
  if (config.data && typeof config.data === 'object' && !(config.data instanceof FormData) && !(config.data instanceof Blob) && !(config.data instanceof ArrayBuffer)) {
    config.data = stripUndefined(config.data)
  }
  if (config.params && typeof config.params === 'object') {
    config.params = stripUndefined(config.params)
  }
  return config
})

/** 递归剔除 undefined / 空字符串（仅对 params，避免空字符串 key），保留 null（null 是合法 JSON） */
function stripUndefined(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripUndefined)
  if (obj && typeof obj === 'object' && !(obj instanceof Date) && !(obj instanceof File)) {
    const out: any = {}
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (v === undefined) continue
      out[k] = stripUndefined(v)
    }
    return out
  }
  return obj
}

http.interceptors.response.use(
  res => res.data,
  err => {
    const msg = err.response?.data?.message || err.message || '请求失败'
    if (err.response?.status === 401) {
      localStorage.removeItem('zg_token')
      localStorage.removeItem('zg_user')
      if (!location.pathname.startsWith('/login')) router.push('/login')
    } else if (err.response?.status === 403) {
      // 403 权限错误：完全静默处理，不弹窗、不reject，避免学生正常浏览时弹出权限弹窗
      console.warn('[403 权限拒绝]', msg)
      // 返回空数据而非reject，防止组件catch块弹出错误提示
      return Promise.resolve(err.response?.data || { data: [], message: '权限不足' })
    } else {
      ElMessage.error(msg)
    }
    return Promise.reject(err)
  }
)

export default http
