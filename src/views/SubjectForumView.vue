<template>
  <div class="sf-page">
    <!-- 顶部 Header -->
    <div class="sf-header glass">
      <div class="sf-back" @click="goBack"><ZgGlyph emoji="←" /> 返回学科</div>
      <h2 class="sf-title">
        <ZgGlyph :emoji="subject?.icon || '💬'" /> {{ subject?.name || '学科' }} · 学科论坛
      </h2>
      <p class="sf-sub">话题讨论、经验分享、问题解答。本学科教师/超管可管理话题标签；所有登录用户可发帖/评论。</p>
    </div>

    <!-- 桌面两栏：主列表 + 侧边热榜 -->
    <div class="sf-layout">
      <!-- 左侧主区 -->
      <div class="sf-main">
        <!-- 话题标签 chips -->
        <div class="sf-topics glass">
          <div class="sf-topics-left">
            <div class="sf-chip" :class="{ on: !activeTopicId }" @click="filterByTopic(null)">
              <ZgGlyph emoji="📚" /> 全部 <span class="sf-chip-n">{{ posts.length }}</span>
            </div>
            <div
              v-for="t in topics"
              :key="t.id"
              class="sf-chip"
              :class="{ on: activeTopicId === t.id }"
              :style="{ '--chip': t.color }"
              @click="filterByTopic(t.id)"
            >
              <span class="dot" :style="{ background: t.color }"></span>
              {{ t.name }} <span class="sf-chip-n">{{ countByTopic[t.id] || 0 }}</span>
              <span v-if="canManage" class="sf-chip-x" @click.stop="delTopic(t)">×</span>
            </div>
          </div>
          <div v-if="canManage" class="sf-topics-right">
            <el-button size="small" @click="openTopicDlg" type="primary" plain>
              <ZgGlyph emoji="+" /> 新建话题
            </el-button>
          </div>
        </div>

        <!-- 操作条 -->
        <div class="sf-actions">
          <div class="sf-stat">共 {{ filteredPosts.length }} / {{ posts.length }} 个帖子</div>
          <el-button type="primary" size="small" @click="goNewPost">
            <ZgGlyph emoji="✍️" /> 我要发帖
          </el-button>
        </div>

        <!-- 帖子列表 -->
        <div v-loading="loading" class="sf-list">
          <div v-if="!filteredPosts.length" class="sf-empty">
            <el-empty :description="activeTopicId ? '此话题下还没有帖子' : '本学科论坛还没有帖子，来发第一个吧！'">
              <el-button type="primary" @click="goNewPost">发第一个帖</el-button>
            </el-empty>
          </div>
          <article
            v-for="p in filteredPosts"
            :key="p.id"
            class="sf-card glass"
            @click="goPost(p)"
          >
            <div class="sf-card-head">
              <div class="sf-card-author">
                <img class="avatar" :src="p.author_avatar || defaultAvatar" :alt="p.author_name" />
                <div>
                  <div class="sf-card-name">
                    {{ p.author_name }}
                    <span v-if="p.status==='pending'" class="sf-pending">待审核</span>
                    <span v-else-if="p.status==='rejected'" class="sf-rejected">已驳回</span>
                  </div>
                  <div class="sf-card-meta">
                    {{ (p.created_at || '').slice(0, 16) }} ·
                    <ZgGlyph emoji="👁" /> {{ p.views }} ·
                    <ZgGlyph emoji="💬" /> {{ p.comment_count || 0 }}
                    <span v-if="p.review_note" class="sf-note">· 审核意见：{{ p.review_note }}</span>
                  </div>
                </div>
              </div>
              <div v-if="p.topic_ids && p.topic_ids.length" class="sf-card-tags">
                <span
                  v-for="tid in p.topic_ids"
                  :key="tid"
                  class="sf-card-tag"
                  :style="{ background: topicColorMap[tid] || '#94A3B8' }"
                >{{ topicNameMap[tid] || '#'+tid }}</span>
              </div>
            </div>
            <h3 class="sf-card-title">
              <span v-if="p.pinned" class="sf-pin"><ZgGlyph emoji="📌" /> 置顶</span>
              {{ p.title }}
            </h3>
            <p class="sf-card-excerpt">{{ stripMd(p.content) }}</p>
            <div class="sf-card-actions" @click.stop>
              <el-button v-if="canEditOrDel(p)" size="small" text @click="goEditPost(p)">
                <ZgGlyph emoji="✏️" /> 编辑
              </el-button>
              <el-button v-if="canEditOrDel(p)" size="small" text type="danger" @click="delPost(p)">
                <ZgGlyph emoji="🗑" /> 删除
              </el-button>
            </div>
          </article>
        </div>
      </div>

      <!-- 右侧：热榜 + 学科信息 -->
      <aside class="sf-side">
        <div class="sf-side-card glass">
          <h3 class="sf-side-title"><ZgGlyph emoji="🔥" /> 热门话题</h3>
          <div v-if="!topics.length" class="sf-side-empty">还没有话题</div>
          <div v-else class="sf-side-topics">
            <div
              v-for="t in topicsWithCount"
              :key="t.id"
              class="sf-side-topic"
              :class="{ on: activeTopicId === t.id }"
              @click="filterByTopic(t.id)"
            >
              <span class="dot" :style="{ background: t.color }"></span>
              <span class="name">{{ t.name }}</span>
              <span class="count">{{ t.count }}</span>
            </div>
          </div>
        </div>

        <div class="sf-side-card glass">
          <h3 class="sf-side-title"><ZgGlyph emoji="🔥" /> 最热帖子</h3>
          <div v-if="!hotPosts.length" class="sf-side-empty">还没有帖子</div>
          <div v-else class="sf-side-latest">
            <div
              v-for="(p, i) in hotPosts"
              :key="p.id"
              class="sf-side-latest-item"
              @click="goPost(p)"
            >
              <div class="t">
                <span v-if="i < 3" class="hot-rank" :class="`rk${i+1}`">{{ i + 1 }}</span>
                {{ p.title }}
              </div>
              <div class="m">
                <ZgGlyph emoji="👤" /> {{ p.author_name }} ·
                <ZgGlyph emoji="👁" /> {{ p.views || 0 }} ·
                <ZgGlyph emoji="💬" /> {{ p.comment_count || 0 }}
              </div>
            </div>
          </div>
        </div>

        <div class="sf-side-card glass">
          <h3 class="sf-side-title"><ZgGlyph emoji="📊" /> 学科信息</h3>
          <div class="sf-side-stat-row">
            <div class="lab">帖子</div><div class="val">{{ posts.length }}</div>
          </div>
          <div class="sf-side-stat-row">
            <div class="lab">话题</div><div class="val">{{ topics.length }}</div>
          </div>
          <div class="sf-side-stat-row" v-if="threshold > 0">
            <div class="lab">免审阈值</div><div class="val">{{ threshold }} 字</div>
          </div>
        </div>
      </aside>
    </div>

    <!-- 新建/编辑话题 dialog（保留在列表页） -->
    <el-dialog v-model="topicDlgVisible" :title="editingTopic ? '编辑话题' : '新建话题'" width="420px">
      <el-form :model="topicForm" label-width="60px">
        <el-form-item label="名称">
          <el-input v-model="topicForm.name" maxlength="20" placeholder="如：考点速记、作业答疑" />
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

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import ZgGlyph from '@/components/ZgGlyph.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const subject = ref<any>(null)
const topics = ref<any[]>([])
const posts = ref<any[]>([])
const loading = ref(false)
const activeTopicId = ref<number | null>(null)
const defaultAvatar = 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'

const topicNameMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.name])))
const topicColorMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.color])))
const canManage = computed(() => subject.value ? user.canManageSubject(subject.value.id) : false)
const canAudit = computed(() => canManage.value || user.isSuperAdmin)
const filteredPosts = computed(() =>
  activeTopicId.value
    ? posts.value.filter(p => (p.topic_ids || []).includes(activeTopicId.value!))
    : posts.value
)
const countByTopic = computed(() => {
  const m: Record<number, number> = {}
  for (const p of posts.value) for (const tid of (p.topic_ids || [])) m[tid] = (m[tid] || 0) + 1
  return m
})
const topicsWithCount = computed(() =>
  topics.value
    .map(t => ({ ...t, count: countByTopic.value[t.id] || 0 }))
    .sort((a, b) => b.count - a.count)
)
// 【v4.1.4】最热帖子：浏览 0.4 + 评论 0.6 加权；同分按发布时间倒序
const hotPosts = computed(() =>
  [...posts.value]
    .filter(p => p.status === 'published' || (user.current && p.author_id === user.current.id))
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
const threshold = computed(() => Number(subject.value?.forum_auto_approve_threshold || 0))

async function load() {
  loading.value = true
  try {
    const slug = route.params.slug as string
    subject.value = await api.subject(slug)
    if (!subject.value) { ElMessage.error('学科不存在'); return }
    await Promise.all([loadTopics(), loadPosts()])
  } finally { loading.value = false }
}
async function loadTopics() { topics.value = (await api.forumTopics(subject.value.id)) as any }
async function loadPosts() { posts.value = (await api.forumPosts(subject.value.id)) as any }

function filterByTopic(id: number | null) { activeTopicId.value = id }

// ---- 话题 CRUD（保留在列表页） ----
const topicDlgVisible = ref(false)
const editingTopic = ref<any>(null)
const topicForm = ref({ name: '', color: '#F59E0B' })
function openTopicDlg() {
  editingTopic.value = null
  topicForm.value = { name: '', color: '#F59E0B' }
  topicDlgVisible.value = true
}
async function saveTopic() {
  if (editingTopic.value) {
    await api.updateForumTopic(subject.value.id, editingTopic.value.id, topicForm.value)
    ElMessage.success('已更新')
  } else {
    await api.createForumTopic(subject.value.id, topicForm.value)
    ElMessage.success('已创建')
  }
  topicDlgVisible.value = false
  await loadTopics()
}
async function delTopic(t: any) {
  try {
    await ElMessageBox.confirm(`确认删除话题「${t.name}」？帖子会保留但失去该话题标签。`, '删除话题', { type: 'warning' })
  } catch { return }
  await api.deleteForumTopic(subject.value.id, t.id)
  ElMessage.success('已删除')
  if (activeTopicId.value === t.id) activeTopicId.value = null
  await loadTopics()
}

// ---- 帖子：跳独立页 ----
function goNewPost() {
  router.push({ name: 'subject-forum-new', params: { slug: subject.value.slug } })
}
function goPost(p: any) {
  router.push({ name: 'subject-forum-post', params: { slug: subject.value.slug, id: p.id } })
}
function goEditPost(p: any) {
  router.push({ name: 'subject-forum-edit', params: { slug: subject.value.slug, id: p.id } })
}
async function delPost(p: any) {
  try {
    await ElMessageBox.confirm('确认删除该帖子及其全部评论？', '删除帖子', { type: 'warning' })
  } catch { return }
  await api.deleteForumPost(subject.value.id, p.id)
  ElMessage.success('已删除')
  await loadPosts()
}

function canEditOrDel(p: any) {
  if (!user.current) return false
  if (p.author_id === user.current.id) return true
  if (canManage.value) return true
  if (user.isSuperAdmin) return true
  return false
}

function goBack() {
  if (subject.value) router.push({ name: 'subject', params: { slug: subject.value.slug } })
  else router.push('/subjects')
}
function stripMd(s: string) {
  if (!s) return ''
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/[#*_`>\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

onMounted(load)
watch(() => route.params.slug, load)
</script>

<style scoped>
.sf-page { max-width: 1280px; margin: 16px auto 64px; padding: 0 20px; }
.sf-header { padding: 22px 28px; border-radius: 20px; }
.sf-back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--zg-text-sub); cursor: pointer; }
.sf-back:hover { color: var(--zg-primary); }
.sf-title { font-size: 22px; font-weight: 800; margin: 8px 0 4px; }
.sf-sub { font-size: 13px; color: var(--zg-text-sub); margin: 0; line-height: 1.6; }

/* 桌面两栏：主区 + 侧栏 */
.sf-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 18px; margin-top: 16px; }
.sf-main { min-width: 0; }
.sf-side { display: flex; flex-direction: column; gap: 14px; }

/* 话题 chips */
.sf-topics { padding: 12px 16px; border-radius: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.sf-topics-left { display: flex; flex-wrap: wrap; gap: 6px; flex: 1; }
.sf-topics-right { display: flex; gap: 6px; }
.sf-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; background: rgba(148, 163, 184, 0.15); border-radius: 999px; font-size: 13px; cursor: pointer; transition: all 0.18s; user-select: none; }
.sf-chip:hover { transform: translateY(-1px); }
.sf-chip.on { background: var(--chip, #F59E0B); color: #fff; font-weight: 700; }
.sf-chip.on .dot { background: rgba(255,255,255,0.7) !important; }
.sf-chip.on .sf-chip-n { color: #fff; }
.sf-chip-n { font-size: 11px; color: var(--zg-text-sub); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.sf-chip-x { margin-left: 4px; opacity: 0.5; padding: 0 2px; }
.sf-chip-x:hover { opacity: 1; }

.sf-actions { display: flex; justify-content: space-between; align-items: center; margin: 16px 4px 10px; }
.sf-stat { font-size: 13px; color: var(--zg-text-sub); }

.sf-list { display: grid; grid-template-columns: 1fr; gap: 12px; }
@media (min-width: 1100px) { .sf-list { grid-template-columns: repeat(2, 1fr); } }

.sf-card { padding: 18px 22px; border-radius: 16px; cursor: pointer; transition: all 0.2s; display: flex; flex-direction: column; gap: 6px; }
.sf-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.08); }
.sf-card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; gap: 8px; }
.sf-card-author { display: flex; gap: 10px; align-items: center; }
.avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: #f0f0f0; }
.sf-card-name { font-weight: 700; font-size: 14px; }
.sf-card-meta { font-size: 12px; color: var(--zg-text-sub); margin-top: 2px; }
.sf-note { color: #B45309; }
.sf-pending { margin-left: 6px; padding: 1px 6px; background: #FEF3C7; color: #B45309; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sf-rejected { margin-left: 6px; padding: 1px 6px; background: #FEE2E2; color: #B91C1C; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sf-card-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.sf-card-tag { padding: 2px 8px; color: #fff; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sf-card-title { font-size: 17px; font-weight: 700; margin: 4px 0 6px; line-height: 1.4; }
.sf-pin { color: var(--zg-primary); font-size: 12px; margin-right: 4px; }
.sf-card-excerpt { font-size: 13px; color: var(--zg-text-sub); line-height: 1.6; margin: 0; flex: 1; }
.sf-card-actions { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.sf-empty { grid-column: 1 / -1; padding: 60px 0; }

/* 侧栏卡片 */
.sf-side-card { padding: 16px 18px; border-radius: 16px; }
.sf-side-title { font-size: 14px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
.sf-side-empty { font-size: 12px; color: var(--zg-text-sub); text-align: center; padding: 12px 0; }
.sf-side-topics { display: flex; flex-direction: column; gap: 6px; }
.sf-side-topic { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; cursor: pointer; transition: background .15s; }
.sf-side-topic:hover { background: rgba(var(--zg-primary-rgb), 0.06); }
.sf-side-topic.on { background: rgba(var(--zg-primary-rgb), 0.12); font-weight: 600; }
.sf-side-topic .name { flex: 1; font-size: 13px; }
.sf-side-topic .count { font-size: 11px; color: var(--zg-text-sub); background: rgba(148, 163, 184, 0.2); padding: 1px 8px; border-radius: 999px; }
.sf-side-latest { display: flex; flex-direction: column; gap: 10px; }
.sf-side-latest-item { cursor: pointer; padding: 6px 0; border-bottom: 1px dashed rgba(148, 163, 184, 0.25); }
.sf-side-latest-item:last-child { border-bottom: none; }
.sf-side-latest-item:hover .t { color: var(--zg-primary); }
.sf-side-latest-item .t { font-size: 13px; font-weight: 600; line-height: 1.5; display: flex; align-items: center; gap: 6px; }
.sf-side-latest-item .m { font-size: 11px; color: var(--zg-text-sub); margin-top: 2px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.hot-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; font-size: 11px; font-weight: 800; color: #fff; flex: none; }
.hot-rank.rk1 { background: linear-gradient(135deg, #F59E0B, #D97706); box-shadow: 0 2px 6px rgba(217, 119, 6, 0.35); }
.hot-rank.rk2 { background: linear-gradient(135deg, #94A3B8, #64748B); box-shadow: 0 2px 6px rgba(100, 116, 139, 0.3); }
.hot-rank.rk3 { background: linear-gradient(135deg, #B45309, #92400E); box-shadow: 0 2px 6px rgba(180, 83, 9, 0.3); }
.sf-side-stat-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
.sf-side-stat-row .lab { color: var(--zg-text-sub); }
.sf-side-stat-row .val { font-weight: 700; }

@media (max-width: 1024px) {
  .sf-layout { grid-template-columns: 1fr; }
  .sf-side { flex-direction: row; flex-wrap: wrap; }
  .sf-side-card { flex: 1 1 220px; }
}
@media (max-width: 640px) {
  .sf-page { padding: 0 12px; }
  .sf-header { padding: 16px; }
  .sf-title { font-size: 19px; }
  .sf-sub { font-size: 12px; }
  .sf-topics { padding: 10px 12px; }
  .sf-topics-left { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .sf-topics-left::-webkit-scrollbar { display: none; }
  .sf-chip { flex: 0 0 auto; min-height: 34px; }
  .sf-actions { flex-wrap: wrap; gap: 8px; }
  .sf-actions :deep(.el-button) { min-height: 38px; }
  .sf-list { grid-template-columns: 1fr; gap: 10px; }
  .sf-card { padding: 16px; }
  .sf-card-title { font-size: 16px; }
  .sf-side { flex-direction: column; }
  .sf-side-card { padding: 14px; }
  .sf-card-actions :deep(.el-button) { min-height: 34px; }
}
</style>
