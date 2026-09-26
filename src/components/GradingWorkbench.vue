<script setup lang="ts">
// 【v4.8.15】在线阅卷工作台（对标智学网网阅三栏布局）
// ---------------------------------------------------------------------------
// 旧实现的三个硬伤（ExamManageView 里的 grade 弹窗）：
//   ① 单栏表单：一个下拉选学生 → 一排 input-number 逐题打分。
//      40 人的班、20 道题 = 800 次「选人 + 找输入框 + 点数字 + 记着第几题」，
//      完全无法批量阅卷；
//   ② 没有进度概念：不知道还剩几人、当前是第几份；
//   ③ 有扫描件但只给一个「查看扫描件」链接，无法与打分并排对照。
//
// 本组件按智学网的三栏工作台重做：
//   ┌────────────┬──────────────────────┬─────────────┐
//   │ 左：切图区  │ 中：学生作答切图      │ 右：打分板   │
//   │ 题号切换    │ （缩放 / 全屏）      │ 0.5 分档     │
//   │            │                      │ 自动提交     │
//   ├────────────┴──────────────────────┴─────────────┤
//   │ 底：进度条 已阅 12/40 ｜ 上一份 ｜ 提交并下一份   │
//   └──────────────────────────────────────────────────┘
//
// 保留原有后端接口（saveExamResponse / examResponses），不引入新表。
// 键盘快捷键：←/→ 切换份数，数字键 0-9 快速给分，Enter 提交并下一份。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from '@/api'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage, ElMessageBox } from 'element-plus'

const props = defineProps<{
  exam: any
  students: any[]
}>()

const emit = defineEmits<{ (e: 'saved'): void }>()

// ===== 数据 =====
const responses = ref<any[]>([])
const loading = ref(false)
const saving = ref(false)
const idx = ref(0)                     // 当前阅到第几份
const scores = ref<Record<number, number | null>>({})
const comment = ref('')
const scanUrl = ref('')
const zoom = ref(1)
const autoSubmit = ref(false)
const showImage = ref(true)

const questions = computed<any[]>(() => props.exam?.questions || [])
const totalScore = computed(() => questions.value.reduce((s, q) => s + (Number(q.score) || 0), 0))

// 待阅队列：优先未录入的，已录入的排在后面可回评
const queue = computed(() => {
  const done = new Set(responses.value.map(r => r.student_id))
  const pending = props.students.filter(s => !done.has(s.id))
  const finished = props.students.filter(s => done.has(s.id))
  return [...pending, ...finished]
})
const cur = computed(() => queue.value[idx.value] || null)
const doneCount = computed(() => responses.value.length)
const totalCount = computed(() => props.students.length)
const progress = computed(() => totalCount.value ? Math.round((doneCount.value / totalCount.value) * 100) : 0)

// 当前学生的已有记录（回评时回填）
const curResponse = computed(() => responses.value.find(r => r.student_id === cur.value?.id) || null)
const myTotal = computed(() =>
  questions.value.reduce((s, q) => s + (Number(scores.value[q.id]) || 0), 0))

// ===== 载入 =====
async function loadResponses() {
  loading.value = true
  try {
    const r: any = await api.examResponses(props.exam.id)
    responses.value = r?.data || r || []
  } finally { loading.value = false }
  // 【v4.8.15 修复】必须在 responses 到位后再回填，否则 watch 先于数据执行 →
  // 已录入的学生打开阅卷台时打分是空的、合计显示 0（实测踩坑）。
  backfill()
}

// 回填：当前学生已有记录则回填打分，否则清空
function backfill() {
  const s = cur.value
  if (!s) return
  const rec = responses.value.find(r => r.student_id === s.id)
  if (rec) {
    scores.value = { ...(rec.scores || {}) }
    comment.value = rec.comment || ''
    scanUrl.value = rec.scan_url || ''
  } else {
    const init: Record<number, number | null> = {}
    questions.value.forEach(q => { init[q.id] = null })
    scores.value = init
    comment.value = ''
    scanUrl.value = ''
  }
}

// 切学生时回填；questions 变化（exam 异步载入）时也要重新回填
watch([cur, questions], backfill, { immediate: true })

onMounted(loadResponses)

// ===== 打分 =====
// 智学网打分板是 0.5 分档；这里按题目满分生成 0.5 步进的合法分值按钮
function scoreChips(q: any): number[] {
  const max = Number(q.score) || 0
  const out: number[] = []
  for (let v = 0; v <= max + 1e-6; v += 0.5) out.push(Number(v.toFixed(1)))
  return out
}
function setScore(qid: number, v: number) {
  scores.value[qid] = v
  if (autoSubmit.value) submitAndNext()
}
// 一键满分 / 零分
function fillAll(v: 'full' | 'zero') {
  questions.value.forEach(q => {
    scores.value[q.id] = v === 'full' ? Number(q.score) || 0 : 0
  })
  ElMessage.success(v === 'full' ? '已全部给满分' : '已全部给零分')
}

async function save(advance = true) {
  if (!cur.value) return
  const unanswered = questions.value.filter(q => scores.value[q.id] === null || scores.value[q.id] === undefined)
  if (unanswered.length) {
    const ok = await ElMessageBox.confirm(
      `还有 ${unanswered.length} 题未打分，未打分的题按 0 分计。确定保存？`,
      '提示', { type: 'warning' }
    ).then(() => true).catch(() => false)
    if (!ok) return
  }
  saving.value = true
  try {
    const payload = {
      student_id: cur.value.id,
      scores: Object.fromEntries(questions.value.map(q => [q.id, Number(scores.value[q.id]) || 0])),
      comment: comment.value,
      scan_url: scanUrl.value,
    }
    await api.saveExamResponse(props.exam.id, payload)
    await loadResponses()
    emit('saved')
    ElMessage.success(`已保存 ${cur.value.real_name || cur.value.username} 的成绩`)
    if (advance) next()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败')
  } finally { saving.value = false }
}

function prev() { if (idx.value > 0) idx.value-- }
function next() { if (idx.value < queue.value.length - 1) idx.value++ }
function submitAndNext() { save(true) }

function jumpTo(i: number) { idx.value = i }

// 上传扫描件（走统一 uploadImage）
async function uploadScan(opt: any) {
  try {
    const r: any = await api.uploadImage(opt.file)
    scanUrl.value = r.url
    ElMessage.success('扫描件已上传')
  } catch (e: any) {
    ElMessage.error(e?.message || '上传失败')
  }
}

// ===== 键盘快捷键 =====
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  if (e.key === 'ArrowLeft') { prev(); e.preventDefault() }
  else if (e.key === 'ArrowRight') { next(); e.preventDefault() }
  else if (e.key === 'Enter' && !e.shiftKey) { submitAndNext(); e.preventDefault() }
  else if (e.key === ' ') { autoSubmit.value = !autoSubmit.value; e.preventDefault() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function qtypeLabel(t: string) {
  return ({ single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' } as any)[t] || t
}
function shorten(s: string, n = 60) {
  const t = String(s || '').replace(/[#*`>]/g, '').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
</script>

<template>
  <div class="gw" v-loading="loading">
    <!-- 顶部：进度 + 自动提交开关 -->
    <div class="gw-top">
      <div class="gw-progress">
        <div class="gp-bar"><div class="gp-fill" :style="{ width: progress + '%' }" /></div>
        <span class="gp-txt">已阅 <b>{{ doneCount }}</b> / {{ totalCount }} 份 · {{ progress }}%</span>
      </div>
      <div class="gw-toggles">
        <el-switch v-model="autoSubmit" size="small" active-text="自动提交" inline-prompt />
        <el-switch v-model="showImage" size="small" active-text="显示切图" inline-prompt />
      </div>
    </div>

    <div v-if="!queue.length" class="gw-empty">该学科下暂时没有学生，请先在班级中添加学生</div>

    <div v-else class="gw-body">
      <!-- 左栏：份数导航 -->
      <aside class="gw-left">
        <div class="gl-title">阅卷队列</div>
        <div class="gl-list">
          <div
            v-for="(s, i) in queue" :key="s.id"
            class="gl-item" :class="{ active: i === idx, done: responses.some(r => r.student_id === s.id) }"
            @click="jumpTo(i)">
            <span class="gl-idx">{{ i + 1 }}</span>
            <span class="gl-name">{{ s.real_name || s.username }}</span>
            <span class="gl-tick">{{ responses.some(r => r.student_id === s.id) ? '✓' : '' }}</span>
          </div>
        </div>
      </aside>

      <!-- 中栏：学生作答切图 -->
      <section v-if="showImage" class="gw-mid">
        <div class="gm-head">
          <span>{{ cur?.real_name || cur?.username }} 的作答</span>
          <div class="gm-zoom">
            <el-button size="small" text icon="ZoomOut" @click="zoom = Math.max(0.5, zoom - 0.15)" />
            <span class="gm-z">{{ Math.round(zoom * 100) }}%</span>
            <el-button size="small" text icon="ZoomIn" @click="zoom = Math.min(3, zoom + 0.15)" />
            <el-button size="small" text @click="zoom = 1">复位</el-button>
          </div>
        </div>
        <div class="gm-canvas">
          <img v-if="scanUrl" :src="scanUrl" :style="{ transform: `scale(${zoom})` }" alt="作答扫描件" />
          <div v-else class="gm-placeholder">
            <el-upload :show-file-list="false" :http-request="uploadScan" accept="image/*">
              <el-button icon="UploadFilled">上传客观题扫描件</el-button>
            </el-upload>
            <p>上传后可在此对照卷面打分（支持缩放）</p>
          </div>
        </div>
      </section>

      <!-- 右栏：打分板 -->
      <section class="gw-right">
        <div class="gr-head">
          <span class="gr-who">{{ cur?.real_name || cur?.username }}</span>
          <span class="gr-idx">第 {{ idx + 1 }} / {{ queue.length }} 份</span>
        </div>

        <div class="gr-quick">
          <el-button size="small" @click="fillAll('full')">全满分</el-button>
          <el-button size="small" @click="fillAll('zero')">全零分</el-button>
        </div>

        <div class="gr-qs">
          <div v-for="(q, i) in questions" :key="q.id" class="gr-q">
            <div class="gq-head">
              <span class="gq-idx">{{ i + 1 }}</span>
              <span class="gq-type">{{ qtypeLabel(q.qtype) }}</span>
              <span class="gq-text">{{ shorten(q.content) }}</span>
              <span class="gq-max">/ {{ q.score }}</span>
            </div>
            <div class="gq-chips">
              <button
                v-for="v in scoreChips(q)" :key="v"
                class="chip" :class="{ on: Number(scores[q.id]) === v, zero: v === 0 }"
                @click="setScore(q.id, v)">{{ v }}</button>
            </div>
          </div>
        </div>

        <el-input v-model="comment" type="textarea" :rows="2" placeholder="评语（选填）" class="gr-comment" />

        <div class="gr-foot">
          <div class="gf-total">合计 <b>{{ myTotal }}</b> / {{ totalScore }}</div>
          <div class="gf-btns">
            <el-button :disabled="idx === 0" @click="prev" icon="ArrowLeft">上一份</el-button>
            <el-button type="primary" :loading="saving" @click="save(true)">提交并下一份</el-button>
          </div>
        </div>

        <div class="gr-tips">
          快捷键：← → 切换份数 ｜ Enter 提交并下一份 ｜ 空格 切换自动提交
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.gw { display: flex; flex-direction: column; gap: 12px; }

/* 顶部 */
.gw-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.gw-progress { flex: 1; min-width: 200px; display: flex; align-items: center; gap: 10px; }
.gp-bar { flex: 1; height: 8px; border-radius: 999px; background: rgba(var(--zg-primary-rgb, 245 158 11), .15); overflow: hidden; }
.gp-fill { height: 100%; border-radius: 999px; background: var(--zg-primary, #f59e0b); transition: width .3s ease; }
.gp-txt { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); white-space: nowrap; }
.gw-toggles { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
.gw-empty { padding: 30px; text-align: center; color: var(--zg-text-dim, #8a7a5e); }

/* 三栏主体 */
.gw-body { display: grid; grid-template-columns: 168px minmax(0, 1fr) 380px; gap: 12px; align-items: start; }
.gw-left, .gw-mid, .gw-right {
  border-radius: 14px; background: rgba(255, 255, 255, .55);
  border: 1px solid rgba(var(--zg-primary-rgb, 245 158 11), .14);
  padding: 10px; min-width: 0;
}
html.zg-inkgold-dark .gw-left, html.zg-inkgold-dark .gw-mid, html.zg-inkgold-dark .gw-right {
  background: rgba(255, 255, 255, .05);
  border-color: rgba(255, 255, 255, .10);
}

/* 左栏 */
.gl-title { font-size: 12px; font-weight: 700; color: var(--zg-text-dim, #8a7a5e); margin-bottom: 8px; }
.gl-list { max-height: 460px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.gl-item {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-radius: 9px; cursor: pointer; font-size: 13px; transition: background .15s;
}
.gl-item:hover { background: rgba(var(--zg-primary-rgb, 245 158 11), .10); }
.gl-item.active { background: var(--zg-primary, #f59e0b); color: #fff; }
.gl-item.done .gl-name { opacity: .7; }
.gl-idx { flex: none; width: 20px; text-align: center; font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }
.gl-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gl-tick { flex: none; color: #10b981; font-weight: 700; }
.gl-item.active .gl-tick { color: #fff; }

/* 中栏 */
.gm-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; font-size: 13px; flex-wrap: wrap; }
.gm-zoom { display: flex; align-items: center; gap: 2px; }
.gm-z { font-size: 12px; min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.gm-canvas {
  height: 460px; overflow: auto; background: #6b6b6b; border-radius: 10px;
  display: flex; align-items: flex-start; justify-content: center; padding: 8px;
}
.gm-canvas img { max-width: 100%; transform-origin: top center; border-radius: 4px; }
.gm-placeholder {
  margin: auto; text-align: center; color: #eee;
  display: flex; flex-direction: column; align-items: center; gap: 10px;
}
.gm-placeholder p { font-size: 12px; opacity: .85; margin: 0; }

/* 右栏 */
.gr-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.gr-who { font-weight: 700; font-size: 14px; }
.gr-idx { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); font-variant-numeric: tabular-nums; }
.gr-quick { display: flex; gap: 8px; margin-bottom: 10px; }
.gr-quick .el-button { flex: 1; margin: 0; }
.gr-qs { max-height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.gr-q { padding: 8px 10px; border-radius: 10px; background: rgba(var(--zg-primary-rgb, 245 158 11), .05); }
html.zg-inkgold-dark .gr-q { background: rgba(255, 255, 255, .05); }
.gq-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 6px; font-size: 12px; }
.gq-idx { flex: none; font-weight: 700; }
.gq-type { flex: none; font-size: 11px; padding: 0 5px; border-radius: 999px; background: rgba(var(--zg-primary-rgb, 245 158 11), .16); color: var(--zg-primary, #f59e0b); }
.gq-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--zg-text-dim, #8a7a5e); }
.gq-max { flex: none; color: var(--zg-text-dim, #8a7a5e); }
.gq-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip {
  min-width: 34px; height: 30px; padding: 0 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(var(--zg-primary-rgb, 245 158 11), .3);
  background: transparent; color: inherit; font-size: 12px;
  font-variant-numeric: tabular-nums; transition: all .12s;
}
.chip:hover { background: rgba(var(--zg-primary-rgb, 245 158 11), .14); }
.chip.on { background: var(--zg-primary, #f59e0b); border-color: var(--zg-primary, #f59e0b); color: #fff; font-weight: 700; }
.chip.zero { border-color: rgba(150, 150, 150, .35); }
.gr-comment { margin-top: 10px; }
.gr-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
.gf-total { font-size: 13px; }
.gf-total b { font-size: 18px; color: var(--zg-primary, #f59e0b); font-variant-numeric: tabular-nums; }
.gf-btns { display: flex; gap: 8px; }
.gr-tips { margin-top: 8px; font-size: 11px; color: var(--zg-text-dim, #8a7a5e); line-height: 1.5; }

/* 响应式：窄屏改为单列纵向堆叠（左队列折叠成横滑条） */
@media (max-width: 1100px) {
  .gw-body { grid-template-columns: 1fr; }
  .gl-list { max-height: none; flex-direction: row; overflow-x: auto; gap: 6px; }
  .gl-item { flex: none; }
  .gm-canvas, .gr-qs { height: auto; max-height: 340px; }
}
@media (max-width: 768px) {
  .gw-body { gap: 10px; }
  .gw-left, .gw-mid, .gw-right { padding: 10px; }
  .gm-canvas { height: 280px; }
  .chip { min-width: 44px; height: 44px; font-size: 14px; }
  .gq-chips { gap: 6px; }
  .gr-quick .el-button { min-height: 44px; }
  .gf-btns { width: 100%; }
  .gf-btns .el-button { flex: 1; margin: 0; min-height: 44px; }
}
</style>
