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

// 全局注册 B5 品牌状态组件（空/搜索/错误/404 插画）与 B6 迷你折线图
import ZgState from './components/ZgState.vue'
import ZgSparkline from './components/ZgSparkline.vue'
app.component('ZgState', ZgState)
app.component('ZgSparkline', ZgSparkline)

// 全局注册 B 类通用组件：骨架屏 / 数字动画 / 三层头像 / 时间线 / 网络错误 / 下拉刷新
import ZgSkeleton from './components/ZgSkeleton.vue'
import ZgCountUp from './components/ZgCountUp.vue'
import ZgAvatar from './components/ZgAvatar.vue'
import ZgTimeline from './components/ZgTimeline.vue'
import ZgNetworkError from './components/ZgNetworkError.vue'
import ZgPullRefresh from './components/ZgPullRefresh.vue'
app.component('ZgSkeleton', ZgSkeleton)
app.component('ZgCountUp', ZgCountUp)
app.component('ZgAvatar', ZgAvatar)
app.component('ZgTimeline', ZgTimeline)
app.component('ZgNetworkError', ZgNetworkError)
app.component('ZgPullRefresh', ZgPullRefresh)

// 全局注册 B8 移动端抽屉右滑关闭手势指令
import { swipeClose } from './directives/swipeClose'
app.directive('swipe-close', swipeClose)

// 全局注册 B7 卡片左滑操作指令（移动端露出编辑/删除）
import { vSwipeAction } from './directives/swipeAction'
app.directive('swipe-action', vSwipeAction)

app.mount('#app')

// 【v4.2.7】注册 Service Worker：拦截 /api/download/* 路径，
//   实现「浏览器原生流式下载 + URL 完全不暴露 token + 不开新标签页」
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw-download.js')
      .then((reg) => {
        // 监听 SW 消息：收到 'zg_download:get_token' 时把 zg_token 传回去
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data?.type === 'zg_download:get_token') {
            const port = event.ports?.[0]
            const token = localStorage.getItem('zg_token') || ''
            try { port?.postMessage({ token }) } catch { /* SW 已 close */ }
          }
        })
        console.info('[zg-download] SW registered', reg.scope)
      })
      .catch((err) => {
        console.warn('[zg-download] SW register failed, fallback to v4.2.6 fetch+blob', err)
      })
  })
}
