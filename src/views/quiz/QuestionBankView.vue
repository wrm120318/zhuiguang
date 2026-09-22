<script setup lang="ts">
// 【v4.6.0】智能题库主页（对标组卷网/智学网）：知识树 + 多维筛选 + 精致题卡 + 题目详情（同类题/纠错/收藏）
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
// 题目列表内联展开答案/解析
const showAnswer = ref(false)
const expanded = ref<Record<number, boolean>>({})
function toggleExpand(id: number) { expanded.value[id] = !expanded.value[id] }

const filters = reactive({
  keyword: '', qtype: '', difficulty: '', textbook_version: '', region: '', chapter: '', year: '', source: '', knowledge_point_id: '',
})

const isStaff = computed(() => !!subject.value && user.canManageSubject(subject.value.id))
const qtypeLabels: Record<string, string> = { single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' }
const qtypeColor: Record<string, string> = {
  single: '#f59e0b', multiple: '#10b981', judge: '#3b82f6', fill: '#8b5cf6', subjective: '#ef4444',
}

const stats = computed(() => {
  const byType: Record<string, number> = {}
  questions.value.forEach(q => { byType[q.qtype] = (byType[q.qtype] || 0) + 1 })
  return { total: questions.value.length, kp: kpList.value.length, byType }
})

// ===== 知识点树 =====
const kpTree = computed(() => {
  const list = kpList.value.map(k => ({ ...k, children: [] as any[], childCount: 0 }))
  const map = new Map<number, any>(); list.forEach(k => map.set(k.id, k))
  const roots: any[] = []
  list.forEach(k => {
    if (k.parent_id && map.has(k.parent_id)) { map.get(k.parent_id).children.push(k); map.get(k.parent_id).childCount++ }
    else roots.push(k)
  })
  return roots
})
const expandedKp = reactive<Record<number, boolean>>({})
function flatten(nodes: any[], depth = 0, out: any[] = []): any[] {
  for (const n of nodes) { out.push({ ...n, depth }); if (n.children.length && expandedKp[n.id]) flatten(n.children, depth + 1, out) }
  return out
}
const flatKps = computed(() => flatten(kpTree.value))
const kpCount = computed(() => {
  const m: Record<number, number> = {}
  questions.value.forEach(q => (q.knowledge_points || []).forEach((k: any) => { m[k.id] = (m[k.id] || 0) + 1 }))
  return m
})
function toggleKp(id: number) { expandedKp[id] = !expandedKp[id] }
function selectKp(id: number | null) { filters.knowledge_point_id = id ? String(id) : ''; loadQuestions() }

async function loadSubject() { subject.value = await api.subject(slug) }
async function loadKp() { if (subject.value) kpList.value = (await api.knowledgePoints(subject.value.id)) as any }
async function loadQuestions() {
  if (!subject.value) return
  loading.value = true
  try {
    const params: any = {}
    for (const k of ['keyword', 'qtype', 'difficulty', 'textbook_version', 'region', 'chapter', 'year', 'source', 'knowledge_point_id']) {
      if ((filters as any)[k]) params[k] = (filters as any)[k]
    }
    questions.value = (await api.subjectQuestions(subject.value.id, params)) as any
  } finally { loading.value = false }
}

onMounted(async () => {
  await loadSubject()
  await Promise.all([loadKp(), loadQuestions()])
  // 默认展开一级知识点
  kpTree.value.forEach(n => { if (n.children.length) expandedKp[n.id] = true })
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
  try { await api.favoriteQuestion(q.id); ElMessage.success('已收藏到个人题库') } catch (e: any) { ElMessage.error(e?.response?.data?.message || '收藏失败') }
}

// ===== 题目详情抽屉（同类题 / 纠错 / 收藏）=====
const showDetail = ref(false)
const detail = ref<any>(null)
const similar = ref<any[]>([])
async function openDetail(q: any) {
  detail.value = q
  showDetail.value = true
  try {
    const kpId = (q.knowledge_points && q.knowledge_points[0]?.id) || filters.knowledge_point_id
    if (kpId) {
      const list = (await api.subjectQuestions(subject.value.id, { knowledge_point_id: kpId })) as any
      similar.value = (list || []).filter((x: any) => x.id !== q.id).slice(0, 6)
    } else similar.value = []
  } catch { similar.value = [] }
}
// ===== 纠错 =====
const showFeedback = ref(false)
const feedbackText = ref('')
async function submitFeedback() {
  if (!detail.value) return
  if (!feedbackText.value.trim()) { ElMessage.warning('请填写纠错说明'); return }
  try { await api.questionFeedback(detail.value.id, feedbackText.value.trim()); ElMessage.success('纠错已提交，感谢反馈'); showFeedback.value = false; feedbackText.value = '' } catch (e: any) { ElMessage.error(e?.response?.data?.message || '提交失败') }
}

// ===== 知识点管理 =====
const kpForm = reactive({ name: '', parent_id: '' as any })
async function createKp() {
  if (!kpForm.name.trim() || !subject.value) return
  await api.createKnowledgePoint(subject.value.id, { name: kpForm.name, parent_id: kpForm.parent_id || null })
  kpForm.name = ''; kpForm.parent_id = ''
  await loadKp()
}
async function deleteKp(id: number) { await api.deleteKnowledgePoint(id); await loadKp() }

// ===== 智能组卷（按条件自动抽题）=====
const showSmart = ref(false)
const smart = reactive({
  difficulty: '', knowledge_point_id: '',
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
    <!-- 头部：学科 + 统计 + 主操作 -->
    <div class="bank-head glass">
      <div class="bh-left">
        <el-button @click="router.back()" icon="ArrowLeft" circle plain />
        <div>
          <h2>{{ subject?.name }} · 智能题库</h2>
          <div class="bh-sub">对标组卷网 / 智学网 · 多维筛选 · 智能组卷 · Word 导出</div>
        </div>
      </div>
      <div class="bh-stats">
        <div class="stat"><b>{{ stats.total }}</b><span>题目</span></div>
        <div class="stat"><b>{{ stats.kp }}</b><span>知识点</span></div>
        <div class="stat" v-for="(c, k) in stats.byType" :key="k"><b>{{ c }}</b><span>{{ qtypeLabels[k] }}</span></div>
      </div>
      <div class="bh-actions">
        <el-button v-if="isStaff" type="primary" @click="router.push(`/subject/${slug}/bank/add`)" icon="Plus">添加题目</el-button>
        <el-button type="success" @click="showSmart = true" icon="MagicStick">智能组卷</el-button>
        <el-button @click="showCards = true" icon="Postcard">制卡</el-button>
        <el-button v-if="isStaff" @click="showImport = true" icon="Upload">Word 导入</el-button>
        <el-badge :value="basket.count(subject.id)" :hidden="basket.count(subject.id) === 0">
          <el-button @click="showBasket = true" icon="Files">试题篮</el-button>
        </el-badge>
      </div>
    </div>

    <div class="bank-body">
      <!-- 左侧：知识点树 -->
      <aside class="kp-aside glass">
        <div class="kp-aside-head">
          <span><el-icon><Collection /></el-icon> 知识点</span>
          <el-button text size="small" @click="selectKp(null)" :type="!filters.knowledge_point_id ? 'primary' : 'default'">全部</el-button>
        </div>
        <div class="kp-tree">
          <div v-for="n in flatKps" :key="n.id" class="kp-node" :class="{ active: filters.knowledge_point_id === String(n.id) }" :style="{ paddingLeft: 8 + n.depth * 16 + 'px' }">
            <span v-if="n.childCount" class="chev" @click.stop="toggleKp(n.id)">{{ expandedKp[n.id] ? '▾' : '▸' }}</span>
            <span v-else class="chev placeholder">·</span>
            <span class="kp-name" @click="selectKp(n.id)">{{ n.name }}</span>
            <span class="kp-count" v-if="kpCount[n.id]">{{ kpCount[n.id] }}</span>
          </div>
          <div v-if="!flatKps.length" class="empty-sm">暂无知识点</div>
        </div>
        <el-button v-if="isStaff" text size="small" class="kp-mgr-btn" @click="showKpManager = !showKpManager" icon="Setting">管理知识点</el-button>
      </aside>

      <!-- 右侧：筛选 + 题卡 -->
      <section class="bank-main">
        <div class="filters glass">
          <el-input v-model="filters.keyword" placeholder="关键词" clearable style="width:150px" @keyup.enter="loadQuestions" />
          <el-select v-model="filters.qtype" placeholder="题型" clearable style="width:110px" @change="loadQuestions">
            <el-option v-for="(l, v) in qtypeLabels" :key="v" :label="l" :value="v" />
          </el-select>
          <el-select v-model="filters.difficulty" placeholder="难度" clearable style="width:100px" @change="loadQuestions">
            <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="`${d}星`" :value="d" />
          </el-select>
          <el-input v-model="filters.textbook_version" placeholder="教材版本" clearable style="width:120px" @keyup.enter="loadQuestions" />
          <el-input v-model="filters.region" placeholder="地区" clearable style="width:100px" @keyup.enter="loadQuestions" />
          <el-input v-model="filters.chapter" placeholder="章节" clearable style="width:120px" @keyup.enter="loadQuestions" />
          <el-input v-model="filters.year" placeholder="年份" clearable style="width:90px" @keyup.enter="loadQuestions" />
          <el-select v-model="filters.source" placeholder="题源" clearable style="width:100px" @change="loadQuestions">
            <el-option label="真题" value="真题" /><el-option label="模拟" value="模拟" />
            <el-option label="同步" value="同步" /><el-option label="专题" value="专题" /><el-option label="原创" value="原创" />
          </el-select>
          <el-button type="primary" @click="loadQuestions" icon="Search">筛选</el-button>
          <el-button text @click="showAnswer = !showAnswer" :icon="showAnswer ? 'View' : 'Hide'">{{ showAnswer ? '隐藏答案' : '显示答案' }}</el-button>
        </div>

        <!-- 知识点管理 -->
        <div v-if="showKpManager" class="kp-manager glass">
          <div class="kp-add">
            <el-input v-model="kpForm.name" placeholder="新知识点名称" style="width:200px" />
            <el-select v-model="kpForm.parent_id" placeholder="上级（可选）" clearable filterable style="width:170px">
              <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="k.id" />
            </el-select>
            <el-button type="primary" @click="createKp" icon="Plus">添加</el-button>
          </div>
          <div class="kp-list">
            <div v-for="k in kpList" :key="k.id" class="kp-item">
              <span>{{ k.name }}<small v-if="k.parent_id">（子）</small></span>
              <el-button size="small" text type="danger" @click="deleteKp(k.id)" icon="Delete" />
            </div>
            <div v-if="!kpList.length" class="empty-sm">暂无知识点，先添加</div>
          </div>
        </div>

        <!-- 题目卡片 -->
        <div v-loading="loading" class="q-list">
          <div v-for="q in questions" :key="q.id" class="q-card glass" @click="openDetail(q)">
            <span class="q-bar" :style="{ background: qtypeColor[q.qtype] || '#f59e0b' }" />
            <div class="q-meta">
              <el-tag size="small" :style="{ borderColor: qtypeColor[q.qtype], color: qtypeColor[q.qtype] }" effect="plain">{{ qtypeLabels[q.qtype] || q.qtype }}</el-tag>
              <span class="diff-badge" title="难度">
                <el-rate :model-value="q.difficulty || 3" disabled size="small" />
                <span class="diff-txt">难度 {{ q.difficulty || 3 }}</span>
              </span>
              <span v-if="q.score" class="tag">满分 {{ q.score }}</span>
              <span v-if="q.textbook_version" class="tag">{{ q.textbook_version }}</span>
              <span v-if="q.region" class="tag">{{ q.region }}</span>
              <span v-if="q.year" class="tag">{{ q.year }}</span>
              <span v-if="q.source" class="tag src">{{ q.source }}</span>
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
            <div v-if="showAnswer" class="q-answer">
              <div class="qa-row"><b>答案：</b><span v-html="renderMarkdown(q.answer || '（未填写）')" /></div>
              <div v-if="q.analysis" class="qa-row qa-analysis"><b>解析：</b><span v-html="renderMarkdown(q.analysis)" /></div>
            </div>
            <div class="q-actions" @click.stop>
              <el-button size="small" @click="addToBasket(q)" icon="CirclePlus">入篮</el-button>
              <el-button size="small" @click="onFavorite(q)" icon="Star">收藏</el-button>
              <el-button size="small" @click="openDetail(q)" icon="ZoomIn">详情</el-button>
              <el-button v-if="isStaff" size="small" type="primary" @click="router.push(`/subject/${slug}/bank/${q.id}/edit`)" icon="Edit">编辑</el-button>
              <el-button v-if="isStaff" size="small" type="danger" text @click="onDelete(q)" icon="Delete">删除</el-button>
            </div>
          </div>
          <div v-if="!loading && !questions.length" class="empty">暂无题目，点击「添加题目」或「Word 导入」</div>
        </div>
      </section>
    </div>

    <!-- 试题篮抽屉 -->
    <el-drawer v-model="showBasket" title="试题篮 · 组卷" size="46%" :append-to-body="true">
      <div class="basket">
        <div v-for="(it, idx) in basket.items(subject.id)" :key="it.id" class="basket-item">
          <div class="bi-order">
            <el-button size="small" text :disabled="idx===0" @click="basket.reorder(idx, idx-1, subject.id)" icon="Top" />
            <el-button size="small" text :disabled="idx===basket.items(subject.id).length-1" @click="basket.reorder(idx, idx+1, subject.id)" icon="Bottom" />
          </div>
          <div class="bi-content"><span class="bi-idx">{{ idx+1 }}.</span> <span v-html="renderMarkdown(it.content)" /></div>
          <el-input-number v-model="it.basketScore" :min="1" :max="100" size="small" @change="(v:number)=>basket.setScore(it.id, v, subject.id)" />
          <el-button size="small" text type="danger" @click="basket.remove(it.id, subject.id)" icon="Delete" />
        </div>
        <div v-if="!basket.items(subject.id).length" class="empty">试题篮为空，去题目列表点「入篮」</div>
      </div>
      <template #footer>
        <span>总分：<b>{{ basket.totalScore(subject.id) }}</b> 分 / {{ basket.count(subject.id) }} 题</span>
        <div style="margin-top:8px">
          <el-button @click="basket.clear(subject.id)">清空</el-button>
          <el-button type="primary" :disabled="!basket.items(subject.id).length" @click="showExport = true">导出 Word / 答题卡</el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog v-model="showExport" title="导出设置" width="560px" append-to-body>
      <DocxExportPanel v-if="subject" :subject-name="subject.name" :items="basket.items(subject.id)" @done="showExport=false" />
    </el-dialog>

    <el-dialog v-model="showImport" title="Word 试卷导入（自动拆分）" width="720px" append-to-body>
      <WordImportPanel v-if="subject" :subject-id="subject.id" @imported="() => { showImport=false; loadQuestions(); loadKp() }" />
    </el-dialog>

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

    <!-- 题目详情抽屉 -->
    <el-drawer v-model="showDetail" :title="`题目详情 #${detail?.id ?? ''}`" size="52%" :append-to-body="true">
      <div v-if="detail" class="detail">
        <div class="d-meta">
          <el-tag size="small" :style="{ borderColor: qtypeColor[detail.qtype], color: qtypeColor[detail.qtype] }" effect="plain">{{ qtypeLabels[detail.qtype] }}</el-tag>
          <span class="diff-badge"><el-rate :model-value="detail.difficulty || 3" disabled size="small" /><span class="diff-txt">难度 {{ detail.difficulty || 3 }}</span></span>
          <span v-if="detail.score" class="tag">满分 {{ detail.score }}</span>
          <span v-if="detail.textbook_version" class="tag">{{ detail.textbook_version }}</span>
          <span v-if="detail.year" class="tag">{{ detail.year }}</span>
          <span v-if="detail.source" class="tag src">{{ detail.source }}</span>
        </div>
        <div class="d-content q-card-inner" v-html="renderMarkdown(detail.content)" />
        <div v-if="['single','multiple','judge'].includes(detail.qtype)" class="q-options">
          <div v-for="(o, i) in (detail.options || [])" :key="i" class="q-opt"><b>{{ 'ABCDEFGH'[i] }}.</b> <span v-html="renderMarkdown(o)" /></div>
        </div>
        <div class="q-answer">
          <div class="qa-row"><b>答案：</b><span v-html="renderMarkdown(detail.answer || '（未填写）')" /></div>
          <div v-if="detail.analysis" class="qa-row qa-analysis"><b>解析：</b><span v-html="renderMarkdown(detail.analysis)" /></div>
        </div>
        <div v-if="detail.knowledge_points?.length" class="q-kp">
          <el-tag v-for="k in detail.knowledge_points" :key="k.id" size="small" type="warning" effect="plain">{{ k.name }}</el-tag>
        </div>
        <div class="d-actions">
          <el-button type="primary" @click="addToBasket(detail)" icon="CirclePlus">加入试题篮</el-button>
          <el-button @click="onFavorite(detail)" icon="Star">收藏</el-button>
          <el-button type="warning" @click="showFeedback = true" icon="Warning">纠错</el-button>
        </div>

        <el-divider>同类题推荐</el-divider>
        <div v-if="similar.length" class="similar">
          <div v-for="s in similar" :key="s.id" class="sim-item" @click="openDetail(s)">
            <el-tag size="small" effect="plain">{{ qtypeLabels[s.qtype] }}</el-tag>
            <span class="sim-content" v-html="renderMarkdown(s.content)" />
          </div>
        </div>
        <div v-else class="empty-sm">暂无同类题</div>
      </div>
    </el-drawer>

    <!-- 纠错 -->
    <el-dialog v-model="showFeedback" title="题目纠错" width="480px" append-to-body>
      <el-input v-model="feedbackText" type="textarea" :rows="4" placeholder="请描述题目存在的问题（如：答案错误 / 解析不清 / 图片缺失等）" />
      <template #footer>
        <el-button @click="showFeedback = false">取消</el-button>
        <el-button type="primary" @click="submitFeedback" icon="Promotion">提交纠错</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bank-page { max-width: 1320px; margin: 0 auto; padding: 16px 20px 60px; }
/* 头部 */
.bank-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 20px; border-radius: 16px; margin-bottom: 14px; }
.bh-left { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 220px; }
.bh-left h2 { font-size: 20px; margin: 0; }
.bh-sub { font-size: 12px; color: #b06a00; opacity: .85; margin-top: 2px; }
.bh-stats { display: flex; gap: 14px; flex-wrap: wrap; }
.bh-stats .stat { display: flex; flex-direction: column; align-items: center; min-width: 48px; }
.bh-stats .stat b { font-size: 18px; color: #F59E0B; }
.bh-stats .stat span { font-size: 11px; color: #999; }
.bh-actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* 主体两栏 */
.bank-body { display: grid; grid-template-columns: 248px 1fr; gap: 14px; align-items: start; }
.kp-aside { padding: 12px; border-radius: 14px; position: sticky; top: 12px; }
.kp-aside-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 600; color: #7c4a03; }
.kp-aside-head .el-icon { vertical-align: -2px; margin-right: 4px; }
.kp-tree { max-height: 60vh; overflow: auto; }
.kp-node { display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.kp-node:hover { background: rgba(245,158,11,0.1); }
.kp-node.active { background: rgba(245,158,11,0.18); font-weight: 600; color: #b06a00; }
.kp-node .chev { width: 14px; text-align: center; color: #b06a00; user-select: none; }
.kp-node .chev.placeholder { color: #ddd; }
.kp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kp-count { font-size: 11px; color: #aaa; }
.kp-mgr-btn { margin-top: 8px; }
/* 筛选 */
.filters { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px; margin-bottom: 12px; border-radius: 14px; align-items: center; }
/* 题目卡 */
.q-list { display: flex; flex-direction: column; gap: 12px; }
.q-card { position: relative; padding: 14px 16px 14px 22px; border-radius: 14px; cursor: pointer; transition: transform .15s, box-shadow .15s; }
.q-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(245,158,11,0.12); }
.q-bar { position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px; border-radius: 4px; }
.q-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.tag { font-size: 12px; color: #b06a00; background: rgba(245,158,11,0.12); padding: 1px 8px; border-radius: 6px; }
.tag.src { color: #0e9f6e; background: rgba(16,185,129,0.12); }
.diff-badge { display: inline-flex; align-items: center; gap: 6px; }
.diff-badge :deep(.el-rate) { height: 18px; line-height: 18px; }
.diff-badge :deep(.el-rate__icon) { font-size: 14px; margin-right: 1px; }
.diff-txt { font-size: 12px; color: #999; }
.q-content { line-height: 1.7; }
.q-options { margin: 8px 0; display: flex; flex-direction: column; gap: 6px; }
.q-opt { display: flex; align-items: baseline; gap: 6px; line-height: 1.7; }
.q-opt > b { flex: 0 0 auto; min-width: 18px; font-weight: 600; color: #b06a00; }
.q-opt > span { flex: 1 1 auto; min-width: 0; }
.q-opt > span :deep(p) { display: inline; margin: 0; }
.q-opt > span :deep(.katex-display) { display: inline-block; margin: 0; vertical-align: middle; }
.q-kp { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.q-answer { margin: 10px 0 4px; padding: 10px 12px; border-radius: 10px; background: rgba(245,158,11,0.07); border-left: 3px solid rgba(245,158,11,0.5); }
.qa-row { display: flex; align-items: baseline; gap: 6px; line-height: 1.75; }
.qa-row > b { flex: 0 0 auto; color: #b06a00; }
.qa-row > span { flex: 1 1 auto; min-width: 0; }
.qa-row > span :deep(p) { display: inline; margin: 0; }
.qa-analysis { margin-top: 4px; color: #6b7280; }
.q-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
/* 详情 */
.detail .q-card-inner { line-height: 1.8; font-size: 15px; }
.q-card-inner :deep(.katex-display) { margin: 8px 0; }
.d-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.d-actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
.similar { display: flex; flex-direction: column; gap: 8px; }
.sim-item { display: flex; gap: 8px; align-items: baseline; padding: 8px 10px; border-radius: 10px; background: rgba(245,158,11,0.06); cursor: pointer; }
.sim-item:hover { background: rgba(245,158,11,0.14); }
.sim-content { flex: 1; line-height: 1.6; font-size: 13px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.empty { padding: 30px; text-align: center; color: #999; }
.empty-sm { padding: 12px; text-align: center; color: #aaa; font-size: 13px; }
.kp-manager { padding: 12px; margin-bottom: 12px; border-radius: 14px; }
.kp-add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.kp-list { display: flex; flex-wrap: wrap; gap: 8px; }
.kp-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(245,158,11,0.1); border-radius: 8px; }
.kp-item small { color: #999; margin-left: 4px; }
.basket-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
.bi-order { display: flex; flex-direction: column; }
.bi-content { flex: 1; line-height: 1.5; max-height: 60px; overflow: hidden; }
.bi-idx { font-weight: 700; color: #F59E0B; margin-right: 4px; }
.smart { padding: 4px; }
.smart-filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.smart-rule { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed rgba(0,0,0,0.08); }
.sr-label { width: 80px; font-weight: 600; }
.sr-score { margin-left: 12px; color: #888; font-size: 13px; }
.sr-unit { color: #888; font-size: 13px; }
@media (max-width: 900px) { .bank-body { grid-template-columns: 1fr; } .kp-aside { position: static; } }
</style>
