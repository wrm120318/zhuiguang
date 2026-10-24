<script setup lang="ts">
// 【v4.5.0】通用题目编辑表单（新增/二次编辑复用）
// 题目内容、参考答案、解析均使用全站统一 MarkdownEditor 富文本编辑器
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

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

// 知识点（v4.18.4：无限层级，扁平选项 + 全链父子联动）
// 【v4.18.4】原实现按「一级 = 分组标题，二级 = 可勾选项」展示，只能给**叶子**节点打标；
//   层级放开后任意节点都要可勾选，故改为**扁平选项列表**（缩进 + N级标签），
//   父子联动从「一层」升级为**整条祖先链 / 整棵子孙树**：
//   · 勾选任意节点 → 自动带上它的每一级祖先（侧栏点上级聚合查询才能命中）
//   · 取消某个节点 → 它的全部子孙一并取消（避免"有子无父"的悬空状态）
const kpList = ref<any[]>([])
async function loadKp() {
  try { kpList.value = (await api.knowledgePoints(props.subjectId)) as any } catch { kpList.value = [] }
}
/** id → 直接父 id（顶级为 null） */
const kpParentOf = computed(() => new Map(kpList.value.map((k: any) => [Number(k.id), k.parent_id ? Number(k.parent_id) : null])))
/** id → 深度（顶级=0），由根递归计算 */
const kpDepthOf = computed(() => {
  const m = new Map<number, number>()
  const childrenOf = new Map<number, number[]>()
  kpList.value.forEach((k: any) => {
    const p = k.parent_id ? Number(k.parent_id) : null
    if (p != null) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(Number(k.id))
  })
  const walk = (id: number, d: number, seen: Set<number>) => {
    if (seen.has(id)) return
    seen.add(id); m.set(id, d)
    ;(childrenOf.get(id) || []).forEach(c => walk(c, d + 1, seen))
  }
  kpList.value.filter((k: any) => !k.parent_id).forEach((r: any) => walk(Number(r.id), 0, new Set()))
  return m
})
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
const kpLevelName = (d: number) => (CN_NUM[d] ?? String(d + 1)) + '级'
/** 扁平选项：按深度排序，标签带缩进（NBSP）与层级 */
const kpFlatOptions = computed(() => {
  const depth = kpDepthOf.value
  return kpList.value
    .slice()
    .sort((a: any, b: any) => (depth.get(Number(a.id)) ?? 0) - (depth.get(Number(b.id)) ?? 0) || Number(a.id) - Number(b.id))
    .map((k: any) => {
      const d = depth.get(Number(k.id)) ?? 0
      return { id: Number(k.id), label: '\u00A0\u00A0'.repeat(d) + `${k.name}（${kpLevelName(d)}）` }
    })
})

/** 知识点勾选变化时的「父子联动」（全链版） */
function onKpChange(next: number[]) {
  const set = new Set(next.map(Number))
  // ① 补父：任何被勾选的节点，它的**每一级祖先**都必须在集合里
  for (const id of Array.from(set)) {
    let p = kpParentOf.value.get(id) ?? null
    const seen = new Set<number>([id])
    while (p && !seen.has(p)) { seen.add(p); set.add(p); p = kpParentOf.value.get(p) ?? null }
  }
  // ② 删子：若某节点不在集合里，它的**全部子孙**一并移除
  const childrenOf = new Map<number, number[]>()
  kpList.value.forEach((k: any) => {
    const p = k.parent_id ? Number(k.parent_id) : null
    if (p != null) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(Number(k.id))
  })
  const removeDesc = (id: number, seen: Set<number>) => {
    if (seen.has(id)) return
    seen.add(id)
    ;(childrenOf.get(id) || []).forEach(c => { set.delete(c); removeDesc(c, seen) })
  }
  for (const k of kpList.value) if (!set.has(Number(k.id))) removeDesc(Number(k.id), new Set())
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
            <!-- 【v4.18.4】无限层级：扁平选项（缩进 + N级标签）替代原来的两级分组；
                 勾选任意节点会自动带上它的每一级祖先，取消则连带取消全部子孙 -->
            <el-select
              v-model="form.knowledge_point_ids"
              multiple
              filterable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择知识点（可多选，任意层级）"
              style="width:100%"
              @change="onKpChange"
            >
              <el-option
                v-for="k in kpFlatOptions"
                :key="k.id"
                :label="k.label"
                :value="k.id"
              />
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
