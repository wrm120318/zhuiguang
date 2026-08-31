<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { mdExcerpt } from '@/utils/markdown'
import { fileUrl } from '@/utils/helpers'

const router = useRouter()
const user = useUserStore()
const list = ref<any[]>([])
const loading = ref(false)
const myOnly = ref(false)

async function load() {
  loading.value = true
  try {
    const params: any = { ptype: 'blog' }
    if (myOnly.value) { params.mine = '1'; params.userId = user.current?.id }
    list.value = (await api.pages(params)) as any
  } finally { loading.value = false }
}
onMounted(load)

const filtered = computed(() => list.value)

function excerpt(md: string) {
  return mdExcerpt(md, 100)
}
</script>

<template>
  <div class="page zg-container">
    <div class="head">
      <h1 class="zg-page-title"><ZgGlyph emoji="✍️" /> 网站博客</h1>
      <div class="head-actions">
        <el-radio-group v-model="myOnly" size="small" @change="load">
          <el-radio-button :value="false">全部</el-radio-button>
          <el-radio-button :value="true">我的</el-radio-button>
        </el-radio-group>
        <el-button type="primary" round @click="router.push('/blog/new')">+ 写博客</el-button>
      </div>
    </div>

    <div v-loading="loading" class="grid">
      <div v-for="b in filtered" :key="b.id" class="blog-card glass zg-card" @click="router.push(`/blog/${b.id}`)">
        <div v-if="b.cover" class="bc-cover" :style="{ backgroundImage: `url(${fileUrl(b.cover)})` }"></div>
        <div v-else class="bc-cover bc-placeholder"><ZgGlyph emoji="✍️" /></div>
        <div class="bc-body">
          <div class="bc-title">{{ b.title }}</div>
          <div class="bc-excerpt">{{ excerpt(b.content) }}</div>
          <div class="bc-meta">
            <span><ZgGlyph emoji="👤" /> {{ b.author_name }}</span>
            <span><ZgGlyph emoji="👁" /> {{ b.views }}</span>
            <span><ZgGlyph emoji="📅" /> {{ b.created_at?.slice(5, 10) }}</span>
          </div>
        </div>
      </div>
      <ZgState v-if="!loading && !filtered.length" type="empty" title="还没有博客" desc="记录学习心得、写下第一篇吧～">
        <template #actions>
          <el-button type="primary" @click="router.push('/blog/new')">写第一篇</el-button>
        </template>
      </ZgState>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; flex-wrap: wrap; gap: 12px; }
.zg-page-title { font-size: 26px; font-weight: 800; }
.head-actions { display: flex; gap: 10px; align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.blog-card { overflow: hidden; cursor: pointer; }
.bc-cover { height: 140px; background-size: cover; background-position: center; }
.bc-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.2), rgba(var(--zg-primary-2-rgb),.15)); font-size: 48px; }
.bc-body { padding: 16px; }
.bc-title { font-weight: 700; font-size: 16px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bc-excerpt { color: var(--zg-text-dim); font-size: 13px; line-height: 1.6; margin: 8px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.bc-meta { display: flex; gap: 12px; font-size: 12px; color: var(--zg-text-dim); }
@media (max-width: 768px) { .grid { grid-template-columns: 1fr; } .zg-page-title { font-size: 22px; } }
</style>
