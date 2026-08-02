<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { useThemeStore } from '@/store/theme'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { useSettingsStore } from '@/store/settings'
import NavBar from '@/components/NavBar.vue'
import MobileTabBar from '@/components/MobileTabBar.vue'

const route = useRoute()
const theme = useThemeStore()
const user = useUserStore()
const data = useDataStore()
const settings = useSettingsStore()
const ready = ref(false)
const isPublicPage = computed(() => route.meta.public === true)
const isAdminRoute = computed(() => route.path.startsWith('/admin'))

// 在 body 上标记 admin 路由，便于全局 CSS 在手机端隐藏冗余的全局顶栏/底栏
watchEffect(() => {
  document.body.classList.toggle('is-admin-route', isAdminRoute.value)
})

onMounted(async () => {
  try {
    await theme.load()
    if (user.isLogin) {
      await user.fetchProfile().catch(() => {})
      await Promise.all([data.loadCommon(), settings.fetchAll().catch(() => {})])
    }
  } finally {
    ready.value = true
  }
})
</script>

<template>
  <div class="zg-bg"></div>
  <div class="zg-orb a"></div>
  <div class="zg-orb b"></div>
  <div class="zg-orb c"></div>
  <template v-if="!isPublicPage">
    <NavBar v-if="ready" />
    <main class="app-main" :class="{ 'has-tabbar': ready && user.isLogin && !isAdminRoute }">
      <router-view v-if="ready" v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
      <div v-else class="boot">✨ 追光加载中…</div>
    </main>
    <MobileTabBar v-if="ready && user.isLogin && !isAdminRoute" />
  </template>
  <template v-else>
    <main class="app-main public-page">
      <router-view v-if="ready" v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
      <div v-else class="boot">✨ 追光加载中…</div>
    </main>
  </template>
</template>

<style scoped>
.app-main { min-height: calc(100vh - 64px); }
.app-main.public-page { min-height: 100vh; }
.has-tabbar { padding-bottom: 64px; }
.boot { display:flex; align-items:center; justify-content:center; height:80vh; color:var(--zg-text-dim); font-size:16px; }
.public-page .boot { height: 100vh; }
@media (max-width: 768px) {
  .app-main:not(.public-page) { min-height: calc(100vh - 56px); }
}
</style>
