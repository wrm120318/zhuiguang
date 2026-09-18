<script setup lang="ts">
// 【v4.5.0】通用题目编辑表单（新增/二次编辑复用）
// 题目内容、参考答案、解析均使用全站统一 MarkdownEditor 富文本编辑器
import { ref, reactive, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  subjectId: number
  initial?: any | null
}>()
const emit = defineEmits<{
  (e: 'submit', payload: any): void
  (e: 'cancel'): void
}>()

const route = useRoute()
const qtypes = [
  { v: 'single', label: '单选题' },
  { v: 'multiple', label: '多选题' },
  { v: 'judge', label: '判断题' },
  { v: 'fill', label: '填空题' },
  { v: 'subjective', label: '主观题' },
]
const difficultyOptions = [1, 2, 3, 4, 5]

const form = reactive({
  qtype: 'single',
  content: '',
  answer: '',
  analysis: '',
  score: 5,
  difficulty: 3,
  textbook_version: '',
  region: '',
  chapter: '',
  status: 'active',
  knowledge_point_ids: [] as number[],
  options: [] as string[],
})

// 选项编辑（选择题）
const optionLetters = 'ABCDEFGH'
function ensureOptions(n: number) {
  while (form.options.length < n) form.options.push('')
  while (form.options.length > n) form.options.pop()
}
function onQtypeChange() {
  if (['single', 'multiple', 'judge'].includes(form.qtype)) {
    const need = form.qtype === 'judge' ? 2 : 4
    ensureOptions(need)
    if (form.qtype === 'judge') {
      form.options = ['正确', '错误']
    }
  } else {
    form.options = []
  }
}

function syncFromInitial() {
  const q = props.initial
  if (!q) { onQtypeChange(); return }
  form.qtype = q.qtype || 'single'
  form.content = q.content || ''
  form.answer = q.answer || ''
  form.analysis = q.analysis || ''
  form.score = q.score || 5
  form.difficulty = q.difficulty || 3
  form.textbook_version = q.textbook_version || ''
  form.region = q.region || ''
  form.chapter = q.chapter || ''
  form.status = q.status || 'active'
  form.knowledge_point_ids = (q.knowledge_points || []).map((k: any) => k.id)
  form.options = Array.isArray(q.options) ? q.options.map((o: any) => (typeof o === 'string' ? o : (o.text ?? ''))) : []
  if (!['single', 'multiple', 'judge'].includes(form.qtype)) form.options = []
  else if (form.options.length === 0) onQtypeChange()
}

// 知识点（树状，用于多选）
const kpList = ref<any[]>([])
async function loadKp() {
  try { kpList.value = (await api.knowledgePoints(props.subjectId)) as any } catch { kpList.value = [] }
}

onMounted(async () => {
  await loadKp()
  syncFromInitial()
})

function buildPayload() {
  const isChoice = ['single', 'multiple', 'judge'].includes(form.qtype)
  return {
    qtype: form.qtype,
    content: form.content,
    answer: form.answer,
    analysis: form.analysis,
    score: Number(form.score) || 5,
    difficulty: Number(form.difficulty) || 3,
    textbook_version: form.textbook_version,
    region: form.region,
    chapter: form.chapter,
    status: form.status,
    knowledge_point_ids: form.knowledge_point_ids,
    options: isChoice ? form.options.map(s => s) : [],
  }
}

function onSubmit() {
  if (!form.content.trim()) { ElMessage.warning('题目内容不能为空'); return }
  emit('submit', buildPayload())
}
</script>

<template>
  <div class="q-form">
    <el-form label-position="top">
      <el-row :gutter="16">
        <el-col :xs="24" :sm="8">
          <el-form-item label="题型">
            <el-select v-model="form.qtype" @change="onQtypeChange" style="width:100%">
              <el-option v-for="t in qtypes" :key="t.v" :label="t.label" :value="t.v" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="12" :sm="8">
          <el-form-item label="分值">
            <el-input-number v-model="form.score" :min="1" :max="100" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :sm="8">
          <el-form-item label="难度">
            <el-rate v-model="form.difficulty" :max="5" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="题目内容（富文本）">
        <MarkdownEditor v-model="form.content" :min-height="200" />
      </el-form-item>

      <!-- 选择题选项 -->
      <el-form-item v-if="['single','multiple','judge'].includes(form.qtype)" label="选项">
        <div class="opt-list">
          <div v-for="(opt, idx) in form.options" :key="idx" class="opt-row">
            <span class="opt-key">{{ optionLetters[idx] }}</span>
            <el-input v-model="form.options[idx]" :placeholder="`选项 ${optionLetters[idx]}`" />
          </div>
        </div>
      </el-form-item>

      <el-form-item label="参考答案（富文本）">
        <MarkdownEditor v-model="form.answer" :min-height="140" />
      </el-form-item>

      <el-form-item label="详细解析（富文本）">
        <MarkdownEditor v-model="form.analysis" :min-height="140" />
      </el-form-item>

      <el-divider>精细化标签（智能选题）</el-divider>
      <el-row :gutter="16">
        <el-col :xs="24" :sm="12">
          <el-form-item label="教材版本">
            <el-input v-model="form.textbook_version" placeholder="如：人教 / 北师大 / 苏教" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :sm="12">
          <el-form-item label="适用地区">
            <el-input v-model="form.region" placeholder="如：全国 / 江苏" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :sm="12">
          <el-form-item label="章节">
            <el-input v-model="form.chapter" placeholder="如：第一章 集合" />
          </el-form-item>
        </el-col>
        <el-col :xs="24" :sm="12">
          <el-form-item label="知识点">
            <el-select v-model="form.knowledge_point_ids" multiple filterable placeholder="选择知识点" style="width:100%">
              <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="k.id" />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item>
        <el-button type="primary" @click="onSubmit">保存</el-button>
        <el-button @click="emit('cancel')">取消</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<style scoped>
.opt-list { width: 100%; display: flex; flex-direction: column; gap: 8px; }
.opt-row { display: flex; align-items: center; gap: 10px; }
.opt-key {
  width: 28px; height: 28px; flex: 0 0 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: var(--zg-glass-1-bg, rgba(245,158,11,0.15)); color: #F59E0B; font-weight: 700;
}
</style>
