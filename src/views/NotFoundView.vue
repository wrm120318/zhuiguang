<script setup lang="ts">
import ZgState from '@/components/ZgState.vue'
import { useRouter } from 'vue-router'
const router = useRouter()
</script>

<template>
  <div class="zg-notfound">
    <ZgState type="404" action-text="返回首页" action-to="/" />
    <button class="zg-nf-back" type="button" @click="router.back()">← 返回上一页</button>
  </div>
</template>

<style scoped>
.zg-notfound {
  min-height: 70vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.zg-nf-back {
  margin-top: 4px; padding: 8px 18px; border-radius: 999px; cursor: pointer;
  background: transparent; border: 1px solid var(--zg-card-border); color: var(--zg-text-dim);
  font-size: 13px; transition: all .2s ease;
}
.zg-nf-back:hover { color: var(--zg-primary); border-color: var(--zg-primary); }
</style>
