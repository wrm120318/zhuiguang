// ==============================================================================
// 【v4.9.7】ADMIN 角色 · 权限 key 定义（与后端 worker-api.ts 的 PERM_KEYS 保持一致）
//
// 模型：
//   - SUPER_ADMIN：恒全权，不读 permissions（后端 hasPerm 首行短路）
//   - ADMIN：权限来自 users.permissions，**每个管理员各自一套**（互不影响）
//   - TEACHER / STUDENT：不参与本权限系统（教师走原有学科判定）
//
// ⚠️ 新增后台模块时，必须三处同步：
//   1) 本文件的 PERM_KEYS / PERM_LABELS
//   2) worker-api.ts 的 PERM_KEYS
//   3) AdminLayout.vue 对应菜单项的 perm 字段
// ==============================================================================

export const PERM_KEYS = [
  'dashboard',
  'users',
  'subjects',
  'classes',
  'audit',
  'query',
  'guide',
  'site_config',
  'exp_rules',
  'exp_logs',
  'feature_flags',
  'theme',
  'monitor',
] as const

export type PermKey = typeof PERM_KEYS[number]

/** 权限 key → 中文名（用于用户管理页的勾选框） */
export const PERM_LABELS: Record<PermKey, string> = {
  dashboard: '数据看板',
  users: '用户管理',
  subjects: '学科管理',
  classes: '班级管理',
  audit: '内容审核',
  query: '数据查询',
  guide: '网站说明',
  site_config: '网站自定义',
  exp_rules: '经验设置',
  exp_logs: '经验记录',
  feature_flags: '功能开关',
  theme: '界面风格',
  monitor: '运行监控',
}

/** 权限 key → 一句话说明（勾选框下方提示，帮助超管理解影响范围） */
export const PERM_DESC: Record<PermKey, string> = {
  dashboard: '查看后台首页的数据看板，并向全站广播公告',
  users: '增删改用户、重置密码、分配班级与任教、设置管理员权限',
  subjects: '新增/编辑/删除学科，以及管理全站学科内的题目与知识点',
  classes: '新增/编辑/删除班级',
  audit: '审核全站美文、论坛帖子、资料与博客话题，可查看未公开内容',
  query: '查看与导出租数据查询任务（含他人创建的）',
  guide: '编辑「网站说明」页面及其中的公告',
  site_config: '修改站点名称、Logo、备案等网站自定义配置',
  exp_rules: '配置各类行为的经验值规则',
  exp_logs: '查看全站经验记录，并可手动增删',
  feature_flags: '开关注册、发帖等功能开关',
  theme: '管理界面主题风格',
  monitor: '查看运行监控、存储用量、缓存与预热、数据迁移',
}

/** 判断某个 key 是否合法 */
export function isPermKey(k: any): k is PermKey {
  return (PERM_KEYS as readonly string[]).includes(k)
}

/** 把任意输入规整为合法的权限数组（过滤未知 key） */
export function sanitizePerms(input: any): PermKey[] {
  if (!Array.isArray(input)) return []
  return input.filter(isPermKey)
}
