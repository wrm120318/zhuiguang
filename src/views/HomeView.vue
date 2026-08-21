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

/* 报告 §9.3：消费 activeSiteConfig —— 按当前 designMode 取对应主题那一套自定义配置。
   经典 / 墨金各自独立一份（互不覆盖）；旧单份结构由 store 侧向后兼容。 */
const siteConfig = computed(() => settings.activeSiteConfig)
const configLoaded = computed(() => settings.siteConfigLoaded)
/* 仅墨金模式渲染创新元素（CTA 等），确保经典档像素级冻结不被污染（铁律1） */
const isInkgold = computed(() => settings.designMode === 'inkgold')

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

/* Hero 数据条（单一来源，杜绝重复）：
   - 公开项：学科 / 美文 / 资料（全站可见）
   - 登录追加：经验值 / 等级 / 收藏（个人维度，详见 §3.1 视觉资产区去重）
   原实现 hero-stats 与 aside ha-facts 两份数据源导致「美文/资料」重复且数值冲突（4 vs 1），
   现合并为单一 heroStats，每个指标只出现一次。 */
const favorites = ref<any[]>([])
const heroStats = computed(() => {
  const list: { k: string; v: number }[] = [
    { k: '学科', v: data.subjects.length || 0 },
    { k: '美文', v: stats.value.articles || articles.value.length || 0 },
    { k: '资料', v: stats.value.resources || 0 },
  ]
  if (user.isLogin) {
    list.unshift(
      { k: '经验值', v: user.current?.exp || 0 },
      { k: '等级', v: user.current?.level || 1 },
    )
    list.push({ k: '收藏', v: favorites.value.length || 0 })
  }
  return list
})

const error = ref(false)

async function load() {
  error.value = false
  try {
    if (!settings.siteConfigLoaded) await settings.fetchSiteConfig()
    if (!data.subjects.length) await data.fetchSubjects()
    const [artsRes, statsRes, favRes] = await Promise.allSettled([
      api.articles({ limit: 6 }),
      api.stats(),
      api.favorites(),
    ])
    if (artsRes.status === 'fulfilled') articles.value = artsRes.value as any
    if (statsRes.status === 'fulfilled') stats.value = statsRes.value as any
    if (favRes.status === 'fulfilled') favorites.value = (favRes.value as any) || []
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
      <!-- 首页专属暖金呼吸光晕（仅墨金作用域可见，经典不渲染任何可见内容） -->
      <div class="home-bg" aria-hidden="true"></div>

      <!-- Hero：L1 主角瓷板（墨金两栏 / 经典单栏原样） -->
      <section class="hero">
        <!-- 釉面斜向光泽：仅墨金渲染（§2.1 釉光） -->
        <div class="hero-glaze" aria-hidden="true"></div>
        <!-- 经典档 display:contents → 布局与改版前完全等价（铁律1） -->
        <div class="hero-grid">
          <div class="hero-content home-enter">
            <div class="hero-meta">
              <div class="hero-kicker"><span class="hk-line"></span>追光 · 学科共享平台</div>
              <div class="hero-time" v-if="user.isLogin">{{ new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }}</div>
            </div>

            <h1 class="hero-title">
              <span class="hero-greet">{{ greeting }}，</span>
              <span class="hero-name">{{ user.current?.realName || '追光者' }}</span>
              <span class="hero-dot">。</span>
            </h1>

            <p class="hero-slogan">{{ siteConfig?.siteSlogan || '追光的人，终会身披万丈光芒。' }} {{ siteConfig?.heroSubtitle || '在这里分享知识，收获成长。' }}</p>

            <div class="hero-accent" aria-hidden="true"></div>

            <div class="hero-cta" v-if="isInkgold">
              <button class="cta cta-primary" @click="router.push('/subjects')">开始探索</button>
              <button class="cta cta-ghost" @click="router.push('/leaderboard')">经验排行</button>
            </div>

            <div class="hero-stats" v-if="siteConfig?.showHeroStats !== false">
              <template v-for="(s, i) in heroStats" :key="s.k">
                <div class="hs-item">
                  <div class="hs-num"><ZgCountUp :value="s.v" /></div>
                  <div class="hs-label">{{ s.k }}</div>
                </div>
                <div class="hs-divider" v-if="i < heroStats.length - 1"></div>
              </template>
            </div>
          </div>

          <!-- 视觉资产区（§3.1）：瓷纹光盘 + 平台数据微缩。仅墨金渲染，经典 display:none -->
          <aside class="hero-aside" aria-hidden="true">
            <div class="ha-disc">
              <svg viewBox="0 0 200 200" width="100%" height="100%" role="presentation">
                <!-- 注：SVG presentation attribute 不解析 var()，故一律用 inline style 写 CSS 变量，
                     确保三档主题色（含后台自定义主色）真正穿透到纹样。 -->
                <defs>
                  <radialGradient id="haCore" cx="42%" cy="36%" r="66%">
                    <stop offset="0" style="stop-color: var(--zg-accent); stop-opacity: .55" />
                    <stop offset="1" style="stop-color: var(--zg-primary); stop-opacity: .14" />
                  </radialGradient>
                  <linearGradient id="haArc" x1="20" y1="150" x2="180" y2="70" gradientUnits="userSpaceOnUse">
                    <stop offset="0" style="stop-color: var(--zg-primary); stop-opacity: .05" />
                    <stop offset=".55" style="stop-color: var(--zg-primary); stop-opacity: .42" />
                    <stop offset="1" style="stop-color: var(--zg-accent); stop-opacity: .08" />
                  </linearGradient>
                </defs>
                <!-- 瓷盘同心纹（釉面细纹，极淡） -->
                <circle cx="100" cy="100" r="86" fill="none" style="stroke: var(--zg-primary); stroke-opacity: .08" />
                <circle cx="100" cy="100" r="66" fill="none" style="stroke: var(--zg-primary); stroke-opacity: .10" />
                <circle cx="100" cy="100" r="46" fill="none" style="stroke: var(--zg-primary); stroke-opacity: .13" />
                <!-- 追光弧：品牌母题 -->
                <path d="M22 138 Q100 190 178 96" fill="none" stroke="url(#haArc)" stroke-width="7" stroke-linecap="round" />
                <!-- 暖光核 -->
                <circle cx="100" cy="92" r="30" fill="url(#haCore)" />
                <!-- 点缀光斑 -->
                <circle cx="152" cy="52" r="4.4" style="fill: var(--zg-accent); fill-opacity: .55" />
                <circle cx="46" cy="66" r="2.6" style="fill: var(--zg-primary); fill-opacity: .35" />
              </svg>
            </div>
          </aside>
        </div>
      </section>

      <!-- 公告：经典=玻璃横标；墨金=去盒化贴顶细栏（§3.1） -->
      <div v-if="showAnnouncement" class="announce-bar zg-slide-up">
        <span class="ab-icon"><ZgGlyph :emoji="'📢'" /></span>
        <span class="ab-text" v-html="renderMarkdownPreserveSpaces(siteConfig.announcementBar)"></span>
      </div>

      <!-- 快捷入口：经典=玻璃胶囊；墨金=L3 瓷纹胶囊条（融入底色、不单独投影） -->
      <div class="quick-row" v-if="displayQuickLinks && displayQuickLinks.length">
        <div v-for="(ql, i) in displayQuickLinks" :key="i" class="qr-item" @click="router.push(ql.path)">
          <div class="qr-icon" :style="iconStyle(ql.color)"><ZgGlyph :emoji="ql.icon" /></div>
          <div class="qr-text">{{ ql.label }}</div>
        </div>
      </div>

      <!-- 学科子站：经典=胶囊流；墨金=瓷片网格（桌面多列，横向利用率拉满） -->
      <div class="section" v-if="data.subjects.length && (siteConfig?.showSubjects !== false)">
        <div class="section-head">
          <div class="section-title">学科子站</div>
          <div class="section-meta">
            <span>{{ data.subjects.length }} 个学科</span>
            <span class="section-link" @click="router.push('/subjects')">查看全部 →</span>
          </div>
        </div>
        <div class="subj-row">
          <div v-for="s in data.subjects" :key="s.id" class="subj-chip" @click="router.push(`/subject/${s.slug}`)">
            <span class="sc-icon" :style="iconStyle(s.color)"><ZgGlyph :emoji="s.icon" /></span>
            <span class="sc-name">{{ s.name }}</span>
          </div>
        </div>
      </div>

      <!-- 最新美文：墨金=杂志瓷卡（封面釉光 + 标题区） -->
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

/* ============================================================
   首页背景光晕
   经典：不渲染任何可见内容（铁律1，像素级不动）
   墨金：§2.3 暖金呼吸光晕——比旧版明显但仍克制（.18~.24 + 更大 blur + 18s 缓动），
         是"瓷盘后的暖光"，不是霓虹灯。
   ============================================================ */
.home-bg { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
.zg-inkgold .home-bg::before {
  content: ''; position: absolute; top: -240px; right: -200px; width: 820px; height: 820px; border-radius: 50%;
  background: radial-gradient(circle, rgba(var(--zg-accent-rgb), 0.24), transparent 66%); filter: blur(110px);
  opacity: 0.85; animation: zgBreath 18s ease-in-out infinite;
}
.zg-inkgold .home-bg::after {
  content: ''; position: absolute; bottom: -260px; left: -180px; width: 640px; height: 640px; border-radius: 50%;
  background: radial-gradient(circle, rgba(var(--zg-primary-rgb), 0.14), transparent 68%); filter: blur(120px);
  opacity: 0.7; animation: zgBreath 22s ease-in-out infinite reverse;
}
@keyframes zgBreath {
  0%,100% { transform: scale(1); opacity: 0.58; }
  50% { transform: scale(1.07); opacity: 0.86; }
}

/* ===== HERO 通用结构 ===== */
.hero {
  position: relative; margin: 6px 0 28px; padding: 56px 54px 50px; border-radius: 28px;
  overflow: hidden; min-height: 360px; display: flex; flex-direction: column; justify-content: center;
}
/* 品牌光线母题：顶部一道金色光线 + 一道极缓流光（经典保留原样） */
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

/* Hero 两栏容器：经典 display:contents（渲染结果与改版前完全一致），墨金桌面转两栏网格 */
.hero-grid { display: contents; }
/* 釉面光泽 / 视觉资产区：经典不渲染 */
.hero-glaze, .hero-aside { display: none; }

.hero-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; flex-wrap: wrap; gap: 12px; }
.hero-tag { display: inline-flex; align-items: center; gap: 7px; padding: 8px 18px; border-radius: 999px; font-size: 13px; font-weight: 700; letter-spacing: .3px; }
.hero-time { font-size: 13px; font-weight: 600; letter-spacing: .2px; color: var(--zg-text-dim); }
/* 品牌眉头（eyebrow）：细金线 + 字距标签，立品牌识别；非矩形边框 */
.hero-kicker { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 700; letter-spacing: .14em; color: var(--zg-text-dim); }
.hero-kicker .hk-line { width: 26px; height: 2px; border-radius: 2px; background: linear-gradient(90deg, var(--zg-primary), var(--zg-accent)); }
/* 品牌点睛短金线：点睛而非框边 */
.hero-accent { width: 56px; height: 3px; border-radius: 3px; margin: 14px 0 26px; background: linear-gradient(90deg, var(--zg-primary), var(--zg-accent)); box-shadow: 0 1px 6px rgba(var(--zg-primary-rgb), .30); }

/* ===== Hero CTA（仅墨金渲染，经典不出现 → 铁律1 冻结不被污染）===== */
.hero-cta { display: flex; gap: 12px; margin: 22px 0 4px; flex-wrap: wrap; }
.cta { appearance: none; -webkit-appearance: none; border: none; cursor: pointer; font-family: var(--zg-font); font-size: 15px; font-weight: 700; letter-spacing: .3px; padding: 13px 26px; border-radius: 999px; transition: transform .2s cubic-bezier(.22,1,.36,1), box-shadow .25s, background .25s, border-color .25s; }
.cta-primary { background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2)); color: #fff; box-shadow: 0 8px 22px rgba(var(--zg-primary-rgb), .32); }
.cta-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(var(--zg-primary-rgb), .42); }
.cta-ghost { background: rgba(var(--zg-primary-rgb), .08); color: var(--zg-text); border: 1px solid rgba(var(--zg-primary-rgb), .22); }
.cta-ghost:hover { background: rgba(var(--zg-primary-rgb), .14); transform: translateY(-2px); }
.zg-inkgold .hero-cta { margin-top: 26px; }
.zg-inkgold .cta { font-weight: 600; }

/* 标题：经典=无衬线渐变展示；墨金=优雅衬线（字体族与 600 字重由 main.css 强制，报告 §2.4） */
.hero-title { margin: 0 0 14px; line-height: 1.12; font-size: 42px; font-weight: 800; letter-spacing: -1.5px; color: var(--zg-text); }
.hero-greet { font-weight: 600; opacity: .7; }
.hero-name { background: linear-gradient(118deg, var(--zg-primary-2), var(--zg-primary) 55%, var(--zg-accent)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; }
.hero-dot { color: var(--zg-primary-2); -webkit-text-fill-color: var(--zg-primary-2); }
.hero-slogan { margin: 0 0 34px; font-size: 19px; line-height: 1.7; max-width: 660px; font-weight: 500; opacity: .82; letter-spacing: .2px; }

/* 墨金标题：与"各页 logo 小标题"同款优雅衬线（600 字重 + 舒展字距，不再碑文笨重） */
.zg-inkgold .hero-title { font-size: 44px; font-weight: 600; letter-spacing: .01em; line-height: 1.22; text-shadow: none; }
.zg-inkgold .hero-greet { opacity: .74; font-weight: 600; }
/* 墨金 hero 名字：优雅衬线 + 沉稳金实色（非渐变、非流光、无廉价投影，干净高级）。
   字体族由 main.css 全局 serif 规则继承，回退链已规避 SimSun（铁律：不退化丑宋体）。 */
.zg-inkgold .hero-name {
  display: inline;
  background: none;
  -webkit-text-fill-color: var(--zg-primary);
  color: var(--zg-primary);
  filter: none;
}
.zg-inkgold .hero-name::after { display: none; }
.zg-inkgold .hero-dot { color: var(--zg-primary); -webkit-text-fill-color: var(--zg-primary); }
@keyframes zgNameShimmer { to { background-position: 220% center; } }
.zg-inkgold .hero-slogan { color: var(--zg-text-dim); opacity: .92; font-size: 17px; max-width: 30em; }

/* ===== hero-stats ===== */
.hero-stats { display: flex; align-items: center; gap: 0; padding: 22px 32px; border-radius: 20px; }
.hs-item { flex: 1; text-align: center; }
.hs-num { font-size: 30px; font-weight: 800; letter-spacing: -.6px; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hs-label { font-size: 12px; margin-top: 4px; font-weight: 600; letter-spacing: .5px; color: var(--zg-text-dim); }
/* 统计数字：沉稳金实色 + 干净数字体（tabular），静态、克制、现代 */
.zg-inkgold .hs-num {
  background: none;
  -webkit-text-fill-color: var(--zg-primary);
  color: var(--zg-primary);
  font-family: var(--zg-font); font-weight: 800; letter-spacing: -1px;
  font-variant-numeric: tabular-nums;
}
.hs-divider { width: 1px; height: 38px; background: rgba(var(--zg-primary-rgb), 0.18); }

/* ===== 经典模式：干净橙玻璃（原样冷冻，铁律1） ===== */
.hero, .announce-bar, .qr-item, .subj-chip, .art-card {
  background: linear-gradient(135deg, rgba(255,255,255,0.72), rgba(255,255,255,0.52));
  -webkit-backdrop-filter: blur(var(--zg-blur)); backdrop-filter: blur(var(--zg-blur));
  border: 1px solid rgba(255,255,255,0.6);
  box-shadow: 0 1px 0 0 rgba(255,255,255,0.9) inset, 0 -1px 0 0 rgba(120,53,15,0.04) inset, var(--zg-shadow);
}

/* ============================================================
   墨金学术 ·「温润如瓷」材质（报告 §2）
   L1 Hero 瓷板 / L2 美文卡·统计条 / L3 快捷入口·学科瓷片·公告细栏
   ============================================================ */
/* L1 主角瓷板 →「开放釉光 hero」：不再有硬边界圆角卡 + 矩形阴影。
   改为随页面暖底晕开的柔光瓷面（径向渐变边缘化开），overflow 放开让光晕自由呼吸，
   彻底打破"首页=一堆被框住的白卡"旧范式（§创新·敢于打破）。 */
.zg-inkgold .hero {
  background:
    radial-gradient(140% 130% at 16% -12%, var(--zg-porcelain) 0%, rgba(255,253,248,0) 62%),
    radial-gradient(120% 120% at 102% -6%, rgba(var(--zg-accent-rgb), .10), transparent 58%);
  border: none;
  box-shadow: none;
  -webkit-backdrop-filter: none; backdrop-filter: none;
  overflow: visible;
}
/* 墨金：无卡边后，顶部悬浮金线失去依附，移除（品牌线已由 hero-kicker / hero-accent 承担） */
.zg-inkgold .hero::before { display: none; }
.zg-inkgold .hero::after { display: none; }
/* 釉面斜向光泽：光打在釉面上的温润反光（极低透明度，大半径） */
.zg-inkgold .hero-glaze {
  display: block; position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background:
    linear-gradient(122deg, rgba(255,255,255,.62) 0%, rgba(255,255,255,.16) 20%, transparent 44%),
    radial-gradient(120% 84% at 88% 6%, rgba(var(--zg-accent-rgb), .12), transparent 62%);
}
/* 统计条：彻底去盒——坐在开放 hero 上，无边框无底色（只靠数字+分隔线表达，不是矩形框） */
.zg-inkgold .hero-stats {
  background: transparent;
  border: none;
  box-shadow: none;
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
/* 美文瓷卡：由"硬边白卡"改为清晰瓷面 + 大扩散柔影（只浮不框，阴影是好的设计） */
.zg-inkgold .art-card {
  background: var(--zg-porcelain-2);
  border: 1px solid transparent;
  box-shadow: var(--zg-glaze), var(--zg-porcelain-shadow-sm);
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
/* L3 点缀：快捷入口 / 学科瓷片 —— 极淡瓷金底，无边框无外阴影，融进页面（流动感，无矩形界限） */
.zg-inkgold .qr-item,
.zg-inkgold .subj-chip {
  background: rgba(var(--zg-primary-rgb), .05);
  border: none;
  box-shadow: none;
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
/* L3 公告：去盒化贴顶细栏（不再独立白卡，§3.1） */
.zg-inkgold .announce-bar {
  background: linear-gradient(90deg, rgba(var(--zg-primary-rgb), .07), rgba(var(--zg-accent-rgb), .03) 62%, transparent);
  border: none; border-left: 2px solid rgba(var(--zg-primary-rgb), .55);
  box-shadow: none; border-radius: 0 12px 12px 0;
  -webkit-backdrop-filter: none; backdrop-filter: none;
}
/* hover：底色微升 + 描边微显（无外阴影，保持流动感） */
.zg-inkgold .qr-item:hover,
.zg-inkgold .subj-chip:hover {
  background: rgba(var(--zg-primary-rgb), .10);
  border-color: rgba(var(--zg-primary-rgb), .30);
  box-shadow: none;
  transform: translateY(-2px);
}
.zg-inkgold .art-card:hover {
  box-shadow: var(--zg-glaze), inset 0 0 0 1px rgba(var(--zg-primary-rgb), .22), var(--zg-porcelain-shadow-sm);
  transform: translateY(-4px);
}

/* 墨金深色档：暗底暖金瓷（变量已在 main.css 深档重声明，此处只需补差异项） */
.zg-inkgold.zg-inkgold-dark .hero-glaze {
  background:
    linear-gradient(122deg, rgba(255,243,214,.075) 0%, rgba(255,243,214,.022) 22%, transparent 46%),
    radial-gradient(120% 84% at 88% 6%, rgba(var(--zg-accent-rgb), .14), transparent 62%);
}
.zg-inkgold.zg-inkgold-dark .announce-bar {
  background: linear-gradient(90deg, rgba(var(--zg-primary-rgb), .12), rgba(var(--zg-accent-rgb), .04) 62%, transparent);
  border-left-color: rgba(var(--zg-primary-rgb), .6);
}

/* ===== Hero 视觉资产区（仅墨金）===== */
.zg-inkgold .hero-aside {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
  position: relative; z-index: 2;
}
.ha-disc { width: 100%; max-width: 232px; aspect-ratio: 1; position: relative; }
/* 徽标柔光晕（"追光"光源）：极淡大扩散，无硬边，品牌纵深 */
.zg-inkgold .ha-disc::after {
  content: ''; position: absolute; inset: -16%; border-radius: 50%; z-index: 0; pointer-events: none;
  background: radial-gradient(circle, rgba(var(--zg-accent-rgb), .22), transparent 66%);
  filter: blur(22px); animation: zgBreath 16s ease-in-out infinite;
}
.zg-inkgold .ha-disc::before {
  content: ''; position: absolute; inset: 6%; border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, rgba(255,255,255,.75), rgba(var(--zg-accent-rgb), .05) 62%, transparent 74%);
  box-shadow: var(--zg-glaze), inset 0 0 0 1px rgba(var(--zg-primary-rgb), .10);
}
.zg-inkgold.zg-inkgold-dark .ha-disc::before {
  background: radial-gradient(circle at 38% 32%, rgba(255,243,214,.10), rgba(var(--zg-accent-rgb), .05) 60%, transparent 74%);
}
.ha-disc svg { position: relative; z-index: 1; display: block; animation: haSpin 68s linear infinite; }
@keyframes haSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.ha-facts { display: flex; align-items: stretch; gap: 0; width: 100%; max-width: 260px; }
.hf { flex: 1; text-align: center; padding: 0 6px; position: relative; }
.hf + .hf::before { content: ''; position: absolute; left: 0; top: 12%; bottom: 12%; width: 1px; background: rgba(var(--zg-primary-rgb), .16); }
.hf-k { display: block; font-size: 11px; letter-spacing: .18em; color: var(--zg-text-dim); opacity: .85; }
.hf-v { display: block; margin-top: 4px; font-size: 21px; font-weight: 600; color: var(--zg-text); font-variant-numeric: tabular-nums; }

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
/* 墨金：胶囊内图标底改极淡瓷金（后台自定义 color 时仍走 iconStyle 实色，铁律10） */
.zg-inkgold .qr-text { font-weight: 600; }

/* 学科 */
.section { margin: 36px 0; }
.section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.section-title { font-size: 21px; font-weight: 800; color: var(--zg-text); letter-spacing: .3px; display: flex; align-items: center; gap: 10px; }
.section-title::before { content: ''; width: 4px; height: 19px; border-radius: 3px; background: linear-gradient(180deg, var(--zg-accent), var(--zg-primary)); }
.section-meta { font-size: 12px; color: var(--zg-text-dim); font-weight: 600; letter-spacing: .3px; display: flex; align-items: center; gap: 10px; }
.section-link { color: var(--zg-primary); font-weight: 700; cursor: pointer; letter-spacing: .2px; transition: opacity .2s, transform .2s; }
.section-link:hover { opacity: .7; transform: translateX(2px); }
.zg-inkgold .section-link { font-weight: 600; }
.subj-row { display: flex; gap: 9px; flex-wrap: wrap; }
.subj-chip { display: flex; align-items: center; gap: 9px; padding: 10px 18px; cursor: pointer; border-radius: 999px; transition: transform .28s cubic-bezier(.22,1,.36,1), box-shadow .28s; }
.subj-chip:hover { transform: translateY(-2px); }
.sc-icon { width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex: none; }
.sc-name { font-weight: 700; font-size: 14px; color: var(--zg-text); letter-spacing: .2px; }
/* 墨金：标题改优雅衬线细节（字体族由 main.css 统一），金条改发丝短线 */
.zg-inkgold .section-title { font-weight: 600; letter-spacing: .02em; }
.zg-inkgold .section-title::before { width: 2px; height: 16px; border-radius: 2px; opacity: .8; }
.zg-inkgold .sc-name { font-weight: 600; }

/* 美文 */
.art-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
.art-card { overflow: hidden; cursor: pointer; border-radius: 22px; transition: transform .3s cubic-bezier(.22,1,.36,1), box-shadow .3s; }
.art-card:hover { transform: translateY(-4px); }
.ac-cover { position: relative; height: 150px; background-size: cover; background-position: center; }
.ac-cover::after { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 60px; background: linear-gradient(180deg, rgba(255,255,255,0.25), transparent); pointer-events: none; }
.ac-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb), 0.45), rgba(var(--zg-primary-2-rgb), 0.35)); font-size: 44px; font-weight: 800; color: rgba(255,255,255,0.85); }
.zg-inkgold .ac-placeholder { background: linear-gradient(135deg, rgba(var(--zg-primary-rgb), 0.10), rgba(var(--zg-accent-rgb), 0.05)); color: var(--zg-primary); font-weight: 600; }
.zg-inkgold-dark .ac-placeholder { color: var(--zg-accent); }
/* 墨金：封面顶部釉光（暖金而非冷白） */
.zg-inkgold .ac-cover::after { height: 72px; background: linear-gradient(180deg, rgba(255,253,248,.42), transparent); }
.zg-inkgold.zg-inkgold-dark .ac-cover::after { background: linear-gradient(180deg, rgba(255,243,214,.10), transparent); }
.ac-body { padding: 15px 18px; }
.ac-title { font-weight: 700; font-size: 15px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--zg-text); }
.ac-meta { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-author { font-weight: 500; }
.ac-dot { opacity: .5; }
.ac-like { display: inline-flex; align-items: center; gap: 3px; }

.zg-footer { text-align: center; padding: 40px 0 8px; margin-top: 48px; font-size: 12px; color: var(--zg-text-dim); opacity: .65; white-space: pre-wrap; word-wrap: break-word; }
.zg-footer :deep(br) { display: block; content: ""; margin: 4px 0; }
.zg-footer :deep(*) { white-space: pre-wrap; }

/* ===== 平板（768–1199px）：墨金两列过渡（§3.3） ===== */
@media (min-width: 768px) and (max-width: 1199px) {
  .zg-inkgold .subj-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .zg-inkgold .subj-chip { border-radius: 16px; padding: 12px 14px; }
  .zg-inkgold .art-grid { grid-template-columns: repeat(2, 1fr); gap: 16px; }
}

/* ===== 桌面端（≥1200px）：解决"空"——Hero 两栏 + 多列网格 ===== */
@media (min-width: 1200px) {
  .hero { padding: 68px 64px 60px; border-radius: 32px; min-height: 400px; }
  .hero-title { font-size: 48px; letter-spacing: -2px; }
  .zg-inkgold .hero-title { font-size: 46px; letter-spacing: .01em; }
  .hero-slogan { font-size: 21px; margin-bottom: 42px; }
  .zg-inkgold .hero-slogan { font-size: 18px; margin-bottom: 34px; }
  .hero-stats { padding: 26px 40px; border-radius: 24px; }
  .hs-num { font-size: 34px; }
  .hs-label { font-size: 13px; }
  .hs-divider { height: 42px; }
  .section-title { font-size: 22px; }
  .section-meta { font-size: 13px; }
  .art-grid { grid-template-columns: repeat(3, 1fr); gap: 18px; }

  /* 墨金：桌面幅宽放宽到 1360（§3.1），横向利用率拉满 */
  .zg-inkgold .home-page { max-width: 1360px; }
  /* Hero 两栏：左文案 + 右视觉资产 */
  .zg-inkgold .hero-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 46px; align-items: center; }
  .zg-inkgold .hero { padding: 64px 60px 58px; }
  .zg-inkgold .hero-aside::before {
    content: ''; position: absolute; left: -23px; top: 8%; bottom: 8%; width: 1px;
    background: linear-gradient(180deg, transparent, rgba(var(--zg-primary-rgb), .22), transparent);
  }
  /* 学科瓷片网格：5 列（1360 宽下每片 ~250px） */
  .zg-inkgold .subj-row { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
  .zg-inkgold .subj-chip { border-radius: 16px; padding: 13px 16px; }
  /* 快捷入口瓷纹条：等分铺满一行，不再挤在左侧留大空 */
  .zg-inkgold .quick-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; overflow: visible; }
  .zg-inkgold .qr-item { border-radius: 18px; padding: 14px 18px; justify-content: flex-start; }
  .zg-inkgold .art-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
}
@media (min-width: 1440px) {
  .zg-inkgold .subj-row { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .zg-inkgold .art-grid { grid-template-columns: repeat(4, 1fr); }
  .zg-inkgold .hero-grid { grid-template-columns: minmax(0, 1fr) 330px; gap: 54px; }
}
@media (min-width: 1600px) { .art-grid { grid-template-columns: repeat(4, 1fr); } }

/* ===== 移动端（≤767px）：Hero 单栏（文案上 / 资产缩为顶部细带），触控 ≥40px ===== */
@media (max-width: 768px) {
  .hero { margin: 0 0 20px; padding: 34px 22px 30px; border-radius: 24px; min-height: auto; }
  .hero-meta { margin-bottom: 14px; }
  .hero-tag { font-size: 12px; padding: 6px 14px; }
  .hero-time { display: none; }
  .hero-cta { margin: 18px 0 2px; gap: 10px; }
  .cta { padding: 12px 22px; font-size: 14px; }
  .hero-title { font-size: 30px; letter-spacing: -1px; margin-bottom: 10px; }
  .zg-inkgold .hero-title { font-size: 29px; letter-spacing: .01em; line-height: 1.3; }
  .hero-slogan { font-size: 14px; margin-bottom: 22px; }
  .zg-inkgold .hero-slogan { font-size: 14px; }
  .hero-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; padding: 16px 14px; border-radius: 18px; }
  .hs-divider { display: none; }
  .hs-num { font-size: 22px; }
  .hs-label { font-size: 11px; }
  .announce-bar { padding: 12px 16px; margin-bottom: 20px; border-radius: 14px; }
  .zg-inkgold .announce-bar { border-radius: 0 10px 10px 0; padding: 11px 14px; }
  .ab-text { font-size: 13px; }
  .quick-row { margin-bottom: 24px; gap: 8px; }
  .qr-item { padding: 10px 14px; gap: 9px; min-height: 44px; }
  .qr-icon { width: 30px; height: 30px; font-size: 15px; border-radius: 9px; }
  .qr-text { font-size: 13px; }
  .section { margin: 24px 0; }
  .section-title { font-size: 18px; }
  .section-meta { font-size: 11px; }
  .subj-chip { padding: 8px 14px; min-height: 42px; }
  .sc-icon { width: 26px; height: 26px; font-size: 14px; border-radius: 8px; }
  .sc-name { font-size: 13px; }
  .art-card { border-radius: 18px; }
  .ac-cover { height: 130px; }
  .ac-body { padding: 12px 14px; }
  .ac-title { font-size: 14px; }

  /* 墨金移动端：资产区收为顶部细光带（瓷盘不占高），学科横滚胶囊 */
  .zg-inkgold .hero-grid { display: contents; }
  .zg-inkgold .hero-aside { display: flex; flex-direction: row; align-items: center; gap: 14px; margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(var(--zg-primary-rgb), .14); }
  .zg-inkgold .ha-disc { width: 62px; max-width: 62px; flex: none; }
  .zg-inkgold .ha-facts { max-width: none; }
  .zg-inkgold .hf-v { font-size: 17px; }
  .zg-inkgold .hf-k { font-size: 10px; letter-spacing: .14em; }
  .zg-inkgold .subj-row { display: flex; flex-wrap: nowrap; overflow-x: auto; gap: 8px; padding-bottom: 4px; scrollbar-width: none; }
  .zg-inkgold .subj-row::-webkit-scrollbar { display: none; }
  .zg-inkgold .subj-chip { flex: none; white-space: nowrap; }
}

/* 无障碍：尊重"减少动态效果"偏好 */
@media (prefers-reduced-motion: reduce) {
  .ha-disc svg { animation: none; }
  .zg-inkgold .home-bg::before, .zg-inkgold .home-bg::after { animation: none; }
}
</style>
