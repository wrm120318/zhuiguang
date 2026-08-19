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

// YIQ 亮度公式：白底/浅底 → 深色图标；深底 → 白色图标（Q3 修复）
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
      <!-- ★ 多层光球背景（5 个，色彩更鲜艳）撑起琉璃氛围 -->
      <div class="home-bg" aria-hidden="true">
        <div class="home-bg-orb orb-1"></div>
        <div class="home-bg-orb orb-2"></div>
        <div class="home-bg-orb orb-3"></div>
        <div class="home-bg-orb orb-4"></div>
        <div class="home-bg-orb orb-5"></div>
      </div>

      <!-- ★ Hero：超大半屏液态玻璃主面板（视觉主角，stats 收进内部） -->
      <section class="hero zg-slide-up">
        <div class="hero-shine"></div>
        <div class="hero-glow"></div>
        <div class="hero-content">
          <div class="hero-meta">
            <div class="hero-tag"><ZgGlyph :emoji="'🌟'" /> {{ siteConfig?.siteName || '追光学科共享平台' }}</div>
            <div class="hero-time" v-if="user.isLogin">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }}</div>
          </div>

          <h1 class="hero-title">
            <span class="hero-greet">{{ greeting }}，</span>
            <span class="hero-name">{{ user.current?.realName || '追光者' }}</span>
            <span class="hero-dot">。</span>
          </h1>

          <p class="hero-slogan">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }}</p>

          <!-- 数据瓦片：收进 hero 内部，一体式液态玻璃横条（不再是分离 4 块） -->
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

      <!-- 公告：极简金条样式（不再是大块卡片） -->
      <div v-if="showAnnouncement" class="announce-bar zg-slide-up">
        <span class="ab-icon"><ZgGlyph :emoji="'📢'" /></span>
        <span class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></span>
      </div>

      <!-- ★ 快捷入口：降权为单行横向小瓦片（不再是 8 色方块） -->
      <div class="quick-row" v-if="displayQuickLinks && displayQuickLinks.length">
        <div v-for="(ql, i) in displayQuickLinks" :key="i" class="qr-item" @click="router.push(ql.path)">
          <div class="qr-icon" :style="iconStyle(ql.color)"><ZgGlyph :emoji="ql.icon" /></div>
          <div class="qr-text">{{ ql.label }}</div>
        </div>
      </div>

      <!-- 学科子站：水平胶囊带（与快捷入口同一行级别） -->
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

      <!-- 最新美文：杂志网格（克制卡片视觉重量） -->
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

      <!-- 页脚文字 -->
      <footer class="zg-footer" v-if="configLoaded && siteConfig?.footerText">
        <span v-html="renderMarkdownPreserveSpaces(siteConfig.footerText)"></span>
      </footer>
    </template>
  </ZgPullRefresh>
</template>

<style scoped>
/* ★ 多层光球背景：5 个饱满高饱和球（不再小气） */
.home-page { position: relative; }
.home-bg { position: absolute; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; border-radius: inherit; }
.home-bg-orb { position: absolute; border-radius: 50%; filter: blur(70px); will-change: transform; }
.home-bg-orb.orb-1 { width: 600px; height: 600px; top: -220px; right: -180px; background: radial-gradient(circle, rgba(var(--zg-primary-rgb),0.65), transparent 70%); animation: zgOrbFloat 24s ease-in-out infinite; }
.home-bg-orb.orb-2 { width: 500px; height: 500px; top: 35%; left: -200px; background: radial-gradient(circle, rgba(var(--zg-accent-rgb),0.55), transparent 70%); animation: zgOrbFloat 28s ease-in-out infinite reverse; }
.home-bg-orb.orb-3 { width: 460px; height: 460px; bottom: 8%; right: 5%; background: radial-gradient(circle, rgba(var(--zg-primary-2-rgb),0.60), transparent 70%); animation: zgOrbFloat 32s ease-in-out infinite; }
.home-bg-orb.orb-4 { width: 380px; height: 380px; top: 60%; left: 35%; background: radial-gradient(circle, rgba(var(--zg-primary-rgb),0.40), transparent 70%); animation: zgOrbFloat 26s ease-in-out infinite reverse; }
.home-bg-orb.orb-5 { width: 340px; height: 340px; top: 18%; left: 20%; background: radial-gradient(circle, rgba(var(--zg-accent-rgb),0.35), transparent 70%); animation: zgOrbFloat 30s ease-in-out infinite; }
@keyframes zgOrbFloat {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(50px, -35px) scale(1.10); }
  66% { transform: translate(-40px, 30px) scale(0.92); }
}

/* ★ Hero 主面板：超大半屏、编辑级排版、液态玻璃（视觉主角） */
.hero { position: relative; margin: 4px 0 28px; border-radius: 40px; padding: 64px 56px 52px; overflow: hidden; background: rgba(255, 255, 255, 0.42); backdrop-filter: blur(40px) saturate(200%); -webkit-backdrop-filter: blur(40px) saturate(200%); border: 1px solid rgba(255, 255, 255, 0.6); box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.8) inset, 0 -1px 0 0 rgba(120, 53, 15, 0.04) inset, 0 32px 80px -12px rgba(245, 158, 11, 0.25), 0 12px 28px -6px rgba(120, 53, 15, 0.10); min-height: 380px; display: flex; flex-direction: column; justify-content: center; }
.hero-shine { position: absolute; top: 0; left: 0; right: 0; height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.95) 25%, rgba(255,255,255,0.95) 75%, transparent); pointer-events: none; }
.hero-shine::after { content:''; position: absolute; top: 0; left: 0; right: 0; height: 120px; background: linear-gradient(180deg, rgba(255,255,255,0.4), transparent); pointer-events: none; }
.hero-glow { position: absolute; bottom: -60px; right: -60px; width: 320px; height: 320px; background: radial-gradient(circle, rgba(var(--zg-primary-rgb), 0.20), transparent 70%); border-radius: 50%; filter: blur(40px); pointer-events: none; }
.hero-content { position: relative; z-index: 1; }
.hero-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 28px; flex-wrap: wrap; gap: 12px; }
.hero-tag { display: inline-flex; align-items: center; gap: 6px; padding: 7px 18px; border-radius: 999px; background: rgba(255, 255, 255, 0.55); border: 1px solid rgba(255, 255, 255, 0.6); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); font-size: 13px; color: var(--zg-primary); font-weight: 600; letter-spacing: 0.3px; }
.hero-time { font-size: 13px; color: var(--zg-text-dim); font-weight: 500; letter-spacing: 0.2px; }
.hero-title { font-size: 64px; font-weight: 800; line-height: 1.1; letter-spacing: -3px; color: var(--zg-text); margin: 0 0 18px; }
.hero-greet { font-weight: 600; opacity: 0.7; }
.hero-name { background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
.hero-dot { color: var(--zg-primary); -webkit-text-fill-color: var(--zg-primary); }
.hero-slogan { color: var(--zg-text); margin: 0 0 36px; font-size: 19px; line-height: 1.65; max-width: 640px; font-weight: 500; opacity: 0.85; letter-spacing: 0.2px; }

/* ★ hero-stats：一体式液态玻璃横条（不再是 4 块独立瓦片） */
.hero-stats { display: flex; align-items: center; padding: 22px 32px; border-radius: 24px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); box-shadow: 0 4px 16px rgba(120, 53, 15, 0.05), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.hs-item { flex: 1; text-align: center; }
.hs-num { font-size: 30px; font-weight: 800; color: var(--zg-text); line-height: 1.1; letter-spacing: -0.8px; }
.hs-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; font-weight: 600; letter-spacing: 0.5px; }
.hs-divider { width: 1px; height: 36px; background: rgba(var(--zg-primary-rgb), 0.15); }

/* 公告：极简金条横标（不再是大块卡片） */
.announce-bar { display: flex; align-items: center; gap: 12px; padding: 14px 22px; margin: 0 0 28px; border-radius: 16px; background: rgba(255, 255, 255, 0.5); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); border-left: 3px solid var(--zg-primary); }
.ab-icon { font-size: 20px; flex: none; }
.ab-text { font-size: 14px; color: var(--zg-text); line-height: 1.7; white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word; }

/* ★ 快捷入口：降权为单行横向（不再是 8 色方块） */
.quick-row { display: flex; gap: 10px; margin: 0 0 36px; overflow-x: auto; padding: 4px 0; scrollbar-width: none; }
.quick-row::-webkit-scrollbar { display: none; }
.qr-item { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-radius: 999px; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); cursor: pointer; transition: all .28s cubic-bezier(.22,1,.36,1); flex: none; white-space: nowrap; box-shadow: 0 2px 8px rgba(120, 53, 15, 0.04), 0 1px 0 0 rgba(255, 255, 255, 0.6) inset; }
.qr-item:hover { transform: translateY(-2px); border-color: rgba(255, 255, 255, 0.8); background: rgba(255, 255, 255, 0.75); box-shadow: 0 10px 24px -6px rgba(245, 158, 11, 0.18), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.qr-icon { width: 32px; height: 32px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex: none; box-shadow: 0 4px 10px rgba(245, 158, 11, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.4); }
.qr-text { font-size: 14px; font-weight: 600; color: var(--zg-text); letter-spacing: 0.2px; }

/* 学科子站 */
.section { margin: 36px 0; }
.section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.section-title { font-size: 20px; font-weight: 700; color: var(--zg-text); letter-spacing: 0.3px; display: flex; align-items: center; gap: 10px; }
.section-title::before { content: ''; width: 4px; height: 18px; border-radius: 3px; background: linear-gradient(180deg, var(--zg-accent), var(--zg-primary)); box-shadow: 0 0 10px rgba(var(--zg-primary-rgb), 0.4); }
.section-meta { font-size: 12px; color: var(--zg-text-dim); font-weight: 500; letter-spacing: 0.3px; }
.subj-row { display: flex; gap: 8px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 8px; padding: 9px 18px; cursor: pointer; border-radius: 999px; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(16px) saturate(160%); -webkit-backdrop-filter: blur(16px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); transition: all .28s cubic-bezier(.22,1,.36,1); box-shadow: 0 2px 8px rgba(120, 53, 15, 0.04), 0 1px 0 0 rgba(255, 255, 255, 0.6) inset; }
.subj-chip:hover { transform: translateY(-2px); background: rgba(255, 255, 255, 0.75); box-shadow: 0 10px 24px -6px rgba(245, 158, 11, 0.18), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.sc-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex: none; box-shadow: 0 3px 8px rgba(245, 158, 11, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.4); }
.sc-name { font-weight: 600; font-size: 14px; color: var(--zg-text); letter-spacing: 0.2px; }

/* 最新美文：克制视觉重量的杂志卡片 */
.art-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
.art-card { overflow: hidden; cursor: pointer; border-radius: 20px; background: rgba(255, 255, 255, 0.55); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); border: 1px solid rgba(255, 255, 255, 0.55); transition: all .3s cubic-bezier(.22,1,.36,1); box-shadow: 0 2px 10px rgba(120, 53, 15, 0.04), 0 1px 0 0 rgba(255, 255, 255, 0.7) inset; }
.art-card:hover { transform: translateY(-3px); background: rgba(255, 255, 255, 0.72); box-shadow: 0 16px 36px -6px rgba(245, 158, 11, 0.18), 0 1px 0 0 rgba(255, 255, 255, 0.8) inset; }
.ac-cover { position: relative; height: 140px; background-size: cover; background-position: center; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb), 0.35), rgba(var(--zg-primary-2-rgb), 0.28)); font-size: 48px; font-weight: 800; color: rgba(255, 255, 255, 0.7); }
.ac-body { padding: 14px 18px; }
.ac-title { font-weight: 700; font-size: 15px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--zg-text); }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-author { font-weight: 500; }
.ac-dot { opacity: .5; }
.ac-like { display: inline-flex; align-items: center; gap: 3px; }

.zg-footer { text-align: center; padding: 40px 0 8px; margin-top: 48px; font-size: 12px; color: var(--zg-text-dim); opacity: 0.65; white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

/* ★ 移动端：编辑级压缩版（Hero 减小但仍是主角，stats 仍收进 hero） */
@media (max-width: 768px) {
  .home-bg-orb.orb-1 { width: 320px; height: 320px; top: -120px; right: -100px; }
  .home-bg-orb.orb-2 { width: 260px; height: 260px; }
  .home-bg-orb.orb-3 { width: 240px; height: 240px; }
  .home-bg-orb.orb-4 { width: 200px; height: 200px; }
  .home-bg-orb.orb-5 { width: 180px; height: 180px; }
  .hero { margin: 0 0 20px; padding: 36px 22px 28px; border-radius: 28px; min-height: 280px; }
  .hero-meta { margin-bottom: 18px; }
  .hero-tag { font-size: 12px; padding: 5px 14px; }
  .hero-time { font-size: 12px; }
  .hero-title { font-size: 32px; letter-spacing: -1px; margin-bottom: 12px; }
  .hero-slogan { font-size: 14px; margin-bottom: 24px; }
  .hero-stats { padding: 14px 8px; gap: 0; border-radius: 18px; }
  .hs-num { font-size: 20px; }
  .hs-label { font-size: 11px; }
  .hs-divider { height: 28px; margin: 0 4px; }
  .announce-bar { padding: 12px 16px; margin-bottom: 20px; border-radius: 14px; }
  .ab-text { font-size: 13px; }
  .quick-row { gap: 8px; margin-bottom: 24px; }
  .qr-item { padding: 10px 14px; gap: 10px; }
  .qr-icon { width: 28px; height: 28px; font-size: 14px; border-radius: 8px; }
  .qr-text { font-size: 13px; }
  .section { margin: 24px 0; }
  .section-title { font-size: 17px; }
  .section-meta { font-size: 11px; }
  .subj-chip { padding: 7px 14px; gap: 6px; }
  .sc-icon { width: 24px; height: 24px; font-size: 13px; border-radius: 7px; }
  .sc-name { font-size: 13px; }
  .art-grid { gap: 12px; }
  .art-card { border-radius: 16px; }
  .ac-cover { height: 120px; }
  .ac-body { padding: 12px 14px; }
  .ac-title { font-size: 14px; }
}

/* 桌面端 */
@media (min-width: 1200px) {
  .hero { padding: 80px 64px 64px; border-radius: 44px; min-height: 420px; }
  .hero-title { font-size: 76px; letter-spacing: -3.5px; }
  .hero-slogan { font-size: 21px; margin-bottom: 44px; }
  .hero-stats { padding: 26px 40px; border-radius: 28px; }
  .hs-num { font-size: 34px; }
  .hs-label { font-size: 13px; }
  .hs-divider { height: 40px; margin: 0 8px; }
  .section-title { font-size: 22px; }
  .section-meta { font-size: 13px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
}

@media (min-width: 1600px) {
  .art-grid { grid-template-columns: repeat(4, 1fr); }
}
</style>