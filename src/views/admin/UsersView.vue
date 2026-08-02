<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api'
import { useDataStore } from '@/store/data'
import { ElMessage, ElMessageBox } from 'element-plus'

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
</script>

<template>
  <div>
    <div class="head">
      <h1 class="dh-title">用户管理</h1>
      <div class="head-actions">
        <el-input v-model="search" placeholder="搜索姓名/用户名/邮箱" style="width:240px" clearable />
        <el-button type="primary" @click="openAdd">+ 新建用户</el-button>
      </div>
    </div>

    <div class="table-wrap glass">
      <el-table :data="filtered" style="width:100%">
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
        <el-table-column label="等级" width="90"><template #default="{ row }">Lv.{{ row.level }}</template></el-table-column>
        <el-table-column label="经验" width="100"><template #default="{ row }">{{ row.exp }}</template></el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }"><el-tag size="small" :type="row.status==='active'?'success':'danger'">{{ row.status === 'active' ? '正常' : '禁用' }}</el-tag></template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
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
  :deep(.el-table__fixed-right .cell) {
    padding: 8px 0 !important;
  }
  :deep(.el-table .cell .el-button) {
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    margin: 2px 0;
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
</style>
