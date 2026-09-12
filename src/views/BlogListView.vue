<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { mdExcerpt } from '@/utils/markdown'
import { fileUrl } from '@/utils/helpers'
import ZgGlyph from '@/components/ZgGlyph.vue'

const router = useRouter()
const user = useUserStore()
const list = ref<any[]>([])
const topics = ref<any[]>([])
const loading = ref(false)
const myOnly = ref(false)
const activeTopicId = ref<number | null>(null)
const defaultAvatar = 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'

// ===== v4.4.19 视图切换（卡片 / 横条，偏好存 localStorage，默认卡片）=====
type ViewMode = 'card' | 'list'
const VIEW_KEY = 'zg:blog:view'
const viewMode = ref<ViewMode>((localStorage.getItem(VIEW_KEY) as ViewMode) || 'card')
function setView(m: ViewMode) {
  viewMode.value = m
  try { localStorage.setItem(VIEW_KEY, m) } catch { /* 忽略 */ }
}

// ===== v4.4.19 超管话题管理（复用论坛模式；修复：此前博客模块无管理 UI）=====
const topicDlgVisible = ref(false)
const editingTopic = ref<any>(null)
const topicForm = ref({ name: '', color: '#F59E0B' })
function openTopicDlg(t: any = null) {
  editingTopic.value = t
  topicForm.value = t ? { name: t.name, color: t.color } : { name: '', color: '#F59E0B' }
  topicDlgVisible.value = true
}
async function saveTopic() {
  if (!topicForm.value.name.trim()) { ElMessage.warning('请填写话题名称'); return }
  try {
    if (editingTopic.value) {
      await api.updateBlogTopic(editingTopic.value.id, { name: topicForm.value.name, color: topicForm.value.color })
      ElMessage.success('已更新话题')
    } else {
      await api.createBlogTopic({ name: topicForm.value.name, color: topicForm.value.color })
      ElMessage.success('已创建话题')
    }
    topicDlgVisible.value = false
    await loadTopics()
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '操作失败') }
}
async function delTopic(t: any) {
  try {
    await ElMessageBox.confirm(`确认删除话题「${t.name}」？相关博客会保留，但失去该话题标签。`, '删除话题', { type: 'warning' })
  } catch { return }
  try {
    await api.deleteBlogTopic(t.id)
    ElMessage.success('已删除话题')
    if (activeTopicId.value === t.id) activeTopicId.value = null
    await loadTopics()
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '操作失败') }
}
async function loadTopics() {
  try { topics.value = (await api.blogTopics()) as any } catch { /* 忽略 */ }
}

async function load() {
  loading.value = true
  try {
    const [posts, tps] = await Promise.all([
      api.blogPosts({ ...(myOnly.value ? { mine: '1', userId: user.current?.id } : {}) }),
      api.blogTopics(),
    ])
    list.value = posts as any
    topics.value = tps as any
  } finally { loading.value = false }
}
onMounted(load)

const topicNameMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.name])))
const topicColorMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.color])))

const filteredPosts = computed(() =>
  activeTopicId.value
    ? list.value.filter(p => (p.topic_ids || []).includes(activeTopicId.value!))
    : list.value
)
const countByTopic = computed(() => {
  const m: Record<number, number> = {}
  for (const p of list.value) for (const tid of (p.topic_ids || [])) m[tid] = (m[tid] || 0) + 1
  return m
})
// 【v4.4.16】热门博客：浏览 0.4 + 评论 0.6 加权（同论坛热帖）
const hotPosts = computed(() =>
  [...list.value]
    .map(p => ({
      ...p,
      _heat: (Number(p.views || 0)) * 0.4 + (Number(p.comment_count || 0)) * 0.6,
    }))
    .sort((a, b) => {
      if (b._heat !== a._heat) return b._heat - a._heat
      return (b.created_at || '').localeCompare(a.created_at || '')
    })
    .slice(0, 5)
)

function filterByTopic(id: number | null) { activeTopicId.value = id }
function excerpt(md: string) { return mdExcerpt(md, 100) }

function canEditOrDel(p: any) {
  if (!user.current) return false
  return p.author_id === user.current.id || user.isSuperAdmin
}
async function delPost(p: any) {
  try {
    await ElMessageBox.confirm('确认删除该博客？', '删除', { type: 'warning' })
  } catch { return }
  await api.deletePage(p.id)
  ElMessage.success('已删除')
  await load()
}
</script>

<template>
  <div class="bl-page">
    <div class="bl-header glass">
      <div class="bl-title">
        <ZgGlyph emoji="✍️" />
        <h2>网站博客</h2>
      </div>
      <p class="bl-sub">学习心得、经验分享、好文推荐。支持话题标签、评论互动与热门排行。</p>
    </div>

    <div class="bl-layout">
      <!-- 主区 -->
      <div class="bl-main">
        <!-- 话题筛选 chips -->
        <div class="bl-topics glass">
          <div class="bl-topics-left">
            <div class="bl-chip" :class="{ on: !activeTopicId }" @click="filterByTopic(null)">
              <ZgGlyph emoji="📚" /> 全部 <span class="bl-chip-n">{{ list.length }}</span>
            </div>
            <div
              v-for="t in topics"
              :key="t.id"
              class="bl-chip"
              :class="{ on: activeTopicId === t.id }"
              :style="{ '--chip': t.color }"
              @click="filterByTopic(t.id)"
            >
              <span class="dot" :style="{ background: t.color }"></span>
              {{ t.name }} <span class="bl-chip-n">{{ countByTopic[t.id] || 0 }}</span>
            </div>
          </div>
          <div class="bl-topics-right">
            <el-radio-group v-model="myOnly" size="small" @change="load">
              <el-radio-button :value="false">全部</el-radio-button>
              <el-radio-button :value="true">我的</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <div class="bl-actions">
          <div class="bl-stat">共 {{ filteredPosts.length }} 篇博客</div>
          <div class="bl-act-right">
            <!-- 视图切换 -->
            <div class="bl-view-switch" role="group" aria-label="视图切换">
              <button class="vs-btn" :class="{ on: viewMode === 'card' }" @click="setView('card')" title="卡片视图">▦</button>
              <button class="vs-btn" :class="{ on: viewMode === 'list' }" @click="setView('list')" title="横条视图">☰</button>
            </div>
            <el-button v-if="user.isSuperAdmin" size="small" @click="openTopicDlg(null)">
              <ZgGlyph emoji="🏷️" /> 管理话题
            </el-button>
            <el-button type="primary" round @click="router.push('/blog/new')">
              <ZgGlyph emoji="✍️" /> 写博客
            </el-button>
          </div>
        </div>

        <div v-loading="loading" class="bl-grid" :class="viewMode">
          <div v-if="!filteredPosts.length" class="bl-empty">
            <el-empty :description="activeTopicId ? '此话题下还没有博客' : '还没有博客，来写第一篇吧！'">
              <el-button type="primary" @click="router.push('/blog/new')">写第一篇</el-button>
            </el-empty>
          </div>
          <article
            v-for="b in filteredPosts"
            :key="b.id"
            class="bl-card glass"
            :class="{ list: viewMode === 'list' }"
            @click="router.push(`/blog/${b.id}`)"
          >
            <div class="bl-cover-wrap">
              <div v-if="b.cover" class="bl-cover">
                <img :src="fileUrl(b.cover)" :alt="b.title" loading="lazy" />
              </div>
              <div v-else class="bl-cover bl-placeholder">
                <ZgGlyph class="ph-emoji" emoji="✍️" />
              </div>
            </div>
            <div class="bl-body">
              <div class="bl-card-head">
                <div class="bl-card-author">
                  <img class="avatar" :src="b.author_avatar || defaultAvatar" :alt="b.author_name" />
                  <div>
                    <div class="bl-card-name">{{ b.author_name }}</div>
                    <div class="bl-card-meta">
                      {{ (b.created_at || '').slice(0, 16) }} ·
                      <ZgGlyph emoji="👁" /> {{ b.views || 0 }} ·
                      <ZgGlyph emoji="💬" /> {{ b.comment_count || 0 }}
                    </div>
                  </div>
                </div>
                <el-button
                  v-if="canEditOrDel(b)"
                  size="small" text type="danger"
                  @click.stop="delPost(b)"
                ><ZgGlyph emoji="🗑" /> 删除</el-button>
              </div>

              <h3 class="bl-card-title">
                <span v-if="b.pinned" class="bl-pin"><ZgGlyph emoji="📌" /> 置顶</span>
                {{ b.title }}
              </h3>
              <p class="bl-card-excerpt">{{ excerpt(b.content) }}</p>

              <div v-if="b.topic_ids?.length" class="bl-card-tags">
                <span
                  v-for="tid in b.topic_ids"
                  :key="tid"
                  class="bl-card-tag"
                  :style="{ background: topicColorMap[tid] || '#94A3B8' }"
                >{{ topicNameMap[tid] || '#'+tid }}</span>
              </div>
            </div>
          </article>
        </div>
      </div>

      <!-- 侧栏 -->
      <aside class="bl-side">
        <div class="bl-side-card glass">
          <h3 class="bl-side-title"><ZgGlyph emoji="🔥" /> 热门博客</h3>
          <div v-if="!hotPosts.length" class="bl-side-empty">还没有博客</div>
          <div v-else class="bl-side-hot">
            <div
              v-for="(p, i) in hotPosts"
              :key="p.id"
              class="bl-side-hot-item"
              @click="router.push(`/blog/${p.id}`)"
            >
              <div class="t">
                <span v-if="i < 3" class="hot-rank" :class="`rk${i+1}`">{{ i + 1 }}</span>
                {{ p.title }}
              </div>
              <div class="m">
                <ZgGlyph emoji="👤" /> {{ p.author_name }} ·
                <ZgGlyph emoji="💬" /> {{ p.comment_count || 0 }}
              </div>
            </div>
          </div>
        </div>

        <div class="bl-side-card glass">
          <h3 class="bl-side-title">
            <ZgGlyph emoji="🏷️" /> 博客话题
            <el-button v-if="user.isSuperAdmin" size="small" text type="primary" class="bl-side-manage" @click="openTopicDlg(null)">管理</el-button>
          </h3>
          <div v-if="!topics.length" class="bl-side-empty">暂无话题</div>
          <div v-else class="bl-side-topics">
            <div
              v-for="t in topics"
              :key="t.id"
              class="bl-side-topic"
              :class="{ on: activeTopicId === t.id }"
              @click="filterByTopic(t.id)"
            >
              <span class="dot" :style="{ background: t.color }"></span>
              <span class="name">{{ t.name }}</span>
              <span class="count">{{ countByTopic[t.id] || 0 }}</span>
              <span v-if="user.isSuperAdmin" class="tm-ops" @click.stop>
                <span class="tm-edit" title="编辑" @click="openTopicDlg(t)"><ZgGlyph emoji="✏️" /></span>
                <span class="tm-del" title="删除" @click="delTopic(t)"><ZgGlyph emoji="🗑" /></span>
              </span>
            </div>
          </div>
        </div>

        <div class="bl-side-card glass">
          <h3 class="bl-side-title"><ZgGlyph emoji="📊" /> 博客统计</h3>
          <div class="bl-side-stat-row"><div class="lab">博客总数</div><div class="val">{{ list.length }}</div></div>
          <div class="bl-side-stat-row"><div class="lab">话题数</div><div class="val">{{ topics.length }}</div></div>
        </div>
      </aside>
    </div>

    <!-- 超管：新建 / 编辑话题 -->
    <el-dialog v-model="topicDlgVisible" :title="editingTopic ? '编辑话题' : '新建话题'" width="420px">
      <el-form :model="topicForm" label-width="60px">
        <el-form-item label="名称">
          <el-input v-model="topicForm.name" maxlength="20" placeholder="如：考点速记、经验分享" />
        </el-form-item>
        <el-form-item label="颜色">
          <el-color-picker v-model="topicForm.color" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="topicDlgVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!topicForm.name.trim()" @click="saveTopic">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.bl-page { max-width: 1280px; margin: 16px auto 64px; padding: 0 20px; }
.bl-header { padding: 22px 28px; border-radius: 20px; }
.bl-title { display: flex; align-items: center; gap: 10px; }
.bl-title h2 { font-size: 22px; font-weight: 800; margin: 0; }
.bl-sub { font-size: 13px; color: var(--zg-text-sub); margin: 6px 0 0; line-height: 1.6; }

.bl-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; margin-top: 16px; }
.bl-main { min-width: 0; }

.bl-topics { padding: 12px 16px; border-radius: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.bl-topics-left { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.bl-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; background: rgba(148, 163, 184, 0.15); border-radius: 999px; font-size: 13px; cursor: pointer; transition: all 0.18s; user-select: none; }
.bl-chip:hover { transform: translateY(-1px); }
.bl-chip.on { background: var(--chip, #F59E0B); color: #fff; font-weight: 700; }
.bl-chip.on .dot { background: rgba(255,255,255,0.7) !important; }
.bl-chip.on .bl-chip-n { color: #fff; }
.bl-chip-n { font-size: 11px; color: var(--zg-text-sub); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

.bl-actions { display: flex; justify-content: space-between; align-items: center; margin: 16px 4px 10px; gap: 12px; flex-wrap: wrap; }
.bl-stat { font-size: 13px; color: var(--zg-text-sub); }
.bl-act-right { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.bl-view-switch { display: inline-flex; background: rgba(148, 163, 184, 0.16); border-radius: 10px; padding: 3px; }
.vs-btn { border: none; background: transparent; cursor: pointer; width: 32px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; color: var(--zg-text-sub); font-size: 15px; line-height: 1; transition: all .2s; }
.vs-btn:hover { color: var(--zg-primary); }
.vs-btn.on { background: var(--zg-primary); color: #fff; box-shadow: 0 2px 8px rgba(245, 158, 11, 0.35); }

.bl-grid { display: grid; gap: 12px; }
.bl-grid.card { grid-template-columns: 1fr; }
@media (min-width: 1100px) { .bl-grid.card { grid-template-columns: repeat(2, 1fr); } }
.bl-grid.list { grid-template-columns: 1fr; }
.bl-empty { grid-column: 1 / -1; padding: 60px 0; }

/* ===== 卡片（光感 + 高斯模糊光晕）===== */
.bl-card { padding: 0; border-radius: 16px; cursor: pointer; display: flex; flex-direction: column; overflow: hidden; position: relative; transition: transform .25s var(--zg-ease), box-shadow .25s var(--zg-ease); }
.bl-card::before { /* 玻璃顶部高光，营造光感 */
  content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 2;
  background: linear-gradient(160deg, rgba(255,255,255,.22), rgba(255,255,255,0) 38%);
}
.bl-card:hover { transform: translateY(-3px); box-shadow: 0 14px 34px rgba(15,23,42,.14), 0 0 0 1px rgba(var(--zg-primary-rgb),.22), 0 18px 52px rgba(var(--zg-accent-rgb),.20); }
.bl-card:hover::before { background: linear-gradient(160deg, rgba(255,255,255,.32), rgba(255,255,255,0) 42%); }

.bl-cover-wrap { min-width: 0; }
.bl-cover { position: relative; height: 168px; border-radius: 12px; overflow: hidden; margin: 14px 16px 0; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.18), rgba(var(--zg-primary-2-rgb),.12)); }
.bl-cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .55s var(--zg-ease); }
.bl-card:hover .bl-cover img { transform: scale(1.06); }
/* 无图占位：回到「博客大改之前」的简洁美观（渐变光感 + 半透明清晰图标）*/
.bl-placeholder { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.26), rgba(var(--zg-primary-2-rgb),.2)); }
.bl-placeholder .ph-emoji { font-size: 52px; opacity: .42; }

.bl-body { display: flex; flex-direction: column; min-width: 0; position: relative; z-index: 3; }
.bl-card-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 14px 16px 0; gap: 8px; }
.bl-card-author { display: flex; gap: 10px; align-items: center; }
.avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: #f0f0f0; }
.bl-card-name { font-weight: 700; font-size: 14px; }
.bl-card-meta { font-size: 12px; color: var(--zg-text-sub); margin-top: 2px; }
.bl-card-title { font-size: 17px; font-weight: 700; margin: 12px 16px 6px; line-height: 1.4; }
.bl-pin { color: var(--zg-primary); font-size: 12px; margin-right: 4px; }
.bl-card-excerpt { font-size: 13px; color: var(--zg-text-sub); line-height: 1.6; margin: 0 16px 12px; }
.bl-card-tags { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 16px 16px; }
.bl-card-tag { padding: 2px 8px; color: #fff; font-size: 11px; border-radius: 6px; font-weight: 600; }

/* ===== 横条视图：封面左、内容右 ===== */
.bl-card.list { flex-direction: row; align-items: stretch; }
.bl-card.list .bl-cover-wrap { flex: 0 0 240px; display: flex; padding: 12px; }
.bl-card.list .bl-cover { margin: 0; height: 100%; min-height: 160px; width: 100%; }
.bl-card.list .bl-body { flex: 1; justify-content: center; padding: 14px 18px 14px 4px; }
.bl-card.list .bl-card-title { margin-top: 8px; font-size: 18px; }
.bl-card.list .bl-card-excerpt { margin-bottom: 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

/* 侧栏 */
.bl-side { display: flex; flex-direction: column; gap: 14px; }
.bl-side-card { padding: 16px 18px; border-radius: 16px; }
.bl-side-title { font-size: 14px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
.bl-side-manage { margin-left: auto; padding: 2px 6px; font-size: 12px; }
.bl-side-empty { font-size: 12px; color: var(--zg-text-sub); text-align: center; padding: 12px 0; }
.bl-side-hot { display: flex; flex-direction: column; gap: 10px; }
.bl-side-hot-item { cursor: pointer; padding: 6px 0; border-bottom: 1px dashed rgba(148, 163, 184, 0.25); }
.bl-side-hot-item:last-child { border-bottom: none; }
.bl-side-hot-item:hover .t { color: var(--zg-primary); }
.bl-side-hot-item .t { font-size: 13px; font-weight: 600; line-height: 1.5; display: flex; align-items: center; gap: 6px; }
.bl-side-hot-item .m { font-size: 11px; color: var(--zg-text-sub); margin-top: 2px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.hot-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; font-size: 11px; font-weight: 800; color: #fff; flex: none; }
.hot-rank.rk1 { background: linear-gradient(135deg, #F59E0B, #D97706); box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35); }
.hot-rank.rk2 { background: linear-gradient(135deg, #94A3B8, #64748B); box-shadow: 0 2px 6px rgba(100, 116, 139, 0.3); }
.hot-rank.rk3 { background: linear-gradient(135deg, #B45309, #92400E); box-shadow: 0 2px 6px rgba(180, 83, 9, 0.3); }
.bl-side-topics { display: flex; flex-direction: column; gap: 6px; }
.bl-side-topic { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer; transition: background .15s; }
.bl-side-topic:hover { background: rgba(var(--zg-primary-rgb), 0.06); }
.bl-side-topic.on { background: rgba(var(--zg-primary-rgb), 0.12); font-weight: 600; }
.bl-side-topic .name { flex: 1; font-size: 13px; }
.bl-side-topic .count { font-size: 11px; color: var(--zg-text-sub); background: rgba(148, 163, 184, 0.2); padding: 1px 8px; border-radius: 999px; }
.tm-ops { display: inline-flex; gap: 6px; margin-left: 4px; }
.tm-edit, .tm-del { cursor: pointer; font-size: 13px; opacity: .6; transition: opacity .15s, color .15s; }
.tm-edit:hover { opacity: 1; color: var(--zg-primary); }
.tm-del:hover { opacity: 1; color: #ef4444; }
.bl-side-stat-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
.bl-side-stat-row .lab { color: var(--zg-text-sub); }
.bl-side-stat-row .val { font-weight: 700; }

@media (max-width: 1024px) {
  .bl-layout { grid-template-columns: 1fr; }
  .bl-side { flex-direction: row; flex-wrap: wrap; }
  .bl-side-card { flex: 1 1 220px; }
}
@media (max-width: 768px) {
  .bl-card.list { flex-direction: column; }
  .bl-card.list .bl-cover-wrap { flex: none; padding: 12px 12px 0; }
  .bl-card.list .bl-cover { height: 160px; }
  .bl-card.list .bl-body { padding: 12px 14px 14px; }
}
@media (max-width: 640px) {
  .bl-page { padding: 0 12px; }
  .bl-header { padding: 16px; }
  .bl-topics { padding: 10px 12px; }
  .bl-topics-left { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .bl-topics-left::-webkit-scrollbar { display: none; }
  .bl-chip { flex: 0 0 auto; min-height: 34px; }
  .bl-grid.card { grid-template-columns: 1fr; gap: 10px; }
  .bl-card-title { font-size: 16px; }
  .bl-side { flex-direction: column; }
  .bl-side-card { padding: 14px; }
}
</style>
