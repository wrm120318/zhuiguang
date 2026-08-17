<script setup lang="ts">
import { computed } from 'vue'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { useThemeStore } from '@/store/theme'

// 墨金模式下把常见 emoji 自动映射为对应的金色 SVG 图标；经典模式保持原 emoji（与现状一致）。
const props = defineProps<{ emoji: string; icon?: string }>()

const theme = useThemeStore()
const isGold = computed(() => theme.activeTheme?.config?.designMode === 'inkgold')

const EMOJI_MAP: Record<string, string> = {
  '📚': 'Reading', '🏆': 'Trophy', '👤': 'User', '⭐': 'Star', '🌟': 'Star',
  '📢': 'Promotion', '✍️': 'EditPen', '🔍': 'Search', '📦': 'Box', '⬇': 'Download',
  '💡': 'LightBulb', '📂': 'FolderOpened', '🗑': 'Delete', '📎': 'Paperclip',
  '📄': 'Document', '🔧': 'Tools', '⏳': 'Loading', '📝': 'Edit', '🔤': 'ZoomIn',
  '❤': 'Medal', '📊': 'DataLine', '👥': 'UserFilled', '🏫': 'School', '✅': 'CircleCheck',
  '📈': 'TrendCharts', '📋': 'Tickets', '🧩': 'Grid', '🎨': 'Brush', '🖥️': 'Monitor',
  '📖': 'Notebook', '🔑': 'Key', '📧': 'ChatDotRound', '✉️': 'ChatDotRound',
  '🚪': 'SwitchButton', '🏠': 'HomeFilled', '⚙️': 'Setting', '🔔': 'Bell', '☰': 'Menu',
  '🤖': 'Cpu', '📁': 'Folder', '🔗': 'Link', '🏷': 'PriceTag', '💬': 'ChatDotRound',
  '🗞': 'News', '📜': 'Memo', '🔒': 'Lock', '📌': 'LocationFilled', '🎯': 'Aim',
  '💰': 'Coin', '🕒': 'Clock', '🌐': 'Link',
}

const iconName = computed(() => props.icon || EMOJI_MAP[props.emoji] || '')
const iconComp = computed(() => (iconName.value ? (ElementPlusIconsVue as Record<string, any>)[iconName.value] : null))
</script>

<template>
  <el-icon v-if="isGold && iconComp" class="zg-glyph"><component :is="iconComp" /></el-icon>
  <span v-else class="zg-glyph-emoji">{{ emoji }}</span>
</template>

<style scoped>
.zg-glyph { vertical-align: -2px; }
.zg-glyph-emoji { line-height: 1; }
</style>
