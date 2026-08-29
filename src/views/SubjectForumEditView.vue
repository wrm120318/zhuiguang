<template>
  <div class="sfe-page zg-container">
    <div class="sfe-top">
      <div class="sfe-back" @click="goBack">
        <ZgGlyph emoji="←" /> 返回 {{ subject?.name || '学科' }} 论坛
      </div>
      <div class="sfe-top-meta">
        <span v-if="lastSavedAt" class="sfe-draft">
          <ZgGlyph emoji="💾" /> 草稿已自动保存 · {{ draftTimeText }}
        </span>
        <span v-else-if="hasDraft && restored" class="sfe-draft warn">
          <ZgGlyph emoji="↩" /> 已恢复本地草稿
        </span>
      </div>
    </div>

    <div class="sfe-grid">
      <div class="sfe-main glass-strong">
        <h1 class="sfe-title">
          <ZgGlyph :emoji="isEdit ? '✏️' : '✍️'" /> {{ pageTitle }}
        </h1>

        <div class="sfe-row">
          <el-input
            v-model="postForm.title"
            maxlength="100"
            placeholder="帖子标题（一句话说清楚你想聊什么）"
            size="large"
          />
        </div>

        <div class="sfe-row two">
          <el-select
            v-model="postForm.topicIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="选 1-3 个话题标签（可空）"
            style="width:100%"
          >
            <el-option v-for="t in topics" :key="t.id" :label="t.name" :value="t.id">
              <span style="float:left">{{ t.name }}</span>
              <span
                style="float:right;width:10px;height:10px;border-radius:50%;margin-top:7px"
                :style="{ background: t.color }"
              ></span>
            </el-option>
          </el-select>
          <el-input
            v-model="postForm.recommendation"
            placeholder="推荐语 / 摘要（一句话介绍，可空）"
          />
        </div>

        <!-- 【v4.2.2】统一 MarkdownEditor -->
        <MarkdownEditor
          v-model="postForm.content"
          placeholder="支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF/B站嵌入 + @提及 + ==高亮== + 表情..."
          :min-height="360"
        />

        <div class="sfe-foot">
          <div class="sfe-stats">
            字数 <b>{{ charCount }}</b>
            <span v-if="autoApproveHint" class="ep-hint-auto">
              · 阈值 {{ threshold }} 字，将自动通过
            </span>
            <span v-else-if="needAuditHint" class="ep-hint-pending">· 需提交审核</span>
            <span v-else-if="isStaff" class="ep-hint-auto">· 你发布的帖子将直接公开</span>
          </div>
          <div class="sfe-btns">
            <el-button v-if="hasDraft" @click="clearDraftNow" plain>
              <ZgGlyph emoji="🧹" /> 清除草稿
            </el-button>
            <el-button @click="saveNow" plain>
              <ZgGlyph emoji="💾" /> 保存草稿
            </el-button>
            <el-button @click="goBack">取消</el-button>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="!canSubmit"
              @click="submit"
            >{{ isEdit ? '保存修改' : '发布' }}</el-button>
          </div>
        </div>
      </div>

      <aside class="sfe-side">
        <div class="sfe-side-card glass">
          <h3 class="sfe-side-title"><ZgGlyph emoji="🏷️" /> 话题</h3>
          <p class="sfe-side-tip">为本帖打 1-3 个话题标签，便于其他同学检索。</p>
          <div class="sfe-topics-mini">
            <span
              v-for="t in topics"
              :key="t.id"
              class="sfe-topic-chip"
              :class="{ on: postForm.topicIds.includes(t.id) }"
              :style="{ '--chip': t.color }"
              @click="toggleTopic(t.id)"
            >{{ t.name }}</span>
          </div>
        </div>

        <div class="sfe-side-card glass">
          <h3 class="sfe-side-title"><ZgGlyph emoji="📜" /> 发帖规则</h3>
          <ul class="sfe-rules">
            <li><ZgGlyph emoji="✍️" /> 支持 Markdown + HTML 子集 + KaTeX 公式 + 视频/PDF 嵌入</li>
            <li><ZgGlyph emoji="⏱" /> 内容每 {{ AUTO_DEBOUNCE_MS / 1000 }} 秒自动存到本地草稿</li>
            <li v-if="threshold > 0"><ZgGlyph emoji="⚡" /> 纯文本 ≤ {{ threshold }} 字自动通过审核</li>
            <li v-else><ZgGlyph emoji="🔍" /> 帖子需审核通过后才会公开</li>
            <li><ZgGlyph emoji="📌" /> 标题 100 字内，正文不限</li>
          </ul>
        </div>

        <div v-if="isStaff" class="sfe-side-card glass">
          <h3 class="sfe-side-title"><ZgGlyph emoji="🛡" /> 学科教师 / 超管</h3>
          <p class="sfe-side-tip">你发布的帖子会跳过审核，立即公开。仍可事后编辑/删除。</p>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
// ===== v4.2.2 学科论坛帖子编辑器 =====
// 统一使用 <MarkdownEditor>（CommonMark + GFM + HTML 子集 + KaTeX + 视频/PDF 嵌入）
// 编辑权限：作者本人 / 学科教师 / 超管

import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { useAutoSave } from '@/composables/useAutoSave'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import ZgGlyph from '@/components/ZgGlyph.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const AUTO_DEBOUNCE_MS = 1500

const subject = ref<any>(null)
const topics = ref<any[]>([])
const post = ref<any>(null)
const loading = ref(false)
const permissionDenied = ref(false)
const saving = ref(false)

const editId = computed<number | null>(() => {
  const p = route.params.id
  if (p) {
    const n = Number(Array.isArray(p) ? p[0] : p)
    if (n) return n
  }
  return null
})
const isEdit = computed(() => !!editId.value)
const pageTitle = computed(() => {
  if (isEdit.value) return '编辑帖子'
  if (subject.value) return `在「${subject.value.name}」发帖`
  return '写新帖'
})

const postForm = ref<{ title: string; content: string; topicIds: number[]; recommendation: string }>({
  title: '', content: '', topicIds: [], recommendation: '',
})

const isStaff = computed(() => {
  if (!subject.value) return false
  if (user.isSuperAdmin) return true
  if (user.isTeacher && user.teachingSubjects?.includes?.(Number(subject.value.id))) return true
  return false
})
const threshold = computed(() => Number(subject.value?.forum_auto_approve_threshold || 0))
const charCount = computed(() => (postForm.value.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, '').length)
const autoApproveHint = computed(() =>
  threshold.value > 0 && charCount.value > 0 && charCount.value <= threshold.value && !isStaff.value
)
const needAuditHint = computed(() =>
  threshold.value > 0 && charCount.value > threshold.value && !isStaff.value
)
const canSubmit = computed(() => !!postForm.value.title.trim() && charCount.value > 0)

function toggleTopic(id: number) {
  const i = postForm.value.topicIds.indexOf(id)
  if (i >= 0) postForm.value.topicIds.splice(i, 1)
  else if (postForm.value.topicIds.length < 3) postForm.value.topicIds.push(id)
  else ElMessage.warning('最多选 3 个话题')
}

async function load() {
  const slug = route.params.slug as string
  loading.value = true
  try {
    subject.value = await api.subject(slug)
    if (!subject.value) { ElMessage.error('学科不存在'); permissionDenied.value = true; return }
    topics.value = (await api.forumTopics(subject.value.id)) as any
    if (isEdit.value && editId.value) {
      try {
        const r: any = await api.forumPost(subject.value.id, editId.value)
        const isOwner = r.author_id === user.current?.id
        if (!isOwner && !user.isSuperAdmin && !isStaff.value) {
          permissionDenied.value = true
          ElMessage.error('只有作者本人、学科教师或超管可以编辑该帖子')
          return
        }
        post.value = r
        postForm.value = {
          title: r.title || '',
          content: r.content || '',
          topicIds: [...(r.topic_ids || [])],
          recommendation: r.recommendation || '',
        }
      } catch (e: any) {
        permissionDenied.value = true
        ElMessage.error(e?.response?.data?.message || '帖子不存在或已被删除')
      }
    }
  } finally { loading.value = false }
}

const draftKey = computed(() => {
  if (!subject.value) return 'forum-post:unknown'
  const uid = user.current?.id || 0
  return `zhuiguang:forum:draft:${subject.value.id}:${uid}:${isEdit.value ? 'edit:' + editId.value : 'new'}`
})

const { lastSaved, hasDraft, restoreDraft, clear, saveNow: saveDraftNow } = useAutoSave({
  key: draftKey.value,
  sources: () => [postForm],
  debounce: AUTO_DEBOUNCE_MS,
  snapshot: () => ({
    title: postForm.value.title,
    topicIds: postForm.value.topicIds,
    recommendation: postForm.value.recommendation,
    content: postForm.value.content,
  }),
  restore: (d: any) => {
    postForm.value.title = d.title || ''
    postForm.value.topicIds = Array.isArray(d.topicIds) ? d.topicIds : []
    postForm.value.recommendation = d.recommendation || ''
    postForm.value.content = d.content || ''
  },
})

const lastSavedAt = computed(() => lastSaved.value)
const restored = ref(false)
const draftTimeText = computed(() => {
  if (!lastSaved.value) return ''
  const diff = Math.max(1, Math.round((Date.now() - lastSaved.value) / 1000))
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`
  return new Date(lastSaved.value).toLocaleString('zh-CN')
})

function tryRestoreDraft() {
  if (isEdit.value) {
    const ok = restoreDraft()
    if (ok) {
      restored.value = true
      ElMessageBox.confirm(
        '检测到未提交的草稿，是否恢复？（将覆盖当前编辑内容）',
        '恢复草稿',
        { confirmButtonText: '恢复', cancelButtonText: '放弃草稿' }
      ).then(() => { /* 已自动恢复 */ }).catch(() => { clear(); restored.value = false })
    }
    return
  }
  const ok = restoreDraft()
  if (ok) { restored.value = true; ElMessage.success('已恢复本地草稿') }
}

function clearDraftNow() {
  try { ElMessageBox.confirm('确认清除本地草稿？此操作不可恢复。', '清除草稿', { type: 'warning' }) } catch { return }
  clear()
  restored.value = false
  ElMessage.success('已清除草稿')
}
function saveNow() { saveDraftNow(); ElMessage.success('已保存草稿') }

async function submit() {
  if (!canSubmit.value) { ElMessage.warning('请填写标题与正文'); return }
  saving.value = true
  try {
    if (isEdit.value && editId.value) {
      await api.updateForumPost(subject.value.id, editId.value, { ...postForm.value })
      ElMessage.success('已保存')
      clear()
      router.push(`/subject/${subject.value.slug}/forum/post/${editId.value}`)
    } else {
      const r: any = await api.createForumPost(subject.value.id, { ...postForm.value })
      if (r?.autoApproved) ElMessage.success('已发布（自动免审）')
      else if (r?.status === 'pending') ElMessage.success('已提交审核')
      else ElMessage.success('已发布')
      clear()
      router.push(`/subject/${subject.value.slug}/forum/post/${r.id}`)
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '操作失败')
  } finally { saving.value = false }
}

function goBack() {
  if (subject.value) router.push(`/subject/${subject.value.slug}/forum`)
  else router.push('/subjects')
}

onMounted(async () => {
  await load()
  if (!permissionDenied.value) {
    nextTick(() => { tryRestoreDraft() })
  }
})
onBeforeUnmount(() => { try { saveDraftNow() } catch { /* */ } })
</script>

<style scoped>
.sfe-page { padding: 16px 0 64px; }
.sfe-top { display: flex; justify-content: space-between; align-items: center; max-width: 1280px; margin: 0 auto 12px; padding: 0 20px; }
.sfe-back { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--zg-text-sub); cursor: pointer; }
.sfe-back:hover { color: var(--zg-primary); }
.sfe-top-meta { font-size: 12px; color: var(--zg-text-sub); }
.sfe-draft { background: rgba(var(--zg-primary-rgb), 0.08); color: var(--zg-primary); padding: 4px 10px; border-radius: 999px; }
.sfe-draft.warn { background: rgba(245, 158, 11, 0.12); color: #B45309; }
.sfe-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 20px; max-width: 1280px; margin: 0 auto; padding: 0 20px; }
.sfe-main { padding: 24px 28px; border-radius: 18px; }
.sfe-title { font-size: 22px; font-weight: 800; margin: 0 0 14px; display: flex; align-items: center; gap: 8px; }
.sfe-row { margin-bottom: 12px; }
.sfe-row.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.sfe-foot { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 16px; padding-top: 12px; border-top: 1px dashed rgba(148, 163, 184, 0.3); }
.sfe-stats { font-size: 13px; color: var(--zg-text-sub); }
.ep-hint-auto { color: #047857; font-weight: 600; }
.ep-hint-pending { color: #B45309; font-weight: 600; }
.sfe-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.sfe-side { display: flex; flex-direction: column; gap: 16px; }
.sfe-side-card { padding: 16px 18px; border-radius: 16px; }
.sfe-side-title { font-size: 14px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 6px; }
.sfe-side-tip { font-size: 12px; color: var(--zg-text-sub); margin: 0 0 10px; line-height: 1.6; }
.sfe-topics-mini { display: flex; flex-wrap: wrap; gap: 6px; }
.sfe-topic-chip { padding: 4px 10px; font-size: 12px; border-radius: 999px; background: rgba(148, 163, 184, 0.15); color: var(--zg-text); cursor: pointer; border: 1px solid transparent; }
.sfe-topic-chip.on { background: var(--chip, var(--zg-primary)); color: #fff; border-color: var(--chip, var(--zg-primary)); }
.sfe-rules { margin: 0; padding-left: 0; list-style: none; font-size: 12px; color: var(--zg-text-sub); line-height: 1.9; }

@media (max-width: 980px) {
  .sfe-grid { grid-template-columns: 1fr; }
  .sfe-side { order: -1; flex-direction: row; flex-wrap: wrap; }
  .sfe-side-card { flex: 1 1 240px; }
}
@media (max-width: 640px) {
  .sfe-main { padding: 16px; }
  .sfe-row.two { grid-template-columns: 1fr; }
  .sfe-side { flex-direction: column; }
}
</style>
