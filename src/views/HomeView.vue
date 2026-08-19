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
      <div class="hero zg-slide-up">
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
    <div v-if="showAnnouncement" class="announce-bar zg-slide-up" style="animation-delay:0.1s">
      <span class="ab-icon"><ZgGlyph :emoji="'📢'" /></span>
      <span class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></span>
    </div>

    <!-- 快捷入口：横向卡片列表（现代高级，去除多余嵌套框） -->
    <div class="quick-list" v-if="displayQuickLinks && displayQuickLinks.length">
      <div v-for="(ql, i) in displayQuickLinks" :key="i" class="ql-item zg-slide-up" :style="{ animationDelay: `${i * 0.05}s` }" @click="router.push(ql.path)">
        <div class="ql-icon" :style="iconStyle(ql.color)"><ZgGlyph :emoji="ql.icon" /></div>
        <div class="ql-body">
          <div class="ql-text">{{ ql.label }}</div>
          <div class="ql-hint">{{ ql.hint || '点击进入' }}</div>
        </div>
        <div class="ql-arrow"><ZgGlyph emoji="→" /></div>
      </div>
    </div>

    <!-- 学科 -->
    <div class="section" v-if="data.subjects.length && (siteConfig?.showSubjects !== false)">
      <div class="section-title">学科子站</div>
      <div class="subj-row">
        <div v-for="s in data.subjects" :key="s.id" class="subj-chip" @click="router.push(`/subject/${s.slug}`)">
          <span class="sc-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></span>
          <span class="sc-name">{{ s.name }}</span>
        </div>
      </div>
    </div>

    <!-- 最新美文 -->
    <div class="section" v-if="articles.length && (siteConfig?.showLatestArticles !== false)">
      <div class="section-title">最新美文</div>
      <div class="art-grid">
        <div v-for="(a, i) in articles.slice(0, siteConfig?.maxArticlesOnHome || 6)" :key="a.id" class="art-card zg-card zg-slide-up" :style="{ animationDelay: `${i * 0.08}s` }" @click="goArticle(a.id)">
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
/* ★ Q5: Hero 去框化——无边框/无阴影，渐变底色+装饰光球营造氛围 */
.hero { position: relative; overflow: hidden; margin: 16px 0 0; border-radius: 28px; padding: 44px 40px 36px; background: linear-gradient(135deg, rgba(var(--zg-primary-rgb),0.10) 0%, rgba(var(--zg-accent-rgb),0.08) 60%, rgba(var(--zg-primary-2-rgb),0.06) 100%); }
.hero-bg { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.hero-bg::before { content:''; position:absolute; top:-80px; right:-40px; width:280px; height:280px; background: radial-gradient(circle, rgba(var(--zg-primary-rgb),0.18), transparent 70%); border-radius:50%; filter: blur(30px); }
.hero-bg::after { content:''; position:absolute; bottom:-60px; left:-40px; width:200px; height:200px; background: radial-gradient(circle, rgba(var(--zg-accent-rgb),0.14), transparent 70%); border-radius:50%; filter: blur(24px); }
.hero-content { position: relative; z-index: 1; }
.hero-tag { display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; border-radius: 999px; background: rgba(var(--zg-primary-rgb),.15); font-size: var(--zg-fs-sm); color: var(--zg-primary); margin-bottom: 16px; font-weight: 500; }
.hero-title { font-size: var(--zg-fs-2xl); font-weight: 800; line-height: 1.3; letter-spacing: -0.5px; }
.hero-sub { color: var(--zg-text-dim); margin-top: 8px; font-size: var(--zg-fs-base); line-height: 1.7; max-width: 640px; }
.hero-stats { display: flex; align-items: stretch; gap: 0; margin-top: 28px; background: rgba(255,255,255,0.55); border-radius: 18px; padding: 18px 24px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.hs-item { flex: 1; text-align: center; }
.hs-num { font-size: var(--zg-fs-xl); font-weight: 800; color: var(--zg-text); line-height: 1.1; }
.hs-label { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 4px; }
.hs-divider { width: 1px; align-self: center; height: 36px; background: rgba(var(--zg-primary-rgb),.15); margin: 0 8px; }

/* Q5: 公告栏去框——轻底+左金条 */
.announce-bar { display: flex; align-items: center; gap: 10px; padding: 12px 18px; margin-top: 16px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.05); border-left: 3px solid var(--zg-primary); }
.ab-icon { font-size: 18px; flex: none; }
.ab-text { font-size: var(--zg-fs-sm); color: var(--zg-text); line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }

/* 快捷入口：横向卡片列表（去玻璃嵌套，单层轻底） */
.quick-list { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 20px; }
.ql-item { display: flex; align-items: center; gap: 16px; padding: 16px 18px; border-radius: 16px; background: rgba(255,255,255,0.7); cursor: pointer; transition: all .25s cubic-bezier(.22,1,.36,1); border: 1px solid rgba(var(--zg-primary-rgb),.08); }
.ql-item:hover { transform: translateY(-2px); border-color: rgba(var(--zg-primary-rgb),.28); background: rgba(255,255,255,0.92); box-shadow: 0 10px 28px rgba(var(--zg-primary-rgb),.10); }
.ql-item:hover .ql-arrow { transform: translateX(4px); color: var(--zg-primary); }
.ql-icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex: none; box-shadow: 0 4px 10px rgba(var(--zg-primary-rgb),.16); }
.ql-body { flex: 1; min-width: 0; }
.ql-text { font-size: var(--zg-fs-base); font-weight: 600; color: var(--zg-text); line-height: 1.4; }
.ql-hint { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 2px; opacity: .7; }
.ql-arrow { font-size: 18px; color: var(--zg-text-dim); transition: transform .25s ease, color .25s ease; flex: none; }

/* 学科子站：胶囊形态（去嵌套框） */
.section { margin-top: 32px; }
.section-title { font-size: var(--zg-fs-lg); font-weight: 700; margin-bottom: 14px; display:flex; align-items:center; gap:8px; color: var(--zg-text); }
.section-title::before { content:''; width:3px; height:14px; border-radius:3px; background: linear-gradient(var(--zg-accent), var(--zg-primary)); }
.subj-row { display: flex; gap: 8px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 6px; padding: 8px 14px; cursor: pointer; border-radius: 999px; background: rgba(255,255,255,0.7); border: 1px solid rgba(var(--zg-primary-rgb),.10); transition: all .22s ease; }
.subj-chip:hover { border-color: rgba(var(--zg-primary-rgb),.32); transform: translateY(-2px); box-shadow: 0 8px 18px rgba(var(--zg-primary-rgb),.10); }
.sc-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.sc-name { font-weight: 600; font-size: var(--zg-fs-sm); color: var(--zg-text); }

/* 最新美文：简洁卡片（去嵌套框） */
.art-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
.art-card { overflow: hidden; cursor: pointer; border-radius: 16px; background: rgba(255,255,255,0.75); border: 1px solid rgba(var(--zg-primary-rgb),.08); transition: all .25s ease; }
.art-card:hover { transform: translateY(-3px); border-color: rgba(var(--zg-primary-rgb),.28); box-shadow: 0 14px 32px rgba(var(--zg-primary-rgb),.12); }
.ac-cover { height: 140px; background-size: cover; background-position: center; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.2), rgba(var(--zg-primary-2-rgb),.15)); font-size: 48px; font-weight: 800; color: rgba(var(--zg-primary-rgb),.3); }
.ac-body { padding: 14px 16px; }
.ac-title { font-weight: 700; font-size: var(--zg-fs-base); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); }
.ac-dot { opacity: .5; }

.zg-footer { text-align: center; padding: 32px 0 8px; margin-top: 40px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); opacity: 0.7; white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

/* ★ Q6: 移动端重设计——更现代高级 */
@media (max-width: 768px) {
  .hero { margin-top: 12px; padding: 28px 20px 24px; border-radius: 22px; }
  .hero-bg::before { width: 180px; height: 180px; top: -50px; right: -30px; }
  .hero-bg::after { width: 140px; height: 140px; bottom: -40px; left: -20px; }
  .hero-title { font-size: var(--zg-fs-xl); letter-spacing: -0.3px; }
  .hero-sub { font-size: var(--zg-fs-sm); }
  .hero-stats { padding: 12px 8px; border-radius: 14px; gap: 0; }
  .hs-num { font-size: var(--zg-fs-md); }
  .hs-label { font-size: 11px; margin-top: 2px; }
  .hs-divider { height: 28px; margin: 0 4px; }
  .announce-bar { padding: 10px 14px; border-radius: 10px; gap: 8px; }
  .ab-icon { font-size: 16px; }
  .ab-text { font-size: var(--zg-fs-xs); }
  .quick-list { grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px; }
  .ql-item { flex-direction: column; align-items: flex-start; gap: 8px; padding: 14px 12px; border-radius: 14px; }
  .ql-icon { width: 36px; height: 36px; font-size: 18px; border-radius: 10px; box-shadow: 0 3px 8px rgba(var(--zg-primary-rgb),.16); }
  .ql-body { width: 100%; }
  .ql-text { font-size: var(--zg-fs-sm); }
  .ql-hint { display: none; }
  .ql-arrow { position: absolute; top: 12px; right: 12px; font-size: 14px; }
  .ql-item { position: relative; }
  .section { margin-top: 26px; }
  .section-title { font-size: var(--zg-fs-md); margin-bottom: 12px; }
  .subj-row { gap: 6px; }
  .subj-chip { padding: 7px 12px; }
  .sc-icon { width: 24px; height: 24px; font-size: 13px; border-radius: 7px; }
  .sc-name { font-size: var(--zg-fs-xs); }
  .art-grid { grid-template-columns: 1fr; gap: 10px; }
  .art-card { border-radius: 14px; }
  .ac-cover { height: 120px; }
  .ac-body { padding: 12px 14px; }
  .ac-title { font-size: var(--zg-fs-sm); }
  .ac-meta { font-size: 11px; }
}

/* 平板/小屏：2 列 */
@media (min-width: 769px) and (max-width: 1199px) {
  .quick-list { grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .art-grid { grid-template-columns: repeat(2, 1fr); }
}

/* 桌面端 */
@media (min-width: 1200px) {
  .hero { padding: 60px 56px 48px; border-radius: 32px; }
  .hero-title { font-size: 42px; max-width: 820px; }
  .hero-sub { font-size: 17px; }
  .hero-stats { padding: 24px 32px; gap: 0; }
  .hs-num { font-size: 30px; }
  .hs-label { font-size: 13px; }
  .hs-divider { height: 44px; margin: 0 12px; }
  .quick-list { grid-template-columns: repeat(4, 1fr); gap: 14px; }
  .ql-item { padding: 20px 18px; }
  .ql-icon { width: 50px; height: 50px; font-size: 24px; border-radius: 14px; }
  .subj-row { gap: 12px; }
  .subj-chip { padding: 10px 18px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 18px; }
}

@media (min-width: 1600px) {
  .art-grid { grid-template-columns: repeat(4, 1fr); }
}
</style>
