// @ts-ignore
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import path from 'path'
import { writeFileSync, existsSync } from 'fs'

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] })
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
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
