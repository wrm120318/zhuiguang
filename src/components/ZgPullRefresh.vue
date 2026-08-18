<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
const props = withDefaults(defineProps<{ threshold?: number }>(), { threshold: 80 })
const emit = defineEmits(['refresh'])
const wrap = ref<HTMLElement | null>(null)
const pulling = ref(false)
const refreshing = ref(false)
const offset = ref(0)
let startY = 0
let startScrollTop = 0

function onTouchStart(e: TouchEvent) {
  if (refreshing.value) return
  startY = e.touches[0].clientY
  startScrollTop = wrap.value?.scrollTop || 0
}
function onTouchMove(e: TouchEvent) {
  if (refreshing.value) return
  const y = e.touches[0].clientY
  const delta = y - startY
  if (startScrollTop > 0 || delta <= 0) return
  e.preventDefault()
  pulling.value = true
  offset.value = Math.min(delta * 0.5, props.threshold * 1.4)
}
function onTouchEnd() {
  if (!pulling.value) return
  pulling.value = false
  if (offset.value >= props.threshold) {
    refreshing.value = true
    offset.value = props.threshold * 0.8
    emit('refresh', () => { refreshing.value = false; offset.value = 0 })
  } else {
    offset.value = 0
  }
}
onMounted(() => {
  const el = wrap.value
  if (!el) return
  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchmove', onTouchMove, { passive: false })
  el.addEventListener('touchend', onTouchEnd)
})
onUnmounted(() => {
  const el = wrap.value
  if (!el) return
  el.removeEventListener('touchstart', onTouchStart)
  el.removeEventListener('touchmove', onTouchMove)
  el.removeEventListener('touchend', onTouchEnd)
})
</script>

<template>
  <div ref="wrap" class="zg-pull-refresh">
    <div class="zg-ptr" :class="{ show: pulling || refreshing }" :style="{ height: offset + 'px' }">
      <span class="zg-ptr-icon" :class="{ spin: refreshing }"><ZgGlyph emoji="🌟" /></span>
      <span class="zg-ptr-text">{{ refreshing ? '正在刷新…' : offset >= threshold ? '松开刷新' : '下拉刷新' }}</span>
    </div>
    <div class="zg-ptr-body" :style="{ transform: `translateY(${offset}px)` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.zg-pull-refresh { overflow-y: auto; -webkit-overflow-scrolling: touch; position: relative; }
.zg-ptr { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: center; gap: 8px; height: 0; overflow: hidden; color: var(--zg-text-dim, #9c8e73); font-size: 13px; transition: height .22s ease; z-index: 1; }
.zg-ptr-icon { font-size: 18px; display: inline-block; transition: transform .2s; }
.zg-ptr-icon.spin { animation: zgSpin 1s linear infinite; }
@keyframes zgSpin { to { transform: rotate(360deg); } }
.zg-ptr-body { position: relative; z-index: 2; background: transparent; }
</style>
