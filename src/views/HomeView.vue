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

// YIQ 亮度公式：白底/浅底 → 深色图标；深底 → 白色图标
function isLightColor(hex: string): boolean {
  const m = (hex || '').replace('#', '').match(/.{2}/g)
  if (!m || m.length < 3) return false
  const [r, g, b] = m.map(x => parseInt(x, 16))
  return (r * 299 + g * 587 + b * 114) / 1000 > 170
}
function iconStyle(color?: string) {
  if (!color) {
    return {
      background: `linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2))`,
      color: '#fff',
    }
  }
  return {
    background: `linear-gradient(135deg, ${color}, ${color}cc)`,
    color: isLightColor(color) ? 'rgba(120,53,15,0.85)' : '#fff',
  }
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
      <!-- 首页专属极淡呼吸光晕（仅墨金作用域，经典不渲染任何可见内容） -->
      <div class="home-bg" aria-hidden="true"></div>

      <!-- Hero：克制玻璃 + 衬线留白 + 品牌光线母题 -->
      <section class="hero">
        <div class="hero-content home-enter">
          <div class="hero-meta">
            <div class="hero-tag"><ZgGlyph :emoji="'🌟'" /> {{ siteConfig?.siteName || '追光学科共享平台' }}</div>
            <div class="hero-time" v-if="user.isLogin">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }}</div>
          </div>

          <h1 class="hero-title">
            <span class="hero-greet">{{ greeting }}，</span>
            <span class="hero-name">{{ user.current?.realName || '追光者' }}</span>
            <span class="hero-dot">。</span>
          </h1>

          <p class="hero-slogan">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }} {{ siteConfig?.heroSubtitle || '在这里分享知识，收获成长。' }}</p>

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
      </section>

      <!-- 公告：玻璃横标 -->
      <div v-if="showAnnouncement" class="announce-bar zg-slide-up">
        <span class="ab-icon"><ZgGlyph :emoji="'📢'" /></span>
        <span class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></span>
      </div>

      <!-- 快捷入口：单行玻璃胶囊 -->
      <div class="quick-row" v-if="displayQuickLinks && displayQuickLinks.length">
        <div v-for="(ql, i) in displayQuickLinks" :key="i" class="qr-item" @click="router.push(ql.path)">
          <div class="qr-icon" :style="iconStyle(ql.color)"><ZgGlyph :emoji="ql.icon" /></div>
          <div class="qr-text">{{ ql.label }}</div>
        </div>
      </div>

      <!-- 学科子站 -->
      <div class="section" v-if="data.subjects.length && (siteConfig?.showSubjects !== false)">
        <div class="section-head">
          <div class="section-title">学科子站</div>
          <div class="section-meta">{{ data.subjects.length }} 个学科</div>
        </div>
        <div class="subj-row">
          <div v-for="s in data.subjects" :key="s.id" class="subj-chip" @click="router.push(`/subject/${s.slug}`)">
            <span class="sc-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></span>
            <span class="sc-name">{{ s.name }}</span>
          </div>
        </div>
      </div>

      <!-- 最新美文 -->
      <div class="section" v-if="articles.length && (siteConfig?.showLatestArticles !== false)">
        <div class="section-head">
          <div class="section-title">最新美文</div>
          <div class="section-meta">{{ articles.length }} 篇</div>
        </div>
        <div class="art-grid">
          <article v-for="(a, i) in articles.slice(0, siteConfig?.maxArticlesOnHome || 6)" :key="a.id" class="art-card zg-slide-up" :style="{ animationDelay: `${i * 0.08}s` }" @click="goArticle(a.id)">
            <div class="ac-cover" v-if="a.cover" :style="{ backgroundImage: `url(${a.cover})` }"></div>
            <div class="ac-cover ac-placeholder" v-else>
              <span>{{ a.category?.[0] || '追' }}</span>
            </div>
            <div class="ac-body">
              <div class="ac-title">{{ a.title }}</div>
              <div class="ac-meta">
                <span class="ac-author">{{ a.author }}</span>
                <span class="ac-dot">·</span>
                <span>{{ a.created_at?.slice(5, 10) }}</span>
                <span class="ac-dot">·</span>
                <span class="ac-like"><ZgGlyph :emoji="'❤'" /> {{ a.likes || 0 }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>

      <!-- 页脚 -->
      <footer class="zg-footer" v-if="configLoaded && siteConfig?.footerText">
        <span v-html="renderMarkdownPreserveSpaces(siteConfig.footerText)"></span>
      </footer>
    </template>
  </ZgPullRefresh>
</template>

<style scoped>
.home-page { position: relative; }

/* 首页专属极淡呼吸光晕：仅墨金可见（经典不渲染任何可见内容） */
.home-bg { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
.zg-inkgold .home-bg::before {
  content: ''; position: absolute; top: -200px; right: -160px; width: 680px; height: 680px; border-radius: 50%;
  background: radial-gradient(circle, rgba(212,175,55,0.14), transparent 68%); filter: blur(90px);
  opacity: 0.75; animation: zgBreath 18s ease-in-out infinite;
}
@keyframes zgBreath {
  0%,100% { transform: scale(1); opacity: 0.58; }
  50% { transform: scale(1.07); opacity: 0.80; }
}

/* ===== HERO 通用结构 ===== */
.hero {
  position: relative; margin: 6px 0 28px; padding: 56px 54px 50px; border-radius: 28px;
  overflow: hidden; min-height: 360px; display: flex; flex-direction: column; justify-content: center;
}
/* 品牌光线母题：顶部一道金色光线 + 一道极缓流光（只此一处，贯穿三档主题色） */
.hero::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; z-index: 3;
  background: linear-gradient(90deg, transparent, var(--zg-accent) 18%, var(--zg-primary) 50%, var(--zg-accent) 82%, transparent);
  box-shadow: 0 0 26px rgba(var(--zg-primary-rgb), 0.55), 0 0 6px rgba(var(--zg-primary-rgb), 0.35);
}
.hero::after {
  content: ''; position: absolute; top: 0; left: -40%; width: 40%; height: 2px; z-index: 4;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent);
  animation: zgShimmer 7s ease-in-out infinite; opacity: 0.8;
}
@keyframes zgShimmer { 0% { left: -40%; } 55%,100% { left: 110%; } }
.hero-content { position: relative; z-index: 2; }
.home-enter { animation: homeEnter .8s cubic-bezier(.22,1,.36,1) both; }
@keyframes homeEnter { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }

.hero-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; flex-wrap: wrap; gap: 12px; }
.hero-tag { display: inline-flex; align-items: center; gap: 7px; padding: 8px 18px; border-radius: 999px; font-size: 13px; font-weight: 700; letter-spacing: .3px; }
.hero-time { font-size: 13px; font-weight: 600; letter-spacing: .2px; color: var(--zg-text-dim); }

/* 标题：经典=无衬线渐变展示；墨金=衬线留白（衬线由 main.css 的 !important 强制生效） */
.hero-title { margin: 0 0 14px; line-height: 1.12; font-size: 42px; font-weight: 800; letter-spacing: -1.5px; color: var(--zg-text); }
.hero-greet { font-weight: 600; opacity: .7; }
.hero-name { background: linear-gradient(118deg, var(--zg-primary-2), var(--zg-primary) 55%, var(--zg-accent)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
.hero-dot { color: var(--zg-primary-2); -webkit-text-fill-color: var(--zg-primary-2); }
.hero-slogan { margin: 0 0 34px; font-size: 19px; line-height: 1.7; max-width: 660px; font-weight: 500; opacity: .82; letter-spacing: .2px; }

/* 墨金标题覆盖 */
.zg-inkgold .hero-title { font-size: 46px; font-weight: 700; letter-spacing: -.5px; text-shadow: 0 2px 18px rgba(186,117,23,0.08); }
.zg-inkgold .hero-greet { opacity: .80; }
.zg-inkgold .hero-name { background: none; -webkit-text-fill-color: var(--zg-text); color: var(--zg-text); position: relative; }
.zg-inkgold .hero-name::after { content: ''; position: absolute; left: 0; right: 35%; bottom: -4px; height: 3px; border-radius: 3px; background: linear-gradient(90deg, var(--zg-primary), var(--zg-accent) 70%, transparent); }
.zg-inkgold .hero-dot { color: var(--zg-primary); -webkit-text-fill-color: var(--zg-primary); }
.zg-inkgold .hero-slogan { color: var(--zg-text-dim); opacity: .92; }

/* ===== hero-stats ===== */
.hero-stats { display: flex; align-items: center; gap: 0; padding: 22px 32px; border-radius: 20px; }
.hs-item { flex: 1; text-align: center; }
.hs-num { font-size: 30px; font-weight: 800; letter-spacing: -.6px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hs-label { font-size: 12px; margin-top: 4px; font-weight: 600; letter-spacing: .5px; color: var(--zg-text-dim); }
.hs-divider { width: 1px; height: 38px; background: rgba(var(--zg-primary-rgb), 0.18); }

/* ===== 经典模式：干净橙玻璃（不越界，不堆墨金液态玻璃） ===== */
.hero, .announce-bar, .qr-item, .subj-chip, .art-card {
  background: linear-gradient(135deg, rgba(255,255,255,0.72), rgba(255,255,255,0.52));
  -webkit-backdrop-filter: blur(var(--zg-blur)); backdrop-filter: blur(var(--zg-blur));
  border: 1px solid rgba(255,255,255,0.6);
  box-shadow: 0 1px 0 0 rgba(255,255,255,0.9) inset, 0 -1px 0 0 rgba(120,53,15,0.04) inset, var(--zg-shadow);
}

/* ===== 墨金学术模式：克制玻璃 + 金发丝描边（限定 .zg-inkgold 作用域） ===== */
.zg-inkgold .hero { background: linear-gradient(155deg, rgba(255,255,255,0.92), rgba(255,251,242,0.82)); border: 1px solid var(--zg-card-border); box-shadow: var(--zg-shadow); }
.zg-inkgold .hero-stats { background: linear-gradient(155deg, rgba(255,255,255,0.78), rgba(255,251,242,0.66)); border: 1px solid var(--zg-card-border); box-shadow: var(--zg-shadow); }
.zg-inkgold .announce-bar,
.zg-inkgold .qr-item,
.zg-inkgold .subj-chip,
.zg-inkgold .art-card { background: linear-gradient(155deg, rgba(255,255,255,0.90), rgba(255,251,242,0.80)); border: 1px solid var(--zg-card-border); box-shadow: var(--zg-shadow); }

/* 墨金深色：暗底暖金，不阴郁 */
.zg-inkgold.zg-inkgold-dark .hero,
.zg-inkgold.zg-inkgold-dark .hero-stats,
.zg-inkgold.zg-inkgold-dark .announce-bar,
.zg-inkgold.zg-inkgold-dark .qr-item,
.zg-inkgold.zg-inkgold-dark .subj-chip,
.zg-inkgold.zg-inkgold-dark .art-card { background: linear-gradient(155deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03)); border-color: rgba(212,175,55,0.20); box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 22px 56px rgba(0,0,0,0.4); }

/* 公告 */
.announce-bar { display: flex; align-items: center; gap: 12px; padding: 15px 22px; margin: 0 0 28px; border-radius: 16px; border-left: 3px solid var(--zg-primary); }
.ab-icon { font-size: 18px; flex: none; }
.ab-text { font-size: 14px; color: var(--zg-text); line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }

/* 快捷入口 */
.quick-row { display: flex; gap: 10px; margin: 0 0 36px; overflow-x: auto; padding: 4px 0; scrollbar-width: none; }
.quick-row::-webkit-scrollbar { display: none; }
.qr-item { display: flex; align-items: center; gap: 11px; padding: 11px 18px; border-radius: 999px; cursor: pointer; white-space: nowrap; flex: none; transition: transform .28s cubic-bezier(.22,1,.36,1), box-shadow .28s; }
.qr-item:hover { transform: translateY(-2px); }
.qr-icon { width: 34px; height: 34px; border-radius: 11px; display: flex; align-items: center; justify-content: center; font-size: 17px; flex: none; }
.qr-text { font-size: 14px; font-weight: 700; color: var(--zg-text); letter-spacing: .2px; }

/* 学科 */
.section { margin: 36px 0; }
.section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.section-title { font-size: 21px; font-weight: 800; color: var(--zg-text); letter-spacing: .3px; display: flex; align-items: center; gap: 10px; }
.section-title::before { content: ''; width: 4px; height: 19px; border-radius: 3px; background: linear-gradient(180deg, var(--zg-accent), var(--zg-primary)); }
.section-meta { font-size: 12px; color: var(--zg-text-dim); font-weight: 600; letter-spacing: .3px; }
.subj-row { display: flex; gap: 9px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 9px; padding: 10px 18px; cursor: pointer; border-radius: 999px; transition: transform .28s cubic-bezier(.22,1,.36,1), box-shadow .28s; }
.subj-chip:hover { transform: translateY(-2px); }
.sc-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex: none; }
.sc-name { font-weight: 700; font-size: 14px; color: var(--zg-text); letter-spacing: .2px; }

/* 美文 */
.art-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
.art-card { overflow: hidden; cursor: pointer; border-radius: 22px; transition: transform .3s cubic-bezier(.22,1,.36,1), box-shadow .3s; }
.art-card:hover { transform: translateY(-4px); }
.ac-cover { position: relative; height: 150px; background-size: cover; background-position: center; }
.ac-cover::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 60px; background: linear-gradient(180deg, rgba(255,255,255,0.25), transparent); pointer-events: none; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb), 0.45), rgba(var(--zg-primary-2-rgb), 0.35)); font-size: 44px; font-weight: 800; color: rgba(255,255,255,0.85); }
.zg-inkgold .ac-placeholder { background: linear-gradient(135deg, rgba(186,117,23,0.12), rgba(212,175,55,0.06)); color: var(--zg-primary); }
.zg-inkgold-dark .ac-placeholder { color: var(--zg-accent); }
.ac-body { padding: 15px 18px; }
.ac-title { font-weight: 700; font-size: 15px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--zg-text); }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-author { font-weight: 500; }
.ac-dot { opacity: .5; }
.ac-like { display: inline-flex; align-items: center; gap: 3px; }

.zg-footer { text-align: center; padding: 40px 0 8px; margin-top: 48px; font-size: 12px; color: var(--zg-text-dim); opacity: .65; white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

/* 桌面端 */
@media (min-width: 1200px) {
  .hero { padding: 68px 64px 60px; border-radius: 32px; min-height: 400px; }
  .hero-title { font-size: 48px; letter-spacing: -2px; }
  .zg-inkgold .hero-title { font-size: 52px; }
  .hero-slogan { font-size: 21px; margin-bottom: 42px; }
  .hero-stats { padding: 26px 40px; border-radius: 24px; }
  .hs-num { font-size: 34px; }
  .hs-label { font-size: 13px; }
  .hs-divider { height: 42px; }
  .section-title { font-size: 22px; }
  .section-meta { font-size: 13px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 18px; }
}
@media (min-width: 1600px) { .art-grid { grid-template-columns: repeat(4, 1fr); } }

/* 移动端 */
@media (max-width: 768px) {
  .hero { margin: 0 0 20px; padding: 34px 22px 30px; border-radius: 24px; min-height: auto; }
  .hero-meta { margin-bottom: 14px; }
  .hero-tag { font-size: 12px; padding: 6px 14px; }
  .hero-time { display: none; }
  .hero-title { font-size: 30px; letter-spacing: -1px; margin-bottom: 10px; }
  .zg-inkgold .hero-title { font-size: 30px; letter-spacing: -.3px; }
  .hero-slogan { font-size: 14px; margin-bottom: 22px; }
  .hero-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 16px 14px; border-radius: 18px; }
  .hs-divider { display: none; }
  .hs-num { font-size: 22px; }
  .hs-label { font-size: 11px; }
  .announce-bar { padding: 12px 16px; margin-bottom: 20px; border-radius: 14px; }
  .ab-text { font-size: 13px; }
  .quick-row { margin-bottom: 24px; gap: 8px; }
  .qr-item { padding: 10px 14px; gap: 9px; }
  .qr-icon { width: 30px; height: 30px; font-size: 15px; border-radius: 9px; }
  .qr-text { font-size: 13px; }
  .section { margin: 24px 0; }
  .section-title { font-size: 18px; }
  .section-meta { font-size: 11px; }
  .subj-chip { padding: 8px 14px; }
  .sc-icon { width: 26px; height: 26px; font-size: 14px; border-radius: 8px; }
  .sc-name { font-size: 13px; }
  .art-card { border-radius: 18px; }
  .ac-cover { height: 130px; }
  .ac-body { padding: 12px 14px; }
  .ac-title { font-size: 14px; }
}
</style>
