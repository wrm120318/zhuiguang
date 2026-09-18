<script setup lang="ts">
// 【v4.5.0】题目新增 / 二次编辑（独立新界面，非弹窗）
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import QuestionForm from '@/components/QuestionForm.vue'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const slug = route.params.slug as string
const qid = route.params.qid ? Number(route.params.qid) : null
const isEdit = !!qid

const subject = ref<any>(null)
const question = ref<any>(null)
const loading = ref(false)

onMounted(async () => {
  try {
    subject.value = await api.subject(slug)
    if (qid) {
      loading.value = true
      question.value = await api.subjectQuestion(qid)
      loading.value = false
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载失败')
  }
})

async function onSubjectLoaded() {}

async function onSubmit(payload: any) {
  if (!subject.value) return
  const sid = subject.value.id
  try {
    if (isEdit && qid) {
      await api.updateSubjectQuestion(qid, payload)
      ElMessage.success('题目已更新')
    } else {
      await api.addSubjectQuestion(sid, payload)
      ElMessage.success('题目已添加')
    }
    router.push(`/subject/${slug}/bank`)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败')
  }
}
</script>

<template>
  <div class="q-edit-page zg-container">
    <div class="page-head">
      <el-button @click="router.back()" icon="ArrowLeft">返回题库</el-button>
      <h2>{{ isEdit ? '编辑题目' : '添加题目' }} · {{ subject?.name || '' }}</h2>
    </div>
    <div v-if="loading" class="loading">加载中…</div>
    <QuestionForm
      v-else-if="subject"
      :subject-id="subject.id"
      :initial="question"
      @submit="onSubmit"
      @cancel="router.back()"
    />
  </div>
</template>

<style scoped>
.q-edit-page { max-width: 960px; margin: 0 auto; padding: 20px 0 60px; }
.page-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
.page-head h2 { font-size: 20px; margin: 0; }
.loading { padding: 40px; text-align: center; color: #888; }
</style>
