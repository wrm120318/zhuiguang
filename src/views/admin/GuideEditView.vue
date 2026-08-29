<script setup lang="ts">
// ===== v4.2.2 网站说明编辑器 =====
// 统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF 嵌入）

import { ref, onMounted } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import MarkdownEditor from '@/components/MarkdownEditor.vue'

const form = ref({ title: '', content: '' })
const submitting = ref(false)
const loading = ref(true)

onMounted(async () => {
  try {
    const r: any = await api.guide()
    if (r) { form.value.title = r.title; form.value.content = r.content }
  } finally { loading.value = false }
})

async function save() {
  if (!form.value.title || !form.value.content) { ElMessage.warning('请填写标题和正文'); return }
  submitting.value = true
  try {
    await api.saveGuide({ title: form.value.title, content: form.value.content })
    ElMessage.success('网站说明已保存')
    const r: any = await api.guide()
    if (r) { form.value.title = r.title; form.value.content = r.content }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '保存失败，请重试')
  } finally { submitting.value = false }
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <h1 class="dh-title"><ZgGlyph emoji="📖" /> 网站说明编辑</h1>
      <el-button type="primary" :loading="submitting" @click="save">保存</el-button>
    </div>
    <div class="glass edit-page">
      <el-input v-model="form.title" placeholder="标题" style="margin-bottom:12px" />
      <MarkdownEditor
        v-model="form.content"
        placeholder="支持 Markdown + HTML 子集 + KaTeX + 视频/PDF 嵌入..."
        :min-height="500"
      />
      <div class="tip">支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF/B站嵌入 + @提及 + ==高亮==</div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.edit-page { padding: 20px; }
.tip { font-size: 12px; color: var(--zg-text-dim); margin-top: 10px; }
@media (max-width: 768px) { .edit-page { padding: 14px; } }
</style>
