import http from './http'
import axios from 'axios'
import { ElMessage } from 'element-plus'

// ===== 客户端图片压缩（Canvas API） =====
// 上传前对图片做压缩：转为 WebP、质量 0.85、最大边 1920px，减少带宽与存储占用
const COMPRESS_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif']
const COMPRESS_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const COMPRESS_MAX_DIMENSION = 1920
const COMPRESS_QUALITY = 0.85

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

async function compressImage(file: File): Promise<File> {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  const isImage = COMPRESS_IMAGE_EXTS.includes(ext) || COMPRESS_IMAGE_TYPES.includes(file.type.toLowerCase())
  if (!isImage) {
    return file
  }

  try {
    const img = await loadImageFromFile(file)
    let { width, height } = img
    // 超过最大边时按比例缩放
    if (width > COMPRESS_MAX_DIMENSION || height > COMPRESS_MAX_DIMENSION) {
      if (width >= height) {
        height = Math.round((height * COMPRESS_MAX_DIMENSION) / width)
        width = COMPRESS_MAX_DIMENSION
      } else {
        width = Math.round((width * COMPRESS_MAX_DIMENSION) / height)
        height = COMPRESS_MAX_DIMENSION
      }
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    // PNG 透明通道转 WebP 时填充白底，避免出现黑底
    if (file.type.toLowerCase() === 'image/png') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(img, 0, 0, width, height)
    const blob: Blob | null = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/webp', COMPRESS_QUALITY)
    })
    if (!blob) return file
    const baseName = file.name.replace(/\.[^/.]+$/, '')
    return new File([blob], `${baseName}.webp`, { type: 'image/webp', lastModified: Date.now() })
  } catch (e: any) {
    console.warn('[compressImage] 压缩失败，返回原文件:', e?.message)
    return file
  }
}

// ===== 直传 Supabase 工具函数（绕过 pinggy 隧道大文件限制） =====
// 流程：前端调 /api/upload/presign 拿签名URL → 直接 PUT 到 Supabase → 返回公共URL
async function directUpload(file: File, kind: 'file' | 'image'): Promise<any> {
  // 图片先做客户端压缩（Canvas → WebP），失败则使用原文件
  let uploadFile = file
  if (kind === 'image') {
    try {
      uploadFile = await compressImage(file)
    } catch (e: any) {
      console.warn('[directUpload] 图片压缩失败，使用原文件上传:', e?.message)
      uploadFile = file
    }
  }

  const presignEndpoint = kind === 'image' ? '/api/upload/presign-image' : '/api/upload/presign'
  let presignResp: any
  try {
    presignResp = await http.post(presignEndpoint, { fileName: uploadFile.name, contentType: uploadFile.type })
  } catch (e: any) {
    // presign 接口本身不可用（如后端未启动），回退到旧接口
    console.warn('[directUpload] presign 请求失败，回退到旧接口:', e?.message)
    const fd = new FormData(); fd.append('file', uploadFile)
    const oldEndpoint = kind === 'image' ? '/api/upload/image' : '/api/upload/file'
    return http.post(oldEndpoint, fd)
  }

  // Supabase 不可用，回退到旧的 /api/upload/* 接口
  if (presignResp?.fallback) {
    const fd = new FormData(); fd.append('file', uploadFile)
    const oldEndpoint = kind === 'image' ? '/api/upload/image' : '/api/upload/file'
    return http.post(oldEndpoint, fd)
  }

  if (!presignResp?.signedUrl) {
    throw new Error('获取上传签名失败，请重试')
  }

  // 直传到 Supabase（PUT 签名URL，不需要 Authorization header）
  const upResp = await fetch(presignResp.signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': uploadFile.type || 'application/octet-stream' },
    body: uploadFile,
  })
  if (!upResp.ok) {
    const detail = await upResp.text().catch(() => '')
    throw new Error(`上传到存储服务失败 (${upResp.status}): ${detail.slice(0, 200)}`)
  }

  // 返回与原后端 /api/upload/file 兼容的数据结构
  if (kind === 'image') {
    return { url: presignResp.publicUrl }
  }
  return {
    url: presignResp.publicUrl,
    filePath: presignResp.key,
    fileName: uploadFile.name,
    fileType: presignResp.fileType || 'file',
    fileSize: uploadFile.size,
  }
}

export const api = {
  // 认证
  login: (data: { username: string; password: string }) => http.post('/api/auth/login', data),
  register: (data: any) => http.post('/api/auth/register', data),
  me: () => http.get('/api/auth/me'),
  // 用户
  users: () => http.get('/api/users'),
  createUser: (data: any) => http.post('/api/users', data),
  importUsers: (users: any[]) => http.post('/api/users/import', { users }),
  toggleUser: (id: number, status: string) => http.patch(`/api/users/${id}/status`, { status }),
  resetUser: (id: number) => http.post(`/api/users/${id}/reset`),
  deleteUser: (id: number) => http.delete(`/api/users/${id}`),
  adjustUserExp: (id: number, data: { exp?: number; level?: number }) => http.patch(`/api/users/${id}/exp`, data),
  grantExp: (data: { userId: number; change: number; actionType: string; description: string }) => http.post('/api/exp/logs', data),
  updateProfile: (data: any) => http.patch('/api/profile', data),
  uploadAvatar: async (file: File) => {
    // 头像通常较小，直接走 presign-image 直传 Supabase，上传成功后更新用户信息
    const result = await directUpload(file, 'image')
    const url = (result as any).url
    if (url) await http.patch('/api/profile', { avatar: url })
    return result
  },
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
  // Bug2 美文评论
  articleComments: (id: number) => http.get(`/api/articles/${id}/comments`),
  addArticleComment: (id: number, content: string) => http.post(`/api/articles/${id}/comments`, { content }),
  // Bug4 禁用状态检查
  meStatus: () => http.get('/api/me/status'),
  // Bug5 公开feature flag
  publicFeatureFlags: () => http.get('/api/feature-flags/public'),
  // 资料
  resources: (params: any) => http.get('/api/resources', { params }),
  createResource: (data: any) => http.post('/api/resources', data),
  auditResource: (id: number, status: string) => http.patch(`/api/resources/${id}/status`, { status }),
  deleteResource: (id: number) => http.delete(`/api/resources/${id}`),
  downloadResource: async (id: number) => {
    const baseURL = (import.meta.env.VITE_API_BASE_URL as string) || ''
    const token = localStorage.getItem('zg_token') || ''
    const http2 = axios.create({ baseURL, timeout: 60000, responseType: 'blob', withCredentials: !!(import.meta.env.VITE_API_BASE_URL) })
    if (token) http2.defaults.headers.common.Authorization = `Bearer ${token}`
    // 优先尝试新的 GET /file/r/:id?token=xxx（返回完整 axios 响应对象，含 headers，SubjectView 需要读取 content-type/content-disposition）
    try {
      return await http2.get(`/file/r/${id}`, { params: { token } })
    } catch (err: any) {
      // 失败（如 401）回退到旧的 POST /api/resources/:id/download
      console.warn('[downloadResource] GET /file/r/:id 失败，回退到 POST 接口:', err?.response?.status || err?.message)
      return http2.post(`/api/resources/${id}/download`)
    }
  },
  // 文件直链 URL（带 token，供 <img>/<a>/新窗口直接访问）
  fileDownloadUrl: (id: number): string => {
    const baseURL = (import.meta.env.VITE_API_BASE_URL as string) || ''
    const token = localStorage.getItem('zg_token') || ''
    return `${baseURL}/file/r/${id}?token=${encodeURIComponent(token)}`
  },
  filePreviewUrl: (id: number): string => {
    const baseURL = (import.meta.env.VITE_API_BASE_URL as string) || ''
    const token = localStorage.getItem('zg_token') || ''
    return `${baseURL}/file/r/${id}/preview?token=${encodeURIComponent(token)}`
  },
  fileRawUrl: (key: string): string => {
    const baseURL = (import.meta.env.VITE_API_BASE_URL as string) || ''
    const token = localStorage.getItem('zg_token') || ''
    return `${baseURL}/file/raw/${key}?token=${encodeURIComponent(token)}`
  },
  likeResource: (id: number) => http.post(`/api/resources/${id}/like`),
  uploadFile: (file: File) => directUpload(file, 'file'),
  uploadImage: (file: File) => directUpload(file, 'image'),
  // 查询
  queryTasks: () => http.get('/api/query/tasks'),
  queryTask: (id: number) => http.get(`/api/query/tasks/${id}`),
  doQuery: (id: number) => http.post(`/api/query/tasks/${id}/query`),
  createQueryTask: (data: any) => http.post('/api/query/tasks', data),
  deleteQueryTask: (id: number) => http.delete(`/api/query/tasks/${id}`),
  updateQueryTask: (id: number, data: any) => http.put(`/api/query/tasks/${id}`, data),
  // 需求1：导出查询任务Excel（超管下载所有人的，教师下载自己的）
  exportQueryTask: (id: number) => {
    const http2 = axios.create({ baseURL: (import.meta.env.VITE_API_BASE_URL as string) || '', timeout: 60000, responseType: 'blob', withCredentials: !!(import.meta.env.VITE_API_BASE_URL) })
    const token = localStorage.getItem('zg_token')
    if (token) http2.defaults.headers.common.Authorization = `Bearer ${token}`
    return http2.get(`/api/query/tasks/${id}/export`).then(async (res: any) => {
      // 检查是否为错误响应（JSON 而非文件）
      if (res.data instanceof Blob && res.data.type.includes('application/json')) {
        const text = await res.data.text()
        const err = JSON.parse(text)
        throw { response: { data: err, status: res.status } }
      }
      return res.data
    })
  },
  // 需求3：学生待确认美文 + 同意/拒绝
  pendingStudentArticles: () => http.get('/api/articles/pending-student'),
  approveStudentArticle: (id: number) => http.post(`/api/articles/${id}/student-approve`),
  rejectStudentArticle: (id: number) => http.post(`/api/articles/${id}/student-reject`),
  // 需求9：超管代学生确认美文
  adminConfirmArticle: (id: number) => http.post(`/api/articles/${id}/admin-confirm`),
  // 需求9：删除评论（美文/页面）
  deleteArticleComment: (articleId: number, commentId: number) => http.delete(`/api/articles/${articleId}/comments/${commentId}`),
  deletePageComment: (pageId: number, commentId: number) => http.delete(`/api/pages/${pageId}/comments/${commentId}`),
  // 需求9：超管修改用户信息（含用户名）
  updateUser: (id: number, data: any) => http.patch(`/api/users/${id}`, data),
  // 需求2：公告置顶切换
  pinPage: (id: number, pinned: boolean, pinnedScope?: string) => http.patch(`/api/pages/${id}/pin`, { pinned, pinnedScope }),
  // 需求5：网站运行监控（仅超管）
  monitor: () => http.get('/api/admin/monitor'),
  // 存储与缓存管理（仅超管）
  storageMonitor: () => http.get('/api/admin/storage/monitor'),
  storageOptimize: (action: string) => http.post('/api/admin/storage/optimize', { action }),
  deleteStorageFile: (fileName: string) => http.delete('/api/admin/storage/file', { data: { fileName } }),
  cacheStats: () => http.get('/api/admin/cache/stats'),
  // 经验 & 排行
  expLogs: (userId?: number) => http.get('/api/exp/logs', { params: { userId } }),
  allExpLogs: (page?: number, pageSize?: number) => http.get('/api/exp/all-logs', { params: { page, pageSize } }),
  deleteExpLog: (id: number) => http.delete(`/api/exp/logs/${id}`),
  batchDeleteExpLogs: (ids: number[]) => http.post('/api/exp/logs/batch-delete', { ids }),
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
  // 修改用户密码（超管）
  setUserPassword: (id: number, password: string) => http.post(`/api/users/${id}/password`, { password }),
  // ===== 设置：经验规则 / 功能开关 / 网站自定义 =====
  getExpRules: () => http.get('/api/settings/exp_rules'),
  saveExpRules: (rules: Record<string, number>) => http.put('/api/settings/exp_rules', rules),
  getFeatureFlags: () => http.get('/api/settings/feature_flags'),
  saveFeatureFlags: (flags: Record<string, boolean>) => http.put('/api/settings/feature_flags', flags),
  getSiteConfig: () => http.get('/api/settings/site_config'),
  saveSiteConfig: (config: any) => http.put('/api/settings/site_config', config),
  // ===== 题库自测 =====
  quizzes: (params?: any) => http.get('/api/quizzes', { params }),
  quiz: (id: number) => http.get(`/api/quizzes/${id}`),
  createQuiz: (data: any) => http.post('/api/quizzes', data),
  updateQuiz: (id: number, data: any) => http.patch(`/api/quizzes/${id}`, data),
  deleteQuiz: (id: number) => http.delete(`/api/quizzes/${id}`),
  submitQuiz: (id: number, answers: any) => http.post(`/api/quizzes/${id}/submit`, { answers }),
  gradeSubmission: (quizId: number, subId: number, grades: any) => http.post(`/api/quizzes/${quizId}/submissions/${subId}/grade`, { grades }),
  quizSubmissions: (id: number) => http.get(`/api/quizzes/${id}/submissions`),
  quizMyReport: (id: number) => http.get(`/api/quizzes/${id}/my_report`),
  quizReport: (id: number) => http.get(`/api/quizzes/${id}/report`),
  // 学科题目池（单题训练）
  subjectQuestions: (subjectId: number) => http.get(`/api/subjects/${subjectId}/questions`),
  subjectQuestion: (id: number) => http.get(`/api/subject-questions/${id}`),
  addSubjectQuestion: (subjectId: number, data: any) => http.post(`/api/subjects/${subjectId}/questions`, data),
  deleteSubjectQuestion: (id: number) => http.delete(`/api/subject-questions/${id}`),
  submitPractice: (qid: number, answer: string) => http.post(`/api/subject-questions/${qid}/submit`, { answer }),
  practiceMyResult: (qid: number) => http.get(`/api/subject-questions/${qid}/my_result`),
  practicePending: () => http.get('/api/practice/pending'),
  gradePractice: (id: number, score: number, comment: string) => http.post(`/api/practice/${id}/grade`, { score, comment }),
  practiceMyRecords: (page: number, perPage: number) => http.get('/api/practice/my-records', { params: { page, perPage } }),
  deletePracticeRecord: (id: number) => http.delete(`/api/practice/record/${id}`),
  practiceStats: (subjectId: number) => http.get(`/api/practice/stats/${subjectId}`),
  // ===== 通用页面：网站说明 / 博客 / 公告 =====
  guide: () => http.get('/api/pages/guide'),
  saveGuide: (data: { title: string; content: string; images?: string[]; attachments?: any[] }) => http.put('/api/pages/guide', data),
  pages: (params: any) => http.get('/api/pages', { params }),
  page: (id: number) => http.get(`/api/pages/${id}`),
  createPage: (data: any) => http.post('/api/pages', data),
  deletePage: (id: number) => http.delete(`/api/pages/${id}`),
  likePage: (id: number) => http.post(`/api/pages/${id}/like`),
  pageLiked: (id: number) => http.get(`/api/pages/${id}/liked`),
  pageComments: (id: number) => http.get(`/api/pages/${id}/comments`),
  addPageComment: (id: number, content: string) => http.post(`/api/pages/${id}/comments`, { content }),
  announcements: () => http.get('/api/announcements'),
  // ===== 站内信 =====
  messageContacts: () => http.get('/api/messages/contacts'),
  messageSessions: () => http.get('/api/messages/sessions'),
  messageThread: (peerId: number) => http.get(`/api/messages/${peerId}`),
  sendMessage: (toId: number, content: string, attachments?: any[]) => http.post('/api/messages', { toId, content, attachments }),
  messageUnreadCount: () => http.get('/api/messages/unread/count'),
  readAllMessages: () => http.post('/api/messages/read-all'),
  messageAll: (aId: number, bId: number) => http.get(`/api/messages/all/${aId}/${bId}`),
}
