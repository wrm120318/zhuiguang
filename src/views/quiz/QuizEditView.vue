<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()
const route = useRoute()
const user = useUserStore()
const data = useDataStore()

const isEdit = computed(() => !!route.params.id)
const form = ref({
  title: '',
  description: '',
  subjectId: null as number | null,
  classId: null as number | null,
  duration: 0,
  validUntil: '',
  status: 'published' as 'published' | 'closed' | 'draft',
})
const questions = ref<any[]>([])
const submitting = ref(false)
// 【v4.0.1 Bug10 兼容模式】从学科题库选题 dialog
const pickVisible = ref(false)
const pickPool = ref<any[]>([])
const pickLoading = ref(false)
const pickSelected = ref<number[]>([])
async function openPick() {
  if (!form.value.subjectId) { ElMessage.warning('请先选择学科'); return }
  pickVisible.value = true
  pickLoading.value = true
  try {
    const rows: any = await api.subjectQuestions(form.value.subjectId)
    pickPool.value = Array.isArray(rows) ? rows : []
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载学科题库失败')
  } finally { pickLoading.value = false }
}
function confirmPick() {
  // 勾选的按题号顺序插入到 questions 末尾（与后端 sort 行为一致）
  const picked = pickPool.value.filter(q => pickSelected.value.includes(q.id))
  for (const q of picked) {
    questions.value.push({
      qtype: q.qtype, content: q.content,
      options: q.options || (q.qtype === 'single' || q.qtype === 'multiple' ? ['', '', '', ''] : []),
      answer: q.answer || '',
      score: q.score ?? 5,
      attachments: q.attachments || [],
      _fromPool: true, _poolId: q.id,
    })
  }
  ElMessage.success(`已从学科题库添加 ${picked.length} 题`)
  pickVisible.value = false
  pickSelected.value = []
}

onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  if (!data.classes.length) await data.fetchClasses()
  if (isEdit.value) {
    const r: any = await api.quiz(Number(route.params.id))
    form.value = {
      title: r.title, description: r.description || '',
      subjectId: r.subject_id, classId: r.class_id,
      duration: r.duration || 0, validUntil: r.valid_until || '',
      status: r.status,
    }
    questions.value = (r.questions || []).map((q: any) => ({
      id: q.id, qtype: q.qtype, content: q.content,
      options: q.options || (q.qtype === 'single' || q.qtype === 'multiple' ? ['', '', '', ''] : []),
      answer: q.answer || '',
      score: q.score ?? 5,
      attachments: q.attachments || [],
    }))
  } else {
    const qSid = route.query.subjectId ? Number(route.query.subjectId) : null
    form.value.subjectId = qSid ?? data.subjects[0]?.id ?? null
    form.value.classId = data.classes[0]?.id ?? null
    questions.value = [newQuestion('single')]
  }
})

function newQuestion(qtype: string) {
  return {
    qtype, content: '',
    options: qtype === 'single' || qtype === 'multiple' ? ['', '', '', ''] : qtype === 'judge' ? ['对', '错'] : [],
    answer: '',
    score: 5,
    attachments: [] as any[],
  }
}

function addQuestion(qtype: string) { questions.value.push(newQuestion(qtype)) }
function removeQuestion(i: number) { questions.value.splice(i, 1) }
function onTypeChange(q: any) {
  if (q.qtype === 'judge') { q.options = ['对', '错']; q.answer = '对' }
  else if (q.qtype === 'single' || q.qtype === 'multiple') { q.options = q.options.length >= 2 ? q.options : ['', '', '', '']; q.answer = '' }
  else { q.options = []; q.answer = '' }
}

async function onUploadAttach(uploadRequest: any, q: any) {
  const raw = uploadRequest.file as File
  if (!raw) return
  try {
    const r: any = await api.uploadFile(raw)
    q.attachments.push({ name: r.fileName, url: r.filePath, type: r.fileType, size: r.fileSize })
    ElMessage.success('附件已上传')
  } catch (e: any) {
    console.error('[附件上传失败]', e)
    ElMessage.error(e?.message || '附件上传失败')
  }
}

function removeAttach(q: any, i: number) { q.attachments.splice(i, 1) }

function fmtSize(n: number) {
  if (!n) return ''
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB'
  return (n / 1024 / 1024).toFixed(1) + 'MB'
}

async function submit() {
  if (!form.value.title) { ElMessage.warning('请填写题库标题'); return }
  if (!form.value.subjectId || !form.value.classId) { ElMessage.warning('请选择学科与班级'); return }
  if (!questions.value.length) { ElMessage.warning('请至少添加一道题目'); return }
  for (const q of questions.value) {
    if (!q.content) { ElMessage.warning('请填写每道题的题干'); return }
    if ((q.qtype === 'single' || q.qtype === 'multiple' || q.qtype === 'judge') && !q.answer) {
      ElMessage.warning('请为客观题设置正确答案'); return
    }
  }
  submitting.value = true
  try {
    const payload = {
      ...form.value,
      questions: questions.value.map(q => ({
        qtype: q.qtype, content: q.content,
        options: q.options, answer: q.answer,
        score: q.score, attachments: q.attachments,
      })),
    }
    if (isEdit.value) {
      // 简化：编辑时整体重建题目（先删除后插入在 API 层未支持，这里改用 PATCH 元信息 + 提示）
      await api.updateQuiz(Number(route.params.id), {
        title: form.value.title, description: form.value.description,
        duration: form.value.duration, validUntil: form.value.validUntil, status: form.value.status,
      })
      ElMessage.success('题库元信息已更新（题目修改请删除后重建）')
    } else {
      await api.createQuiz(payload)
      ElMessage.success('题库已创建')
    }
    router.push('/quizzes')
  } catch { /* */ } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div class="editor glass-strong">
      <h1 class="ep-title"><template v-if="isEdit"><ZgGlyph emoji="✏️" /> 编辑题库</template><template v-else><ZgGlyph emoji="📝" /> 创建题库</template></h1>

      <div class="ep-row">
        <el-input v-model="form.title" placeholder="题库名称，如：高三期末复习卷" />
      </div>
      <el-input v-model="form.description" type="textarea" :rows="2" placeholder="题库描述（选填）" style="margin-bottom:12px" />
      <div class="ep-row">
        <el-select v-model="form.subjectId" placeholder="学科" style="flex:1">
          <el-option v-for="s in data.subjects" :key="s.id" :label="s.icon + ' ' + s.name" :value="s.id" />
        </el-select>
        <el-select v-model="form.classId" placeholder="班级" style="flex:1">
          <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-input-number v-model="form.duration" :min="0" :step="5" placeholder="作答时长(分钟)" />
      </div>
      <div class="ep-row">
        <el-input v-model="form.validUntil" placeholder="截止时间，如 2026-08-30 23:59" />
        <el-select v-model="form.status" style="width:160px">
          <el-option label="进行中" value="published" />
          <el-option label="草稿" value="draft" />
          <el-option label="已关闭" value="closed" />
        </el-select>
      </div>

      <div class="q-section">
        <div class="qs-head">
          <div class="qs-title">题目列表（{{ questions.length }} 题）</div>
          <div class="qs-actions">
            <!-- 【v4.0.1 Bug10 兼容模式】从学科题库选题 dialog 入口 -->
            <el-button size="small" @click="openPick" :disabled="!form.subjectId"><ZgGlyph emoji="📚" /> 从学科题库选题</el-button>
            <el-dropdown trigger="click">
              <el-button type="primary" size="small">+ 添加题目</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="addQuestion('single')">单选题</el-dropdown-item>
                  <el-dropdown-item @click="addQuestion('multiple')">多选题</el-dropdown-item>
                  <el-dropdown-item @click="addQuestion('judge')">判断题</el-dropdown-item>
                  <el-dropdown-item @click="addQuestion('subjective')">主观题（需批改）</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-for="(q, i) in questions" :key="i" class="q-edit">
          <div class="qe-head">
            <span class="qe-no">第 {{ i + 1 }} 题</span>
            <el-select v-model="q.qtype" size="small" style="width:120px" @change="onTypeChange(q)">
              <el-option label="单选" value="single" />
              <el-option label="多选" value="multiple" />
              <el-option label="判断" value="judge" />
              <el-option label="主观" value="subjective" />
            </el-select>
            <el-input-number v-model="q.score" :min="1" :max="100" size="small" />分
            <el-button text type="danger" size="small" @click="removeQuestion(i)">删除</el-button>
          </div>

          <el-input v-model="q.content" type="textarea" :rows="2" placeholder="题干（支持 Markdown 语法，如 **加粗**、`代码`、![图片](url)）" />

          <template v-if="q.qtype === 'single' || q.qtype === 'multiple' || q.qtype === 'judge'">
            <div class="qe-options">
              <div v-for="(opt, idx) in q.options" :key="idx" class="qe-opt">
                <el-input v-model="q.options[idx]" :placeholder="`选项 ${String.fromCharCode(65 + idx)}`" size="small" />
                <el-button text type="danger" size="small" @click="q.options.splice(idx, 1)">×</el-button>
              </div>
              <el-button v-if="q.qtype !== 'judge'" text size="small" @click="q.options.push('')">+ 添加选项</el-button>
            </div>
            <el-input v-model="q.answer" :placeholder="q.qtype === 'judge' ? '正确答案：对 或 错' : q.qtype === 'multiple' ? '正确答案（多个用英文逗号，如 A,B）' : '正确答案（如 A）'" size="small" style="margin-top:8px" />
          </template>
          <template v-else>
            <div class="qe-tip">主观题由教师批改给分，学生作答时输入文字。</div>
            <el-input v-model="q.answer" placeholder="参考答案 / 评分要点（仅教师可见，批改时参考）" type="textarea" :rows="2" style="margin-top:8px" />
          </template>

          <div class="qe-attach">
            <el-upload :http-request="(req: any) => onUploadAttach(req, q)" :show-file-list="false" multiple>
              <el-button size="small"><ZgGlyph emoji="📎" /> 添加附件（图片/文件）</el-button>
            </el-upload>
            <div v-for="(a, idx) in q.attachments" :key="idx" class="qa-item">
              <span><ZgGlyph emoji="📎" /> {{ a.name }} ({{ fmtSize(a.size) }})</span>
              <el-button text type="danger" size="small" @click="removeAttach(q, idx)">×</el-button>
            </div>
          </div>
        </div>
      </div>

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">{{ isEdit ? '保存' : '创建' }}</el-button>
      </div>
    </div>

    <!-- 【v4.0.1 Bug10 兼容模式】从学科题库选题 dialog -->
    <el-dialog v-model="pickVisible" width="780px" :close-on-click-modal="false">
      <template #header><span style="font-weight:700">从学科题库选题</span></template>
      <div v-loading="pickLoading" class="pick-wrap">
        <div v-if="!pickPool.length" class="pick-empty">
          <el-empty description="该学科题库还没有题目" />
        </div>
        <el-table v-else :data="pickPool" @selection-change="(rows: any[]) => pickSelected = rows.map(r => r.id)" max-height="440">
          <el-table-column type="selection" width="50" />
          <el-table-column prop="qtype" label="类型" width="80">
            <template #default="{ row }">
              <el-tag size="small" :type="(row.qtype==='single'?'primary':row.qtype==='multiple'?'success':row.qtype==='judge'?'warning':'info') as any">
                {{ ({ single: '单选', multiple: '多选', judge: '判断', subjective: '主观' } as any)[row.qtype] || row.qtype }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="content" label="题干" min-width="380" show-overflow-tooltip />
          <el-table-column prop="score" label="分值" width="70" />
        </el-table>
      </div>
      <template #footer>
        <el-button @click="pickVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!pickSelected.length" @click="confirmPick">添加 {{ pickSelected.length }} 题</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.editor { padding: 28px; }
.ep-title { font-size: 22px; font-weight: 800; margin-bottom: 16px; }
.ep-row { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.q-section { margin-top: 20px; }
.qs-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.qs-title { font-weight: 700; font-size: 16px; }
.qs-actions { display: flex; gap: 8px; align-items: center; }
.pick-wrap { min-height: 120px; }
.pick-empty { padding: 24px 0; }
.q-edit { padding: 16px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.04); border: 1px dashed rgba(var(--zg-primary-rgb),.18); margin-bottom: 14px; }
.qe-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.qe-no { font-weight: 700; }
.qe-options { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.qe-opt { display: flex; align-items: center; gap: 8px; }
.qe-tip { font-size: 12px; color: var(--zg-text-dim); margin-top: 6px; }
.qe-attach { margin-top: 10px; }
.qa-item { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; background: rgba(var(--zg-primary-rgb),.08); border-radius: 6px; margin-top: 6px; font-size: 13px; }
.ep-foot { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
@media (max-width: 720px) { .editor { padding: 18px; } .ep-row { flex-direction: column; } }
</style>
