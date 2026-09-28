<script setup lang="ts">
// 【v4.5.0】通用题目编辑表单（新增/二次编辑复用）
// 题目内容、参考答案、解析均使用全站统一 MarkdownEditor 富文本编辑器
import { ref, reactive, computed, onMounted } from 'vue'
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
  year: '',
  source: '',
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
  form.year = q.year || ''
  form.source = q.source || ''
  form.status = q.status || 'active'
  form.knowledge_point_ids = (q.knowledge_points || []).map((k: any) => k.id)
  form.options = Array.isArray(q.options) ? q.options.map((o: any) => (typeof o === 'string' ? o : (o.text ?? ''))) : []
  if (!['single', 'multiple', 'judge'].includes(form.qtype)) form.options = []
  else if (form.options.length === 0) onQtypeChange()
}

// 知识点（两级结构，用于分组多选）
// 【v4.8.25 对齐组卷网】
//   · 选项按「一级 = 分组标题，二级 = 可勾选项」展示，与组卷网的章节选择器一致；
//   · 勾选二级时**自动带上它的一级**（父节点）—— 这样侧栏点一级聚合查询才能命中，
//     用户也不必手动把父节点也勾一遍。取消勾选一级时，连同其下的二级一起取消。
const kpList = ref<any[]>([])
async function loadKp() {
  try { kpList.value = (await api.knowledgePoints(props.subjectId)) as any } catch { kpList.value = [] }
}
/** 一级节点（含「无子节点的孤立知识点」，它们也按一级处理） */
const kpRoots = computed(() => kpList.value.filter((k: any) => !k.parent_id))
/** 挂到某个一级下的二级节点 */
function kpChildren(rootId: number) {
  return kpList.value.filter((k: any) => Number(k.parent_id) === Number(rootId))
}

/**
 * 知识点勾选变化时的「父子联动」：
 *  - 勾了某个二级 → 自动把它的一级也加进勾选（让聚合筛选能命中）
 *  - 取消某个一级 → 把它下面的所有二级一并取消（避免出现"有子无父"的悬空状态）
 */
function onKpChange(next: number[]) {
  const set = new Set(next.map(Number))
  // ① 补父：任何被勾选的二级，其一级必须也在集合里
  for (const id of Array.from(set)) {
    const node = kpList.value.find((k: any) => Number(k.id) === id)
    if (node?.parent_id && !set.has(Number(node.parent_id))) set.add(Number(node.parent_id))
  }
  // ② 删子：若某个一级已不在集合里，则它下面的二级全部移除
  for (const root of kpRoots.value) {
    if (!set.has(Number(root.id))) {
      kpChildren(root.id).forEach((c: any) => set.delete(Number(c.id)))
    }
  }
  const arr = Array.from(set)
  // 避免与 v-model 形成回环（值相同时不重写）
  if (arr.length !== form.knowledge_point_ids.length || arr.some(x => !form.knowledge_point_ids.map(Number).includes(x))) {
    form.knowledge_point_ids = arr
  }
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
    year: form.year,
    source: form.source,
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
        <el-col :xs="12" :sm="6">
          <el-form-item label="年份">
            <el-input v-model="form.year" placeholder="如：2024" />
          </el-form-item>
        </el-col>
        <el-col :xs="12" :sm="6">
          <el-form-item label="题源">
            <el-select v-model="form.source" clearable placeholder="如：真题" style="width:100%">
              <el-option label="真题" value="真题" />
              <el-option label="模拟" value="模拟" />
              <el-option label="同步" value="同步" />
              <el-option label="专题" value="专题" />
              <el-option label="原创" value="原创" />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :xs="24" :sm="12">
          <el-form-item label="知识点">
            <!-- 【v4.8.25 对齐组卷网】按「一级 / 二级」分组展示；勾二级会自动带上其一级 -->
            <el-select
              v-model="form.knowledge_point_ids"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择知识点（可多选）"
              style="width:100%"
              @change="onKpChange"
            >
              <template v-for="root in kpRoots" :key="root.id">
                <!-- 有子级 → 用分组：标题是一级（本身也可勾），内容是二级 -->
                <el-option-group v-if="kpChildren(root.id).length" :label="root.name">
                  <el-option
                    v-for="k in kpChildren(root.id)"
                    :key="k.id"
                    :label="'　' + k.name"
                    :value="k.id"
                  />
                </el-option-group>
                <!-- 无子级 → 直接作为可选项 -->
                <el-option v-else :key="'r' + root.id" :label="root.name" :value="root.id" />
              </template>
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
