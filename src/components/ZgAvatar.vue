<script setup lang="ts">
interface Props {
  src?: string
  size?: number | string
  ringColor?: string
  online?: boolean
  fallback?: string
}
const props = withDefaults(defineProps<Props>(), { size: 40, ringColor: 'var(--zg-primary, #F59E0B)', online: false, fallback: '' })
const sizePx = typeof props.size === 'number' ? `${props.size}px` : props.size
</script>

<template>
  <div class="zg-avatar" :style="{ width: sizePx, height: sizePx, '--zg-avatar-ring': ringColor }">
    <div class="ring"></div>
    <img v-if="src" :src="src" :alt="fallback || '头像'" />
    <div v-else class="fallback"><ZgGlyph emoji="👤" /></div>
    <span v-if="online" class="dot" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.zg-avatar { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.ring { position: absolute; inset: -3px; border-radius: 50%; padding: 2px; background: linear-gradient(135deg, var(--zg-avatar-ring), transparent 70%); -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); -webkit-mask-composite: xor; mask-composite: exclude; }
img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; position: relative; z-index: 1; }
.fallback { width: 100%; height: 100%; border-radius: 50%; background: rgba(186,117,23,.12); display: flex; align-items: center; justify-content: center; font-size: calc(v-bind(sizePx) * 0.45); color: var(--zg-text-dim, #7a6e54); }
.dot { position: absolute; bottom: 2px; right: 2px; width: 10px; height: 10px; border-radius: 50%; background: #10B981; border: 2px solid var(--zg-card-bg, #fff); z-index: 2; }
</style>
