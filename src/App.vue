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
  <div class="zg-root">
    <div class="zg-bg"></div>
    <div class="zg-orb a"></div>
    <div class="zg-orb b"></div>
    <div class="zg-orb c"></div>

    <!-- 非公开页面 -->
    <template v-if="!isPublicPage">
      <NavBar v-if="ready" />
      <main class="app-main" :class="{ 'has-tabbar': ready && user.isLogin && !isAdminRoute }">
        <div v-if="!ready" class="boot">✨ 追光加载中…</div>
        <router-view v-else v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </main>
      <MobileTabBar v-if="ready && user.isLogin && !isAdminRoute" />
    </template>

    <!-- 公开页面 -->
    <template v-else>
      <main class="app-main public-page">
        <div v-if="!ready" class="boot">✨ 追光加载中…</div>
        <router-view v-else v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" :key="route.fullPath" />
          </transition>
        </router-view>
      </main>
    </template>
  </div>
</template>

<style scoped>
.zg-root { position: relative; }
.app-main { min-height: calc(100vh - 64px); }
.app-main.public-page { min-height: 100vh; }
.has-tabbar { padding-bottom: 64px; }
.boot { display:flex; align-items:center; justify-content:center; height:80vh; color:var(--zg-text-dim); font-size:16px; }
.public-page .boot { height: 100vh; }
@media (max-width: 768px) {
  .app-main:not(.public-page) { min-height: calc(100vh - 56px); }
}
</style>
