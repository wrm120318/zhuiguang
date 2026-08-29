<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { useSettingsStore } from '@/store/settings'
import { ElMessage, ElNotification } from 'element-plus'
import { api } from '@/api'
import LogoMark from '@/components/LogoMark.vue'

const router = useRouter()
const route = useRoute()
const user = useUserStore()
const data = useDataStore()
const settings = useSettingsStore()

// 站点配置（品牌名称等），未配置或加载失败时回退默认品牌名「追光」
// 报告 §9.3：消费 activeSiteConfig —— 经典 / 墨金各自一套自定义，按当前 designMode 取用
const siteConfig = computed(() => settings.activeSiteConfig)
const brandName = computed(() => siteConfig.value?.navTitle || siteConfig.value?.siteName || '追光')
// 导航按钮可见性：优先使用站点配置，回退功能开关
const showSearch = computed(() => siteConfig.value?.showNavSearch !== false && settings.isEnabled('search'))
const showMessage = computed(() => siteConfig.value?.showNavMessage !== false && settings.isEnabled('message'))
const showNotice = computed(() => siteConfig.value?.showNavNotice !== false)

const messageUnread = ref(0)

async function refreshUnread() {
  if (!user.isLogin) return
  try { const r: any = await api.messageUnreadCount(); messageUnread.value = r?.count || 0 } catch { /* */ }
}

const noticeVisible = ref(false)
const drawerVisible = ref(false)
const settingsVisible = ref(false)

const myNotices = ref<any[]>([])
const unread = ref(0)

// 字体大小调节
const fontScale = ref(Number(localStorage.getItem('zg_fs_scale') || 1))
const fontLabels = ['小', '标准', '大', '特大']
const fontSteps = [0.85, 1, 1.15, 1.3]

function applyFontScale() {
  document.documentElement.style.setProperty('--zg-fs-scale', String(fontScale.value))
  localStorage.setItem('zg_fs_scale', String(fontScale.value))
}
function setFontScale(idx: number) {
  fontScale.value = fontSteps[idx]
  applyFontScale()
}
function fontScaleIndex() {
  const i = fontSteps.indexOf(fontScale.value)
  return i >= 0 ? i : 1
}

// 搜索
const searchVisible = ref(false)
const searchQuery = ref('')
const searchResults = ref<{ articles: any[]; resources: any[] }>({ articles: [], resources: [] })
const searching = ref(false)

async function doSearch() {
  if (!searchQuery.value.trim()) { searchResults.value = { articles: [], resources: [] }; return }
  searching.value = true
  try {
    searchResults.value = (await api.search(searchQuery.value)) as any
  } finally { searching.value = false }
}

function goSearch() {
  if (!searchQuery.value.trim()) return
  searchVisible.value = false
  router.push(`/search?q=${encodeURIComponent(searchQuery.value)}`)
  searchQuery.value = ''
}

async function loadNotices() {
  if (!user.isLogin) return
  myNotices.value = (await api.notices()) as any
  unread.value = myNotices.value.filter((n: any) => !n.read).length
}
onMounted(() => {
  applyFontScale(); loadNotices(); refreshUnread()
  if (!settings.siteConfigLoaded) settings.fetchSiteConfig()
  // 站内信已读后即时刷新未读数
  window.addEventListener('messages-read', refreshUnread)
  // 手机端底栏「通知中心」按钮 → 打开通知抽屉
  window.addEventListener('zg-open-notice', openNoticeFromBar)
  // 【v4.2.1】启动通知轮询
  startNoticePolling()
})
function openNoticeFromBar() { noticeVisible.value = true }
onUnmounted(() => {
  window.removeEventListener('messages-read', refreshUnread)
  window.removeEventListener('zg-open-notice', openNoticeFromBar)
  stopNoticePolling()
})

// 路由变化时刷新未读信件数（站内信已读后红色徽标即时消失）
watch(() => route.fullPath, () => { refreshUnread() })

const navItems = computed(() => {
  const items: { name: string; label: string; to: string }[] = [{ name: 'home', label: '首页', to: '/' }]
  if (settings.isEnabled('subjects')) items.push({ name: 'subjects', label: '学科', to: '/subjects' })
  if (settings.isEnabled('guide')) items.push({ name: 'guide', label: '说明', to: '/guide' })
  if (settings.isEnabled('blog')) items.push({ name: 'blog', label: '博客', to: '/blog' })
  if (settings.isEnabled('announcement')) items.push({ name: 'announcements', label: '公告', to: '/announcements' })
  if (settings.isEnabled('quiz')) items.push({ name: 'quizzes', label: '题库', to: '/quizzes' })
  if (settings.isEnabled('leaderboard')) items.push({ name: 'leaderboard', label: '经验榜', to: '/leaderboard' })
  if (user.isStaff) items.push({ name: 'admin', label: '管理', to: '/admin' })
  return items
})

function go(to: string) { router.push(to); drawerVisible.value = false }
function roleLabel(r?: string) { return r === 'SUPER_ADMIN' ? '超管' : r === 'TEACHER' ? '教师' : '学生' }
const reading = ref(false)
async function readAll() {
  if (reading.value) return
  reading.value = true
  try {
    await api.readAllNotices()
    await loadNotices()
    ElMessage.success('已全部已读')
  } catch (e: any) {
    ElMessage.error(e?.message || '操作失败，请稍后重试')
  } finally {
    reading.value = false
  }
}
function logout() { user.logout(); router.push('/login') }
function typeLabel(t: string) {
  return ({ audit: '审核', query: '查询', system: '系统', teacher: '教师', comment: '评论', like: '点赞' } as Record<string, string>)[t] || '通知'
}

// 【v4.2.1】点击通知项：标记已读 + 跳转到 target_url + 滚动到锚点
async function openNotice(n: any) {
  if (!n.read) {
    try { await api.readNotice(n.id); n.read = 1 } catch { /* */ }
    unread.value = Math.max(0, unread.value - 1)
  }
  if (n.target_url) {
    noticeVisible.value = false
    // 解析 hash 锚点（如 /article/123#comment-456 → 456）
    const hashIdx = n.target_url.indexOf('#')
    const path = hashIdx >= 0 ? n.target_url.slice(0, hashIdx) : n.target_url
    const anchor = hashIdx >= 0 ? n.target_url.slice(hashIdx + 1) : ''
    await router.push(path)
    // 等路由切换 + DOM 更新后，滚到锚点
    if (anchor) {
      await nextTick()
      // 再多等一帧，避免评论数据异步加载
      setTimeout(() => {
        const el = document.getElementById(anchor)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 120)
    }
  }
}

// 【v4.2.1】定时轮询：让通知中心"实时"（15 秒）+ 新通知桌面 toast 提醒
let noticeTimer: any = null
let lastSeenIds: Set<number> = new Set()
function startNoticePolling() {
  stopNoticePolling()
  // 立即拉一次，初始化 lastSeenIds
  pollNotices()
  noticeTimer = setInterval(pollNotices, 15000)
}
async function pollNotices() {
  if (!user.isLogin) return
  try {
    const resp: any = await api.notices()
    const list: any[] = Array.isArray(resp) ? resp : (resp?.data || [])
    myNotices.value = list
    unread.value = list.filter((n: any) => !n.read).length
    // 首次拉取：只记录 id，不弹 toast
    if (lastSeenIds.size === 0) {
      list.forEach((n: any) => lastSeenIds.add(n.id))
      return
    }
    // 增量：新出现的 comment / like 通知 → 弹桌面 toast
    const fresh = list.filter((n: any) => !lastSeenIds.has(n.id) && (n.type === 'comment' || n.type === 'like'))
    if (fresh.length) {
      // 只弹最新的 1 条，避免连发打扰
      const n = fresh[0]
      try {
        ElNotification({
          title: n.title,
          message: n.content,
          type: n.type === 'like' ? 'success' : 'info',
          duration: 4500,
          position: 'top-right',
          onClick: () => openNotice(n),
        })
      } catch { /* ElNotification 不存在时静默 */ }
    }
    // 同步 id 集合
    list.forEach((n: any) => lastSeenIds.add(n.id))
  } catch { /* 静默 */ }
}
function stopNoticePolling() {
  if (noticeTimer) { clearInterval(noticeTimer); noticeTimer = null }
}
</script>

<template>
  <header class="nav glass">
    <div class="nav-inner zg-container">
      <div class="brand" @click="go('/')">
        <LogoMark class="logo" />
        <span class="brand-name zg-grad-text">{{ brandName }}</span>
      </div>

      <nav class="links">
        <router-link v-for="it in navItems" :key="it.name" :to="it.to" class="nav-link" active-class="active">{{ it.label }}</router-link>
      </nav>

      <div class="actions" v-if="user.isLogin">
        <el-button v-if="showSearch" text circle class="action-btn" aria-label="搜索" @click="searchVisible = true"><el-icon><Search /></el-icon></el-button>

        <el-badge v-if="showMessage" :value="messageUnread" :hidden="messageUnread === 0" class="msg-bell">
          <el-button text circle class="action-btn" aria-label="站内信" @click="go('/messages')"><el-icon><ChatDotRound /></el-icon></el-button>
        </el-badge>

        <el-popover trigger="click" width="240" placement="bottom-end" :visible="settingsVisible" @update:visible="settingsVisible = $event">
          <template #reference>
            <el-button text circle class="action-btn" aria-label="界面设置" @click="settingsVisible = !settingsVisible"><el-icon><Setting /></el-icon></el-button>
          </template>
          <div class="settings-panel">
            <div class="sp-title">字体大小</div>
            <div class="sp-fonts">
              <div v-for="(label, i) in fontLabels" :key="i" class="sp-font-btn" :class="{ on: fontScaleIndex() === i }" @click="setFontScale(i)">
                <span :style="{ fontSize: (11 + i * 2) + 'px' }">A</span>
                <span class="sp-font-label">{{ label }}</span>
              </div>
            </div>
          </div>
        </el-popover>

        <el-badge v-if="showNotice" :value="unread" :hidden="unread === 0" class="bell">
          <el-button text circle class="action-btn" aria-label="通知中心" @click="noticeVisible = true"><el-icon><Bell /></el-icon></el-button>
        </el-badge>

        <el-dropdown trigger="click" aria-label="个人菜单">
          <div class="me">
            <ZgAvatar :src="user.current?.avatar" :size="36" :fallback="user.current?.realName" />
            <div class="me-meta">
              <div class="me-name">{{ user.current?.realName }}</div>
              <div class="me-role">{{ roleLabel(user.current?.role) }} · Lv.{{ user.current?.level }}</div>
            </div>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="go('/profile')"><el-icon><User /></el-icon>个人中心</el-dropdown-item>
              <el-dropdown-item @click="go('/leaderboard')"><el-icon><Trophy /></el-icon>经验榜</el-dropdown-item>
              <el-dropdown-item @click="go('/favorites')"><el-icon><Star /></el-icon>我的收藏</el-dropdown-item>
              <el-dropdown-item divided @click="logout"><el-icon><SwitchButton /></el-icon>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>

      <el-button v-else type="primary" round size="small" @click="go('/login')">登录</el-button>

      <el-button class="menu-btn" text circle aria-label="打开菜单" @click="drawerVisible = true"><el-icon><Menu /></el-icon></el-button>
    </div>
  </header>

  <!-- 移动端抽屉（左侧菜单） -->
  <el-drawer v-model="drawerVisible" direction="ltr" size="72%" :show-close="false">
    <div class="drawer">
      <div class="d-brand"><LogoMark class="logo" /><span class="zg-grad-text">{{ brandName }}</span></div>
      <div class="d-search" @click="drawerVisible = false; searchVisible = true">
        <el-icon><Search /></el-icon> 搜索美文 / 资料…
      </div>
      <div class="d-user" v-if="user.isLogin">
        <ZgAvatar :src="user.current?.avatar" :size="48" :fallback="user.current?.realName" />
        <div><div class="du-name">{{ user.current?.realName }}</div><div class="du-role">{{ roleLabel(user.current?.role) }} · Lv.{{ user.current?.level }}</div></div>
      </div>
      <div class="d-list">
        <div class="d-item" @click="go('/')"><el-icon><HomeFilled /></el-icon><span>首页</span></div>
        <div class="d-item" v-if="settings.isEnabled('subjects')" @click="go('/subjects')"><el-icon><Reading /></el-icon><span>全部学科</span></div>
        <div class="d-item" v-if="settings.isEnabled('guide')" @click="go('/guide')"><el-icon><Notebook /></el-icon><span>网站说明</span></div>
        <div class="d-item" v-if="settings.isEnabled('blog')" @click="go('/blog')"><el-icon><EditPen /></el-icon><span>网站博客</span></div>
        <div class="d-item" v-if="settings.isEnabled('announcement')" @click="go('/announcements')"><el-icon><Promotion /></el-icon><span>网站公告</span></div>
        <div class="d-item" v-if="settings.isEnabled('quiz')" @click="go('/quizzes')"><el-icon><Edit /></el-icon><span>题库自测</span></div>
        <div class="d-item" v-if="settings.isEnabled('leaderboard')" @click="go('/leaderboard')"><el-icon><Trophy /></el-icon><span>经验榜</span></div>
        <div class="d-item" @click="go('/profile')"><el-icon><User /></el-icon><span>个人中心</span></div>
        <div class="d-item" v-if="showNotice" @click="noticeVisible = true"><el-icon><Bell /></el-icon><span>通知中心</span><span v-if="unread" class="d-badge">{{ unread }}</span></div>
        <div class="d-item" v-if="settings.isEnabled('favorites')" @click="go('/favorites')"><el-icon><Star /></el-icon><span>我的收藏</span></div>
        <div class="d-item" v-if="user.isStaff" @click="go('/admin')"><el-icon><Setting /></el-icon><span>管理后台</span></div>
        <div class="d-item" @click="drawerVisible = false; settingsVisible = true"><el-icon><ZoomIn /></el-icon><span>字体设置</span></div>
        <div class="d-item" v-if="user.isLogin" @click="logout"><el-icon><SwitchButton /></el-icon><span>退出登录</span></div>
        <div class="d-item" v-else @click="go('/login')"><el-icon><Key /></el-icon><span>登录</span></div>
      </div>
      <div class="d-subj-title">学科子站</div>
      <div class="d-subj-grid">
        <div v-for="s in data.subjects" :key="s.id" class="d-subj" @click="go(`/subject/${s.slug}`)"><ZgGlyph :emoji="s.icon" /> {{ s.name }}</div>
      </div>
    </div>
  </el-drawer>

  <!-- 搜索弹窗 -->
  <el-dialog v-model="searchVisible" width="600px" class="search-dialog">
    <template #title><span class="sd-title"><el-icon><Search /></el-icon> 搜索</span></template>
    <div class="search-bar">
      <el-input v-model="searchQuery" placeholder="搜索美文、资料…" size="large" @keyup.enter="goSearch">
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <el-button type="primary" size="large" @click="goSearch">搜索</el-button>
    </div>
    <div class="search-quick" v-if="!searchQuery">
      <div class="sq-label">热门搜索</div>
      <div class="sq-tags">
        <span class="sq-tag" @click="searchQuery = '语文'; doSearch()">语文</span>
        <span class="sq-tag" @click="searchQuery = '数学'; doSearch()">数学</span>
        <span class="sq-tag" @click="searchQuery = '英语'; doSearch()">英语</span>
        <span class="sq-tag" @click="searchQuery = '课件'; doSearch()">课件</span>
      </div>
    </div>
    <div class="search-results" v-if="searchQuery" v-loading="searching">
      <div v-if="searchResults.articles?.length" class="sr-group">
        <div class="sr-title"><ZgGlyph :emoji="'✍️'" /> 美文 ({{ searchResults.articles.length }})</div>
        <div v-for="a in searchResults.articles" :key="a.id" class="sr-item" @click="searchVisible = false; router.push(`/article/${a.id}`)">
          <div class="sr-item-title">{{ a.title }}</div>
          <div class="sr-item-meta">{{ a.author }} · {{ a.category }}</div>
        </div>
      </div>
      <div v-if="searchResults.resources?.length" class="sr-group">
        <div class="sr-title"><ZgGlyph :emoji="'📦'" /> 资料 ({{ searchResults.resources.length }})</div>
        <div v-for="r in searchResults.resources" :key="r.id" class="sr-item" @click="searchVisible = false; router.push(`/subject/${data.subjectById(r.subject_id)?.slug}`)">
          <div class="sr-item-title">{{ r.title }}</div>
          <div class="sr-item-meta">{{ r.category }} · <ZgGlyph :emoji="'⬇'" /> {{ r.downloads }}</div>
        </div>
      </div>
      <el-empty v-if="searchQuery && !searchResults.articles?.length && !searchResults.resources?.length && !searching" description="未找到结果" />
    </div>
  </el-dialog>

  <el-drawer v-model="noticeVisible" title="通知中心" direction="rtl" size="380px" v-swipe-close>
    <div class="notice-head">
      <span>{{ unread }} 条未读</span>
      <el-button text size="small" :loading="reading" @click="readAll">全部已读</el-button>
    </div>
    <div class="notice-list">
      <div v-for="n in myNotices" :key="n.id" class="notice-item" :class="{ unread: !n.read }" @click="openNotice(n)">
        <div class="n-type" :class="n.type">{{ typeLabel(n.type) }}</div>
        <div class="n-body">
          <div class="n-title">{{ n.title }}</div>
          <div class="n-content">{{ n.content }}</div>
          <div class="n-foot">
            <span class="n-time">{{ n.created_at }}</span>
            <span v-if="n.target_url" class="n-go">查看 →</span>
          </div>
        </div>
      </div>
      <el-empty v-if="!myNotices.length" description="暂无通知" />
    </div>
  </el-drawer>
</template>

<style scoped>
/* ===== v17.1 真液态玻璃导航栏 - L1导航层（中blur+暖金细边框+柔和阴影）===== */
.nav {
  position: sticky;
  top: 0;
  z-index: 100;
  border-radius: 28px;
  padding-top: env(safe-area-inset-top);
  background: linear-gradient(155deg, var(--zg-glass-1-bg), var(--zg-glass-1-bg-2));
  -webkit-backdrop-filter: blur(var(--zg-glass-blur)) saturate(var(--zg-glass-sat));
  backdrop-filter: blur(var(--zg-glass-blur)) saturate(var(--zg-glass-sat));
  border: 1px solid var(--zg-glass-1-border);
  box-shadow: var(--zg-glass-1-shadow);
  transition: box-shadow .4s var(--zg-ease), background .3s ease;
  overflow: hidden;
}
/* 导航栏顶部1px细高光条（v17.1：更柔和） */
.nav::before {
  content: '';
  position: absolute;
  top: 0;
  left: 10%;
  right: 10%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent);
  pointer-events: none;
  z-index: 1;
}
/* 深色档导航栏高光用暖金色调 */
.zg-inkgold-dark .nav::before {
  background: linear-gradient(90deg, transparent, rgba(255,243,214,0.4), transparent);
}
/* 确保nav内容在高光之上 */
.nav-inner { position: relative; z-index: 2; }
/* 经典橙色模式导航栏保持兼容 - 不动经典 */
html:not(.zg-inkgold) .nav {
  background: linear-gradient(180deg, rgba(255,255,255,0.88), rgba(255,248,240,0.82));
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  backdrop-filter: blur(20px) saturate(150%);
  border: none;
  box-shadow: 0 1px 3px rgba(245,158,11,0.08);
  border-radius: 0;
  overflow: visible;
}
html:not(.zg-inkgold) .nav::before { display: none; }
.nav-inner { display: flex; align-items: center; height: 60px; gap: 16px; }
.brand { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 6px 10px 6px 4px; border-radius: 16px; transition: all .3s var(--zg-spring); }
.brand:hover { background: rgba(var(--zg-primary-rgb),0.06); }
.logo { font-size: 26px; filter: drop-shadow(0 2px 8px rgba(var(--zg-primary-rgb),0.35)); transition: transform .4s var(--zg-spring); }
.brand:hover .logo { transform: scale(1.08) rotate(-5deg); }
.brand-name { font-size: 22px; font-weight: 800; letter-spacing: 1px; }
.links { display: flex; gap: 4px; flex: 1; margin-left: 12px; }
.nav-link {
  padding: 9px 16px;
  border-radius: 12px;
  color: var(--zg-text-dim);
  font-weight: 600;
  transition: all .3s var(--zg-spring);
  font-size: var(--zg-fs-sm);
  position: relative;
}
.nav-link:hover { color: var(--zg-text); background: rgba(255,255,255,0.35); transform: translateY(-1px); }
.nav-link.active {
  color: var(--zg-primary);
  background: linear-gradient(155deg, rgba(255,255,255,0.45), rgba(255,255,255,0.20));
  font-weight: 700;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.6),
    0 2px 8px -2px rgba(var(--zg-primary-rgb),0.10);
}
.zg-inkgold-dark .nav-link:hover { background: rgba(255,243,214,0.08); }
.zg-inkgold-dark .nav-link.active {
  background: linear-gradient(155deg, rgba(var(--zg-primary-rgb),0.18), rgba(var(--zg-primary-rgb),0.10));
  box-shadow:
    inset 0 1px 0 rgba(255,243,214,0.12),
    0 2px 8px -2px rgba(0,0,0,0.20);
}
.actions { display: flex; align-items: center; gap: 4px; }
.action-btn {
  color: var(--zg-text) !important;
  font-size: 18px !important;
  width: 44px !important;
  height: 44px !important;
  border-radius: 12px !important;
  transition: all .3s var(--zg-spring) !important;
}
.action-btn:hover {
  background: rgba(255,255,255,0.4) !important;
  transform: translateY(-1px);
}
.bell :deep(.el-button) {
  color: var(--zg-text) !important;
  font-size: 18px;
  width: 44px !important;
  height: 44px !important;
  border-radius: 12px !important;
  transition: all .3s var(--zg-spring);
}
.bell :deep(.el-button:hover) {
  background: rgba(255,255,255,0.4) !important;
  transform: translateY(-1px);
}
.msg-bell :deep(.el-button) {
  color: var(--zg-text) !important;
  font-size: 18px;
  width: 44px !important;
  height: 44px !important;
  border-radius: 12px !important;
  transition: all .3s var(--zg-spring);
}
.msg-bell :deep(.el-button:hover) {
  background: rgba(255,255,255,0.4) !important;
  transform: translateY(-1px);
}
/* 用户头像按钮：L3层玻璃 */
.me {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 5px 12px 5px 5px;
  border-radius: 20px;
  transition: all .3s var(--zg-spring);
  background: linear-gradient(155deg, var(--zg-glass-3-bg), var(--zg-glass-3-bg-2));
  -webkit-backdrop-filter: blur(12px) saturate(var(--zg-glass-sat));
  backdrop-filter: blur(12px) saturate(var(--zg-glass-sat));
  border: 1px solid var(--zg-glass-3-border);
  box-shadow: var(--zg-glass-3-shadow);
  position: relative;
  overflow: hidden;
}
.me::before {
  content: '';
  position: absolute;
  top: 0;
  left: 15%;
  right: 15%;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
  pointer-events: none;
}
.zg-inkgold-dark .me::before {
  background: linear-gradient(90deg, transparent, rgba(255,243,214,0.3), transparent);
}
.me > * { position: relative; z-index: 1; }
.me:hover {
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 8px 24px rgba(120,90,30,0.10), inset 0 1px 0 rgba(255,255,255,0.5);
}
.zg-inkgold-dark .me {
  background: linear-gradient(155deg, var(--zg-glass-3-bg), var(--zg-glass-3-bg-2));
  border: 1px solid var(--zg-glass-3-border);
  box-shadow: var(--zg-glass-3-shadow);
}
.zg-inkgold-dark .me:hover {
  box-shadow: 0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,243,214,0.10), inset 0 -1px 0 rgba(0,0,0,0.12);
}
.avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 1.5px solid rgba(255,255,255,0.5); box-shadow: 0 2px 8px -2px rgba(var(--zg-primary-rgb),0.15); }
.me-meta { line-height: 1.2; }
.me-name { font-size: var(--zg-fs-sm); font-weight: 700; }
.me-role { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); font-weight: 500; }
.menu-btn { display: none !important; font-size: 22px; color: var(--zg-text) !important; width: 44px !important; height: 44px !important; border-radius: 12px !important; }
.menu-btn:hover { background: rgba(255,255,255,0.4) !important; }

/* 字体设置面板 */
.settings-panel { padding: 4px 0; }
.sp-title { font-size: var(--zg-fs-sm); color: var(--zg-text-dim); margin-bottom: 10px; font-weight: 600; }
.sp-fonts { display: flex; gap: 8px; }
.sp-font-btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border-radius: 10px; background: rgba(var(--zg-primary-rgb),.06); cursor: pointer; transition: all .2s; border: 2px solid transparent; }
.sp-font-btn.on { border-color: var(--zg-primary); background: rgba(var(--zg-primary-rgb),.15); }
.sp-font-label { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); }
.sp-font-btn.on .sp-font-label { color: var(--zg-text); font-weight: 600; }

/* 搜索弹窗 */
.search-bar { display: flex; gap: 10px; margin-bottom: 16px; }
.search-quick { padding: 8px 0; }
.sq-label { font-size: var(--zg-fs-sm); color: var(--zg-text-dim); margin-bottom: 10px; }
.sq-tags { display: flex; gap: 8px; flex-wrap: wrap; }
.sq-tag { padding: 6px 14px; border-radius: 20px; background: rgba(var(--zg-primary-rgb),.1); cursor: pointer; font-size: var(--zg-fs-sm); transition: all .2s; }
.sq-tag:hover { background: var(--zg-primary); color: #fff; }
.search-results { max-height: 400px; overflow-y: auto; }
.sr-group { margin-bottom: 16px; }
.sr-title { font-size: var(--zg-fs-sm); font-weight: 700; color: var(--zg-text); margin-bottom: 8px; }
.sr-item { padding: 10px 12px; border-radius: 10px; cursor: pointer; transition: background .2s; }
.sr-item:hover { background: rgba(var(--zg-primary-rgb),.08); }
.sr-item-title { font-weight: 600; font-size: var(--zg-fs-sm); }
.sr-item-meta { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 2px; }

/* 抽屉 */
.drawer { padding: 16px; }
.d-brand { display:flex; align-items:center; gap:8px; font-size:22px; font-weight:800; margin-bottom:20px; }
.d-search { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.08); cursor: pointer; color: var(--zg-text-dim); font-size: var(--zg-fs-sm); margin-bottom: 16px; transition: all .2s; }
.d-search:hover { background: rgba(var(--zg-primary-rgb),.15); color: var(--zg-text); }
.d-user { display:flex; align-items:center; gap:12px; padding:14px; border-radius:14px; background:rgba(var(--zg-primary-rgb),.06); margin-bottom:16px; }
.d-user img { width:48px; height:48px; border-radius:50%; }
.du-name { font-weight:700; font-size: var(--zg-fs-md); }
.du-role { font-size: var(--zg-fs-xs); color:var(--zg-text-dim); }
.d-list { display:flex; flex-direction:column; gap:4px; }
.d-item { display:flex; align-items:center; gap:10px; padding:14px 16px; border-radius:12px; cursor:pointer; color:var(--zg-text); font-size: var(--zg-fs-base); transition:background .2s; min-height: 44px; }
.d-item :deep(.el-icon) { font-size: 18px; }
.d-item:hover { background:rgba(var(--zg-primary-rgb),.06); }
.d-subj-title { margin:20px 0 10px; font-size:var(--zg-fs-sm); color:var(--zg-text-dim); font-weight:600; }
.d-subj-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.d-subj { padding:12px; border-radius:10px; background:rgba(var(--zg-primary-rgb),.06); text-align:center; cursor:pointer; font-size: var(--zg-fs-sm); min-height: 44px; display: flex; align-items: center; justify-content: center; }
.d-subj:hover { background:rgba(var(--zg-primary-rgb),.15); }
.d-badge { margin-left:auto; background:#ef4444; color:#fff; font-size:11px; padding:1px 7px; border-radius:10px; }
.sd-title { display:flex; align-items:center; gap:8px; font-weight:700; }

/* 通知 */
.notice-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; color: var(--zg-text-dim); font-size:var(--zg-fs-sm);}
.notice-list { display:flex; flex-direction:column; gap:10px; }
.notice-item { display:flex; gap:12px; padding:12px; border-radius:12px; background:rgba(var(--zg-primary-rgb),.06); cursor:pointer; transition: all .2s; }
.notice-item:hover { background:rgba(var(--zg-primary-rgb),.1); }
.notice-item.unread { background: rgba(var(--zg-primary-rgb),.12); border:1px solid rgba(var(--zg-primary-rgb),.3); }
.n-type { font-size:var(--zg-fs-xs); padding:2px 8px; border-radius:6px; height:fit-content; background:rgba(var(--zg-primary-rgb),.15); color:var(--zg-text-dim); white-space:nowrap; }
.n-type.audit { background: rgba(var(--zg-primary-rgb),.2); color:var(--zg-accent); }
.n-type.query { background: rgba(var(--zg-primary-2-rgb),.18); color:var(--zg-primary); }
.n-type.teacher { background: rgba(239,68,68,.15); color:#dc2626; }
/* v4.2.1：评论/点赞 type 颜色 */
.n-type.comment { background: rgba(99,102,241,.15); color:#6366f1; }
.n-type.like { background: rgba(236,72,153,.15); color:#ec4899; }
.n-body { flex:1; }
.n-title { font-weight:600; font-size: var(--zg-fs-sm); }
.n-content { font-size: var(--zg-fs-xs); color:var(--zg-text-dim); margin:4px 0; }
.n-time { font-size: var(--zg-fs-xs); color:var(--zg-text-dim); }

@media (max-width: 768px) {
  /* 顶栏纳入刘海安全区 */
  .nav {
    padding-top: env(safe-area-inset-top);
    border-radius: 16px;
    margin: 8px auto 0;
    max-width: calc(100% - 16px);
  }
  .nav-inner { height: 52px; gap: 6px; padding: 0 12px; }
  .links { display: none; }
  .actions { gap: 2px; }
  .msg-bell { display: none !important; }
  .bell { display: none !important; }
  .menu-btn { display: inline-flex !important; align-items: center; justify-content: center; }
  .me-meta { display: none; }
  .me { padding: 3px; border-radius: 50%; background: transparent; border: none; box-shadow: none; overflow: visible; }
  .me::before { display: none; }
  .me:hover { background: rgba(var(--zg-primary-rgb),0.06); box-shadow: none; transform: none; }
  .logo { font-size: 24px; }
  .brand-name { font-size: 20px; letter-spacing: 0.5px; }
  .avatar { width: 36px; height: 36px; border-width: 1px; }
  .action-btn { font-size: 18px !important; width: 44px !important; height: 44px !important; }
  .menu-btn { width: 44px !important; height: 44px !important; font-size: 22px; }
  .search-dialog { width: 92% !important; }
  .search-bar { flex-direction: column; }
  .search-bar :deep(.el-button) { width: 100%; min-height: 44px; }

  /* 抽屉：纳入底部安全区，菜单项触控目标≥44px */
  :deep(.el-drawer) { width: 88% !important; }
  .drawer { padding: 18px 16px calc(100px + env(safe-area-inset-bottom)); }
  .d-search { min-height: 48px; }
  .d-item { min-height: 48px; }
  .d-subj { min-height: 44px; display: flex; align-items: center; justify-content: center; }
}

@media (min-width: 1200px) {
  .brand-name { font-size: 26px; letter-spacing: 2px; }
  .logo { font-size: 30px; }
  .nav-link { padding: 10px 18px; font-size: 15px; }
  .avatar { width: 38px; height: 38px; }
  .me-name { font-size: 14px; }
  .me-role { font-size: 12px; }
}
</style>
