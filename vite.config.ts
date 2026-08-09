import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import path from 'path'

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
        manualChunks: {
          'element-plus-color-picker': ['element-plus/es/components/color-picker/index'],
          'element-plus-input-number': ['element-plus/es/components/input-number/index'],
          'element-plus-switch': ['element-plus/es/components/switch/index'],
        }
      }
    }
  }
})
