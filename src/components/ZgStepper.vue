<script setup lang="ts">
import ZgGlyph from './ZgGlyph.vue'

defineProps<{
  steps: string[]
  /** 当前步骤索引（0-based） */
  current: number
}>()
</script>

<template>
  <div class="zg-stepper" role="list" aria-label="步骤进度">
    <template v-for="(s, i) in steps" :key="i">
      <div class="zg-step" :class="{ done: i < current, active: i === current }" role="listitem">
        <div class="zg-step-dot">
          <ZgGlyph v-if="i < current" emoji="✓" />
          <span v-else>{{ i + 1 }}</span>
        </div>
        <div class="zg-step-label">{{ s }}</div>
      </div>
      <div v-if="i < steps.length - 1" class="zg-step-bar" :class="{ done: i < current }"></div>
    </template>
  </div>
</template>

<style scoped>
.zg-stepper {
  display: flex;
  align-items: center;
  padding: 4px 2px 16px;
}
.zg-step {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zg-step-dot {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  background: rgba(186, 117, 23, .12);
  color: #BA7517;
  border: 1.5px solid rgba(186, 117, 23, .3);
  transition: all .25s cubic-bezier(.2, .8, .2, 1);
}
.zg-step.active .zg-step-dot {
  background: linear-gradient(135deg, #D4AF37, #BA7517);
  color: #fff;
  border-color: #BA7517;
  box-shadow: 0 4px 12px rgba(186, 117, 23, .3);
}
.zg-step.done .zg-step-dot {
  background: rgba(186, 117, 23, .18);
  color: #BA7517;
  border-color: rgba(186, 117, 23, .5);
}
.zg-step-label {
  font-size: 13px;
  color: #9a8a6a;
  font-weight: 600;
  white-space: nowrap;
}
.zg-step.active .zg-step-label,
.zg-step.done .zg-step-label {
  color: #7a5a12;
}
.zg-step-bar {
  flex: 1;
  height: 2px;
  margin: 0 8px;
  background: rgba(186, 117, 23, .18);
  border-radius: 2px;
  transition: all .3s;
}
.zg-step-bar.done {
  background: linear-gradient(90deg, #D4AF37, #BA7517);
}
@media (max-width: 768px) {
  .zg-step-label { font-size: 11px; }
  .zg-step-bar { margin: 0 5px; }
  .zg-step-dot { width: 23px; height: 23px; font-size: 12px; }
}
</style>
