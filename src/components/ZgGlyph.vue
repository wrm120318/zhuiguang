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
  '☁': 'Cloudy', '☰': 'Operation', '⚗': 'MagicStick', '⚙': 'Setting',
  '⚠': 'Warning', '⚡': 'Lightning',
  // 勾叉 / 状态
  '✅': 'CircleCheck', '✉': 'ChatDotRound', '✍': 'EditPen', '✏': 'EditPen',
  '✓': 'Check', '✕': 'Close', '✗': 'Close', '❌': 'CircleClose', '❤': 'Medal',
  '⬇': 'Bottom', '⭐': 'Star',
  // 学科 / 通用
  '🌍': 'Globe', '🌐': 'Connection', '🌟': 'Star',
  '🎁': 'Present', '🎉': 'Trophy', '🎓': 'School', '🎨': 'Brush', '🎬': 'Film',
  '🎭': 'Star', '🎯': 'Aim', '🏆': 'Trophy', '🏋': 'Basketball', '🏛': 'OfficeBuilding',
  '🏠': 'HomeFilled', '🏫': 'School', '🏷': 'PriceTag',
  '👁': 'View', '👍': 'Pointer', '👤': 'User', '👥': 'UserFilled',
  '💡': 'LightBulb', '💬': 'ChatLineRound', '💰': 'Coin', '💻': 'Monitor', '💾': 'Document',
  '📁': 'Folder', '📂': 'FolderOpened', '📄': 'Document', '📅': 'Calendar',
  '📈': 'TrendCharts', '📊': 'DataLine', '📋': 'Tickets', '📌': 'LocationFilled',
  '📎': 'Paperclip', '📐': 'ScaleToOriginal', '📔': 'Notebook', '📖': 'Notebook',
  '📗': 'Notebook', '📘': 'Notebook', '📚': 'Reading', '📜': 'Memo', '📝': 'Edit',
  '📢': 'Promotion', '📤': 'Upload', '📥': 'Download', '📦': 'Box', '📧': 'ChatDotRound',
  '📱': 'Cellphone', '📷': 'Camera', '📽': 'VideoCamera', '🔄': 'Refresh', '🔌': 'Connection',
  '🔍': 'Search', '🔐': 'Lock', '🔑': 'Key', '🔒': 'Lock', '🔔': 'Bell', '🔗': 'Link',
  '🔢': 'Sort', '🔤': 'ZoomIn', '🔥': 'Lightning', '🔧': 'Tools', '🔬': 'MagicStick',
  '🔴': 'Warning', '🔵': 'CircleCheck', '🕐': 'Clock', '🕒': 'Clock',
  '🖐': 'Pointer', '🖥': 'Monitor', '🖼': 'Picture', '🗄': 'Files', '🗑': 'Delete',
  '🗜': 'Files', '🗞': 'Postcard', '🚀': 'Promotion', '🚩': 'Flag', '🚪': 'SwitchButton',
  '🚫': 'CircleClose', '🛠': 'Tools', '🛡': 'Lock', '🟡': 'Warning', '🟢': 'CircleCheck',
  '🤍': 'Star', '🤖': 'Cpu', '🥇': 'GoldMedal', '🥈': 'Medal', '🥉': 'Medal',
  '🧑': 'User', '🧩': 'Grid', '🧬': 'Connection', '🧹': 'Brush',
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
  <el-icon v-else-if="isGold && iconComp" class="zg-glyph"><component :is="iconComp" /></el-icon>
  <span v-else class="zg-glyph-emoji">{{ emoji }}</span>
</template>

<style scoped>
.zg-glyph { vertical-align: -2px; }
.zg-glyph-emoji { line-height: 1; }
.zg-medal { width: 1em; height: 1em; vertical-align: -0.18em; display: inline-block; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.18)); }
</style>
