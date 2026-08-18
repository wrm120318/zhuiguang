<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const data = useDataStore()
const user = useUserStore()

const task = ref<any>(null)
const myRows = ref<any[]>([])
const headers = ref<string[]>([])
const queried = ref(false)
const querying = ref(false)

const subject = () => data.subjectById(task.value?.subject_id)

async function load() {
  if (!data.subjects.length) await data.fetchSubjects()
  try {
    task.value = await api.queryTask(Number(route.params.taskId))
  } catch { /* */ }
}
onMounted(load)

async function doQuery() {
  if (!task.value) return
  querying.value = true
  try {
    const r: any = await api.doQuery(task.value.id)
    headers.value = r.headers || []
    myRows.value = r.myRows || []
    queried.value = true
    if (myRows.value.length === 0) {
      ElMessage.warning('未查询到您的数据，请联系任课教师核实姓名是否匹配。')
    } else {
      ElMessage.success(`已为您匹配 ${myRows.value.length} 条记录`)
    }
  } catch { /* */ } finally { querying.value = false }
}

function exportData() {
  if (!myRows.value.length) return
  import('xlsx').then((XLSX) => {
    const ws = XLSX.utils.json_to_sheet(myRows.value, { header: headers.value })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '我的数据')
    XLSX.writeFile(wb, `${task.value.title}_我的数据.xlsx`)
  })
}

// 超管或任务创建者可编辑任务 / 导出整任务数据
const canEdit = computed(() =>
  !!task.value && (user.isSuperAdmin || task.value.creator_id === user.current?.id)
)

const editVisible = ref(false)
const editSaving = ref(false)
const editForm = ref({ title: '', note: '', validUntil: '' })

function openEdit() {
  if (!task.value) return
  editForm.value = {
    title: task.value.title || '',
    note: task.value.note || '',
    validUntil: task.value.valid_until || '',
  }
  editVisible.value = true
}

async function saveEdit() {
  if (!task.value) return
  editSaving.value = true
  try {
    await api.updateQueryTask(task.value.id, {
      title: editForm.value.title,
      note: editForm.value.note,
      validUntil: editForm.value.validUntil,
    })
    ElMessage.success('查询任务已更新')
    editVisible.value = false
    await load()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '更新失败')
  } finally {
    editSaving.value = false
  }
}

const downloading = ref(false)

// 导出整任务 Excel（超管下载所有人的，教师下载自己发布的）
async function downloadTaskExcel() {
  if (!task.value) return
  downloading.value = true
  try {
    const blob: any = await api.exportQueryTask(task.value.id)
    const fileBlob = new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(fileBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${task.value.title}_查询数据.xlsx`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('Excel 已下载')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '下载失败')
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <div class="page zg-container" v-if="task">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>

    <div class="q-hero glass-strong">
      <div class="qh-subj" :style="{ color: subject()?.color }"><ZgGlyph :emoji="subject()?.icon" /> {{ subject()?.name }}</div>
      <h1 class="qh-title">{{ task.title }}</h1>
      <div class="qh-meta">
        <span>发布人：{{ task.creator_name }}</span>
        <span class="dot">·</span>
        <span>{{ task.created_at }}</span>
        <span class="dot">·</span>
        <span>有效期至 {{ task.valid_until }}</span>
      </div>
      <p class="qh-note">{{ task.note }}</p>
      <div class="qh-flags">
        <span class="flag"><ZgGlyph emoji="🔒" /> 行级隐私过滤</span>
        <span class="flag" v-if="task.show_comment"><ZgGlyph emoji="💬" /> 显示评语</span>
        <span class="flag" v-else><ZgGlyph emoji="🚫" /> 隐藏评语</span>
        <span class="flag" v-if="!task.allow_export"><ZgGlyph emoji="🚫" /> 禁止导出</span>
      </div>
      <div class="qh-actions" v-if="canEdit">
        <el-button size="small" @click="openEdit"><ZgGlyph emoji="✏️" /> 编辑任务</el-button>
        <el-button size="small" type="success" plain :loading="downloading" @click="downloadTaskExcel"><ZgGlyph emoji="📥" /> 导出全部数据</el-button>
      </div>
    </div>

    <!-- 隐私说明 -->
    <div class="privacy glass">
      <div class="prv-icon"><ZgGlyph emoji="🛡️" /></div>
      <div class="prv-text">
        <div class="prv-title">数据查询隐私保护</div>
        <div class="prv-desc">系统将严格依据您当前登录身份（<b>{{ user.current?.realName }}</b>）与查询任务中的「{{ task.match_field }}」字段进行匹配，仅返回 <b>标题行</b> 与 <b>您本人对应的数据行</b>，无法查看其他同学数据。后端行级过滤，前端不接收他人数据。</div>
      </div>
    </div>

    <!-- 查询入口 -->
    <div class="query-action" v-if="!queried">
      <el-button type="primary" size="large" round :loading="querying" @click="doQuery"><ZgGlyph emoji="🔐" /> 点击查询我的数据</el-button>
      <span class="qa-hint">将以「{{ user.current?.realName }}」身份匹配</span>
    </div>

    <!-- 查询结果 -->
    <div v-else class="result-wrap">
      <div class="result-head">
        <div class="section-title">我的查询结果</div>
        <el-button v-if="task.allow_export && myRows.length" text size="small" @click="exportData"><ZgGlyph emoji="📥" /> 导出</el-button>
      </div>

      <div v-if="myRows.length" class="result-table glass">
        <table>
          <thead>
            <tr><th v-for="h in headers" :key="h">{{ h }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in myRows" :key="i">
              <td v-for="h in headers" :key="h" :class="{ score: h === '总分', grade: h === '等第', comment: h === '评语' }">{{ row[h] }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <el-empty v-else description="未查询到您的数据" />

      <div class="history" v-if="myRows.length > 1">
        <div class="hist-title"><ZgGlyph emoji="📊" /> 历史记录</div>
        <div class="hist-tip">检测到您有 {{ myRows.length }} 条记录（如同一人多次测试），已全部展示于上方表格。</div>
      </div>
    </div>
  </div>
  <el-empty v-else description="查询任务不存在" style="margin-top:80px" />

  <!-- 编辑查询任务对话框（仅超管 / 创建者） -->
  <el-dialog v-model="editVisible" title="编辑查询任务" width="520px" :close-on-click-modal="false">
    <el-form label-width="80px">
      <el-form-item label="标题">
        <el-input v-model="editForm.title" placeholder="查询任务标题" />
      </el-form-item>
      <el-form-item label="说明">
        <el-input v-model="editForm.note" type="textarea" :rows="3" placeholder="任务说明" />
      </el-form-item>
      <el-form-item label="有效期">
        <el-date-picker
          v-model="editForm.validUntil"
          type="date"
          value-format="YYYY-MM-DD"
          style="width:100%"
          placeholder="选择有效期"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editVisible = false">取消</el-button>
      <el-button type="primary" :loading="editSaving" @click="saveEdit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.back { display:inline-block; margin:16px 0 0; color:var(--zg-text-dim); cursor:pointer; }
.q-hero { padding:32px; margin-top:8px; }
.qh-subj { font-size:13px; font-weight:600; }
.qh-title { font-size:28px; font-weight:800; margin:6px 0 10px; }
.qh-meta { color:var(--zg-text-dim); font-size:13px; display:flex; gap:8px; flex-wrap:wrap; }
.dot { opacity:.5; }
.qh-note { margin:14px 0; color:var(--zg-text); line-height:1.7; }
.qh-flags { display:flex; gap:8px; flex-wrap:wrap; }
.qh-actions { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
.flag { padding:4px 10px; border-radius:8px; font-size:12px; background:rgba(245,158,11,.06); color:var(--zg-text-dim); }
.privacy { display:flex; gap:16px; padding:20px 24px; margin-top:20px; border:1px solid rgba(245,158,11,.25); }
.prv-icon { font-size:28px; }
.prv-title { font-weight:700; color:var(--zg-accent); }
.prv-desc { font-size:13px; color:var(--zg-text-dim); line-height:1.7; margin-top:4px; }
.prv-desc b { color:var(--zg-text); }
.query-action { display:flex; flex-direction:column; align-items:center; gap:12px; margin:40px 0; }
.qa-hint { font-size:13px; color:var(--zg-text-dim); }
.result-wrap { margin-top:20px; }
.result-head { display:flex; justify-content:space-between; align-items:center; }
.result-table { padding:8px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { padding:14px 18px; text-align:left; border-bottom:1px solid rgba(245,158,11,.06); }
th { font-size:13px; color:var(--zg-text-dim); font-weight:600; white-space:nowrap; }
td { font-size:15px; }
td.score { font-weight:800; color:var(--zg-accent); font-size:18px; }
td.grade { font-weight:700; }
td.comment { color:var(--zg-text-dim); max-width:300px; }
.history { margin-top:20px; padding:16px 20px; border-radius:12px; background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.2); }
.hist-title { font-weight:700; }
.hist-tip { font-size:13px; color:var(--zg-text-dim); margin-top:4px; }
@media (max-width:768px){
  .q-hero{padding:20px;}
  .qh-title{font-size:22px;}
  .privacy{flex-direction:column; gap:8px; padding:16px;}
  th,td{padding:10px 12px; font-size:13px;}
  td.score{font-size:15px;}
}
</style>
