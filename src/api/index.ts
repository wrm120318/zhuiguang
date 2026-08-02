import http from './http'
import axios from 'axios'

export const api = {
  // 认证
  login: (data: { username: string; password: string }) => http.post('/api/auth/login', data),
  register: (data: any) => http.post('/api/auth/register', data),
  me: () => http.get('/api/auth/me'),
  // 用户
  users: () => http.get('/api/users'),
  createUser: (data: any) => http.post('/api/users', data),
  toggleUser: (id: number, status: string) => http.patch(`/api/users/${id}/status`, { status }),
  resetUser: (id: number) => http.post(`/api/users/${id}/reset`),
  deleteUser: (id: number) => http.delete(`/api/users/${id}`),
  adjustUserExp: (id: number, data: { exp?: number; level?: number }) => http.patch(`/api/users/${id}/exp`, data),
  grantExp: (data: { userId: number; change: number; actionType: string; description: string }) => http.post('/api/exp/logs', data),
  updateProfile: (data: any) => http.patch('/api/profile', data),
  uploadAvatar: (file: File) => { const fd = new FormData(); fd.append('file', file); return http.post('/api/upload/avatar', fd) },
  // 班级 & 学科
  classes: () => http.get('/api/classes'),
  createClass: (data: any) => http.post('/api/classes', data),
  updateClass: (id: number, data: any) => http.patch(`/api/classes/${id}`, data),
  deleteClass: (id: number) => http.delete(`/api/classes/${id}`),
  subjects: () => http.get('/api/subjects'),
  subject: (slug: string) => http.get(`/api/subjects/${slug}`),
  createSubject: (data: any) => http.post('/api/subjects', data),
  updateSubject: (id: number, data: any) => http.patch(`/api/subjects/${id}`, data),
  deleteSubject: (id: number) => http.delete(`/api/subjects/${id}`),
  myClasses: () => http.get('/api/me/classes'),
  // 美文
  articles: (params: any) => http.get('/api/articles', { params }),
  article: (id: number) => http.get(`/api/articles/${id}`),
  createArticle: (data: any) => http.post('/api/articles', data),
  auditArticle: (id: number, status: string) => http.patch(`/api/articles/${id}/status`, { status }),
  deleteArticle: (id: number) => http.delete(`/api/articles/${id}`),
  likeArticle: (id: number) => http.post(`/api/articles/${id}/like`),
  // 资料
  resources: (params: any) => http.get('/api/resources', { params }),
  createResource: (data: any) => http.post('/api/resources', data),
  auditResource: (id: number, status: string) => http.patch(`/api/resources/${id}/status`, { status }),
  deleteResource: (id: number) => http.delete(`/api/resources/${id}`),
  downloadResource: (id: number) => {
    const http2 = axios.create({ baseURL: '', timeout: 60000, responseType: 'blob' })
    const token = localStorage.getItem('zg_token')
    if (token) http2.defaults.headers.common.Authorization = `Bearer ${token}`
    return http2.post(`/api/resources/${id}/download`)
  },
  likeResource: (id: number) => http.post(`/api/resources/${id}/like`),
  uploadFile: (file: File) => { const fd = new FormData(); fd.append('file', file); return http.post('/api/upload/file', fd) },
  uploadImage: (file: File) => { const fd = new FormData(); fd.append('file', file); return http.post('/api/upload/image', fd) },
  // 查询
  queryTasks: () => http.get('/api/query/tasks'),
  queryTask: (id: number) => http.get(`/api/query/tasks/${id}`),
  doQuery: (id: number) => http.post(`/api/query/tasks/${id}/query`),
  createQueryTask: (data: any) => http.post('/api/query/tasks', data),
  deleteQueryTask: (id: number) => http.delete(`/api/query/tasks/${id}`),
  // 经验 & 排行
  expLogs: (userId?: number) => http.get('/api/exp/logs', { params: { userId } }),
  leaderboard: (params: any) => http.get('/api/leaderboard', { params }),
  // 通知
  notices: () => http.get('/api/notices'),
  readNotice: (id: number) => http.post(`/api/notices/${id}/read`),
  readAllNotices: () => http.post('/api/notices/readAll'),
  // 主题
  themes: () => http.get('/api/themes'),
  activeTheme: () => http.get('/api/themes/active'),
  setActiveTheme: (id: number) => http.patch(`/api/themes/${id}/active`),
  updateTheme: (id: number, data: any) => http.put(`/api/themes/${id}`, data),
  createTheme: (data: any) => http.post('/api/themes', data),
  deleteTheme: (id: number) => http.delete(`/api/themes/${id}`),
  // 统计
  stats: () => http.get('/api/stats'),
  // 搜索
  search: (q: string) => http.get('/api/search', { params: { q } }),
  // 收藏
  favorites: () => http.get('/api/favorites'),
  toggleFavorite: (type: string, id: number) => http.post(`/api/favorites/${type}/${id}`),
  // 群发通知
  broadcastNotice: (data: { title: string; content: string; type?: string }) => http.post('/api/notices/broadcast', data),
}
