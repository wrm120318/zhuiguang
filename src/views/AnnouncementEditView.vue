<script setup lang="ts">
// ===== v4.2.2 公告编辑器 =====
// 统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF 嵌入）
// 同时支持新建（/announcements/new）和编辑（/announcements/:id/edit）
// 编辑权限：仅超管可编辑所有公告；教师/超管可发布班级公告

import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const data = useDataStore()

const editId = computed<number | null>(() => {
  const p = route.params.id
  if (p) {
    const n = Number(Array.isArray(p) ? p[0] : p)
    if (n) return n
  }
  return null
})
const isEdit = computed(() => editId.value !== null)
const pageTitle = computed(() => isEdit.value ? '✏️ 编辑公告' : '📢 发布公告')

const form = ref({
  title: '', content: '', scope: 'site' as 'site' | 'class', classId: null as number | null,
  pinned: false, pinnedScope: 'site' as 'site' | 'class'
})
const attachments = ref<any[]>([])
const submitting = ref(false)
const loading = ref(false)
const permissionDenied = ref(false)

const canSite = computed(() => user.isSuperAdmin)
const canClass = computed(() => user.isSuperAdmin || user.isTeacher)

function onScopeChange() {
  if (form.value.scope === 'site') { form.value.classId = null; form.value.pinnedScope = 'site' }
  else if (!form.value.classId && data.classes.length) { form.value.classId = data.classes[0].id }
}

async function onUploadImage(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadImage(file)
    attachments.value.push({ url: r.url, name: file.name, size: 0, type: 'image' })
    ElMessage.success('图片已添加')
  } catch (e: any) {
    ElMessage.error(e?.message || '图片上传失败')
  }
}

async function onUploadFile(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadFile(file)
    attachments.value.push({ url: r.url, name: r.fileName, size: r.fileSize, type: r.fileType })
    ElMessage.success('附件已添加')
  } catch (e: any) {
    ElMessage.error(e?.message || '附件上传失败')
  }
}

function removeAttach(idx: number) { attachments.value.splice(idx, 1) }
function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }

async function loadForEdit() {
  if (!editId.value) return
  loading.value = true
  try {
    const r: any = await api.page(editId.value)
    // 权限：仅超管可编辑公告
    if (!user.isSuperAdmin) {
      permissionDenied.value = true
      ElMessage.error('只有超级管理员可以编辑公告')
      return
    }
    form.value = {
      title: r.title || '',
      content: r.content || '',
      scope: r.scope || 'site',
      classId: r.class_id || null,
      pinned: r.pinned || false,
      pinnedScope: r.pinned_scope || 'site',
    }
    try {
      attachments.value = typeof r.attachments === 'string' ? JSON.parse(r.attachments) : (r.attachments || [])
    } catch { attachments.value = [] }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '公告不存在或已被删除')
    permissionDenied.value = true
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  if (isEdit.value) {
    await loadForEdit()
  }
})

async function submit() {
  if (!form.value.title || !form.value.content) { ElMessage.warning('请填写标题和正文'); return }
  if (form.value.scope === 'class' && !form.value.classId) { ElMessage.warning('请选择班级'); return }
  submitting.value = true
  try {
    const payload: any = {
      ptype: 'announcement',
      scope: form.value.scope,
      classId: form.value.classId,
      title: form.value.title,
      content: form.value.content,
      attachments: attachments.value,
      pinned: form.value.pinned,
      pinnedScope: form.value.pinned ? form.value.pinnedScope : 'none',
    }
    if (isEdit.value && editId.value) {
      // 编辑模式：PATCH /api/pages/:id
      await api.updatePage(editId.value, payload)
      ElMessage.success('公告已更新')
      router.push(`/announcements/${editId.value}`)
    } else {
      // 新建模式：POST /api/pages
      await api.createPage(payload)
      ElMessage.success('公告已发布')
      router.push('/announcements')
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '操作失败')
  } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div v-if="permissionDenied" class="glass-strong editor">
      <h1 class="ep-title"><ZgGlyph emoji="🔒" /> 无权编辑</h1>
      <p style="color: var(--zg-text-dim);">只有超级管理员可以编辑公告。</p>
      <el-button @click="router.push('/announcements')">返回公告列表</el-button>
    </div>
    <div v-else v-loading="loading" class="glass-strong editor">
      <h1 class="ep-title">
        <ZgGlyph :emoji="isEdit ? '✏️' : '📢'" /> {{ pageTitle }}
      </h1>

      <div class="scope-row">
        <span class="sr-label">公告类型：</span>
        <el-radio-group v-model="form.scope" @change="onScopeChange">
          <el-radio v-if="canSite" value="site"><ZgGlyph emoji="🌐" /> 全站公告（所有人可见）</el-radio>
          <el-radio v-if="canClass" value="class"><ZgGlyph emoji="🏫" /> 班级公告（仅本班学生可见）</el-radio>
        </el-radio-group>
      </div>

      <div v-if="form.scope === 'class'" class="class-row">
        <span class="sr-label">选择班级：</span>
        <el-select v-model="form.classId" placeholder="选择班级" style="width:240px">
          <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>

      <div v-if="user.isSuperAdmin" class="pin-row">
        <span class="sr-label">置顶设置：</span>
        <el-checkbox v-model="form.pinned"><ZgGlyph emoji="📌" /> 置顶此公告</el-checkbox>
        <el-select v-if="form.pinned" v-model="form.pinnedScope" size="small" style="width:180px; margin-left:12px">
          <el-option value="site"><ZgGlyph emoji="🌐" /> 全站置顶（所有人顶部）</el-option>
          <el-option value="class"><ZgGlyph emoji="🏫" /> 班级置顶（仅对应班级）</el-option>
        </el-select>
      </div>

      <el-input v-model="form.title" placeholder="公告标题" size="large" style="margin:12px 0" />

      <MarkdownEditor
        v-model="form.content"
        placeholder="支持 Markdown + HTML 子集 + KaTeX + 视频/PDF 嵌入..."
        :min-height="380"
      />

      <div class="upload-row">
        <el-upload :http-request="onUploadImage" :show-file-list="false" accept="image/*">
          <el-button size="small"><ZgGlyph emoji="🖼" /> 添加图片</el-button>
        </el-upload>
        <el-upload :http-request="onUploadFile" :show-file-list="false" multiple>
          <el-button size="small"><ZgGlyph emoji="📎" /> 添加附件</el-button>
        </el-upload>
      </div>

      <div v-if="attachments.length" class="att-list">
        <div class="att-title"><ZgGlyph emoji="📎" /> 附件（{{ attachments.length }}）</div>
        <div v-for="(a, i) in attachments" :key="i" class="att-item">
          <span><ZgGlyph emoji="📄" /> {{ a.name }} ({{ fmtSize(a.size) }})</span>
          <el-button text type="danger" size="small" @click="removeAttach(i)">移除</el-button>
        </div>
      </div>

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">
          {{ isEdit ? '保存修改' : '发布公告' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { padding: 12px 0; color: var(--zg-text-dim); cursor: pointer; width: fit-content; font-size: 14px; }
.back:hover { color: var(--zg-primary); }
.editor { padding: 24px; }
.ep-title { font-size: 24px; font-weight: 800; margin-bottom: 16px; }
.scope-row, .class-row, .pin-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.sr-label { font-weight: 600; font-size: 14px; }
.upload-row { display: flex; gap: 8px; margin-top: 12px; }
.att-list { margin-top: 16px; }
.att-title { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.att-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(var(--zg-primary-rgb),.05); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.ep-foot { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 768px) { .editor { padding: 16px; } }
</style>
