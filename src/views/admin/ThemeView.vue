<script setup lang="ts">
import { reactive, watch, onMounted, computed } from 'vue'
import { useThemeStore } from '@/store/theme'
import { ElMessage } from 'element-plus'

const theme = useThemeStore()
const d = reactive<any>({ primary: '#f59e0b', primary2: '#fb923c', accent: '#fbbf24', bgFrom: '#FFFBEB', bgVia: '#FEF3C7', bgTo: '#FDE68A', blur: 16, radius: 18, designMode: 'classic', inkgoldTone: 'light', bright: 'soft', name: '我的主题', isActive: false, id: null })

onMounted(() => {
  if (theme.draft) Object.assign(d, JSON.parse(JSON.stringify(theme.draft)))
})

watch(d, () => { theme.preview({ ...d }) }, { deep: true })

// BUG-13 修复：预设色板跟随设计模式——经典=橘黄系原色板（像素级不变），墨金=沉稳金系（12 色更自由）
const classicSwatches = ['#f59e0b', '#eab308', '#f97316', '#fbbf24', '#d97706', '#fde047', '#a16207', '#fdba74', '#dc2626', '#0891b2', '#7c3aed', '#059669']
const inkgoldSwatches = ['#BA7517', '#C8922E', '#D4AF37', '#A66B11', '#8C6414', '#E6C66E', '#9C7A2A', '#B8905A', '#6B4423', '#A0784A', '#D9B777', '#F0DCA8']
const presetColors = computed(() => (d.designMode === 'inkgold' ? inkgoldSwatches : classicSwatches))

function pickTheme(id: number) {
  const t = theme.themes.find((x: any) => x.id === id)
  if (!t) return
  Object.assign(d, JSON.parse(JSON.stringify(t.config)), { id: t.id, name: t.name })
}

async function publish() {
  await theme.saveDraft({ id: d.id, name: d.name, config: { primary: d.primary, primary2: d.primary2, accent: d.accent, bgFrom: d.bgFrom, bgVia: d.bgVia, bgTo: d.bgTo, blur: d.blur, radius: d.radius, designMode: d.designMode, inkgoldTone: d.inkgoldTone, bright: d.bright }, isActive: true })
  ElMessage.success('主题已发布，全站即时生效')
}
function reset() {
  theme.reset()
  if (theme.draft) Object.assign(d, JSON.parse(JSON.stringify(theme.draft)))
  ElMessage.info('已恢复为当前线上主题')
}
</script>

<template>
  <div class="theme-page">
    <h1 class="dh-title"><ZgGlyph emoji="🎨" /> 界面风格编辑器</h1>
    <p class="tip">实时调整全局配色、毛玻璃强度、圆角，发布后全站生效。</p>

    <div class="theme-row">
      <div class="edit-panel glass">
        <div class="ep-section">
          <div class="ep-label">预设主题</div>
          <div class="preset-row">
            <div v-for="t in theme.themes" :key="t.id" class="preset-chip" :class="{ on: d.id === t.id }" @click="pickTheme(t.id)">
              <span class="pc-dot" :style="{ background: `linear-gradient(135deg, ${t.config.primary}, ${t.config.accent})` }"></span>
              {{ t.name }}
            </div>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">主题名称</div>
          <el-input v-model="d.name" placeholder="如：追光金辉" />
        </div>

        <div class="ep-section">
          <div class="ep-label">设计模式（全站皮肤，发布后即时生效）</div>
          <el-radio-group v-model="d.designMode">
            <el-radio-button label="classic">经典暖橘</el-radio-button>
            <el-radio-button label="inkgold">墨金学术</el-radio-button>
          </el-radio-group>
          <p class="tip" style="margin-top:8px">墨金学术 = 胶囊导航 + 沉稳金 + 液态玻璃 + 衬线标题 + 手机化过渡；经典 = 当前外观，切回后完全一致。</p>
          <div v-if="d.designMode === 'inkgold'" style="margin-top:18px">
            <p class="tip ink-note">墨金模式默认使用沉稳金色系；下方色板/圆角/毛玻璃的自定义在墨金模式下也生效（会覆盖默认金色）。无自定义时墨金保持沉稳金原貌。</p>
            <div class="ep-label">墨金深浅（发布后全站生效）</div>
            <el-radio-group v-model="d.inkgoldTone">
              <el-radio-button label="light">浅色 · 暖米白</el-radio-button>
              <el-radio-button label="dark">深色 · 温润暖黑</el-radio-button>
            </el-radio-group>
            <p class="tip" style="margin-top:8px">浅色为默认学术风（暖米白 + 沉稳金，1.0–2.0 原貌）；深色为温润暖黑。两者均去表情 emoji、改用金色 SVG 图标。</p>
            <div class="ep-label" style="margin-top:18px">背景亮度（发布后全站生效）</div>
            <el-radio-group v-model="d.bright">
              <el-radio-button label="soft">温和提亮</el-radio-button>
              <el-radio-button label="bright">明显提亮</el-radio-button>
            </el-radio-group>
            <p class="tip" style="margin-top:8px">温和＝保留暖调、仅提升卡片通透度；明显＝背景整体更亮更净，高级感更强。全站全用户即时生效。</p>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">主色调</div>
          <div class="color-row">
            <el-color-picker v-model="d.primary" />
            <span class="color-val">{{ d.primary }}</span>
            <div class="swatches">
              <span v-for="c in presetColors" :key="c" class="sw" :style="{ background: c }" @click="d.primary = c"></span>
            </div>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">辅色</div>
          <div class="color-row">
            <el-color-picker v-model="d.primary2" />
            <span class="color-val">{{ d.primary2 }}</span>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">点缀色</div>
          <div class="color-row">
            <el-color-picker v-model="d.accent" />
            <span class="color-val">{{ d.accent }}</span>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">背景渐变</div>
          <div class="bg-row">
            <el-color-picker v-model="d.bgFrom" /><span>起</span>
            <el-color-picker v-model="d.bgVia" /><span>中</span>
            <el-color-picker v-model="d.bgTo" /><span>终</span>
          </div>
        </div>

        <div class="ep-section">
          <div class="ep-label">毛玻璃强度：{{ d.blur }}px</div>
          <el-slider v-model="d.blur" :min="0" :max="40" :step="1" />
        </div>

        <div class="ep-section">
          <div class="ep-label">圆角：{{ d.radius }}px</div>
          <el-slider v-model="d.radius" :min="0" :max="32" :step="1" />
        </div>

        <div class="ep-actions">
          <el-button @click="reset">恢复</el-button>
          <el-button type="primary" @click="publish">发布全局风格</el-button>
        </div>
      </div>

      <div class="preview-panel">
        <div class="pp-label">实时预览</div>
        <div class="pp-demo glass-strong">
          <div class="pp-nav glass">
            <span class="pp-logo"><ZgGlyph emoji="🌟" /> 追光</span>
            <span class="pp-link on">首页</span>
            <span class="pp-link">学科</span>
            <el-button size="small" type="primary" round>主按钮</el-button>
          </div>
          <div class="pp-cards">
            <div class="pp-card glass zg-card">
              <div class="pp-card-icon" :style="{ background: `linear-gradient(135deg, ${d.primary}, ${d.accent})` }"><ZgGlyph emoji="📖" /></div>
              <div class="pp-card-title">语文</div>
              <div class="pp-card-desc">诗书礼乐，美文共赏</div>
            </div>
            <div class="pp-card glass zg-card">
              <div class="pp-card-icon" :style="{ background: `linear-gradient(135deg, ${d.primary2}, ${d.accent})` }"><ZgGlyph emoji="📐" /></div>
              <div class="pp-card-title">数学</div>
              <div class="pp-card-desc">逻辑与抽象之美</div>
            </div>
          </div>
          <div class="pp-grad">当前毛玻璃：{{ d.blur }}px · 圆角：{{ d.radius }}px</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dh-title { font-size:24px; font-weight:800; }
.tip { color:var(--zg-text-dim); font-size:13px; margin:6px 0 20px; }
.ink-note { padding:10px 12px; border-radius:10px; background:rgba(var(--zg-primary-rgb),.08); border:1px dashed rgba(var(--zg-primary-rgb),.35); margin:0 0 14px; }
.theme-row { display:grid; grid-template-columns:380px 1fr; gap:24px; }
.edit-panel { padding:24px; height:fit-content; }
.ep-section { margin-bottom:22px; }
.ep-label { font-size:13px; color:var(--zg-text-dim); margin-bottom:10px; font-weight:600; }
.preset-row { display:flex; flex-wrap:wrap; gap:8px; }
.preset-chip { display:flex; align-items:center; gap:8px; padding:6px 12px; border-radius:20px; background:rgba(var(--zg-primary-rgb),.06); cursor:pointer; font-size:13px; border:1px solid transparent; }
.preset-chip.on { border-color:var(--zg-primary); background:rgba(var(--zg-primary-rgb),.15); }
.pc-dot { width:14px; height:14px; border-radius:50%; }
.color-row { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.color-val { font-size:13px; color:var(--zg-text-dim); font-family:monospace; }
.swatches { display:flex; gap:6px; }
.sw { width:20px; height:20px; border-radius:6px; cursor:pointer; border:1px solid rgba(var(--zg-primary-rgb),.3); }
.bg-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bg-row span { font-size:12px; color:var(--zg-text-dim); }
.ep-actions { display:flex; gap:12px; margin-top:24px; }
.pp-label { font-size:13px; color:var(--zg-text-dim); margin-bottom:10px; font-weight:600; }
.pp-demo { padding:24px; }
.pp-nav { display:flex; align-items:center; gap:16px; padding:12px 20px; border-radius:14px; margin-bottom:20px; flex-wrap:wrap; }
.pp-logo { font-weight:800; }
.pp-link { font-size:14px; color:var(--zg-text-dim); }
.pp-link.on { color:var(--zg-text); background:var(--zg-primary); padding:4px 10px; border-radius:8px; }
.pp-cards { display:grid; grid-template-columns:repeat(2,1fr); gap:16px; margin-bottom:20px; }
.pp-card { padding:18px; }
.pp-card-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; margin-bottom:10px; }
.pp-card-title { font-weight:700; }
.pp-card-desc { font-size:12px; color:var(--zg-text-dim); margin-top:2px; }
.pp-grad { font-size:12px; color:var(--zg-text-dim); text-align:center; padding-top:16px; border-top:1px dashed rgba(var(--zg-primary-rgb),.15); }
@media (max-width:980px){ .theme-row{grid-template-columns:1fr;} }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; }
  .tip { font-size: 12px; margin: 4px 0 14px; }
  .theme-row { grid-template-columns: 1fr; gap: 14px; }
  .edit-panel { padding: 16px; }
  .ep-section { margin-bottom: 16px; }
  .ep-label { font-size: 12px; margin-bottom: 8px; }
  .preset-row { gap: 6px; }
  .preset-chip { padding: 6px 10px; font-size: 12px; gap: 6px; }
  .color-row { gap: 8px; }
  .color-val { font-size: 12px; }
  .swatches { gap: 4px; }
  .sw { width: 18px; height: 18px; border-radius: 5px; }
  .bg-row { gap: 6px; }
  .bg-row .el-color-picker { --el-color-picker-trigger-size: 28px; }
  .ep-actions { flex-direction: column; gap: 8px; margin-top: 20px; }
  .ep-actions .el-button { width: 100%; height: 42px; }
  .pp-label { font-size: 12px; margin-bottom: 8px; }
  .pp-demo { padding: 16px; }
  .pp-nav { gap: 10px; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px; }
  .pp-logo { font-size: 14px; }
  .pp-link { font-size: 12px; }
  .pp-link.on { padding: 4px 8px; }
  .pp-cards { grid-template-columns: 1fr; gap: 10px; margin-bottom: 14px; }
  .pp-card { padding: 14px; }
  .pp-card-icon { width: 40px; height: 40px; border-radius: 10px; font-size: 20px; margin-bottom: 8px; }
  .pp-card-title { font-size: 14px; }
  .pp-card-desc { font-size: 11px; }
  .pp-grad { font-size: 11px; padding-top: 12px; }
}

@media (min-width: 1200px) {
  .dh-title { font-size: 30px; }
  .tip { font-size: 14px; margin: 8px 0 28px; }
  .theme-row { grid-template-columns: 420px 1fr; gap: 32px; }
  .edit-panel { padding: 32px; }
  .ep-section { margin-bottom: 28px; }
  .ep-label { font-size: 14px; margin-bottom: 12px; }
  .preset-row { gap: 12px; }
  .preset-chip { padding: 8px 16px; font-size: 14px; gap: 10px; border-radius: 24px; transition: all .2s ease; }
  .preset-chip:hover { background: rgba(var(--zg-primary-rgb),.12); }
  .color-row { gap: 16px; }
  .color-val { font-size: 14px; }
  .swatches { gap: 8px; }
  .sw { width: 26px; height: 26px; border-radius: 8px; transition: transform .2s ease; }
  .sw:hover { transform: scale(1.15); }
  .bg-row { gap: 12px; }
  .ep-actions { gap: 16px; margin-top: 32px; }
  .ep-actions .el-button { padding: 12px 28px; height: 44px; font-size: 15px; }
  .pp-label { font-size: 14px; margin-bottom: 14px; }
  .pp-demo { padding: 32px; }
  .pp-nav { gap: 20px; padding: 14px 28px; border-radius: 18px; margin-bottom: 28px; }
  .pp-logo { font-size: 18px; }
  .pp-link { font-size: 15px; }
  .pp-link.on { padding: 6px 14px; border-radius: 10px; }
  .pp-cards { grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 28px; }
  .pp-card { padding: 24px; border-radius: 16px; transition: transform .2s ease; }
  .pp-card:hover { transform: translateY(-4px); }
  .pp-card-icon { width: 56px; height: 56px; border-radius: 14px; font-size: 28px; margin-bottom: 12px; }
  .pp-card-title { font-size: 16px; }
  .pp-card-desc { font-size: 13px; }
  .pp-grad { font-size: 13px; padding-top: 20px; }
}
</style>