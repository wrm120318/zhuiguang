<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()
const data = useDataStore()
const user = useUserStore()

const form = ref({
  title: '',
  author: user.current?.realName || '',
  source: '原创',
  recommendation: '',
  category: '散文',
  tagsInput: '',
})
const editorRef = ref<HTMLElement | null>(null)
const images = ref<string[]>([])
const cover = ref('')
const submitting = ref(false)

// 需求3：教师代发美文 — 选择实际作者学生（可搜索）
const allStudents = ref<any[]>([])
const authorSearch = ref('')
const authorPickerVisible = ref(false)
// 选中的代发作者学生：null=自己发, 否则是学生用户对象
const proxyAuthor = ref<any>(null)

const filteredStudents = computed(() => {
  const kw = authorSearch.value.trim().toLowerCase()
  const list = allStudents.value.filter(s => s.role === 'STUDENT' && s.status === 'active')
  if (!kw) return list.slice(0, 50)
  return list.filter(s =>
    (s.real_name || '').toLowerCase().includes(kw) ||
    (s.username || '').toLowerCase().includes(kw)
  ).slice(0, 50)
})

const subjectOptions = computed(() => data.subjects.filter(s => s.modules?.articles))
const subjectId = ref(1)

onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  if (subjectOptions.value.length && !subjectOptions.value.find(s => s.id === subjectId.value)) {
    subjectId.value = subjectOptions.value[0].id
  }
  // 需求3：教师/超管可以代发，拉取全部用户列表用于选择作者学生
  if (user.isTeacher || user.isSuperAdmin) {
    try {
      const r: any = await api.users()
      allStudents.value = r.data || r
    } catch {}
  }
})

function exec(cmd: string, val?: string) {
  document.execCommand(cmd, false, val)
  editorRef.value?.focus()
}

function getContent() {
  return editorRef.value?.innerHTML || ''
}

async function onUploadImg(uploadRequest: any) {
  const raw = uploadRequest.file as File
  if (!raw) return
  try {
    const r: any = await api.uploadImage(raw)
    const url = r.url
    if (!cover.value) cover.value = url
    images.value.push(url)
    const img = `<img src="${url}" style="max-width:100%;border-radius:12px;margin:10px 0;" />`
    if (editorRef.value) {
      editorRef.value.innerHTML += img
    }
    ElMessage.success('图片已上传')
  } catch (e: any) {
    console.error('[图片上传失败]', e)
    ElMessage.error(e?.message || '图片上传失败')
  }
}

function selectProxyStudent(s: any) {
  proxyAuthor.value = s
  form.value.author = s.real_name
  authorPickerVisible.value = false
  ElMessage.success(`已选择代发作者：${s.real_name}`)
}
function clearProxyAuthor() {
  proxyAuthor.value = null
  form.value.author = user.current?.realName || ''
  authorSearch.value = ''
}

async function submit() {
  const content = getContent()
  if (!form.value.title || !content) { ElMessage.warning('请填写标题与正文'); return }
  submitting.value = true
  try {
    const payload: any = {
      title: form.value.title,
      content,
      author: form.value.author,
      source: form.value.source,
      recommendation: form.value.recommendation,
      subjectId: subjectId.value,
      cover: cover.value || `https://picsum.photos/seed/zg${Date.now()}/800/500`,
      images: images.value,
      tags: form.value.tagsInput.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      category: form.value.category,
      classId: user.classIds[0] || 1,
    }
    // 需求3：教师代发 — 指定 actualUserId
    if ((user.isTeacher || user.isSuperAdmin) && proxyAuthor.value) {
      payload.actualUserId = proxyAuthor.value.id
    }
    const r: any = await api.createArticle(payload)
    // 需求4：状态提示文案区分
    if (r.status === 'approved') {
      ElMessage.success('发布成功，已公开展示')
    } else if (r.status === 'pending_student') {
      ElMessage.success(`已提交，等待学生「${proxyAuthor.value.real_name}」确认后进入超管审核`)
    } else {
      ElMessage.success('提交成功，待超级管理员审核通过后将公开')
    }
    router.push(`/subject/${data.subjectById(subjectId.value)?.slug}`)
  } catch { /* http 拦截器已提示 */ } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div class="editor-page glass-strong">
      <h1 class="ep-title"><ZgGlyph emoji="✍️" /> 发布美文</h1>
      <p class="ep-tip">选择对应学科，提交后进入待审核，由学科教师或管理员审核通过后公开展示。</p>

      <div class="ep-row">
        <el-select v-model="subjectId" placeholder="选择学科" style="width:160px">
          <el-option v-for="s in subjectOptions" :key="s.id" :label="`${s.icon} ${s.name}`" :value="s.id" />
        </el-select>
        <el-input v-model="form.title" placeholder="文章标题" />
      </div>

      <div class="ep-row">
        <!-- 需求3：教师/超管账号可选代发的实际作者学生 -->
        <div class="author-field" v-if="user.isTeacher || user.isSuperAdmin">
          <div class="af-current" @click="authorPickerVisible = !authorPickerVisible">
            <span v-if="proxyAuthor" class="af-proxy">
              <ZgGlyph emoji="🧑‍" /><ZgGlyph emoji="🎓" /> 代发作者：<b>{{ proxyAuthor.real_name }}</b>
              <el-tag size="small" type="warning" style="margin-left:6px">学生确认后公开</el-tag>
            </span>
            <span v-else class="af-self"><ZgGlyph emoji="✍️" /> 自己发布（作者：{{ form.author }}）</span>
            <span class="af-toggle"><ZgGlyph v-if="authorPickerVisible" emoji="▲" /><ZgGlyph v-else emoji="▼" /></span>
          </div>
          <div v-if="authorPickerVisible" class="af-picker glass-strong">
            <div class="afp-title">选择实际作者（学生）— 发布后需要学生确认</div>
            <el-input v-model="authorSearch" placeholder="搜索学生姓名或账号..." size="small" clearable />
            <div class="afp-list">
              <div v-for="s in filteredStudents" :key="s.id" class="afp-item" @click="selectProxyStudent(s)">
                <span class="afp-name">{{ s.real_name }}</span>
                <span class="afp-uname">@{{ s.username }}</span>
              </div>
              <el-empty v-if="!filteredStudents.length" :image-size="60" description="没有匹配的学生" />
            </div>
            <div class="afp-actions">
              <el-button v-if="proxyAuthor" size="small" type="danger" plain @click="clearProxyAuthor">取消代发（改为自己发）</el-button>
              <el-button size="small" @click="authorPickerVisible=false">收起</el-button>
            </div>
          </div>
        </div>
        <el-input v-else v-model="form.author" placeholder="作者" style="width:200px" />
        <el-input v-model="form.source" placeholder="出处（原创/转载）" style="width:160px" />
        <el-select v-model="form.category" placeholder="分类" style="width:160px">
          <el-option label="散文" value="散文" />
          <el-option label="诗歌" value="诗歌" />
          <el-option label="短篇小说" value="短篇小说" />
          <el-option label="英文美文" value="英文美文" />
        </el-select>
      </div>

      <el-input v-model="form.recommendation" placeholder="推荐语（一句话介绍）" style="margin-bottom:12px" />

      <el-input v-model="form.tagsInput" placeholder="标签，用逗号分隔（如：散文,励志）" style="margin-bottom:12px" />

      <div class="toolbar glass">
        <button @click="exec('bold')"><b>B</b></button>
        <button @click="exec('italic')"><i>I</i></button>
        <button @click="exec('underline')"><u>U</u></button>
        <button @click="exec('formatBlock','<h2>')">H2</button>
        <button @click="exec('formatBlock','<p>')">正文</button>
        <button @click="exec('formatBlock','<blockquote>')">引用</button>
        <button @click="exec('insertUnorderedList')">• 列表</button>
        <el-upload :show-file-list="false" :http-request="onUploadImg" accept="image/*">
          <button><ZgGlyph emoji="🖼️" /> 插入图片</button>
        </el-upload>
      </div>
      <div ref="editorRef" class="editor" contenteditable="true"></div>

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交审核</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display:inline-block; margin:16px 0 0; color:var(--zg-text-dim); cursor:pointer; }
.editor-page { padding:32px; }
.ep-title { font-size:24px; font-weight:800; }
.ep-tip { color:var(--zg-text-dim); font-size:13px; margin:8px 0 20px; }
.ep-row { display:flex; gap:12px; margin-bottom:12px; }
.toolbar { display:flex; gap:6px; padding:8px; margin:12px 0; flex-wrap:wrap; }
.toolbar button { background:rgba(245,158,11,.06); border:1px solid rgba(245,158,11,.15); color:var(--zg-text); padding:6px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
.toolbar button:hover { background:rgba(245,158,11,.2); }
.editor { min-height:320px; padding:20px; background:rgba(255,255,255,.5); border-radius:12px; border:1px solid rgba(245,158,11,.15); outline:none; font-size:16px; line-height:1.9; }
.editor :deep(img) { max-width:100%; border-radius:12px; margin:10px 0; }
.editor :deep(blockquote) { border-left:3px solid var(--zg-primary); padding:8px 16px; margin:12px 0; background:rgba(255,255,255,.5); border-radius:0 8px 8px 0; color:var(--zg-text-dim); }
.editor:empty::before { content:'在此输入正文…'; color:var(--zg-text-dim); }
.ep-foot { display:flex; justify-content:flex-end; gap:12px; margin-top:20px; }
@media (max-width:720px){ .ep-row{flex-direction:column;} .editor-page{padding:20px;} }

.author-field { flex:1; min-width:280px; }
.af-current { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(245,158,11,.08); border:1px dashed rgba(245,158,11,.3); border-radius:10px; cursor:pointer; font-size:14px; }
.af-current:hover { background:rgba(245,158,11,.14); }
.af-proxy b { color:var(--zg-primary); font-weight:700; }
.af-self { color:var(--zg-text-dim); }
.af-toggle { color:var(--zg-primary); font-size:12px; }
.af-picker { margin-top:10px; padding:16px; border-radius:14px; }
.afp-title { font-size:13px; font-weight:600; margin-bottom:10px; color:var(--zg-primary); }
.afp-list { max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; margin:10px 0; }
.afp-item { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
.afp-item:hover { background:rgba(245,158,11,.12); }
.afp-name { font-weight:600; }
.afp-uname { color:var(--zg-text-dim); font-size:12px; }
.afp-actions { display:flex; justify-content:space-between; align-items:center; }
</style>
