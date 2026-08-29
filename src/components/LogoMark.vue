<script setup lang="ts">
// 追光 · 自绘品牌标记（光芒 / 星芒意象），fill 使用主题 CSS 变量，随经典/墨金自动适配
</script>

<template>
  <svg
    class="zg-logo-mark"
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="追光"
  >
    <path
      d="M16 3c.9 7.4 4.6 11.1 12 13-7.4 1.9-11.1 5.6-12 13-.9-7.4-4.6-11.1-12-13 7.4-1.9 11.1-5.6 12-13z"
      fill="var(--zg-primary)"
    />
    <circle cx="25.5" cy="6.5" r="2" fill="var(--zg-accent)" />
    <circle cx="6" cy="23.5" r="1.5" fill="var(--zg-accent)" />
  </svg>
</template>

<style scoped>
.zg-logo-mark {
  width: 1em;
  height: 1em;
  display: inline-block;
  vertical-align: -0.15em;
  flex-shrink: 0;
}
</style>
