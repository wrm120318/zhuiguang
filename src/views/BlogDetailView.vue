<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown } from '@/utils/markdown'
import { fileUrl } from '@/utils/helpers'
import CommentTree from '@/components/CommentTree.vue'
import ZgGlyph from '@/components/ZgGlyph.vue'
const md = renderMarkdown

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const blog = ref<any>(null)
const loading = ref(true)
const liked = ref(false)
const comments = ref<any[]>([])
const topics = ref<any[]>([])
const relatedPosts = ref<any[]>([])

const topicNameMap = ref<Record<number, string>>({})
const topicColorMap = ref<Record<number, string>>({})

async function loadComments() {
  try { comments.value = (await api.pageComments(Number(route.params.id))) as any } catch { /* */ }
}

onMounted(async () => {
  try {
    const [b, tps] = await Promise.all([
      api.page(Number(route.params.id)),
      api.blogTopics(),
    ])
    const bAny: any = b
    if (typeof bAny.topic_ids === 'string') { try { bAny.topic_ids = JSON.parse(bAny.topic_ids || '[]') } catch { bAny.topic_ids = [] } }
    blog.value = bAny
    const tp: any = tps
    topics.value = tp
    topicNameMap.value = Object.fromEntries(tp.map((t: any) => [t.id, t.name]))
    topicColorMap.value = Object.fromEntries(tp.map((t: any) => [t.id, t.color]))
    if (user.isLogin) {
      try { const r: any = await api.pageLiked(Number(route.params.id)); liked.value = r.liked } catch { /* */ }
    }
    await loadComments()
    await loadRelated()
  } finally { loading.value = false }
})

async function loadRelated() {
  if (!blog.value) return
  try {
    const all: any[] = (await api.blogPosts()) as any
    const tids = (blog.value.topic_ids || []).map(Number).filter(Boolean)
    relatedPosts.value = all
      .filter(p => p.id !== blog.value.id && (tids.length === 0 || (p.topic_ids || []).some((id: number) => tids.includes(id))))
      .slice(0, 5)
  } catch { relatedPosts.value = [] }
}

async function like() {
  if (!user.isLogin) { ElMessage.warning('请先登录'); return }
  if (liked.value) return
  try {
    const r: any = await api.likePage(blog.value.id)
    if (r.liked) { liked.value = true; blog.value.likes++ }
    else ElMessage.info('你已经点过赞了')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '操作失败') }
}

// 【v4.2.0】统一交给 CommentTree
async function onCommentSubmit(content: string, parentId: number | null) {
  try {
    await api.addPageComment(blog.value.id, content, parentId ?? undefined)
    await loadComments()
    ElMessage.success(parentId == null ? '评论已发布' : '回复成功')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '评论发送失败')
    throw e
  }
}
async function onCommentDelete(commentId: number) {
  try {
    await ElMessageBox.confirm('确认删除该评论？主评论将连同所有回复一起删除。', '删除', { type: 'warning' })
  } catch { return }
  await api.deletePageComment(blog.value.id, commentId)
  await loadComments()
  ElMessage.success('已删除')
}
function canDeleteComment(c: any) {
  return user.current?.id === c.user_id || user.isSuperAdmin
}

async function del() {
  try {
    await ElMessageBox.confirm('确定删除这篇博客？', '删除', { type: 'warning' })
    await api.deletePage(blog.value.id)
    ElMessage.success('已删除')
    router.push('/blog')
  } catch (e: any) { if (e !== 'cancel' && e?.message !== 'cancel') ElMessage.error('删除失败：' + (e?.response?.data?.message || e?.message || '请稍后重试')) }
}

// 【v4.0.1 Bug12】编辑博客：跳到编辑页（路由 :id 是博客 ID）
function edit() {
  router.push(`/blog/${blog.value.id}/edit`)
}

function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }
function timeShort(s: string) { return s?.slice(0, 16) || '' }
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回博客列表</div>
    <div v-if="blog" class="bd-grid">
      <!-- 中央：正文 + 评论 -->
      <div class="bd-main">
        <article class="glass-strong detail">
          <div v-if="blog.cover" class="cover">
            <img :src="fileUrl(blog.cover)" :alt="blog.title" />
          </div>
          <h1 class="d-title">{{ blog.title }}</h1>
          <div v-if="blog.topic_ids?.length" class="d-tags">
            <span
              v-for="tid in (blog.topic_ids||[]).map(Number).filter(Boolean)"
              :key="tid"
              class="d-tag"
              :style="{ background: topicColorMap[tid] || '#94A3B8' }"
            >{{ topicNameMap[tid] || '#'+tid }}</span>
          </div>
          <div class="d-meta">
            <span><ZgGlyph emoji="👤" /> {{ blog.author_name }}</span>
            <span><ZgGlyph emoji="👁" /> {{ blog.views }} 次阅读</span>
            <span><ZgGlyph emoji="📅" /> {{ blog.created_at?.slice(0, 16) }}</span>
            <el-button v-if="user.isSuperAdmin || blog.author_id === user.current?.id" text type="primary" size="small" @click="edit"><ZgGlyph emoji="✏️" /> 编辑</el-button>
            <el-button v-if="user.isSuperAdmin || blog.author_id === user.current?.id" text type="danger" size="small" @click="del"><ZgGlyph emoji="🗑" /> 删除</el-button>
          </div>
          <div class="d-content markdown-body" v-html="md(blog.content)"></div>

          <div v-if="blog.attachments?.length" class="d-attachments">
            <div class="da-title"><ZgGlyph emoji="📎" /> 附件下载（{{ blog.attachments.length }}）</div>
            <a v-for="(a, i) in blog.attachments" :key="i" :href="a.url" target="_blank" class="da-item">
              <ZgGlyph emoji="📄" /> {{ a.name }} <span v-if="a.size">({{ fmtSize(a.size) }})</span> <ZgGlyph emoji="⬇" />
            </a>
          </div>

          <div class="like-bar">
            <div class="like-btn" :class="{ on: liked }" @click="like">
              <span class="lb-icon"><ZgGlyph v-if="liked" emoji="❤️" /><ZgGlyph v-else emoji="🤍" /></span>
              <span class="lb-text">{{ liked ? '已赞' : '点赞' }}</span>
              <span class="lb-count">{{ blog.likes || 0 }}</span>
            </div>
          </div>
        </article>

        <section class="glass comment-box">
          <CommentTree
            :comments="comments"
            :current-user="user.current"
            :can-delete="canDeleteComment"
            :on-submit="onCommentSubmit"
            :on-delete="onCommentDelete"
            empty-text="还没有评论，来抢沙发～"
          />
        </section>
      </div>

      <!-- 侧栏 -->
      <aside class="bd-side">
        <div class="bd-side-card glass">
          <h3 class="bd-side-title"><ZgGlyph emoji="👤" /> 作者</h3>
          <div class="bd-author">
            <img class="avatar lg" :src="blog.author_avatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'" :alt="blog.author_name" />
            <div>
              <div class="bd-author-name">{{ blog.author_name }}</div>
              <div class="bd-author-meta">本文作者</div>
            </div>
          </div>
        </div>

        <div v-if="relatedPosts.length" class="bd-side-card glass">
          <h3 class="bd-side-title"><ZgGlyph emoji="🔗" /> 相关博客</h3>
          <div class="bd-related">
            <div
              v-for="rp in relatedPosts"
              :key="rp.id"
              class="bd-related-item"
              @click="router.push(`/blog/${rp.id}`)"
            >
              <div class="t">{{ rp.title }}</div>
              <div class="m">{{ rp.author_name }} · <ZgGlyph emoji="💬" /> {{ rp.comment_count || 0 }}</div>
            </div>
          </div>
        </div>

        <div class="bd-side-card glass">
          <h3 class="bd-side-title"><ZgGlyph emoji="📊" /> 博客信息</h3>
          <div class="bd-stat-row"><div class="lab">发布于</div><div class="val">{{ blog.created_at?.slice(0, 10) }}</div></div>
          <div class="bd-stat-row"><div class="lab">阅读量</div><div class="val">{{ blog.views }}</div></div>
          <div class="bd-stat-row"><div class="lab">评论数</div><div class="val">{{ comments.length }}</div></div>
        </div>
      </aside>
    </div>
    <ZgState v-else-if="!loading" type="404" title="博客不存在" desc="这篇博客可能已被删除或链接有误。" />
  </div>
</template>

<style scoped>
.back { padding: 12px 0; color: var(--zg-text-dim); cursor: pointer; width: fit-content; font-size: 14px; }
.back:hover { color: var(--zg-primary); }
.bd-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px; align-items: start; margin-top: 8px; }
.bd-main { min-width: 0; display: flex; flex-direction: column; gap: 16px; }
.bd-side { display: flex; flex-direction: column; gap: 14px; }

.detail { padding: 32px; }
.cover { position: relative; height: 240px; border-radius: 16px; overflow: hidden; margin-bottom: 22px; background: linear-gradient(135deg, rgba(var(--zg-accent-rgb),.18), rgba(var(--zg-primary-2-rgb),.12)); box-shadow: var(--zg-shadow-lg); transition: box-shadow .3s var(--zg-ease); }
.cover::before { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: 1; background: linear-gradient(160deg, rgba(255,255,255,.20), rgba(255,255,255,0) 40%); }
.cover img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .6s var(--zg-ease); }
.cover:hover { box-shadow: var(--zg-shadow-lg), 0 0 0 1px rgba(var(--zg-primary-rgb),.22), 0 18px 52px rgba(var(--zg-accent-rgb),.20); }
.cover:hover img { transform: scale(1.04); }
.d-title { font-size: 28px; font-weight: 800; line-height: 1.3; }
.d-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 4px; }
.d-tag { padding: 3px 10px; color: #fff; font-size: 11px; border-radius: 6px; font-weight: 600; }
.d-meta { display: flex; gap: 16px; align-items: center; color: var(--zg-text-dim); font-size: 13px; margin: 12px 0 24px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px dashed rgba(var(--zg-primary-rgb),.15); }
.d-content { font-size: 15px; line-height: 1.9; color: var(--zg-text); }
.d-content :deep(h2) { font-size: 22px; margin: 24px 0 12px; }
.d-content :deep(h3) { font-size: 18px; margin: 20px 0 10px; }
.d-content :deep(ul), .d-content :deep(ol) { padding-left: 24px; margin: 10px 0; }
.d-content :deep(li) { margin: 6px 0; }
.d-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }
.d-content :deep(a) { color: var(--zg-primary); }
.d-attachments { margin-top: 32px; padding-top: 20px; border-top: 1px dashed rgba(var(--zg-primary-rgb),.15); }
.da-title { font-weight: 700; margin-bottom: 12px; }
.da-item { display: block; padding: 12px 16px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 10px; margin-bottom: 8px; color: var(--zg-text); text-decoration: none; font-size: 14px; transition: all .2s; }
.da-item:hover { background: rgba(var(--zg-primary-rgb),.15); }
.like-bar { display: flex; justify-content: center; margin-top: 28px; }
.like-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 28px; border-radius: 24px; background: rgba(var(--zg-primary-rgb),.06); border: 2px solid rgba(var(--zg-primary-rgb),.2); cursor: pointer; transition: all .2s; user-select: none; }
.like-btn:hover { background: rgba(var(--zg-primary-rgb),.12); }
.like-btn.on { background: rgba(239,68,68,.1); border-color: #ef4444; }
.lb-icon { font-size: 20px; }
.lb-text { font-weight: 600; font-size: 14px; }
.lb-count { font-size: 14px; font-weight: 700; color: var(--zg-primary); }
.like-btn.on .lb-count { color: #ef4444; }
.comment-box { padding: 24px; }

.bd-side-card { padding: 16px 18px; border-radius: 16px; }
.bd-side-title { font-size: 14px; font-weight: 700; margin: 0 0 12px; display: flex; align-items: center; gap: 6px; }
.bd-author { display: flex; gap: 12px; align-items: center; }
.avatar.lg { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; background: #f0f0f0; }
.bd-author-name { font-weight: 700; font-size: 14px; }
.bd-author-meta { font-size: 12px; color: var(--zg-text-sub); margin-top: 2px; }
.bd-related { display: flex; flex-direction: column; gap: 10px; }
.bd-related-item { cursor: pointer; padding: 6px 0; border-bottom: 1px dashed rgba(148, 163, 184, 0.25); }
.bd-related-item:last-child { border-bottom: none; }
.bd-related-item:hover .t { color: var(--zg-primary); }
.bd-related-item .t { font-size: 13px; font-weight: 600; line-height: 1.5; }
.bd-related-item .m { font-size: 12px; color: var(--zg-text-sub); margin-top: 2px; }
.bd-stat-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
.bd-stat-row .lab { color: var(--zg-text-sub); }
.bd-stat-row .val { font-weight: 700; }

@media (max-width: 1024px) {
  .bd-grid { grid-template-columns: 1fr; }
  .bd-side { flex-direction: row; flex-wrap: wrap; }
  .bd-side-card { flex: 1 1 220px; }
}
@media (max-width: 768px) {
  .detail { padding: 20px; } .d-title { font-size: 22px; } .cover { height: 160px; border-radius: 14px; }
  .comment-box { padding: 18px; } .bd-side { flex-direction: column; } .bd-side-card { padding: 14px; }
}
</style>
