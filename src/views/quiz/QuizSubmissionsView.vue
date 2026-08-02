<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { renderMarkdown as renderMd } from '@/utils/markdown'

const router = useRouter()
const route = useRoute()
const quiz = ref<any>(null)
const submissions = ref<any[]>([])
const questions = ref<any[]>([])
const loading = ref(true)
// 第一级：学生列表；第二级：选中某学生进入批改
const activeSubId = ref<number | null>(null)
const filterTab = ref<'pending' | 'graded'>('pending')

const activeSub = computed(() => submissions.value.find(s => s.id === activeSubId.value))
const pendingList = computed(() => submissions.value.filter(s => s.status === 'pending'))
const gradedList = computed(() => submissions.value.filter(s => s.status === 'graded'))
const currentList = computed(() => filterTab.value === 'pending' ? pendingList.value : gradedList.value)

async function load() {
  loading.value = true
  try {
    quiz.value = await api.quiz(Number(route.params.id))
    questions.value = quiz.value.questions || []
    submissions.value = (await api.quizSubmissions(Number(route.params.id))) as any
    // 默认进入待批 tab；若无待批则切到已批
    if (!pendingList.value.length && gradedList.value.length) filterTab.value = 'graded'
  } finally { loading.value = false }
}
onMounted(load)

function letter(idx: number) { return String.fromCharCode(65 + idx) }

// 主观题临时分数 / 评语
const grades = ref<Record<number, { score: number; comment: string }>>({})
function initGrades(sub: any) {
  const g: Record<number, { score: number; comment: string }> = {}
  const graded = sub?.answers?.graded || {}
  for (const q of questions.value) {
    if (q.qtype === 'subjective') {
      g[q.id] = { score: graded[q.id]?.score ?? 0, comment: graded[q.id]?.comment ?? '' }
    }
  }
  grades.value = g
}
function openStudent(id: number) {
  activeSubId.value = id
  initGrades(submissions.value.find(s => s.id === id))
}
function backToList() { activeSubId.value = null }

const grading = ref(false)
async function submitGrades() {
  if (!activeSub.value) return
  grading.value = true
  try {
    await api.gradeSubmission(Number(route.params.id), activeSub.value.id, grades.value)
    ElMessage.success('批改完成，已通知学生')
    await load()
    activeSubId.value = null
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '批改失败')
  } finally { grading.value = false }
}

function qTypeLabel(t: string) { return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : '主观' }
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()">← 返回题库自测</div>

    <!-- 顶部信息条 -->
    <div class="top-bar glass-strong" v-if="quiz">
      <div class="tb-info">
        <h1 class="tb-title">📋 {{ quiz.title }}</h1>
        <div class="tb-meta">提交 {{ submissions.length }} 份 · 待批 {{ pendingList.length }} · 已批 {{ gradedList.length }}</div>
      </div>
      <div class="tb-actions">
        <el-button type="primary" round @click="router.push(`/quiz/${quiz.id}/report`)">📊 数据报告</el-button>
      </div>
    </div>

    <!-- 第一级：学生列表（待批 / 已批） -->
    <div v-if="!activeSubId" class="lvl1">
      <el-tabs v-model="filterTab" class="lvl1-tabs">
        <el-tab-pane :label="`待批改学生（${pendingList.length}）`" name="pending" />
        <el-tab-pane :label="`已批改学生（${gradedList.length}）`" name="graded" />
      </el-tabs>
      <div class="stu-grid">
        <div v-for="s in currentList" :key="s.id" class="stu-card glass zg-card" @click="openStudent(s.id)">
          <div class="sc-head">
            <span class="sc-name">👤 {{ s.real_name || `用户${s.user_id}` }}</span>
            <el-tag size="small" :type="s.status === 'graded' ? 'success' : 'warning'">{{ s.status === 'graded' ? '已批' : '待批' }}</el-tag>
          </div>
          <div class="sc-score">
            <span class="sc-cur">{{ s.total_score }}</span>
            <span class="sc-max"> / {{ s.max_score }}</span>
          </div>
          <div class="sc-time">提交：{{ s.submitted_at?.slice(0, 16) }}</div>
          <el-button type="primary" size="small" round class="sc-btn">{{ s.status === 'graded' ? '查看作答' : '去批改' }}</el-button>
        </div>
        <el-empty v-if="!currentList.length" :description="filterTab === 'pending' ? '暂无待批改学生' : '暂无已批改学生'" />
      </div>
    </div>

    <!-- 第二级：批改某学生作答 -->
    <div v-else class="lvl2">
      <div class="lvl2-head glass">
        <span class="l2-back" @click="backToList">← 返回学生列表</span>
        <span class="l2-name">{{ activeSub.real_name }} 的作答</span>
        <el-tag :type="activeSub.status === 'graded' ? 'success' : 'warning'">{{ activeSub.status === 'graded' ? '已批改' : '待批改' }}</el-tag>
        <span class="l2-score">当前得分：<b>{{ activeSub.total_score }}</b> / {{ activeSub.max_score }}</span>
      </div>

      <div v-for="(q, i) in questions" :key="q.id" class="glass q-card">
        <div class="q-head">
          <span class="q-no">{{ i + 1 }}.</span>
          <el-tag size="small">{{ qTypeLabel(q.qtype) }}</el-tag>
          <span class="q-score">{{ q.score }} 分</span>
        </div>
        <div class="q-content" v-html="renderMd(q.content)"></div>

        <template v-if="q.qtype !== 'subjective'">
          <div class="q-line">学生答案：<b>{{ activeSub.answers?.answers?.[q.id] || '未作答' }}</b></div>
          <div class="q-line">正确答案：<b>{{ q.answer }}</b></div>
          <div class="q-line">
            <el-tag :type="activeSub.answers?.graded?.[q.id]?.correct ? 'success' : 'danger'">
              {{ activeSub.answers?.graded?.[q.id]?.correct ? '✓ 正确' : '✗ 错误' }}
            </el-tag>
            <span style="margin-left:8px; color: var(--zg-text-dim); font-size:13px;">得分 {{ activeSub.answers?.graded?.[q.id]?.score || 0 }} / {{ q.score }}</span>
          </div>
        </template>
        <template v-else>
          <div class="q-line">学生作答：</div>
          <div class="q-answer" v-html="renderMd(activeSub.answers?.answers?.[q.id] || '未作答')"></div>
          <div class="q-line" v-if="q.answer">参考答案：</div>
          <div class="q-ref" v-if="q.answer" v-html="renderMd(q.answer)"></div>
          <div class="grade-row">
            <span>给分：</span>
            <el-input-number v-model="grades[q.id].score" :min="0" :max="q.score" size="small" />
            <span style="margin-left:8px; color: var(--zg-text-dim); font-size:12px;">满分 {{ q.score }} 分</span>
          </div>
          <el-input v-model="grades[q.id].comment" placeholder="教师评语（选填）" type="textarea" :rows="2" style="margin-top:8px" />
        </template>
      </div>

      <div class="action-bar glass" v-if="questions.some(q => q.qtype === 'subjective')">
        <el-button @click="backToList">取消</el-button>
        <el-button type="primary" :loading="grading" @click="submitGrades">提交批改</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.top-bar { padding: 18px 24px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.tb-title { font-size: 20px; font-weight: 800; }
.tb-meta { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.lvl1 { margin-top: 16px; }
.lvl1-tabs { margin-bottom: 8px; }
.stu-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.stu-card { padding: 18px; cursor: pointer; transition: all .2s; }
.stu-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(245,158,11,.15); }
.sc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.sc-name { font-weight: 700; font-size: 15px; }
.sc-score { font-size: 14px; color: var(--zg-text-dim); margin-bottom: 6px; }
.sc-cur { font-size: 24px; font-weight: 800; color: var(--zg-primary); }
.sc-max { color: var(--zg-text-dim); }
.sc-time { font-size: 12px; color: var(--zg-text-dim); margin-bottom: 12px; }
.sc-btn { width: 100%; }
.lvl2 { margin-top: 16px; }
.lvl2-head { padding: 14px 20px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.l2-back { color: var(--zg-text-dim); cursor: pointer; font-size: 14px; }
.l2-back:hover { color: var(--zg-primary); }
.l2-name { font-weight: 700; font-size: 16px; }
.l2-score { margin-left: auto; font-size: 14px; }
.l2-score b { color: var(--zg-primary); font-size: 20px; }
.q-card { padding: 18px 22px; margin-top: 12px; }
.q-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.q-no { font-weight: 800; }
.q-score { margin-left: auto; color: var(--zg-accent); font-size: 13px; }
.q-content { font-size: 15px; line-height: 1.8; margin-bottom: 10px; }
.q-content :deep(img) { max-width: 100%; border-radius: 10px; }
.q-line { font-size: 13px; color: var(--zg-text-dim); margin: 6px 0; }
.q-answer, .q-ref { padding: 12px; background: rgba(245,158,11,.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.q-ref { background: rgba(16,185,129,.06); }
.grade-row { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 14px; }
.action-bar { padding: 14px 22px; margin-top: 16px; display: flex; justify-content: flex-end; gap: 10px; }
@media (max-width: 768px) { .stu-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 520px) { .stu-grid { grid-template-columns: 1fr; } }
</style>
