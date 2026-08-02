<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { renderMarkdown as md } from '@/utils/markdown'

const router = useRouter()
const user = useUserStore()
const guide = ref<any>(null)
const loading = ref(true)

onMounted(async () => {
  try { guide.value = await api.guide() } finally { loading.value = false }
})
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div v-if="guide" class="glass-strong guide-card">
      <h1 class="g-title">{{ guide.title }}</h1>
      <div class="g-meta" v-if="guide.updated_at || guide.author_name">最后更新：{{ guide.updated_at || guide.created_at?.slice(0, 10) }} · 作者：{{ guide.author_name }}</div>
      <div class="g-content" v-html="md(guide.content)"></div>
      <div class="g-foot">
        <el-button v-if="user.isSuperAdmin" type="primary" round @click="router.push('/admin/guide')">✏️ 编辑此说明</el-button>
      </div>
    </div>
    <el-empty v-else-if="!loading" description="暂无网站说明">
      <el-button v-if="user.isSuperAdmin" type="primary" @click="router.push('/admin/guide')">前往编辑</el-button>
    </el-empty>
  </div>
</template>

<style scoped>
.guide-card { padding: 32px; margin-top: 20px; }
.g-title { font-size: 28px; font-weight: 800; }
.g-meta { color: var(--zg-text-dim); font-size: 13px; margin: 8px 0 24px; }
.g-content { font-size: 15px; line-height: 1.9; color: var(--zg-text); }
.g-content :deep(h2) { font-size: 22px; margin-top: 28px; margin-bottom: 14px; }
.g-content :deep(h3) { font-size: 18px; margin-top: 22px; margin-bottom: 10px; }
.g-content :deep(ul), .g-content :deep(ol) { padding-left: 24px; margin: 10px 0; }
.g-content :deep(li) { margin: 6px 0; }
.g-content :deep(b) { font-weight: 700; }
.g-content :deep(a) { color: var(--zg-primary); }
.g-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }
.g-foot { margin-top: 32px; padding-top: 20px; border-top: 1px dashed rgba(245,158,11,.15); }
@media (max-width: 768px) { .guide-card { padding: 20px; } .g-title { font-size: 22px; } }
</style>
