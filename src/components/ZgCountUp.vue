<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
const props = withDefaults(defineProps<{ value: number; duration?: number }>(), { duration: 800 })
const display = ref(0)
let raf = 0
function animate(to: number) {
  if (raf) cancelAnimationFrame(raf)
  const from = display.value
  const start = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / props.duration)
    const eased = 1 - Math.pow(1 - t, 3)
    display.value = Math.round(from + (to - from) * eased)
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}
watch(() => props.value, animate)
onMounted(() => animate(props.value))
</script>

<template>
  <span class="zg-count-up">{{ display }}</span>
</template>

<style scoped>
.zg-count-up { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; }
</style>
