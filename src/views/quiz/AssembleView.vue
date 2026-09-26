<script setup lang="ts">
// 【v4.6.0】智能组卷专业版（对标组卷网）：多维筛选 + 双向细目表 + 一键智能组卷 + 试卷编辑 + 导出/存档
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage, ElMessageBox } from 'element-plus'
import ZgGlyph from '@/components/ZgGlyph.vue'
import DocxExportPanel from '@/components/DocxExportPanel.vue'

const route = useRoute()
const user = useUserStore()
const slug = route.params.slug as string

const subject = ref<any>(null)
const allQuestions = ref<any[]>([])
const kpList = ref<any[]>([])
const loading = ref(false)

const QTYPES: { key: string; label: string }[] = [
  { key: 'single', label: '单选' },
  { key: 'multiple', label: '多选' },
  { key: 'judge', label: '判断' },
  { key: 'fill', label: '填空' },
  { key: 'subjective', label: '主观' },
]
const QLABEL: Record<string, string> = Object.fromEntries(QTYPES.map(q => [q.key, q.label]))

// 试卷属性
const meta = reactive({
  title: '', grade: '高一', term: '上学期', duration: 90, template: 'test',
})
const TEMPLATES = [
  { key: 'formal', label: '正式考试' },
  { key: 'test', label: '日常测验' },
  { key: 'homework', label: '课后作业' },
]

// 筛选器
const filters = reactive({ keyword: '', qtype: '', difficulty: '', kpId: '' as string })

// 题库树（父→子）
const childMap = computed(() => {
  const m: Record<number, any[]> = {}
  for (const k of kpList.value) (m[k.parent_id ?? 0] ||= []).push(k)
  return m
})
function descendants(kpId: number): number[] {
  const out = [kpId]
  const stack = [...(childMap.value[kpId] || [])]
  while (stack.length) {
    const n = stack.pop()
    out.push(n.id)
    for (const c of childMap.value[n.id] || []) stack.push(c)
  }
  return out
}

// 双向细目表：matrix[kpId][qtype] = 目标题量
const matrix = reactive<Record<number, Record<string, number>>>({})
function ensureMatrix() {
  for (const k of kpList.value) {
    if (!matrix[k.id]) matrix[k.id] = {}
    for (const q of QTYPES) if (matrix[k.id][q.key] == null) matrix[k.id][q.key] = 0
  }
}

const kpRowTotal = (kpId: number) => QTYPES.reduce((s, q) => s + (matrix[kpId]?.[q.key] || 0), 0)
const qtypeColTotal = (qt: string) => kpList.value.reduce((s, k) => s + (matrix[k.id]?.[qt] || 0), 0)
const grandTotal = computed(() => kpList.value.reduce((s, k) => s + kpRowTotal(k.id), 0))

// 试卷（扁平，按数组顺序渲染/分组）
interface PaperItem { key: number; qid: number; qtype: string; content: string; options: any[]; answer: string; analysis: string; score: number; kpId: number; difficulty: number }
const paper = ref<PaperItem[]>([])
let keySeq = 1

const maxScore = computed(() => paper.value.reduce((s, p) => s + (p.score || 0), 0))

// 题库池（按当前筛选）
const filteredPool = computed(() => {
  const kw = filters.keyword.trim().toLowerCase()
  return allQuestions.value.filter(q => {
    if (filters.qtype && q.qtype !== filters.qtype) return false
    if (filters.difficulty && String(q.difficulty) !== String(filters.difficulty)) return false
    if (filters.kpId) {
      const ids = (q.knowledge_points || []).map((k: any) => k.id)
      const want = descendants(Number(filters.kpId))
      if (!ids.some((id: number) => want.includes(id))) return false
    }
    if (kw && !(`${q.content} ${q.answer}`.toLowerCase().includes(kw))) return false
    return true
  })
})

function qKpId(q: any): number {
  const kps = q.knowledge_points || []
  return kps.length ? kps[0].id : 0
}

// 一键智能组卷：按细目表从题库抽题
function autoAssemble() {
  const pool = allQuestions.value
  const pickedKeys = new Set(paper.value.map(p => p.key))
  const usedQids = new Set(paper.value.map(p => p.qid))
  const next: PaperItem[] = [...paper.value]
  let shortfall = 0
  for (const k of kpList.value) {
    const wantIds = descendants(k.id)
    for (const qt of QTYPES) {
      let need = matrix[k.id]?.[qt.key] || 0
      if (need <= 0) continue
      // 该知识点(含子) + 该题型 的候选
      let cands = pool.filter(q =>
        q.qtype === qt.key &&
        (q.knowledge_points || []).some((kp: any) => wantIds.includes(kp.id)) &&
        !usedQids.has(q.id)
      )
      shuffle(cands)
      for (const c of cands) {
        if (need <= 0) break
        next.push({
          key: keySeq++, qid: c.id, qtype: c.qtype, content: c.content,
          options: c.options || [], answer: c.answer || '', analysis: c.analysis || '',
          score: c.score || 5, kpId: qKpId(c), difficulty: c.difficulty || 3,
        })
        usedQids.add(c.id)
        need--
      }
      shortfall += need
    }
  }
  paper.value = next
  if (shortfall > 0) ElMessage.warning(`已按细目表组卷，但有 ${shortfall} 题题库不足，已尽可能抽取`)
  else ElMessage.success(`组卷完成，共 ${paper.value.length} 题 / ${maxScore.value} 分`)
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
}

// 快速模板：标准测验（每个叶子知识点 1 单选 + 1 填空）
function presetStandard() {
  ensureMatrix()
  for (const k of kpList.value) {
    if ((childMap.value[k.id] || []).length) continue // 仅叶子
    matrix[k.id]['single'] = 1
    matrix[k.id]['fill'] = 1
  }
  ElMessage.info('已套用「标准测验」模板，可手动调整细目表后再组卷')
}

// 手动加题
function addManual(q: any) {
  if (paper.value.some(p => p.qid === q.id)) { ElMessage.info('该题已在卷中'); return }
  paper.value.push({
    key: keySeq++, qid: q.id, qtype: q.qtype, content: q.content,
    options: q.options || [], answer: q.answer || '', analysis: q.analysis || '',
    score: q.score || 5, kpId: qKpId(q), difficulty: q.difficulty || 3,
  })
}
function removeItem(key: number) { paper.value = paper.value.filter(p => p.key !== key) }
function setScore(key: number, v: number) { const it = paper.value.find(p => p.key === key); if (it) it.score = v }
function move(key: number, dir: -1 | 1) {
  const i = paper.value.findIndex(p => p.key === key)
  const j = i + dir
  if (i < 0 || j < 0 || j >= paper.value.length) return
  const arr = paper.value
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  paper.value = [...arr]
}
// 智能换题：同知识点同题型另选一题
function swapItem(key: number) {
  const it = paper.value.find(p => p.key === key); if (!it) return
  const wantIds = descendants(it.kpId)
  const cands = allQuestions.value.filter(q =>
    q.id !== it.qid && q.qtype === it.qtype &&
    (q.knowledge_points || []).some((kp: any) => wantIds.includes(kp.id)) &&
    !paper.value.some(p => p.qid === q.id)
  )
  if (!cands.length) { ElMessage.warning('没有可替换的同知识点同题型题目'); return }
  shuffle(cands)
  const c = cands[0]
  Object.assign(it, { qid: c.id, qtype: c.qtype, content: c.content, options: c.options || [], answer: c.answer || '', analysis: c.analysis || '', score: c.score || 5, kpId: qKpId(c), difficulty: c.difficulty || 3 })
  ElMessage.success('已智能换题')
}

// 分组展示
const grouped = computed(() => {
  const g: Record<string, PaperItem[]> = {}
  for (const p of paper.value) (g[p.qtype] ||= []).push(p)
  return QTYPES.filter(q => g[q.key]?.length).map(q => ({ key: q.key, label: q.label, items: g[q.key] }))
})

// 导出 / 存档
const showExport = ref(false)
const showSave = ref(false)
const saving = ref(false)
const basketItems = computed(() => paper.value.map(p => ({
  id: p.qid, qtype: p.qtype, content: p.content, options: p.options, answer: p.answer,
  analysis: p.analysis, score: p.score, basketScore: p.score, subjectId: subject.value?.id,
  knowledge_points: kpList.value.filter(k => k.id === p.kpId).map(k => ({ id: k.id, name: k.name })),
})))

async function savePaper() {
  if (!paper.value.length) { ElMessage.warning('试卷为空'); return }
  saving.value = true
  try {
    const cfg = { title: meta.title, grade: meta.grade, term: meta.term, duration: meta.duration, template: meta.template, maxScore: maxScore.value, password: savePassword.value || '' }
    const r: any = await api.createPaper({
      subjectId: subject.value.id, title: meta.title || `${subject.value.name}组卷`, kind: 'paper',
      template: meta.template, export_config: cfg,
      questionIds: paper.value.map(p => p.qid),
    })
    ElMessage.success(`已存档为试卷（ID ${r.id}）${savePassword.value ? '· 已设访问密码' : ''}`)
    savedPaperId.value = r.id
    showSave.value = false
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '存档失败') }
  finally { saving.value = false }
}

// ===== 【v4.8.0】平行组卷 A/B：同考点、同难度，换一套题目 =====
const snapshotA = ref<PaperItem[] | null>(null)
const activeAB = ref<'A' | 'B'>('A')
const savedPaperId = ref<number | null>(null)
function buildBFrom(base: PaperItem[]): PaperItem[] {
  return base.map((it) => {
    const wantIds = descendants(it.kpId)
    const cands = allQuestions.value.filter((q: any) =>
      q.id !== it.qid && q.qtype === it.qtype &&
      (q.knowledge_points || []).some((kp: any) => wantIds.includes(kp.id)))
    if (!cands.length) return { ...it }
    shuffle(cands)
    const c = cands[0]
    return { key: keySeq++, qid: c.id, qtype: c.qtype, content: c.content, options: c.options || [], answer: c.answer || '', analysis: c.analysis || '', score: it.score, kpId: qKpId(c), difficulty: c.difficulty || 3 }
  })
}
function generateParallel() {
  if (!paper.value.length) { ElMessage.warning('请先组卷，再生成平行卷'); return }
  if (!snapshotA.value) snapshotA.value = paper.value.map((p) => ({ ...p }))
  paper.value = buildBFrom(snapshotA.value)
  activeAB.value = 'B'
  ElMessage.success('已生成平行卷 B（同考点·同难度·换一套题）')
}
function toggleAB() {
  if (!snapshotA.value) return
  if (activeAB.value === 'A') { paper.value = buildBFrom(snapshotA.value); activeAB.value = 'B' }
  else { paper.value = snapshotA.value.map((p) => ({ ...p })); activeAB.value = 'A' }
}

// ===== 【v4.8.0】分享 / 预览 / 幻灯播放 =====
const showSlideshow = ref(false)
const slideIdx = ref(0)
const slideTotal = computed(() => paper.value.length)
function slideNext() { if (slideIdx.value < slideTotal.value - 1) slideIdx.value++ }
function slidePrev() { if (slideIdx.value > 0) slideIdx.value-- }
async function ensureSaved(): Promise<number | null> {
  if (savedPaperId.value) return savedPaperId.value
  if (!paper.value.length) { ElMessage.warning('试卷为空'); return null }
  saving.value = true
  try {
    const cfg = { title: meta.title, grade: meta.grade, term: meta.term, duration: meta.duration, template: meta.template, maxScore: maxScore.value, password: savePassword.value || '' }
    const r: any = await api.createPaper({
      subjectId: subject.value.id, title: meta.title || `${subject.value.name}组卷`, kind: 'paper',
      template: meta.template, export_config: cfg, questionIds: paper.value.map((p) => p.qid),
    })
    savedPaperId.value = r.id
    return r.id
  } finally { saving.value = false }
}
async function sharePaper() {
  const id = await ensureSaved()
  if (!id) return
  const url = `${location.origin}/quiz/${id}`
  try { await navigator.clipboard.writeText(url); ElMessage.success('分享链接已复制：' + url) }
  catch { ElMessage.info('分享链接：' + url) }
}
async function previewPaper() {
  const id = await ensureSaved()
  if (!id) return
  window.open(`/quiz/${id}`, '_blank')
}

const savePassword = ref('')
function clearPaper() {
  paper.value = []
  snapshotA.value = null
  activeAB.value = 'A'
  savedPaperId.value = null
  savePassword.value = ''
}

onMounted(async () => {
  loading.value = true
  try {
    subject.value = await api.subject(slug)
    const [kps, qs] = await Promise.all([
      api.knowledgePoints(subject.value.id),
      api.subjectQuestions(subject.value.id, { limit: 500 }),
    ])
    kpList.value = kps as any
    allQuestions.value = qs as any
    ensureMatrix()
    meta.title = `${subject.value.name}·第1章测验`
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '加载失败') }
  finally { loading.value = false }
})
</script>

<template>
  <div class="zg-container assemble">
    <div class="assemble-head">
      <h2><ZgGlyph emoji="🧩" /> 智能组卷 · {{ subject?.name }}</h2>
      <span class="hint">对标组卷网：双向细目表 + 一键智能组卷 + Word 直出</span>
    </div>

    <el-row :gutter="16">
      <!-- 左：筛选 + 细目表 + 题库 -->
      <el-col :md="9" :sm="24">
        <el-card shadow="never" class="blk">
          <template #header><b>① 选题条件</b></template>
          <el-input v-model="filters.keyword" placeholder="关键词（题干/答案）" clearable size="default" />
          <div class="row2">
            <el-select v-model="filters.qtype" placeholder="题型" clearable size="default">
              <el-option v-for="q in QTYPES" :key="q.key" :label="q.label" :value="q.key" />
            </el-select>
            <el-select v-model="filters.difficulty" placeholder="难度" clearable size="default">
              <el-option v-for="d in [1,2,3,4,5]" :key="d" :label="`难度 ${d}`" :value="d" />
            </el-select>
          </div>
          <el-select v-model="filters.kpId" placeholder="按知识点筛选题库" clearable size="default" class="full">
            <el-option v-for="k in kpList" :key="k.id" :label="k.name" :value="String(k.id)" />
          </el-select>
        </el-card>

        <el-card shadow="never" class="blk">
          <template #header>
            <b>② 双向细目表</b>
            <el-button link type="primary" size="small" @click="presetStandard">套用标准模板</el-button>
          </template>
          <div class="matrix-wrap">
            <table class="matrix">
              <thead>
                <tr><th>知识点</th><th v-for="q in QTYPES" :key="q.key">{{ q.label }}</th><th>小计</th></tr>
              </thead>
              <tbody>
                <tr v-for="k in kpList" :key="k.id" :class="{ parent: (childMap[k.id]||[]).length }">
                  <td :style="(childMap[k.id]||[]).length ? 'font-weight:600' : 'padding-left:18px'">{{ k.name }}</td>
                  <td v-for="q in QTYPES" :key="q.key">
                    <el-input-number v-model="matrix[k.id][q.key]" :min="0" :max="99" size="small" controls-position="right" />
                  </td>
                  <td class="sum">{{ kpRowTotal(k.id) }}</td>
                </tr>
                <tr class="total-row">
                  <td>合计</td>
                  <td v-for="q in QTYPES" :key="q.key">{{ qtypeColTotal(q.key) }}</td>
                  <td class="sum">{{ grandTotal }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <el-button type="primary" class="full" :icon="'MagicStick'" @click="autoAssemble">
            按细目表一键智能组卷（{{ grandTotal }} 题）
          </el-button>
        </el-card>

        <el-card shadow="never" class="blk">
          <template #header><b>③ 题库（点选加入）</b> <span class="muted">{{ filteredPool.length }} 题</span></template>
          <div class="pool">
            <div v-for="q in filteredPool" :key="q.id" class="pool-item" @click="addManual(q)">
              <span class="tag" :class="q.qtype">{{ QLABEL[q.qtype] || q.qtype }}</span>
              <span class="txt" v-html="renderMarkdown(String(q.content).slice(0, 60))" />
              <span class="add">＋</span>
            </div>
            <p v-if="!filteredPool.length" class="muted center">无匹配题目</p>
          </div>
        </el-card>
      </el-col>

      <!-- 右：属性 + 试卷结构 + 导出 -->
      <el-col :md="15" :sm="24">
        <el-card shadow="never" class="blk">
          <template #header><b>试卷属性</b></template>
          <div class="row2">
            <el-input v-model="meta.title" placeholder="试卷标题" />
            <el-select v-model="meta.grade" placeholder="年级">
              <el-option v-for="g in ['初一','初二','初三','高一','高二','高三']" :key="g" :label="g" :value="g" />
            </el-select>
          </div>
          <div class="row2">
            <el-select v-model="meta.term"><el-option label="上学期" value="上学期" /><el-option label="下学期" value="下学期" /></el-select>
            <el-input-number v-model="meta.duration" :min="0" :max="240" placeholder="时长(分)" />
            <el-select v-model="meta.template">
              <el-option v-for="t in TEMPLATES" :key="t.key" :label="t.label" :value="t.key" />
            </el-select>
          </div>
        </el-card>

        <el-card shadow="never" class="blk">
          <template #header>
            <b>试卷结构</b>
            <span class="muted">共 {{ paper.length }} 题 · 满分 {{ maxScore }} 分</span>
            <el-tag v-if="snapshotA" size="small" :type="activeAB==='A'?'primary':'success'" effect="dark" style="margin-left:8px">当前：卷 {{ activeAB }}</el-tag>
            <span style="float:right">
              <el-button size="small" :icon="'CopyDocument'" @click="generateParallel" :disabled="!paper.length">平行卷 B</el-button>
              <el-button v-if="snapshotA" size="small" :icon="'Switch'" @click="toggleAB">切换 A/B</el-button>
              <el-button size="small" :icon="'View'" @click="previewPaper" :disabled="!paper.length">预览</el-button>
              <el-button size="small" :icon="'Share'" @click="sharePaper" :disabled="!paper.length">分享</el-button>
              <el-button size="small" :icon="'Picture'" @click="showSlideshow = true; slideIdx = 0" :disabled="!paper.length">幻灯</el-button>
              <el-button size="small" :icon="'Document'" @click="showExport = true" :disabled="!paper.length">导出 Word</el-button>
              <el-button size="small" type="success" :icon="'Collection'" @click="showSave = true" :disabled="!paper.length">存档</el-button>
              <el-button size="small" text type="danger" @click="clearPaper" :disabled="!paper.length">清空</el-button>
            </span>
          </template>

          <el-empty v-if="!paper.length" description="尚未组卷：在左侧设置细目表后点「一键智能组卷」，或从题库点选加入" />
          <div v-for="g in grouped" :key="g.key" class="qgroup">
            <div class="ghead">{{ g.label }}（{{ g.items.length }} 题 · {{ g.items.reduce((s,i)=>s+i.score,0) }} 分）</div>
            <div v-for="(it, idx) in g.items" :key="it.key" class="pitem">
              <div class="pno">{{ idx + 1 }}.</div>
              <div class="pbody">
                <div class="pcontent" v-html="renderMarkdown(it.content)" />
                <div class="pmeta">
                  <el-tag size="small" :class="it.qtype">{{ QLABEL[it.qtype] }}</el-tag>
                  <span class="muted">难度 {{ it.difficulty }}</span>
                  <span class="muted">知识点：{{ (kpList.find(k=>k.id===it.kpId)?.name) || '—' }}</span>
                  <span class="score">分值
                    <el-input-number v-model="it.score" :min="1" :max="50" size="small" controls-position="right" @change="setScore(it.key, $event)" />
                  </span>
                </div>
              </div>
              <div class="pacts">
                <el-button text :icon="'Refresh'" @click="swapItem(it.key)" title="智能换题">换题</el-button>
                <el-button text :icon="'Top'" @click="move(it.key, -1)" title="上移">↑</el-button>
                <el-button text :icon="'Bottom'" @click="move(it.key, 1)" title="下移">↓</el-button>
                <el-button text type="danger" :icon="'Delete'" @click="removeItem(it.key)">删</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="showExport" title="导出 Word" width="720px" append-to-body>
      <DocxExportPanel v-if="subject" :subject-name="subject.name" :items="basketItems" @done="showExport = false" />
    </el-dialog>

    <el-dialog v-model="showSave" title="存档为试卷" width="420px" append-to-body>
      <p>将当前 {{ paper.length }} 题（满分 {{ maxScore }} 分）存档，便于下次调阅或再编辑。</p>
      <el-input v-model="meta.title" placeholder="试卷标题" style="margin-bottom:10px" />
      <el-input v-model="savePassword" placeholder="存档密码（选填，调阅时需输入）" show-password maxlength="20" />
      <template #footer>
        <el-button @click="showSave = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePaper">确认存档</el-button>
      </template>
    </el-dialog>

    <!-- 幻灯播放 -->
    <el-dialog v-model="showSlideshow" title="幻灯播放" width="720px" append-to-body @open="slideIdx = 0">
      <div v-if="paper.length" class="slideshow">
        <div class="slide-meta">第 {{ slideIdx + 1 }} / {{ slideTotal }} 题 · {{ QLABEL[paper[slideIdx].qtype] }} · {{ paper[slideIdx].score }} 分</div>
        <div class="slide-body" v-html="renderMarkdown(paper[slideIdx].content)" />
        <div v-if="paper[slideIdx].options?.length" class="slide-opts">
          <div v-for="(o, oi) in paper[slideIdx].options" :key="oi" class="so"><b>{{ String.fromCharCode(65 + oi) }}.</b> {{ o }}</div>
        </div>
      </div>
      <template #footer>
        <el-button :icon="'ArrowLeft'" :disabled="slideIdx === 0" @click="slidePrev">上一题</el-button>
        <el-button type="primary" :icon="'ArrowRight'" :disabled="slideIdx >= slideTotal - 1" @click="slideNext">下一题</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.assemble-head { display: flex; align-items: baseline; gap: 12px; margin: 8px 0 16px; flex-wrap: wrap; }
.assemble-head h2 { margin: 0; font-size: 20px; }
.assemble-head .hint { color: var(--zg-primary); font-size: 13px; }
.blk { margin-bottom: 16px; }
.row2 { display: flex; gap: 8px; margin: 8px 0; }
.row2 > * { flex: 1; }
.full { width: 100%; margin-top: 8px; }
.matrix-wrap { overflow-x: auto; }
table.matrix { width: 100%; border-collapse: collapse; font-size: 13px; }
table.matrix th, table.matrix td { border: 1px solid rgba(var(--zg-primary-rgb), .22); padding: 4px 6px; text-align: center; }
table.matrix th { background: rgba(var(--zg-primary-rgb), .10); color: var(--zg-text); }
table.matrix tr.parent td:first-child { background: rgba(var(--zg-primary-rgb), .06); }
table.matrix .sum { font-weight: 700; color: var(--zg-primary); }
table.matrix .total-row td { background: rgba(var(--zg-primary-rgb), .10); font-weight: 700; }
.matrix :deep(.el-input-number) { width: 64px; }
.pool { max-height: 320px; overflow-y: auto; }
.pool-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
.pool-item:hover { background: rgba(var(--zg-primary-rgb), .06); }
.pool-item .txt { flex: 1; font-size: 13px; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pool-item .add { color: var(--zg-primary); font-weight: 700; }
.tag { font-size: 11px; padding: 1px 6px; border-radius: 6px; color: #fff; background: #c9a06a; }
.tag.single, .tag.multiple, .tag.judge, .tag.fill, .tag.subjective { background: var(--zg-primary); }
.qgroup { margin-bottom: 14px; }
.ghead { font-weight: 600; color: var(--zg-text); border-left: 3px solid var(--zg-primary); padding-left: 8px; margin: 10px 0 6px; }
.pitem { display: flex; gap: 8px; padding: 8px; border: 1px solid rgba(var(--zg-primary-rgb), .22); border-radius: 10px; margin-bottom: 8px; }
.pno { font-weight: 700; color: var(--zg-primary); min-width: 22px; }
.pbody { flex: 1; min-width: 0; }
.pcontent { font-size: 14px; line-height: 1.6; }
.pcontent :deep(p) { margin: 0; display: inline; }
.pmeta { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 6px; font-size: 12px; }
.pmeta .score { display: flex; align-items: center; gap: 4px; }
.pacts { display: flex; flex-direction: column; gap: 2px; }
.muted { color: var(--zg-text-dim); font-size: 12px; }
.center { text-align: center; }
.slideshow { min-height: 220px; }
.slide-meta { color: var(--zg-primary); font-size: 13px; margin-bottom: 10px; }
.slide-body { font-size: 17px; line-height: 1.8; }
.slide-opts { margin-top: 12px; line-height: 2; font-size: 15px; }
.so { padding: 2px 0; }
</style>
