<template>
  <div class="exam-page" v-if="subject">
    <!-- 头部 -->
    <div class="exam-head">
      <div>
        <h2 class="zg-title"><ZgGlyph emoji="📝" /> {{ subject.name }} · 考试管理</h2>
        <p class="zg-sub">创建考试 · 答题卡模板 · 网阅打分 · 成绩发布（支持查询密码）</p>
      </div>
      <div class="head-actions">
        <el-button v-if="isStaff" type="primary" icon="Plus" @click="showCreate = true">创建考试</el-button>
        <el-button v-if="!isStaff" icon="Trophy" @click="showMy = true">我的成绩</el-button>
      </div>
    </div>

    <!-- 考试列表 -->
    <div v-loading="loading" class="exam-list">
      <el-empty v-if="!exams.length" description="还没有考试，点击右上角创建第一场吧" />
      <el-card v-for="ex in exams" :key="ex.id" class="exam-card" shadow="hover">
        <div class="exam-card-head">
          <div class="exam-meta">
            <el-tag size="small" :type="typeTag(ex.type)">{{ typeLabel(ex.type) }}</el-tag>
            <span class="exam-title">{{ ex.title }}</span>
          </div>
          <el-tag size="small" :type="ex.status === 'published' ? 'success' : (ex.status === 'grading' ? 'warning' : 'info')">
            {{ statusLabel(ex.status) }}
          </el-tag>
          <el-tag v-if="ex.level" size="small" type="warning" effect="plain">{{ levelLabel(ex.level) }}层</el-tag>
        </div>
        <div class="exam-info">
          <span><ZgGlyph emoji="📋" /> {{ (ex.questions || []).length }} 题</span>
          <span><ZgGlyph emoji="🏆" /> 总分 {{ ex.total_score }}</span>
          <span v-if="ex.exam_date"><ZgGlyph emoji="📅" /> {{ ex.exam_date }}</span>
          <span><ZgGlyph emoji="👤" /> {{ ex.creator_name || '—' }}</span>
          <span v-if="ex.release_password"><el-tag size="small" type="danger" effect="plain">🔒 密码保护</el-tag></span>
        </div>
        <div class="exam-actions">
          <el-button size="small" icon="View" @click="openDetail(ex)">查看 / 答题卡</el-button>
          <el-button v-if="isStaff" size="small" type="warning" icon="EditPen" @click="openGrade(ex)">网阅打分</el-button>
          <template v-if="isStaff">
            <el-button v-if="ex.status !== 'published'" size="small" type="success" icon="Upload" @click="publish(ex, true)">发布成绩</el-button>
            <el-button v-else size="small" icon="Download" @click="publish(ex, false)">撤回</el-button>
            <el-popconfirm title="确认删除该考试？" @confirm="del(ex)">
              <template #reference><el-button size="small" type="danger" icon="Delete" /></template>
            </el-popconfirm>
          </template>
        </div>
      </el-card>
    </div>

    <!-- 创建考试 -->
    <el-dialog v-model="showCreate" title="创建考试" width="760px" top="5vh" @open="resetCreate" append-to-body>
      <el-form label-width="92px">
        <el-form-item label="考试标题" required>
          <el-input v-model="form.title" placeholder="如：2026 秋第一次月考" maxlength="80" />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="考试类型">
              <el-select v-model="form.type">
                <el-option label="正式考试" value="exam" />
                <el-option label="随堂测验" value="quiz" />
                <el-option label="分层作业" value="homework" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="考试日期">
              <el-date-picker v-model="form.exam_date" type="date" value-format="YYYY-MM-DD" placeholder="选填" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="查询密码">
              <el-input v-model="form.release_password" placeholder="选填（学生查分需输入）" maxlength="20" />
            </el-form-item>
          </el-col>
          <el-col :span="8" v-if="form.type === 'homework'">
            <el-form-item label="分层">
              <el-select v-model="form.level" placeholder="选择难度层" clearable>
                <el-option v-for="l in LEVELS" :key="l.v" :label="l.l" :value="l.v" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="选题">
          <div class="picker">
            <div class="picker-bar">
              <el-input v-model="qKw" placeholder="搜索题库题目" size="small" style="width:220px" @keyup.enter="searchQ" />
              <el-select v-model="qType" placeholder="题型" clearable size="small" style="width:130px" @change="searchQ">
                <el-option v-for="t in qtypes" :key="t.v" :label="t.l" :value="t.v" />
              </el-select>
              <el-button size="small" icon="Search" @click="searchQ">搜索</el-button>
            </div>
            <div class="picker-body">
              <div class="pool">
                <div v-for="q in qPool" :key="q.id" class="pool-item" @click="addQ(q)">
                  <span class="qtype-dot" :style="{ background: qtypeColor(q.qtype) }">{{ qtypeLabel(q.qtype) }}</span>
                  <span class="pool-text" v-html="renderMarkdown(shorten(q.content))" />
                  <el-icon><Plus /></el-icon>
                </div>
                <el-empty v-if="!qPool.length" :image-size="40" description="搜索后从题库添加" />
              </div>
              <div class="picked">
                <div v-for="(p, i) in picked" :key="p.id" class="picked-item">
                  <span class="picked-idx">{{ i + 1 }}</span>
                  <span class="picked-text" v-html="renderMarkdown(shorten(p.content))" />
                  <el-input-number v-model="p.score" :min="1" :max="100" size="small" controls-position="right" style="width:96px" />
                  <el-icon class="del" @click="picked.splice(i, 1)"><Close /></el-icon>
                </div>
                <el-empty v-if="!picked.length" :image-size="40" description="左侧点击添加题目" />
              </div>
            </div>
            <div class="picker-foot">已选 <b>{{ picked.length }}</b> 题 · 总分 <b>{{ pickedTotal }}</b> 分</div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :disabled="!form.title || !picked.length" :loading="saving" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <!-- 详情 / 答题卡 -->
    <el-drawer v-model="showDetail" :title="curExam?.title" size="60%" @open="loadDetail">
      <div v-if="detail" v-loading="detailLoading">
        <div class="detail-bar">
          <el-button icon="Printer" @click="printSheet">生成答题卡模板</el-button>
          <el-tag type="info">共 {{ detail.questions.length }} 题 / 总分 {{ detail.total_score }}</el-tag>
        </div>
        <div v-for="(q, i) in detail.questions" :key="q.id" class="d-q">
          <div class="d-q-head"><b>{{ i + 1 }}.</b> <span class="qtype-dot" :style="{ background: qtypeColor(q.qtype) }">{{ qtypeLabel(q.qtype) }}</span> <span class="d-score">{{ q.score }}分</span></div>
          <div class="d-q-body" v-html="renderMarkdown(q.content)" />
          <div v-if="q.options && q.options.length" class="d-opts">
            <div v-for="(o, oi) in q.options" :key="oi" class="d-opt"><b>{{ letter(oi) }}.</b> {{ o }}</div>
          </div>
        </div>
      </div>
    </el-drawer>

    <!-- 网阅打分 -->
    <el-dialog v-model="showGrade" :title="'网阅打分 · ' + (curExam?.title || '')" width="880px" top="4vh" @open="loadResponses" append-to-body>
      <div class="grade-wrap" v-loading="gradeLoading">
        <div class="grade-pick">
          <el-select v-model="gradeStudent" filterable placeholder="选择学生" style="width:220px" @change="onStudentChange">
            <el-option v-for="s in students" :key="s.id" :label="s.real_name + '（' + (s.username || '') + '）'" :value="s.id" />
          </el-select>
          <el-upload :show-file-list="false" :http-request="uploadScan" accept="image/*">
            <el-button size="small" icon="UploadFilled">上传扫描件</el-button>
          </el-upload>
          <el-link v-if="scanUrl" type="primary" :href="scanUrl" target="_blank">查看扫描件</el-link>
        </div>
        <div v-if="curExam && curExam.questions.length" class="grade-grid">
          <div v-for="(q, i) in curExam.questions" :key="q.id" class="grade-row">
            <span class="gr-idx">{{ i + 1 }}.</span>
            <span class="gr-text" v-html="renderMarkdown(shorten(q.content))" />
            <el-input-number v-model="gradeScores[q.id]" :min="0" :max="Number(q.score) || 100" size="small" controls-position="right" style="width:110px" />
            <span class="gr-max">/ {{ q.score }}</span>
          </div>
        </div>
        <el-input v-model="gradeComment" type="textarea" :rows="2" placeholder="评语（选填）" style="margin-top:10px" />
        <div class="grade-foot">
          <b>合计：{{ gradeTotal }} 分</b>
          <el-button type="primary" :disabled="!gradeStudent" :loading="saving" @click="saveGrade">保存该生成绩</el-button>
        </div>
        <el-divider>已录入（{{ responses.length }} 人）</el-divider>
        <el-table :data="responses" size="small" max-height="220">
          <el-table-column prop="student_name" label="学生" width="120" />
          <el-table-column prop="total" label="总分" width="80" />
          <el-table-column label="扫描件" width="90">
            <template #default="{ row }"><el-link v-if="row.scan_url" type="primary" :href="row.scan_url" target="_blank">查看</el-link><span v-else>—</span></template>
          </el-table-column>
          <el-table-column prop="comment" label="评语" show-overflow-tooltip />
        </el-table>
      </div>
    </el-dialog>

    <!-- 学生查分 -->
    <el-dialog v-model="showMy" title="我的成绩" width="460px" append-to-body>
      <div v-if="myResult === null" v-loading="myLoading" />
      <template v-else-if="myResult?.released">
        <template v-if="myResult.response">
          <p>总分：<b style="font-size:20px;color:#e11d48">{{ myResult.response.total }}</b> / {{ myResult.total_score }}</p>
          <el-table :data="myQuestions" size="small">
            <el-table-column label="题号" width="60">
              <template #default="{ $index }">{{ $index + 1 }}</template>
            </el-table-column>
            <el-table-column label="得分" width="80">
              <template #default="{ row }">{{ myResult.response.scores[row.id] ?? '—' }}</template>
            </el-table-column>
          </el-table>
          <p v-if="myResult.response.comment" style="margin-top:8px">评语：{{ myResult.response.comment }}</p>
        </template>
        <el-empty v-else description="教师尚未录入你的成绩" :image-size="60" />
      </template>
      <template v-else>
        <p>{{ myResult?.message || '成绩尚未发布' }}</p>
        <el-input v-if="myResult?.needPwd" v-model="myPwd" placeholder="请输入查询密码" style="margin-top:8px" @keyup.enter="loadMy" />
        <el-button v-if="myResult?.needPwd" type="primary" style="margin-top:8px" :loading="myLoading" @click="loadMy">查询</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { renderMarkdown } from '@/utils/markdown'
import ZgGlyph from '@/components/ZgGlyph.vue'
import { ElMessage } from 'element-plus'
import { UploadFile } from 'element-plus'

const route = useRoute()
const user = useUserStore()
const slug = route.params.slug as string
const subject: any = ref(null)
const exams = ref<any[]>([])
const students = ref<any[]>([])
const loading = ref(false)
const isStaff = computed(() => user.isStaff)
const qtypes = [
  { v: 'single', l: '单选题' }, { v: 'multi', l: '多选题' }, { v: 'fill', l: '填空题' },
  { v: 'judge', l: '判断题' }, { v: 'essay', l: '解答题' }, { v: 'calc', l: '计算题' },
]
const qtypeLabel = (v: string) => qtypes.find(t => t.v === v)?.l || v
const qtypeColor = (v: string) => {
  const map: Record<string, string> = { single: '#3b82f6', multi: '#8b5cf6', fill: '#10b981', judge: '#f59e0b', essay: '#ef4444', calc: '#06b6d4' }
  return map[v] || '#94a3b8'
}
const typeLabel = (v: string) => ({ exam: '正式考试', quiz: '随堂测验', homework: '分层作业' }[v] || v)
const typeTag = (v: string) => ({ exam: '', quiz: 'success', homework: 'warning' }[v] || 'info')
const statusLabel = (v: string) => ({ draft: '草稿', grading: '阅卷中', published: '已发布' }[v] || v)
const letter = (i: number) => String.fromCharCode(65 + i)
const shorten = (s: string) => (s && s.length > 60 ? s.slice(0, 60) + '…' : (s || ''))

// ===== 创建 =====
const showCreate = ref(false)
const form = ref({ title: '', type: 'exam', exam_date: '', release_password: '', level: '' })
const LEVELS = [{ v: 'basic', l: '基础' }, { v: 'improve', l: '提升' }, { v: 'expand', l: '拓展' }]
const levelLabel = (v: string) => LEVELS.find(l => l.v === v)?.l || ''
const qKw = ref(''); const qType = ref(''); const qPool = ref<any[]>([])
const picked = ref<any[]>([])
const pickedTotal = computed(() => picked.value.reduce((a, p) => a + (Number(p.score) || 0), 0))
const saving = ref(false)
function resetCreate() { form.value = { title: '', type: 'exam', exam_date: '', release_password: '', level: '' }; qKw.value = ''; qType.value = ''; qPool.value = []; picked.value = [] }
async function searchQ() {
  const r: any = await api.subjectQuestions(subject.value.id, { keyword: qKw.value || undefined, qtype: qType.value || undefined, pageSize: 50 })
  qPool.value = (r?.data || r || []).slice(0, 50)
}
function addQ(q: any) { if (!picked.value.find(p => p.id === q.id)) picked.value.push({ id: q.id, content: q.content, score: 5 }) }
async function create() {
  saving.value = true
  try {
    await api.createExam(subject.value.id, { ...form.value, level: form.value.level || '', questions: picked.value.map(p => ({ id: p.id, score: Number(p.score) })) })
    showCreate.value = false
    ElMessage.success('考试已创建')
    loadExams()
  } finally { saving.value = false }
}

// ===== 详情 / 答题卡 =====
const showDetail = ref(false)
const curExam: any = ref(null)
const detail: any = ref(null)
const detailLoading = ref(false)
function openDetail(ex: any) { curExam.value = ex; showDetail.value = true }
async function loadDetail() {
  detailLoading.value = true
  try {
    const r: any = await api.examDetail(curExam.value.id)
    detail.value = r?.data || r
  } finally { detailLoading.value = false }
}
function printSheet() {
  if (!detail.value) return
  const qs = detail.value.questions || []
  let rows = ''
  qs.forEach((q: any, i: number) => {
    const isObj = ['single', 'multi', 'judge'].includes(q.qtype)
    let body = ''
    if (isObj) {
      const opts = (q.options || [])
      body = opts.map((o: string, oi: number) => `<span class="bub">（&nbsp;&nbsp;）</span> ${letter(oi)}. ${escapeHtml(stripMd(o))}`).join('&nbsp;&nbsp;')
    } else {
      body = '<div class="lines"><div></div><div></div><div></div></div>'
    }
    rows += `<div class="q"><div class="qh">${i + 1}. （${qtypeLabel(q.qtype)} ${q.score}分）</div><div class="qb">${body}</div></div>`
  })
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(detail.value.title)}·答题卡</title>
  <style>body{font-family:'Microsoft YaHei',sans-serif;padding:24px;color:#111}
  h1{font-size:20px;text-align:center;margin:0 0 4px}.sub{text-align:center;color:#666;margin-bottom:16px}
  .q{margin-bottom:14px;page-break-inside:avoid}.qh{font-weight:bold;margin-bottom:6px}.qb{margin-left:8px;line-height:1.9}
  .bub{display:inline-block;min-width:18px}.lines div{border-bottom:1px solid #999;height:22px;margin:4px 0;width:90%}
  @media print{body{padding:12px}}</style></head><body>
  <h1>${escapeHtml(detail.value.title)}</h1><div class="sub">姓名：____________&nbsp;&nbsp;班级：____________&nbsp;&nbsp;学号：____________</div>
  ${rows}</body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 300) }
}
function escapeHtml(s: string) { return (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
function stripMd(s: string) { return (s || '').replace(/\*\*/g, '').replace(/\$/g, '').replace(/!\[.*?\]\(.*?\)/g, '[图]').slice(0, 80) }

// ===== 网阅 =====
const showGrade = ref(false)
const gradeLoading = ref(false)
const gradeStudent = ref<number | null>(null)
const gradeScores: any = ref({})
const gradeComment = ref('')
const scanUrl = ref('')
const responses = ref<any[]>([])
async function openGrade(ex: any) { curExam.value = ex; showGrade.value = true }
async function loadResponses() {
  gradeLoading.value = true
  try {
    const r: any = await api.examResponses(curExam.value.id)
    responses.value = r?.data || r || []
    gradeStudent.value = null; gradeScores.value = {}; gradeComment.value = ''; scanUrl.value = ''
  } finally { gradeLoading.value = false }
}
function onStudentChange(sid: number) {
  const ex = responses.value.find(r => r.student_id === sid)
  gradeScores.value = ex ? { ...(ex.scores || {}) } : {}
  gradeComment.value = ex?.comment || ''
  scanUrl.value = ex?.scan_url || ''
}
const gradeTotal = computed(() => Object.values(gradeScores.value).reduce((a: number, v: any) => a + (Number(v) || 0), 0))
async function uploadScan(opt: any) {
  const f = (opt.file as UploadFile).raw as File
  const r: any = await api.uploadImage(f)
  scanUrl.value = r?.url || ''
  ElMessage.success('扫描件已上传')
}
async function saveGrade() {
  if (!gradeStudent.value) return
  saving.value = true
  try {
    await api.saveExamResponse(curExam.value.id, { student_id: gradeStudent.value, scores: gradeScores.value, total: gradeTotal.value, scan_url: scanUrl.value, comment: gradeComment.value })
    ElMessage.success('已保存')
    loadResponses()
  } finally { saving.value = false }
}

// ===== 发布 / 删除 =====
async function publish(ex: any, on: boolean) {
  await api.updateExam(ex.id, { status: on ? 'published' : 'grading' })
  ElMessage.success(on ? '成绩已发布' : '已撤回')
  loadExams()
}
async function del(ex: any) {
  await api.deleteExam(ex.id)
  ElMessage.success('已删除')
  loadExams()
}

// ===== 学生查分 =====
const showMy = ref(false)
const myResult: any = ref(null)
const myLoading = ref(false)
const myPwd = ref('')
const myQuestions = computed(() => curExam.value?.questions || [])
async function loadMy() {
  myLoading.value = true
  try {
    const r: any = await api.examMyResult(curExam.value.id, myPwd.value)
    myResult.value = r?.data || r
  } finally { myLoading.value = false }
}

async function loadSubject() { subject.value = await api.subject(slug) }
async function loadExams() {
  loading.value = true
  try {
    const r: any = await api.subjectExams(subject.value.id)
    exams.value = r?.data || r || []
  } finally { loading.value = false }
}
async function loadStudents() {
  try { const r: any = await api.subjectStudents(subject.value.id); students.value = r?.data || r || [] } catch {}
}

onMounted(async () => {
  await loadSubject()
  await Promise.all([loadExams(), isStaff.value ? loadStudents() : Promise.resolve()])
  if (!isStaff.value && exams.value[0]) { curExam.value = exams.value[0]; loadMy() }
})
</script>

<style scoped>
.exam-page { max-width: 1100px; margin: 0 auto; padding: 18px 16px 60px; }
.exam-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.zg-title { font-size: 22px; margin: 0 0 4px; }
.zg-sub { color: #64748b; margin: 0; font-size: 13px; }
.exam-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.exam-card-head { display: flex; justify-content: space-between; align-items: center; }
.exam-meta { display: flex; align-items: center; gap: 8px; }
.exam-title { font-weight: 600; font-size: 15px; }
.exam-info { display: flex; gap: 14px; flex-wrap: wrap; color: #64748b; font-size: 13px; margin: 10px 0; }
.exam-info span { display: inline-flex; align-items: center; gap: 4px; }
.exam-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.picker-bar { display: flex; gap: 8px; margin-bottom: 8px; }
.picker-body { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; height: 320px; }
.pool, .picked { border: 1px solid #e5e7eb; border-radius: 8px; overflow-y: auto; padding: 6px; }
.pool-item, .picked-item { display: flex; align-items: center; gap: 6px; padding: 6px; border-radius: 6px; cursor: pointer; }
.pool-item:hover { background: rgba(var(--zg-primary-rgb), .12); }
.qtype-dot { font-size: 11px; color: #fff; border-radius: 4px; padding: 1px 6px; white-space: nowrap; }
.pool-text, .picked-text { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.picked-item .del { color: #ef4444; cursor: pointer; }
.picked-idx { width: 18px; text-align: center; color: #94a3b8; font-size: 12px; }
.picker-foot { margin-top: 8px; color: #475569; font-size: 13px; }
.detail-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.d-q { border-bottom: 1px dashed #e5e7eb; padding: 10px 0; }
.d-q-head { font-weight: 600; margin-bottom: 4px; }
.d-score { color: #e11d48; font-size: 13px; margin-left: 6px; }
.d-q-body { line-height: 1.7; }
.d-opts { margin: 6px 0 0 18px; line-height: 1.8; }
.grade-wrap { min-height: 200px; }
.grade-pick { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.grade-grid { max-height: 320px; overflow-y: auto; border: 1px solid #eef2f7; border-radius: 8px; padding: 6px; }
.grade-row { display: flex; align-items: center; gap: 8px; padding: 6px; border-bottom: 1px dashed #f1f5f9; }
.gr-idx { width: 20px; color: #94a3b8; }
.gr-text { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-max { color: #94a3b8; font-size: 13px; }
.grade-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; }
</style>
