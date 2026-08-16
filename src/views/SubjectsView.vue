<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useReveal } from '@/composables/useReveal'

const router = useRouter()
const data = useDataStore()
const root = ref<HTMLElement | null>(null)
useReveal(root)
onMounted(() => { if (!data.subjects.length) data.fetchSubjects() })
</script>

<template>
  <div class="page zg-container" ref="root">
    <div class="head">
      <h1 class="zg-grad-text">📚 全部学科</h1>
      <p class="desc">选择学科进入子站，探索资料、美文与数据查询。</p>
    </div>
    <div class="grid">
      <div v-for="s in data.subjects" :key="s.id" class="card glass zg-card zg-reveal" @click="router.push(`/subject/${s.slug}`)">
        <div class="icon" :style="{ background: `linear-gradient(135deg, ${s.color}, ${s.color}88)` }">{{ s.icon }}</div>
        <div class="name">{{ s.name }}</div>
        <div class="d">{{ s.description }}</div>
        <div class="go">进入 →</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { margin: 16px 0 24px; }
.head h1 { font-size: 28px; font-weight: 800; }
.desc { color: var(--zg-text-dim); margin-top: 6px; font-size: 14px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:16px; }
.card { padding:24px; text-align:center; cursor:pointer; }
.icon { width:64px; height:64px; border-radius:18px; display:flex; align-items:center; justify-content:center; font-size:32px; margin:0 auto 14px; }
.name { font-size:20px; font-weight:700; }
.d { font-size:12px; color:var(--zg-text-dim); margin:6px 0 14px; }
.go { font-size:13px; color:var(--zg-primary); font-weight:600; }
@media (max-width:768px){ .grid{grid-template-columns:repeat(2,1fr); gap:12px;} .card{padding:16px;} .icon{width:48px;height:48px;font-size:24px;} .name{font-size:16px;} }
</style>
