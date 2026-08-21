<script setup lang="ts">
import { computed } from 'vue'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { useThemeStore } from '@/store/theme'

// 墨金模式下把常见 emoji 自动映射为对应的金色 SVG 图标；经典模式保持原 emoji（与现状一致）。
const props = defineProps<{ emoji: string; icon?: string }>()

const theme = useThemeStore()
const isGold = computed(() => theme.activeTheme?.config?.designMode === 'inkgold')

const EMOJI_MAP: Record<string, string> = {
  // 箭头 / 方向符号
  '←': 'ArrowLeft', '↑': 'ArrowUp', '→': 'ArrowRight', '↓': 'ArrowDown', '⇄': 'Switch',
  '⏱': 'Timer', '⏳': 'Loading', '▲': 'CaretTop', '▼': 'CaretBottom',
  '☁': 'Cloudy', '☰': 'Operation', '⚙': 'Setting',
  '⚠': 'Warning', '⚡': 'Lightning',
  // 勾叉 / 状态
  '✅': 'CircleCheck', '✉': 'ChatDotRound', '✍': 'EditPen', '✏': 'EditPen',
  '✓': 'Check', '✕': 'Close', '✗': 'Close', '❌': 'CircleClose',
  '⬇': 'Bottom', '⭐': 'Star',
  // 学科 / 通用
  '🌐': 'Connection', '🌟': 'Star',
  '🎁': 'Present', '🎉': 'Trophy', '🎓': 'School', '🎨': 'Brush', '🎬': 'Film',
  '🎯': 'Aim', '🏆': 'Trophy', '🏋': 'Basketball', '🏛': 'OfficeBuilding',
  '🏠': 'HomeFilled', '🏫': 'School', '🏷': 'PriceTag',
  '👁': 'View', '👍': 'Pointer', '👤': 'User', '👥': 'UserFilled',
  '💬': 'ChatLineRound', '💰': 'Coin', '💻': 'Monitor', '💾': 'Document',
  '📁': 'Folder', '📂': 'FolderOpened', '📄': 'Document', '📅': 'Calendar',
  '📈': 'TrendCharts', '📊': 'DataLine', '📋': 'Tickets', '📌': 'LocationFilled',
  '📎': 'Paperclip', '📐': 'Compass', '📔': 'Notebook', '📖': 'Notebook',
  '📗': 'Notebook', '📘': 'Notebook', '📚': 'Reading', '📜': 'Memo', '📝': 'Edit',
  '📢': 'Promotion', '📤': 'Upload', '📥': 'Download', '📦': 'Box', '📧': 'ChatDotRound',
  '📱': 'Cellphone', '📷': 'Camera', '📽': 'VideoCamera', '🔄': 'Refresh', '🔌': 'Connection',
  '🔍': 'Search', '🔐': 'Lock', '🔑': 'Key', '🔒': 'Lock', '🔔': 'Bell', '🔗': 'Link',
  '🔤': 'ZoomIn', '🔥': 'Lightning', '🔧': 'Tools',
  '🔴': 'Warning', '🔵': 'CircleCheck', '🕐': 'Clock', '🕒': 'Clock',
  '🖐': 'Pointer', '🖥': 'Monitor', '🖼': 'Picture', '🗄': 'Files', '🗑': 'Delete',
  '🗜': 'Files', '🗞': 'Postcard', '🚀': 'Promotion', '🚩': 'Flag', '🚪': 'SwitchButton',
  '🚫': 'CircleClose', '🛠': 'Tools', '🛡': 'Lock', '🟡': 'Warning', '🟢': 'CircleCheck',
  '🤍': 'Star', '🤖': 'Cpu', '🥇': 'GoldMedal', '🥈': 'Medal', '🥉': 'Medal',
  '🧑': 'User', '🧩': 'Grid', '🧬': 'Connection', '🧹': 'Brush',
}

// BUG-02 修复：EP 图标库没有 Globe/LightBulb/Heart/Microscope/Flask 等图标（原映射指向不存在的
// 图标名会在墨金下回退成 emoji；❤→Medal/🎭→Star/🔢→Sort 等属语义错映射）。
// 此处整组自绘线性 SVG（stroke=currentColor、2px 线宽、圆角端点——与 EP 线性风格一致），
// 守铁律 6/7：语义优先、组内风格统一；奖牌仍是上方 MEDALS 的自绘数字奖牌。
// 键为 norm() 归一化后的写法（'❤️'→'❤'、'⚗️'→'⚗'）。
const SELF_SVG: Record<string, string> = {
  // 🌍 地球（地理）：圆 + 经纬线
  '🌍': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9.5h17M3.5 14.5h17"/>',
  '🌎': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9.5h17M3.5 14.5h17"/>',
  '🌏': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9.5h17M3.5 14.5h17"/>',
  // 💡 灯泡（物理/创意/提示）
  '💡': '<path d="M12 3a6 6 0 0 1 4.2 10.3c-.8.7-1.4 1.6-1.6 2.7H9.4c-.2-1.1-.8-2-1.6-2.7A6 6 0 0 1 12 3z"/><path d="M9.5 19h5M10.5 21.5h3"/><path d="M12 7.5v3"/>',
  // 🔬 显微镜（科学）
  '🔬': '<path d="M6 18h8"/><path d="M3 22h18"/><path d="M14 22a7 7 0 1 0 0-14h-1"/><path d="M9 14h2"/><path d="M9 12a2 2 0 0 1-2-2V6h6v4a2 2 0 0 1-2 2Z"/><path d="M12 6V3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3"/>',
  // ⚗ 锥形瓶（化学）
  '⚗': '<path d="M10 2v7.5a2 2 0 0 1-.2.9L4.7 20.6a1 1 0 0 0 .9 1.4h12.8a1 1 0 0 0 .9-1.4L14.2 10.4a2 2 0 0 1-.2-.9V2"/><path d="M8.5 2h7"/><path d="M7 16h10"/>',
  // 🎭 戏剧面具（表演艺术）
  '🎭': '<path d="M5 4c4 1.2 10 1.2 14 0v9a7 7 0 0 1-14 0z"/><path d="M9 11c.5-.8 1.5-.8 2 0M13 11c.5-.8 1.5-.8 2 0"/><path d="M10 15.5c1.3 1 2.7 1 4 0"/>',
  // ❤ 点赞爱心（实心，与其他 EP Filled 变体风格协调）
  '❤': '<path fill="currentColor" stroke="none" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
  // 🔢 数字（数学/计算）：计算器线框
  '🔢': '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
  // —— 学科/通用补充（与上方同款 2px 圆角线性风格，守铁律6/7）——
  '⚽': '<circle cx="12" cy="12" r="9"/><path d="M12 8l2.4 2-1 3.1L8.8 13l1-3.1z"/><path d="M12 3.2v2.4M20 11l-2 1.2M16 19.6l-2-1.6M8 19.6l2-1.6M4 11l2 1.2"/>',
  '🎵': '<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  '🌱': '<path d="M12 21v-7"/><path d="M12 14c0-3 2-5 5-5 0 3-2 5-5 5z"/><path d="M12 12c0-2.5-2-4-4.5-4 0 2.5 2 4 4.5 4z"/>',
  '🧪': '<path d="M9 3h6"/><path d="M10 3v4l-4 9a1 1 0 0 0 .9 1.5h10.2a1 1 0 0 0 .9-1.5l-4-9V3"/><path d="M7.5 13.5h9"/>',
  '🔭': '<path d="M5 15l6-2.5 3.5 3.5-4 3z"/><path d="M11 12.5l5.5-8.5 1.8 1.2-5 8.5"/><path d="M9 18h8"/>',
  '🧠': '<path d="M12 6.5a2.8 2.8 0 0 0-2.8 2.8c-1.4.2-2.2 1.4-2.2 2.7 0 1 .6 1.9 1.5 2.3-.2 1 .4 2 1.5 2.3.8.2 1.6-.2 2-1V6.5z"/><path d="M12 6.5a2.8 2.8 0 0 1 2.8 2.8c1.4.2 2.2 1.4 2.2 2.7 0 1-.6 1.9-1.5 2.3.2 1-.4 2-1.5 2.3-.8.2-1.6-.2-2-1"/>',
  '⚖️': '<path d="M12 3v17"/><path d="M5 7h14"/><path d="M5 7l-2.5 5.5h5z"/><path d="M19 7l-2.5 5.5h5z"/><path d="M8.5 20h7"/>',
  '🩺': '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/>',
  '🗣️': '<path d="M5 6h9a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3l-3 3v-3H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M9 9.5v1.8M12 9.5v1.8"/>',
  '🧮': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
  '🏺': '<path d="M8.5 3h7"/><path d="M9.5 3c0 2-1 3-1 5 0 4 2 8 3.5 11 1.5-3 3.5-7 3.5-11 0-2-1-3-1-5"/><path d="M9.5 8h5"/>',
  '🎹': '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 6v6M11 6v6M15 6v6M19 6v6"/>',
  '🎸': '<path d="M7 17a3 3 0 1 0 2.6 4.5"/><path d="M9.6 21.5L20 11l-1.4-1.4L8.2 20.1"/><path d="M16 7l1-3 3 1"/>',
  '🏊': '<path d="M3 15c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1"/><circle cx="9" cy="8" r="2.2"/><path d="M11.2 8H17"/><path d="M9 10.4c2 1 4 1 6 0"/>',
  '🚴': '<circle cx="6" cy="16" r="3"/><circle cx="18" cy="16" r="3"/><path d="M6 16l4-7h5l3 7M10 9l2 7"/>',
}

// 奖牌：EP 图标库无"带数字金银铜奖牌"，自绘 SVG（墨金模式渲染，经典保留 emoji）
const MEDALS: Record<string, { color: string; num: string }> = {
  '🥇': { color: '#FFD700', num: '1' },
  '🥈': { color: '#C0C0C0', num: '2' },
  '🥉': { color: '#CD7F32', num: '3' },
}
const medal = computed(() => {
  const key = norm(props.emoji)
  return MEDALS[key] || MEDALS[props.emoji] || null
})

// 自绘线性 SVG（优先级：奖牌 > 自绘 > EP 映射 > 原样 emoji）
const selfSvg = computed(() => {
  const key = norm(props.emoji)
  return SELF_SVG[key] || SELF_SVG[props.emoji] || ''
})

// 归一化：去掉变体选择符(U+FE0x)后再查表，兼容 "✍️"(基+VS16) 与 "✍"(基) 两种写法
const norm = (s: string) => s.replace(/[️︎︯]/g, '').replace(/[\uFE00-\uFE0F]/g, '')

const iconName = computed(() => {
  if (props.icon) return props.icon
  const key = norm(props.emoji)
  return EMOJI_MAP[key] || EMOJI_MAP[props.emoji] || ''
})
const iconComp = computed(() => (iconName.value ? (ElementPlusIconsVue as Record<string, any>)[iconName.value] : null))
</script>

<template>
  <svg v-if="isGold && medal" class="zg-medal" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10.5" :fill="medal.color" stroke="rgba(0,0,0,0.14)" stroke-width="1" />
    <circle cx="12" cy="12" r="7.5" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1" />
    <text x="12" y="16.5" text-anchor="middle" font-size="11" font-weight="800" fill="#fff">{{ medal.num }}</text>
  </svg>
  <svg v-else-if="isGold && selfSvg" class="zg-glyph zg-self-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="selfSvg"></svg>
  <el-icon v-else-if="isGold && iconComp" class="zg-glyph"><component :is="iconComp" /></el-icon>
  <span v-else class="zg-glyph-emoji">{{ emoji }}</span>
</template>

<style scoped>
.zg-glyph { vertical-align: -2px; }
.zg-self-svg { width: 1em; height: 1em; display: inline-block; vertical-align: -0.15em; }
.zg-glyph-emoji { line-height: 1; }
.zg-medal { width: 1em; height: 1em; vertical-align: -0.18em; display: inline-block; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.18)); }
</style>
