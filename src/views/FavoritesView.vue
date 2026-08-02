<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { useDataStore } from '@/store/data'
import { ElMessage } from 'element-plus'

const router = useRouter()
const data = useDataStore()
const favorites = ref<any[]>([])
const articles = ref<any[]>([])
const resources = ref<any[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    favorites.value = (await api.favorites()) as any
    const artIds = favorites.value.filter(f => f.target_type === 'fav_article').map(f => f.target_id)
    const resIds = favorites.value.filter(f => f.target_type === 'fav_resource').map(f => f.target_id)
    if (artIds.length) {
      const all = (await api.articles({ limit: 100 })) as any
      articles.value = all.filter((a: any) => artIds.includes(a.id))
    }
    if (resIds.length) {
      // Fetch resources from subjects
      for (const s of data.subjects) {
        const list = (await api.resources(s.id)) as any
        const matched = list.filter((r: any) => resIds.includes(r.id))
        resources.value.push(...matched)
      }
    }
  } finally { loading.value = false }
}
onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  await load()
})

async function removeFav(type: string, id: number) {
  await api.toggleFavorite(type, id)
  if (type === 'article') articles.value = articles.value.filter(a => a.id !== id)
  else resources.value = resources.value.filter(r => r.id !== id)
  ElMessage.success('已取消收藏')
}
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="fav-head glass-strong zg-slide-up">
      <h1 class="zg-grad-text">⭐ 我的收藏</h1>
      <p class="fav-desc">收藏的美文与资料，随时回看。</p>
    </div>

    <div v-if="articles.length" class="fav-section">
      <div class="section-title">✍️ 美文 ({{ articles.length }})</div>
      <div class="fav-grid">
        <div v-for="a in articles" :key="a.id" class="fav-card glass zg-card">
          <div class="fc-body" @click="router.push(`/article/${a.id}`)">
            <div class="fc-title">{{ a.title }}</div>
            <div class="fc-meta">{{ a.author }} · {{ a.created_at?.slice(0,10) }}</div>
          </div>
          <el-button text size="small" @click="removeFav('article', a.id)">✕</el-button>
        </div>
      </div>
    </div>

    <div v-if="resources.length" class="fav-section">
      <div class="section-title">📦 资料 ({{ resources.length }})</div>
      <div class="fav-grid">
        <div v-for="r in resources" :key="r.id" class="fav-card glass zg-card">
          <div class="fc-body" @click="router.push(`/subject/${data.subjectById(r.subject_id)?.slug}`)">
            <div class="fc-title">{{ r.title }}</div>
            <div class="fc-meta">{{ r.category }} · ⬇ {{ r.downloads }}</div>
          </div>
          <el-button text size="small" @click="removeFav('resource', r.id)">✕</el-button>
        </div>
      </div>
    </div>

    <el-empty v-if="!loading && !articles.length && !resources.length" description="还没有收藏内容" />
  </div>
</template>

<style scoped>
.fav-head { padding: 28px 32px; margin-top: 20px; border-radius: var(--zg-radius); }
.fav-head h1 { font-size: var(--zg-fs-xl); font-weight: 800; }
.fav-desc { color: var(--zg-text-dim); margin-top: 6px; font-size: var(--zg-fs-sm); }
.fav-section { margin-top: 24px; }
.fav-grid { display: flex; flex-direction: column; gap: 10px; }
.fav-card { display: flex; align-items: center; gap: 8px; padding: 14px 16px; }
.fc-body { flex: 1; cursor: pointer; min-width: 0; }
.fc-title { font-weight: 700; font-size: var(--zg-fs-base); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fc-meta { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 3px; }
@media (max-width: 768px) {
  .fav-head { padding: 20px; margin-top: 12px; }
  .fav-card { padding: 12px 14px; }
}

@media (min-width: 1200px) {
  .fav-head { padding: 40px 44px; border-radius: 22px; }
  .fav-head h1 { font-size: 32px; }
  .fav-card { padding: 18px 22px; }
  .fc-title { font-size: 16px; }
  .fc-meta { font-size: 13px; }
}
</style>
