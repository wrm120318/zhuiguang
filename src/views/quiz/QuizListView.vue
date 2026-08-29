<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'

const router = useRouter()
const user = useUserStore()
const list = ref<any[]>([])
const loading = ref(false)
// 单题训练待批
const pendingPractice = ref<any[]>([])
const practiceLoading = ref(false)
// 批改弹窗
const gradeVisible = ref(false)
const gradeItem = ref<any>(null)
const gradeScore = ref(0)
const gradeComment = ref('')
const grading = ref(false)

async function load() {
  loading.value = true
  try { list.value = (await api.quizzes()) as any } finally { loading.value = false }
}

async function loadPending() {
  if (!user.isStaff) return
  practiceLoading.value = true
  try { pendingPractice.value = (await api.practicePending()) as any } finally { practiceLoading.value = false }
}

onMounted(() => { load(); loadPending() })

function statusLabel(s: string) { return s === 'published' ? '进行中' : s === 'closed' ? '已关闭' : '草稿' }
function qTypeLabel(t: string) { return t === 'single' ? '单选' : t === 'multiple' ? '多选' : t === 'judge' ? '判断' : '主观' }

const studentList = computed(() => list.value.filter(q => q.status !== 'draft'))
const teacherExams = computed(() => list.value)

async function del(q: any) {
  try {
    await ElMessageBox.confirm(`确定删除题库「${q.title}」？相关提交记录将一并删除。`, '删除题库', { type: 'error' })
    await api.deleteQuiz(q.id)
    ElMessage.success('已删除')
    await load()
  } catch { /* */ }
}

// 打开单题训练批改弹窗
function openGrade(p: any) {
  gradeItem.value = p
  gradeScore.value = 0
  gradeComment.value = ''
  gradeVisible.value = true
}

async function submitGrade() {
  if (!gradeItem.value) return
  grading.value = true
  try {
    await api.gradePractice(gradeItem.value.id, gradeScore.value, gradeComment.value)
    ElMessage.success('批改完成，已通知学生')
    gradeVisible.value = false
    await loadPending()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '批改失败')
  } finally { grading.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="head">
      <h1 class="zg-page-title"><ZgGlyph emoji="📝" /> 题库自测</h1>
      <el-button v-if="user.isStaff" type="primary" round @click="router.push('/quiz/new')">+ 组织考试</el-button>
    </div>

    <!-- 教师视图：顶部单题训练待批 -->
    <template v-if="user.isStaff">
      <div class="section">
        <div class="sec-title">
          <ZgGlyph emoji="🖐" /> 单题训练待批题目
          <el-badge v-if="pendingPractice.length" :value="pendingPractice.length" class="sec-badge" />
        </div>
        <div v-loading="practiceLoading" class="pp-list">
          <div v-for="p in pendingPractice" :key="p.id" class="pp-card glass">
            <div class="pp-head">
              <span class="pp-stu"><ZgGlyph emoji="👤" /> {{ p.real_name }}</span>
              <el-tag size="small">{{ qTypeLabel(p.qtype) }}</el-tag>
              <span class="pp-subj">{{ p.subject_name }}</span>
              <span class="pp-time">{{ p.submitted_at?.slice(0, 16) }}</span>
              <el-button type="primary" size="small" round @click="openGrade(p)">批改</el-button>
            </div>
            <div class="pp-q q-content markdown-body" v-html="md(p.qcontent)"></div>
            <div class="pp-ans-label">学生作答：</div>
            <div class="pp-ans markdown-body" v-html="md(p.answer || '未作答')"></div>
            <div class="pp-max">满分：{{ p.max_score }} 分</div>
          </div>
          <el-empty v-if="!practiceLoading && !pendingPractice.length" description="暂无待批单题训练" />
        </div>
      </div>

      <!-- 教师视图：底部考试列表 -->
      <div class="section">
        <div class="sec-title"><ZgGlyph emoji="📋" /> 考试列表（{{ teacherExams.length }} 场）</div>
        <div v-loading="loading" class="grid">
          <div v-for="q in teacherExams" :key="q.id" class="q-card glass zg-card">
            <div class="qc-head">
              <el-tag size="small" :type="q.status === 'published' ? 'success' : q.status === 'closed' ? 'info' : 'warning'">{{ statusLabel(q.status) }}</el-tag>
              <span class="qc-time">{{ q.created_at?.slice(0, 16) }}</span>
            </div>
            <div class="qc-title">{{ q.title }}</div>
            <div class="qc-desc">{{ q.description || '暂无描述' }}</div>
            <div class="qc-meta">
              <span><ZgGlyph emoji="👤" /> {{ q.creator_name || '老师' }}</span>
              <span v-if="q.duration"><ZgGlyph emoji="⏱" /> {{ q.duration }} 分钟</span>
              <span v-if="q.valid_until"><ZgGlyph emoji="📅" /> 截止 {{ q.valid_until }}</span>
            </div>
            <div class="qc-actions">
              <el-button type="primary" size="small" round @click="router.push(`/quiz/${q.id}/submissions`)">批改 / 报告</el-button>
              <el-button size="small" round @click="router.push(`/quiz/${q.id}/report`)">数据报告</el-button>
              <el-button size="small" round @click="router.push(`/quiz/${q.id}/edit`)">编辑</el-button>
              <el-button size="small" type="danger" round @click="del(q)">删除</el-button>
            </div>
          </div>
          <el-empty v-if="!loading && !teacherExams.length" description="暂无考试" />
        </div>
      </div>
    </template>

    <!-- 学生视图：题库列表 -->
    <template v-else>
      <div v-loading="loading" class="grid">
        <div v-for="q in studentList" :key="q.id" class="q-card glass zg-card">
          <div class="qc-head">
            <el-tag size="small" :type="q.status === 'published' ? 'success' : q.status === 'closed' ? 'info' : 'warning'">{{ statusLabel(q.status) }}</el-tag>
            <span class="qc-time">{{ q.created_at?.slice(0, 16) }}</span>
          </div>
          <div class="qc-title">{{ q.title }}</div>
          <div class="qc-desc">{{ q.description || '暂无描述' }}</div>
          <div class="qc-meta">
            <span><ZgGlyph emoji="👤" /> {{ q.creator_name || '老师' }}</span>
            <span v-if="q.duration"><ZgGlyph emoji="⏱" /> {{ q.duration }} 分钟</span>
            <span v-if="q.valid_until"><ZgGlyph emoji="📅" /> 截止 {{ q.valid_until }}</span>
          </div>
          <div class="qc-actions">
            <el-button type="primary" size="small" round @click="router.push(`/quiz/${q.id}`)">开始作答</el-button>
            <el-button size="small" round @click="router.push(`/quiz/${q.id}/report`)">查看报告</el-button>
          </div>
        </div>
        <el-empty v-if="!loading && !studentList.length" description="暂无题库" />
      </div>
    </template>

    <!-- 单题训练批改弹窗 -->
    <el-dialog v-model="gradeVisible" width="640px">
      <template #header><span style="font-weight:700">批改单题训练</span></template>
      <template v-if="gradeItem">
        <div class="gd-stu"><ZgGlyph emoji="👤" /> {{ gradeItem.real_name }} · {{ gradeItem.subject_name }}</div>
        <div class="gd-q q-content markdown-body" v-html="md(gradeItem.qcontent)"></div>
        <div class="gd-label">学生作答：</div>
        <div class="gd-ans markdown-body" v-html="md(gradeItem.answer || '未作答')"></div>
        <div class="gd-row">
          <span>给分：</span>
          <el-input-number v-model="gradeScore" :min="0" :max="gradeItem.max_score" />
          <span class="gd-max">/ {{ gradeItem.max_score }} 分</span>
        </div>
        <el-input v-model="gradeComment" placeholder="教师评语（选填）" type="textarea" :rows="2" style="margin-top:8px" />
      </template>
      <template #footer>
        <el-button @click="gradeVisible = false">取消</el-button>
        <el-button type="primary" :loading="grading" @click="submitGrade">提交批改</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; }
.zg-page-title { font-size: 26px; font-weight: 800; }
.section { margin-bottom: 28px; }
.sec-title { font-size: 18px; font-weight: 700; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
.sec-badge :deep(.el-badge__content) { background: #ef4444; }
.pp-list { display: flex; flex-direction: column; gap: 14px; }
.pp-card { padding: 18px 20px; }
.pp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; font-size: 13px; color: var(--zg-text-dim); flex-wrap: wrap; }
.pp-stu { font-weight: 700; color: var(--zg-text); }
.pp-subj { color: var(--zg-primary); }
.pp-time { margin-left: auto; font-size: 12px; }
.pp-q { font-size: 15px; line-height: 1.8; margin-bottom: 8px; }
.pp-ans-label { font-size: 13px; color: var(--zg-text-dim); margin: 6px 0; }
.pp-ans { padding: 12px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.pp-max { font-size: 12px; color: var(--zg-text-dim); margin-top: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.q-card { padding: 20px; }
.qc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--zg-text-dim); }
.qc-title { font-size: 17px; font-weight: 700; }
.qc-desc { color: var(--zg-text-dim); font-size: 13px; margin: 8px 0 12px; line-height: 1.6; min-height: 40px; }
.qc-meta { display: flex; gap: 12px; font-size: 12px; color: var(--zg-text-dim); margin-bottom: 12px; flex-wrap: wrap; }
.qc-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.gd-stu { font-weight: 600; margin-bottom: 10px; }
.gd-q { font-size: 15px; line-height: 1.8; margin-bottom: 8px; }
.gd-label { font-size: 13px; color: var(--zg-text-dim); margin: 6px 0; }
.gd-ans { padding: 12px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.gd-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: 14px; }
.gd-max { color: var(--zg-text-dim); font-size: 13px; }
@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .zg-page-title { font-size: 22px; } }
</style>
