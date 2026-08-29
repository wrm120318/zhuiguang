<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { renderMarkdown as renderMd } from '@/utils/markdown'

const router = useRouter()
const route = useRoute()
const quiz = ref<any>(null)
const questions = ref<any[]>([])
const answers = ref<Record<number, any>>({})
const submitting = ref(false)
const loading = ref(true)
// 提交结果状态
const submitted = ref(false)
const result = ref<any>(null)

onMounted(async () => {
  try {
    const r: any = await api.quiz(Number(route.params.id))
    quiz.value = r
    questions.value = r.questions || []
    // 已提交过的，直接跳到报告
    try {
      await api.quizMyReport(Number(route.params.id))
      ElMessage.info('你已提交过该题库，正在跳转报告页')
      router.replace(`/quiz/${route.params.id}/report`)
      return
    } catch { /* 未提交 */ }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载失败')
    router.back()
  } finally { loading.value = false }
})

function setAnswer(qId: number, val: any) { answers.value[qId] = val }
function toggleMulti(qId: number, opt: string) {
  const cur = answers.value[qId] || ''
  const set = cur.split(',').filter(Boolean)
  const i = set.indexOf(opt)
  if (i >= 0) set.splice(i, 1); else set.push(opt)
  set.sort()
  answers.value[qId] = set.join(',')
}

const answeredCount = computed(() => Object.keys(answers.value).filter(k => answers.value[+k] !== '' && answers.value[+k] != null).length)
const hasSubjective = computed(() => questions.value.some(q => q.qtype === 'subjective'))
const objectiveCount = computed(() => questions.value.filter(q => q.qtype !== 'subjective').length)
const subjectiveCount = computed(() => questions.value.filter(q => q.qtype === 'subjective').length)
const objCorrect = computed(() => {
  if (!result.value?.graded) return 0
  return Object.values(result.value.graded).filter((g: any) => g.type !== 'subjective' && g.correct).length
})

async function submit() {
  if (answeredCount.value < questions.value.length) {
    ElMessage.warning(`还有 ${questions.value.length - answeredCount.value} 题未作答`)
  }
  submitting.value = true
  try {
    const r: any = await api.submitQuiz(Number(route.params.id), answers.value)
    result.value = r
    submitted.value = true
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '提交失败')
  } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <!-- 提交结果页 -->
    <div v-if="submitted && result" class="glass-strong result-card">
      <div class="rs-icon"><ZgGlyph v-if="result.status === 'graded'" emoji="🎉" /><ZgGlyph v-else emoji="⏳" /></div>
      <h1 class="rs-title">{{ result.status === 'graded' ? '答题完成' : '已提交，等待教师阅卷' }}</h1>
      <p class="rs-sub">{{ quiz.title }}</p>

      <div class="rs-score">
        <div class="rs-score-num">
          <span class="rs-num">{{ result.totalScore }}</span>
          <span class="rs-max"> / {{ result.maxScore }}</span>
        </div>
        <div class="rs-score-label">客观题得分</div>
      </div>

      <div class="rs-summary">
        <div class="rss-item">
          <div class="rss-num">{{ objectiveCount }}</div>
          <div class="rss-label">客观题</div>
        </div>
        <div class="rss-item">
          <div class="rss-num correct">{{ objCorrect }}</div>
          <div class="rss-label">正确</div>
        </div>
        <div class="rss-item">
          <div class="rss-num wrong">{{ objectiveCount - objCorrect }}</div>
          <div class="rss-label">错误</div>
        </div>
        <div class="rss-item" v-if="subjectiveCount">
          <div class="rss-num">{{ subjectiveCount }}</div>
          <div class="rss-label">主观题</div>
        </div>
      </div>

      <div v-if="result.status === 'pending'" class="rs-notice">
        <div class="rsn-icon"><ZgGlyph emoji="⏳" /></div>
        <div class="rsn-text">
          <div class="rsn-title">主观题等待教师批改</div>
          <div class="rsn-desc">已通过站内信通知任课教师阅卷。教师批改完成后，将再次通过站内信提醒你，届时可查看完整测评报告。</div>
        </div>
      </div>
      <div v-else class="rs-notice success">
        <div class="rsn-icon"><ZgGlyph emoji="✅" /></div>
        <div class="rsn-text">
          <div class="rsn-title">整张试卷报告已生成</div>
          <div class="rsn-desc">所有题目已判分完成，可查看完整测评报告。</div>
        </div>
      </div>

      <div class="rs-actions">
        <el-button round @click="router.replace(`/quiz/${route.params.id}/report`)"><ZgGlyph emoji="📊" /> 查看完整报告</el-button>
        <el-button round @click="router.push('/quiz')"><ZgGlyph emoji="←" /> 返回题库列表</el-button>
      </div>
    </div>

    <!-- 作答页 -->
    <template v-else>
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div v-if="quiz" class="glass-strong q-head">
      <h1 class="qh-title">{{ quiz.title }}</h1>
      <p class="qh-desc" v-if="quiz.description">{{ quiz.description }}</p>
      <div class="qh-meta">
        <span>共 {{ questions.length }} 题</span>
        <span v-if="quiz.duration"><ZgGlyph emoji="⏱" /> {{ quiz.duration }} 分钟</span>
        <span v-if="quiz.valid_until"><ZgGlyph emoji="📅" /> 截止 {{ quiz.valid_until }}</span>
      </div>
    </div>

    <div v-for="(q, i) in questions" :key="q.id" class="glass q-card">
      <div class="q-head">
        <span class="q-no">{{ i + 1 }}.</span>
        <el-tag size="small">{{ q.qtype === 'single' ? '单选' : q.qtype === 'multiple' ? '多选' : q.qtype === 'judge' ? '判断' : '主观' }}</el-tag>
        <span class="q-score">{{ q.score }} 分</span>
      </div>
      <div class="q-content" v-html="renderMd(q.content)"></div>

      <div v-if="q.attachments?.length" class="q-attachments">
        <a v-for="(a, idx) in q.attachments" :key="idx" :href="`/api/resources/${a.url}/download`" target="_blank" class="qa-link"><ZgGlyph emoji="📎" /> {{ a.name }}</a>
      </div>

      <!-- 单选/判断 -->
      <template v-if="q.qtype === 'single' || q.qtype === 'judge'">
        <div class="q-options">
          <div v-for="(opt, idx) in q.options" :key="idx"
            class="q-opt" :class="{ on: answers[q.id] === String.fromCharCode(65 + idx) }"
            @click="setAnswer(q.id, String.fromCharCode(65 + idx))">
            <span class="qo-letter">{{ String.fromCharCode(65 + idx) }}</span>
            <span>{{ opt }}</span>
          </div>
        </div>
      </template>
      <!-- 多选 -->
      <template v-else-if="q.qtype === 'multiple'">
        <div class="q-options">
          <div v-for="(opt, idx) in q.options" :key="idx"
            class="q-opt" :class="{ on: (answers[q.id] || '').split(',').includes(String.fromCharCode(65 + idx)) }"
            @click="toggleMulti(q.id, String.fromCharCode(65 + idx))">
            <span class="qo-letter">{{ String.fromCharCode(65 + idx) }}</span>
            <span>{{ opt }}</span>
          </div>
        </div>
      </template>
      <!-- 主观题 -->
      <template v-else>
        <el-input v-model="answers[q.id]" type="textarea" :rows="6" placeholder="在此输入你的答案（支持 Markdown）" />
      </template>
    </div>

    <div class="submit-bar glass" v-if="quiz">
      <span class="sb-info">已答 {{ answeredCount }} / {{ questions.length }}</span>
      <el-button type="primary" round size="large" :loading="submitting" @click="submit">提交作答</el-button>
    </div>
    </template>
  </div>
</template>

<style scoped>
.result-card { padding: 40px 32px; text-align: center; margin-top: 16px; }
.rs-icon { font-size: 64px; margin-bottom: 12px; }
.rs-title { font-size: 26px; font-weight: 800; }
.rs-sub { color: var(--zg-text-dim); font-size: 15px; margin: 6px 0 24px; }
.rs-score { display: flex; flex-direction: column; align-items: center; margin-bottom: 24px; }
.rs-score-num { display: flex; align-items: baseline; gap: 4px; }
.rs-num { font-size: 56px; font-weight: 800; color: var(--zg-primary); line-height: 1; }
.rs-max { font-size: 24px; color: var(--zg-text-dim); font-weight: 600; }
.rs-score-label { font-size: 13px; color: var(--zg-text-dim); margin-top: 6px; }
.rs-summary { display: flex; gap: 16px; justify-content: center; margin-bottom: 28px; flex-wrap: wrap; }
.rss-item { background: rgba(var(--zg-primary-rgb),.06); border-radius: 14px; padding: 14px 24px; min-width: 90px; }
.rss-num { font-size: 28px; font-weight: 800; }
.rss-num.correct { color: #10b981; }
.rss-num.wrong { color: #ef4444; }
.rss-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
.rs-notice { display: flex; align-items: flex-start; gap: 14px; background: rgba(var(--zg-primary-rgb),.1); border-radius: 14px; padding: 18px 22px; text-align: left; margin-bottom: 24px; max-width: 560px; margin-left: auto; margin-right: auto; }
.rs-notice.success { background: rgba(16,185,129,.1); }
.rsn-icon { font-size: 32px; flex-shrink: 0; }
.rsn-title { font-weight: 700; font-size: 16px; margin-bottom: 4px; }
.rsn-desc { font-size: 13px; color: var(--zg-text-dim); line-height: 1.7; }
.rs-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.q-head { padding: 24px; margin-top: 16px; }
.qh-title { font-size: 22px; font-weight: 800; }
.qh-desc { color: var(--zg-text-dim); margin: 6px 0; }
.qh-meta { display: flex; gap: 16px; font-size: 13px; color: var(--zg-text-dim); margin-top: 8px; flex-wrap: wrap; }
.q-card { padding: 22px; margin-top: 14px; }
.q-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.q-no { font-weight: 800; font-size: 17px; }
.q-score { margin-left: auto; color: var(--zg-accent); font-size: 13px; }
.q-content { font-size: 15px; line-height: 1.8; margin-bottom: 14px; }
.q-content :deep(img) { max-width: 100%; border-radius: 10px; }
.q-attachments { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.qa-link { color: var(--zg-primary); font-size: 13px; }
.q-options { display: flex; flex-direction: column; gap: 8px; }
.q-opt { display: flex; gap: 12px; padding: 12px 16px; border-radius: 10px; background: rgba(var(--zg-primary-rgb),.04); border: 1.5px solid rgba(var(--zg-primary-rgb),.1); cursor: pointer; transition: all .2s; }
.q-opt:hover { background: rgba(var(--zg-primary-rgb),.1); }
.q-opt.on { background: rgba(var(--zg-primary-rgb),.18); border-color: var(--zg-primary); }
.qo-letter { width: 26px; height: 26px; border-radius: 50%; background: rgba(var(--zg-primary-rgb),.15); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.q-opt.on .qo-letter { background: var(--zg-primary); color: #fff; }
.submit-bar { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; margin-top: 20px; position: sticky; bottom: 0; }
.sb-info { color: var(--zg-text-dim); font-size: 14px; }
@media (max-width: 720px) { .q-head, .q-card { padding: 16px; } .submit-bar { padding: 10px 16px; } }
</style>
