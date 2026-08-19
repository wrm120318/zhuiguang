<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'

const router = useRouter()
const route = useRoute()

const q = ref<any>(null)
const subject = ref<any>(null)
const loading = ref(true)
const answer = ref('')
const multiAns = ref<string[]>([])
const submitting = ref(false)
const result = ref<any>(null)

// 批改模式：URL ?grade=subId
const gradeSubId = computed(() => {
  const v = route.query.grade
  return v ? Number(v) : null
})
const isGrading = computed(() => gradeSubId.value !== null)

// 批改态状态
const gradeScore = ref(0)
const gradeComment = ref('')
const grading = ref(false)
const gradingSub = ref<any>(null) // 当前正在批改的提交详情

const qid = Number(route.params.id)

function letter(idx: number) { return String.fromCharCode(65 + idx) }

const qtypeLabel = computed(() => {
  const t = q.value?.qtype
  return t === 'single' ? '单选题' : t === 'multiple' ? '多选题' : t === 'judge' ? '判断题' : '主观题'
})

// 学生模式：加载题目 + 已有结果
async function loadStudent() {
  loading.value = true
  try {
    const r: any = await api.subjectQuestion(qid)
    q.value = r
    subject.value = r.subject
    try {
      const res: any = await api.practiceMyResult(qid)
      if (res && res.id) result.value = res
    } catch { /* 未作答 */ }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '题目不存在')
    router.back()
  } finally { loading.value = false }
}

// 教师批改模式：加载题目 + 指定提交详情
async function loadGrade() {
  loading.value = true
  try {
    const r: any = await api.subjectQuestion(qid)
    q.value = r
    subject.value = r.subject

    const sub: any = await api.practiceSubmission(gradeSubId.value!)
    gradingSub.value = sub
    gradeScore.value = sub.score ?? 0
    gradeComment.value = sub.comment ?? ''
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '提交记录不存在')
    router.back()
  } finally { loading.value = false }
}

onMounted(() => {
  if (isGrading.value) {
    loadGrade()
  } else {
    loadStudent()
  }
})

function toggleMulti(l: string) {
  const i = multiAns.value.indexOf(l)
  if (i >= 0) multiAns.value.splice(i, 1)
  else multiAns.value.push(l)
}

async function submit() {
  let ans = answer.value
  if (q.value.qtype === 'multiple') {
    ans = multiAns.value.slice().sort().join(',')
    if (!ans) { ElMessage.warning('请至少选择一项'); return }
  } else if (q.value.qtype !== 'subjective') {
    if (!ans) { ElMessage.warning('请选择答案'); return }
  } else {
    if (!ans.trim()) { ElMessage.warning('请输入作答内容'); return }
  }
  submitting.value = true
  try {
    const r: any = await api.submitPractice(qid, ans)
    ElMessage.success(r.status === 'graded' ? '已提交，客观题自动评分完成' : '已提交，等待教师批改')
    await loadStudent()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '提交失败')
  } finally { submitting.value = false }
}

function retry() {
  result.value = null
  answer.value = ''
  multiAns.value = []
}

// 教师：提交批改
async function submitGrade() {
  if (!isGrading.value) return
  if (gradeScore.value < 0 || gradeScore.value > (gradingSub.value?.max_score ?? q.value?.score ?? 0)) {
    ElMessage.warning('分数超出范围')
    return
  }
  grading.value = true
  try {
    await api.gradePractice(gradeSubId.value!, gradeScore.value, gradeComment.value)
    ElMessage.success('批改完成')
    // 刷新提交详情，更新分数显示
    const sub: any = await api.practiceSubmission(gradeSubId.value!)
    gradingSub.value = sub
    gradeScore.value = sub.score ?? 0
    gradeComment.value = sub.comment ?? ''
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '批改失败')
  } finally { grading.value = false }
}

// 教师：删除本条提交记录
async function deleteSubmission() {
  if (!isGrading.value) return
  try {
    await ElMessageBox.confirm('确定要删除这条训练记录吗？删除后不可恢复。', '删除确认', { type: 'warning' })
    await api.deletePracticeRecord(gradeSubId.value!)
    ElMessage.success('已删除')
    router.push(`/practice/stats/${qid}`)
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e?.response?.data?.message || '删除失败')
  }
}
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>

    <!-- ===== 学生模式：作答中 ===== -->
    <div v-if="q && !result && !isGrading" class="glass-strong practice-box">
      <div class="pb-head">
        <span class="pb-subj"><ZgGlyph :emoji="subject?.icon" /> {{ subject?.name }}</span>
        <el-tag size="small">{{ qtypeLabel }}</el-tag>
        <span class="pb-score">{{ q.score }} 分</span>
        <span class="pb-author" v-if="q.creator_name">出题：{{ q.creator_name }}</span>
      </div>

      <div class="pb-content q-content" v-html="md(q.content)"></div>

      <div v-if="q.attachments?.length" class="pb-att">
        <a v-for="(a, i) in q.attachments" :key="i" :href="a.url" target="_blank" class="att-link"><ZgGlyph emoji="📎" /> {{ a.name }}</a>
      </div>

      <!-- 客观题选项 -->
      <div v-if="q.qtype === 'single' || q.qtype === 'judge'" class="opts">
        <div v-for="(opt, idx) in q.options" :key="idx" class="opt" :class="{ on: answer === letter(idx) }" @click="answer = letter(idx)">
          <span class="opt-letter">{{ letter(idx) }}</span>
          <span>{{ opt }}</span>
        </div>
      </div>
      <div v-else-if="q.qtype === 'multiple'" class="opts">
        <div v-for="(opt, idx) in q.options" :key="idx" class="opt" :class="{ on: multiAns.includes(letter(idx)) }" @click="toggleMulti(letter(idx))">
          <span class="opt-letter">{{ letter(idx) }}</span>
          <span>{{ opt }}</span>
        </div>
      </div>
      <!-- 主观题作答 -->
      <div v-else class="subj-area">
        <div class="toolbar">
          <button @click="answer += '**加粗**'"><b>B</b></button>
          <button @click="answer += '\n- 列表项\n'">列表</button>
          <button @click="answer += '\n```\n代码\n```\n'">代码</button>
        </div>
        <el-input v-model="answer" type="textarea" :rows="8" placeholder="支持 Markdown 作答" />
      </div>

      <div class="pb-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交作答</el-button>
      </div>
    </div>

    <!-- ===== 学生模式：查看结果 ===== -->
    <div v-if="q && result && !isGrading" class="glass-strong result-box">
      <h1 class="rb-title"><ZgGlyph emoji="🎯" /> 训练结果</h1>
      <div class="rb-subj"><ZgGlyph :emoji="subject?.icon" /> {{ subject?.name }} · {{ qtypeLabel }}</div>

      <div class="rb-content q-content" v-html="md(q.content)"></div>

      <div class="rb-score-row">
        <template v-if="result.status === 'graded'">
          <div class="rb-score">
            <span class="rb-num">{{ result.score }}</span>
            <span class="rb-max">/ {{ result.max_score }}</span>
          </div>
          <el-tag :type="result.correct === 1 || result.correct === true ? 'success' : 'danger'" size="large">
            <template v-if="result.correct === 1 || result.correct === true"><ZgGlyph emoji="✓" /> 正确</template><template v-else><ZgGlyph emoji="✗" /> 错误</template>
          </el-tag>
        </template>
        <template v-else>
          <el-tag type="warning" size="large"><ZgGlyph emoji="⏳" /> 等待教师批改</el-tag>
          <span class="rb-tip">主观题已提交，批改完成后将通过站内信通知你。</span>
        </template>
      </div>

      <div class="rb-line">你的作答：</div>
      <div class="rb-answer" v-html="md(result.answer || '未作答')"></div>

      <template v-if="q.qtype !== 'subjective'">
        <div class="rb-line">正确答案：<b>{{ q.answer }}</b></div>
      </template>
      <template v-else>
        <div class="rb-line" v-if="result.comment">教师评语：{{ result.comment }}</div>
        <div class="rb-line" v-if="q.answer">参考答案：</div>
        <div class="rb-ref" v-if="q.answer" v-html="md(q.answer)"></div>
      </template>

      <div class="pb-foot">
        <el-button @click="router.back()">返回题目池</el-button>
        <el-button type="primary" @click="retry">再练一次</el-button>
      </div>
    </div>

    <!-- ===== 教师批改模式 ===== -->
    <div v-if="q && isGrading && gradingSub" class="glass-strong grade-box">
      <div class="grade-header">
        <span class="grade-badge"><ZgGlyph emoji="📝" /> 教师批改</span>
        <el-tag size="small">{{ qtypeLabel }}</el-tag>
        <el-tag size="small" type="info"><ZgGlyph :emoji="subject?.icon" /> {{ subject?.name }}</el-tag>
        <span class="pb-score">{{ q.score }} 分</span>
      </div>

      <!-- 学生信息 -->
      <div class="grade-student">
        <div class="grade-student-avatar">{{ (gradingSub.real_name || gradingSub.username || '?').charAt(0) }}</div>
        <div class="grade-student-info">
          <div class="grade-student-name">{{ gradingSub.real_name || gradingSub.username }}</div>
          <div class="grade-student-time">
            作答时间：{{ gradingSub.submitted_at }}
            <span v-if="gradingSub.graded_at" class="graded-time">· 上次批改：{{ gradingSub.graded_at }}</span>
          </div>
        </div>
        <el-button size="small" type="danger" plain @click="deleteSubmission">删除记录</el-button>
      </div>

      <!-- 题目内容 -->
      <div class="grade-content q-content" v-html="md(q.content)"></div>

      <div v-if="q.attachments?.length" class="pb-att">
        <a v-for="(a, i) in q.attachments" :key="i" :href="a.url" target="_blank" class="att-link"><ZgGlyph emoji="📎" /> {{ a.name }}</a>
      </div>

      <!-- 学生作答 -->
      <div class="grade-answer-section">
        <div class="grade-label">学生作答：</div>
        <div class="grade-answer" v-html="md(gradingSub.answer || '（未作答）')"></div>
      </div>

      <!-- 参考答案（主观题） -->
      <template v-if="q.qtype === 'subjective' && q.answer">
        <div class="grade-ref-section">
          <div class="grade-label">参考答案：</div>
          <div class="grade-ref" v-html="md(q.answer)"></div>
        </div>
      </template>

      <!-- 当前分数（已批改时显示） -->
      <div v-if="gradingSub.status === 'graded'" class="grade-current-score">
        <div class="grade-label">当前得分：</div>
        <div class="grade-score-display">
          <span class="grade-score-num">{{ gradingSub.score }}</span>
          <span class="grade-score-max">/ {{ gradingSub.max_score }}</span>
          <el-tag v-if="gradingSub.comment" size="small" type="info" class="ml-2">有评语</el-tag>
        </div>
      </div>

      <!-- 批改表单 -->
      <div class="grade-form">
        <div class="grade-form-row">
          <span class="grade-form-label">打分（0-{{ q.score }}）：</span>
          <el-input-number v-model="gradeScore" :min="0" :max="q.score" :step="1" size="large" />
        </div>
        <div class="grade-form-row">
          <span class="grade-form-label">评语：</span>
          <el-input v-model="gradeComment" type="textarea" :rows="3" placeholder="选填，给学生反馈" />
        </div>
        <div class="grade-form-actions">
          <el-button @click="router.back()">返回</el-button>
          <el-button type="primary" :loading="grading" @click="submitGrade">保存批改</el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.back:hover { color: var(--zg-primary); }
.practice-box, .result-box, .grade-box { padding: 28px; margin-top: 16px; }
.pb-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.pb-subj { font-weight: 700; color: var(--zg-text); }
.pb-score { color: var(--zg-primary); font-weight: 600; }
.pb-author { margin-left: auto; font-size: 12px; color: var(--zg-text-dim); }
.pb-content { font-size: 16px; line-height: 1.9; margin-bottom: 16px; }
.pb-att { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.att-link { font-size: 13px; color: var(--zg-primary); text-decoration: underline; }
.opts { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.opt { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 10px; background: rgba(var(--zg-primary-rgb),.05); border: 2px solid transparent; cursor: pointer; transition: all .2s; }
.opt:hover { background: rgba(var(--zg-primary-rgb),.1); }
.opt.on { background: rgba(var(--zg-primary-rgb),.15); border-color: var(--zg-primary); }
.opt-letter { width: 30px; height: 30px; border-radius: 50%; background: rgba(var(--zg-primary-rgb),.15); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.opt.on .opt-letter { background: var(--zg-primary); color: #fff; }
.subj-area { margin-bottom: 20px; }
.toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
.toolbar button { background: rgba(var(--zg-primary-rgb),.06); border: 1px solid rgba(var(--zg-primary-rgb),.15); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pb-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.rb-title { font-size: 22px; font-weight: 800; text-align: center; }
.rb-subj { text-align: center; color: var(--zg-text-dim); margin: 6px 0 18px; font-size: 13px; }
.rb-content { font-size: 15px; line-height: 1.8; margin-bottom: 16px; }
.rb-score-row { display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; margin-bottom: 18px; }
.rb-score { display: flex; align-items: baseline; gap: 4px; }
.rb-num { font-size: 48px; font-weight: 800; color: var(--zg-primary); }
.rb-max { font-size: 18px; color: var(--zg-text-dim); }
.rb-tip { font-size: 13px; color: var(--zg-text-dim); }
.rb-line { font-size: 14px; color: var(--zg-text-dim); margin: 10px 0 6px; }
.rb-answer { padding: 12px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.rb-ref { padding: 12px; background: rgba(16,185,129,.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }

/* 批改模式样式 */
.grade-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 18px; }
.grade-badge { font-size: 16px; font-weight: 700; color: var(--zg-primary); }
.grade-student { display: flex; align-items: center; gap: 14px; padding: 14px 16px; background: rgba(59,130,246,.06); border-radius: 10px; margin-bottom: 18px; }
.grade-student-avatar { width: 42px; height: 42px; border-radius: 50%; background: var(--zg-primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; flex-shrink: 0; }
.grade-student-info { flex: 1; }
.grade-student-name { font-size: 15px; font-weight: 700; color: var(--zg-text); }
.grade-student-time { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.graded-time { color: var(--zg-success); }
.grade-content { font-size: 15px; line-height: 1.8; margin-bottom: 16px; }
.grade-answer-section { margin-bottom: 16px; }
.grade-label { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 6px; font-weight: 600; }
.grade-answer { padding: 12px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 8px; font-size: 14px; line-height: 1.7; min-height: 60px; }
.grade-ref-section { margin-bottom: 16px; }
.grade-ref { padding: 12px; background: rgba(16,185,129,.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.grade-current-score { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: rgba(16,185,129,.06); border-radius: 8px; margin-bottom: 18px; }
.grade-score-display { display: flex; align-items: baseline; gap: 4px; }
.grade-score-num { font-size: 28px; font-weight: 800; color: var(--zg-success); }
.grade-score-max { font-size: 14px; color: var(--zg-text-dim); }
.ml-2 { margin-left: 8px; }
.grade-form { padding: 18px; background: rgba(var(--zg-primary-rgb),.04); border-radius: 10px; border: 1px solid rgba(var(--zg-primary-rgb),.12); }
.grade-form-row { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
.grade-form-label { font-size: 14px; color: var(--zg-text); font-weight: 600; min-width: 80px; padding-top: 8px; }
.grade-form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
</style>
