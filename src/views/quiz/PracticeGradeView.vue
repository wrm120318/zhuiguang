<script setup lang="ts">
// 【v4.5.0】教师批改新界面（独立页面，非弹窗）：左侧学生作答，右侧参考答案/解析
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const id = Number(route.params.id)

const sub = ref<any>(null)
const question = ref<any>(null)
const loading = ref(true)
const noAuth = ref(false)
const score = ref(0)
const comment = ref('')
const saved = ref(false)

onMounted(async () => {
  try {
    sub.value = await api.practiceSubmission(id)
    question.value = await api.subjectQuestion(sub.value.question_id)
    if (!user.canManageSubject(question.value.subject_id)) { noAuth.value = true; return }
    score.value = sub.value.score || 0
    comment.value = sub.value.comment || ''
    if (sub.value.status === 'graded') saved.value = true
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载失败')
  } finally { loading.value = false }
})

async function onGrade() {
  try {
    await api.gradePractice(id, score.value, comment.value)
    saved.value = true
    ElMessage.success('批改已保存')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '批改失败') }
}

const qtypeLabels: Record<string, string> = { single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题', subjective: '主观题' }
</script>

<template>
  <div class="grade-page zg-container">
    <div class="page-head">
      <el-button @click="router.back()" icon="ArrowLeft">返回</el-button>
      <h2>批改题目</h2>
    </div>
    <div v-if="loading" class="loading">加载中…</div>
    <el-result v-else-if="noAuth" icon="warning" title="无权限" sub-title="你不是该题所在学科的教师" />
    <div v-else-if="question" class="grade-body">
      <div class="grade-meta">
        <el-tag>{{ qtypeLabels[question.qtype] || question.qtype }}</el-tag>
        <span>分值 {{ question.score }}</span>
        <el-tag v-if="saved" type="success">已批改</el-tag>
      </div>
      <div class="grade-cols">
        <!-- 左：题目 + 学生作答 -->
        <div class="col">
          <h3>题目 / 学生作答</h3>
          <div class="card glass">
            <div class="q-content" v-html="renderMarkdown(question.content)" />
            <div v-if="['single','multiple','judge'].includes(question.qtype)" class="q-opts">
              <div v-for="(o, i) in (question.options||[])" :key="i" class="q-opt"><b>{{ 'ABCDEFGH'[i] }}.</b> <span v-html="renderMarkdown(o)" /></div>
            </div>
          </div>
          <h4>学生答案</h4>
          <div class="card glass student">
            <div v-html="renderMarkdown(sub.answer || '（未作答）')" />
            <div class="stu-meta">
              <span>得分：{{ sub.score }}/{{ sub.max_score }}</span>
              <span v-if="sub.correct !== null">正确：{{ sub.correct ? '是' : '否' }}</span>
            </div>
          </div>
        </div>
        <!-- 右：参考答案 + 解析 -->
        <div class="col">
          <h3>参考答案 / 解析</h3>
          <div class="card glass answer">
            <div class="sec"><b>参考答案</b></div>
            <div class="q-content" v-html="renderMarkdown(question.answer || '（无）')" />
            <template v-if="question.analysis">
              <div class="sec"><b>解析</b></div>
              <div class="q-content" v-html="renderMarkdown(question.analysis)" />
            </template>
            <template v-if="question.knowledge_points?.length">
              <div class="sec"><b>知识点</b></div>
              <div><el-tag v-for="k in question.knowledge_points" :key="k.id" size="small" type="warning">{{ k.name }}</el-tag></div>
            </template>
          </div>
        </div>
      </div>
      <!-- 批改区 -->
      <div class="grade-actions card glass">
        <span>批改得分：</span>
        <el-input-number v-model="score" :min="0" :max="sub.max_score" :disabled="saved" />
        <span style="margin-left:12px">评语：</span>
        <el-input v-model="comment" placeholder="批改评语" style="width:280px" :disabled="saved" />
        <el-button v-if="!saved" type="primary" @click="onGrade" icon="Check">保存批改</el-button>
        <el-tag v-else type="success">已保存</el-tag>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grade-page { max-width: 1100px; margin: 0 auto; padding: 16px 0 60px; }
.page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.page-head h2 { margin: 0; font-size: 20px; }
.loading { padding: 40px; text-align: center; color: #888; }
.grade-meta { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.grade-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 768px) { .grade-cols { grid-template-columns: 1fr; } }
.col h3 { margin: 0 0 8px; font-size: 15px; color: #b06a00; }
.col h4 { margin: 14px 0 8px; font-size: 14px; }
.card { padding: 14px; border-radius: 12px; margin-bottom: 8px; }
.answer { background: rgba(245,158,11,0.06); }
.student { background: rgba(64,158,255,0.06); }
.sec { margin: 8px 0 4px; color: #888; font-size: 13px; }
.q-content { line-height: 1.7; }
.q-opts { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.stu-meta { margin-top: 8px; display: flex; gap: 16px; color: #888; font-size: 13px; }
.grade-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
</style>
