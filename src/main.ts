import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './styles/main.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

// v2.1.2 - 修复 Pages 构建缓存问题，强制重新构建
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
