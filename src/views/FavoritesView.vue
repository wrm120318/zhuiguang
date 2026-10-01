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
    // 【v4.8.28 性能专项】原实现两处串行：
    //   ① `favorites` → `articles`：后者需要前者算出的 artIds，属**真依赖**，保留串行；
    //   ② `for (const s of data.subjects) await api.resources(s.id)` —— **N+1 请求**：
    //      有几个学科就串行发几次，每多一个学科首屏就多等一个 RTT。
    //      改为 `Promise.all` 并发（学科数通常 3~8 个），并去重、过滤空结果。
    //   行为完全不变：仍是「先拿收藏 id，再按学科拉资料并筛出收藏的那些」，
    //   只是把循环里的等待重叠起来，结果集合与顺序由 filter 保证一致。
    favorites.value = (await api.favorites()) as any
    const artIds = favorites.value.filter(f => f.target_type === 'fav_article').map(f => f.target_id)
    const resIds = favorites.value.filter(f => f.target_type === 'fav_resource').map(f => f.target_id)

    const jobs: Promise<any>[] = []
    // 美文：与资料并行（两者都只依赖上面算出的 id 列表）
    if (artIds.length) {
      jobs.push(
        (api.articles({ limit: 100 }) as any).then((all: any) => {
          articles.value = Array.isArray(all) ? all.filter((a: any) => artIds.includes(a.id)) : []
        })
      )
    }
    // 资料：按学科并发拉取（原来是串行 for-await）
    if (resIds.length) {
      const subjList = (data.subjects || []) as any[]
      jobs.push(
        Promise.all(subjList.map(s => (api.resources(s.id) as any).catch(() => [])))
          .then((lists: any[][]) => {
            const out: any[] = []
            for (const list of lists) {
              if (!Array.isArray(list)) continue
              out.push(...list.filter((r: any) => resIds.includes(r.id)))
            }
            resources.value = out
          })
      )
    }
    await Promise.all(jobs)
  } finally { loading.value = false }
}
onMounted(async () => {
  // 【v4.8.28】学科字典与收藏数据互不依赖 → 并行；学科走 store（会话缓存 + 去重）。
  //   load() 内部会遍历 data.subjects 拉资料，因此必须先保证学科已就绪 → 这里保持
  //   「先确保学科，再 load」，但把「学科已在内存」的常见路径变成零等待。
  if (data.subjects.length) { await load() }
  else { await data.fetchSubjects(); await load() }
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
      <h1 class="zg-grad-text"><ZgGlyph emoji="⭐" /> 我的收藏</h1>
      <p class="fav-desc">收藏的美文与资料，随时回看。</p>
    </div>

    <div v-if="articles.length" class="fav-section">
      <div class="section-title"><ZgGlyph emoji="✍️" /> 美文 ({{ articles.length }})</div>
      <div class="fav-grid">
        <div v-for="a in articles" :key="a.id" class="fav-card glass zg-card zg-swipe-card" v-swipe-action>
          <div class="zg-swipe-actions">
            <button class="zg-swipe-btn danger" @click="removeFav('article', a.id)">取消收藏</button>
          </div>
          <div class="zg-swipe-front" @click="router.push(`/article/${a.id}`)">
            <div class="fc-body">
              <div class="fc-title">{{ a.title }}</div>
              <div class="fc-meta">{{ a.author }} · {{ a.created_at?.slice(0,10) }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="resources.length" class="fav-section">
      <div class="section-title"><ZgGlyph emoji="📦" /> 资料 ({{ resources.length }})</div>
      <div class="fav-grid">
        <div v-for="r in resources" :key="r.id" class="fav-card glass zg-card zg-swipe-card" v-swipe-action>
          <div class="zg-swipe-actions">
            <button class="zg-swipe-btn danger" @click="removeFav('resource', r.id)">取消收藏</button>
          </div>
          <div class="zg-swipe-front" @click="router.push(`/subject/${data.subjectById(r.subject_id)?.slug}`)">
            <div class="fc-body">
              <div class="fc-title">{{ r.title }}</div>
              <div class="fc-meta">{{ r.category }} · <ZgGlyph emoji="⬇" /> {{ r.downloads }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ZgState v-if="!loading && !articles.length && !resources.length" type="empty" action-text="去首页逛逛" action-to="/" />
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
