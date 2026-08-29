<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  data: number[]
  color?: string
  width?: number
  height?: number
}>(), {
  color: 'var(--zg-primary)',
  width: 96,
  height: 32,
})

const uid = Math.random().toString(36).slice(2, 8)
const geom = computed(() => {
  const d = props.data
  const w = props.width, h = props.height
  if (!d || d.length < 2) return { line: '', area: '' }
  const min = Math.min(...d), max = Math.max(...d)
  const span = max - min || 1
  const step = w / (d.length - 1)
  const pts = d.map((v, i) => {
    const x = i * step
    const y = h - ((v - min) / span) * (h - 4) - 2
    return [x, y]
  })
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
  const area = line + ` L${w} ${h} L0 ${h} Z`
  return { line, area, pts }
})

const gid = 'zgSpk' + uid
</script>

<template>
  <svg class="zg-spark" :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height" fill="none" aria-hidden="true">
    <defs>
      <linearGradient :id="gid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="color" stop-opacity=".28"/>
        <stop offset="1" :stop-color="color" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path v-if="geom.area" :d="geom.area" :fill="`url(#${gid})`" />
    <path v-if="geom.line" :d="geom.line" :stroke="color" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>

<style scoped>
.zg-spark { display: block; }
</style>
