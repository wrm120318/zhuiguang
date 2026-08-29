<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { renderMarkdown as renderMd } from '@/utils/markdown'
import { useUserStore } from '@/store/user'

const router = useRouter()
const route = useRoute()
const user = useUserStore()
const loading = ref(true)
// 学生报告数据
const studentData = ref<any>(null)
// 教师报告数据
const teacherData = ref<any>(null)

const isTeacherView = computed(() => user.isStaff)

onMounted(async () => {
  try {
    if (isTeacherView.value) {
      teacherData.value = await api.quizReport(Number(route.params.id))
    } else {
      studentData.value = await api.quizMyReport(Number(route.params.id))
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '报告尚未生成')
    router.replace(`/quiz/${route.params.id}`)
  } finally { loading.value = false }
})

// 学生报告计算属性
const sub = computed(() => studentData.value?.submission)
const quiz = computed(() => studentData.value?.quiz)
const questions = computed(() => studentData.value?.questions || [])
const graded = computed(() => sub.value?.answers?.graded || {})

function letter(idx: number) { return String.fromCharCode(65 + idx) }
function resultClass(q: any) { return { correct: q.qtype !== 'subjective', subjective: q.qtype === 'subjective' } }
function resultText(q: any) { return q.qtype === 'subjective' ? '主观题' : '' }
function qTypeLabel(t: string) { return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : '主观' }

// 单题实际得分（来自后端 graded[qid].score，客观题提交即出，主观题教师批改后更新）
function earnedScore(q: any) { return graded.value[q.id]?.score ?? 0 }
function scoreClass(q: any) {
  if (q.qtype === 'subjective') return sub.value?.status === 'graded' ? 'subj' : 'pending'
  return earnedScore(q) > 0 ? 'right' : 'wrong'
}
function scoreText(q: any) {
  if (q.qtype === 'subjective' && sub.value?.status !== 'graded') return '待批改'
  return `你的得分 ${earnedScore(q)} 分`
}

// 教师报告计算属性
const tSummary = computed(() => teacherData.value?.summary || {})
const tQuestions = computed(() => teacherData.value?.questions || [])
const tRanges = computed(() => teacherData.value?.ranges || [])
const tSubs = computed(() => teacherData.value?.submissions || [])
const maxRangeCount = computed(() => Math.max(1, ...tRanges.value.map((r: any) => r.count)))
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>

    <!-- ============ 教师考试数据报告 ============ -->
    <template v-if="isTeacherView && teacherData">
      <div class="glass-strong report-card">
        <h1 class="rc-title"><ZgGlyph emoji="📊" /> 考试数据报告</h1>
        <div class="rc-name">{{ teacherData.quiz?.title }}</div>

        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-num">{{ tSummary.total }}</div>
            <div class="stat-label">提交人数</div>
          </div>
          <div class="stat-item">
            <div class="stat-num warn">{{ tSummary.pending }}</div>
            <div class="stat-label">待批改</div>
          </div>
          <div class="stat-item">
            <div class="stat-num ok">{{ tSummary.graded }}</div>
            <div class="stat-label">已批改</div>
          </div>
          <div class="stat-item">
            <div class="stat-num">{{ tSummary.avg }}</div>
            <div class="stat-label">平均分</div>
          </div>
          <div class="stat-item">
            <div class="stat-num ok">{{ tSummary.max }}</div>
            <div class="stat-label">最高分</div>
          </div>
          <div class="stat-item">
            <div class="stat-num danger">{{ tSummary.min }}</div>
            <div class="stat-label">最低分</div>
          </div>
          <div class="stat-item">
            <div class="stat-num">{{ tSummary.passCount }}</div>
            <div class="stat-label">及格人数</div>
          </div>
          <div class="stat-item">
            <div class="stat-num">{{ tSummary.maxScore }}</div>
            <div class="stat-label">满分</div>
          </div>
        </div>
        <div class="pass-line">及格线：{{ tSummary.passLine }} 分 · 及格率：{{ tSummary.graded ? Math.round(tSummary.passCount / tSummary.graded * 100) : 0 }}%</div>
      </div>

      <!-- 分数段分布 -->
      <div class="glass section-card">
        <div class="sc-title"><ZgGlyph emoji="📈" /> 分数段分布（按得分率百分比，适应不同总分）</div>
        <div class="range-list">
          <div v-for="r in tRanges" :key="r.label" class="range-row">
            <span class="range-label">{{ r.label }}</span>
            <div class="range-bar-bg">
              <div class="range-bar" :style="{ width: (r.count / maxRangeCount * 100) + '%' }"></div>
            </div>
            <span class="range-count">{{ r.count }} 人</span>
          </div>
        </div>
      </div>

      <!-- 每题分析 -->
      <div class="glass section-card">
        <div class="sc-title"><ZgGlyph emoji="📝" /> 每题分析</div>
        <div v-for="(q, i) in tQuestions" :key="q.id" class="qana">
          <div class="qana-head">
            <span class="qana-no">第 {{ i + 1 }} 题</span>
            <el-tag size="small">{{ qTypeLabel(q.qtype) }}</el-tag>
            <span class="qana-score">{{ q.score }} 分</span>
            <span class="qana-rate" :class="{ low: q.correctRate < 60 }">
              {{ q.qtype === 'subjective' ? `平均 ${q.avgScore} 分` : `正确率 ${q.correctRate}%` }}
            </span>
          </div>
          <div class="qana-content markdown-body" v-html="renderMd(q.content)"></div>
          <div class="qana-detail" v-if="q.qtype !== 'subjective'">
            正确答案：<b>{{ q.answer }}</b> · 答对 {{ q.correctCnt }} / {{ q.answeredCnt }} 人
          </div>
          <div class="qana-detail" v-else>
            平均得分：{{ q.avgScore }} / {{ q.score }} · 已批 {{ q.answeredCnt }} 人
          </div>
        </div>
      </div>

      <!-- 学生成绩明细 -->
      <div class="glass section-card">
        <div class="sc-title"><ZgGlyph emoji="👥" /> 学生成绩明细</div>
        <el-table :data="tSubs" style="width: 100%" size="small">
          <el-table-column prop="real_name" label="学生" min-width="100" />
          <el-table-column label="得分" min-width="100">
            <template #default="{ row }"><b>{{ row.total_score }}</b> / {{ row.max_score }}</template>
          </el-table-column>
          <el-table-column label="状态" min-width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="row.status === 'graded' ? 'success' : 'warning'">{{ row.status === 'graded' ? '已批' : '待批' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="submitted_at" label="提交时间" min-width="140">
            <template #default="{ row }">{{ row.submitted_at?.slice(0, 16) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!tSubs.length" description="暂无提交" />
      </div>
    </template>

    <!-- ============ 学生个人报告 ============ -->
    <template v-else-if="sub">
      <div class="glass-strong report-card">
        <h1 class="rc-title"><ZgGlyph emoji="📊" /> 测评报告</h1>
        <div class="rc-name">{{ quiz?.title }}</div>

        <div class="score-row">
          <div class="score-big">
            <span class="sb-num">{{ sub.total_score }}</span>
            <span class="sb-max">/ {{ sub.max_score }}</span>
          </div>
          <el-tag :type="sub.status === 'graded' ? 'success' : 'warning'" size="large">
            <template v-if="sub.status === 'graded'"><ZgGlyph emoji="✅" /> 整张试卷报告已生成</template><template v-else><ZgGlyph emoji="⏳" /> 等待教师阅卷中</template>
          </el-tag>
        </div>

        <div v-if="sub.status === 'pending'" class="rc-pending-tip">
          <span class="rpt-icon"><ZgGlyph emoji="⏳" /></span>
          <span>客观题已自动评分，主观题正在等待教师批改。批改完成后将通过站内信通知你，届时可在此查看完整报告。</span>
        </div>
        <div v-else class="rc-graded-tip">
          <span class="rpt-icon"><ZgGlyph emoji="✅" /></span>
          <span>整张试卷已批改完成，完整测评报告已生成！</span>
        </div>

        <div class="rc-meta">
          <span><ZgGlyph emoji="📝" /> 提交时间：{{ sub.submitted_at?.slice(0, 16) }}</span>
          <span v-if="sub.graded_at"><ZgGlyph emoji="✅" /> 批改时间：{{ sub.graded_at?.slice(0, 16) }}</span>
        </div>

        <div class="rc-summary">
          <div class="rs-item">
            <div class="rs-num">{{ questions.length }}</div>
            <div class="rs-label">总题数</div>
          </div>
          <div class="rs-item">
            <div class="rs-num correct">{{ Object.values(graded).filter((g: any) => g.correct).length }}</div>
            <div class="rs-label">客观题正确</div>
          </div>
          <div class="rs-item">
            <div class="rs-num wrong">{{ Object.values(graded).filter((g: any) => g.type !== 'subjective' && !g.correct).length }}</div>
            <div class="rs-label">客观题错误</div>
          </div>
          <div class="rs-item">
            <div class="rs-num">{{ Object.values(graded).filter((g: any) => g.type === 'subjective').length }}</div>
            <div class="rs-label">主观题</div>
          </div>
        </div>
      </div>

      <div v-for="(q, i) in questions" :key="q.id" class="glass q-card">
        <div class="q-head">
          <span class="q-no">{{ i + 1 }}.</span>
          <el-tag size="small">{{ qTypeLabel(q.qtype) }}</el-tag>
          <span class="q-score" :class="scoreClass(q)">本题 {{ q.score }} 分 · {{ scoreText(q) }}</span>
          <span class="q-result" :class="resultClass(q)">{{ resultText(q) }}</span>
        </div>
        <div class="q-content markdown-body" v-html="renderMd(q.content)"></div>

        <template v-if="q.qtype === 'single' || q.qtype === 'multiple' || q.qtype === 'judge'">
          <div class="q-options">
            <div v-for="(opt, idx) in q.options" :key="idx" class="q-opt"
              :class="{
                correct: q.answer.split(',').includes(letter(idx)),
                'mine-wrong': (sub?.answers?.answers?.[q.id] || '').split(',').includes(letter(idx)) && !q.answer.split(',').includes(letter(idx))
              }">
              <span class="qo-letter">{{ letter(idx) }}</span>
              <span>{{ opt }}</span>
              <span class="qo-tag" v-if="q.answer.split(',').includes(letter(idx))"><ZgGlyph emoji="✓" /> 正确</span>
              <span class="qo-tag wrong" v-if="(sub?.answers?.answers?.[q.id] || '').split(',').includes(letter(idx)) && !q.answer.split(',').includes(letter(idx))">你的选择</span>
            </div>
          </div>
          <div class="q-line">正确答案：<b>{{ q.answer }}</b> | 你的答案：<b>{{ sub?.answers?.answers?.[q.id] || '未作答' }}</b></div>
        </template>
        <template v-else>
          <div class="q-line">你的作答：</div>
          <div class="q-answer markdown-body" v-html="renderMd(sub?.answers?.answers?.[q.id] || '未作答')"></div>
          <div class="q-line" v-if="q.answer">参考答案：</div>
          <div class="q-ref markdown-body" v-if="q.answer" v-html="renderMd(q.answer)"></div>
          <div class="q-line" v-if="graded[q.id]?.comment">教师评语：{{ graded[q.id]?.comment }}</div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.report-card { padding: 28px; margin-top: 16px; text-align: center; }
.rc-title { font-size: 22px; font-weight: 800; }
.rc-name { color: var(--zg-text-dim); margin: 6px 0 18px; }
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 10px; }
.stat-item { padding: 14px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.06); }
.stat-num { font-size: 26px; font-weight: 800; }
.stat-num.ok { color: #10b981; }
.stat-num.warn { color: var(--zg-primary); }
.stat-num.danger { color: #ef4444; }
.stat-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
.pass-line { font-size: 13px; color: var(--zg-text-dim); margin-top: 16px; }
.section-card { padding: 22px; margin-top: 16px; }
.sc-title { font-size: 17px; font-weight: 700; margin-bottom: 16px; }
.range-list { display: flex; flex-direction: column; gap: 10px; }
.range-row { display: flex; align-items: center; gap: 12px; }
.range-label { width: 70px; font-size: 13px; color: var(--zg-text-dim); }
.range-bar-bg { flex: 1; height: 22px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 6px; overflow: hidden; }
.range-bar { height: 100%; background: linear-gradient(90deg, var(--zg-primary), var(--zg-accent)); border-radius: 6px; transition: width .4s; }
.range-count { width: 60px; font-size: 13px; font-weight: 600; text-align: right; }
.qana { padding: 16px 0; border-bottom: 1px solid rgba(var(--zg-primary-rgb),.08); }
.qana:last-child { border-bottom: none; }
.qana-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
.qana-no { font-weight: 700; }
.qana-score { margin-left: auto; color: var(--zg-accent); font-size: 13px; }
.qana-rate { font-size: 13px; font-weight: 600; color: #10b981; }
.qana-rate.low { color: #ef4444; }
.qana-content { font-size: 14px; line-height: 1.7; margin-bottom: 6px; }
.qana-detail { font-size: 13px; color: var(--zg-text-dim); }
.score-row { display: flex; justify-content: center; align-items: center; gap: 24px; flex-wrap: wrap; }
.score-big { display: flex; align-items: baseline; gap: 6px; }
.sb-num { font-size: 52px; font-weight: 800; color: var(--zg-primary); }
.sb-max { font-size: 18px; color: var(--zg-text-dim); }
.rc-meta { display: flex; justify-content: center; gap: 24px; font-size: 13px; color: var(--zg-text-dim); margin-top: 16px; flex-wrap: wrap; }
.rc-pending-tip, .rc-graded-tip { display: flex; align-items: center; gap: 10px; max-width: 560px; margin: 18px auto 0; padding: 14px 18px; border-radius: 12px; font-size: 13px; line-height: 1.7; }
.rc-pending-tip { background: rgba(var(--zg-primary-rgb),.1); color: var(--zg-text); }
.rc-graded-tip { background: rgba(16,185,129,.1); color: var(--zg-text); }
.rpt-icon { font-size: 24px; flex-shrink: 0; }
.rc-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 24px; }
.rs-item { padding: 14px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.06); }
.rs-num { font-size: 22px; font-weight: 800; }
.rs-num.correct { color: #10b981; }
.rs-num.wrong { color: #ef4444; }
.rs-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
.q-card { padding: 22px; margin-top: 14px; }
.q-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.q-no { font-weight: 800; font-size: 17px; }
.q-score { margin-left: auto; color: var(--zg-accent); font-size: 13px; }
.q-score.right { color: #10b981; font-weight: 700; }
.q-score.wrong { color: #ef4444; font-weight: 700; }
.q-score.pending, .q-score.subj { color: var(--zg-accent); font-weight: 600; }
.q-result.correct { color: #10b981; font-size: 13px; font-weight: 600; }
.q-result.subjective { color: var(--zg-text-dim); font-size: 13px; }
.q-content { font-size: 15px; line-height: 1.8; margin-bottom: 14px; }
.q-content :deep(img) { max-width: 100%; border-radius: 10px; }
.q-options { display: flex; flex-direction: column; gap: 8px; }
.q-opt { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 8px; background: rgba(var(--zg-primary-rgb),.04); border: 1px solid rgba(var(--zg-primary-rgb),.1); }
.q-opt.correct { background: rgba(16,185,129,.08); border-color: #10b981; }
.q-opt.mine-wrong { background: rgba(239,68,68,.08); border-color: #ef4444; }
.qo-letter { width: 26px; height: 26px; border-radius: 50%; background: rgba(var(--zg-primary-rgb),.15); display: flex; align-items: center; justify-content: center; font-weight: 700; }
.q-opt.correct .qo-letter { background: #10b981; color: #fff; }
.q-opt.mine-wrong .qo-letter { background: #ef4444; color: #fff; }
.qo-tag { margin-left: auto; font-size: 12px; color: #10b981; }
.qo-tag.wrong { color: #ef4444; }
.q-line { font-size: 14px; color: var(--zg-text-dim); margin: 10px 0 6px; }
.q-answer, .q-ref { padding: 12px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.q-ref { background: rgba(16,185,129,.06); }
@media (max-width: 720px) {
  .stat-grid, .rc-summary { grid-template-columns: repeat(2, 1fr); }
  .report-card, .q-card, .section-card { padding: 16px; }
}
</style>
