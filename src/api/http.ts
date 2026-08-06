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

http.interceptors.response.use(
  res => res.data,
  err => {
    const msg = err.response?.data?.message || err.message || '请求失败'
    if (err.response?.status === 401) {
      localStorage.removeItem('zg_token')
      localStorage.removeItem('zg_user')
      if (!location.pathname.startsWith('/login')) router.push('/login')
    } else {
      ElMessage.error(msg)
    }
    return Promise.reject(err)
  }
)

export default http
