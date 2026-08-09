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
const PROD_API_BASE = (import.meta.env.VITE_API_BASE_URL as string) || ''
const http = axios.create({
  baseURL: PROD_API_BASE,
  timeout: 30000,
  // 云端跨域带Cookie(如果后端加了鉴权Cookie也能用)
  withCredentials: !!PROD_API_BASE,
})

http.interceptors.request.use(config => {
  const token = localStorage.getItem('zg_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// ==============================================================================
// 🔄 Supabase URL → /file/ 路径自动转换（零模板改动）
// 在 API 响应拦截器中递归遍历数据，将所有 Supabase 存储 URL 转换为
// 带 token 的 /file/ 路径，前端 <img src> 等标签无需任何修改
// ==============================================================================

/** 获取当前 token（用于拼接 /file/ 鉴权 query param） */
function getToken(): string {
  return localStorage.getItem('zg_token') || ''
}

/** 将单个 URL 字符串从 Supabase 转换为 /file/ 路径 */
function transformUrl(url: string): string {
  if (!url || typeof url !== 'string') return url
  // 匹配 Supabase 存储 URL
  if (url.includes('supabase.co/storage/v1/object/')) {
    const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/(.+)$/)
    if (m) {
      return `${PROD_API_BASE}/file/${m[1]}?t=${getToken()}`
    }
  }
  return url
}

/** 递归遍历响应数据，转换所有 Supabase URL（含嵌套在 JSON/字符串中的 URL） */
function transformUrlsDeep(data: any): any {
  if (data === null || data === undefined) return data
  if (typeof data === 'string') {
    // 如果字符串中包含 Supabase URL（如 Markdown 内容中的图片），也替换
    if (data.includes('supabase.co/storage/v1/object/')) {
      return data.replace(
        /https?:\/\/[^/]+\.supabase\.co\/storage\/v1\/object\/(?:public|sign)\/[^/]+\/([^\s"'<>)]+)/g,
        (match, key) => `${PROD_API_BASE}/file/${key}?t=${getToken()}`
      )
    }
    return data
  }
  if (Array.isArray(data)) {
    return data.map(transformUrlsDeep)
  }
  if (typeof data === 'object') {
    const result: any = Array.isArray(data) ? [] : {}
    for (const key in data) {
      // 对已知 URL 字段直接转换
      if (typeof data[key] === 'string' && (key === 'avatar' || key === 'cover' || key === 'url' || key === 'filePath' || key === 'file_path')) {
        result[key] = transformUrl(data[key])
      } else {
        result[key] = transformUrlsDeep(data[key])
      }
    }
    return result
  }
  return data
}

http.interceptors.response.use(
  res => {
    // 自动转换响应数据中的 Supabase URL 为 /file/ 路径
    if (res.data) {
      res.data = transformUrlsDeep(res.data)
    }
    return res.data
  },
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
export { transformUrl, getToken as getFileToken }
