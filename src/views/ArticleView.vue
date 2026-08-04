<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { ElMessage } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'

const route = useRoute()
const router = useRouter()
const data = useDataStore()
const user = useUserStore()

const article = ref<any>(null)
const liked = ref(false)
const collected = ref(false)
const comment = ref('')
const comments = ref<any[]>([])

onMounted(async () => {
  article.value = await api.article(Number(route.params.id))
  try { comments.value = (await api.articleComments(Number(route.params.id))) as any } catch {}
})
const subject = () => data.subjectById(article.value?.subject_id || article.value?.subjectId)

async function like() { if (!liked.value) { const r: any = await api.likeArticle(article.value.id); liked.value = r.liked; if (r.liked) article.value.likes++ } }
async function toggleFav() {
  try {
    const r: any = await api.toggleFavorite('article', article.value.id)
    collected.value = r.favorited
    ElMessage.success(r.favorited ? '已收藏' : '已取消收藏')
  } catch { ElMessage.error('操作失败') }
}
async function submitComment() {
  if (!comment.value.trim()) return
  try {
    const r: any = await api.addArticleComment(article.value.id, comment.value)
    comments.value.unshift(r.data || r)
    comment.value = ''
    ElMessage.success('评论已发布（实名）')
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || e?.message || '评论发布失败') }
}
</script>

<template>
  <div class="page zg-container" v-if="article">
    <div class="back" @click="router.back()">← 返回</div>
    <article class="art-detail glass-strong">
      <div class="ad-cover" :style="{ backgroundImage: `url(${article.cover})` }"></div>
      <div class="ad-body">
        <div class="ad-cats">
          <span class="ad-cat">{{ subject()?.icon }} {{ subject()?.name }}</span>
          <span class="ad-cat type">{{ article.category }}</span>
          <span v-for="t in article.tags" :key="t" class="ad-tag">#{{ t }}</span>
        </div>
        <h1 class="ad-title" style="display:inline-block">{{ article.title }}
          <el-tag v-if="article?.status==='pending'" type="warning" effect="dark" style="margin-left:12px">⏳ 待超管审核（仅关联用户可见）</el-tag>
          <el-tag v-else-if="article?.status==='pending_student'" type="info" effect="dark" style="margin-left:12px">👤 等待作者学生确认</el-tag>
          <el-tag v-else-if="article?.status==='rejected'" type="danger" effect="dark" style="margin-left:12px">❌ 审核未通过</el-tag>
          <el-tag v-else-if="article?.status==='rejected_student'" type="danger" style="margin-left:12px">学生已拒绝发布</el-tag>
        </h1>
        <div class="ad-meta">
          <img :src="article.cover" class="ad-avatar" v-if="false" />
          <span>发布人：{{ article?.creator_name || article?.author }}</span><span class="dot">·</span>
          <template v-if="article?.actual_user_name"><span>实际作者：{{ article?.actual_user_name }} · 代发</span><span class="dot">·</span></template>
          <span>{{ article.created_at || article.createdAt }}</span><span class="dot">·</span><span>👁 {{ article.views }}</span>
        </div>
        <div class="ad-recommend glass" v-if="article.recommendation">💡 {{ article.recommendation }}</div>
        <div class="ad-content" v-html="md(article.content)"></div>
        <div class="ad-gallery" v-if="article.images?.length">
          <img v-for="(im, i) in article.images" :key="i" :src="im" class="ad-img" />
        </div>
        <div class="ad-actions">
          <div class="act" :class="{ on: liked }" @click="like">❤ {{ article.likes }}</div>
          <div class="act" :class="{ on: collected }" @click="toggleFav">⭐ {{ collected ? '已收藏' : '收藏' }}</div>
          <div class="act" @click="router.push(`/subject/${subject()?.slug}`)">📂 进入学科</div>
        </div>
      </div>
    </article>
    <section class="comment-box glass">
      <div class="section-title">评论 (实名)</div>
      <div class="comment-input">
        <img :src="user.current?.avatar" class="c-avatar" />
        <el-input v-model="comment" placeholder="写下你的感想…" />
        <el-button type="primary" @click="submitComment">发送</el-button>
      </div>
      <div class="comment-list">
        <div v-for="(c, i) in comments" :key="i" class="comment-item">
          <img :src="c.avatar" class="c-avatar" />
          <div class="c-body"><div class="c-name">{{ c.name }} <span class="c-time">{{ c.time }}</span></div><div class="c-text">{{ c.text }}</div></div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.back { display:inline-block; margin:16px 0 0; color:var(--zg-text-dim); cursor:pointer; }
.art-detail { overflow:hidden; }
.ad-cover { height:280px; background-size:cover; background-position:center; }
.ad-body { padding:32px 40px; }
.ad-cats { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
.ad-cat { padding:3px 10px; border-radius:6px; font-size:12px; background:rgba(245,158,11,.18); color:var(--zg-accent); }
.ad-cat.type { background:rgba(251,146,60,.18); color:var(--zg-primary); }
.ad-tag { font-size:12px; color:var(--zg-text-dim); }
.ad-title { font-size:32px; font-weight:800; margin-bottom:14px; line-height:1.3; }
.ad-meta { display:flex; align-items:center; gap:8px; color:var(--zg-text-dim); font-size:13px; margin-bottom:20px; flex-wrap:wrap; }
.ad-avatar { width:28px; height:28px; border-radius:50%; }
.dot { opacity:.5; }
.ad-recommend { padding:12px 16px; font-size:14px; color:var(--zg-accent); margin-bottom:24px; }
.ad-content { font-size:17px; line-height:2; color:var(--zg-text); }
.ad-content :deep(h2) { font-size:24px; margin:20px 0 12px; }
.ad-content :deep(p) { margin-bottom:16px; }
.ad-content :deep(blockquote) { border-left:3px solid var(--zg-primary); padding:10px 18px; margin:18px 0; background:rgba(245,158,11,.06); border-radius:0 10px 10px 0; color:var(--zg-text-dim); font-style:italic; }
.ad-gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin:24px 0; }
.ad-img { width:100%; height:160px; object-fit:cover; border-radius:12px; }
.ad-actions { display:flex; gap:16px; padding-top:24px; border-top:1px solid rgba(245,158,11,.1); margin-top:24px; flex-wrap:wrap; }
.act { padding:8px 20px; border-radius:30px; background:rgba(245,158,11,.06); cursor:pointer; transition:all .2s; font-size:14px; }
.act:hover { background:rgba(245,158,11,.18); }
.act.on { background:rgba(239,68,68,.15); color:#dc2626; }
.comment-box { margin-top:24px; padding:24px; }
.comment-input { display:flex; gap:12px; align-items:center; margin-bottom:20px; }
.c-avatar { width:36px; height:36px; border-radius:50%; flex-shrink:0; object-fit:cover; }
.comment-list { display:flex; flex-direction:column; gap:16px; }
.comment-item { display:flex; gap:12px; }
.c-body { flex:1; }
.c-name { font-weight:600; font-size:14px; }
.c-time { font-weight:400; font-size:11px; color:var(--zg-text-dim); margin-left:8px; }
.c-text { font-size:14px; color:var(--zg-text-dim); margin-top:4px; line-height:1.6; }
@media (max-width:768px){ .ad-body{padding:20px;} .ad-title{font-size:22px;} .ad-content{font-size:15px;} .ad-cover{height:180px;} .ad-gallery{grid-template-columns:1fr;} }

@media (min-width: 1200px) {
  .ad-cover { height: 380px; }
  .ad-body { padding: 44px 56px; }
  .ad-title { font-size: 38px; line-height: 1.25; margin-bottom: 20px; }
  .ad-meta { font-size: 15px; }
  .ad-content { font-size: 18px; line-height: 2; }
  .ad-content :deep(h2) { font-size: 28px; }
  .ad-gallery { gap: 18px; margin: 32px 0; }
  .ad-img { height: 220px; border-radius: 16px; }
  .ad-actions { gap: 24px; padding-top: 32px; margin-top: 32px; }
  .act { padding: 16px; font-size: 15px; }
  .comment-box { padding: 36px; margin-top: 32px; }
}
</style>
