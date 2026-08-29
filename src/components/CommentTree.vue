<script setup lang="ts">
/**
 * CommentTree 公共评论树组件
 * 支持朋友圈式折叠树子评论（v4.2.0）
 *
 * Props:
 *   comments: Comment[]                 后端原始评论列表（含 parent_id）
 *   currentUser: { id, isSuperAdmin, avatar, ... } | null
 *   canDelete: (c: Comment) => boolean  判断当前用户能否删某条评论
 *   onSubmit: (content: string, parentId: number | null) => Promise<void>
 *   onDelete: (commentId: number) => Promise<void>
 *   emptyText: string                   没评论时的占位文案
 */
import { ref, computed, nextTick } from 'vue'
import { ElMessage } from 'element-plus'

interface Comment {
  id: number
  parent_id: number | null
  user_id: number
  user_name: string
  avatar: string
  content: string
  created_at: string
  children?: Comment[]
}

const props = withDefaults(defineProps<{
  comments: Comment[]
  currentUser: any
  canDelete: (c: Comment) => boolean
  onSubmit: (content: string, parentId: number | null) => Promise<void>
  onDelete: (commentId: number) => Promise<void>
  emptyText?: string
  titleEmoji?: string
}>(), {
  emptyText: '还没有评论，来抢沙发吧～',
  titleEmoji: '💬',
})

// 1. 把扁平列表转成主评论 + 嵌套 children
const topLevel = computed(() => {
  const all = props.comments || []
  const map = new Map<number, Comment>()
  all.forEach(c => map.set(c.id, { ...c, children: [] }))
  const roots: Comment[] = []
  for (const c of map.values()) {
    if (c.parent_id == null) {
      roots.push(c)
    } else {
      const parent = map.get(c.parent_id)
      if (parent) parent.children!.push(c)
      else roots.push(c)  // 父评论不存在（孤儿）→ 当顶级
    }
  }
  // 主评论按 id 倒序（新→旧）；子评论按 id 升序（旧→新，对话感更自然）
  roots.sort((a, b) => b.id - a.id)
  for (const r of roots) r.children!.sort((a: any, b: any) => a.id - b.id)
  return roots
})

const totalCount = computed(() => (props.comments || []).length)

// 2. 主评论输入框
const topText = ref('')
const sendingTop = ref(false)
async function submitTop() {
  const text = topText.value.trim()
  if (!text || sendingTop.value) return
  sendingTop.value = true
  // 【v4.2.4 体验修复】乐观插入：先把评论加到列表给即时反馈，
  //   失败时由父组件 throw 让这里不进 finally 清空逻辑前的 catch 分支
  //   —— 这样用户能看到自己写的字出现在列表里，无需刷新
  const cached = topText.value
  topText.value = ''
  try {
    await props.onSubmit(text, null)
  } catch (e) {
    // 发送失败：恢复输入框内容
    topText.value = cached
    throw e
  } finally { sendingTop.value = false }
}

// 3. 子评论：点"回复" → 就地展开输入框 + 默认 placeholder 带被回复人
const activeReply = ref<number | null>(null)  // 当前打开回复输入框的父评论 id
const replyText = ref('')
const replyToName = ref('')
const sendingReply = ref(false)
const replyInputRefs = ref<Record<number, any>>({})

function startReply(parent: Comment) {
  activeReply.value = parent.id
  replyText.value = ''
  replyToName.value = parent.user_name
  // 自动聚焦
  nextTick(() => {
    const inst = replyInputRefs.value[parent.id]
    if (inst && inst.focus) inst.focus()
  })
}
function cancelReply() {
  activeReply.value = null
  replyText.value = ''
}
async function submitReply(parentId: number) {
  const text = replyText.value.trim()
  if (!text || sendingReply.value) return
  sendingReply.value = true
  // 【v4.2.4 体验修复】失败时恢复输入框内容（见 submitTop 同款）
  const cached = replyText.value
  replyText.value = ''
  try {
    await props.onSubmit(text, parentId)
    activeReply.value = null
  } catch (e) {
    replyText.value = cached
    throw e
  } finally { sendingReply.value = false }
}

// 4. 折叠状态：默认收起
const expanded = ref<Set<number>>(new Set())
function toggleExpand(parentId: number) {
  if (expanded.value.has(parentId)) expanded.value.delete(parentId)
  else expanded.value.add(parentId)
  // 触发响应式
  expanded.value = new Set(expanded.value)
}

// 5. 删除
async function onDelete(c: Comment) {
  try {
    await props.onDelete(c.id)
  } catch { /* 父级已 ElMessage 报错 */ }
}

function setReplyRef(el: any, id: number) {
  if (el) replyInputRefs.value[id] = el
}

function isLogin() { return !!props.currentUser?.id }
function warnLogin() { ElMessage.warning('请先登录') }
</script>

<template>
  <div class="ct-root" id="comment-area">
    <!-- 标题 + 计数 -->
    <div class="ct-title">
      <span>{{ titleEmoji }}</span> 评论 ({{ totalCount }})
    </div>

    <!-- 主评论输入框 -->
    <div v-if="isLogin()" class="ct-input-row">
      <img v-if="currentUser?.avatar" :src="currentUser.avatar" class="ct-avatar" />
      <div v-else class="ct-avatar ct-avatar-fallback">{{ (currentUser?.real_name || '我').slice(0, 1) }}</div>
      <el-input
        v-model="topText"
        placeholder="写下你的评论…"
        :maxlength="500"
        show-word-limit
        @keydown.enter.exact="submitTop"
      />
      <el-button
        type="primary"
        :loading="sendingTop"
        :disabled="!topText.trim()"
        @click="submitTop"
      >发布</el-button>
    </div>
    <div v-else class="ct-login-tip" @click="warnLogin">登录后参与评论</div>

    <!-- 评论列表 -->
    <div v-if="topLevel.length" class="ct-list">
      <div v-for="c in topLevel" :key="c.id" :id="`comment-${c.id}`" class="ct-item">
        <img :src="c.avatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'" class="ct-avatar" />
        <div class="ct-body">
          <div class="ct-head">
            <span class="ct-name">{{ c.user_name }}</span>
            <span class="ct-time">{{ (c.created_at || '').slice(0, 16) }}</span>
            <el-button
              v-if="canDelete(c)"
              size="small"
              text
              type="danger"
              class="ct-del"
              @click="onDelete(c)"
            >删除</el-button>
          </div>
          <div class="ct-text">{{ c.content }}</div>

          <!-- 操作行：回复 + 收起/展开条数 -->
          <div class="ct-actions">
            <el-button v-if="isLogin()" size="small" text @click="startReply(c)">
              <span>💬</span> 回复
            </el-button>
            <el-button
              v-if="c.children && c.children.length"
              size="small"
              text
              type="primary"
              @click="toggleExpand(c.id)"
            >
              {{ expanded.has(c.id) ? '收起' : `展开 ${c.children.length} 条回复` }}
              <span :class="['ct-arrow', { open: expanded.has(c.id) }]">▸</span>
            </el-button>
          </div>

          <!-- 子评论区（折叠） -->
          <div v-if="c.children && c.children.length && expanded.has(c.id)" class="ct-children">
            <div v-for="ch in c.children" :key="ch.id" :id="`comment-${ch.id}`" class="ct-child">
              <img :src="ch.avatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=zg'" class="ct-avatar ct-avatar-sm" />
              <div class="ct-body">
                <div class="ct-head">
                  <span class="ct-name">{{ ch.user_name }}</span>
                  <span class="ct-time">{{ (ch.created_at || '').slice(0, 16) }}</span>
                  <el-button
                    v-if="canDelete(ch)"
                    size="small"
                    text
                    type="danger"
                    class="ct-del"
                    @click="onDelete(ch)"
                  >删除</el-button>
                </div>
                <div class="ct-text">
                  <span v-if="ch.user_name" class="ct-text-user">{{ ch.user_name }}</span>
                  ：{{ ch.content }}
                </div>
                <div class="ct-actions">
                  <el-button v-if="isLogin()" size="small" text @click="startReply(c)">
                    <span>↩</span> 回复
                  </el-button>
                </div>
              </div>
            </div>
          </div>

          <!-- 子评论输入框（就地展开） -->
          <div v-if="activeReply === c.id" class="ct-reply-input">
            <div class="ct-reply-tip">
              回复 <b>@{{ replyToName }}</b>
              <span class="ct-reply-cancel" @click="cancelReply">取消</span>
            </div>
            <el-input
              :ref="(el: any) => setReplyRef(el, c.id)"
              v-model="replyText"
              type="textarea"
              :rows="2"
              :maxlength="500"
              show-word-limit
              :placeholder="`回复 @${replyToName}…`"
              @keydown.ctrl.enter="submitReply(c.id)"
            />
            <div class="ct-reply-foot">
              <span class="ct-reply-hint">Ctrl+Enter 发送</span>
              <el-button
                type="primary"
                size="small"
                :loading="sendingReply"
                :disabled="!replyText.trim()"
                @click="submitReply(c.id)"
              >发送</el-button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="ct-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.ct-root { display: flex; flex-direction: column; gap: 16px; }
.ct-title { font-size: 16px; font-weight: 700; }
.ct-input-row { display: flex; gap: 10px; align-items: center; }
.ct-avatar { width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; object-fit: cover; background: #e2e8f0; }
.ct-avatar-sm { width: 28px; height: 28px; }
.ct-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; color: #fff; background: linear-gradient(135deg, #6366f1, #8b5cf6); font-weight: 600; }
.ct-login-tip { padding: 16px; text-align: center; color: var(--zg-text-dim, #94a3b8); cursor: pointer; border: 1px dashed rgba(148, 163, 184, 0.3); border-radius: 10px; }
.ct-list { display: flex; flex-direction: column; gap: 18px; }
.ct-item { display: flex; gap: 12px; }
.ct-body { flex: 1; min-width: 0; }
.ct-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ct-name { font-weight: 600; font-size: 14px; color: var(--zg-text, #1e293b); }
.ct-time { font-size: 11px; color: var(--zg-text-dim, #94a3b8); }
.ct-del { margin-left: auto; }
.ct-text { font-size: 14px; line-height: 1.65; color: var(--zg-text, #1e293b); margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
.ct-text-user { color: var(--zg-primary, #6366f1); font-weight: 600; }
.ct-actions { margin-top: 4px; display: flex; gap: 4px; align-items: center; }
.ct-arrow { display: inline-block; transition: transform 0.2s; margin-left: 2px; }
.ct-arrow.open { transform: rotate(90deg); }
.ct-children { margin-top: 10px; padding: 10px 12px; background: rgba(var(--zg-primary-rgb, 99 102 241), 0.04); border-radius: 10px; display: flex; flex-direction: column; gap: 12px; }
.ct-child { display: flex; gap: 10px; }
.ct-reply-input { margin-top: 10px; padding: 12px; background: rgba(var(--zg-primary-rgb, 99 102 241), 0.05); border-radius: 10px; border: 1px dashed rgba(var(--zg-primary-rgb, 99 102 241), 0.3); }
.ct-reply-tip { font-size: 12px; color: var(--zg-text-dim, #94a3b8); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
.ct-reply-cancel { color: var(--zg-primary, #6366f1); cursor: pointer; }
.ct-reply-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
.ct-reply-hint { font-size: 11px; color: var(--zg-text-dim, #94a3b8); }
.ct-empty { text-align: center; padding: 32px 20px; color: var(--zg-text-dim, #94a3b8); font-size: 14px; }
</style>
