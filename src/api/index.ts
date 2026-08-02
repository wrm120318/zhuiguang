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
  // 修改用户密码（超管）
  setUserPassword: (id: number, password: string) => http.post(`/api/users/${id}/password`, { password }),
  // ===== 设置：经验规则 / 功能开关 =====
  getExpRules: () => http.get('/api/settings/exp_rules'),
  saveExpRules: (rules: Record<string, number>) => http.put('/api/settings/exp_rules', rules),
  getFeatureFlags: () => http.get('/api/settings/feature_flags'),
  saveFeatureFlags: (flags: Record<string, boolean>) => http.put('/api/settings/feature_flags', flags),
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
  messageAll: (aId: number, bId: number) => http.get(`/api/messages/all/${aId}/${bId}`),
}
