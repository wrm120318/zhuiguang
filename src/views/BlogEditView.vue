<script setup lang="ts">
// ===== v4.2.2 博客编辑器 =====
// 统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF 嵌入）
// 编辑权限：仅作者本人或超管

import { ref, onMounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { fileUrl } from '@/utils/helpers'

const router = useRouter()
const route = useRoute()
const user = useUserStore()

const editId = computed<number | null>(() => {
  const p = route.params.id
  if (p) {
    const n = Number(Array.isArray(p) ? p[0] : p)
    if (n) return n
  }
  const q = route.query.id
  if (q) {
    const n = Number(Array.isArray(q) ? q[0] : q)
    if (n) return n
  }
  return null
})
const isEdit = computed(() => editId.value !== null)
const pageTitle = computed(() => isEdit.value ? '编辑博客' : '写博客')

const form = ref({ title: '', content: '', cover: '' })
const images = ref<string[]>([])
const attachments = ref<any[]>([])
const submitting = ref(false)
const loading = ref(false)
const permissionDenied = ref(false)

async function onUploadImage(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadImage(file)
    images.value.push(r.url)
    ElMessage.success('图片已上传')
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

async function onUploadCover(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadImage(file)
    form.value.cover = r.url
    ElMessage.success('封面已设置')
  } catch (e: any) {
    ElMessage.error(e?.message || '封面上传失败')
  }
}

function removeAttach(idx: number) { attachments.value.splice(idx, 1) }
function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }

async function loadForEdit() {
  if (!editId.value) return
  loading.value = true
  try {
    const r: any = await api.page(editId.value)
    const isOwner = r.author_id === user.current?.id
    if (!isOwner && !user.isSuperAdmin) {
      permissionDenied.value = true
      ElMessage.error('只有作者本人或超级管理员可以编辑该博客')
      return
    }
    form.value = { title: r.title || '', content: r.content || '', cover: r.cover || '' }
    images.value = Array.isArray(r.images) ? r.images : []
    try {
      attachments.value = typeof r.attachments === 'string' ? JSON.parse(r.attachments) : (r.attachments || [])
    } catch { attachments.value = [] }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '博客不存在或已被删除')
    permissionDenied.value = true
  } finally {
    loading.value = false
  }
}

onMounted(loadForEdit)

async function submit() {
  if (!form.value.title || !form.value.content) { ElMessage.warning('请填写标题和正文'); return }
  submitting.value = true
  try {
    if (isEdit.value && editId.value) {
      await api.updatePage(editId.value, {
        title: form.value.title,
        content: form.value.content,
        cover: form.value.cover,
        images: images.value,
        attachments: attachments.value,
      })
      ElMessage.success('博客已更新')
      router.push(`/blog/${editId.value}`)
    } else {
      const r: any = await api.createPage({
        ptype: 'blog', scope: 'site', title: form.value.title, content: form.value.content,
        cover: form.value.cover, images: images.value, attachments: attachments.value,
      })
      ElMessage.success('博客发布成功')
      router.push(`/blog/${r.id}`)
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
      <p style="color: var(--zg-text-dim);">只有这篇博客的作者本人或超级管理员才能编辑。</p>
      <el-button @click="router.push('/blog')">返回博客列表</el-button>
    </div>
    <div v-else v-loading="loading" class="glass-strong editor">
      <h1 class="ep-title">
        <ZgGlyph :emoji="isEdit ? '✏️' : '✍️'" /> {{ pageTitle }}
      </h1>
      <el-input v-model="form.title" placeholder="博客标题" size="large" style="margin-bottom:12px" />

      <div class="cover-row">
        <el-upload :http-request="onUploadCover" :show-file-list="false" accept="image/*">
          <el-button size="small"><ZgGlyph emoji="📷" /> {{ form.cover ? '更换封面图' : '设置封面图' }}</el-button>
        </el-upload>
        <div v-if="form.cover" class="cover-preview" :style="{ backgroundImage: `url(${fileUrl(form.cover)})` }"></div>
        <el-button v-if="form.cover" text type="danger" size="small" @click="form.cover = ''">移除封面</el-button>
      </div>

      <MarkdownEditor
        v-model="form.content"
        placeholder="支持 Markdown + HTML 子集 + KaTeX + 视频/PDF 嵌入..."
        :min-height="420"
      />

      <div class="upload-row">
        <el-upload :http-request="onUploadImage" :show-file-list="false" accept="image/*">
          <el-button size="small"><ZgGlyph emoji="🖼" /> 插入图片</el-button>
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
          {{ isEdit ? '保存修改' : '发布博客' }}
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
.cover-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.cover-preview { width: 80px; height: 50px; background-size: cover; background-position: center; border-radius: 6px; }
.upload-row { display: flex; gap: 8px; margin-top: 12px; }
.att-list { margin-top: 16px; }
.att-title { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.att-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(var(--zg-primary-rgb),.05); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.ep-foot { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 768px) { .editor { padding: 16px; } }
</style>
