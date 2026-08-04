<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import * as XLSX from 'xlsx'
import { useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const data = useDataStore()
const user = useUserStore()

const form = ref({
  title: '',
  subjectId: 1,
  classId: 1,
  note: '',
  validUntil: '2026-08-31',
  showComment: true,
  allowExport: false,
  matchField: '',
})
const headers = ref<string[]>([])
const rows = ref<Record<string, string | number>[]>([])
const fileName = ref('')
const excelUploading = ref(false)
const publishing = ref(false)
const existing = ref<any[]>([])

// 需求1：教师只能发布自己任教学科的查询任务；超管可看所有学科
const subjectOptions = computed(() => {
  const all = data.subjects
  if (user.isTeacher && user.teachingSubjects?.length) {
    // 教师：只显示自己的任教学科
    return all.filter(s => user.teachingSubjects.includes(Number(s.id)))
  }
  return all
})

async function load() {
  if (!data.subjects.length) await data.fetchSubjects()
  if (!data.classes.length) await data.fetchClasses()
  // 需求1：如果是教师，默认学科设为自己任教学科
  if (user.isTeacher && user.teachingSubjects?.length) {
    form.value.subjectId = Number(user.teachingSubjects[0])
  } else if (subjectOptions.value.length && !subjectOptions.value.find(s => s.id === form.value.subjectId)) {
    form.value.subjectId = subjectOptions.value[0].id
  }
  const r: any = await api.queryTasks()
  existing.value = r.data || r
}
onMounted(load)

function downloadTemplate() {
  const aoa = [
    ['姓名', '学号', '分数', '等第', '评语'],
    ['张三', '20240001', 95, 'A', '表现优秀'],
    ['李四', '20240002', 82, 'B', '继续努力'],
  ]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 30 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '成绩模板')
  XLSX.writeFile(wb, '追光_数据查询模板.xlsx')
  ElMessage.success('模板已下载，第一列为「姓名」用于匹配学生')
}

// 使用 http-request 上传模式：前端本地解析 Excel，不走服务器
async function handleExcelUpload(uploadRequest: any) {
  excelUploading.value = true
  try {
    const f = uploadRequest.file as File
    if (!f) throw new Error('未获取到文件')
    fileName.value = f.name
    const ab = await f.arrayBuffer()
    const wb = XLSX.read(ab, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json<Record<string, string | number>>(ws, { defval: '' })
    if (!json.length) throw new Error('未解析到数据')
    headers.value = Object.keys(json[0])
    rows.value = json
    form.value.matchField = headers.value[0]
    ElMessage.success(`解析成功：${headers.value.length} 列，${rows.value.length} 行`)
  } catch (e: any) {
    console.error('[Excel解析失败]', e)
    ElMessage.error(e?.message || 'Excel 解析失败，请检查文件格式')
  } finally {
    excelUploading.value = false
  }
}

const canPublish = computed(() => form.value.title && headers.value.length && form.value.matchField)

async function publish() {
  if (!canPublish.value) return
  publishing.value = true
  try {
    const r: any = await api.createQueryTask({
      subjectId: form.value.subjectId,
      classId: form.value.classId,
      title: form.value.title,
      note: form.value.note,
      validUntil: form.value.validUntil,
      showComment: form.value.showComment,
      allowExport: form.value.allowExport,
      headers: [...headers.value],
      rows: JSON.parse(JSON.stringify(rows.value)),
      matchField: form.value.matchField,
    })
    ElMessage.success('查询任务已发布，对应班级学生可见')
    router.push(`/query/${r.id}`)
  } catch { /* */ } finally { publishing.value = false }
}

// 需求1：超管/教师下载查询任务的Excel
async function downloadTaskExcel(t: any) {
  try {
    const resp: any = await api.exportQueryTask(t.id)
    const blob = new Blob([resp.data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${t.title}_查询数据.xlsx`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('Excel 已下载')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '下载失败')
  }
}

async function deleteTask(t: any) {
  try {
    await ElMessageBox.confirm(`确定删除查询任务「${t.title}」？此操作不可恢复。`, '删除', { type: 'error' })
    await api.deleteQueryTask(t.id)
    existing.value = existing.value.filter(x => x.id !== t.id)
    ElMessage.success('已删除')
  } catch {}
}
</script>

<template>
  <div>
    <h1 class="dh-title">📈 数据查询任务</h1>
    <p class="tip">教师上传 Excel 成绩数据，学生仅可查询本人对应行（行级隐私过滤）。</p>

    <div class="steps glass">
      <div class="step"><span class="s-no">1</span><div><div class="s-title">下载模板</div><div class="s-desc">含表头与示例</div></div></div>
      <div class="step"><span class="s-no">2</span><div><div class="s-title">填入数据</div><div class="s-desc">第一列为姓名/学号</div></div></div>
      <div class="step"><span class="s-no">3</span><div><div class="s-title">上传解析</div><div class="s-desc">前端预览确认</div></div></div>
      <div class="step"><span class="s-no">4</span><div><div class="s-title">配置发布</div><div class="s-desc">学生即可查询</div></div></div>
    </div>

    <div class="create-row">
      <div class="form-panel glass">
        <div class="fp-title">新建查询任务</div>
        <el-form label-width="100px">
          <el-form-item label="任务标题"><el-input v-model="form.title" placeholder="如：圆锥曲线单元测验" /></el-form-item>
          <el-form-item label="学科">
            <el-select v-model="form.subjectId" style="width:100%" :disabled="user.isTeacher">
              <el-option v-for="s in subjectOptions" :key="s.id" :label="`${s.icon} ${s.name}`" :value="s.id" />
            </el-select>
            <div v-if="user.isTeacher" class="hint">（教师账号只能发布自己任教学科的数据查询）</div>
          </el-form-item>
          <el-form-item label="班级">
            <el-select v-model="form.classId" style="width:100%">
              <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="说明"><el-input v-model="form.note" type="textarea" :rows="2" /></el-form-item>
          <el-form-item label="有效期"><el-date-picker v-model="form.validUntil" type="date" value-format="YYYY-MM-DD" style="width:100%" /></el-form-item>
          <el-form-item label="匹配字段">
            <el-select v-model="form.matchField" style="width:100%" placeholder="选择用于匹配学生姓名/学号的列">
              <el-option v-for="h in headers" :key="h" :label="h" :value="h" />
            </el-select>
            <div class="hint">系统将用此列与登录学生姓名严格匹配，仅返回本人行。</div>
          </el-form-item>
          <el-form-item label="选项">
            <div class="opts">
              <el-checkbox v-model="form.showComment">显示评语</el-checkbox>
              <el-checkbox v-model="form.allowExport">允许导出</el-checkbox>
            </div>
          </el-form-item>
          <el-form-item label="数据文件">
            <div class="file-row">
              <el-button @click="downloadTemplate">📥 下载模板</el-button>
              <el-upload
                :http-request="handleExcelUpload"
                :show-file-list="false"
                accept=".xlsx,.xls"
              >
                <el-button type="primary" :loading="excelUploading">📤 上传 Excel</el-button>
              </el-upload>
              <span v-if="fileName" class="file-name">✅ {{ fileName }}</span>
            </div>
          </el-form-item>
        </el-form>
        <el-button type="primary" size="large" round :loading="publishing" :disabled="!canPublish" @click="publish" style="width:100%">发布查询任务</el-button>
      </div>

      <div class="preview-panel glass">
        <div class="pp-title">解析预览 <span v-if="headers.length" class="pp-count">{{ rows.length }} 行 · {{ headers.length }} 列</span></div>
        <div v-if="headers.length" class="preview-table">
          <table>
            <thead><tr><th v-for="h in headers" :key="h" :class="{ match: h === form.matchField }">{{ h }}{{ h === form.matchField ? ' 🔑' : '' }}</th></tr></thead>
            <tbody>
              <tr v-for="(r, i) in rows.slice(0, 6)" :key="i"><td v-for="h in headers" :key="h">{{ r[h] }}</td></tr>
            </tbody>
          </table>
          <div v-if="rows.length > 6" class="more-rows">… 还有 {{ rows.length - 6 }} 行（学生端仅可见本人行）</div>
        </div>
        <el-empty v-else description="上传 Excel 后在此预览解析结果" />
      </div>
    </div>

    <div class="existing">
      <div class="section-title">我发布的查询任务 <span v-if="user.isSuperAdmin" class="st-sub">（超管可查看/下载所有任务）</span></div>
      <div class="ex-list glass">
        <div v-for="t in existing" :key="t.id" class="ex-item">
          <div class="ex-main" @click="router.push(`/query/${t.id}`)">
            <div class="ex-title">{{ t.title }}</div>
            <div class="ex-meta">{{ data.subjectById(t.subject_id)?.name }} · {{ data.classById(t.class_id)?.name }} · 创建人：{{ t.creator_name }} · {{ t.created_at }}</div>
          </div>
          <div class="ex-actions">
            <el-button size="small" type="primary" plain @click.stop="downloadTaskExcel(t)">📥 下载Excel</el-button>
            <el-button v-if="user.isSuperAdmin || t.creator_id===user.current?.id" size="small" type="danger" plain @click.stop="deleteTask(t)">删除</el-button>
          </div>
        </div>
        <el-empty v-if="!existing.length" description="暂无任务" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.dh-title { font-size:24px; font-weight:800; }
.tip { color:var(--zg-text-dim); font-size:13px; margin:6px 0 20px; }
.steps { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; padding:20px; margin-bottom:24px; }
.step { display:flex; gap:12px; align-items:center; }
.s-no { width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,var(--zg-primary),var(--zg-accent)); display:flex; align-items:center; justify-content:center; font-weight:700; flex-shrink:0; color:var(--zg-text); }
.s-title { font-weight:600; font-size:14px; }
.s-desc { font-size:12px; color:var(--zg-text-dim); }
.create-row { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
.form-panel { padding:24px; }
.fp-title { font-weight:700; font-size:16px; margin-bottom:16px; }
.hint { font-size:12px; color:var(--zg-text-dim); margin-top:4px; }
.opts { display:flex; gap:20px; }
.file-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.file-name { font-size:13px; color:#34d399; }
.preview-panel { padding:20px; height:fit-content; }
.pp-title { font-weight:700; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; }
.pp-count { font-size:12px; color:var(--zg-text-dim); font-weight:400; }
.preview-table { overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { padding:10px 12px; text-align:left; border-bottom:1px solid rgba(245,158,11,.06); font-size:13px; }
th { color:var(--zg-text-dim); font-weight:600; }
th.match { color:var(--zg-accent); background:rgba(245,158,11,.1); }
.more-rows { font-size:12px; color:var(--zg-text-dim); padding:12px; text-align:center; }
.existing { margin-top:32px; }
.ex-list { padding:8px; }
.ex-item { display:flex; align-items:center; justify-content:space-between; padding:14px; border-radius:10px; cursor:pointer; }
.ex-item:hover { background:rgba(245,158,11,.06); }
.ex-title { font-weight:600; }
.ex-meta { font-size:12px; color:var(--zg-text-dim); margin-top:3px; }
.ex-go { color:var(--zg-text-dim); }
@media (max-width:980px){ .create-row{grid-template-columns:1fr;} .steps{grid-template-columns:repeat(2,1fr);} }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .tip { font-size: 12px; margin: 4px 0 14px; }
  .steps { grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 14px; margin-bottom: 16px; }
  .step { gap: 8px; }
  .s-no { width: 28px; height: 28px; font-size: 13px; }
  .s-title { font-size: 13px; }
  .s-desc { font-size: 11px; }
  .create-row { grid-template-columns: 1fr; gap: 14px; }
  .form-panel { padding: 16px; }
  .fp-title { font-size: 16px; margin-bottom: 12px; }
  .opts { flex-wrap: wrap; gap: 10px; }
  .file-row { gap: 8px; }
  .file-row .el-button { flex: 1; min-width: auto; width: 100%; }
  .form-panel > .el-button { width: 100%; height: 44px; }
  .preview-panel { padding: 14px; }
  .pp-title { flex-direction: column; align-items: flex-start; gap: 4px; font-size: 16px; }
  .preview-table { overflow-x: auto; }
  th, td { padding: 8px; font-size: 12px; }
  .more-rows { font-size: 11px; padding: 10px; }
  .existing { margin-top: 20px; }
  .section-title { font-size: 16px; margin-bottom: 10px; }
  .ex-list { padding: 6px; }
  .ex-item { padding: 12px; }
  .ex-title { font-size: 14px; }
  .ex-meta { font-size: 11px; }
}

@media (min-width: 1200px) {
  .dh-title { font-size: 30px; }
  .tip { font-size: 14px; margin: 8px 0 28px; }
  .steps { gap: 24px; padding: 32px; margin-bottom: 32px; }
  .step { gap: 16px; }
  .s-no { width: 40px; height: 40px; font-size: 18px; }
  .s-title { font-size: 16px; }
  .s-desc { font-size: 13px; }
  .create-row { gap: 32px; }
  .form-panel { padding: 32px; }
  .fp-title { font-size: 18px; margin-bottom: 20px; }
  .hint { font-size: 13px; }
  .opts { gap: 28px; }
  .file-row { gap: 16px; }
  .file-name { font-size: 14px; }
  .preview-panel { padding: 28px; }
  .pp-title { font-size: 18px; margin-bottom: 18px; }
  .pp-count { font-size: 13px; }
  th, td { padding: 14px 16px; font-size: 15px; }
  .more-rows { font-size: 13px; padding: 16px; }
  .existing { margin-top: 40px; }
  .section-title { font-size: 18px; margin-bottom: 16px; }
  .ex-list { padding: 12px; }
  .ex-item { padding: 20px; border-radius: 14px; }
  .ex-title { font-size: 16px; }
  .ex-meta { font-size: 13px; margin-top: 4px; }
}

@media (max-width: 768px) {
  :deep(.el-form-item) {
    margin-bottom: 14px;
  }
  :deep(.el-form-item__label) {
    width: 60px !important;
    font-size: 12px;
  }
  :deep(.el-checkbox) {
    width: 100%;
  }
}
.st-sub { font-size:12px; color:var(--zg-text-dim); font-weight:400; margin-left:8px; }
.ex-actions { display:flex; gap:8px; flex-shrink:0; }
.ex-main { flex:1; min-width:0; cursor:pointer; }
.ex-main:hover .ex-title { color:var(--zg-primary); }
</style>
