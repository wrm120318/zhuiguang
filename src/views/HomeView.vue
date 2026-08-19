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

const siteConfig = computed(() => settings.siteConfig)
const configLoaded = computed(() => settings.siteConfigLoaded)

const defaultQuickLinks = [
  { icon: '📚', label: '学科广场', path: '/subjects', color: '' },
  { icon: '🏆', label: '经验排行', path: '/leaderboard', color: '' },
  { icon: '👤', label: '个人中心', path: '/profile', color: '' },
  { icon: '⭐', label: '我的收藏', path: '/favorites', color: '' },
]

const displayQuickLinks = computed(() => {
  if (!configLoaded.value) return null
  if (siteConfig.value?.showQuickLinks === false) return []
  if (siteConfig.value?.quickLinks?.length) return siteConfig.value.quickLinks
  return defaultQuickLinks
})

// 图标样式：后台自定义 color → 照常渲染实色渐变（铁律4：自定义优先）；
// 无 color（默认态）→ 液态玻璃图标（高饱和渐变 + 折射高光 + 阴影），在两档都漂亮
function iconStyle(color?: string) {
  if (!color) {
    // 液态玻璃图标：鲜亮主色渐变 + 玻璃高光
    return { background: `linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2))` }
  }
  return { background: `linear-gradient(135deg, ${color}, ${color}cc)` }
}

const showAnnouncement = computed(() => {
  if (!configLoaded.value) return false
  return siteConfig.value?.showAnnouncementBar && siteConfig.value?.announcementBar
})

const error = ref(false)

async function load() {
  error.value = false
  try {
    if (!settings.siteConfigLoaded) await settings.fetchSiteConfig()
    if (!data.subjects.length) await data.fetchSubjects()
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
  <ZgPullRefresh class="page zg-container home-page" @refresh="onRefresh">
    <ZgNetworkError v-if="error" @retry="load" />
    <template v-else>
      <!-- ★ 液态玻璃专属背景：浮在全局 .zg-bg 之上（不污染其他页面） -->
      <div class="home-bg" aria-hidden="true">
        <div class="home-bg-orb orb-1"></div>
        <div class="home-bg-orb orb-2"></div>
        <div class="home-bg-orb orb-3"></div>
        <div class="home-bg-orb orb-4"></div>
      </div>

      <!-- Hero：液态玻璃主面板 -->
      <div class="hero zg-slide-up">
        <div class="hero-shine"></div>
        <div class="hero-content">
          <div class="hero-tag"><ZgGlyph :emoji="'🌟'" /> {{ siteConfig?.siteName || '追光学科共享平台' }}</div>
          <h1 class="hero-title">{{ greeting }}，<span class="hero-name">{{ user.current?.realName || '追光者' }}</span></h1>
          <p class="hero-sub">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }}</p>
          <p class="hero-sub2">{{ siteConfig?.heroSubtitle || '在这里分享知识，收获成长。' }}</p>

          <!-- 数据统计：4 块独立玻璃瓦片 -->
          <div class="hero-stats" v-if="user.isLogin && (siteConfig?.showHeroStats !== false)">
            <div class="hs-tile">
              <div class="hs-num"><ZgCountUp :value="user.current?.exp || 0" /></div>
              <div class="hs-label">经验值</div>
            </div>
            <div class="hs-tile">
              <div class="hs-num">Lv.<ZgCountUp :value="user.current?.level || 1" /></div>
              <div class="hs-label">等级</div>
            </div>
            <div class="hs-tile">
              <div class="hs-num"><ZgCountUp :value="stats.articles || 0" /></div>
              <div class="hs-label">美文</div>
            </div>
            <div class="hs-tile">
              <div class="hs-num"><ZgCountUp :value="stats.resources || 0" /></div>
              <div class="hs-label">资料</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 公告栏：玻璃横条 + 左侧金条 -->
      <div v-if="showAnnouncement" class="announce-bar zg-slide-up" style="animation-delay:0.1s">
        <div class="ab-icon"><ZgGlyph :emoji="'📢'" /></div>
        <div class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></div>
      </div>

      <!-- 快捷入口：App-Icon 风格液态玻璃瓦片 -->
      <div class="quick-grid" v-if="displayQuickLinks && displayQuickLinks.length">
        <div v-for="(ql, i) in displayQuickLinks" :key="i" class="qg-tile zg-slide-up" :style="{ animationDelay: `${i * 0.06}s` }" @click="router.push(ql.path)">
          <div class="qg-icon" :style="iconStyle(ql.color)">
            <span class="qg-icon-shine"></span>
            <ZgGlyph :emoji="ql.icon" />
          </div>
          <div class="qg-text">{{ ql.label }}</div>
        </div>
      </div>

      <!-- 学科子站：玻璃胶囊 -->
      <div class="section" v-if="data.subjects.length && (siteConfig?.showSubjects !== false)">
        <div class="section-title">学科子站</div>
        <div class="subj-row">
          <div v-for="s in data.subjects" :key="s.id" class="subj-chip" @click="router.push(`/subject/${s.slug}`)">
            <span class="sc-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></span>
            <span class="sc-name">{{ s.name }}</span>
          </div>
        </div>
      </div>

      <!-- 最新美文：杂志感玻璃卡 -->
      <div class="section" v-if="articles.length && (siteConfig?.showLatestArticles !== false)">
        <div class="section-title">最新美文</div>
        <div class="art-grid">
          <div v-for="(a, i) in articles.slice(0, siteConfig?.maxArticlesOnHome || 6)" :key="a.id" class="art-card zg-slide-up" :style="{ animationDelay: `${i * 0.08}s` }" @click="goArticle(a.id)">
            <div class="ac-cover" v-if="a.cover" :style="{ backgroundImage: `url(${a.cover})` }">
              <div class="ac-cover-shine"></div>
            </div>
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
/* ★ 液态玻璃专属背景（仅 HomeView 范围内，绝对定位不污染其他页面） */
.home-page { position: relative; }
.home-bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; border-radius: inherit; }
.home-bg-orb { position: absolute; border-radius: 50%; filter: blur(60px); will-change: transform; }
.home-bg-orb.orb-1 { width: 520px; height: 520px; top: -180px; right: -120px; background: radial-gradient(circle, rgba(var(--zg-primary-rgb),0.55), transparent 70%); animation: zgOrbFloat 22s ease-in-out infinite; }
.home-bg-orb.orb-2 { width: 440px; height: 440px; top: 30%; left: -160px; background: radial-gradient(circle, rgba(var(--zg-accent-rgb),0.45), transparent 70%); animation: zgOrbFloat 26s ease-in-out infinite reverse; }
.home-bg-orb.orb-3 { width: 380px; height: 380px; bottom: 5%; right: 10%; background: radial-gradient(circle, rgba(var(--zg-primary-2-rgb),0.50), transparent 70%); animation: zgOrbFloat 30s ease-in-out infinite; }
.home-bg-orb.orb-4 { width: 320px; height: 320px; top: 55%; left: 30%; background: radial-gradient(circle, rgba(var(--zg-primary-rgb),0.30), transparent 70%); animation: zgOrbFloat 24s ease-in-out infinite reverse; }
@keyframes zgOrbFloat {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(40px, -30px) scale(1.08); }
  66% { transform: translate(-30px, 25px) scale(0.95); }
}

/* ★ Hero 主面板：液态玻璃 + 顶光高光 + 底部暗影 + 折射边缘 */
.hero { position: relative; margin-top: 8px; border-radius: 32px; padding: 48px 44px 40px; overflow: hidden; background: rgba(255, 255, 255, 0.42); backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%); border: 1px solid rgba(255, 255, 255, 0.55); box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.7) inset, 0 -1px 0 0 rgba(120, 53, 15, 0.05) inset, 0 24px 60px -10px rgba(245, 158, 11, 0.22), 0 8px 24px -4px rgba(120, 53, 15, 0.10); }
.hero-shine { position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.95) 30%, rgba(255,255,255,0.95) 70%, transparent); pointer-events: none; }
.hero-shine::after { content:''; position: absolute; top: 0; left: 0; right: 0; height: 80px; background: linear-gradient(180deg, rgba(255,255,255,0.35), transparent); pointer-events: none; }
.hero-content { position: relative; z-index: 1; }
.hero-tag { display: inline-flex; align-items: center; gap: 6px; padding: 6px 16px; border-radius: 999px; background: rgba(255, 255, 255, 0.5); border: 1px solid rgba(255, 255, 255, 0.6); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); font-size: 13px; color: var(--zg-primary); margin-bottom: 20px; font-weight: 600; letter-spacing: 0.2px; }
.hero-title { font-size: 36px; font-weight: 800; line-height: 1.25; letter-spacing: -1px; color: var(--zg-text); margin: 0; }
.hero-name { background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.hero-sub { color: var(--zg-text); margin: 14px 0 0; font-size: 16px; line-height: 1.7; max-width: 580px; opacity: 0.85; font-weight: 500; }
.hero-sub2 { color: var(--zg-text-dim); margin: 6px 0 0; font-size: 14px; line-height: 1.7; max-width: 580px; }

/* Hero 数据瓦片：4 块独立液态玻璃 */
.hero-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 32px; }
.hs-tile { padding: 18px 12px; border-radius: 18px; background: rgba(255, 255, 255, 0.45); backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.5); text-align: center; transition: all .3s cubic-bezier(.22,1,.36,1); box-shadow: 0 2px 8px rgba(120, 53, 15, 0.04), 0 1px 0 0 rgba(255, 255, 255, 0.6) inset; }
.hs-tile:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.6); box-shadow: 0 8px 20px rgba(245, 158, 11, 0.12), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.hs-num { font-size: 26px; font-weight: 800; color: var(--zg-text); line-height: 1.1; letter-spacing: -0.5px; }
.hs-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; font-weight: 500; }

/* 公告栏：玻璃横条 + 左侧金条 */
.announce-bar { display: flex; align-items: center; gap: 12px; padding: 14px 20px; margin-top: 16px; border-radius: 16px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); border-left: 3px solid var(--zg-primary); box-shadow: 0 4px 16px rgba(120, 53, 15, 0.06), 0 1px 0 0 rgba(255, 255, 255, 0.6) inset; }
.ab-icon { font-size: 20px; flex: none; }
.ab-text { font-size: 14px; color: var(--zg-text); line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }

/* 快捷入口：App-Icon 风格液态玻璃瓦片 */
.quick-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 20px; }
.qg-tile { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 12px 18px; border-radius: 24px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); cursor: pointer; transition: all .32s cubic-bezier(.22,1,.36,1); box-shadow: 0 4px 16px rgba(120, 53, 15, 0.06), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.qg-tile:hover { transform: translateY(-4px) scale(1.02); background: rgba(255, 255, 255, 0.7); border-color: rgba(255, 255, 255, 0.8); box-shadow: 0 20px 40px -8px rgba(245, 158, 11, 0.25), 0 8px 16px -4px rgba(120, 53, 15, 0.12), 0 1px 0 0 rgba(255, 255, 255, 0.8) inset; }
.qg-icon { position: relative; width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 26px; color: #fff; box-shadow: 0 8px 20px -4px rgba(245, 158, 11, 0.45), 0 3px 8px -2px rgba(0, 0, 0, 0.12), inset 0 1px 0 0 rgba(255, 255, 255, 0.4), inset 0 -2px 4px rgba(0, 0, 0, 0.08); overflow: hidden; }
.qg-icon-shine { position: absolute; top: 0; left: 0; right: 0; height: 50%; background: linear-gradient(180deg, rgba(255,255,255,0.35) 0%, transparent 100%); pointer-events: none; }
.qg-text { font-size: 14px; font-weight: 600; color: var(--zg-text); letter-spacing: 0.2px; }

/* 学科子站：玻璃胶囊 */
.section { margin-top: 36px; }
.section-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 10px; color: var(--zg-text); letter-spacing: 0.3px; }
.section-title::before { content: ''; width: 4px; height: 16px; border-radius: 3px; background: linear-gradient(180deg, var(--zg-accent), var(--zg-primary)); box-shadow: 0 0 8px rgba(var(--zg-primary-rgb), 0.4); }
.subj-row { display: flex; gap: 10px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 8px; padding: 10px 18px; cursor: pointer; border-radius: 999px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); transition: all .28s cubic-bezier(.22,1,.36,1); box-shadow: 0 2px 8px rgba(120, 53, 15, 0.05), 0 1px 0 0 rgba(255, 255, 255, 0.6) inset; }
.subj-chip:hover { transform: translateY(-2px); border-color: rgba(255, 255, 255, 0.8); background: rgba(255, 255, 255, 0.7); box-shadow: 0 10px 24px -6px rgba(245, 158, 11, 0.2), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.sc-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 16px; color: #fff; box-shadow: 0 4px 10px rgba(245, 158, 11, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.4); }
.sc-name { font-weight: 600; font-size: 14px; color: var(--zg-text); }

/* 最新美文：杂志感玻璃卡 */
.art-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
.art-card { overflow: hidden; cursor: pointer; border-radius: 22px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); transition: all .3s cubic-bezier(.22,1,.36,1); box-shadow: 0 4px 16px rgba(120, 53, 15, 0.06), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.art-card:hover { transform: translateY(-4px); border-color: rgba(255, 255, 255, 0.8); background: rgba(255, 255, 255, 0.7); box-shadow: 0 24px 48px -8px rgba(245, 158, 11, 0.2), 0 8px 16px -4px rgba(120, 53, 15, 0.1), 0 1px 0 0 rgba(255, 255, 255, 0.8) inset; }
.ac-cover { position: relative; height: 160px; background-size: cover; background-position: center; overflow: hidden; }
.ac-cover-shine { position: absolute; top: 0; left: 0; right: 0; height: 50%; background: linear-gradient(180deg, rgba(255,255,255,0.25) 0%, transparent 100%); pointer-events: none; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb), 0.4), rgba(var(--zg-primary-2-rgb), 0.3)); font-size: 56px; font-weight: 800; color: rgba(255, 255, 255, 0.7); }
.ac-body { padding: 16px 18px; }
.ac-title { font-weight: 700; font-size: 16px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--zg-text); }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-dot { opacity: .5; }

.zg-footer { text-align: center; padding: 36px 0 8px; margin-top: 48px; font-size: 12px; color: var(--zg-text-dim); opacity: 0.7; white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

/* 移动端 */
@media (max-width: 768px) {
  .home-bg-orb.orb-1 { width: 280px; height: 280px; top: -100px; right: -80px; }
  .home-bg-orb.orb-2 { width: 240px; height: 240px; }
  .home-bg-orb.orb-3 { width: 220px; height: 220px; }
  .home-bg-orb.orb-4 { width: 200px; height: 200px; }
  .hero { margin-top: 4px; padding: 32px 22px 28px; border-radius: 24px; }
  .hero-title { font-size: 26px; letter-spacing: -0.5px; }
  .hero-sub { font-size: 14px; margin-top: 10px; }
  .hero-sub2 { font-size: 13px; }
  .hero-tag { font-size: 12px; padding: 5px 12px; margin-bottom: 14px; }
  .hero-stats { grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 22px; }
  .hs-tile { padding: 14px 8px; border-radius: 14px; }
  .hs-num { font-size: 20px; }
  .hs-label { font-size: 11px; }
  .announce-bar { padding: 12px 16px; border-radius: 14px; }
  .ab-text { font-size: 13px; }
  .quick-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 16px; }
  .qg-tile { padding: 16px 8px 12px; border-radius: 18px; gap: 8px; }
  .qg-icon { width: 40px; height: 40px; border-radius: 12px; font-size: 20px; box-shadow: 0 6px 14px -2px rgba(245, 158, 11, 0.4), 0 2px 4px rgba(0, 0, 0, 0.1), inset 0 1px 0 0 rgba(255, 255, 255, 0.4); }
  .qg-text { font-size: 12px; }
  .section { margin-top: 28px; }
  .section-title { font-size: 16px; margin-bottom: 12px; }
  .subj-chip { padding: 8px 14px; }
  .sc-icon { width: 26px; height: 26px; font-size: 14px; }
  .sc-name { font-size: 13px; }
  .art-grid { grid-template-columns: 1fr; gap: 12px; }
  .art-card { border-radius: 18px; }
  .ac-cover { height: 130px; }
  .ac-body { padding: 12px 14px; }
  .ac-title { font-size: 14px; }
}

/* 桌面端 */
@media (min-width: 1200px) {
  .hero { padding: 56px 52px 48px; border-radius: 36px; }
  .hero-title { font-size: 44px; letter-spacing: -1.5px; }
  .hero-sub { font-size: 17px; }
  .hero-stats { gap: 14px; margin-top: 36px; }
  .hs-tile { padding: 22px 14px; }
  .hs-num { font-size: 30px; }
  .hs-label { font-size: 13px; }
  .quick-grid { grid-template-columns: repeat(8, 1fr); gap: 14px; }
  .qg-tile { padding: 26px 12px 20px; border-radius: 26px; gap: 14px; }
  .qg-icon { width: 56px; height: 56px; border-radius: 18px; font-size: 28px; }
  .qg-text { font-size: 14px; }
  .subj-chip { padding: 12px 20px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
}

@media (min-width: 1600px) {
  .art-grid { grid-template-columns: repeat(4, 1fr); }
}
</style>
