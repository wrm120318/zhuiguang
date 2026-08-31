import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './styles/main.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { zgCover } from '@/utils/helpers'

// v2.1.1 - 修复自定义域名白屏问题
const app = createApp(App)
app.use(createPinia())
app.use(router)

// 全局图片兜底：任何外链图（picsum/supabase 等境外图床）加载失败时，
// 换成 Bing 高清美图，避免破图/空白。一个元素只处理一次，且新图与旧图相同则跳过（防死循环）。
document.addEventListener(
  'error',
  (e) => {
    const t = e.target as HTMLElement | null
    if (!t || t.tagName !== 'IMG') return
    const img = t as HTMLImageElement
    if (img.dataset.zgFixed) return
    const next = zgCover(img.alt || img.getAttribute('src') || 'zhuiguang')
    if (next === img.src) return
    img.dataset.zgFixed = '1'
    img.src = next
  },
  true
)

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

// 【v4.2.9 SW 清理强化】v4.2.7 注册的 sw-download.js 残留 SW 干扰上传。
//   1) 物理文件已删（public/sw-download.js 不再随部署发布）
//   2) 强化 unregister 流程：等所有 SW 真正 unregister 后才解除阻塞
//   3) 防御性：旧 SW 在 unregister 完成前仍可能拦截 fetch，给用户一次强刷提示
async function cleanupLegacySW(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    if (!regs.length) return
    console.info(`[zg-cleanup] 发现 ${regs.length} 个遗留 Service Worker，正在清理...`)
    // 等待所有 unregister 真正完成
    await Promise.all(
      regs.map(async (reg) => {
        try { await reg.unregister() } catch { /* noop */ }
      })
    )
    console.info('[zg-cleanup] 所有遗留 Service Worker 已清理完毕')
  } catch (e) {
    console.warn('[zg-cleanup] SW 清理失败（非阻塞）:', e)
  }
}
// 不阻塞主流程：异步执行 SW 清理
cleanupLegacySW().catch(() => {})
