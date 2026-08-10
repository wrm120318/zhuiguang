import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './styles/main.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

// v2.1.1 - 修复自定义域名白屏问题
const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
