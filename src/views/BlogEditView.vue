<script setup lang="ts">
// ===== v4.4.16 博客编辑器（论坛化）=====
// 统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF 嵌入）
// 复用论坛编辑器的能力：话题标签多选、推荐语、草稿自动保存
// 原博客封面设置逻辑保留；编辑权限：仅作者本人或超管

import { ref, onMounted, computed, nextTick, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import ZgGlyph from '@/components/ZgGlyph.vue'
import { useAutoSave } from '@/composables/useAutoSave'
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

const form = ref({ title: '', content: '', cover: '', recommendation: '' })
const images = ref<string[]>([])
const attachments = ref<any[]>([])
const topics = ref<any[]>([])
const topicIds = ref<number[]>([])
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
function toggleTopic(id: number) {
  const i = topicIds.value.indexOf(id)
  if (i >= 0) topicIds.value.splice(i, 1)
  else if (topicIds.value.length < 3) topicIds.value.push(id)
  else ElMessage.warning('最多选 3 个话题')
}

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
    form.value = { title: r.title || '', content: r.content || '', cover: r.cover || '', recommendation: r.recommendation || '' }
    images.value = Array.isArray(r.images) ? r.images : []
    const rawTids = typeof r.topic_ids === 'string'
      ? (() => { try { return JSON.parse(r.topic_ids || '[]') } catch { return [] } })()
      : (r.topic_ids || [])
    topicIds.value = rawTids.map(Number).filter(Boolean)
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

// ===== v4.4.16 草稿自动保存（复用论坛编辑器逻辑）=====
const draftKey = computed(() => {
  const uid = user.current?.id || 0
  return `zhuiguang:blog:draft:${uid}:${isEdit.value ? 'edit:' + editId.value : 'new'}`
})
const { lastSaved, hasDraft, restoreDraft, clear, saveNow } = useAutoSave({
  key: draftKey.value,
  sources: () => [form, topicIds],
  debounce: 1500,
  snapshot: () => ({
    title: form.value.title,
    content: form.value.content,
    cover: form.value.cover,
    recommendation: form.value.recommendation,
    topicIds: [...topicIds.value],
  }),
  restore: (d: any) => {
    form.value.title = d.title || ''
    form.value.content = d.content || ''
    form.value.cover = d.cover || ''
    form.value.recommendation = d.recommendation || ''
    topicIds.value = Array.isArray(d.topicIds) ? d.topicIds : []
  },
})
const restored = ref(false)
const lastSavedAt = computed(() => lastSaved.value)
const draftTimeText = computed(() => {
  if (!lastSaved.value) return ''
  const diff = Math.max(1, Math.round((Date.now() - lastSaved.value) / 1000))
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`
  return new Date(lastSaved.value).toLocaleString('zh-CN')
})
function tryRestoreDraft() {
  if (isEdit.value) return // 编辑已有博客：始终以原帖内容为准，不自动恢复本地草稿
  const ok = restoreDraft()
  if (ok) { restored.value = true; ElMessage.success('已恢复本地草稿') }
}
function clearDraftNow() {
  try { ElMessageBox.confirm('确认清除本地草稿？此操作不可恢复。', '清除草稿', { type: 'warning' }) } catch { return }
  clear()
  restored.value = false
  ElMessage.success('已清除草稿')
}

onMounted(async () => {
  try { topics.value = (await api.blogTopics()) as any } catch { /* 忽略话题拉取失败 */ }
  await loadForEdit()
  if (!permissionDenied.value) nextTick(() => tryRestoreDraft())
})
onBeforeUnmount(() => { try { saveNow() } catch { /* */ } })

async function submit() {
  if (!form.value.title.trim() || !form.value.content.trim()) { ElMessage.warning('请填写标题和正文'); return }
  submitting.value = true
  try {
    if (isEdit.value && editId.value) {
      await api.updatePage(editId.value, {
        title: form.value.title,
        content: form.value.content,
        cover: form.value.cover,
        images: images.value,
        attachments: attachments.value,
        topicIds: topicIds.value,
        recommendation: form.value.recommendation,
      })
      ElMessage.success('博客已更新')
      clear()
      router.push(`/blog/${editId.value}`)
    } else {
      const r: any = await api.createPage({
        ptype: 'blog', scope: 'site', title: form.value.title, content: form.value.content,
        cover: form.value.cover, images: images.value, attachments: attachments.value,
        topicIds: topicIds.value, recommendation: form.value.recommendation,
      })
      ElMessage.success('博客发布成功')
      clear()
      router.push(`/blog/${r.id}`)
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '操作失败')
  } finally {
    submitting.value = false
  }
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
      <div class="ep-top">
        <h1 class="ep-title">
          <ZgGlyph :emoji="isEdit ? '✏️' : '✍️'" /> {{ pageTitle }}
        </h1>
        <div class="ep-top-meta">
          <span v-if="lastSavedAt" class="ep-draft"><ZgGlyph emoji="💾" /> 草稿已自动保存 · {{ draftTimeText }}</span>
          <span v-else-if="hasDraft && restored" class="ep-draft warn"><ZgGlyph emoji="↩" /> 已恢复本地草稿</span>
        </div>
      </div>

      <el-input v-model="form.title" placeholder="博客标题（一句话说清楚你想分享什么）" size="large" style="margin-bottom:12px" />

      <div class="ep-row two">
        <!-- 【原逻辑保留】封面设置 -->
        <div class="cover-col">
          <div class="cover-label"><ZgGlyph emoji="🖼" /> 封面图（可选）</div>
          <el-upload :http-request="onUploadCover" :show-file-list="false" accept="image/*">
            <el-button size="small"><ZgGlyph emoji="📷" /> {{ form.cover ? '更换封面图' : '设置封面图' }}</el-button>
          </el-upload>
          <div v-if="form.cover" class="cover-preview" :style="{ backgroundImage: `url(${fileUrl(form.cover)})` }"></div>
          <el-button v-if="form.cover" text type="danger" size="small" @click="form.cover = ''">移除封面</el-button>
        </div>
        <!-- 话题标签（论坛化新增）-->
        <div class="topic-col">
          <div class="cover-label"><ZgGlyph emoji="🏷️" /> 话题标签（最多 3 个）</div>
          <div v-if="!topics.length" class="topic-empty">暂无话题（仅超管可创建）</div>
          <div v-else class="topic-mini">
            <span
              v-for="t in topics"
              :key="t.id"
              class="topic-chip"
              :class="{ on: topicIds.includes(t.id) }"
              :style="{ '--chip': t.color }"
              @click="toggleTopic(t.id)"
            >{{ t.name }}</span>
          </div>
          <el-input
            v-model="form.recommendation"
            placeholder="推荐语 / 摘要（一句话介绍，可空）"
            style="margin-top:10px"
          />
        </div>
      </div>

      <MarkdownEditor
        v-model="form.content"
        placeholder="支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF 嵌入..."
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
        <el-button v-if="hasDraft" @click="clearDraftNow" plain><ZgGlyph emoji="🧹" /> 清除草稿</el-button>
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
.ep-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px; }
.ep-title { font-size: 24px; font-weight: 800; margin: 0; display: flex; align-items: center; gap: 8px; }
.ep-top-meta { font-size: 12px; color: var(--zg-text-sub); }
.ep-draft { background: rgba(var(--zg-primary-rgb), 0.08); color: var(--zg-primary); padding: 4px 10px; border-radius: 999px; }
.ep-draft.warn { background: rgba(245, 158, 11, 0.12); color: #B45309; }
.ep-row { margin-bottom: 12px; }
.ep-row.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.cover-label { font-size: 13px; color: var(--zg-text-sub); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.cover-preview { width: 100%; height: 90px; background-size: cover; background-position: center; border-radius: 8px; margin-top: 8px; }
.topic-empty { font-size: 12px; color: var(--zg-text-sub); padding: 8px 0; }
.topic-mini { display: flex; flex-wrap: wrap; gap: 6px; }
.topic-chip { padding: 4px 10px; font-size: 12px; border-radius: 999px; background: rgba(148, 163, 184, 0.15); color: var(--zg-text); cursor: pointer; border: 1px solid transparent; }
.topic-chip.on { background: var(--chip, var(--zg-primary)); color: #fff; border-color: var(--chip, var(--zg-primary)); }
.upload-row { display: flex; gap: 8px; margin-top: 12px; }
.att-list { margin-top: 16px; }
.att-title { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.att-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(var(--zg-primary-rgb),.05); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.ep-foot { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 768px) { .editor { padding: 16px; } .ep-row.two { grid-template-columns: 1fr; } }
</style>
