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
const subject = ref<any>(null)
const stats = ref<any>(null)
const qtypeStats = ref<any[]>([])
const scoreDist = ref<any[]>([])
const pendingSubs = ref<any[]>([])
const activeTab = ref<'stats' | 'pending' | 'records'>('stats')
const deletingId = ref<number | null>(null)

const isTeacher = computed(() => user.isStaff)
const subjectId = computed(() => Number(route.params.id))

// 题型标签
function qTypeLabel(t: string) { return { single: '单选', multiple: '多选', judge: '判断', subjective: '主观' }[t] || t }
function statusTag(status: string) {
  return status === 'graded' ? { type: 'success' as const, label: '已批' }
       : status === 'pending' ? { type: 'warning' as const, label: '待批' }
       : { type: 'info' as const, label: status }
}

// 得分柱状图
const maxDistScore = computed(() => {
  if (!scoreDist.value.length) return 1
  return Math.max(...scoreDist.value.map((r: any) => r.score))
})
const distBarWidth = computed(() => {
  if (!scoreDist.value.length) return 0
  const max = Math.max(...scoreDist.value.map((r: any) => r.score))
  return max === 0 ? 0 : (100 * max / Math.max(maxDistScore.value, 1))
})

async function load() {
  loading.value = true
  try {
    const r: any = await api.practiceStats(subjectId.value)
    subject.value = r.subject
    stats.value = r.stats
    qtypeStats.value = r.qtypeStats || []
    scoreDist.value = r.scoreDist || []
    pendingSubs.value = r.pendingSubs || []
    if (!stats.value?.pendingCount && stats.value?.gradedCount) activeTab.value = 'records'
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

function fmtTime(t: string) {
  if (!t) return '-'
  const d = new Date(t)
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

onMounted(load)
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()">← 返回</div>

    <!-- 学科标题 + 统计卡片 -->
    <div v-if="subject" class="stats-header">
      <div class="stats-title">{{ subject.icon || '📚' }} {{ subject.name }} · 单题训练统计</div>
      <div class="stats-cards" v-if="stats">
        <div class="stat-card glass">
          <div class="sc-num">{{ stats.totalQuestions }}</div>
          <div class="sc-label">题目总数</div>
        </div>
        <div class="stat-card glass">
          <div class="sc-num">{{ stats.totalSubmissions }}</div>
          <div class="sc-label">总提交数</div>
        </div>
        <div class="stat-card glass" :class="{ 'card-pending': stats.pendingCount > 0 }">
          <div class="sc-num">{{ stats.pendingCount }}</div>
          <div class="sc-label">待批改</div>
        </div>
        <div class="stat-card glass">
          <div class="sc-num">{{ stats.gradedCount }}</div>
          <div class="sc-label">已批改</div>
        </div>
      </div>
    </div>

    <!-- Tab 切换 -->
    <div class="tab-bar">
      <button :class="{ active: activeTab === 'stats' }" @click="activeTab = 'stats'">📊 整体统计</button>
      <button :class="{ active: activeTab === 'pending' && pendingSubs.length }" @click="activeTab = 'pending'" :disabled="!pendingSubs.length">
        ⏳ 待批改（{{ pendingSubs.length }}）
      </button>
      <button :class="{ active: activeTab === 'records' }" @click="activeTab = 'records'">📋 全部记录（{{ scoreDist.length }}）</button>
    </div>

    <!-- Tab 1: 整体统计 -->
    <div v-if="activeTab === 'stats'" class="tab-panel">
      <!-- 题型分布 -->
      <div class="glass stat-box">
        <div class="stat-box-title">题型答题分布</div>
        <div v-if="qtypeStats.length" class="qtype-bars">
          <div v-for="s in qtypeStats" :key="s.qtype" class="qtype-row">
            <span class="qtype-label">{{ qTypeLabel(s.qtype) }}</span>
            <div class="qtype-bar-bg">
              <div class="qtype-bar-fill" :style="{ width: s.cnt ? (100 * s.cnt / (qtypeStats[0]?.cnt || 1)) + '%' : '0%' }"></div>
            </div>
            <span class="qtype-count">{{ s.cnt }} 次</span>
          </div>
        </div>
        <el-empty v-else description="暂无答题数据" :image-size="60" />
      </div>

      <!-- 得分分布（直方图） -->
      <div class="glass stat-box">
        <div class="stat-box-title">得分分布（最高分归一化）</div>
        <div v-if="scoreDist.length" class="score-chart">
          <div v-for="(row, i) in scoreDist.slice(0, 20)" :key="i" class="score-row">
            <div class="score-label" style="width:80px;flex-shrink:0">{{ row.real_name || '?' }}</div>
            <div class="score-bar-bg">
              <div
                class="score-bar-fill"
                :style="{
                  width: row.max_score ? (100 * row.score / row.max_score) + '%' : '0%',
                  background: row.score === row.max_score ? '#16a34a' : row.score >= (row.max_score * 0.6) ? '#eab308' : '#dc2626'
                }"
              ></div>
            </div>
            <span class="score-val">{{ row.score }}/{{ row.max_score }}</span>
          </div>
          <div v-if="!scoreDist.length" class="empty-hint">暂无得分数据</div>
        </div>
      </div>
    </div>

    <!-- Tab 2: 待批改 -->
    <div v-if="activeTab === 'pending'" class="tab-panel">
      <div v-if="!pendingSubs.length" class="empty-hint">
        <el-empty description="暂无待批改提交" />
      </div>
      <div v-for="sub in pendingSubs" :key="sub.id" class="pending-card glass">
        <div class="pc-head">
          <span class="pc-user">👤 {{ sub.real_name }}（{{ sub.username }}）</span>
          <span class="pc-time">提交于 {{ fmtTime(sub.submitted_at) }}</span>
          <el-tag size="small" type="warning">待批改</el-tag>
        </div>
        <div class="pc-question q-content" v-html="md(sub.qcontent)"></div>
        <div class="pc-answer">
          <div class="pc-ans-label">学生作答：</div>
          <div class="pc-ans-content">{{ sub.answer || '（无作答）' }}</div>
        </div>
        <div class="pc-actions">
          <el-button size="small" type="primary" @click="router.push(`/practice/${sub.question_id}?grade=${sub.id}`)">批改</el-button>
          <el-button size="small" type="danger" :loading="deletingId === sub.id" @click="deleteSub(sub.id)">删除记录</el-button>
        </div>
      </div>
    </div>

    <!-- Tab 3: 全部记录 -->
    <div v-if="activeTab === 'records'" class="tab-panel">
      <div v-if="!scoreDist.length" class="empty-hint">
        <el-empty description="本学科暂无训练记录" />
      </div>
      <div v-for="(row, i) in scoreDist" :key="i" class="record-card glass">
        <div class="rc-head">
          <span class="rc-user">👤 {{ row.real_name }}</span>
          <el-tag size="small">{{ qTypeLabel(row.qtype) }}</el-tag>
          <el-tag size="small" :type="statusTag(row.status)?.type">{{ statusTag(row.status)?.label }}</el-tag>
          <span class="rc-score" v-if="row.status === 'graded'">{{ row.score }} / {{ row.max_score }}</span>
          <span class="rc-score waiting" v-else>待批</span>
          <span class="rc-time">{{ fmtTime(row.graded_at || row.submitted_at) }}</span>
          <div class="rc-actions">
            <el-button
              v-if="isTeacher"
              size="small" type="danger" text :loading="deletingId === row.id"
              @click="deleteSub(row.id)"
            >删除</el-button>
          </div>
        </div>
        <div class="rc-question q-content" v-html="md(row.qcontent)"></div>
        <div class="rc-footer">
          <span class="rc-ans-label">作答：</span>
          <span class="rc-answer">{{ row.user_answer || '（无作答）' }}</span>
          <span v-if="row.comment" class="rc-comment">教师评语：{{ row.comment }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0; color: var(--zg-text-dim); cursor: pointer; }
.back:hover { color: var(--zg-primary); }
.stats-header { margin-bottom: 20px; }
.stats-title { font-size: 20px; font-weight: 800; margin-bottom: 14px; }
.stats-cards { display: flex; gap: 14px; flex-wrap: wrap; }
.stat-card { padding: 16px 24px; text-align: center; min-width: 110px; }
.sc-num { font-size: 28px; font-weight: 800; color: var(--zg-primary); }
.sc-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
.card-pending .sc-num { color: #eab308; }
.tab-bar { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 2px solid rgba(245,158,11,0.15); }
.tab-bar button {
  padding: 10px 20px; background: none; border: none; border-bottom: 2px solid transparent;
  margin-bottom: -2px; font-size: 14px; color: var(--zg-text-dim); cursor: pointer; transition: all .2s;
}
.tab-bar button.active { color: var(--zg-primary); border-bottom-color: var(--zg-primary); font-weight: 700; }
.tab-bar button:disabled { opacity: 0.4; cursor: not-allowed; }
.tab-bar button:hover:not(:disabled):not(.active) { color: var(--zg-text); }
.tab-panel { display: flex; flex-direction: column; gap: 14px; }
.glass.stat-box { padding: 20px; }
.stat-box-title { font-weight: 700; font-size: 15px; margin-bottom: 14px; }
.qtype-bars { display: flex; flex-direction: column; gap: 10px; }
.qtype-row { display: flex; align-items: center; gap: 10px; }
.qtype-label { width: 50px; font-size: 13px; flex-shrink: 0; }
.qtype-bar-bg { flex: 1; height: 16px; background: rgba(245,158,11,0.08); border-radius: 8px; overflow: hidden; }
.qtype-bar-fill { height: 100%; background: var(--zg-primary); border-radius: 8px; transition: width .4s; }
.qtype-count { width: 50px; text-align: right; font-size: 12px; color: var(--zg-text-dim); flex-shrink: 0; }
.score-chart { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; }
.score-row { display: flex; align-items: center; gap: 10px; }
.score-bar-bg { flex: 1; height: 14px; background: rgba(245,158,11,0.08); border-radius: 7px; overflow: hidden; }
.score-bar-fill { height: 100%; border-radius: 7px; transition: width .4s; }
.score-val { width: 60px; font-size: 12px; color: var(--zg-text-dim); text-align: right; flex-shrink: 0; }
.empty-hint { margin-top: 40px; text-align: center; color: var(--zg-text-dim); }
.pending-card, .record-card { padding: 16px 20px; }
.pc-head, .rc-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.pc-user, .rc-user { font-weight: 700; font-size: 14px; }
.pc-time, .rc-time { font-size: 12px; color: var(--zg-text-dim); }
.pc-score, .rc-score { margin-left: auto; font-weight: 700; }
.pc-score.waiting, .rc-score.waiting { color: #eab308; }
.pc-question, .rc-question { font-size: 14px; line-height: 1.8; margin-bottom: 10px; }
.pc-answer, .rc-footer { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; background: rgba(245,158,11,0.05); border-radius: 8px; font-size: 13px; }
.pc-ans-label, .rc-ans-label { font-size: 12px; color: var(--zg-text-dim); flex-shrink: 0; }
.pc-ans-content, .rc-answer { flex: 1; }
.rc-comment { font-size: 12px; color: #92400e; }
.pc-actions, .rc-actions { display: flex; gap: 8px; margin-top: 10px; }
.q-content :deep(img) { max-width: 100%; border-radius: 8px; }
.q-content :deep(pre) { background: rgba(0,0,0,0.05); padding: 8px 12px; border-radius: 6px; font-size: 13px; }
</style>
