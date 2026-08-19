<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

interface QuickLink {
  icon: string
  label: string
  path: string
  color: string
}

interface SiteConfig {
  siteName: string
  siteSlogan: string
  heroSubtitle: string
  showQuickLinks: boolean
  quickLinks: QuickLink[]
  footerText: string
  showAnnouncementBar: boolean
  announcementBar: string
  // 导航栏自定义
  navTitle: string
  navTitleIcon: string
  showNavSearch: boolean
  showNavMessage: boolean
  showNavNotice: boolean
  // 首页布局
  showHeroStats: boolean
  showSubjects: boolean
  showLatestArticles: boolean
  maxArticlesOnHome: number
  // 颜色主题
  primaryColor: string
}

const loading = ref(true)
const saving = ref(false)

// 默认配置：与首页 HomeView 的快捷入口保持一致
function defaultConfig(): SiteConfig {
  return {
    siteName: '追光学科共享平台',
    siteSlogan: '追光的人，终会身披万丈光芒',
    heroSubtitle: '在这里分享知识，收获成长。',
    showQuickLinks: true,
    quickLinks: [
      { icon: '📚', label: '学科广场', path: '/subjects', color: '' },
      { icon: '🏆', label: '经验排行', path: '/leaderboard', color: '' },
      { icon: '👤', label: '个人中心', path: '/profile', color: '' },
      { icon: '⭐', label: '我的收藏', path: '/favorites', color: '' },
    ],
    footerText: '© 追光学科共享平台 · 用知识点亮未来',
    showAnnouncementBar: false,
    announcementBar: '欢迎来到追光学科共享平台！',
    // 导航栏自定义
    navTitle: '追光学科共享平台',
    navTitleIcon: '🌟',
    showNavSearch: true,
    showNavMessage: true,
    showNavNotice: true,
    // 首页布局
    showHeroStats: true,
    showSubjects: true,
    showLatestArticles: true,
    maxArticlesOnHome: 6,
    // 颜色主题
    primaryColor: '#F59E0B',
  }
}

const form = reactive<SiteConfig>(defaultConfig())

// 合并后端返回的配置，缺失字段补默认值
function mergeConfig(remote: any) {
  const d = defaultConfig()
  if (!remote || typeof remote !== 'object') return
  form.siteName = remote.siteName ?? d.siteName
  form.siteSlogan = remote.siteSlogan ?? d.siteSlogan
  form.heroSubtitle = remote.heroSubtitle ?? d.heroSubtitle
  form.showQuickLinks = remote.showQuickLinks ?? d.showQuickLinks
  form.quickLinks = Array.isArray(remote.quickLinks) && remote.quickLinks.length
    ? remote.quickLinks.map((q: any) => ({
        icon: q.icon ?? '⭐',
        label: q.label ?? '',
        path: q.path ?? '/',
        color: q.color ?? '',
      }))
    : d.quickLinks
  form.footerText = remote.footerText ?? d.footerText
  form.showAnnouncementBar = remote.showAnnouncementBar ?? d.showAnnouncementBar
  form.announcementBar = remote.announcementBar ?? d.announcementBar
  // 导航栏自定义
  form.navTitle = remote.navTitle ?? d.navTitle
  form.navTitleIcon = remote.navTitleIcon ?? d.navTitleIcon
  form.showNavSearch = remote.showNavSearch ?? d.showNavSearch
  form.showNavMessage = remote.showNavMessage ?? d.showNavMessage
  form.showNavNotice = remote.showNavNotice ?? d.showNavNotice
  // 首页布局
  form.showHeroStats = remote.showHeroStats ?? d.showHeroStats
  form.showSubjects = remote.showSubjects ?? d.showSubjects
  form.showLatestArticles = remote.showLatestArticles ?? d.showLatestArticles
  form.maxArticlesOnHome = remote.maxArticlesOnHome ?? d.maxArticlesOnHome
  // 颜色主题
  form.primaryColor = remote.primaryColor ?? d.primaryColor
}

onMounted(async () => {
  try {
    const cfg: any = await api.getSiteConfig()
    mergeConfig(cfg)
  } catch (e: any) {
    ElMessage.error('加载网站配置失败：' + (e?.message || '请稍后重试'))
  } finally {
    loading.value = false
  }
})

async function save() {
  saving.value = true
  try {
    await api.saveSiteConfig({ ...form, quickLinks: form.quickLinks.map(q => ({ ...q })) })
    ElMessage.success('网站配置已保存，立即生效')
  } catch (e: any) {
    ElMessage.error('保存失败：' + (e?.message || '请稍后重试'))
  } finally {
    saving.value = false
  }
}

// ===== 快捷入口动态编辑 =====
const PRESET_COLORS = ['#F59E0B', '#FB923C', '#FBBF24', '#FDE68A', '#F97316', '#EF4444', '#34D399', '#60A5FA']
const PRESET_EMOJIS = ['📚', '🏆', '👤', '⭐', '📝', '📢', '🔍', '✍️', '📦', '🎓', '💡', '🔥']
const THEME_COLORS = ['#F59E0B', '#FB923C', '#F97316', '#EF4444', '#8B5CF6', '#3B82F6', '#10B981', '#EC4899']

function addLink() {
  form.quickLinks.push({ icon: '⭐', label: '', path: '/', color: '' })
}

function removeLink(index: number) {
  form.quickLinks.splice(index, 1)
}

function moveLink(index: number, dir: -1 | 1) {
  const target = index + dir
  if (target < 0 || target >= form.quickLinks.length) return
  const list = form.quickLinks
  ;[list[index], list[target]] = [list[target], list[index]]
}

function resetConfig() {
  Object.assign(form, defaultConfig())
  ElMessage.info('已恢复为默认配置（未保存）')
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title"><ZgGlyph emoji="🏠" /> 网站自定义</h1>
        <p class="dh-sub">自定义首页标题、标语、快捷入口与公告栏，保存后全站立即生效。</p>
      </div>
      <div class="head-actions">
        <el-button @click="resetConfig">恢复默认</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
      </div>
    </div>

    <el-form label-position="top" class="config-form">
      <div class="glass-strong config-page">
        <div class="tip"><ZgGlyph emoji="💡" /> 修改后点击「保存配置」即可全站生效。快捷入口可拖动排序、自由增删。</div>

        <!-- 基础信息 -->
        <div class="sec">
          <div class="sec-title"><span class="sec-bar"></span>基础信息</div>
          <div class="sec-body">
            <el-form-item label="网站名称">
              <el-input v-model="form.siteName" placeholder="如：追光学科共享平台" maxlength="40" show-word-limit />
            </el-form-item>
            <el-form-item label="网站标语">
              <el-input v-model="form.siteSlogan" placeholder="如：追光的人，终会身披万丈光芒" maxlength="60" show-word-limit />
            </el-form-item>
            <el-form-item label="首页副标题">
              <el-input v-model="form.heroSubtitle" placeholder="首页 Hero 区域的副标题文字" maxlength="80" show-word-limit />
            </el-form-item>
            <el-form-item label="页脚文字">
              <el-input
                v-model="form.footerText"
                type="textarea"
                :rows="5"
                placeholder="网站底部页脚文字，支持 Markdown 格式。"
                maxlength="500"
                show-word-limit
                resize="vertical"
              />
              <div class="item-tip">支持 Markdown 语法：段落换行、**加粗**、*斜体*、[链接](url) 等</div>
            </el-form-item>
          </div>
        </div>

        <!-- 快捷入口 -->
        <div class="sec">
          <div class="sec-title">
            <span class="sec-bar"></span>快捷入口
            <el-switch class="sec-switch" v-model="form.showQuickLinks" />
            <span class="sec-switch-label">{{ form.showQuickLinks ? '已显示' : '已隐藏' }}</span>
          </div>
          <div class="sec-body" v-show="form.showQuickLinks">
            <div class="ql-tip">每个快捷入口包含图标、名称、跳转路径与主题色。</div>

            <div v-if="!form.quickLinks.length" class="ql-empty">
              暂无快捷入口，点击下方按钮添加。
            </div>

            <div v-for="(link, idx) in form.quickLinks" :key="idx" class="ql-item">
              <div class="ql-index">{{ idx + 1 }}</div>

              <div class="ql-preview" :style="{ background: `linear-gradient(135deg, ${link.color}, ${link.color}cc)` }">
                <ZgGlyph :emoji="link.icon || '⭐'" />
              </div>

              <div class="ql-fields">
                <div class="ql-row">
                  <el-input v-model="link.icon" class="ql-emoji" placeholder="图标 emoji" maxlength="4">
                    <template #prepend>图标</template>
                  </el-input>
                  <el-input v-model="link.label" placeholder="入口名称" maxlength="12">
                    <template #prepend>名称</template>
                  </el-input>
                  <el-input v-model="link.path" placeholder="/subjects" maxlength="60">
                    <template #prepend>路径</template>
                  </el-input>
                </div>
                <div class="ql-row ql-color-row">
                  <span class="ql-color-label">主题色</span>
                  <el-color-picker v-model="link.color" />
                  <span class="ql-color-val">{{ link.color }}</span>
                  <div class="ql-swatches">
                    <span
                      v-for="c in PRESET_COLORS"
                      :key="c"
                      class="ql-sw"
                      :class="{ on: link.color.toLowerCase() === c.toLowerCase() }"
                      :style="{ background: c }"
                      @click="link.color = c"
                    ></span>
                  </div>
                </div>
                <div class="ql-emoji-quick">
                  <span class="ql-eq-label">快捷图标：</span>
                  <span
                    v-for="e in PRESET_EMOJIS"
                    :key="e"
                    class="ql-eq-item"
                    :class="{ on: link.icon === e }"
                    @click="link.icon = e"
                  >{{ e }}</span>
                </div>
              </div>

              <div class="ql-ops">
                <el-button circle size="small" :disabled="idx === 0" @click="moveLink(idx, -1)" title="上移"><ZgGlyph emoji="↑" /></el-button>
                <el-button circle size="small" :disabled="idx === form.quickLinks.length - 1" @click="moveLink(idx, 1)" title="下移"><ZgGlyph emoji="↓" /></el-button>
                <el-button type="danger" circle size="small" @click="removeLink(idx)" title="删除"><ZgGlyph emoji="✕" /></el-button>
              </div>
            </div>

            <el-button class="ql-add" plain @click="addLink">＋ 添加快捷入口</el-button>
          </div>
        </div>

        <!-- 公告栏 -->
        <div class="sec">
          <div class="sec-title">
            <span class="sec-bar"></span>公告栏
            <el-switch class="sec-switch" v-model="form.showAnnouncementBar" />
            <span class="sec-switch-label">{{ form.showAnnouncementBar ? '已显示' : '已隐藏' }}</span>
          </div>
          <div class="sec-body" v-show="form.showAnnouncementBar">
            <el-form-item label="公告栏内容">
              <el-input
                v-model="form.announcementBar"
                type="textarea"
                :rows="5"
                placeholder="首页顶部公告栏显示的文字，支持 Markdown 格式（如 **加粗**、*斜体*、[链接](url) 等）。"
                maxlength="500"
                show-word-limit
                resize="vertical"
              />
              <div class="item-tip">支持 Markdown 语法：段落换行、**加粗**、*斜体*、[链接](url)、- 列表等</div>
            </el-form-item>
          </div>
        </div>

        <!-- 导航栏自定义 -->
        <div class="sec">
          <div class="sec-title"><span class="sec-bar"></span>导航栏自定义</div>
          <div class="sec-body">
            <el-form-item label="导航栏标题文字">
              <el-input v-model="form.navTitle" placeholder="留空则默认使用网站名称" maxlength="20" show-word-limit />
              <div class="item-tip">显示在顶部导航栏左侧的名称，留空或与网站名称一致即可。</div>
            </el-form-item>
            <el-form-item label="导航栏图标 emoji">
              <el-input v-model="form.navTitleIcon" class="nav-icon-input" placeholder="导航栏图标" maxlength="4" />
              <span class="nav-icon-preview">当前预览：<ZgGlyph :emoji="form.navTitleIcon || '⭐'" /></span>
            </el-form-item>
            <el-form-item label="显示搜索按钮">
              <el-switch v-model="form.showNavSearch" />
              <span class="switch-text">{{ form.showNavSearch ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
            <el-form-item label="显示站内信按钮">
              <el-switch v-model="form.showNavMessage" />
              <span class="switch-text">{{ form.showNavMessage ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
            <el-form-item label="显示通知铃铛">
              <el-switch v-model="form.showNavNotice" />
              <span class="switch-text">{{ form.showNavNotice ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
          </div>
        </div>

        <!-- 首页布局 -->
        <div class="sec">
          <div class="sec-title"><span class="sec-bar"></span>首页布局</div>
          <div class="sec-body">
            <el-form-item label="显示首页统计数据">
              <el-switch v-model="form.showHeroStats" />
              <span class="switch-text">{{ form.showHeroStats ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
            <el-form-item label="显示学科子站入口">
              <el-switch v-model="form.showSubjects" />
              <span class="switch-text">{{ form.showSubjects ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
            <el-form-item label="显示最新美文">
              <el-switch v-model="form.showLatestArticles" />
              <span class="switch-text">{{ form.showLatestArticles ? '已显示' : '已隐藏' }}</span>
            </el-form-item>
            <el-form-item label="首页美文展示数量">
              <el-input-number v-model="form.maxArticlesOnHome" :min="3" :max="12" :step="1" />
              <div class="item-tip">首页「最新美文」板块展示的文章数量，范围 3-12 篇。</div>
            </el-form-item>
          </div>
        </div>

        <!-- 颜色主题 -->
        <div class="sec">
          <div class="sec-title"><span class="sec-bar"></span>颜色主题</div>
          <div class="sec-body">
            <el-form-item label="主题色">
              <el-color-picker v-model="form.primaryColor" />
              <span class="color-val">{{ form.primaryColor }}</span>
              <div class="color-presets">
                <span
                  v-for="c in THEME_COLORS"
                  :key="c"
                  class="color-sw"
                  :class="{ on: form.primaryColor.toLowerCase() === c.toLowerCase() }"
                  :style="{ background: c }"
                  @click="form.primaryColor = c"
                ></span>
              </div>
              <div class="item-tip">全站主色调，影响按钮、强调色与渐变背景。建议使用偏暖的橙黄色系以保持品牌一致。</div>
            </el-form-item>
          </div>
        </div>

        <div class="foot">
          <el-button @click="resetConfig">恢复默认</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
        </div>
      </div>
    </el-form>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.dh-sub { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.head-actions { display: flex; gap: 10px; }

.config-page { padding: 24px; }
.tip { background: rgba(var(--zg-primary-rgb),.08); padding: 10px 14px; border-radius: 10px; font-size: 13px; color: var(--zg-text-dim); margin-bottom: 22px; }

.sec { margin-bottom: 24px; }
.sec:last-of-type { margin-bottom: 0; }
.sec-title { display: flex; align-items: center; gap: 10px; font-size: 16px; font-weight: 700; margin-bottom: 16px; }
.sec-bar { width: 4px; height: 18px; border-radius: 4px; background: linear-gradient(var(--zg-accent), var(--zg-primary)); }
.sec-switch { margin-left: auto; }
.sec-switch-label { font-size: 12px; color: var(--zg-text-dim); font-weight: 500; }
.sec-body { display: flex; flex-direction: column; gap: 4px; }

/* 快捷入口编辑器 */
.ql-tip { font-size: 12px; color: var(--zg-text-dim); margin-bottom: 12px; }
.ql-empty { padding: 24px; text-align: center; color: var(--zg-text-dim); font-size: 13px; background: rgba(var(--zg-primary-rgb),.04); border-radius: 12px; border: 1px dashed rgba(var(--zg-primary-rgb),.2); }
.ql-item { display: flex; align-items: flex-start; gap: 14px; padding: 16px; background: rgba(var(--zg-primary-rgb),.04); border-radius: 12px; margin-bottom: 10px; border: 1px solid transparent; transition: border-color .2s; }
.ql-item:hover { border-color: rgba(var(--zg-primary-rgb),.2); }
.ql-index { width: 24px; height: 24px; border-radius: 50%; background: var(--zg-primary); color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 4px; }
.ql-preview { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; box-shadow: 0 4px 14px rgba(var(--zg-primary-rgb),.2); color: #fff; }
.ql-fields { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ql-row { display: flex; gap: 10px; flex-wrap: wrap; }
.ql-row .el-input { flex: 1; min-width: 120px; }
.ql-emoji { max-width: 110px; flex: 0 0 110px !important; }
.ql-color-row { align-items: center; }
.ql-color-label { font-size: 12px; color: var(--zg-text-dim); white-space: nowrap; }
.ql-color-val { font-size: 12px; color: var(--zg-text-dim); font-family: monospace; }
.ql-swatches { display: flex; gap: 6px; flex-wrap: wrap; }
.ql-sw { width: 20px; height: 20px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(var(--zg-primary-rgb),.3); transition: transform .15s; }
.ql-sw:hover { transform: scale(1.15); }
.ql-sw.on { box-shadow: 0 0 0 2px var(--zg-primary); }
.ql-emoji-quick { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ql-eq-label { font-size: 12px; color: var(--zg-text-dim); }
.ql-eq-item { font-size: 18px; cursor: pointer; padding: 2px 4px; border-radius: 6px; transition: all .15s; }
.ql-eq-item:hover { background: rgba(var(--zg-primary-rgb),.12); transform: scale(1.15); }
.ql-eq-item.on { background: rgba(var(--zg-primary-rgb),.2); box-shadow: 0 0 0 1px var(--zg-primary); }
.ql-ops { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
.ql-add { width: 100%; margin-top: 4px; border-style: dashed !important; }

/* 新增区块通用样式 */
.item-tip { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; line-height: 1.5; }
.switch-text { font-size: 12px; color: var(--zg-text-dim); margin-left: 10px; }
.nav-icon-input { max-width: 120px; }
.nav-icon-preview { margin-left: 12px; font-size: 14px; color: var(--zg-text-dim); }
.color-val { margin-left: 12px; font-size: 12px; color: var(--zg-text-dim); font-family: monospace; }
.color-presets { display: inline-flex; gap: 6px; flex-wrap: wrap; margin-left: 12px; vertical-align: middle; }
.color-sw { width: 20px; height: 20px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(var(--zg-primary-rgb),.3); transition: transform .15s; display: inline-block; }
.color-sw:hover { transform: scale(1.15); }
.color-sw.on { box-shadow: 0 0 0 2px var(--zg-primary); }

.foot { margin-top: 28px; padding-top: 20px; border-top: 1px dashed rgba(var(--zg-primary-rgb),.15); display: flex; justify-content: flex-end; gap: 10px; }

@media (max-width: 768px) {
  .config-page { padding: 16px; }
  .dh-title { font-size: 20px; }
  .tip { font-size: 12px; padding: 8px 12px; margin-bottom: 16px; }
  .sec { margin-bottom: 20px; }
  .sec-title { font-size: 15px; margin-bottom: 12px; }
  .ql-item { flex-wrap: wrap; padding: 12px; gap: 10px; }
  .ql-preview { width: 42px; height: 42px; border-radius: 12px; font-size: 20px; }
  .ql-ops { flex-direction: row; margin-left: auto; }
  .ql-row { flex-direction: column; gap: 8px; }
  .ql-row .el-input { min-width: 0; }
  .ql-emoji { max-width: none; flex: 1 1 100% !important; }
  .color-presets { margin-left: 0; margin-top: 8px; }
  .foot { flex-direction: column-reverse; gap: 8px; }
  .foot .el-button { width: 100%; }
}
</style>
