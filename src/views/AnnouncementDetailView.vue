<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const ann = ref<any>(null)
const loading = ref(true)

onMounted(async () => {
  try { ann.value = await api.page(Number(route.params.id)) } finally { loading.value = false }
})

function scopeLabel(a: any) {
  if (a.scope === 'site') return '全站公告'
  const cn = data.classById(a.class_id)?.name || '班级'
  return `班级公告 · ${cn}`
}
function scopeType(a: any) { return a.scope === 'site' ? 'success' : 'warning' }

async function del() {
  try {
    await ElMessageBox.confirm('确定删除这条公告？', '删除', { type: 'warning' })
    await api.deletePage(ann.value.id)
    ElMessage.success('已删除')
    router.push('/announcements')
  } catch { /* */ }
}
function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回公告列表</div>
    <article v-if="ann" class="glass-strong detail">
      <div class="d-head">
        <el-tag :type="scopeType(ann)" size="large">{{ scopeLabel(ann) }}</el-tag>
        <div>
          <el-button v-if="user.isSuperAdmin" type="primary" plain size="small" @click="router.push(`/announcements/${ann.id}/edit`)" style="margin-right:8px">
            <ZgGlyph emoji="✏️" /> 编辑公告
          </el-button>
          <el-button v-if="user.isSuperAdmin || ann.author_id === user.current?.id" text type="danger" size="small" @click="del"><ZgGlyph emoji="🗑" /> 删除</el-button>
        </div>
      </div>
      <h1 class="d-title">{{ ann.title }}</h1>
      <div class="d-meta">
        <span><ZgGlyph emoji="👤" /> {{ ann.author_name }}</span>
        <span><ZgGlyph emoji="👁" /> {{ ann.views }} 次阅读</span>
        <span><ZgGlyph emoji="📅" /> {{ ann.created_at?.slice(0, 16) }}</span>
      </div>
      <div class="d-content markdown-body" v-html="md(ann.content)"></div>

      <div v-if="ann.attachments?.length" class="d-attachments">
        <div class="da-title"><ZgGlyph emoji="📎" /> 附件下载（{{ ann.attachments.length }}）</div>
        <a v-for="(a, i) in ann.attachments" :key="i" :href="a.url" target="_blank" class="da-item">
          <ZgGlyph emoji="📄" /> {{ a.name }} <span v-if="a.size">({{ fmtSize(a.size) }})</span> <ZgGlyph emoji="⬇" />
        </a>
      </div>
    </article>
    <ZgState v-else-if="!loading" type="404" title="公告不存在或无权查看" desc="这条公告可能已被删除，或你没有查看权限。" />
  </div>
</template>

<style scoped>
.back { padding: 12px 0; color: var(--zg-text-dim); cursor: pointer; width: fit-content; font-size: 14px; }
.back:hover { color: var(--zg-primary); }
.detail { padding: 32px; margin-top: 8px; }
.d-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.d-title { font-size: 26px; font-weight: 800; line-height: 1.3; }
.d-meta { display: flex; gap: 16px; color: var(--zg-text-dim); font-size: 13px; margin: 12px 0 24px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px dashed rgba(var(--zg-primary-rgb),.15); }
.d-content { font-size: 15px; line-height: 1.9; color: var(--zg-text); }
.d-content :deep(h2) { font-size: 22px; margin: 24px 0 12px; }
.d-content :deep(h3) { font-size: 18px; margin: 20px 0 10px; }
.d-content :deep(ul), .d-content :deep(ol) { padding-left: 24px; margin: 10px 0; }
.d-content :deep(li) { margin: 6px 0; }
.d-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }
.d-content :deep(a) { color: var(--zg-primary); }
.d-attachments { margin-top: 32px; padding-top: 20px; border-top: 1px dashed rgba(var(--zg-primary-rgb),.15); }
.da-title { font-weight: 700; margin-bottom: 12px; }
.da-item { display: block; padding: 12px 16px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 10px; margin-bottom: 8px; color: var(--zg-text); text-decoration: none; font-size: 14px; transition: all .2s; }
.da-item:hover { background: rgba(var(--zg-primary-rgb),.15); }
@media (max-width: 768px) { .detail { padding: 20px; } .d-title { font-size: 22px; } }
</style>
