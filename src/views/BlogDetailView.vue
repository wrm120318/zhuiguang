<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { renderMarkdown } from '@/utils/markdown'
const md = renderMarkdown

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const blog = ref<any>(null)
const loading = ref(true)
const liked = ref(false)
const comments = ref<any[]>([])
const commentText = ref('')
const sendingComment = ref(false)

async function loadComments() {
  try { comments.value = (await api.pageComments(Number(route.params.id))) as any } catch { /* */ }
}

onMounted(async () => {
  try {
    blog.value = await api.page(Number(route.params.id))
    if (user.isLogin) {
      try { const r: any = await api.pageLiked(Number(route.params.id)); liked.value = r.liked } catch { /* */ }
    }
    await loadComments()
  } finally { loading.value = false }
})

async function like() {
  if (!user.isLogin) { ElMessage.warning('请先登录'); return }
  if (liked.value) return
  try {
    const r: any = await api.likePage(blog.value.id)
    if (r.liked) { liked.value = true; blog.value.likes++ }
    else ElMessage.info('你已经点过赞了')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '操作失败') }
}

async function submitComment() {
  if (!user.isLogin) { ElMessage.warning('请先登录'); return }
  if (!commentText.value.trim()) return
  sendingComment.value = true
  try {
    const r: any = await api.addPageComment(blog.value.id, commentText.value)
    comments.value.unshift(r)
    commentText.value = ''
    ElMessage.success('评论已发布（实名）')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '评论失败')
  } finally { sendingComment.value = false }
}

async function deleteComment(commentId: number) {
  try {
    await api.deletePageComment(blog.value.id, commentId)
    comments.value = comments.value.filter((c: any) => c.id !== commentId)
    ElMessage.success('评论已删除')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '删除失败') }
}

async function del() {
  try {
    await ElMessageBox.confirm('确定删除这篇博客？', '删除', { type: 'warning' })
    await api.deletePage(blog.value.id)
    ElMessage.success('已删除')
    router.push('/blog')
  } catch { /* */ }
}

function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }
function timeShort(s: string) { return s?.slice(0, 16) || '' }
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回博客列表</div>
    <article v-if="blog" class="glass-strong detail">
      <div v-if="blog.cover" class="cover" :style="{ backgroundImage: `url(${blog.cover})` }"></div>
      <h1 class="d-title">{{ blog.title }}</h1>
      <div class="d-meta">
        <span><ZgGlyph emoji="👤" /> {{ blog.author_name }}</span>
        <span><ZgGlyph emoji="👁" /> {{ blog.views }} 次阅读</span>
        <span><ZgGlyph emoji="📅" /> {{ blog.created_at?.slice(0, 16) }}</span>
        <el-button v-if="user.isSuperAdmin || blog.author_id === user.current?.id" text type="danger" size="small" @click="del"><ZgGlyph emoji="🗑" /> 删除</el-button>
      </div>
      <div class="d-content" v-html="md(blog.content)"></div>

      <div v-if="blog.attachments?.length" class="d-attachments">
        <div class="da-title"><ZgGlyph emoji="📎" /> 附件下载（{{ blog.attachments.length }}）</div>
        <a v-for="(a, i) in blog.attachments" :key="i" :href="a.url" target="_blank" class="da-item">
          <ZgGlyph emoji="📄" /> {{ a.name }} <span v-if="a.size">({{ fmtSize(a.size) }})</span> <ZgGlyph emoji="⬇" />
        </a>
      </div>

      <!-- 点赞 -->
      <div class="like-bar">
        <div class="like-btn" :class="{ on: liked }" @click="like">
          <span class="lb-icon"><ZgGlyph v-if="liked" emoji="❤️" /><ZgGlyph v-else emoji="🤍" /></span>
          <span class="lb-text">{{ liked ? '已赞' : '点赞' }}</span>
          <span class="lb-count">{{ blog.likes || 0 }}</span>
        </div>
      </div>
    </article>
    <el-empty v-else-if="!loading" description="博客不存在" />

    <!-- 评论区 -->
    <section v-if="blog" class="glass comment-box">
      <div class="section-title"><ZgGlyph emoji="💬" /> 评论 ({{ comments.length }}) · 实名</div>
      <div class="comment-input">
        <img v-if="user.current?.avatar" :src="user.current.avatar" class="ci-avatar" />
        <el-input v-model="commentText" placeholder="写下你的感想…" @keydown.enter="submitComment" />
        <el-button type="primary" :loading="sendingComment" @click="submitComment">发布</el-button>
      </div>
      <div class="comment-list">
        <div v-for="c in comments" :key="c.id" class="comment-item">
          <img :src="c.avatar" class="cm-avatar" />
          <div class="cm-body">
            <div class="cm-head">
              <span class="cm-name">{{ c.user_name }}</span>
              <span class="cm-time">{{ timeShort(c.created_at) }}</span>
            </div>
            <div class="cm-text" v-html="md(c.content)"></div>
          </div>
          <el-button v-if="user.current?.id === c.user_id || user.isSuperAdmin" text size="small" type="danger" @click="deleteComment(c.id)" style="margin-left:auto">删除</el-button>
        </div>
        <el-empty v-if="!comments.length" description="还没有评论，来抢沙发～" :image-size="80" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.back { padding: 12px 0; color: var(--zg-text-dim); cursor: pointer; width: fit-content; font-size: 14px; }
.back:hover { color: var(--zg-primary); }
.detail { padding: 32px; margin-top: 8px; }
.cover { height: 220px; background-size: cover; background-position: center; border-radius: 14px; margin-bottom: 20px; }
.d-title { font-size: 28px; font-weight: 800; line-height: 1.3; }
.d-meta { display: flex; gap: 16px; align-items: center; color: var(--zg-text-dim); font-size: 13px; margin: 12px 0 24px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px dashed rgba(245,158,11,.15); }
.d-content { font-size: 15px; line-height: 1.9; color: var(--zg-text); }
.d-content :deep(h2) { font-size: 22px; margin: 24px 0 12px; }
.d-content :deep(h3) { font-size: 18px; margin: 20px 0 10px; }
.d-content :deep(ul), .d-content :deep(ol) { padding-left: 24px; margin: 10px 0; }
.d-content :deep(li) { margin: 6px 0; }
.d-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }
.d-content :deep(a) { color: var(--zg-primary); }
.d-attachments { margin-top: 32px; padding-top: 20px; border-top: 1px dashed rgba(245,158,11,.15); }
.da-title { font-weight: 700; margin-bottom: 12px; }
.da-item { display: block; padding: 12px 16px; background: rgba(245,158,11,.06); border-radius: 10px; margin-bottom: 8px; color: var(--zg-text); text-decoration: none; font-size: 14px; transition: all .2s; }
.da-item:hover { background: rgba(245,158,11,.15); }
.like-bar { display: flex; justify-content: center; margin-top: 28px; }
.like-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 28px; border-radius: 24px; background: rgba(245,158,11,.06); border: 2px solid rgba(245,158,11,.2); cursor: pointer; transition: all .2s; user-select: none; }
.like-btn:hover { background: rgba(245,158,11,.12); }
.like-btn.on { background: rgba(239,68,68,.1); border-color: #ef4444; }
.lb-icon { font-size: 20px; }
.lb-text { font-weight: 600; font-size: 14px; }
.lb-count { font-size: 14px; font-weight: 700; color: var(--zg-primary); }
.like-btn.on .lb-count { color: #ef4444; }
.comment-box { margin-top: 16px; padding: 24px; }
.section-title { font-size: 16px; font-weight: 700; margin-bottom: 18px; }
.comment-input { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; }
.ci-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; }
.comment-list { display: flex; flex-direction: column; gap: 16px; }
.comment-item { display: flex; gap: 12px; }
.cm-avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; }
.cm-body { flex: 1; min-width: 0; }
.cm-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.cm-name { font-weight: 600; font-size: 13px; }
.cm-time { font-size: 12px; color: var(--zg-text-dim); }
.cm-text { font-size: 14px; line-height: 1.6; color: var(--zg-text); word-break: break-word; }
.cm-text :deep(img) { max-width: 100%; border-radius: 8px; }
@media (max-width: 768px) { .detail { padding: 20px; } .d-title { font-size: 22px; } .cover { height: 160px; } .comment-box { padding: 18px; } }
</style>
