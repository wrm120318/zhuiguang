<script setup lang="ts">
// ===== v4.2.2 通用美文编辑器 =====
// 同时支持新建（/article/new）和编辑（/article/:id/edit）
// 编辑权限：发布者本人 / 实际作者（代发美文的学生） / 超管 / 对应学科教师
// 编辑器：统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF/B站/file 附件）

import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { zgCover, bingCover, BING_COVERS, fileUrl } from '@/utils/helpers'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { useAutoSave } from '@/composables/useAutoSave'

const route = useRoute()
const router = useRouter()
const data = useDataStore()
const user = useUserStore()

// 编辑模式：有 route.params.id 即为编辑
const editId = computed<number | null>(() => {
  const p = route.params.id
  if (p) {
    const n = Number(Array.isArray(p) ? p[0] : p)
    if (n) return n
  }
  return null
})
const isEdit = computed(() => editId.value !== null)
const pageTitle = computed(() => isEdit.value ? '✏️ 编辑美文' : '✍️ 发布美文')
const loading = ref(false)
const permissionDenied = ref(false)

const form = ref({
  title: '',
  author: user.current?.realName || '',
  source: '原创',
  recommendation: '',
  category: '散文',
  tagsInput: '',
})
const content = ref('')
const images = ref<string[]>([])
const cover = ref('')
const submitting = ref(false)

// 需求3：教师/超管代发 — 选择实际作者学生
const allStudents = ref<any[]>([])
const authorSearch = ref('')
const authorPickerVisible = ref(false)
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

// 自动保存草稿（仅新建模式）
const { hasDraft: draftSaved, restoreDraft: restoreDraftFn, clear: clearDraft } = useAutoSave({
  key: isEdit.value ? `zg_draft_article_edit_${editId.value}` : 'zg_draft_article_new',
  sources: [form, subjectId, cover, images, content],
  snapshot: () => ({
    form: form.value,
    subjectId: subjectId.value,
    cover: cover.value,
    images: images.value,
    content: content.value,
  }),
  restore: (d: any) => {
    if (d.form) Object.assign(form.value, d.form)
    if (typeof d.subjectId === 'number') subjectId.value = d.subjectId
    if (typeof d.cover === 'string') cover.value = d.cover
    if (Array.isArray(d.images)) images.value = d.images
    if (typeof d.content === 'string') content.value = d.content
  },
})

// 编辑模式：拉取数据
async function loadForEdit() {
  if (!editId.value) return
  loading.value = true
  try {
    const r: any = await api.article(editId.value)
    // 权限校验：发布者 / 实际作者 / 超管 / 任教该学科教师
    const isOwner = r.user_id === user.current?.id
    const isActualUser = r.actual_user_id && Number(r.actual_user_id) === Number(user.current?.id)
    const isManage = user.isSuperAdmin || (user.isTeacher && ((user as any).teachingSubjects || []).includes(r.subject_id))
    if (!isOwner && !isActualUser && !isManage) {
      permissionDenied.value = true
      ElMessage.error('只有发布者本人、实际作者或超级管理员可以编辑该美文')
      return
    }
    form.value = {
      title: r.title || '',
      author: r.author || user.current?.realName || '',
      source: r.source || '原创',
      recommendation: r.recommendation || '',
      category: r.category || '散文',
      tagsInput: Array.isArray(r.tags) ? r.tags.join(',') : (r.tags || ''),
    }
    content.value = r.content || ''
    cover.value = r.cover || ''
    images.value = Array.isArray(r.images) ? r.images : []
    subjectId.value = r.subject_id || 1
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '美文不存在或已被删除')
    permissionDenied.value = true
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  if (subjectOptions.value.length && !subjectOptions.value.find(s => s.id === subjectId.value)) {
    subjectId.value = subjectOptions.value[0].id
  }
  // 教师/超管代发：拉取学生列表
  if (user.isTeacher || user.isSuperAdmin) {
    try {
      const r: any = await api.users()
      allStudents.value = r.data || r
    } catch {}
  }
  if (isEdit.value) {
    await loadForEdit()
  } else if (restoreDraftFn()) {
    ElMessage.info('已恢复上次未发布的草稿')
  }
})

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

// 上传自定义封面：经 Worker 存储层落 B2，返回 /api/file/{id} 直链
const uploadingCover = ref(false)
async function onUploadCover(req: any) {
  const file = req?.file as File
  if (!file) return
  uploadingCover.value = true
  try {
    const r: any = await api.uploadImage(file)
    cover.value = r.url
    ElMessage.success('封面已上传')
  } catch (e: any) {
    ElMessage.error(e?.message || '封面上传失败')
  } finally {
    uploadingCover.value = false
  }
}

// 换一张美图：从 Bing 美图池随机取一张（尽量与当前不同），国内可访问、清晰美观
function randomCover() {
  if (BING_COVERS.length <= 1) return
  let next = bingCover(String(Date.now() + Math.random()))
  let guard = 0
  while (next === cover.value && guard++ < 12) next = bingCover(String(Date.now() + Math.random() + guard))
  cover.value = next
  ElMessage.success('已换一张美图')
}

async function submit() {
  if (!form.value.title || !content.value) { ElMessage.warning('请填写标题与正文'); return }
  submitting.value = true
  try {
    const payload: any = {
      title: form.value.title,
      content: content.value,
      author: form.value.author,
      source: form.value.source,
      recommendation: form.value.recommendation,
      subjectId: subjectId.value,
      cover: cover.value || zgCover(form.value.title || String(Date.now())),
      images: images.value,
      tags: form.value.tagsInput.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      category: form.value.category,
      classId: user.classIds[0] || 1,
    }
    if (isEdit.value && editId.value) {
      // 编辑模式：PATCH /api/articles/:id
      await api.updateArticle(editId.value, payload)
      ElMessage.success('美文已更新')
      clearDraft()
      router.push(`/article/${editId.value}`)
    } else {
      // 新建模式：POST /api/articles
      if ((user.isTeacher || user.isSuperAdmin) && proxyAuthor.value) {
        payload.actualUserId = proxyAuthor.value.id
      }
      const r: any = await api.createArticle(payload)
      if (r.status === 'approved') {
        ElMessage.success('发布成功，已公开展示')
      } else if (r.status === 'pending_student') {
        ElMessage.success(`已提交，等待学生「${proxyAuthor.value.real_name}」确认后进入超管审核`)
      } else {
        ElMessage.success('提交成功，待超级管理员审核通过后将公开')
      }
      clearDraft()
      router.push(`/subject/${data.subjectById(subjectId.value)?.slug}`)
    }
  } catch { /* http 拦截器已提示 */ } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div v-if="permissionDenied" class="glass-strong editor">
      <h1 class="ep-title"><ZgGlyph emoji="🔒" /> 无权编辑</h1>
      <p style="color: var(--zg-text-dim);">只有发布者本人、实际作者或超级管理员可以编辑该美文。</p>
      <el-button @click="router.push('/articles')">返回美文列表</el-button>
    </div>
    <div v-else v-loading="loading" class="glass-strong editor">
      <h1 class="ep-title">
        <ZgGlyph :emoji="isEdit ? '✏️' : '✍️'" /> {{ pageTitle }}
      </h1>
      <p class="ep-tip" v-if="!isEdit">
        选择对应学科，提交后进入待审核，由学科教师或管理员审核通过后公开展示。
        <span class="zg-autosave" v-if="draftSaved"><span class="dot"></span>草稿已自动保存</span>
      </p>
      <p class="ep-tip" v-else>
        <ZgGlyph emoji="🔁" /> 你正在编辑已发布或待审核的美文。修改后保存即可。
      </p>

      <div class="ep-row">
        <el-select v-model="subjectId" placeholder="选择学科" style="width:160px" :disabled="isEdit">
          <el-option v-for="s in subjectOptions" :key="s.id" :label="`${s.icon} ${s.name}`" :value="s.id" />
        </el-select>
        <el-input v-model="form.title" placeholder="文章标题" size="large" />
      </div>

      <div class="ep-row" v-if="!isEdit">
        <!-- 仅新建模式显示代发选择 -->
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

      <div class="ep-row">
        <el-input v-model="cover" :placeholder="isEdit ? '封面图URL（也可上传/换图）' : '封面图URL（留空自动生成 Bing 美图，也可上传）'" style="flex:1; min-width:240px" />
        <el-upload :http-request="onUploadCover" :show-file-list="false" accept="image/*" :disabled="uploadingCover">
          <el-button :loading="uploadingCover"><ZgGlyph emoji="📤" /> 上传封面</el-button>
        </el-upload>
        <el-button @click="randomCover">🖼️ 换一张美图</el-button>
        <el-button v-if="cover" text type="danger" size="small" @click="cover = ''">移除</el-button>
        <span v-if="cover" class="cover-preview" :style="{ backgroundImage: `url(${fileUrl(cover)})` }"></span>
      </div>

      <MarkdownEditor
        v-model="content"
        placeholder="支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF 嵌入..."
        :min-height="420"
      />

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ isEdit ? '保存修改' : '提交审核' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display:inline-block; margin:16px 0 0; color:var(--zg-text-dim); cursor:pointer; }
.back:hover { color: var(--zg-primary); }
.editor { padding:32px; }
.ep-title { font-size:24px; font-weight:800; margin-bottom: 12px; }
.ep-tip { color:var(--zg-text-dim); font-size:13px; margin:0 0 20px; }
.ep-row { display:flex; gap:12px; margin-bottom:12px; flex-wrap: wrap; align-items: center; }
.cover-preview { width: 80px; height: 50px; background-size: cover; background-position: center; border-radius: 6px; border: 1px solid var(--zg-border); }
.ep-foot { display:flex; justify-content:flex-end; gap:12px; margin-top:20px; }
@media (max-width:720px){ .ep-row{flex-direction:column;} .editor{padding:20px;} }

.author-field { flex:1; min-width:280px; }
.af-current { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; background:rgba(var(--zg-primary-rgb),.08); border:1px dashed rgba(var(--zg-primary-rgb),.3); border-radius:10px; cursor:pointer; font-size:14px; }
.af-current:hover { background:rgba(var(--zg-primary-rgb),.14); }
.af-proxy b { color:var(--zg-primary); font-weight:700; }
.af-self { color:var(--zg-text-dim); }
.af-toggle { color:var(--zg-primary); font-size:12px; }
.af-picker { margin-top:10px; padding:16px; border-radius:14px; }
.afp-title { font-size:13px; font-weight:600; margin-bottom:10px; color:var(--zg-primary); }
.afp-list { max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:4px; margin:10px 0; }
.afp-item { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
.afp-item:hover { background:rgba(var(--zg-primary-rgb),.12); }
.afp-name { font-weight:600; }
.afp-uname { color:var(--zg-text-dim); font-size:12px; }
.afp-actions { display:flex; justify-content:space-between; align-items:center; }
</style>
