<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'
import { useUserStore } from '@/store/user'

const user = useUserStore()
const isSuperAdmin = computed(() => user.isSuperAdmin)

const tab = ref<'article' | 'resource'>('article')
const articles = ref<any[]>([])
const resources = ref<any[]>([])

const pendingArticles = computed(() => articles.value.filter(a => a.status === 'pending' || a.status === 'pending_student'))
const pendingResources = computed(() => resources.value.filter(r => r.status === 'pending'))

function statusText(s: string) {
  switch (s) {
    case 'approved': return '已通过'
    case 'pending': return '待超管审核'
    case 'pending_student': return '待学生确认'
    case 'rejected': return '已驳回'
    case 'rejected_student': return '学生已拒绝'
    default: return s
  }
}
function statusType(s: string) {
  switch (s) {
    case 'approved': return 'success'
    case 'pending': return 'warning'
    case 'pending_student': return 'info'
    case 'rejected_student': return 'info'
    case 'rejected': return 'danger'
    default: return 'info'
  }
}

async function load() {
  const [arts, ress] = await Promise.all([
    api.articles({}) as any,
    api.resources({}) as any,
  ])
  let artList = arts || []
  let resList = ress || []
  // 教师仅审核本学科美文和资料（按 teachingSubjects 客户端过滤）
  if (user.isTeacher && !user.isSuperAdmin && user.teachingSubjects.length) {
    artList = artList.filter((a: any) => user.teachingSubjects.includes(Number(a.subject_id)))
    resList = resList.filter((r: any) => user.teachingSubjects.includes(Number(r.subject_id)))
  }
  articles.value = artList
  resources.value = resList
}
onMounted(load)

async function approveArticle(id: number) {
  try {
    await api.auditArticle(id, 'approved')
    const a = articles.value.find(x => x.id === id); if (a) a.status = 'approved'
    ElMessage.success('已通过审核，作者 +20 经验')
  } catch { /* */ }
}
async function rejectArticle(id: number) {
  await api.auditArticle(id, 'rejected')
  const a = articles.value.find(x => x.id === id); if (a) a.status = 'rejected'
  ElMessage.success('已驳回')
}
async function adminConfirmArticle(id: number) {
  try {
    await api.adminConfirmArticle(id)
    const a = articles.value.find(x => x.id === id); if (a) a.status = 'approved'
    ElMessage.success('已代为确认，美文已发布')
    // 代确认成功后重新加载审核列表，确保状态与徽标数同步
    await load()
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '代确认失败') }
}
async function deleteArticleItem(id: number) {
  try {
    await ElMessageBox.confirm('确定删除该美文？此操作不可恢复。', '删除', { type: 'error' })
    await api.deleteArticle(id)
    articles.value = articles.value.filter(a => a.id !== id)
    ElMessage.success('已删除')
  } catch { /* */ }
}
async function approveResource(id: number) {
  await api.auditResource(id, 'approved')
  const r = resources.value.find(x => x.id === id); if (r) r.status = 'approved'
  ElMessage.success('已通过，上传者 +15 经验')
}
async function rejectResource(id: number) {
  await api.auditResource(id, 'rejected')
  const r = resources.value.find(x => x.id === id); if (r) r.status = 'rejected'
  ElMessage.success('已驳回')
}
async function deleteResourceItem(id: number) {
  try {
    await ElMessageBox.confirm('确定删除该资料及关联文件？此操作不可恢复。', '删除', { type: 'error' })
    await api.deleteResource(id)
    resources.value = resources.value.filter(r => r.id !== id)
    ElMessage.success('已删除')
  } catch { /* */ }
}

async function batchApprove() {
  if (tab.value === 'article') {
    for (const a of pendingArticles.value) await approveArticle(a.id)
  } else {
    for (const r of pendingResources.value) await approveResource(r.id)
  }
  ElMessage.success('已批量通过')
}
</script>

<template>
  <div>
    <div class="head">
      <h1 class="dh-title">内容审核中心</h1>
      <div>
        <el-button type="primary" :disabled="(tab==='article'?pendingArticles:pendingResources).length===0" @click="batchApprove">批量通过</el-button>
      </div>
    </div>

    <div class="sub-nav glass">
      <div class="sub-tab" :class="{on:tab==='article'}" @click="tab='article'">美文 ({{ pendingArticles.length }})</div>
      <div class="sub-tab" :class="{on:tab==='resource'}" @click="tab='resource'">资料 ({{ pendingResources.length }})</div>
    </div>

    <div class="audit-list">
      <template v-if="tab==='article'">
        <div v-for="a in articles" :key="a.id" class="audit-card glass" :class="{ 'au-proxy-card': a.actual_user_id }">
          <img :src="a.cover" class="au-cover" />
          <div class="au-body">
            <div class="au-title">{{ a.title }}</div>
            <div class="au-meta">{{ a.author }} · {{ a.category }} · {{ a.created_at }}
              <span v-if="a.actual_user_id" class="au-proxy">
                🧑‍🎓 实际作者：<b>{{ a.actual_user_name || '学生#'+a.actual_user_id }}</b>
                · 代发教师：{{ a.creator_name }}
              </span>
              <el-tag size="small" :type="statusType(a.status)" style="margin-left:8px">
                {{ statusText(a.status) }}
              </el-tag>
            </div>
            <div class="au-rec">{{ a.recommendation }}</div>
            <div class="au-content" v-html="md(a.content)"></div>
          </div>
          <div class="au-actions">
            <template v-if="a.status === 'pending'">
              <el-button type="primary" size="small" @click="approveArticle(a.id)">通过 +20EXP</el-button>
              <el-button size="small" @click="rejectArticle(a.id)">驳回</el-button>
            </template>
            <template v-else-if="a.status === 'pending_student'">
              <el-tag type="info" size="small" effect="dark">等待学生确认</el-tag>
              <el-button v-if="isSuperAdmin" type="warning" size="small" @click="adminConfirmArticle(a.id)">超管代确认</el-button>
            </template>
            <el-button size="small" type="danger" plain @click="deleteArticleItem(a.id)">删除</el-button>
          </div>
        </div>
        <el-empty v-if="!articles.length" description="暂无美文" />
      </template>

      <template v-else>
        <div v-for="r in resources" :key="r.id" class="audit-card glass">
          <div class="au-icon">{{ r.file_type === 'pdf' ? '📄' : r.file_type === 'ppt' ? '📊' : r.file_type === 'word' ? '📝' : r.file_type === 'excel' ? '📗' : r.file_type === 'video' ? '🎬' : '📦' }}</div>
          <div class="au-body">
            <div class="au-title">{{ r.title }}</div>
            <div class="au-meta">{{ r.category }} · {{ r.file_name }} · 上传人：{{ r.creator_name }}
              <el-tag size="small" :type="r.status==='approved'?'success':r.status==='pending'?'warning':'danger'" style="margin-left:8px">
                {{ r.status === 'approved' ? '已通过' : r.status === 'pending' ? '待审核' : '已驳回' }}
              </el-tag>
            </div>
            <div class="au-rec">{{ r.description }}</div>
          </div>
          <div class="au-actions">
            <template v-if="r.status === 'pending'">
              <el-button type="primary" size="small" @click="approveResource(r.id)">通过 +15EXP</el-button>
              <el-button size="small" @click="rejectResource(r.id)">驳回</el-button>
            </template>
            <el-button size="small" type="danger" plain @click="deleteResourceItem(r.id)">删除</el-button>
          </div>
        </div>
        <el-empty v-if="!resources.length" description="暂无资料" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
.dh-title { font-size:24px; font-weight:800; }
.sub-nav { display:flex; gap:6px; padding:8px; margin-bottom:20px; width:fit-content; }
.sub-tab { padding:8px 18px; border-radius:10px; cursor:pointer; color:var(--zg-text-dim); }
.sub-tab.on { color:var(--zg-text); background:var(--zg-primary); }
.audit-list { display:flex; flex-direction:column; gap:16px; }
.audit-card { display:flex; gap:16px; padding:16px; }
.au-cover { width:120px; height:90px; object-fit:cover; border-radius:10px; flex-shrink:0; }
.au-icon { width:80px; height:80px; border-radius:12px; background:rgba(245,158,11,.06); display:flex; align-items:center; justify-content:center; font-size:36px; flex-shrink:0; }
.au-body { flex:1; min-width:0; }
.au-title { font-weight:700; font-size:16px; }
.au-meta { font-size:12px; color:var(--zg-text-dim); margin:4px 0; }
.au-rec { font-size:13px; color:var(--zg-accent); }
.au-content { font-size:13px; color:var(--zg-text-dim); margin-top:8px; max-height:80px; overflow:hidden; }
.au-content :deep(p) { margin-bottom:6px; }
.au-actions { display:flex; flex-direction:column; gap:8px; justify-content:center; }
.au-proxy { display:block; font-size:12px; color:#9a3412; margin:4px 0; padding:4px 8px; background:rgba(251,146,60,.1); border-radius:6px; }
.au-proxy b { color:#c2410c; }
.au-proxy-card { border-left:3px solid var(--zg-primary); background:rgba(245,158,11,.04); }
@media (max-width:768px){ .audit-card{flex-direction:column;} .au-cover{width:100%;height:160px;} }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .head { margin-bottom: 14px; gap: 8px; }
  .head .el-button { min-width: auto; padding: 8px 14px; height: 34px; font-size: 13px; }
  .sub-nav { width: 100%; gap: 4px; padding: 6px; margin-bottom: 14px; flex-wrap: wrap; }
  .sub-tab { flex: 1; min-width: 100%; width: 100%; text-align: center; padding: 10px 14px; font-size: 13px; border-radius: 8px; }
  .audit-list { gap: 12px; }
  .audit-card { flex-direction: column; gap: 12px; padding: 14px; }
  .au-cover { width: 100%; height: 140px; }
  .au-icon { width: 64px; height: 64px; font-size: 28px; border-radius: 10px; }
  .au-title { font-size: 15px; }
  .au-meta { font-size: 11px; }
  .au-rec { font-size: 12px; }
  .au-content { font-size: 12px; max-height: 60px; }
  .au-actions { flex-direction: row; flex-wrap: wrap; justify-content: flex-start; gap: 6px; padding-top: 8px; border-top: 1px dashed rgba(245,158,11,.1); }
  .au-actions .el-button { flex: 1; min-width: auto; }
}

@media (min-width: 1200px) {
  .head { margin-bottom: 40px; }
  .dh-title { font-size: 30px; }
  .sub-nav { padding: 14px; gap: 16px; margin-bottom: 40px; }
  .sub-tab { padding: 12px 28px; border-radius: 24px; font-size: 16px; }
  .audit-list { gap: 28px; }
  .audit-card { display: grid; grid-template-columns: auto 1fr auto; gap: 40px; padding: 24px 32px; align-items: start; }
  .au-cover { width: 160px; height: 120px; border-radius: 16px; }
  .au-icon { width: 120px; height: 120px; border-radius: 16px; font-size: 52px; }
  .au-title { font-size: 20px; }
  .au-meta { font-size: 14px; }
  .au-rec { font-size: 15px; }
  .au-content { font-size: 15px; max-height: 120px; }
  .au-actions { flex-direction: column; gap: 12px; justify-content: flex-start; padding-top: 0; border: none; }
  .au-actions .el-button { padding: 12px 24px; font-size: 15px; min-width: 110px; }
}

@media (min-width: 1200px) {
  .head { margin-bottom: 28px; }
  .dh-title { font-size: 28px; }
  .sub-nav { padding: 12px; gap: 12px; margin-bottom: 28px; }
  .sub-tab { padding: 10px 24px; border-radius: 20px; font-size: 15px; }
  .audit-list { gap: 20px; }
  .audit-card { gap: 20px; padding: 20px 24px; }
  .au-cover { width: 160px; height: 120px; border-radius: 14px; }
  .au-icon { width: 100px; height: 100px; border-radius: 14px; font-size: 44px; }
  .au-title { font-size: 18px; }
  .au-meta { font-size: 13px; }
  .au-rec { font-size: 14px; }
  .au-content { font-size: 14px; max-height: 100px; }
  .au-actions { gap: 10px; }
  .au-actions .el-button { padding: 10px 20px; font-size: 14px; }
}
</style>
