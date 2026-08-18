<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useDataStore } from '@/store/data'

const route = useRoute()
const router = useRouter()
const data = useDataStore()

const query = ref((route.query.q as string) || '')
const results = ref<{ articles: any[]; resources: any[] }>({ articles: [], resources: [] })
const loading = ref(false)

async function search() {
  if (!query.value.trim()) { results.value = { articles: [], resources: [] }; return }
  loading.value = true
  try {
    results.value = (await api.search(query.value)) as any
  } finally { loading.value = false }
}

watch(() => route.query.q, (q) => { if (q) { query.value = q as string; search() } })
onMounted(() => { if (query.value) search() })
</script>

<template>
  <div class="page zg-container">
    <div class="search-head glass-strong zg-slide-up">
      <div class="sh-bar">
        <el-input v-model="query" placeholder="搜索美文、资料…" size="large" @keyup.enter="search" clearable>
          <template #prefix><ZgGlyph emoji="🔍" /></template>
        </el-input>
        <el-button type="primary" size="large" @click="search">搜索</el-button>
      </div>
    </div>

    <div v-loading="loading" class="results-wrap">
      <div v-if="results.articles?.length" class="result-section">
        <div class="section-title"><ZgGlyph emoji="✍️" /> 美文 ({{ results.articles.length }})</div>
        <div class="result-list">
          <div v-for="a in results.articles" :key="a.id" class="result-card glass zg-card" @click="router.push(`/article/${a.id}`)">
            <div class="rc-icon"><ZgGlyph emoji="📝" /></div>
            <div class="rc-body">
              <div class="rc-title">{{ a.title }}</div>
              <div class="rc-meta">{{ a.author }} · {{ a.category }} · {{ a.created_at?.slice(0,10) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="results.resources?.length" class="result-section">
        <div class="section-title"><ZgGlyph emoji="📦" /> 资料 ({{ results.resources.length }})</div>
        <div class="result-list">
          <div v-for="r in results.resources" :key="r.id" class="result-card glass zg-card" @click="router.push(`/subject/${data.subjectById(r.subject_id)?.slug}`)">
            <div class="rc-icon"><ZgGlyph emoji="📎" /></div>
            <div class="rc-body">
              <div class="rc-title">{{ r.title }}</div>
              <div class="rc-meta">{{ r.category }} · <ZgGlyph emoji="⬇" /> {{ r.downloads }} 次下载</div>
            </div>
          </div>
        </div>
      </div>

      <ZgState v-if="query && !loading && !results.articles?.length && !results.resources?.length" type="search" />
    </div>
  </div>
</template>

<style scoped>
.search-head { padding: 24px; margin-top: 20px; border-radius: var(--zg-radius); }
.sh-bar { display: flex; gap: 12px; }
.results-wrap { margin-top: 24px; }
.result-section { margin-bottom: 28px; }
.result-list { display: flex; flex-direction: column; gap: 10px; }
.result-card { display: flex; align-items: center; gap: 14px; padding: 16px 20px; cursor: pointer; }
.rc-icon { width: 44px; height: 44px; border-radius: 12px; background: rgba(245,158,11,.1); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
.rc-body { flex: 1; min-width: 0; }
.rc-title { font-weight: 700; font-size: var(--zg-fs-base); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rc-meta { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 4px; }
@media (max-width: 768px) {
  .search-head { padding: 16px; margin-top: 12px; }
  .sh-bar { flex-direction: column; }
  .result-card { padding: 12px 14px; gap: 10px; }
  .rc-icon { width: 36px; height: 36px; font-size: 18px; }
}

@media (min-width: 1200px) {
  .search-head { padding: 32px 40px; border-radius: 22px; }
  .result-card { padding: 18px 24px; gap: 18px; }
  .rc-icon { width: 52px; height: 52px; border-radius: 14px; font-size: 26px; }
  .rc-title { font-size: 16px; }
  .rc-meta { font-size: 13px; }
}
</style>
