<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'
import { useUserStore } from '@/store/user'

const router = useRouter()
const user = useUserStore()
const loading = ref(true)
const records = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const perPage = 15
const deleting = ref<number | null>(null)

const canDelete = computed(() => user.isStudent || user.isSuperAdmin)

async function load(p = 1) {
  loading.value = true
  try {
    const r: any = await api.practiceMyRecords(p, perPage)
    records.value = r.list || []
    total.value = r.total || 0
    page.value = p
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载失败')
  } finally { loading.value = false }
}

async function removeRecord(rec: any) {
  try {
    await ElMessageBox.confirm(
      `确定删除「${rec.subject_name || ''}」的这道训练记录？删除后不可恢复。`,
      '删除训练记录',
      { type: 'error', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
    deleting.value = rec.id
    await api.deletePracticeRecord(rec.id)
    ElMessage.success('已删除')
    await load()
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e?.response?.data?.message || '删除失败')
  } finally { deleting.value = null }
}

const totalPages = computed(() => Math.ceil(total.value / perPage))
function goToPage(p: number) { if (p >= 1 && p <= totalPages.value) load(p) }
function qTypeLabel(t: string) { return { single: '单选', multiple: '多选', judge: '判断', subjective: '主观' }[t] || t }
function statusTag(status: string) {
  return status === 'graded' ? { type: 'success' as const, label: '已评分' }
       : status === 'pending' ? { type: 'warning' as const, label: '待批改' }
       : { type: 'info' as const, label: status }
}
function fmtTime(t: string) { if (!t) return '-'
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

onMounted(() => load(1))
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()">← 返回</div>
    <div class="dh-title">📝 我的单题训练记录</div>

    <div v-if="!records.length && !loading" class="empty-hint">
      <el-empty description="暂无训练记录，去学科站开始训练吧！" />
    </div>

    <!-- 记录列表 -->
    <div class="records-list">
      <div v-for="rec in records" :key="rec.id" class="record-card glass">
        <div class="rc-head">
          <span class="rc-subj">{{ rec.subject_icon || '📚' }} {{ rec.subject_name }}</span>
          <el-tag size="small" type="info">{{ qTypeLabel(rec.qtype) }}</el-tag>
          <el-tag size="small" :type="statusTag(rec.status)?.type">{{ statusTag(rec.status)?.label }}</el-tag>
          <span class="rc-score" v-if="rec.status === 'graded'">得分：{{ rec.score }} / {{ rec.max_score }}</span>
          <span class="rc-score waiting" v-else>待批</span>
        </div>

        <div class="rc-question q-content" v-html="md(rec.qcontent)"></div>

        <!-- 附件 -->
        <div v-if="rec.qattachments?.length" class="rc-atts">
          <a v-for="(a, i) in rec.qattachments" :key="i" :href="a.url" target="_blank" class="att-link">📎 {{ a.name }}</a>
        </div>

        <div class="rc-foot">
          <span class="rc-time">🕐 {{ fmtTime(rec.submitted_at) }}</span>
          <template v-if="rec.status === 'graded'">
            <span class="rc-time" v-if="rec.graded_at">✅ {{ fmtTime(rec.graded_at) }}</span>
            <span class="rc-comment" v-if="rec.comment">📝 教师评语：{{ rec.comment }}</span>
          </template>
          <div class="rc-actions">
            <el-button text size="small" type="primary" @click="router.push(`/practice/${rec.question_id}`)">查看详情</el-button>
            <el-button
              v-if="canDelete"
              text size="small" type="danger" :loading="deleting === rec.id"
              @click="removeRecord(rec)"
            >删除</el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="pager">
      <el-button :disabled="page <= 1" size="small" @click="goToPage(page - 1)">上一页</el-button>
      <span class="pager-info">第 {{ page }} / {{ totalPages }} 页（共 {{ total }} 条）</span>
      <el-button :disabled="page >= totalPages" size="small" @click="goToPage(page + 1)">下一页</el-button>
    </div>

    <div class="empty-tip" v-if="!loading && !records.length">
      <p>还没有训练记录哦，去「题库自测」开始练习吧！</p>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0; color: var(--zg-text-dim); cursor: pointer; }
.back:hover { color: var(--zg-primary); }
.dh-title { font-size: 24px; font-weight: 800; margin: 0 0 20px; }
.records-list { display: flex; flex-direction: column; gap: 14px; }
.record-card { padding: 20px; }
.rc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.rc-subj { font-weight: 700; font-size: 14px; }
.rc-score { margin-left: auto; font-weight: 700; color: var(--zg-primary); }
.rc-score.waiting { color: #eab308; }
.rc-question { font-size: 15px; line-height: 1.8; margin-bottom: 12px; }
.rc-atts { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.att-link { font-size: 13px; color: var(--zg-primary); text-decoration: underline; }
.rc-foot { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid rgba(245,158,11,0.12); }
.rc-time { font-size: 12px; color: var(--zg-text-dim); white-space: nowrap; }
.rc-comment { font-size: 13px; color: #92400e; background: rgba(245,158,11,0.08); padding: 4px 10px; border-radius: 6px; }
.rc-actions { margin-left: auto; display: flex; gap: 6px; }
.pager { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 24px; padding: 16px 0; }
.pager-info { font-size: 13px; color: var(--zg-text-dim); }
.empty-hint { margin-top: 40px; }
.empty-tip { margin-top: 40px; text-align: center; color: var(--zg-text-dim); }
.q-content :deep(img) { max-width: 100%; border-radius: 8px; }
</style>
