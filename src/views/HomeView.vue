<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'

const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const articles = ref<any[]>([])
const stats = ref<any>({})
const siteConfig = ref<any>(null)

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
})

onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  try {
    articles.value = (await api.articles({ limit: 6 })) as any
  } catch { /* */ }
  try {
    stats.value = (await api.stats()) as any
  } catch { /* */ }
  try {
    siteConfig.value = await api.getSiteConfig()
  } catch { /* */ }
})

function goArticle(id: number) { router.push(`/article/${id}`) }
</script>

<template>
  <div class="page zg-container">
    <!-- Hero -->
    <div class="hero glass-strong zg-slide-up">
      <div class="hero-bg"></div>
      <div class="hero-content">
        <div class="hero-tag">🌟 {{ siteConfig?.siteName || '追光学科共享平台' }}</div>
        <h1 class="hero-title">{{ greeting }}，<span class="zg-grad-text">{{ user.current?.realName || '追光者' }}</span>！</h1>
        <p class="hero-sub">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }} {{ siteConfig?.heroSubtitle || '在这里分享知识，收获成长。' }}</p>
        <div class="hero-stats" v-if="user.isLogin">
          <div class="hs-item">
            <div class="hs-num">{{ user.current?.exp || 0 }}</div>
            <div class="hs-label">经验值</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num">Lv.{{ user.current?.level || 1 }}</div>
            <div class="hs-label">等级</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num">{{ stats.articles || 0 }}</div>
            <div class="hs-label">美文</div>
          </div>
          <div class="hs-divider"></div>
          <div class="hs-item">
            <div class="hs-num">{{ stats.resources || 0 }}</div>
            <div class="hs-label">资料</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 公告栏 -->
    <div v-if="siteConfig?.showAnnouncementBar && siteConfig?.announcementBar" class="announce-bar glass zg-slide-up" style="animation-delay:0.1s">
      <span class="ab-icon">📢</span>
      <span class="ab-text">{{ siteConfig.announcementBar }}</span>
    </div>

    <!-- 快捷入口 -->
    <div class="quick-grid" v-if="siteConfig?.showQuickLinks !== false">
      <template v-if="siteConfig?.quickLinks?.length">
        <div v-for="(ql, i) in siteConfig.quickLinks" :key="i" class="qg-card glass zg-card" @click="router.push(ql.path)">
          <div class="qg-icon" :style="{ background: `linear-gradient(135deg, ${ql.color || '#F59E0B'}, ${(ql.color || '#F59E0B')}aa)` }">{{ ql.icon }}</div>
          <div class="qg-text">{{ ql.label }}</div>
        </div>
      </template>
      <template v-else>
        <div class="qg-card glass zg-card" @click="router.push('/subjects')">
          <div class="qg-icon" style="background:linear-gradient(135deg,#F59E0B,#FB923C)">📚</div>
          <div class="qg-text">学科广场</div>
        </div>
        <div class="qg-card glass zg-card" @click="router.push('/leaderboard')">
          <div class="qg-icon" style="background:linear-gradient(135deg,#FBBF24,#F59E0B)">🏆</div>
          <div class="qg-text">经验排行</div>
        </div>
        <div class="qg-card glass zg-card" @click="router.push('/profile')">
          <div class="qg-icon" style="background:linear-gradient(135deg,#FB923C,#EF4444)">👤</div>
          <div class="qg-text">个人中心</div>
        </div>
        <div class="qg-card glass zg-card" @click="router.push('/favorites')">
          <div class="qg-icon" style="background:linear-gradient(135deg,#FDE68A,#FBBF24)">⭐</div>
          <div class="qg-text">我的收藏</div>
        </div>
      </template>
    </div>

    <!-- 学科 -->
    <div class="section">
      <div class="section-title">学科子站</div>
      <div class="subj-row">
        <div v-for="s in data.subjects" :key="s.id" class="subj-chip glass zg-card" @click="router.push(`/subject/${s.slug}`)">
          <span class="sc-icon" :style="{ background: `linear-gradient(135deg, ${s.color}, ${s.color}aa)` }">{{ s.icon }}</span>
          <span class="sc-name">{{ s.name }}</span>
        </div>
      </div>
    </div>

    <!-- 最新美文 -->
    <div class="section" v-if="articles.length">
      <div class="section-title">最新美文</div>
      <div class="art-grid">
        <div v-for="(a, i) in articles" :key="a.id" class="art-card glass zg-card zg-slide-up" :style="{ animationDelay: `${i * 0.08}s` }" @click="goArticle(a.id)">
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
              <span>❤ {{ a.likes || 0 }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hero { position: relative; overflow: hidden; margin-top: 20px; border-radius: 24px; padding: 40px; }
.hero-bg { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(251,191,36,0.12), rgba(251,146,60,0.08)); z-index: 0; }
.hero-content { position: relative; z-index: 1; }
.hero-tag { display: inline-block; padding: 6px 14px; border-radius: 30px; background: rgba(245,158,11,.15); border: 1px solid rgba(245,158,11,.3); font-size: var(--zg-fs-sm); color: #b45309; margin-bottom: 18px; font-weight: 500; }
.hero-title { font-size: var(--zg-fs-2xl); font-weight: 800; line-height: 1.3; }
.hero-sub { color: var(--zg-text-dim); margin-top: 10px; font-size: var(--zg-fs-base); line-height: 1.6; }
.hero-stats { display: flex; align-items: center; gap: 20px; margin-top: 28px; }
.hs-item { text-align: center; }
.hs-num { font-size: var(--zg-fs-xl); font-weight: 800; color: var(--zg-text); }
.hs-label { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 2px; }
.hs-divider { width: 1px; height: 30px; background: rgba(245,158,11,.15); }

.quick-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 20px; }

.announce-bar { display: flex; align-items: center; gap: 10px; padding: 12px 20px; margin-top: 14px; border-radius: 14px; border: 1px solid rgba(245,158,11,.25); }
.ab-icon { font-size: 18px; }
.ab-text { font-size: var(--zg-fs-sm); color: var(--zg-text); }
.qg-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 20px 12px; cursor: pointer; }
.qg-icon { width: 52px; height: 52px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 26px; box-shadow: 0 4px 14px rgba(245,158,11,.2); }
.qg-text { font-size: var(--zg-fs-sm); font-weight: 600; color: var(--zg-text); }

.section { margin-top: 28px; }
.subj-row { display: flex; gap: 12px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 8px; padding: 10px 16px; cursor: pointer; }
.sc-icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; }
.sc-name { font-weight: 600; font-size: var(--zg-fs-sm); }

.art-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.art-card { overflow: hidden; cursor: pointer; }
.ac-cover { height: 140px; background-size: cover; background-position: center; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(251,191,36,.2), rgba(251,146,60,.15)); font-size: 48px; font-weight: 800; color: rgba(245,158,11,.3); }
.ac-body { padding: 14px 16px; }
.ac-title { font-weight: 700; font-size: var(--zg-fs-base); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); }
.ac-dot { opacity: .5; }

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
