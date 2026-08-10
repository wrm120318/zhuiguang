<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api'
import { useDataStore } from '@/store/data'
import { ElMessage, ElMessageBox } from 'element-plus'
import * as XLSX from 'xlsx'

const data = useDataStore()

const users = ref<any[]>([])
const search = ref('')

const filtered = computed(() => {
  const q = search.value.trim()
  if (!q) return users.value
  return users.value.filter((u: any) => u.real_name?.includes(q) || u.username?.includes(q) || u.email?.includes(q))
})

async function load() {
  if (!data.classes.length) await data.fetchClasses()
  if (!data.subjects.length) await data.fetchSubjects()
  users.value = (await api.users()) as any
}

function subjectName(id: number | null) {
  if (!id) return '-'
  const s = data.subjects.find((x: any) => x.id === id)
  return s ? `${s.icon} ${s.name}` : '-'
}
onMounted(load)

function roleLabel(r: string) { return r === 'SUPER_ADMIN' ? '超管' : r === 'TEACHER' ? '教师' : '学生' }

async function toggleStatus(u: any) {
  const next = u.status === 'active' ? 'disabled' : 'active'
  await api.toggleUser(u.id, next)
  u.status = next
  ElMessage.success(`已${next === 'active' ? '启用' : '禁用'}「${u.real_name}」`)
}

async function resetPwd(u: any) {
  try {
    const { value } = await ElMessageBox.prompt(`为「${u.real_name}」设置新密码（留空则重置为 123456）`, '重置 / 修改密码', {
      inputType: 'password',
      inputPlaceholder: '输入新密码（≥4 位），留空默认 123456',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValidator: (v: string) => !v || v.length >= 4 || '密码至少 4 位',
    })
    const pwd = (value || '').trim()
    await api.setUserPassword(u.id, pwd || '123456')
    ElMessage.success(`已设置新密码`)
  } catch { /* */ }
}

async function deleteUser(u: any) {
  try {
    await ElMessageBox.confirm(`确定删除用户「${u.real_name}」？该操作不可恢复，将同时删除其所有美文、资料、经验记录等。`, '删除用户', { type: 'error' })
    await api.deleteUser(u.id)
    ElMessage.success('用户已删除')
    await load()
  } catch { /* */ }
}

const addVisible = ref(false)
const form = ref({ realName: '', username: '', role: 'STUDENT', email: '', classId: 1, password: '', subjectId: null as number | null })

async function openAdd() {
  // 始终拉取最新班级/学科，避免在「班级管理」里改动后此处仍显示旧数据
  await Promise.all([data.fetchClasses(), data.fetchSubjects()])
  // 若默认 classId 已不存在于最新列表，则回退到第一个班级
  if (form.value.classId && !data.classes.find((c: any) => c.id === form.value.classId)) {
    form.value.classId = data.classes[0]?.id ?? 1
  }
  addVisible.value = true
}

async function addUser() {
  if (!form.value.realName || !form.value.username) { ElMessage.warning('请填写姓名与用户名'); return }
  if (form.value.role === 'TEACHER' && !form.value.subjectId) { ElMessage.warning('请为教师选择绑定学科'); return }
  try {
    await api.createUser({
      realName: form.value.realName,
      username: form.value.username,
      role: form.value.role,
      email: form.value.email || `${form.value.username}@zguang.edu`,
      classId: form.value.classId,
      password: form.value.password || '123456',
      subjectId: form.value.subjectId,
    })
    ElMessage.success('用户已创建')
    addVisible.value = false
    form.value = { realName: '', username: '', role: 'STUDENT', email: '', classId: 1, password: '', subjectId: null }
    await load()
  } catch { /* */ }
}

// ===== 编辑用户 =====
const editVisible = ref(false)
const editForm = ref({ id: 0, realName: '', username: '', role: 'STUDENT', subjectId: null as number | null, email: '', classId: null as number | null })
const editLoading = ref(false)

async function openEdit(u: any) {
  // 拉取最新班级和学科列表
  await Promise.all([data.fetchClasses(), data.fetchSubjects()])
  editForm.value = {
    id: u.id,
    realName: u.real_name || '',
    username: u.username || '',
    role: u.role || 'STUDENT',
    subjectId: u.subject_id ?? null,
    email: u.email || '',
    classId: u.class_id ?? null as number | null,
  }
  editVisible.value = true
}

async function saveEdit() {
  if (!editForm.value.realName || !editForm.value.username) { ElMessage.warning('请填写姓名与用户名'); return }
  if (editForm.value.role === 'TEACHER' && !editForm.value.subjectId) { ElMessage.warning('请为教师选择绑定学科'); return }
  editLoading.value = true
  try {
    await api.updateUser(editForm.value.id, {
      realName: editForm.value.realName,
      username: editForm.value.username,
      role: editForm.value.role,
      subjectId: editForm.value.subjectId,
      email: editForm.value.email,
      classId: editForm.value.classId,
    })
    ElMessage.success('用户信息已更新')
    editVisible.value = false
    await load()
  } catch { /* */ } finally {
    editLoading.value = false
  }
}

const expDialogVisible = ref(false)
const expForm = ref({ userId: 0, exp: 0, level: 1, change: 0, reason: '' })

function openExpDialog(u: any) {
  expForm.value = { userId: u.id, exp: u.exp, level: u.level, change: 0, reason: '' }
  expDialogVisible.value = true
}

async function saveExp() {
  try {
    if (expForm.value.change !== 0) {
      await api.grantExp({
        userId: expForm.value.userId,
        change: expForm.value.change,
        actionType: 'admin_adjust',
        description: expForm.value.reason || '管理员调整',
      })
    }
    if (expForm.value.exp !== undefined || expForm.value.level !== undefined) {
      await api.adjustUserExp(expForm.value.userId, {
        exp: expForm.value.exp,
        level: expForm.value.level,
      })
    }
    ElMessage.success('经验值已更新')
    expDialogVisible.value = false
    await load()
  } catch { /* */ }
}

// ===== 查看经验记录 =====
const expLogsVisible = ref(false)
const expLogsData = ref<any[]>([])
const expLogsLoading = ref(false)
const expLogsUser = ref<any>(null)
const expLogsSelected = ref<any[]>([])
const expLogsDeleting = ref(false)
const expLogSearch = ref('')
const expLogActionFilter = ref('')

// 经验记录可选的行为类型（与 ExpLogsView 保持一致）
const EXP_LOG_ACTIONS = [
  { value: '', label: '全部行为' },
  { value: 'login', label: '每日登录' },
  { value: 'register', label: '注册奖励' },
  { value: 'article', label: '发布美文' },
  { value: 'resource', label: '上传资料' },
  { value: 'query', label: '完成查询' },
  { value: 'quiz_pass', label: '题库自测' },
  { value: 'blog', label: '发布博客' },
  { value: 'comment', label: '收到评论' },
  { value: 'like', label: '收到点赞' },
  { value: 'favorite', label: '被收藏' },
  { value: 'practice_pass', label: '单题训练' },
  { value: 'announcement_read', label: '阅读公告' },
  { value: 'message_reply', label: '回复站内信' },
  { value: 'article_delete', label: '删除美文' },
  { value: 'resource_delete', label: '删除资料' },
  { value: 'blog_delete', label: '删除博客' },
  { value: 'query_delete', label: '删除查询' },
  { value: 'comment_delete', label: '删除评论' },
  { value: 'like_cancel', label: '取消点赞' },
  { value: 'favorite_cancel', label: '取消收藏' },
  { value: 'quiz_fail', label: '自测未通过' },
  { value: 'practice_fail', label: '训练未通过' },
  { value: 'admin_adjust', label: '管理员调整' },
]
const EXP_LOG_LABELS: Record<string, string> = Object.fromEntries(
  EXP_LOG_ACTIONS.filter(o => o.value).map(o => [o.value, o.label])
)
function expLogActionLabel(t: string) { return EXP_LOG_LABELS[t] || t }

// 过滤后的经验记录（支持关键词 + 行为类型）
const filteredExpLogs = computed(() => {
  const q = expLogSearch.value.trim().toLowerCase()
  const a = expLogActionFilter.value
  return expLogsData.value.filter((it: any) => {
    if (a && it.action_type !== a) return false
    if (q && !(it.description || '').toLowerCase().includes(q)) return false
    return true
  })
})

// 当前选中记录的净经验变动（删除这些记录会从 users.exp 回退的总和）
const selectedExpNet = computed(() =>
  expLogsSelected.value.reduce((s: number, it: any) => s + Number(it.exp_change || 0), 0)
)

async function openExpLogs(u: any) {
  expLogsUser.value = u
  expLogsVisible.value = true
  expLogsData.value = []
  expLogsSelected.value = []
  expLogSearch.value = ''
  expLogActionFilter.value = ''
  expLogsLoading.value = true
  try {
    expLogsData.value = (await api.expLogs(u.id)) as any
  } catch { /* */ } finally {
    expLogsLoading.value = false
  }
}

async function deleteOneExpLog(row: any) {
  try {
    await ElMessageBox.confirm(
      `确定要删除该条经验记录吗？将回退 ${row.exp_change > 0 ? '+' : ''}${row.exp_change} 经验值。`,
      '删除经验记录',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch { return }
  expLogsDeleting.value = true
  try {
    await api.deleteExpLog(row.id)
    ElMessage.success('已删除')
    // 从本地列表里移除，避免重新拉取
    expLogsData.value = expLogsData.value.filter((x: any) => x.id !== row.id)
    expLogsSelected.value = expLogsSelected.value.filter((x: any) => x.id !== row.id)
    await load()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '删除失败')
  } finally {
    expLogsDeleting.value = false
  }
}

async function batchDeleteExpLogs() {
  if (!expLogsSelected.value.length) { ElMessage.warning('请先勾选要删除的记录'); return }
  const ids = expLogsSelected.value.map((x: any) => x.id)
  try {
    await ElMessageBox.confirm(
      `确定删除选中的 ${ids.length} 条经验记录吗？将回退 ${selectedExpNet.value > 0 ? '+' : ''}${selectedExpNet.value} 经验值。`,
      '批量删除经验记录',
      { type: 'warning', confirmButtonText: '批量删除', cancelButtonText: '取消' }
    )
  } catch { return }
  expLogsDeleting.value = true
  try {
    const r: any = await api.batchDeleteExpLogs(ids)
    ElMessage.success(`已删除 ${r.deleted} 条记录${r.affectedUsers ? `，影响 ${r.affectedUsers} 个用户` : ''}`)
    // 从本地列表里移除已删除的 id
    const idSet = new Set(ids)
    expLogsData.value = expLogsData.value.filter((x: any) => !idSet.has(x.id))
    expLogsSelected.value = []
    await load()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '批量删除失败')
  } finally {
    expLogsDeleting.value = false
  }
}

function onExpLogSelectionChange(rows: any[]) {
  expLogsSelected.value = rows || []
}

function expLogFmtTime(t: string) {
  if (!t) return '-'
  return String(t).replace('T', ' ').slice(0, 19)
}

// ===== 批量导入用户 =====
const importVisible = ref(false)
const importPreview = ref<any[]>([])
const importLoading = ref(false)
const importResult = ref<{ success: number; skipped: number; errors: string[] } | null>(null)

function downloadTemplate() {
  // 构建含示例数据的模板
  const classNameMap: Record<number, string> = {}
  data.classes.forEach((c: any) => { classNameMap[c.id] = c.name })
  const subjectNameMap: Record<number, string> = {}
  data.subjects.forEach((s: any) => { subjectNameMap[s.id] = `${s.icon} ${s.name}` })

  const aoa: any[][] = [
    ['姓名', '用户名', '角色', '密码', '邮箱', '班级', '学科'],
    ['张三', 'zhangsan', '学生', '123456', 'zhangsan@school.edu', data.classes[0]?.name || '高二（1）班', ''],
    ['李老师', 'lilaoshi', '教师', '123456', 'lilaoshi@school.edu', '', data.subjects[0] ? `${data.subjects[0].icon} ${data.subjects[0].name}` : '语文'],
    ['王同学', 'wangtongxue', '学生', '', '', data.classes[0]?.name || '高二（1）班', ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 12 }, { wch: 16 }, { wch: 8 }, { wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 16 }]

  // 添加第二个sheet：角色和班级对照说明
  const guideAoa: any[][] = [
    ['字段说明'],
    ['姓名', '必填，用户真实姓名'],
    ['用户名', '必填，登录用，唯一不可重复'],
    ['角色', '填「学生」「教师」或「超级管理员」，默认学生'],
    ['密码', '留空默认 123456'],
    ['邮箱', '留空自动生成 用户名@zguang.edu'],
    ['班级', '填班级名称（需与系统班级一致），学生建议填写'],
    ['学科', '教师必填，填学科名称（如：语文、数学），学生留空'],
    [''],
    ['当前系统班级列表'],
    ...data.classes.map((c: any) => [c.name]),
    [''],
    ['当前系统学科列表'],
    ...data.subjects.map((s: any) => [`${s.icon} ${s.name}`]),
  ]
  const ws2 = XLSX.utils.aoa_to_sheet(guideAoa)
  ws2['!cols'] = [{ wch: 20 }, { wch: 40 }]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '用户导入模板')
  XLSX.utils.book_append_sheet(wb, ws2, '填写说明')
  XLSX.writeFile(wb, '追光_用户导入模板.xlsx')
  ElMessage.success('模板已下载，请按格式填写后上传')
}

async function handleImportUpload(uploadRequest: any) {
  importLoading.value = true
  importResult.value = null
  try {
    const f = uploadRequest.file as File
    if (!f) throw new Error('未获取到文件')
    const ab = await f.arrayBuffer()
    const wb = XLSX.read(ab, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' })
    if (!json.length) throw new Error('未解析到数据，请检查Excel格式')

    // 构建班级/学科名称→ID映射
    const classMap: Record<string, number> = {}
    data.classes.forEach((c: any) => { classMap[c.name] = c.id })
    const subjectMap: Record<string, number> = {}
    data.subjects.forEach((s: any) => {
      subjectMap[s.name] = s.id
      subjectMap[`${s.icon} ${s.name}`] = s.id
      subjectMap[s.icon + s.name] = s.id
    })

    // 解析每行数据
    const parsed = json.map((row: any) => {
      const realName = String(row['姓名'] || '').trim()
      const username = String(row['用户名'] || '').trim()
      let role = String(row['角色'] || '学生').trim()
      if (role === '学生' || role === 'STUDENT') role = 'STUDENT'
      else if (role === '教师' || role === 'TEACHER') role = 'TEACHER'
      else if (role === '超级管理员' || role === 'SUPER_ADMIN') role = 'SUPER_ADMIN'
      else role = 'STUDENT'

      const password = String(row['密码'] || '').trim()
      const email = String(row['邮箱'] || '').trim()
      const className = String(row['班级'] || '').trim()
      const subjectName = String(row['学科'] || '').trim()

      return {
        realName,
        username,
        role,
        password: password || undefined,
        email: email || undefined,
        classId: className ? (classMap[className] || undefined) : undefined,
        subjectId: subjectName ? (subjectMap[subjectName] || undefined) : null,
      }
    }).filter((u: any) => u.realName && u.username)

    if (!parsed.length) throw new Error('未解析到有效数据，请检查姓名和用户名列')

    importPreview.value = parsed
    ElMessage.success(`解析成功：共 ${parsed.length} 条用户数据`)
  } catch (e: any) {
    console.error('[Excel解析失败]', e)
    ElMessage.error(e?.message || 'Excel 解析失败，请检查文件格式')
    importPreview.value = []
  } finally {
    importLoading.value = false
  }
}

function classNameById(id?: number) {
  if (!id) return '-'
  const c = data.classes.find((x: any) => x.id === id)
  return c ? c.name : '-'
}

function subjectNameById(id: number | null) {
  if (!id) return '-'
  const s = data.subjects.find((x: any) => x.id === id)
  return s ? `${s.icon} ${s.name}` : '-'
}

async function confirmImport() {
  if (!importPreview.value.length) return
  importLoading.value = true
  try {
    const r: any = await api.importUsers(importPreview.value)
    importResult.value = r
    if (r.success > 0) {
      ElMessage.success(`导入完成：成功 ${r.success} 人${r.skipped ? `，跳过 ${r.skipped} 人` : ''}`)
      await load()
    } else {
      ElMessage.warning('没有成功导入任何用户，请检查错误信息')
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '导入失败')
  } finally {
    importLoading.value = false
  }
}

function openImport() {
  importPreview.value = []
  importResult.value = null
  importVisible.value = true
}
</script>

<template>
  <div>
    <div class="head">
      <h1 class="dh-title">用户管理</h1>
      <div class="head-actions">
        <el-input v-model="search" placeholder="搜索姓名/用户名/邮箱" style="width:240px" clearable />
        <el-button @click="openImport">批量导入</el-button>
        <el-button type="primary" @click="openAdd">+ 新建用户</el-button>
      </div>
    </div>

    <div class="table-wrap glass">
      <el-table :data="filtered" style="width:100%;min-width:1400px">
        <el-table-column label="用户" min-width="180">
          <template #default="{ row }">
            <div class="u-cell"><img :src="row.avatar" class="u-avatar" /><div><div class="u-name">{{ row.real_name }}</div><div class="u-id">@{{ row.username }}</div></div></div>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="100">
          <template #default="{ row }"><el-tag size="small" :type="row.role==='SUPER_ADMIN'?'danger':row.role==='TEACHER'?'warning':'info'">{{ roleLabel(row.role) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="学科" width="120" v-if="filtered.some((u:any) => u.role === 'TEACHER')">
          <template #default="{ row }"><span v-if="row.role === 'TEACHER'" class="subj-cell">{{ subjectName(row.subject_id) }}</span><span v-else>-</span></template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="180" />
        <el-table-column label="班级" width="120">
          <template #default="{ row }">{{ classNameById(row.class_id) }}</template>
        </el-table-column>
        <el-table-column label="等级" width="90"><template #default="{ row }">Lv.{{ row.level }}</template></el-table-column>
        <el-table-column label="经验" width="100"><template #default="{ row }">{{ row.exp }}</template></el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag size="small" :type="row.status==='active'?'success':'danger'">{{ row.status === 'active' ? '正常' : '禁用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="420">
          <template #default="{ row }">
            <el-button text size="small" type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" @click="openExpLogs(row)">查看经验</el-button>
            <el-button text size="small" @click="openExpDialog(row)">调整经验</el-button>
            <el-button text size="small" @click="resetPwd(row)">修改密码</el-button>
            <el-button text size="small" :type="row.status==='active'?'danger':'success'" @click="toggleStatus(row)">{{ row.status === 'active' ? '禁用' : '启用' }}</el-button>
            <el-button text size="small" type="danger" @click="deleteUser(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 新建用户 -->
    <el-dialog v-model="addVisible" title="新建用户" width="440px">
      <el-form label-width="80px">
        <el-form-item label="姓名"><el-input v-model="form.realName" /></el-form-item>
        <el-form-item label="用户名"><el-input v-model="form.username" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" placeholder="留空默认 123456" type="password" show-password /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width:100%">
            <el-option label="学生" value="STUDENT" /><el-option label="教师" value="TEACHER" /><el-option label="超级管理员" value="SUPER_ADMIN" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定学科" v-if="form.role === 'TEACHER'">
          <el-select v-model="form.subjectId" placeholder="请选择教师管理的学科" style="width:100%">
            <el-option v-for="s in data.subjects" :key="s.id" :label="s.icon + ' ' + s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="邮箱"><el-input v-model="form.email" placeholder="留空自动生成" /></el-form-item>
        <el-form-item label="班级">
          <el-select v-model="form.classId" style="width:100%">
            <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="addVisible=false">取消</el-button><el-button type="primary" @click="addUser">创建</el-button></template>
    </el-dialog>

    <!-- 编辑用户 -->
    <el-dialog v-model="editVisible" title="编辑用户" width="440px">
      <el-form label-width="80px">
        <el-form-item label="姓名"><el-input v-model="editForm.realName" /></el-form-item>
        <el-form-item label="用户名"><el-input v-model="editForm.username" /></el-form-item>
        <el-form-item label="角色">
          <el-select v-model="editForm.role" style="width:100%">
            <el-option label="学生" value="STUDENT" /><el-option label="教师" value="TEACHER" /><el-option label="超级管理员" value="SUPER_ADMIN" />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定学科" v-if="editForm.role === 'TEACHER'">
          <el-select v-model="editForm.subjectId" placeholder="请选择教师管理的学科" style="width:100%">
            <el-option v-for="s in data.subjects" :key="s.id" :label="s.icon + ' ' + s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="邮箱"><el-input v-model="editForm.email" /></el-form-item>
        <el-form-item label="归属班级">
          <el-select v-model="editForm.classId" placeholder="不选则不分配班级" style="width:100%" clearable>
            <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="editVisible=false">取消</el-button><el-button type="primary" :loading="editLoading" @click="saveEdit">保存</el-button></template>
    </el-dialog>

    <!-- 经验值调整 -->
    <el-dialog v-model="expDialogVisible" title="调整经验值" width="440px">
      <el-form label-width="100px">
        <el-form-item label="当前经验">
          <el-input-number v-model="expForm.exp" :min="0" controls-position="right" />
        </el-form-item>
        <el-form-item label="当前等级">
          <el-input-number v-model="expForm.level" :min="1" controls-position="right" />
        </el-form-item>
        <el-form-item label="经验变动">
          <el-input-number v-model="expForm.change" :min="-9999" :max="9999" controls-position="right" />
          <span style="font-size:12px;color:var(--zg-text-dim);margin-left:8px">正数增加，负数扣除</span>
        </el-form-item>
        <el-form-item label="变动原因">
          <el-input v-model="expForm.reason" type="textarea" :rows="2" placeholder="如：表现优秀奖励 / 违反规定扣分" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="expDialogVisible=false">取消</el-button>
        <el-button type="primary" @click="saveExp">保存</el-button>
      </template>
    </el-dialog>

    <!-- 查看经验记录 -->
    <el-dialog v-model="expLogsVisible" :title="`经验记录 - ${expLogsUser?.real_name || ''}（共 ${expLogsData.length} 条）`" width="900px">
      <div v-loading="expLogsLoading" style="min-height:200px">
        <!-- 顶部筛选 + 操作栏 -->
        <div class="exp-log-toolbar">
          <el-input
            v-model="expLogSearch"
            placeholder="搜索描述关键词"
            clearable
            size="default"
            class="exp-log-search"
          >
            <template #prefix><span>🔍</span></template>
          </el-input>
          <el-select v-model="expLogActionFilter" placeholder="行为类型" clearable size="default" class="exp-log-action">
            <el-option v-for="o in EXP_LOG_ACTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <div class="exp-log-stat">
            <span class="exp-log-stat-label">已选</span>
            <span class="exp-log-stat-val">{{ expLogsSelected.length }}</span>
            <span class="exp-log-stat-sep">·</span>
            <span class="exp-log-stat-label">合计回退</span>
            <span class="exp-log-stat-val" :style="{ color: selectedExpNet > 0 ? '#16a34a' : selectedExpNet < 0 ? '#dc2626' : 'var(--zg-text-dim)' }">{{ selectedExpNet > 0 ? '+' : '' }}{{ selectedExpNet }}</span>
          </div>
          <el-button type="danger" :disabled="!expLogsSelected.length || expLogsDeleting" :loading="expLogsDeleting" @click="batchDeleteExpLogs">
            批量删除
          </el-button>
        </div>

        <el-table
          :data="filteredExpLogs"
          row-key="id"
          empty-text="暂无经验记录"
          size="small"
          max-height="420"
          @selection-change="onExpLogSelectionChange"
          class="exp-log-table"
          style="overflow-x: auto;"
        >
          <el-table-column type="selection" width="44" :selectable="() => true" />
          <el-table-column label="行为" width="120">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ expLogActionLabel(row.action_type) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="经验变动" width="100" align="center">
            <template #default="{ row }">
              <span :style="{ color: row.exp_change > 0 ? '#16a34a' : row.exp_change < 0 ? '#dc2626' : 'var(--zg-text-dim)', fontWeight: 800 }">
                {{ row.exp_change > 0 ? '+' : '' }}{{ row.exp_change }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="描述" min-width="220" prop="description" />
          <el-table-column label="时间" width="160">
            <template #default="{ row }">{{ expLogFmtTime(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="84" fixed="right" align="center">
            <template #default="{ row }">
              <el-button text size="small" type="danger" :loading="expLogsDeleting" @click="deleteOneExpLog(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <el-button @click="expLogsVisible=false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 批量导入用户 -->
    <el-dialog v-model="importVisible" title="批量导入用户" width="720px" :close-on-click-modal="false">
      <div v-if="!importResult">
        <div class="import-steps">
          <div class="import-step"><span class="s-no">1</span><div><div class="s-title">下载模板</div><div class="s-desc">含表头与示例数据</div></div></div>
          <div class="import-step"><span class="s-no">2</span><div><div class="s-title">填写数据</div><div class="s-desc">按格式填入用户信息</div></div></div>
          <div class="import-step"><span class="s-no">3</span><div><div class="s-title">上传预览</div><div class="s-desc">确认无误后导入</div></div></div>
        </div>

        <div class="import-actions">
          <el-button type="primary" @click="downloadTemplate">下载模板</el-button>
          <el-upload
            :http-request="handleImportUpload"
            :show-file-list="false"
            accept=".xlsx,.xls"
            :disabled="importLoading"
          >
            <el-button :loading="importLoading">{{ importLoading ? '解析中...' : '上传Excel' }}</el-button>
          </el-upload>
        </div>

        <div v-if="importPreview.length" class="preview-section">
          <div class="preview-title">预览（共 {{ importPreview.length }} 条）</div>
          <el-table :data="importPreview.slice(0, 20)" style="width:100%" max-height="300" size="small">
            <el-table-column label="姓名" prop="realName" width="100" />
            <el-table-column label="用户名" prop="username" width="120" />
            <el-table-column label="角色" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.role==='SUPER_ADMIN'?'danger':row.role==='TEACHER'?'warning':'info'">
                  {{ row.role === 'SUPER_ADMIN' ? '超管' : row.role === 'TEACHER' ? '教师' : '学生' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="班级" width="120">
              <template #default="{ row }">{{ classNameById(row.classId) }}</template>
            </el-table-column>
            <el-table-column label="学科" width="120">
              <template #default="{ row }">{{ subjectNameById(row.subjectId) }}</template>
            </el-table-column>
            <el-table-column label="密码" width="80">
              <template #default="{ row }">{{ row.password || '默认' }}</template>
            </el-table-column>
          </el-table>
          <div v-if="importPreview.length > 20" class="preview-more">仅显示前20条，共 {{ importPreview.length }} 条</div>
        </div>
      </div>

      <!-- 导入结果 -->
      <div v-else class="import-result">
        <el-result :icon="importResult.success > 0 ? 'success' : 'warning'" :title="`导入完成`" :sub-title="`成功 ${importResult.success} 人，跳过 ${importResult.skipped} 人`">
        </el-result>
        <div v-if="importResult.errors.length" class="error-list">
          <div class="error-title">详细信息：</div>
          <div v-for="(err, i) in importResult.errors" :key="i" class="error-item">{{ err }}</div>
        </div>
      </div>

      <template #footer>
        <el-button @click="importVisible=false">{{ importResult ? '关闭' : '取消' }}</el-button>
        <el-button v-if="!importResult && importPreview.length" type="primary" :loading="importLoading" @click="confirmImport">确认导入</el-button>
        <el-button v-if="importResult" type="primary" @click="importVisible=false">完成</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
.dh-title { font-size:24px; font-weight:800; }
.head-actions { display:flex; gap:12px; flex-wrap:wrap; }
.table-wrap { padding:8px; overflow-x:auto; }
.u-cell { display:flex; align-items:center; gap:10px; }
.u-avatar { width:36px; height:36px; border-radius:50%; object-fit:cover; }
.u-name { font-weight:600; }
.u-id { font-size:12px; color:var(--zg-text-dim); }

.import-steps { display:flex; gap:16px; margin-bottom:20px; }
.import-step { display:flex; align-items:center; gap:10px; flex:1; }
.s-no { width:28px; height:28px; border-radius:50%; background:var(--zg-primary,#409eff); color:#fff; display:flex; align-items:center; justify-content:center; font-size:14px; font-weight:700; flex-shrink:0; }
.s-title { font-weight:600; font-size:14px; }
.s-desc { font-size:12px; color:var(--zg-text-dim,#999); }
.import-actions { display:flex; gap:12px; margin-bottom:20px; }
.preview-section { margin-top:12px; }
.preview-title { font-weight:600; margin-bottom:8px; font-size:14px; }
.preview-more { text-align:center; font-size:12px; color:var(--zg-text-dim,#999); margin-top:8px; }
.import-result { text-align:center; }
.error-list { margin-top:16px; max-height:200px; overflow-y:auto; text-align:left; }
.error-title { font-weight:600; font-size:13px; margin-bottom:6px; }
.error-item { font-size:12px; color:#e6a23c; padding:2px 0; }

/* 经验记录弹窗工具栏 + 表格 */
.exp-log-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
.exp-log-search { width:220px; }
.exp-log-action { width:160px; }
.exp-log-stat { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:13px; }
.exp-log-stat-label { color:var(--zg-text-dim); }
.exp-log-stat-val { font-weight:800; font-size:15px; padding:0 6px; }
.exp-log-stat-sep { color:var(--zg-text-dim); opacity:.5; }
.exp-log-table { border-radius:10px; overflow:hidden; }
:deep(.exp-log-table .cell) { padding:6px 0; }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .head { margin-bottom: 14px; }
  .head-actions { width: 100%; }
  .head-actions .el-input { width: 100% !important; }
  .head-actions .el-button { min-width: auto; }
  .table-wrap { padding: 6px; overflow-x: auto; }
  .u-cell { gap: 8px; }
  .u-avatar { width: 32px; height: 32px; }
  .u-name { font-size: 13px; }
  .u-id { font-size: 11px; }
}

@media (min-width: 1200px) {
  .dh-title { font-size: 28px; }
  .head { margin-bottom: 28px; }
  .table-wrap { padding: 12px; }
}

:deep(.el-dialog) {
  width: 440px;
}
:deep(.el-table .cell) {
  padding: 8px 0;
  font-size: 13px;
}
@media (max-width: 768px) {
  :deep(.el-dialog) {
    width: 92% !important;
    margin: 4vh auto !important;
  }
  :deep(.el-form-item__label) {
    width: 60px !important;
  }
  :deep(.el-table .cell) {
    padding: 8px !important;
    font-size: 12px !important;
  }
  :deep(.el-table .cell .el-button) {
    height: 28px;
    padding: 0 6px;
    font-size: 12px;
    margin: 0;
  }
  :deep(.el-table .cell) {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  :deep(.el-table .cell > *) {
    margin: 0;
  }
}
@media (min-width: 1200px) {
  :deep(.el-table .cell) {
    padding: 14px 0;
    font-size: 15px;
  }
}

/* 表格水平滚动，避免列重叠 */
:deep(.el-table__body-wrapper) {
  overflow-x: auto;
}
</style>
