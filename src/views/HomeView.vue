<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { useSettingsStore } from '@/store/settings'
import { api } from '@/api'
import { useThemeStore } from '@/store/theme'
import { renderMarkdownPreserveSpaces } from '@/utils/markdown'

const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const settings = useSettingsStore()
const theme = useThemeStore()
const articles = ref<any[]>([])
const stats = ref<any>({})

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

// 使用共享的站点配置，避免多个组件独立加载导致闪烁
const siteConfig = computed(() => settings.siteConfig)
const configLoaded = computed(() => settings.siteConfigLoaded)

// 默认快捷入口（与后台 SiteConfigView 默认值一致）
// A7 修复：默认 color 置空 → 走统一暖金浅底；后台自定义 color 照常生效（铁律4）
const defaultQuickLinks = [
  { icon: '📚', label: '学科广场', path: '/subjects', color: '' },
  { icon: '🏆', label: '经验排行', path: '/leaderboard', color: '' },
  { icon: '👤', label: '个人中心', path: '/profile', color: '' },
  { icon: '⭐', label: '我的收藏', path: '/favorites', color: '' },
]

// 计算最终展示的快捷入口：配置加载完成前不渲染，避免闪烁
const displayQuickLinks = computed(() => {
  if (!configLoaded.value) return null
  if (siteConfig.value?.showQuickLinks === false) return []
  if (siteConfig.value?.quickLinks?.length) return siteConfig.value.quickLinks
  return defaultQuickLinks
})

// 图标样式（A7 规格）：后台自定义 color → 照常渲染实色渐变（铁律4：自定义优先）；
// 无 color（默认态）→ 暖金浅底 rgba(var(--zg-primary-rgb), .10) + 主色图标（不再杂色实色渐变）
function iconStyle(color?: string) {
  if (!color) {
    const cfg: any = theme.activeTheme?.config
    const a = cfg?.designMode === 'inkgold' && cfg?.inkgoldTone === 'dark' ? 0.12 : 0.10
    return { background: `rgba(var(--zg-primary-rgb), ${a})`, color: 'var(--zg-primary)' }
  }
  return { background: `linear-gradient(135deg, ${color}, ${color}aa)` }
}

// 公告栏：配置加载完成前不渲染，避免闪烁
const showAnnouncement = computed(() => {
  if (!configLoaded.value) return false
  return siteConfig.value?.showAnnouncementBar && siteConfig.value?.announcementBar
})

const error = ref(false)

async function load() {
  error.value = false
  try {
    // 确保站点配置已加载（App.vue 也会触发，这里做兜底）
    if (!settings.siteConfigLoaded) await settings.fetchSiteConfig()
    if (!data.subjects.length) await data.fetchSubjects()
    // 并行加载文章和统计数据（站点配置已由 settings store 管理）
    const [artsRes, statsRes] = await Promise.allSettled([
      api.articles({ limit: 6 }),
      api.stats(),
    ])
    if (artsRes.status === 'fulfilled') articles.value = artsRes.value as any
    if (statsRes.status === 'fulfilled') stats.value = statsRes.value as any
  } catch { error.value = true }
}
onMounted(load)

async function onRefresh(done: () => void) {
  await load()
  done()
}

function goArticle(id: number) { router.push(`/article/${id}`) }
</script>

<template>
  <ZgPullRefresh class="page zg-container" @refresh="onRefresh">
    <ZgNetworkError v-if="error" @retry="load" />
    <template v-else>
      <!-- Hero -->
      <div class="hero glass-strong zg-slide-up">
      <div class="hero-bg"></div>
      <div class="hero-content">
        <div class="hero-tag"><ZgGlyph :emoji="'🌟'" /> {{ siteConfig?.siteName || '追光学科共享平台' }}</div>
        <h1 class="hero-title">{{ greeting }}，<span class="zg-grad-text">{{ user.current?.realName || '追光者' }}</span>！</h1>
        <p class="hero-sub">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }} {{ siteConfig?.heroSubtitle || '在这里分享知识，收获成长。' }}</p>
        <div class="hero-stats" v-if="user.isLogin && (siteConfig?.showHeroStats !== false)">
          <div class="hs-item">
            <div class="hs-num"><ZgCountUp :value="user.current?.exp || 0" /></div>
            <div class="hs-label">经验值</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num">Lv.<ZgCountUp :value="user.current?.level || 1" /></div>
            <div class="hs-label">等级</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num"><ZgCountUp :value="stats.articles || 0" /></div>
            <div class="hs-label">美文</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num"><ZgCountUp :value="stats.resources || 0" /></div>
            <div class="hs-label">资料</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 公告栏：配置加载完成后才渲染，避免闪烁 -->
    <div v-if="showAnnouncement" class="announce-bar glass zg-slide-up" style="animation-delay:0.1s">
      <span class="ab-icon"><ZgGlyph :emoji="'📢'" /></span>
      <span class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></span>
    </div>

    <!-- 快捷入口：配置加载完成后才渲染，避免先显示默认值再闪烁为自定义配置 -->
    <div class="quick-grid" v-if="displayQuickLinks && displayQuickLinks.length">
      <div v-for="(ql, i) in displayQuickLinks" :key="i" class="qg-card glass zg-card" @click="router.push(ql.path)">
        <div class="qg-icon" :style="iconStyle(ql.color)"><ZgGlyph :emoji="ql.icon" /></div>
        <div class="qg-text">{{ ql.label }}</div>
      </div>
    </div>

    <!-- 学科 -->
    <div class="section" v-if="data.subjects.length && (siteConfig?.showSubjects !== false)">
      <div class="section-title">学科子站</div>
      <div class="subj-row">
        <div v-for="s in data.subjects" :key="s.id" class="subj-chip glass zg-card" @click="router.push(`/subject/${s.slug}`)">
          <span class="sc-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></span>
          <span class="sc-name">{{ s.name }}</span>
        </div>
      </div>
    </div>

    <!-- 最新美文 -->
    <div class="section" v-if="articles.length && (siteConfig?.showLatestArticles !== false)">
      <div class="section-title">最新美文</div>
      <div class="art-grid">
        <div v-for="(a, i) in articles.slice(0, siteConfig?.maxArticlesOnHome || 6)" :key="a.id" class="art-card glass zg-card zg-slide-up" :style="{ animationDelay: `${i * 0.08}s` }" @click="goArticle(a.id)">
          <div class="ac-cover" v-if="a.cover" :style="{ backgroundImage: `url(${a.cover})` }"></div>
          <div class="ac-cover ac-placeholder" v-else>
            <span>{{ a.category?.[0] || '追' }}</span>
          </div>
          <div class="ac-body">
            <div class="ac-title">{{ a.title }}</div>
            <div class="ac-meta">
              <span>{{ a.author }}</span>
              <span class="ac-dot">·</span>
              <span>{{ a.created_at?.slice(5, 10) }}</span>
              <span class="ac-dot">·</span>
              <span><ZgGlyph :emoji="'❤'" /> {{ a.likes || 0 }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 页脚文字 -->
    <footer class="zg-footer" v-if="configLoaded && siteConfig?.footerText">
      <span v-html="renderMarkdownPreserveSpaces(siteConfig.footerText)"></span>
    </footer>
    </template>
  </ZgPullRefresh>
</template>

<style scoped>
.hero { position: relative; overflow: hidden; margin-top: 20px; border-radius: 24px; padding: 40px; }
.hero-bg { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),0.12), rgba(var(--zg-primary-2-rgb),0.08)); z-index: 0; }
.hero-content { position: relative; z-index: 1; }
.hero-tag { display: inline-block; padding: 6px 14px; border-radius: 30px; background: rgba(var(--zg-primary-rgb),.15); border: 1px solid rgba(var(--zg-primary-rgb),.3); font-size: var(--zg-fs-sm); color: #b45309; margin-bottom: 18px; font-weight: 500; }
.hero-title { font-size: var(--zg-fs-2xl); font-weight: 800; line-height: 1.3; }
.hero-sub { color: var(--zg-text-dim); margin-top: 10px; font-size: var(--zg-fs-base); line-height: 1.6; }
.hero-stats { display: flex; align-items: center; gap: 20px; margin-top: 28px; }
.hs-item { text-align: center; }
.hs-num { font-size: var(--zg-fs-xl); font-weight: 800; color: var(--zg-text); }
.hs-label { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 2px; }
.hs-divider { width: 1px; height: 30px; background: rgba(var(--zg-primary-rgb),.15); }

.quick-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 20px; }

.announce-bar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; margin-top: 14px; border-radius: 14px; border: 1px solid rgba(var(--zg-primary-rgb),.25); }
.ab-icon { font-size: 18px; }
.ab-text { font-size: var(--zg-fs-sm); color: var(--zg-text); line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }
.qg-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px 12px; cursor: pointer; }
.qg-icon { width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 26px; box-shadow: 0 4px 14px rgba(var(--zg-primary-rgb),.2); }
.qg-text { font-size: var(--zg-fs-sm); font-weight: 600; color: var(--zg-text); }

.section { margin-top: 28px; }
.subj-row { display: flex; gap: 12px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 8px; padding: 10px 16px; cursor: pointer; }
.sc-icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
.sc-name { font-weight: 600; font-size: var(--zg-fs-sm); }

.art-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.art-card { overflow: hidden; cursor: pointer; }
.ac-cover { height: 140px; background-size: cover; background-position: center; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.2), rgba(var(--zg-primary-2-rgb),.15)); font-size: 48px; font-weight: 800; color: rgba(var(--zg-primary-rgb),.3); }
.ac-body { padding: 14px 16px; }
.ac-title { font-weight: 700; font-size: var(--zg-fs-base); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); }
.ac-dot { opacity: .5; }

.zg-footer { text-align: center; padding: 32px 0 8px; margin-top: 40px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); opacity: 0.7; border-top: 1px dashed rgba(var(--zg-primary-rgb),.12); white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

@media (max-width: 768px) {
  .hero { padding: 24px 20px; border-radius: 18px; margin-top: 12px; }
  .hero-title { font-size: var(--zg-fs-xl); }
  .hero-sub { font-size: var(--zg-fs-sm); }
  .hero-stats { gap: 14px; margin-top: 20px; }
  .hs-num { font-size: var(--zg-fs-md); }
  .quick-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .qg-card { padding: 14px 6px; }
  .qg-icon { width: 42px; height: 42px; font-size: 20px; border-radius: 12px; }
  .qg-text { font-size: var(--zg-fs-xs); }
  .subj-row { gap: 8px; }
  .subj-chip { padding: 8px 12px; }
  .art-grid { grid-template-columns: 1fr; gap: 12px; }
  .ac-cover { height: 120px; }
}

@media (min-width: 1200px) {
  .hero { padding: 56px 52px; border-radius: 28px; }
  .hero-title { font-size: 42px; max-width: 800px; }
  .hero-sub { font-size: 17px; }
  .hero-stats { gap: 32px; margin-top: 36px; }
  .hs-num { font-size: 32px; }
  .hs-label { font-size: 13px; }
  .quick-grid { gap: 20px; margin-top: 28px; }
  .qg-card { padding: 28px 16px; }
  .qg-icon { width: 64px; height: 64px; border-radius: 20px; font-size: 30px; }
  .qg-text { font-size: 15px; }
  .subj-row { gap: 14px; }
  .subj-chip { padding: 14px 22px; }
  .sc-icon { width: 42px; height: 42px; }
  .sc-name { font-size: 15px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
}

@media (min-width: 1600px) {
  .art-grid { grid-template-columns: repeat(4, 1fr); }
}
</style>
