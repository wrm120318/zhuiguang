<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'

const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const list = ref<any[]>([])
const loading = ref(false)
const filter = ref<'all' | 'site' | 'class'>('all')

async function load() {
  loading.value = true
  try { list.value = (await api.announcements()) as any } finally { loading.value = false }
}
onMounted(load)

const filtered = computed(() => {
  if (filter.value === 'all') return list.value
  return list.value.filter(a => a.scope === filter.value)
})

function scopeLabel(a: any) {
  if (a.scope === 'site') return '全站公告'
  const cn = data.classById(a.class_id)?.name || '班级'
  return `班级公告 · ${cn}`
}
function scopeType(a: any) { return a.scope === 'site' ? 'success' : 'warning' }
function canPost() { return user.isSuperAdmin || user.isTeacher }
function excerpt(html: string) {
  const text = (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}
</script>

<template>
  <div class="page zg-container">
    <div class="head">
      <h1 class="zg-page-title">📢 网站公告</h1>
      <div class="head-actions">
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="site">全站</el-radio-button>
          <el-radio-button value="class">班级</el-radio-button>
        </el-radio-group>
        <el-button v-if="canPost()" type="primary" round @click="router.push('/announcements/new')">+ 发布公告</el-button>
      </div>
    </div>

    <div v-loading="loading" class="list">
      <div v-for="a in filtered" :key="a.id" class="ann-card glass zg-card" @click="router.push(`/announcements/${a.id}`)">
        <div class="ac-head">
          <el-tag :type="scopeType(a)" size="small">{{ scopeLabel(a) }}</el-tag>
          <span class="ac-time">{{ a.created_at?.slice(0, 16) }}</span>
        </div>
        <div class="ac-title">{{ a.title }}</div>
        <div class="ac-excerpt">{{ excerpt(a.content) }}</div>
        <div class="ac-meta">
          <span>👤 {{ a.author_name }}</span>
          <span>👁 {{ a.views }}</span>
        </div>
      </div>
      <el-empty v-if="!loading && !filtered.length" description="暂无公告" />
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; flex-wrap: wrap; gap: 12px; }
.zg-page-title { font-size: 26px; font-weight: 800; }
.head-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.list { display: flex; flex-direction: column; gap: 12px; }
.ann-card { padding: 18px 20px; cursor: pointer; transition: all .2s; }
.ann-card:hover { transform: translateY(-2px); }
.ac-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-title { font-size: 17px; font-weight: 700; }
.ac-excerpt { color: var(--zg-text-dim); font-size: 13px; line-height: 1.6; margin: 8px 0 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ac-meta { display: flex; gap: 12px; font-size: 12px; color: var(--zg-text-dim); }
@media (max-width: 768px) { .zg-page-title { font-size: 22px; } }
</style>
