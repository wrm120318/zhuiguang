<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'
import { useUserStore } from '@/store/user'

const router = useRouter()
const route = useRoute()
const user = useUserStore()
const loading = ref(true)

const question = ref<any>(null)
const subject = ref<any>(null)
const stats = ref<any>(null)
const scoreDist = ref<any[]>([])
const pendingSubs = ref<any[]>([])
const detailSubs = ref<any[]>([])
const deletingId = ref<number | null>(null)

const questionId = computed(() => Number(route.params.questionId))
const isTeacher = computed(() => user.isStaff)

function qTypeLabel(t: string) { return { single: '单选', multiple: '多选', judge: '判断', subjective: '主观' }[t] || t }
function statusTag(s: string) {
  return s === 'graded' ? { type: 'success' as const, label: '已批' }
       : s === 'pending' ? { type: 'warning' as const, label: '待批' }
       : { type: 'info' as const, label: s }
}

async function load() {
  loading.value = true
  try {
    const r: any = await api.practiceStats(questionId.value)
    question.value = r.question
    subject.value = r.subject
    stats.value = r.stats
    scoreDist.value = r.scoreDist || []
    pendingSubs.value = r.pendingSubs || []
    detailSubs.value = r.detailSubs || []
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载失败')
  } finally { loading.value = false }
}

async function deleteSub(id: number) {
  try {
    await ElMessageBox.confirm('确定删除该提交记录？此操作不可恢复。', '删除提交记录', { type: 'error', confirmButtonText: '删除', cancelButtonText: '取消' })
    deletingId.value = id
    await api.deletePracticeRecord(id)
    ElMessage.success('已删除')
    await load()
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e?.response?.data?.message || '删除失败')
  } finally { deletingId.value = null }
}

// 正确率
const passRate = computed(() => {
  if (!stats.value || stats.value.totalSubmissions === 0) return 0
  return Math.round(100 * stats.value.passCount / stats.value.totalSubmissions)
})

function fmtTime(t: string) {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(load)
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()">← 返回</div>

    <!-- 题目 + 统计卡片 -->
    <div v-if="question" class="qs-header">
      <div class="qs-meta">
        <span class="qs-subj">{{ subject?.icon || '📚' }} {{ subject?.name }}</span>
        <el-tag size="small">{{ qTypeLabel(question.qtype) }}</el-tag>
        <el-tag size="small" type="success">{{ question.score }} 分</el-tag>
        <el-button size="small" type="primary" round @click="router.push(`/practice/${questionId}`)">🎯 开始作答</el-button>
        <el-button v-if="isTeacher" size="small" @click="router.push(`/practice/my-records`)">📝 我的记录</el-button>
      </div>

      <div class="qs-stats" v-if="stats">
        <div class="qs-card glass">
          <div class="qs-num">{{ stats.totalSubmissions }}</div>
          <div class="qs-label">总提交</div>
        </div>
        <div class="qs-card glass">
          <div class="qs-num" :style="{ color: passRate >= 60 ? '#16a34a' : '#dc2626' }">{{ passRate }}%</div>
          <div class="qs-label">正确率</div>
        </div>
        <div class="qs-card glass">
          <div class="qs-num">{{ stats.gradedCount }}</div>
          <div class="qs-label">已批改</div>
        </div>
        <div class="qs-card glass" :class="{ 'card-warn': stats.pendingCount > 0 }">
          <div class="qs-num">{{ stats.pendingCount }}</div>
          <div class="qs-label">待批改</div>
        </div>
      </div>
    </div>

    <!-- 题目内容 -->
    <div v-if="question" class="glass question-view">
      <div class="q-label">📖 题目</div>
      <div class="q-content q-content-lg" v-html="md(question.content)"></div>
      <!-- 正确答案（教师可见） -->
      <div v-if="isTeacher && question.qtype !== 'subjective'" class="q-answer-reveal">
        <div class="q-label">✅ 正确答案</div>
        <div class="q-answer-text">{{ question.answer }}</div>
      </div>
      <div v-if="question.attachments?.length" class="q-atts">
        <a v-for="(a, i) in question.attachments" :key="i" :href="a.url" target="_blank" class="att-link">📎 {{ a.name }}</a>
      </div>
    </div>

    <!-- 待批改列表 -->
    <div v-if="pendingSubs.length" class="section-title">⏳ 待批改（{{ pendingSubs.length }} 条）</div>
    <div v-for="sub in pendingSubs" :key="sub.id" class="pending-card glass">
      <div class="pc-head">
        <span class="pc-user">👤 {{ sub.real_name }}（{{ sub.username }}）</span>
        <span class="pc-time">提交于 {{ fmtTime(sub.submitted_at) }}</span>
        <el-tag size="small" type="warning">待批改</el-tag>
      </div>
      <div class="pc-answer">
        <span class="pc-ans-label">作答：</span>
        <span class="pc-ans-content">{{ sub.answer || '（无作答）' }}</span>
      </div>
      <div class="pc-actions">
        <el-button size="small" type="primary" @click="router.push(`/practice/${questionId}?grade=${sub.id}`)">去批改</el-button>
        <el-button size="small" type="danger" :loading="deletingId === sub.id" @click="deleteSub(sub.id)">删除记录</el-button>
      </div>
    </div>

    <!-- 全部提交记录 -->
    <div class="section-title">📋 全部提交记录（{{ detailSubs.length }} 条）</div>
    <div v-if="!detailSubs.length" class="empty-hint">
      <el-empty description="暂无提交记录" />
    </div>
    <div v-for="sub in detailSubs" :key="sub.sub_id" class="record-card glass">
      <div class="rc-head">
        <span class="rc-user">👤 {{ sub.real_name }}（{{ sub.username }}）</span>
        <el-tag size="small" :type="statusTag(sub.status)?.type">{{ statusTag(sub.status)?.label }}</el-tag>
        <span class="rc-score" v-if="sub.status === 'graded'">
          {{ sub.score }}/{{ sub.max_score }}
          <el-tag v-if="sub.correct === 1" size="small" type="success" style="margin-left:4px">✓</el-tag>
          <el-tag v-else size="small" type="danger" style="margin-left:4px">✗</el-tag>
        </span>
        <span class="rc-score waiting" v-else>待批</span>
        <span class="rc-time">{{ fmtTime(sub.graded_at || sub.submitted_at) }}</span>
        <div class="rc-actions">
          <el-button
            v-if="isTeacher"
            size="small" type="danger" text :loading="deletingId === sub.sub_id"
            @click="deleteSub(sub.sub_id)"
          >删除</el-button>
        </div>
      </div>
      <div class="rc-footer">
        <span class="rc-ans-label">作答：</span>
        <span class="rc-answer">{{ sub.user_answer || '（无作答）' }}</span>
        <span v-if="sub.comment" class="rc-comment">📝 {{ sub.comment }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0; color: var(--zg-text-dim); cursor: pointer; }
.back:hover { color: var(--zg-primary); }
.qs-header { margin-bottom: 20px; }
.qs-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.qs-subj { font-size: 16px; font-weight: 700; }
.qs-stats { display: flex; gap: 12px; flex-wrap: wrap; }
.qs-card { padding: 14px 20px; text-align: center; min-width: 90px; }
.qs-num { font-size: 26px; font-weight: 800; color: var(--zg-primary); }
.qs-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.card-warn .qs-num { color: #eab308; }
.question-view { padding: 20px 24px; margin-bottom: 20px; }
.q-label { font-weight: 700; font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.q-content-lg { font-size: 16px; line-height: 1.9; }
.q-answer-reveal { margin-top: 16px; padding: 12px 16px; background: rgba(22,163,74,0.08); border-radius: 10px; }
.q-answer-text { font-size: 15px; font-weight: 700; color: #16a34a; margin-top: 4px; }
.q-atts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.att-link { font-size: 13px; color: var(--zg-primary); text-decoration: underline; }
.section-title { font-size: 15px; font-weight: 700; margin: 20px 0 12px; color: var(--zg-text); }
.pending-card, .record-card { padding: 14px 18px; margin-bottom: 10px; }
.pc-head, .rc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.pc-user, .rc-user { font-weight: 700; font-size: 14px; }
.pc-time, .rc-time { font-size: 12px; color: var(--zg-text-dim); }
.pc-score, .rc-score { font-weight: 700; }
.pc-score.waiting, .rc-score.waiting { color: #eab308; }
.pc-answer, .rc-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 12px; background: rgba(245,158,11,0.05); border-radius: 8px; font-size: 13px; }
.pc-ans-label, .rc-ans-label { font-size: 12px; color: var(--zg-text-dim); flex-shrink: 0; }
.pc-ans-content, .rc-answer { flex: 1; word-break: break-all; }
.rc-comment { font-size: 12px; color: #92400e; }
.pc-actions, .rc-actions { display: flex; gap: 8px; margin-top: 10px; }
.empty-hint { margin: 20px 0; }
.q-content :deep(img) { max-width: 100%; border-radius: 8px; }
.q-content :deep(pre) { background: rgba(0,0,0,0.05); padding: 8px 12px; border-radius: 6px; font-size: 13px; }
</style>
