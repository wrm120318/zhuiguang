<script setup lang="ts">
interface Props {
  width?: string
  height?: string
  circle?: boolean
  text?: boolean
  pulse?: boolean
}
withDefaults(defineProps<Props>(), { width: '100%', height: '1em', circle: false, text: false, pulse: true })
</script>

<template>
  <div class="zg-skeleton" :class="{ circle, text, pulse }" :style="{ width, height }"></div>
</template>

<style scoped>
.zg-skeleton {
  display: inline-block;
  border-radius: 6px;
  background: linear-gradient(90deg, rgba(186,117,23,.10) 25%, rgba(186,117,23,.18) 50%, rgba(186,117,23,.10) 75%);
  background-size: 200% 100%;
}
.zg-skeleton.circle { border-radius: 50%; }
.zg-skeleton.text { border-radius: 4px; }
.zg-skeleton.pulse { animation: zgSkeletonShimmer 1.6s linear infinite; }
@keyframes zgSkeletonShimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
