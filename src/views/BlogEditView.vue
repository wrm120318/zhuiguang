<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()
const form = ref({ title: '', content: '', cover: '' })
const images = ref<string[]>([])
const attachments = ref<any[]>([])
const submitting = ref(false)

const TAGS = {
  h2: '## 小标题\n\n',
  h3: '### 三级标题\n\n',
  b: '**加粗文字**',
  list: '- 列表项\n- 列表项\n',
  quote: '> 引用文字\n\n',
  code: '```\n代码块\n```\n\n',
  link: '[文字](链接)',
}
function insertTag(tag: string) {
  form.value.content += tag
}

async function onUploadImage(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadImage(file)
    images.value.push(r.url)
    form.value.content += `\n![图片](${r.url})\n`
    ElMessage.success('图片已插入')
  } catch (e: any) {
    console.error('[图片上传失败]', e)
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
    console.error('[附件上传失败]', e)
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
    console.error('[封面上传失败]', e)
    ElMessage.error(e?.message || '封面上传失败')
  }
}

function removeAttach(idx: number) { attachments.value.splice(idx, 1) }
function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }

async function submit() {
  if (!form.value.title || !form.value.content) { ElMessage.warning('请填写标题和正文'); return }
  submitting.value = true
  try {
    await api.createPage({
      ptype: 'blog', scope: 'site', title: form.value.title, content: form.value.content,
      cover: form.value.cover, images: images.value, attachments: attachments.value,
    })
    ElMessage.success('博客发布成功')
    router.push('/blog')
  } catch { /* */ } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()">← 返回</div>
    <div class="glass-strong editor">
      <h1 class="ep-title">✍️ 写博客</h1>
      <el-input v-model="form.title" placeholder="博客标题" size="large" style="margin-bottom:12px" />

      <div class="cover-row">
        <el-upload :http-request="onUploadCover" :show-file-list="false" accept="image/*">
          <el-button size="small">📷 设置封面图</el-button>
        </el-upload>
        <div v-if="form.cover" class="cover-preview" :style="{ backgroundImage: `url(${form.cover})` }"></div>
        <el-button v-if="form.cover" text type="danger" size="small" @click="form.cover = ''">移除封面</el-button>
      </div>

      <div class="toolbar">
        <button @click="insertTag(TAGS.h2)">H2</button>
        <button @click="insertTag(TAGS.h3)">H3</button>
        <button @click="insertTag(TAGS.b)"><b>B</b></button>
        <button @click="insertTag(TAGS.list)">列表</button>
        <button @click="insertTag(TAGS.quote)">引用</button>
        <button @click="insertTag(TAGS.code)">代码</button>
        <button @click="insertTag(TAGS.link)">链接</button>
        <el-upload :http-request="onUploadImage" :show-file-list="false" accept="image/*" class="tb-upload">
          <button>🖼 插入图片</button>
        </el-upload>
        <el-upload :http-request="onUploadFile" :show-file-list="false" multiple class="tb-upload">
          <button>📎 添加附件</button>
        </el-upload>
      </div>
      <el-input v-model="form.content" type="textarea" :rows="18" placeholder="支持 Markdown 语法：## 标题、**加粗**、- 列表、> 引用、![图片](url)、[链接](url)，也可上传图片和附件" />

      <div v-if="attachments.length" class="att-list">
        <div class="att-title">📎 附件（{{ attachments.length }}）</div>
        <div v-for="(a, i) in attachments" :key="i" class="att-item">
          <span>📄 {{ a.name }} ({{ fmtSize(a.size) }})</span>
          <el-button text type="danger" size="small" @click="removeAttach(i)">移除</el-button>
        </div>
      </div>

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">发布博客</el-button>
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
.toolbar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
.toolbar button { background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.15); color: var(--zg-text); padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.toolbar button:hover { background: rgba(245,158,11,.2); }
.tb-upload { display: inline-block; }
.att-list { margin-top: 16px; }
.att-title { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.att-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(245,158,11,.05); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.ep-foot { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 768px) { .editor { padding: 16px; } }
</style>
