<script setup lang="ts">
import { useRouter } from 'vue-router'
import ZgState from './ZgState.vue'
const router = useRouter()
const emit = defineEmits(['retry'])
</script>

<template>
  <ZgState type="error" title="网络连接异常" desc="无法连接到服务器，请检查网络后重试，或返回首页。" class="zg-network-error">
    <template #actions>
      <el-button type="primary" @click="emit('retry')">重试</el-button>
      <el-button @click="router.push('/')">返回首页</el-button>
    </template>
  </ZgState>
</template>

<style scoped>
.zg-network-error { padding: 40px 0; }
</style>
