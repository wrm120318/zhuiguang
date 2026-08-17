import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './styles/main.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

// v2.1.1 - 修复自定义域名白屏问题
const app = createApp(App)
app.use(createPinia())
app.use(router)

// 全局注册本项目用到的图标组件（@element-plus/icons-vue 已随 element-plus 安装）
// 经典模式也启用 SVG 图标（决策 A：图标全局替换），仅替换原先的 emoji，不改变布局/配色
const ZG_ICONS = [
  'Search', 'ChatDotRound', 'Setting', 'Bell', 'Menu', 'Close', 'User', 'Trophy', 'Star',
  'SwitchButton', 'HomeFilled', 'Reading', 'Notebook', 'EditPen', 'Promotion', 'Edit',
  'ZoomIn', 'Key', 'DataLine', 'UserFilled', 'School', 'CircleCheck', 'TrendCharts',
  'Tickets', 'Grid', 'Brush', 'Monitor', 'ArrowLeft', 'Tools', 'Loading',
]
for (const name of ZG_ICONS) {
  app.component(name, (ElementPlusIconsVue as Record<string, any>)[name])
}

// 全局注册 ZgGlyph：emoji → 金色 SVG 双渲染（墨金模式显示 SVG，经典模式显示原 emoji）
import ZgGlyph from './components/ZgGlyph.vue'
app.component('ZgGlyph', ZgGlyph)

app.mount('#app')
