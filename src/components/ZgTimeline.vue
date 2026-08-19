<script setup lang="ts">
interface Item { time: string; title: string; desc?: string; type?: 'default' | 'success' | 'warning' | 'info' | 'error' }
withDefaults(defineProps<{ items: Item[] }>(), { items: () => [] })
</script>

<template>
  <div class="zg-timeline">
    <div v-for="(it, i) in items" :key="i" class="zg-tl-item">
      <div class="zg-tl-line" v-if="i < items.length - 1"></div>
      <div class="zg-tl-dot" :class="it.type || 'default'"></div>
      <div class="zg-tl-card glass zg-card">
        <div class="zg-tl-time">{{ it.time }}</div>
        <div class="zg-tl-title">{{ it.title }}</div>
        <div v-if="it.desc" class="zg-tl-desc">{{ it.desc }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.zg-timeline { display: flex; flex-direction: column; gap: 0; padding-left: 8px; }
.zg-tl-item { position: relative; display: grid; grid-template-columns: 22px 1fr; gap: 14px; padding-bottom: 20px; }
.zg-tl-line { position: absolute; left: 10px; top: 18px; bottom: 0; width: 2px; background: linear-gradient(var(--zg-primary), transparent); opacity: .35; }
.zg-tl-dot { width: 14px; height: 14px; border-radius: 50%; background: var(--zg-primary); box-shadow: 0 0 0 4px rgba(186,117,23,.12); margin-top: 4px; }
.zg-tl-dot.success { background: var(--zg-success, #10B981); box-shadow: 0 0 0 4px rgba(16,185,129,.15); }
.zg-tl-dot.warning { background: var(--zg-warning, var(--zg-primary)); box-shadow: 0 0 0 4px rgba(var(--zg-primary-rgb),.15); }
.zg-tl-dot.info { background: var(--zg-info, #3B82F6); box-shadow: 0 0 0 4px rgba(59,130,246,.15); }
.zg-tl-dot.error { background: var(--zg-error, #EF4444); box-shadow: 0 0 0 4px rgba(239,68,68,.15); }
.zg-tl-card { padding: 14px 16px; }
.zg-tl-time { font-size: var(--zg-fs-xs, 12px); color: var(--zg-text-dim, #9c8e73); margin-bottom: 4px; }
.zg-tl-title { font-weight: 600; font-size: var(--zg-fs-sm, 14px); }
.zg-tl-desc { font-size: var(--zg-fs-xs, 12px); color: var(--zg-text-dim, #9c8e73); margin-top: 4px; }
</style>
