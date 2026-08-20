<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useThemeStore } from '@/store/theme'
import { useReveal } from '@/composables/useReveal'
import ZgState from '@/components/ZgState.vue'

const router = useRouter()
const data = useDataStore()
const theme = useThemeStore()
const root = ref<HTMLElement | null>(null)
const loading = ref(false)
useReveal(root)

const error = ref(false)

async function load() {
  loading.value = true; error.value = false
  try {
    if (!data.subjects.length) await data.fetchSubjects()
  } catch { error.value = true }
  finally { loading.value = false }
}
onMounted(load)

async function onRefresh(done: () => void) { await load(); done() }

// 图标样式（A7 规格）：学科自定义 s.color 照常渲染实色渐变（铁律4）；无 color 默认走暖金浅底 + 主色图标
// ★ Q3 修复：自定义背景色太浅（如 #FFFFFF/#FDE68A）时，emoji 默认深色被白底吞掉看不见——自动反色用深色图标
function isLightColor(hex: string): boolean {
  const m = (hex || '').replace('#', '').match(/.{2}/g)
  if (!m || m.length < 3) return false
  const [r, g, b] = m.map(x => parseInt(x, 16))
  // YIQ 亮度公式（业界感知亮度标准）
  return (r * 299 + g * 587 + b * 114) / 1000 > 170
}
function iconStyle(color?: string) {
  if (!color) {
    const cfg: any = theme.activeTheme?.config
    const a = cfg?.designMode === 'inkgold' && cfg?.inkgoldTone === 'dark' ? 0.12 : 0.10
    return { background: `rgba(var(--zg-primary-rgb), ${a})`, color: 'var(--zg-primary)' }
  }
  return {
    background: `linear-gradient(135deg, ${color}, ${color}aa)`,
    color: isLightColor(color) ? 'rgba(120,53,15,0.85)' : '#fff',
  }
}

function go(s: any) { router.push(`/subject/${s.slug}`) }
</script>

<template>
  <ZgPullRefresh class="page zg-container subjects-page" @refresh="onRefresh">
    <ZgNetworkError v-if="error" @retry="load" />
    <template v-else>
      <div ref="root">
        <div class="sp-head">
        <h1 class="sp-title"><ZgGlyph emoji="📚" /> 全部学科</h1>
        <p class="sp-sub">选择学科进入子站，探索资料、美文与数据查询。</p>
      </div>

      <!-- 骨架屏 -->
    <div v-if="loading" class="sp-grid">
      <div v-for="i in 9" :key="i" class="sp-card glass zg-skeleton-pulse">
        <div class="sp-icon-sk"></div>
        <div class="sp-text-sk">
          <div class="sp-line-sk short"></div>
          <div class="sp-line-sk long"></div>
        </div>
        <div class="sp-arrow-sk"></div>
      </div>
    </div>

    <!-- 空状态 -->
    <ZgState v-else-if="!data.subjects.length" type="empty" title="暂无学科" desc="学科管理员还没有创建学科子站，稍后再来看看吧。" />

    <!-- 学科网格 -->
    <div v-else class="sp-grid">
      <div v-for="(s, i) in data.subjects" :key="s.id" class="sp-card glass zg-card zg-reveal" :style="{ animationDelay: `${i * 0.05}s` }" @click="go(s)">
        <div class="sp-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></div>
        <div class="sp-body">
          <div class="sp-name">{{ s.name }}</div>
          <div class="sp-desc">{{ s.description || '探索该学科的精彩资料与美文' }}</div>
        </div>
        <div class="sp-arrow"><ZgGlyph emoji="→" /></div>
      </div>
    </div>
    </div>
    </template>
  </ZgPullRefresh>
</template>

<style scoped>
.subjects-page { padding-bottom: 40px; }
.sp-head { margin: 24px 0 28px; }
.sp-title { font-size: var(--zg-fs-2xl, 32px); font-weight: 800; line-height: 1.25; display: flex; align-items: center; gap: 10px; }
.sp-sub { color: var(--zg-text-dim, #7a6e54); margin-top: 8px; font-size: var(--zg-fs-base, 15px); line-height: 1.6; }
.sp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.sp-card { display: flex; align-items: center; gap: 16px; padding: 20px; border-radius: 18px; cursor: pointer; transition: transform .28s cubic-bezier(.22,1,.36,1), box-shadow .28s ease, border-color .28s ease; }
/* 悬停：仅做温润上浮，阴影交给全局瓷材质（§2 多层柔影，杜绝硬矩形阴影）。
   墨金下由 main.css「html.zg-inkgold .zg-card:hover」接管柔影；经典下回退软影。 */
.sp-card:hover { transform: translateY(-4px); box-shadow: var(--zg-porcelain-shadow, 0 10px 30px rgba(120,90,30,.10)); }
.sp-card:hover .sp-arrow { transform: translateX(4px); color: var(--zg-primary); }
/* 墨金：学科卡由"硬边白卡"改为清晰瓷面 + 大扩散柔影（只浮不框，阴影是好的设计）；
   经典档 .glass 橙玻璃不动（铁律1）。 */
.zg-inkgold .sp-card.glass {
  background: var(--zg-porcelain-2) !important;
  border: 1px solid transparent !important;
  box-shadow: var(--zg-glaze), var(--zg-porcelain-shadow) !important;
  -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
}
.zg-inkgold .sp-card.glass:hover {
  box-shadow: var(--zg-glaze), inset 0 0 0 1px rgba(var(--zg-primary-rgb), .24), var(--zg-porcelain-shadow) !important;
  transform: translateY(-3px);
}
/* 图标小硬阴影在墨金下也压掉，避免"卡中带小盒" */
.zg-inkgold .sp-icon { box-shadow: none; }
.sp-icon { width: 56px; height: 56px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 28px; flex: none; box-shadow: 0 6px 16px rgba(0,0,0,.08); }
.sp-body { flex: 1; min-width: 0; }
.sp-name { font-size: var(--zg-fs-md, 17px); font-weight: 700; line-height: 1.35; }
.sp-desc { font-size: var(--zg-fs-xs, 13px); color: var(--zg-text-dim, #7a6e54); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sp-arrow { font-size: 18px; color: var(--zg-text-dim, #9c8e73); transition: transform .2s ease, color .2s ease; flex: none; }

/* 骨架屏 */
.zg-skeleton-pulse { animation: zgSkeletonPulse 1.6s ease-in-out infinite; }
@keyframes zgSkeletonPulse { 0%,100%{ opacity: .55; } 50%{ opacity: .85; } }
.sp-icon-sk { width: 56px; height: 56px; border-radius: 16px; background: rgba(186,117,23,.12); flex: none; }
.sp-text-sk { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.sp-line-sk { height: 12px; border-radius: 6px; background: rgba(186,117,23,.1); }
.sp-line-sk.short { width: 38%; }
.sp-line-sk.long { width: 72%; }
.sp-arrow-sk { width: 22px; height: 22px; border-radius: 6px; background: rgba(186,117,23,.1); flex: none; }

@media (max-width: 768px) {
  .sp-head { margin: 14px 0 18px; }
  .sp-title { font-size: var(--zg-fs-xl, 24px); }
  .sp-sub { font-size: var(--zg-fs-sm, 14px); }
  .sp-grid { grid-template-columns: 1fr; gap: 12px; }
  .sp-card { padding: 16px; gap: 14px; }
  .sp-icon { width: 48px; height: 48px; font-size: 24px; border-radius: 14px; }
  .sp-name { font-size: var(--zg-fs-base, 15px); }
}
@media (min-width: 1200px) {
  .sp-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .sp-card { padding: 24px; }
  .sp-icon { width: 64px; height: 64px; font-size: 30px; }
}
@media (min-width: 1600px) {
  .sp-grid { grid-template-columns: repeat(4, 1fr); }
}
</style>
