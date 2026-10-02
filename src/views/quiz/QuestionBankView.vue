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
// 【v4.9.0】Word 原卷分栏编辑（左侧保真原卷 + 自动分割线，右侧复用添加题目的编辑器）
import WordPaperSplitEditor from '@/components/WordPaperSplitEditor.vue'
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
const showPaperEdit = ref(false)

// ===== 【v4.9.0】智能题库批量工具 =====
const selected = ref<number[]>([])
const showBatch = ref(false)
const batchBusy = ref(false)
const batchForm = reactive({
  qtype: '', difficulty: undefined as number | undefined, score: undefined as number | undefined,
  status: '', textbook_version: '', region: '', chapter: '', year: '', source: '',
  add_knowledge_point_ids: [] as number[],
})
// 去重结果
const dupGroups = ref<any[]>([])
const dupScanned = ref(0)

function toggleSelect(id: number, on: boolean) {
  if (on) { if (!selected.value.includes(id)) selected.value.push(id) }
  else selected.value = selected.value.filter(x => x !== id)
}
function clearSelection() { selected.value = [] }
function selectAll() { selected.value = questions.value.map((q: any) => q.id) }

function openBatchTools() {
  if (!selected.value.length) { ElMessage.info('请先勾选要批量处理的题目'); return }
  showBatch.value = true
}

async function runBatchUpdate() {
  if (!selected.value.length) return
  batchBusy.value = true
  try {
    // 只提交用户真正填了的字段（留空 = 不改动）
    const payload: any = { ids: selected.value }
    for (const k of ['qtype', 'difficulty', 'score', 'status', 'textbook_version', 'region', 'chapter', 'year', 'source'] as const) {
      const v = (batchForm as any)[k]
      if (v !== '' && v !== undefined && v !== null) payload[k] = v
    }
    if (batchForm.add_knowledge_point_ids.length) payload.add_knowledge_point_ids = batchForm.add_knowledge_point_ids
    if (Object.keys(payload).length <= 1) { ElMessage.warning('请至少修改一个字段'); return }
    const r: any = await api.batchUpdateQuestions(payload)
    ElMessage.success(`已更新 ${r?.updated ?? selected.value.length} 道题${r?.denied?.length ? `，${r.denied.length} 道权限不足已跳过` : ''}`)
    clearSelection()
    await loadQuestions()
  } catch (e: any) {
    ElMessage.error('批量更新失败：' + (e?.response?.data?.message || e?.message || e))
  } finally { batchBusy.value = false }
}

async function runBatchDelete() {
  if (!selected.value.length) return
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${selected.value.length} 道题？此操作不可恢复（仅自己创建的题可删）。`, '批量删除', { type: 'warning' })
  } catch { return }
  batchBusy.value = true
  try {
    const r: any = await api.batchDeleteQuestions(selected.value)
    ElMessage.success(`已删除 ${r?.deleted ?? 0} 道题${r?.denied?.length ? `，${r.denied.length} 道无权限已跳过` : ''}`)
    clearSelection()
    await loadQuestions()
  } catch (e: any) {
    ElMessage.error('批量删除失败：' + (e?.response?.data?.message || e?.message || e))
  } finally { batchBusy.value = false }
}

/** 一键给选中题目推荐并追加知识点 */
async function runAutoTag() {
  if (!selected.value.length) return
  batchBusy.value = true
  try {
    const r: any = await api.suggestKpBatch(subject.value.id, selected.value)
    const sug = r?.suggestions || {}
    const all = new Set<number>()
    Object.values(sug).forEach((arr: any) => (arr || []).forEach((k: any) => all.add(Number(k.id))))
    if (!all.size) { ElMessage.info('未在题面里匹配到现有知识点，可先补充知识点名称'); return }
    const r2: any = await api.batchUpdateQuestions({ ids: selected.value, add_knowledge_point_ids: Array.from(all) })
    ElMessage.success(`已按题面自动标注 ${all.size} 个知识点（覆盖 ${r2?.updated ?? selected.value.length} 题），请在题目里核对`)
    clearSelection()
    await loadQuestions()
  } catch (e: any) {
    ElMessage.error('自动标注失败：' + (e?.response?.data?.message || e?.message || e))
  } finally { batchBusy.value = false }
}

/** 题目去重检测 */
async function runDedupe() {
  batchBusy.value = true
  dupGroups.value = []
  try {
    const r: any = await api.findDuplicateQuestions(subject.value.id)
    dupGroups.value = r?.groups || []
    dupScanned.value = r?.scanned || 0
    if (!dupGroups.value.length) ElMessage.success(`已扫描 ${dupScanned.value} 道题，未发现疑似重复`)
    else ElMessage.warning(`发现 ${dupGroups.value.length} 组疑似重复（共 ${r.total} 题），请人工确认`)
  } catch (e: any) {
    ElMessage.error('去重检测失败：' + (e?.response?.data?.message || e?.message || e))
  } finally { batchBusy.value = false }
}
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
/**
 * 【v4.8.25 对齐组卷网】知识点题数统计：**父节点要含子节点**
 *
 * 原实现只对 `q.knowledge_points` 里直接出现的 id 计数 → 由于出题时打的是**二级**知识点，
 * 一级节点永远显示 0，用户看到「父节点是个空壳」。
 * 组卷网的语义是「一级题数 = 其下所有二级之和」，故这里做一次**向上汇总**：
 * 先把每道题计入它直接挂的节点，再把每个子节点的计数累加到父节点。
 */
const kpCount = computed(() => {
  const direct: Record<number, number> = {}
  questions.value.forEach(q => (q.knowledge_points || []).forEach((k: any) => {
    direct[k.id] = (direct[k.id] || 0) + 1
  }))
  // 向上汇总：子 → 父（本项目 2 级封顶，一层即可）
  const total: Record<number, number> = { ...direct }
  kpList.value.forEach(k => {
    if (k.parent_id && direct[k.id]) {
      total[k.parent_id] = (total[k.parent_id] || 0) + direct[k.id]
    }
  })
  return total
})
function toggleKp(id: number) { expandedKp[id] = !expandedKp[id] }
function selectKp(id: number | null) { filters.knowledge_point_id = id ? String(id) : ''; loadQuestions() }

// 【v4.8.25 修复存量缺陷】原写法 `subject.value = await api.subject(slug)` 未做空值校验：
//   当 slug 无效 / 接口异常返回空时，subject.value 为 null，
//   而模板里有多处 `basket.count(subject.id)`、`basket.items(subject.id)` 直接取属性 →
//   抛 `TypeError: Cannot read properties of null (reading 'id')`，整页渲染中断。
//   现在：① 判空并给出可见提示；② 空值时直接 return，不进入后续加载。
const subjectMissing = ref(false)
async function loadSubject() {
  try {
    const s: any = await api.subject(slug)
    if (!s || !s.id) {
      subjectMissing.value = true
      subject.value = null
      ElMessage.error('未找到该学科，或你没有访问权限')
      return
    }
    subjectMissing.value = false
    subject.value = s
  } catch (e: any) {
    subjectMissing.value = true
    subject.value = null
    ElMessage.error(e?.response?.data?.message || '学科加载失败')
  }
}
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
  // 学科没加载到 → 直接停在这里，避免后续所有 `subject.id` 访问炸掉整页
  if (!subject.value) return
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
  // 【v4.8.24 修复「点取消也把题删了」】
  //   原写法 `await ElMessageBox.confirm(...).catch(() => null)` 把用户点「取消」
  //   产生的 reject 也吞成了正常返回，Promise 链随后**无条件继续执行删除**——
  //   于是「取消」等于「确定」。这里改为标准的提前 return（与全项目其余 40+ 处一致）。
  try {
    await ElMessageBox.confirm('确定删除该题？', '提示', { type: 'warning' })
  } catch { return }
  try {
    await api.deleteSubjectQuestion(q.id)
    ElMessage.success('已删除')
    // 【v4.8.24】删除后重新拉取，而不是仅本地 filter —— 保证与后端（含分页/总数）完全一致
    await loadQuestions()
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

// ===== 知识点管理（v4.8.25 对齐组卷网：两级封顶 + 同级重名拦截 + 编辑/改层级）=====
const kpForm = reactive({ name: '', parent_id: '' as any, sort: 0 })
/** 只有「一级节点」才能当上级（二级不能再挂子级） */
const rootKpOptions = computed(() => kpList.value.filter((k: any) => !k.parent_id))
async function createKp() {
  if (!kpForm.name.trim() || !subject.value) return
  try {
    await api.createKnowledgePoint(subject.value.id, {
      name: kpForm.name.trim(),
      parent_id: kpForm.parent_id || null,
      sort: kpForm.sort || 0,
    })
    kpForm.name = ''
    kpForm.parent_id = ''
    kpForm.sort = 0
    await loadKp()
    // 新建后重新拉题目，保证父节点计数立即反映子节点的题（v4.8.25）
    await loadQuestions()
    ElMessage.success('知识点已添加')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '添加失败')
  }
}
async function deleteKp(id: number) {
  try {
    await api.deleteKnowledgePoint(id)
    await loadKp()
    await loadQuestions()
    ElMessage.success('已删除')
  } catch (e: any) {
    // 【v4.8.25】后端在「存在子知识点」时会返回 400，这里原样透出提示
    ElMessage.error(e?.response?.data?.message || '删除失败')
  }
}

// —— 知识点内联编辑（改名 / 改上级），对齐组卷网的可编辑树 ——
const kpEditingId = ref<number | null>(null)
const kpEditForm = reactive({ name: '', parent_id: '' as any })
function startEditKp(k: any) {
  kpEditingId.value = k.id
  kpEditForm.name = k.name
  kpEditForm.parent_id = k.parent_id || ''
}
function cancelEditKp() { kpEditingId.value = null }
async function saveEditKp(k: any) {
  if (!kpEditForm.name.trim()) { ElMessage.warning('名称不能为空'); return }
  try {
    await api.updateKnowledgePoint(k.id, {
      name: kpEditForm.name.trim(),
      parent_id: kpEditForm.parent_id || null,
    })
    kpEditingId.value = null
    await loadKp()
    await loadQuestions()
    ElMessage.success('已保存')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败')
  }
}
/** 是否为「一级且有子级」（用于禁用「设为其它节点的下级」这类非法操作） */
function isRootWithChildren(k: any) {
  return !k.parent_id && kpList.value.some((x: any) => x.parent_id === k.id)
}

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
  <!-- 【v4.8.25 修复存量缺陷】学科不存在 / 接口异常时，给出可见提示页，
       而不是让模板里的 `subject.id` 访问抛 TypeError 导致整页白屏。 -->
  <div v-if="subjectMissing" class="bank-page zg-container">
    <div class="bank-missing glass">
      <el-empty description="未找到该学科，或你没有访问权限">
        <el-button type="primary" @click="router.back()" icon="ArrowLeft">返回上一页</el-button>
        <el-button @click="router.push('/')" icon="HomeFilled">回到首页</el-button>
      </el-empty>
    </div>
  </div>
  <div v-else class="bank-page zg-container">
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
        <el-button v-if="isStaff" @click="showPaperEdit = true" icon="Document">原卷分栏编辑</el-button>
        <el-button v-if="isStaff" @click="openBatchTools" icon="Operation">批量工具</el-button>
        <el-badge :value="subject ? basket.count(subject.id) : 0" :hidden="!subject || basket.count(subject.id) === 0">
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
        <!-- 【v4.8.15】筛选区：移除全部内联定宽（原 150/110/100/120/90px）。
             内联宽度会与移动端 2 列网格的列宽互相打架，导致控件宽度 132 vs 273
             参差、高度 44/48 混杂，是「模块大小极不统一」的直接根因。
             宽度改由 CSS 网格接管，桌面/移动共用一套等宽规则。 -->
        <div class="filters glass">
          <el-input v-model="filters.keyword" placeholder="关键词" clearable @keyup.enter="loadQuestions" />
          <el-select v-model="filters.qtype" placeholder="题型" clearable @change="loadQuestions">
            <el-option v-for="(l, v) in qtypeLabels" :key="v" :label="l" :value="v" />
          </el-select>
          <el-select v-model="filters.difficulty" placeholder="难度" clearable @change="loadQuestions">
            <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="`${d}星`" :value="d" />
          </el-select>
          <el-input v-model="filters.textbook_version" placeholder="教材版本" clearable @keyup.enter="loadQuestions" />
          <el-input v-model="filters.region" placeholder="地区" clearable @keyup.enter="loadQuestions" />
          <el-input v-model="filters.chapter" placeholder="章节" clearable @keyup.enter="loadQuestions" />
          <el-input v-model="filters.year" placeholder="年份" clearable @keyup.enter="loadQuestions" />
          <el-select v-model="filters.source" placeholder="题源" clearable @change="loadQuestions">
            <el-option label="真题" value="真题" /><el-option label="模拟" value="模拟" />
            <el-option label="同步" value="同步" /><el-option label="专题" value="专题" /><el-option label="原创" value="原创" />
          </el-select>
          <el-button type="primary" @click="loadQuestions" icon="Search">筛选</el-button>
          <el-button text @click="showAnswer = !showAnswer" :icon="showAnswer ? 'View' : 'Hide'">{{ showAnswer ? '隐藏答案' : '显示答案' }}</el-button>
        </div>

        <!-- 知识点管理（v4.8.25：两级封顶，对齐组卷网） -->
        <div v-if="showKpManager" class="kp-manager glass">
          <div class="kp-hint">
            知识点为**两级结构**：一级＝章/模块（如「力学」），二级＝具体知识点（如「牛顿第二定律」）。
            出题时打二级标签，点一级即可查出其下全部题目。
          </div>
          <div class="kp-add">
            <el-input v-model="kpForm.name" placeholder="知识点名称" style="width:190px" @keyup.enter="createKp" />
            <el-select v-model="kpForm.parent_id" placeholder="上级（留空＝一级）" clearable filterable style="width:190px">
              <!-- 【v4.8.25】只能选一级节点作上级 —— 二级不能再挂子级（2 级封顶） -->
              <el-option v-for="k in rootKpOptions" :key="k.id" :label="`${k.name}（一级）`" :value="k.id" />
            </el-select>
            <el-input-number v-model="kpForm.sort" :min="0" :max="999" size="default" style="width:110px" />
            <el-button type="primary" @click="createKp" icon="Plus">添加</el-button>
          </div>
          <div class="kp-list">
            <div v-for="k in kpList" :key="k.id" class="kp-item">
              <!-- 编辑态 -->
              <template v-if="kpEditingId === k.id">
                <el-input v-model="kpEditForm.name" size="small" style="width:150px" @keyup.enter="saveEditKp(k)" />
                <el-select
                  v-model="kpEditForm.parent_id"
                  size="small"
                  clearable
                  filterable
                  placeholder="一级"
                  style="width:150px"
                  :disabled="isRootWithChildren(k)"
                >
                  <el-option
                    v-for="p in rootKpOptions.filter((x:any) => x.id !== k.id)"
                    :key="p.id"
                    :label="`${p.name}（一级）`"
                    :value="p.id"
                  />
                </el-select>
                <el-button size="small" type="primary" text @click="saveEditKp(k)" icon="Check" />
                <el-button size="small" text @click="cancelEditKp" icon="Close" />
              </template>
              <!-- 展示态 -->
              <template v-else>
                <span class="kp-item-name">
                  <el-tag v-if="!k.parent_id" size="small" effect="plain" type="info">一级</el-tag>
                  <el-tag v-else size="small" effect="plain" type="warning">二级</el-tag>
                  {{ k.name }}
                </span>
                <el-button size="small" text @click="startEditKp(k)" icon="Edit" title="编辑 / 调整上级" />
                <el-button size="small" text type="danger" @click="deleteKp(k.id)" icon="Delete" title="删除" />
              </template>
            </div>
            <div v-if="!kpList.length" class="empty-sm">暂无知识点，先添加</div>
          </div>
        </div>

        <!-- 题目卡片 -->
        <div v-loading="loading" class="q-list">
          <div v-for="q in questions" :key="q.id" class="q-card glass" :class="{ 'q-selected': selected.includes(q.id) }" @click="openDetail(q)">
            <!-- 【v4.9.0】批量操作勾选框（仅教师/超管可见） -->
            <el-checkbox
              v-if="isStaff"
              class="q-pick"
              :model-value="selected.includes(q.id)"
              @click.stop
              @change="(v: any) => toggleSelect(q.id, v)"
            />
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
            <div class="q-content zg-rich" v-html="renderMarkdown(q.content)" />
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

    <!-- 试题篮抽屉（v-if="subject" 兜底：学科未加载完成时整块不渲染） -->
    <el-drawer v-if="subject" v-model="showBasket" title="试题篮 · 组卷" size="46%" :append-to-body="true">
      <div class="basket">
        <div v-for="(it, idx) in basket.items(subject.id)" :key="it.id" class="basket-item">
          <div class="bi-order">
            <el-button size="small" text :disabled="idx===0" @click="basket.reorder(idx, idx-1, subject.id)" icon="Top" />
            <el-button size="small" text :disabled="idx===basket.items(subject.id).length-1" @click="basket.reorder(idx, idx+1, subject.id)" icon="Bottom" />
          </div>
          <div class="bi-content"><span class="bi-idx">{{ idx+1 }}.</span> <span class="zg-rich" v-html="renderMarkdown(it.content)" /></div>
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

    <!-- 【v4.9.0】原卷分栏编辑：左保真原卷 + 分割线，右逐题编辑（编辑器与「添加题目」一致）-->
    <el-dialog v-model="showPaperEdit" title="Word 原卷分栏编辑" width="96%" top="3vh" append-to-body destroy-on-close>
      <WordPaperSplitEditor
        v-if="subject"
        :subject-id="subject.id"
        :subject-name="subject.name"
        @imported="loadQuestions(); loadKp()"
      />
    </el-dialog>

    <!-- 【v4.9.0】智能题库批量工具 -->
    <el-dialog v-model="showBatch" title="批量工具" width="640px" append-to-body>
      <div class="batch-bar">
        <span>已选 <b>{{ selected.length }}</b> / {{ questions.length }} 题</span>
        <div>
          <el-button size="small" @click="selectAll">全选本页</el-button>
          <el-button size="small" @click="clearSelection">清空</el-button>
        </div>
      </div>

      <el-tabs>
        <el-tab-pane label="批量修改">
          <el-form label-width="92px" size="small">
            <el-row :gutter="12">
              <el-col :span="12"><el-form-item label="题型">
                <el-select v-model="batchForm.qtype" clearable placeholder="不改动" style="width:100%">
                  <el-option v-for="(l, k) in qtypeLabels" :key="k" :label="l" :value="k" />
                </el-select>
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="难度">
                <el-select v-model="batchForm.difficulty" clearable placeholder="不改动" style="width:100%">
                  <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="'难度 ' + d" :value="d" />
                </el-select>
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="分值">
                <el-input-number v-model="batchForm.score" :min="1" :max="100" placeholder="不改动" style="width:100%" />
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="教材版本">
                <el-input v-model="batchForm.textbook_version" placeholder="不改动" />
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="地区">
                <el-input v-model="batchForm.region" placeholder="不改动" />
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="章节">
                <el-input v-model="batchForm.chapter" placeholder="不改动" />
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="年份">
                <el-input v-model="batchForm.year" placeholder="不改动" />
              </el-form-item></el-col>
              <el-col :span="12"><el-form-item label="来源">
                <el-input v-model="batchForm.source" placeholder="不改动" />
              </el-form-item></el-col>
            </el-row>
            <el-form-item label="追加知识点">
              <el-select v-model="batchForm.add_knowledge_point_ids" multiple filterable clearable placeholder="选填，批量追加（不覆盖原有）" style="width:100%">
                <el-option v-for="k in kpList" :key="k.id" :label="(k.parent_id ? '　' : '') + k.name" :value="k.id" />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="batch-actions">
            <el-button type="primary" :loading="batchBusy" @click="runBatchUpdate">应用到选中题目</el-button>
            <el-button :loading="batchBusy" @click="runAutoTag">按题面自动标注知识点</el-button>
          </div>
        </el-tab-pane>

        <el-tab-pane label="去重检测">
          <div class="batch-actions">
            <el-button :loading="batchBusy" @click="runDedupe">扫描本学科重复题</el-button>
            <span v-if="dupScanned" class="dup-meta">已扫描 {{ dupScanned }} 题</span>
          </div>
          <div v-if="dupGroups.length" class="dup-list">
            <div v-for="(g, gi) in dupGroups" :key="gi" class="dup-group">
              <div class="dup-head">第 {{ gi + 1 }} 组 · {{ g.length }} 题疑似重复</div>
              <div v-for="q in g" :key="q.id" class="dup-item">
                <el-tag size="small" effect="plain">{{ qtypeLabels[q.qtype] || q.qtype }}</el-tag>
                <span class="dup-txt">{{ q.preview }}</span>
                <span class="dup-id">#{{ q.id }}</span>
              </div>
            </div>
          </div>
          <div v-else class="dup-empty">点上方按钮开始扫描；命中的题目请自行判断是否删除（不自动删，避免误伤）</div>
        </el-tab-pane>

        <el-tab-pane label="危险操作">
          <el-alert type="error" :closable="false" title="删除不可恢复" description="仅「自己创建」的题目会被删除，他人的题目会被自动跳过。" show-icon />
          <div class="batch-actions">
            <el-button type="danger" :loading="batchBusy" @click="runBatchDelete">删除选中的 {{ selected.length }} 道题</el-button>
          </div>
        </el-tab-pane>
      </el-tabs>
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
        <!-- 【v4.8.25】详情抽屉容器改为与列表卡片**完全一致**的 `q-content zg-rich`
             （原为 `d-content q-card-inner`，容器类不同 → 少了一整套样式，
             是用户反馈「点开预览跟不在预览状态显示不一样」的根因）。 -->
        <div class="d-content q-content zg-rich" v-html="renderMarkdown(detail.content)" />
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
            <span class="sim-content zg-rich" v-html="renderMarkdown(s.content)" />
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
/* 【v4.8.25】学科不存在时的提示页容器 */
.bank-missing { margin-top: 60px; padding: 40px 20px; border-radius: 16px; }
/* 头部 */
.bank-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 16px 20px; border-radius: 16px; margin-bottom: 14px; }
.bh-left { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 220px; }
.bh-left h2 { font-size: 20px; margin: 0; }
.bh-sub { font-size: 12px; color: var(--zg-primary); opacity: .85; margin-top: 2px; }
.bh-stats { display: flex; gap: 14px; flex-wrap: wrap; }
.bh-stats .stat { display: flex; flex-direction: column; align-items: center; min-width: 48px; }
.bh-stats .stat b { font-size: 18px; color: #F59E0B; }
.bh-stats .stat span { font-size: 11px; color: var(--zg-text-dim); }
.bh-actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* 主体两栏
   【v4.8.22 修复「电脑端题库横向溢出」】
   grid 子项默认 min-width:auto —— 右侧 1fr 列的"最小值"会变成内容的 min-content 宽度。
   数学题里的宽表格（实测 1661px）因此把该列撑到 1701px，连带 body 横向溢出 683px。
   显式 min-width:0 允许子项收缩，内容过宽时交给内部的 overflow-x:auto 滚动。 */
.bank-body { display: grid; grid-template-columns: 248px 1fr; gap: 14px; align-items: start; }
.bank-body > * { min-width: 0; }
.kp-aside { padding: 12px; border-radius: 14px; position: sticky; top: 12px; }
.kp-aside-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 600; color: #7c4a03; }
.kp-aside-head .el-icon { vertical-align: -2px; margin-right: 4px; }
.kp-tree { max-height: 60vh; overflow: auto; }
.kp-node { display: flex; align-items: center; gap: 4px; padding: 5px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.kp-node:hover { background: rgba(245,158,11,0.1); }
.kp-node.active { background: rgba(245,158,11,0.18); font-weight: 600; color: var(--zg-primary); }
.kp-node .chev { width: 14px; text-align: center; color: var(--zg-primary); user-select: none; }
.kp-node .chev.placeholder { color: #ddd; }
.kp-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kp-count { font-size: 11px; color: #aaa; }
.kp-mgr-btn { margin-top: 8px; }
/* 筛选
   【v4.8.15】原为 flex + 每个控件内联定宽（150/110/100/120/90px），
   宽度参差、窄屏互相打架。改为等宽网格：关键字占两格更宽，
   其余控件同宽，桌面与移动共用同一套"统一控件规范"。 */
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
  gap: 10px;
  padding: 14px;
  margin-bottom: 12px;
  border-radius: 14px;
  align-items: center;
  /* 【v4.8.22】minmax(132px,…) 的固定下限在窄容器里会让 grid 整体撑宽 → 显式收敛 */
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
/* 关键词是主输入，占两格 */
.filters > *:first-child { grid-column: span 2; }
.filters .el-input,
.filters .el-select { width: 100%; }
/* 题目卡 */
.q-list { display: flex; flex-direction: column; gap: 12px; }
.q-card { position: relative; padding: 14px 16px 14px 22px; border-radius: 14px; cursor: pointer; transition: transform .15s, box-shadow .15s; }
/* 【v4.9.0】批量勾选 */
.q-card .q-pick { position: absolute; top: 12px; right: 12px; z-index: 3; }
.q-card.q-selected { box-shadow: 0 0 0 2px var(--zg-primary) inset, 0 8px 24px rgba(245,158,11,0.14); }

/* 【v4.9.0】批量工具 */
.batch-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 13px; }
.batch-actions { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.dup-meta { font-size: 12px; color: var(--zg-text-dim, #888); }
.dup-list { max-height: 320px; overflow: auto; margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.dup-group { border: 1px solid rgba(0,0,0,0.09); border-radius: 10px; padding: 8px 10px; }
.dup-head { font-size: 12px; font-weight: 700; color: #d97706; margin-bottom: 6px; }
.dup-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; border-top: 1px dashed rgba(0,0,0,0.07); }
.dup-item:first-of-type { border-top: 0; }
.dup-txt { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dup-id { color: var(--zg-text-dim, #999); flex: 0 0 auto; }
.dup-empty { font-size: 12px; color: var(--zg-text-dim, #999); padding: 14px 4px; }
.q-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(245,158,11,0.12); }
.q-bar { position: absolute; left: 0; top: 12px; bottom: 12px; width: 4px; border-radius: 4px; }
.q-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.tag { font-size: 12px; color: var(--zg-primary); background: rgba(245,158,11,0.12); padding: 1px 8px; border-radius: 6px; }
.tag.src { color: #0e9f6e; background: rgba(16,185,129,0.12); }
.diff-badge { display: inline-flex; align-items: center; gap: 6px; }
.diff-badge :deep(.el-rate) { height: 18px; line-height: 18px; }
.diff-badge :deep(.el-rate__icon) { font-size: 14px; margin-right: 1px; }
.diff-txt { font-size: 12px; color: var(--zg-text-dim); }
.q-content { line-height: 1.7; }
.q-options { margin: 8px 0; display: flex; flex-direction: column; gap: 6px; }
.q-opt { display: flex; align-items: baseline; gap: 6px; line-height: 1.7; }
.q-opt > b { flex: 0 0 auto; min-width: 18px; font-weight: 600; color: var(--zg-primary); }
.q-opt > span { flex: 1 1 auto; min-width: 0; }
/* 【v4.8.25 修复「吞空格空行」】原写法 `.q-opt > span :deep(p){display:inline}` 把选项里的
   `<p>` 强制内联化，代价是**选项内的段落换行全部消失**（用户反馈的"编辑器里好好的，
   提交后换行没了"正是此处）。现在选项字母与首行对齐的问题改由 flex + `p{margin:0}` 解决，
   `<p>` 保持块级 → 段间换行被完整保留。 */
.q-opt > span :deep(p) { margin: 0; }
.q-opt > span :deep(p:first-child) { margin-top: 0; }
.q-opt > span :deep(p:last-child) { margin-bottom: 0; }
.q-opt > span :deep(.katex-display) { margin: 0; }
.q-kp { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.q-answer { margin: 10px 0 4px; padding: 10px 12px; border-radius: 10px; background: rgba(245,158,11,0.07); border-left: 3px solid rgba(245,158,11,0.5); }
.qa-row { display: flex; align-items: baseline; gap: 6px; line-height: 1.75; }
.qa-row > b { flex: 0 0 auto; color: var(--zg-primary); }
.qa-row > span { flex: 1 1 auto; min-width: 0; }
/* 【v4.8.25】同上：答案/解析里的 `<p>` 不再内联化，换行完整保留 */
.qa-row > span :deep(p) { margin: 0; }
.qa-analysis { margin-top: 4px; color: #6b7280; }
.q-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
/* 详情 */
/* 【v4.8.25 修复「点开详情预览与列表不一致」】原写法 `.detail .q-card-inner { … }`
   是 **scoped 样式、特异性 (0,2,0)**，高于全局 `.d-content img`(0,1,1) →
   抽屉里图片尺寸、表格滚动等规则全被压过。现在详情容器在模板里已改为与列表
   完全一致的 `q-content`（+ 全局 .zg-rich），此处不再复写任何富文本样式。 */
.d-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.d-actions { display: flex; gap: 8px; margin: 14px 0; flex-wrap: wrap; }
.similar { display: flex; flex-direction: column; gap: 8px; }
.sim-item { display: flex; gap: 8px; align-items: baseline; padding: 8px 10px; border-radius: 10px; background: rgba(245,158,11,0.06); cursor: pointer; }
.sim-item:hover { background: rgba(245,158,11,0.14); }
/* 【v4.8.25】原 `-webkit-line-clamp:2` 会把同类题内容硬截两行（用户看到的"内容被吞"）。
   同类题本来就是缩略预览，改为限高 3 行 + 不显示滚动条，保留更多内容。 */
.sim-content { flex: 1; line-height: 1.6; font-size: 13px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; }
.empty { padding: 30px; text-align: center; color: var(--zg-text-dim); }
.empty-sm { padding: 12px; text-align: center; color: #aaa; font-size: 13px; }
.kp-manager { padding: 12px; margin-bottom: 12px; border-radius: 14px; }
/* 【v4.8.25】层级说明条：把「两级结构」的规则显式告诉用户，减少误操作 */
.kp-hint { font-size: 12px; line-height: 1.7; color: var(--zg-text-dim); background: rgba(245,158,11,0.08); border-left: 3px solid rgba(245,158,11,0.5); padding: 8px 10px; border-radius: 0 8px 8px 0; margin-bottom: 10px; }
.kp-add { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.kp-list { display: flex; flex-wrap: wrap; gap: 8px; }
.kp-item { display: flex; align-items: center; gap: 6px; padding: 4px 10px; background: rgba(245,158,11,0.1); border-radius: 8px; }
.kp-item-name { display: inline-flex; align-items: center; gap: 6px; }
.kp-item small { color: var(--zg-text-dim); margin-left: 4px; }
.basket-item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
.bi-order { display: flex; flex-direction: column; }
.bi-content { flex: 1; line-height: 1.5; max-height: 60px; overflow: hidden; }
.bi-idx { font-weight: 700; color: #F59E0B; margin-right: 4px; }
.smart { padding: 4px; }
.smart-filters { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.smart-rule { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed rgba(0,0,0,0.08); }
.sr-label { width: 80px; font-weight: 600; }
.sr-score { margin-left: 12px; color: var(--zg-text-dim); font-size: 13px; }
.sr-unit { color: var(--zg-text-dim); font-size: 13px; }
@media (max-width: 900px) { .bank-body { grid-template-columns: 1fr; } .kp-aside { position: static; } }
</style>
