<script setup lang="ts">
// 【v4.5.0】智能题库主页（学科内子模块）：智能选题 + 知识点管理 + 个人题库 + 组卷入口
import { ref, reactive, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { useBasketStore } from '@/stores/basket'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage, ElMessageBox } from 'element-plus'
import DocxExportPanel from '@/components/DocxExportPanel.vue'
import WordImportPanel from '@/components/WordImportPanel.vue'
import CardsPanel from '@/components/CardsPanel.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const basket = useBasketStore()

const slug = route.params.slug as string
const subject = ref<any>(null)
const questions = ref<any[]>([])
const kpList = ref<any[]>([])
const loading = ref(false)
const showKpManager = ref(false)
const showBasket = ref(false)
const showExport = ref(false)
const showImport = ref(false)
const showCards = ref(false)
// 【v4.5.3】题目列表内联展开答案/解析——组卷场景高频需求，避免每题点进编辑页才能核对
const showAnswer = ref(false)
const expanded = ref<Record<number, boolean>>({})
function toggleExpand(id: number) { expanded.value[id] = !expanded.value[id] }

const filters = reactive({
  keyword: '', qtype: '', difficulty: '', textbook_version: '', region: '', chapter: '', knowledge_point_id: '',
})

const isStaff = computed(() => !!subject.value && user.canManageSubject(subject.value.id))

async function loadSubject() {
  subject.value = await api.subject(slug)
}
async function loadKp() {
  if (!subject.value) return
  kpList.value = (await api.knowledgePoints(subject.value.id)) as any
}
async function loadQuestions() {
  if (!subject.value) return
  loading.value = true
  try {
    const params: any = {}
    if (filters.keyword) params.keyword = filters.keyword
    if (filters.qtype) params.qtype = filters.qtype
    if (filters.difficulty) params.difficulty = filters.difficulty
    if (filters.textbook_version) params.textbook_version = filters.textbook_version
    if (filters.region) params.region = filters.region
    if (filters.chapter) params.chapter = filters.chapter
    if (filters.knowledge_point_id) params.knowledge_point_id = filters.knowledge_point_id
    questions.value = (await api.subjectQuestions(subject.value.id, params)) as any
  } finally { loading.value = false }
}

onMounted(async () => {
  await loadSubject()
  await Promise.all([loadKp(), loadQuestions()])
})

function kpNames(ids: any[]): string {
  if (!ids || !ids.length) return ''
  const map = new Map(kpList.value.map(k => [k.id, k.name]))
  return ids.map(i => map.get(i) || '').filter(Boolean).join('、')
}

function addToBasket(q: any) {
  const ok = basket.add(q, subject.value.id)
  ElMessage[ok ? 'success' : 'info'](ok ? '已加入试题篮' : '已在试题篮中')
}
async function onDelete(q: any) {
  await ElMessageBox.confirm('确定删除该题？', '提示', { type: 'warning' }).catch(() => null)
  try {
    await api.deleteSubjectQuestion(q.id)
    questions.value = questions.value.filter(x => x.id !== q.id)
    ElMessage.success('已删除')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '删除失败') }
}
async function onFavorite(q: any) {
  try { await api.favoriteQuestion(q.id); ElMessage.success('已收藏') } catch (e: any) { ElMessage.error(e?.response?.data?.message || '收藏失败') }
}

// ===== 知识点管理 =====
const kpForm = reactive({ name: '', parent_id: '' as any })
async function createKp() {
  if (!kpForm.name.trim() || !subject.value) return
  await api.createKnowledgePoint(subject.value.id, { name: kpForm.name, parent_id: kpForm.parent_id || null })
  kpForm.name = ''; kpForm.parent_id = ''
  await loadKp()
}
async function deleteKp(id: number) {
  await api.deleteKnowledgePoint(id); await loadKp()
}

const qtypeLabels: Record<string, string> = { single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' }

// ===== 智能组卷（按条件自动抽题） =====
const showSmart = ref(false)
const smart = reactive({
  difficulty: '',
  knowledge_point_id: '',
  rules: [
    { key: 'single', label: '单选题', count: 0, score: 5 },
    { key: 'multiple', label: '多选题', count: 0, score: 5 },
    { key: 'judge', label: '判断题', count: 0, score: 3 },
    { key: 'fill', label: '填空题', count: 0, score: 5 },
    { key: 'subjective', label: '主观题', count: 0, score: 10 },
  ],
})
function shuffle<T>(a: T[]): T[] { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
async function smartAssemble() {
  const active = smart.rules.filter(r => r.count > 0)
  if (!active.length) { ElMessage.warning('请至少设置一种题型的题量'); return }
  let total = 0
  for (const r of active) {
    const params: any = { qtype: r.key }
    if (smart.difficulty) params.difficulty = smart.difficulty
    if (smart.knowledge_point_id) params.knowledge_point_id = smart.knowledge_point_id
    const list = (await api.subjectQuestions(subject.value.id, params)) as any as any[]
    const picked = shuffle([...list]).slice(0, r.count)
    picked.forEach((q: any) => basket.add({ ...q, score: r.score }, subject.value.id))
    total += picked.length
  }
  if (total) { ElMessage.success(`已智能抽取 ${total} 题入篮`); showSmart.value = false; showBasket.value = true }
  else ElMessage.warning('未找到满足条件的题目，请调整筛选或先添加题目')
}
</script>

<template>
  <div class="bank-page zg-container">
    <div class="bank-head">
      <el-button @click="router.back()" icon="ArrowLeft">返回</el-button>
      <h2>{{ subject?.name }} · 智能题库</h2>
      <div class="head-actions">
        <el-button v-if="isStaff" type="primary" @click="router.push(`/subject/${slug}/bank/add`)" icon="Plus">添加题目</el-button>
        <el-button type="success" @click="showSmart = true" icon="MagicStick">智能组卷</el-button>
        <el-button @click="showCards = true" icon="Postcard">制卡</el-button>
        <el-button v-if="isStaff" @click="showImport = true" icon="Upload">Word 导入</el-button>
        <el-badge :value="basket.count()" :hidden="basket.count() === 0">
          <el-button @click="showBasket = true" icon="Files">试题篮</el-button>
        </el-badge>
      </div>
    </div>

    <!-- 筛选 -->
    <div class="filters glass">
      <el-input v-model="filters.keyword" placeholder="关键词" clearable style="width:160px" @keyup.enter="loadQuestions" />
      <el-select v-model="filters.qtype" placeholder="题型" clearable style="width:120px" @change="loadQuestions">
        <el-option v-for="(l, v) in qtypeLabels" :key="v" :label="l" :value="v" />
      </el-select>
      <el-select v-model="filters.difficulty" placeholder="难度" clearable style="width:110px" @change="loadQuestions">
        <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="`${d}星`" :value="d" />
      </el-select>
      <el-input v-model="filters.textbook_version" placeholder="教材版本" clearable style="width:130px" @keyup.enter="loadQuestions" />
      <el-input v-model="filters.region" placeholder="地区" clearable style="width:110px" @keyup.enter="loadQuestions" />
      <el-input v-model="filters.chapter" placeholder="章节" clearable style="width:140px" @keyup.enter="loadQuestions" />
      <el-select v-model="filters.knowledge_point_id" placeholder="知识点" clearable filterable style="width:160px" @change="loadQuestions">
        <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="k.id" />
      </el-select>
      <el-button type="primary" @click="loadQuestions" icon="Search">筛选</el-button>
      <el-button text @click="showAnswer = !showAnswer" :icon="showAnswer ? 'View' : 'Warning'">
        {{ showAnswer ? '隐藏答案' : '显示答案' }}
      </el-button>
      <el-button text @click="showKpManager = !showKpManager" icon="Collection">知识点管理</el-button>
    </div>

    <!-- 知识点管理 -->
    <div v-if="showKpManager" class="kp-manager glass">
      <div class="kp-add">
        <el-input v-model="kpForm.name" placeholder="新知识点名称" style="width:200px" />
        <el-select v-model="kpForm.parent_id" placeholder="上级（可选）" clearable filterable style="width:180px">
          <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="k.id" />
        </el-select>
        <el-button type="primary" @click="createKp" icon="Plus">添加</el-button>
      </div>
      <div class="kp-list">
        <div v-for="k in kpList" :key="k.id" class="kp-item">
          <span>{{ k.name }}<small v-if="k.parent_id">（子）</small></span>
          <el-button size="small" text type="danger" @click="deleteKp(k.id)" icon="Delete" />
        </div>
        <div v-if="!kpList.length" class="empty">暂无知识点，先添加</div>
      </div>
    </div>

    <!-- 题目列表 -->
    <div v-loading="loading" class="q-list">
      <div v-for="q in questions" :key="q.id" class="q-card glass">
        <div class="q-meta">
          <el-tag size="small">{{ qtypeLabels[q.qtype] || q.qtype }}</el-tag>
          <span class="diff-badge" :title="`难度 ${q.difficulty || 3} / 5`">
            <el-rate :model-value="q.difficulty || 3" disabled size="small" />
            <span class="diff-txt">难度 {{ q.difficulty || 3 }}</span>
          </span>
          <span v-if="q.score" class="tag">满分 {{ q.score }}</span>
          <span v-if="q.textbook_version" class="tag">{{ q.textbook_version }}</span>
          <span v-if="q.region" class="tag">{{ q.region }}</span>
          <span v-if="q.chapter" class="tag">{{ q.chapter }}</span>
        </div>
        <div class="q-content" v-html="renderMarkdown(q.content)" />
        <div v-if="['single','multiple','judge'].includes(q.qtype)" class="q-options">
          <div v-for="(o, i) in (q.options || [])" :key="i" class="q-opt">
            <b>{{ 'ABCDEFGH'[i] }}.</b> <span v-html="renderMarkdown(o)" />
          </div>
        </div>
        <div v-if="q.knowledge_points?.length" class="q-kp">
          <el-tag v-for="k in q.knowledge_points" :key="k.id" size="small" type="warning" effect="plain">{{ k.name }}</el-tag>
        </div>
        <!-- 【v4.5.3】答案/解析展开区（对标组卷网的题目预览） -->
        <div v-if="showAnswer" class="q-answer">
          <div class="qa-row">
            <b>答案：</b>
            <span v-html="renderMarkdown(q.answer || '（未填写）')" />
          </div>
          <div v-if="q.analysis" class="qa-row qa-analysis">
            <b>解析：</b>
            <span v-html="renderMarkdown(q.analysis)" />
          </div>
        </div>
        <div class="q-actions">
          <el-button size="small" @click="addToBasket(q)" icon="CirclePlus">入篮</el-button>
          <el-button size="small" @click="onFavorite(q)" icon="Star">收藏</el-button>
          <el-button v-if="isStaff" size="small" type="primary" @click="router.push(`/subject/${slug}/bank/${q.id}/edit`)" icon="Edit">编辑</el-button>
          <el-button v-if="isStaff" size="small" type="danger" text @click="onDelete(q)" icon="Delete">删除</el-button>
        </div>
      </div>
      <div v-if="!loading && !questions.length" class="empty">暂无题目，点击「添加题目」或「Word 导入」</div>
    </div>

    <!-- 试题篮抽屉 -->
    <el-drawer v-model="showBasket" title="试题篮 · 组卷" size="46%" :append-to-body="true">
      <div class="basket">
        <div v-for="(it, idx) in basket.items" :key="it.id" class="basket-item">
          <div class="bi-order">
            <el-button size="small" text :disabled="idx===0" @click="basket.reorder(idx, idx-1)" icon="Top" />
            <el-button size="small" text :disabled="idx===basket.items.length-1" @click="basket.reorder(idx, idx+1)" icon="Bottom" />
          </div>
          <div class="bi-content"><span class="bi-idx">{{ idx+1 }}.</span> <span v-html="renderMarkdown(it.content)" /></div>
          <el-input-number v-model="it.basketScore" :min="1" :max="100" size="small" @change="(v:number)=>basket.setScore(it.id, v)" />
          <el-button size="small" text type="danger" @click="basket.remove(it.id)" icon="Delete" />
        </div>
        <div v-if="!basket.items.length" class="empty">试题篮为空，去题目列表点「入篮」</div>
      </div>
      <template #footer>
        <span>总分：<b>{{ basket.totalScore() }}</b> 分 / {{ basket.count() }} 题</span>
        <div style="margin-top:8px">
          <el-button @click="basket.clear">清空</el-button>
          <el-button type="primary" :disabled="!basket.items.length" @click="showExport = true">导出 Word / 答题卡</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="showExport" title="导出设置" width="560px" append-to-body>
      <DocxExportPanel v-if="subject" :subject-name="subject.name" :items="basket.items" @done="showExport=false" />
    </el-dialog>

    <el-dialog v-model="showImport" title="Word 试卷导入（自动拆分）" width="720px" append-to-body>
      <WordImportPanel v-if="subject" :subject-id="subject.id" @imported="() => { showImport=false; loadQuestions(); loadKp() }" />
    </el-dialog>

    <!-- 制卡 -->
    <el-dialog v-model="showCards" title="制卡（试题卡 / 错题卡 / 知识点卡）" width="760px" append-to-body>
      <CardsPanel v-if="subject" :subject-id="subject.id" :questions="questions" />
    </el-dialog>

    <!-- 智能组卷 -->
    <el-dialog v-model="showSmart" title="智能组卷（按条件自动抽题）" width="560px" append-to-body>
      <div class="smart">
        <div class="smart-filters">
          <el-select v-model="smart.difficulty" placeholder="难度（不限）" clearable style="width:160px">
            <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="`${d}星`" :value="d" />
          </el-select>
          <el-select v-model="smart.knowledge_point_id" placeholder="知识点（不限）" clearable filterable style="width:200px">
            <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="k.id" />
          </el-select>
        </div>
        <div class="smart-rule" v-for="r in smart.rules" :key="r.key">
          <span class="sr-label">{{ r.label }}</span>
          <el-input-number v-model="r.count" :min="0" :max="200" size="small" /> <span class="sr-unit">题</span>
          <span class="sr-score">每题</span>
          <el-input-number v-model="r.score" :min="1" :max="100" size="small" /> <span class="sr-unit">分</span>
        </div>
        <el-alert type="info" :closable="false" title="说明" description="系统按题型/难度/知识点从本题库随机抽取并加入试题篮，可继续手动增减后导出 Word。" />
      </div>
      <template #footer>
        <el-button @click="showSmart = false">取消</el-button>
        <el-button type="primary" @click="smartAssemble" icon="MagicStick">自动抽题入篮</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bank-page { max-width: 1280px; margin: 0 auto; padding: 16px 20px 60px; }
.bank-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.bank-head h2 { font-size: 20px; margin: 0; flex: 1; }
.head-actions { display: flex; gap: 8px; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px; margin-bottom: 12px; border-radius: 14px; }
.kp-manager { padding: 12px; margin-bottom: 12px; border-radius: 14px; }
.kp-add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.kp-list { display: flex; flex-wrap: wrap; gap: 8px; }
.kp-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(245,158,11,0.1); border-radius: 8px; }
.kp-item small { color: #999; margin-left: 4px; }
.q-list { display: flex; flex-direction: column; gap: 12px; }
.q-card { padding: 14px 16px; border-radius: 14px; }
.q-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.tag { font-size: 12px; color: #b06a00; background: rgba(245,158,11,0.12); padding: 1px 8px; border-radius: 6px; }
/* 【v4.5.3】难度徽标：星级 + 文字，紧凑排版，避免星级灰幽灵观感 */
.diff-badge { display: inline-flex; align-items: center; gap: 6px; }
.diff-badge :deep(.el-rate) { height: 18px; line-height: 18px; }
.diff-badge :deep(.el-rate__icon) { font-size: 14px; margin-right: 1px; }
.diff-txt { font-size: 12px; color: #999; }
.q-content { line-height: 1.7; }
.q-options { margin: 8px 0; display: flex; flex-direction: column; gap: 6px; }
/* 【v4.5.3 修复】选项字母与内容必须同行：
   此前 .q-opt 无 flex，renderMarkdown 输出的块级元素（KaTeX 公式等）会把 "A." 挤到上一行，
   出现「A.⏎√2」的断裂排版。改为 flex 行内对齐，并让内容区可换行。 */
.q-opt { display: flex; align-items: baseline; gap: 6px; line-height: 1.7; }
.q-opt > b { flex: 0 0 auto; min-width: 18px; font-weight: 600; color: #b06a00; }
.q-opt > span { flex: 1 1 auto; min-width: 0; }
/* 选项内的块级元素（KaTeX 独立公式/段落）改为与文字同行，避免断行 */
.q-opt > span :deep(p) { display: inline; margin: 0; }
.q-opt > span :deep(.katex-display) { display: inline-block; margin: 0; vertical-align: middle; }
.q-opt > span :deep(.katex) { font-size: 1.02em; }
.q-kp { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
/* 【v4.5.3】答案/解析区样式 */
.q-answer { margin: 10px 0 4px; padding: 10px 12px; border-radius: 10px; background: rgba(245,158,11,0.07); border-left: 3px solid rgba(245,158,11,0.5); }
.qa-row { display: flex; align-items: baseline; gap: 6px; line-height: 1.75; }
.qa-row > b { flex: 0 0 auto; color: #b06a00; }
.qa-row > span { flex: 1 1 auto; min-width: 0; }
.qa-row > span :deep(p) { display: inline; margin: 0; }
.qa-analysis { margin-top: 4px; color: #6b7280; }
.qa-analysis > span :deep(.katex-display) { display: inline-block; margin: 0; vertical-align: middle; }
.q-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.basket-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
.bi-order { display: flex; flex-direction: column; }
.bi-content { flex: 1; line-height: 1.5; max-height: 60px; overflow: hidden; }
.bi-idx { font-weight: 700; color: #F59E0B; margin-right: 4px; }
.empty { padding: 30px; text-align: center; color: #999; }
.smart { padding: 4px; }
.smart-filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.smart-rule { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed rgba(0,0,0,0.08); }
.sr-label { width: 80px; font-weight: 600; }
.sr-score { margin-left: 12px; color: #888; font-size: 13px; }
.sr-unit { color: #888; font-size: 13px; }
</style>
