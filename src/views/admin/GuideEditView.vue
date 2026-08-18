<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

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
    // 重新加载以确保显示最新内容
    const r: any = await api.guide()
    if (r) { form.value.title = r.title; form.value.content = r.content }
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '保存失败，请重试') } finally { submitting.value = false }
}

const TAGS = {
  h2: '<h2>小标题</h2>',
  h3: '<h3>三级标题</h3>',
  b: '<b>加粗</b>',
  list: '<ul><li>列表项</li></ul>',
  img: '<img src="图片地址" style="max-width:100%;border-radius:12px;" />',
  link: '<a href="链接" target="_blank">文字</a>',
}
function insertTag(tag: string) {
  form.value.content += tag
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
      <div class="toolbar">
        <button @click="insertTag(TAGS.h2)">H2</button>
        <button @click="insertTag(TAGS.h3)">H3</button>
        <button @click="insertTag(TAGS.b)"><b>B</b></button>
        <button @click="insertTag(TAGS.list)">列表</button>
        <button @click="insertTag(TAGS.img)">图片</button>
        <button @click="insertTag(TAGS.link)">链接</button>
      </div>
      <el-input v-model="form.content" type="textarea" :rows="20" placeholder="支持 HTML，可输入标题、列表、图片、链接等" />
      <div class="tip">支持 HTML 标签，例如 &lt;h2&gt;、&lt;ul&gt;、&lt;img&gt;、&lt;a&gt; 等</div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.edit-page { padding: 20px; }
.toolbar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.toolbar button { background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.15); color: var(--zg-text); padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.toolbar button:hover { background: rgba(245,158,11,.2); }
.tip { font-size: 12px; color: var(--zg-text-dim); margin-top: 10px; }
@media (max-width: 768px) { .edit-page { padding: 14px; } }
</style>
