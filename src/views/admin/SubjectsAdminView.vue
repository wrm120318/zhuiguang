<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const subjects = ref<any[]>([])
const loading = ref(false)
const editVisible = ref(false)
const editForm = ref<any>({})

async function load() {
  loading.value = true
  try {
    subjects.value = (await api.subjects()) as any
  } finally { loading.value = false }
}
onMounted(load)

function openCreate() {
  editForm.value = {
    name: '', slug: '', icon: '📚', color: '#f59e0b', description: '',
    displayOrder: subjects.value.length + 1,
    modules: { announcement: true, resources: true, articles: true, query: false, quiz: false, leaderboard: true },
    announcement: '',
  }
  editVisible.value = true
}

function openEdit(s: any) {
  editForm.value = {
    id: s.id,
    name: s.name, slug: s.slug, icon: s.icon, color: s.color,
    description: s.description || '', displayOrder: s.display_order || 0,
    modules: s.modules || { announcement: true, resources: true, articles: false, query: false, quiz: false, leaderboard: true },
    announcement: s.announcement || '',
  }
  editVisible.value = true
}

async function saveSubject() {
  const f = editForm.value
  if (!f.name || !f.slug) { ElMessage.warning('请填写学科名称和标识'); return }
  try {
    if (f.id) {
      await api.updateSubject(f.id, {
        name: f.name, icon: f.icon, color: f.color, description: f.description,
        displayOrder: f.displayOrder, modules: f.modules, announcement: f.announcement,
      })
      ElMessage.success('已更新')
    } else {
      await api.createSubject({
        name: f.name, slug: f.slug, icon: f.icon, color: f.color,
        description: f.description, displayOrder: f.displayOrder,
        modules: f.modules, announcement: f.announcement,
      })
      ElMessage.success('已创建')
    }
    editVisible.value = false
    await load()
  } catch { /* */ }
}

async function deleteSubject(s: any) {
  try {
    await ElMessageBox.confirm(`确定删除学科「${s.name}」？该学科下的所有美文和资料也将被删除。`, '删除学科', { type: 'error' })
    await api.deleteSubject(s.id)
    ElMessage.success('学科已删除')
    await load()
  } catch { /* */ }
}

const iconPresets = ['📚', '📖', '📐', '🌍', '🔬', '⚗️', '🧬', '🏛️', '💻', '🎨', '🎭', '📊', '📝', '🔢', '💡', '🎯']
const colorPresets = ['#f59e0b', '#eab308', '#f97316', '#fbbf24', '#d97706', '#fde047', '#a16207', '#fdba74', '#fb923c', '#fcd34d']
const moduleDefs = [
  { key: 'announcement', label: '公告栏', desc: '学科动态发布', icon: 'Promotion' },
  { key: 'resources', label: '资料共享', desc: '课件与素材', icon: 'Files' },
  { key: 'articles', label: '美文共赏', desc: '优秀文章', icon: 'Notebook' },
  { key: 'query', label: '数据查询', desc: '成绩与统计', icon: 'Search' },
  { key: 'quiz', label: '题库自测', desc: '练习与测验', icon: 'EditPen' },
  { key: 'leaderboard', label: '学科榜', desc: '贡献排行', icon: 'Trophy' },
]
</script>

<template>
  <div>
    <div class="head">
      <h1 class="dh-title"><ZgGlyph emoji="📚" /> 学科管理</h1>
      <el-button type="primary" @click="openCreate">+ 新建学科</el-button>
    </div>

    <div class="table-wrap glass">
      <el-table :data="subjects" style="width:100%" v-loading="loading">
        <el-table-column label="ID" width="60" prop="id" />
        <el-table-column label="图标" width="80">
          <template #default="{ row }"><span style="font-size:24px"><ZgGlyph :emoji="row.icon" /></span></template>
        </el-table-column>
        <el-table-column label="名称" width="120">
          <template #default="{ row }">{{ row.name }} <span class="slug">{{ row.slug }}</span></template>
        </el-table-column>
        <el-table-column label="颜色" width="100">
          <template #default="{ row }"><span class="color-dot" :style="{background: row.color}"></span> {{ row.color }}</template>
        </el-table-column>
        <el-table-column label="描述" min-width="150" prop="description" />
        <el-table-column label="排序" width="80" prop="display_order" />
        <el-table-column label="模块" min-width="240">
          <template #default="{ row }">
            <span v-for="(v, k) in row.modules" :key="k" v-show="v" class="mod-chip">{{ {announcement:'公告',resources:'资料',articles:'美文',query:'查询',quiz:'题库',leaderboard:'排行'}[k] }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button text size="small" @click="openEdit(row)">编辑</el-button>
            <el-button text size="small" type="danger" @click="deleteSubject(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editVisible" width="560px">
      <template #header>
        <div class="dlg-head"><span class="dlg-bar"></span><ZgGlyph emoji="📚" /><span>{{ editForm.id ? '编辑学科' : '新建学科' }}</span></div>
      </template>
      <el-form label-position="top">
        <el-form-item label="学科名称"><el-input v-model="editForm.name" placeholder="如：物理" /></el-form-item>
        <el-form-item label="标识 slug"><el-input v-model="editForm.slug" placeholder="英文标识，如：physics" :disabled="!!editForm.id" /></el-form-item>
        <el-form-item label="图标">
          <div class="preset-row">
            <span v-for="i in iconPresets" :key="i" class="preset" :class="{on: editForm.icon === i}" @click="editForm.icon = i"><ZgGlyph :emoji="i" /></span>
          </div>
        </el-form-item>
        <el-form-item label="主色调">
          <div class="color-row">
            <el-color-picker v-model="editForm.color" />
            <div class="preset-row" style="margin-left:12px">
              <span v-for="c in colorPresets" :key="c" class="sw" :style="{background: c}" @click="editForm.color = c"></span>
            </div>
          </div>
        </el-form-item>
        <el-form-item label="描述"><el-input v-model="editForm.description" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="公告"><el-input v-model="editForm.announcement" type="textarea" :rows="2" placeholder="学科公告内容" /></el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="editForm.displayOrder" :min="0" controls-position="right" />
        </el-form-item>
        <el-form-item label="模块开关">
          <div class="mod-grid">
            <div v-for="m in moduleDefs" :key="m.key" class="mod-card" :class="{on: editForm.modules?.[m.key]}" @click="editForm.modules[m.key] = !editForm.modules?.[m.key]">
              <el-icon class="mc-ico"><component :is="m.icon" /></el-icon>
              <div class="mc-body">
                <div class="mc-title">{{ m.label }}</div>
                <div class="mc-desc">{{ m.desc }}</div>
              </div>
              <el-switch :model-value="editForm.modules?.[m.key]" @change="(v:boolean) => { editForm.modules[m.key] = v }" @click.stop />
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible=false">取消</el-button>
        <el-button type="primary" @click="saveSubject">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.dh-title { font-size:24px; font-weight:800; }
.dlg-head { display:flex; align-items:center; gap:10px; font-size:var(--zg-fs-lg); font-weight:800; }
.dlg-bar { width:4px; height:20px; border-radius:4px; background:linear-gradient(var(--zg-accent), var(--zg-primary)); }
.table-wrap { padding:8px; overflow-x:auto; }
.slug { font-size:12px; color:var(--zg-text-dim); margin-left:6px; }
.color-dot { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:6px; vertical-align:middle; }
.mod-chip { display:inline-block; padding:2px 8px; border-radius:6px; background:rgba(245,158,11,.15); color:var(--zg-accent); font-size:12px; margin-right:4px; }
.preset-row { display:flex; flex-wrap:wrap; gap:6px; }
.preset { width:36px; height:36px; display:flex; align-items:center; justify-content:center; border-radius:8px; cursor:pointer; background:rgba(245,158,11,.06); border:2px solid transparent; font-size:20px; }
.preset.on { border-color:var(--zg-primary); background:rgba(245,158,11,.2); }
.color-row { display:flex; align-items:center; }
.sw { width:24px; height:24px; border-radius:6px; cursor:pointer; border:1px solid rgba(245,158,11,.3); }
.mod-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; width:100%; }
.mod-card { display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:12px; background:rgba(245,158,11,.06); border:1px solid transparent; transition:all .2s cubic-bezier(.2,.8,.2,1); cursor:pointer; }
.mod-card:hover { transform:translateY(-2px); border-color:rgba(245,158,11,.3); box-shadow:0 6px 18px rgba(245,158,11,.12); }
.mod-card.on { border-color:var(--zg-primary); background:rgba(245,158,11,.12); }
.mc-ico { font-size:22px; color:var(--zg-primary); }
.mc-body { flex:1; }
.mc-title { font-weight:600; font-size:var(--zg-fs-sm); }
.mc-desc { font-size:var(--zg-fs-xs); color:var(--zg-text-dim); }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .head { flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .head .el-button { min-width: auto; padding: 8px 14px; height: 34px; font-size: 13px; }
  .table-wrap { padding: 6px; overflow-x: auto; }
  .mod-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .mod-item { padding: 6px 10px; }
  .preset { width: 32px; height: 32px; font-size: 18px; }
  .sw { width: 20px; height: 20px; }
}

@media (min-width: 1200px) {
  .dh-title { font-size: 28px; }
  .head { margin-bottom: 28px; }
  .table-wrap { padding: 14px; }
  .mod-grid { grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .mod-item { padding: 12px 16px; border-radius: 12px; transition: all .2s ease; }
  .mod-item:hover { background: rgba(245,158,11,.12); transform: translateY(-2px); }
  .preset-row { gap: 10px; }
  .preset { width: 40px; height: 40px; font-size: 22px; transition: all .2s ease; }
  .preset:hover { transform: scale(1.1); background: rgba(245,158,11,.12); }
}

:deep(.el-dialog) {
  width: 560px;
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
