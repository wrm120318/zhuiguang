<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '@/api'
import { useDataStore } from '@/store/data'
import { ElMessage, ElMessageBox } from 'element-plus'

const data = useDataStore()
const classes = ref<any[]>([])
const loading = ref(false)
const editVisible = ref(false)
const editForm = ref<any>({})

async function load() {
  loading.value = true
  try {
    await data.fetchClasses()
    classes.value = data.classes
  } finally { loading.value = false }
}
onMounted(load)

function openCreate() {
  editForm.value = { name: '', grade: '', description: '' }
  editVisible.value = true
}

function openEdit(c: any) {
  editForm.value = { id: c.id, name: c.name, grade: c.grade, description: c.description || '' }
  editVisible.value = true
}

async function saveClass() {
  const f = editForm.value
  if (!f.name) { ElMessage.warning('请填写班级名称'); return }
  try {
    if (f.id) {
      await api.updateClass(f.id, { name: f.name, grade: f.grade, description: f.description })
      ElMessage.success('已更新')
    } else {
      await api.createClass({ name: f.name, grade: f.grade, description: f.description })
      ElMessage.success('已创建')
    }
    editVisible.value = false
    await load()
  } catch { /* */ }
}

async function deleteClass(c: any) {
  try {
    await ElMessageBox.confirm(`确定删除班级「${c.name}」？班级下的所有成员关系也将被删除。`, '删除班级', { type: 'error' })
    await api.deleteClass(c.id)
    ElMessage.success('班级已删除')
    await load()
  } catch { /* */ }
}
</script>

<template>
  <div>
    <div class="head">
      <h1 class="dh-title">🏫 班级管理</h1>
      <el-button type="primary" @click="openCreate">+ 新建班级</el-button>
    </div>

    <div class="table-wrap glass">
      <el-table :data="classes" style="width:100%" v-loading="loading">
        <el-table-column label="ID" width="60" prop="id" />
        <el-table-column label="班级名称" min-width="180" prop="name" />
        <el-table-column label="年级" width="120" prop="grade" />
        <el-table-column label="描述" min-width="200" prop="description" />
        <el-table-column label="创建时间" width="180" prop="created_at" />
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button text size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" type="danger" @click="deleteClass(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!classes.length && !loading" description="暂无班级，点击右上角新建" />
    </div>

    <el-dialog v-model="editVisible" :title="editForm.id ? '编辑班级' : '新建班级'" width="440px">
      <el-form label-width="80px">
        <el-form-item label="班级名称"><el-input v-model="editForm.name" placeholder="如：高二（1）班" /></el-form-item>
        <el-form-item label="年级"><el-input v-model="editForm.grade" placeholder="如：高二" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="editForm.description" type="textarea" :rows="3" placeholder="班级描述" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible=false">取消</el-button>
        <el-button type="primary" @click="saveClass">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.dh-title { font-size:24px; font-weight:800; }
.table-wrap { padding:8px; overflow-x:auto; }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .head { flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .head .el-button { min-width: auto; padding: 8px 14px; height: 34px; font-size: 13px; }
  .table-wrap { padding: 6px; overflow-x: auto; }
}

@media (min-width: 1200px) {
  .dh-title { font-size: 28px; }
  .head { margin-bottom: 28px; }
  .table-wrap { padding: 14px; }
}

:deep(.el-dialog) {
  width: 440px;
}
@media (max-width: 768px) {
  :deep(.el-dialog) {
    width: 92% !important;
    margin: 4vh auto !important;
  }
  :deep(.el-form-item__label) {
    width: 60px !important;
    font-size: 12px;
  }
  :deep(.el-table .cell) {
    padding: 8px !important;
    font-size: 12px !important;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  :deep(.el-table .cell .el-button) {
    height: 28px;
    padding: 0 8px;
    font-size: 12px;
    min-width: auto;
  }
}
@media (min-width: 1200px) {
  :deep(.el-table .cell) {
    padding: 14px 0;
    font-size: 15px;
  }
}
</style>
