// @ts-ignore
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import path from 'path'
import { writeFileSync, existsSync } from 'fs'

// ---------------------------------------------------------------------------
// 【v4.17.2 首屏减重 · element-plus 按需引入（自定义 resolver）】
// 现象：国内网络访问站点数分钟全白（标题栏已有标题=HTML 已到，JS/CSS 卡住）。
//       实测首屏需下载 element-plus chunk 1.09MB + CSS 732KB + vue-vendor 113KB，
//       20~50KB/s 链路下正好数分钟 —— 首屏体积是根本瓶颈。
// 根因：官方 ElementPlusResolver 对所有组件返回 from: 'element-plus/es'（barrel）。
//       es/index.mjs 顶层 import 了全部 124 个组件（含 ElTour/ElSplitter/ElWatermark
//       等本项目从未使用的组件），Rollup 无法剔除 —— 实测 chunk 内 17 个冷门组件
//       全部在场，tree-shaking 完全失效。
// 修法：自定义 resolver，组件/API/指令一律指向 element-plus/es/components/<name>/
//       index.mjs 独立入口（exports map 的 ./es/* 规则放行该子路径），
//       每个组件只打包自己 + 依赖的 hooks，CSS sideEffects 与官方行为保持一致。
// 覆盖用法（构建前全仓扫描确认）：
//       ① 模板组件 47 种（el-button/el-table/el-dialog/...）
//       ② 脚本 API：ElMessage(427 处) / ElMessageBox(54) / ElNotification(2)
//       ③ 指令 v-loading(48 处)
//       ④ ElIconXxx → @element-plus/icons-vue（保留官方行为）
// ---------------------------------------------------------------------------
const EP_CDN_BASE = 'element-plus/es/components'

const kebabCase = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

// v-loading 等指令：模板 v-xxx → 插件剥掉 v 前缀后以 PascalCase 调用
const EP_DIRECTIVES: Record<string, { importName: string; dir: string }> = {
  Loading: { importName: 'vLoading', dir: 'loading' },
  Popover: { importName: 'ElPopoverDirective', dir: 'popover' },
  InfiniteScroll: { importName: 'ElInfiniteScroll', dir: 'infinite-scroll' },
}

// 子组件没有独立 index.mjs（只有 style/ 目录），从父组件目录出口导出：
// ElFormItem←form、ElTableColumn←table、ElTabPane←tabs、ElOption←select、
// ElDropdownItem/Menu←dropdown、ElAside/Footer/Header/Main←container 等。
// 键为 kebab-case 子组件名，值为父组件目录名。
const EP_SUB_COMPONENTS: Record<string, string> = {
  'anchor-link': 'anchor',
  aside: 'container',
  'avatar-group': 'avatar',
  'breadcrumb-item': 'breadcrumb',
  'button-group': 'button',
  'carousel-item': 'carousel',
  'checkbox-button': 'checkbox',
  'checkbox-group': 'checkbox',
  'collapse-item': 'collapse',
  'descriptions-item': 'descriptions',
  'dropdown-item': 'dropdown',
  'dropdown-menu': 'dropdown',
  footer: 'container',
  'form-item': 'form',
  header: 'container',
  main: 'container',
  'menu-item': 'menu',
  'menu-item-group': 'menu',
  option: 'select',
  'option-group': 'select',
  'radio-button': 'radio',
  'radio-group': 'radio',
  'skeleton-item': 'skeleton',
  'splitter-panel': 'splitter',
  step: 'steps',
  'sub-menu': 'menu',
  'table-column': 'table',
  'tab-pane': 'tabs',
  'timeline-item': 'timeline',
  'tour-step': 'tour',
}

const ElementPlusOnDemand = [
  {
    type: 'component',
    resolve: (name: string) => {
      if (!name.match(/^El[A-Z]/)) return
      // ElIconXxx → 图标库命名导出（与官方一致）
      if (name.match(/^ElIcon.+/)) {
        return { name: name.replace(/^ElIcon/, ''), from: '@element-plus/icons-vue' }
      }
      const partial = kebabCase(name.slice(2))
      const dir = EP_SUB_COMPONENTS[partial] || partial
      return {
        name,
        from: `${EP_CDN_BASE}/${dir}/index.mjs`,
        sideEffects: [
          `${EP_CDN_BASE}/base/style/css`,
          `${EP_CDN_BASE}/${partial}/style/css`,
        ],
      }
    },
  },
  {
    type: 'directive',
    resolve: (name: string) => {
      const d = EP_DIRECTIVES[name]
      if (!d) return
      return {
        name: d.importName,
        from: `${EP_CDN_BASE}/${d.dir}/index.mjs`,
        sideEffects: [
          `${EP_CDN_BASE}/base/style/css`,
          `${EP_CDN_BASE}/${d.dir}/style/css`,
        ],
      }
    },
  },
]

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: ElementPlusOnDemand }),
    Components({ resolvers: ElementPlusOnDemand })
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src'), '@shared': path.resolve(__dirname, 'shared') }
  },
  server: {
    host: '0.0.0.0', port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/uploads': { target: 'http://localhost:3001', changeOrigin: true }
    }
  },
  build: {
    cssCodeSplit: false,
    modulePreload: true,
    rollupOptions: {
      output: {
        // ---------------------------------------------------------------------------
        // 【v4.8.24 根治「主域白屏 —— CF 边缘缓存了 MIME 错误的 JS」】
        // 现象：访问 https://xkzg.de5.net 白屏，页面 0 个 input、body 文本为空。
        //       Chromium 控制台报：
        //         Refused to apply style from '.../style-DChl5NDa.css' because its MIME
        //         type ('text/html') is not a supported stylesheet MIME type
        //         Failed to load module script: Expected a JavaScript-or-Wasm module
        //         script but the server responded with a MIME type of "text/html"
        // 排查：同一时间同一 URL，
        //         curl        → content-type: application/javascript  ✅
        //         Chromium    → content-type: text/html               ❌（无论 h2 / h3）
        //       带 `?v=1` 时 cf-cache-status: MISS 且 MIME 正确 → 证明**源站正常，
        //       是 CF 边缘节点上缓存了一条脏响应**。
        //       脏条目的根源：public/_headers 给 /assets/* 设了
        //         `Cache-Control: public, max-age=31536000, immutable`
        //       一旦某次部署间隙某边缘节点回源拿到 SPA fallback（返回 index.html，
        //       MIME=text/html），这条错误响应就会被缓存**一整年**，且 immutable
        //       意味着客户端不会重新校验 → 该节点上的用户长期白屏。
        // 修法：让**入口文件名带上构建时间戳**，每次部署都是全新 URL，
        //       脏缓存自然失效；以后也再不会命中历史脏条目。
        //       入口不再长缓存没关系——它只被 index.html 引用，而 index.html 本来就
        //       是 `must-revalidate`，每次都会重新取。
        // 注意：其余懒加载 chunk / vendor chunk 仍用内容 hash（内容不变则复用缓存），
        //       只有入口（以及它引用的 CSS）强制换名，兼顾性能与「必然破缓存」。
        // ---------------------------------------------------------------------------
        entryFileNames: `assets/index-[hash]-${Date.now().toString(36)}.js`,
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          // CSS 也跟着入口走时间戳，避免 css 脏缓存同样白屏（样式全丢 + strict MIME 报错）
          const n = assetInfo.name || ''
          if (n.endsWith('.css')) return `assets/style-[hash]-${Date.now().toString(36)}[extname]`
          return 'assets/[name]-[hash][extname]'
        },
        // v4.4.29 性能：把重型依赖拆成独立 vendor chunk，缩小首屏主包、并行加载。
        // 经典/墨金视觉与全部功能保持不变，仅改变产物切分。
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('echarts') || id.includes('zrender')) return 'echarts'
          if (id.includes('xlsx')) return 'xlsx'
          if (id.includes('katex')) return 'katex'
          if (id.includes('marked')) return 'marked'
          if (id.includes('element-plus') || id.includes('@element-plus/icons-vue')) return 'element-plus'
          if (id.includes('axios')) return 'axios'
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('/pinia/') || id.includes('@vue/')) return 'vue-vendor'
        }
      }
    },
    // v2.1.1 - 禁用构建缓存，确保每次构建都生成新的 index.html
    sourcemap: false,
    emptyOutDir: true,
    manifest: false,
    // v2.1.14 - 添加 rollup 配置，避免 prompt() 问题
    chunkSizeWarningLimit: 1000,
  },
  // v2.1.15 - 强制 CSS 文件名带时间戳，避免缓存问题
  css: {
    modules: {
      localsConvention: 'camelCase'
    }
  }
})
