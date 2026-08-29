<template>
  <div class="sfp-page">
    <div class="sfp-back" @click="goBack">
      <ZgGlyph emoji="←" /> 返回 {{ subject?.name || '学科' }} 论坛
    </div>

    <div v-if="loading" v-loading="true" class="sfp-loading"></div>

    <!-- 桌面两栏：中央阅读 + 侧栏 -->
    <div v-else-if="post" class="sfp-grid">
      <!-- 中央：帖子正文 + 评论 -->
      <div class="sfp-main">
        <article class="sfp-card glass">
          <div class="sfp-head">
            <div class="sfp-author">
              <img class="avatar" :src="post.author_avatar || defaultAvatar" :alt="post.author_name" />
              <div>
                <div class="sfp-name">
                  {{ post.author_name }}
                  <span v-if="post.status==='pending'" class="sf-pending">待审核</span>
                  <span v-else-if="post.status==='rejected'" class="sf-rejected">已驳回</span>
                </div>
                <div class="sfp-meta">
                  {{ (post.created_at || '').slice(0, 16) }} ·
                  <ZgGlyph emoji="👁" /> {{ post.views }} ·
                  <ZgGlyph emoji="💬" /> {{ comments.length }}
                </div>
              </div>
            </div>
            <div v-if="canEdit" class="sfp-head-actions">
              <el-button size="small" @click="goEdit">
                <ZgGlyph emoji="✏️" /> 编辑
              </el-button>
              <el-button size="small" type="danger" @click="delPost">
                <ZgGlyph emoji="🗑" /> 删除
              </el-button>
            </div>
          </div>

          <h1 class="sfp-title">{{ post.title }}</h1>

          <div v-if="post.topic_ids && post.topic_ids.length" class="sfp-tags">
            <span
              v-for="tid in post.topic_ids"
              :key="tid"
              class="sfp-tag"
              :style="{ background: topicColorMap[tid] || '#94A3B8' }"
            >{{ topicNameMap[tid] || '#'+tid }}</span>
          </div>

          <div class="sfp-content" v-html="renderMd(post.content)"></div>

          <div v-if="post.review_note" class="sfp-review-note">
            <ZgGlyph emoji="⚠️" /> 审核意见：{{ post.review_note }}
          </div>
        </article>

        <!-- 评论【v4.2.0】统一用 CommentTree，支持二级回复 -->
        <div class="sfp-comments glass">
          <CommentTree
            :comments="comments"
            :current-user="user.current"
            :can-delete="canDelComment"
            :on-submit="onCommentSubmit"
            :on-delete="onCommentDelete"
            empty-text="还没有评论，来抢沙发吧～"
          />
        </div>
      </div>

      <!-- 侧栏：作者信息 / 相关帖子 / 学科信息 -->
      <aside class="sfp-side">
        <div class="sfp-side-card glass">
          <h3 class="sfp-side-title"><ZgGlyph emoji="👤" /> 作者</h3>
          <div class="sfp-author-block">
            <img class="avatar lg" :src="post.author_avatar || defaultAvatar" :alt="post.author_name" />
            <div>
              <div class="sfp-author-name">{{ post.author_name }}</div>
              <div class="sfp-author-meta">本文作者</div>
            </div>
          </div>
        </div>

        <div v-if="relatedPosts.length" class="sfp-side-card glass">
          <h3 class="sfp-side-title"><ZgGlyph emoji="🔗" /> 相关帖子</h3>
          <div class="sfp-related">
            <div
              v-for="rp in relatedPosts"
              :key="rp.id"
              class="sfp-related-item"
              @click="goRelated(rp.id)"
            >
              <div class="t">{{ rp.title }}</div>
              <div class="m">
                {{ rp.author_name }} · <ZgGlyph emoji="💬" /> {{ rp.comment_count || 0 }}
              </div>
            </div>
          </div>
        </div>

        <div class="sfp-side-card glass">
          <h3 class="sfp-side-title"><ZgGlyph emoji="📊" /> 学科信息</h3>
          <div class="sfp-side-stat-row">
            <div class="lab">学科</div>
            <div class="val">{{ subject?.name || '-' }}</div>
          </div>
          <div class="sfp-side-stat-row">
            <div class="lab">发布于</div>
            <div class="val">{{ (post.created_at || '').slice(0, 10) }}</div>
          </div>
        </div>
      </aside>
    </div>

    <div v-else class="sfp-empty">
      <el-empty description="帖子不存在或已被删除" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import ZgGlyph from '@/components/ZgGlyph.vue'
import CommentTree from '@/components/CommentTree.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const subject = ref<any>(null)
const post = ref<any>(null)
const topics = ref<any[]>([])
const comments = ref<any[]>([])
const relatedPosts = ref<any[]>([])
const loading = ref(false)
const defaultAvatar = 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'

const topicNameMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.name])))
const topicColorMap = computed(() => Object.fromEntries(topics.value.map(t => [t.id, t.color])))
const canEdit = computed(() => {
  if (!post.value || !user.current) return false
  if (user.isSuperAdmin) return true
  if (post.value.author_id === user.current.id) return true
  if (subject.value && user.canManageSubject(subject.value.id)) return true
  return false
})
function canDelComment(c: any) {
  if (!user.current) return false
  if (user.isSuperAdmin) return true
  if (c.user_id === user.current.id) return true
  if (subject.value && user.canManageSubject(subject.value.id)) return true
  return false
}

async function load() {
  loading.value = true
  try {
    const slug = route.params.slug as string
    const pid = Number(route.params.id)
    subject.value = await api.subject(slug)
    if (!subject.value) { ElMessage.error('学科不存在'); return }
    const [p, t] = await Promise.all([
      api.forumPost(subject.value.id, pid),
      api.forumTopics(subject.value.id),
    ])
    post.value = p
    topics.value = t as any
    if (post.value?.id) await loadComments()
    await loadRelated()
  } catch (e: any) {
    if (e?.response?.status === 403) ElMessage.error('无权查看此帖')
    else if (e?.response?.status === 404) ElMessage.error('帖子不存在')
  } finally { loading.value = false }
}

async function loadComments() {
  comments.value = (await api.pageComments(post.value.id)) as any
}

async function loadRelated() {
  // 取同话题的其他帖子作为相关
  if (!post.value || !subject.value) return
  try {
    const all: any[] = (await api.forumPosts(subject.value.id)) as any
    const tids = post.value.topic_ids || []
    relatedPosts.value = all
      .filter(p => p.id !== post.value.id && p.status === 'published'
        && (tids.length === 0 || (p.topic_ids || []).some((id: number) => tids.includes(id))))
      .slice(0, 5)
  } catch { relatedPosts.value = [] }
}

// 【v4.2.0】统一交给 CommentTree：支持二级回复
async function onCommentSubmit(content: string, parentId: number | null) {
  const r: any = await api.addPageComment(post.value.id, content, parentId ?? undefined)
  if (parentId == null) {
    comments.value.unshift(r)
  } else {
    const parent = comments.value.find((x: any) => x.id === parentId)
    if (parent) {
      const children = parent.children || []
      children.push({ ...r, parent_id: parentId })
      parent.children = children
    } else {
      comments.value.unshift(r)
    }
  }
  ElMessage.success(parentId == null ? '评论已发布' : '回复成功')
}
async function onCommentDelete(commentId: number) {
  try {
    await ElMessageBox.confirm('确认删除该评论？主评论将连同所有回复一起删除。', '删除', { type: 'warning' })
  } catch { return }
  await api.deletePageComment(post.value.id, commentId)
  await loadComments()
  ElMessage.success('已删除')
}
async function delComment(c: any) {
  try {
    await ElMessageBox.confirm('确认删除该评论？', '删除', { type: 'warning' })
  } catch { return }
  await api.deletePageComment(post.value.id, c.id)
  ElMessage.success('已删除')
  await loadComments()
}

function goEdit() {
  router.push({
    name: 'subject-forum-edit',
    params: { slug: subject.value.slug, id: post.value.id },
  })
}
async function delPost() {
  try {
    await ElMessageBox.confirm('确认删除该帖子及其全部评论？', '删除帖子', { type: 'warning' })
  } catch { return }
  await api.deleteForumPost(subject.value.id, post.value.id)
  ElMessage.success('已删除')
  router.push({ name: 'subject-forum', params: { slug: subject.value.slug } })
}
function goRelated(id: number) {
  router.push({ name: 'subject-forum-post', params: { slug: subject.value.slug, id } })
}

function goBack() {
  if (subject.value) router.push({ name: 'subject-forum', params: { slug: subject.value.slug } })
  else router.push('/subjects')
}

function renderMd(s: string) {
  if (!s) return ''
  let html = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  html = html
    .split(/\n\n+/)
    .map(p => /^\s*<(h\d|ul|ol|pre|blockquote)/.test(p) ? p : '<p>' + p.replace(/\n/g, '<br>') + '</p>')
    .join('\n')
  return html
}

onMounted(load)
watch(() => route.params.id, load)
</script>

<style scoped>
.sfp-page { max-width: 1280px; margin: 16px auto 64px; padding: 0 20px; }
.sfp-back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--zg-text-sub); cursor: pointer; margin-bottom: 12px; }
.sfp-back:hover { color: var(--zg-primary); }
.sfp-loading { min-height: 320px; }

/* 桌面两栏：中央阅读 + 侧栏 */
.sfp-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; }
.sfp-main { min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.sfp-side { display: flex; flex-direction: column; gap: 14px; }

.sfp-card { padding: 28px 32px; border-radius: 20px; }
.sfp-head { display: flex; justify-content: space-between; align-items: flex-start; }
.sfp-author { display: flex; gap: 12px; align-items: center; }
.avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #f0f0f0; }
.avatar.sm { width: 32px; height: 32px; }
.avatar.lg { width: 56px; height: 56px; }
.sfp-name { font-weight: 700; font-size: 14px; }
.sfp-meta { font-size: 12px; color: var(--zg-text-sub); margin-top: 2px; }
.sf-pending { margin-left: 6px; padding: 1px 6px; background: #FEF3C7; color: #B45309; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sf-rejected { margin-left: 6px; padding: 1px 6px; background: #FEE2E2; color: #B91C1C; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sfp-title { font-size: 26px; font-weight: 800; margin: 16px 0 12px; line-height: 1.35; }
.sfp-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 16px; }
.sfp-tag { padding: 3px 10px; color: #fff; font-size: 11px; border-radius: 6px; font-weight: 600; }
.sfp-content { font-size: 15px; line-height: 1.85; color: var(--zg-text); }
.sfp-content :deep(h1) { font-size: 22px; margin: 1em 0 0.5em; }
.sfp-content :deep(h2) { font-size: 19px; margin: 1em 0 0.5em; }
.sfp-content :deep(h3) { font-size: 16px; margin: 1em 0 0.5em; }
.sfp-content :deep(p) { margin: 0.8em 0; }
.sfp-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }
.sfp-content :deep(code) { background: rgba(148, 163, 184, 0.2); padding: 1px 6px; border-radius: 4px; font-family: monospace; font-size: 0.92em; }
.sfp-content :deep(pre) { background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 10px; overflow-x: auto; }
.sfp-content :deep(blockquote) { border-left: 4px solid var(--zg-primary); padding: 6px 14px; background: rgba(var(--zg-primary-rgb), 0.05); margin: 10px 0; color: var(--zg-text-sub); }
.sfp-content :deep(strong) { font-weight: 700; }
.sfp-content :deep(a) { color: var(--zg-primary); }
.sfp-content :deep(ul), .sfp-content :deep(ol) { padding-left: 1.5em; }
.sfp-review-note { margin-top: 14px; padding: 10px 14px; background: #FEF3C7; color: #92400E; border-radius: 10px; font-size: 13px; }

.sfp-comments { padding: 24px 28px; border-radius: 20px; }
.sfp-comments-title { font-size: 17px; font-weight: 700; margin: 0 0 16px; }
.sfp-comment-input { display: flex; flex-direction: column; gap: 8px; margin-bottom: 18px; }
.sfp-comment-input .el-button { align-self: flex-end; }
.sfp-no-comments { text-align: center; color: var(--zg-text-sub); padding: 20px; font-size: 13px; }
.sfp-comment { display: flex; gap: 12px; padding: 14px 0; border-top: 1px dashed rgba(148, 163, 184, 0.25); }
.sfp-comment:first-of-type { border-top: none; }
.sfp-comment-body { flex: 1; }
.sfp-comment-head { display: flex; align-items: center; gap: 10px; }
.sfp-comment-name { font-weight: 700; font-size: 13px; }
.sfp-comment-time { font-size: 12px; color: var(--zg-text-sub); }
.sfp-comment-text { font-size: 14px; line-height: 1.6; margin-top: 6px; white-space: pre-wrap; }

.sfp-side-card { padding: 16px 18px; border-radius: 16px; }
.sfp-side-title { font-size: 14px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
.sfp-author-block { display: flex; gap: 12px; align-items: center; }
.sfp-author-name { font-weight: 700; font-size: 14px; }
.sfp-author-meta { font-size: 11px; color: var(--zg-text-sub); margin-top: 2px; }

.sfp-related { display: flex; flex-direction: column; gap: 10px; }
.sfp-related-item { cursor: pointer; padding: 6px 0; border-bottom: 1px dashed rgba(148, 163, 184, 0.25); }
.sfp-related-item:last-child { border-bottom: none; }
.sfp-related-item:hover .t { color: var(--zg-primary); }
.sfp-related-item .t { font-size: 13px; font-weight: 600; line-height: 1.5; }
.sfp-related-item .m { font-size: 11px; color: var(--zg-text-sub); margin-top: 2px; }
.sfp-side-stat-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
.sfp-side-stat-row .lab { color: var(--zg-text-sub); }
.sfp-side-stat-row .val { font-weight: 700; }

.sfp-empty { padding: 60px 0; }

@media (max-width: 1024px) {
  .sfp-grid { grid-template-columns: 1fr; }
  .sfp-side { flex-direction: row; flex-wrap: wrap; }
  .sfp-side-card { flex: 1 1 220px; }
}
@media (max-width: 640px) {
  .sfp-page { padding: 0 14px; }
  .sfp-card { padding: 18px 18px; }
  .sfp-title { font-size: 21px; }
  .sfp-side { flex-direction: column; }
}
</style>
