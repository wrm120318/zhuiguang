<script setup lang="ts">
import { ref, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const route = useRoute()
const router = useRouter()
const user = useUserStore()

const sessions = ref<any[]>([])
const allUsers = ref<any[]>([]) // 超管可监督的全部用户
const contacts = ref<any[]>([]) // 可发消息的对象
const activePeer = ref<any>(null)
const messages = ref<any[]>([])
const inputText = ref('')
const sending = ref(false)
const loading = ref(false)
const readingAll = ref(false)
const chatBox = ref<HTMLElement | null>(null)

function attachInfo(m: any) {
  const act = (m.attachments || []).find((a: any) => a.type === 'action' && a.articleId)
  return { hasApprove: !!act, articleId: act?.articleId }
}
function goApprove(articleId: number) { router.push('/profile') }

// 超管监督模式：选择任意两人查看对话
const adminMode = ref(false)
const adminA = ref<number | null>(null)
const adminB = ref<number | null>(null)

async function loadSessions() {
  const r: any = await api.messageSessions()
  sessions.value = r.sessions || []
  if (r.allUsers) allUsers.value = r.allUsers
  // 可发对象：全部活跃用户（超管与普通用户均可主动发起新会话）
  contacts.value = r.allUsers || sessions.value.map(s => s.peer).filter(Boolean)
}

async function readAllMessages() {
  readingAll.value = true
  try {
    await api.readAllMessages()
    sessions.value.forEach((s: any) => { s.unread = 0 })
    window.dispatchEvent(new Event('messages-read'))
    ElMessage.success('已全部标记为已读')
  } catch { ElMessage.error('操作失败，请重试') }
  finally { readingAll.value = false }
}

async function openPeer(peerId: number) {
  if (!peerId) return
  activePeer.value = await findUser(peerId)
  adminMode.value = false
  loading.value = true
  try {
    messages.value = (await api.messageThread(peerId)) as any
    await nextTick()
    scrollBottom()
    // 后端已标记为已读，通知导航栏刷新未读数
    window.dispatchEvent(new Event('messages-read'))
    await loadSessions()
  } finally { loading.value = false }
}

async function findUser(id: number) {
  const pool = [...allUsers.value, ...contacts.value, ...sessions.value.map(s => s.peer)]
  let u = pool.find(x => x?.id === id)
  if (!u) {
    try { const r: any = await api.messageSessions(); u = (r.allUsers || []).find((x: any) => x.id === id) || sessions.value.find(s => s.peer?.id === id)?.peer } catch { /* */ }
  }
  return u || { id, real_name: `用户${id}`, role: 'STUDENT', avatar: '' }
}

async function send() {
  if (!inputText.value.trim() || !activePeer.value) return
  sending.value = true
  const content = inputText.value
  inputText.value = ''
  try {
    await api.sendMessage(activePeer.value.id, content)
    messages.value.push({ from_id: user.current?.id, to_id: activePeer.value.id, content, created_at: nowStr(), attachments: [] })
    await nextTick()
    scrollBottom()
    await loadSessions()
  } catch { inputText.value = content } finally { sending.value = false }
}

function scrollBottom() {
  if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight
}

function nowStr() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function timeShort(s: string) { return s?.slice(5, 16) || '' }
function peerName(p: any) { return p?.real_name || `用户${p?.id}` }

// 超管监督：查任意两人对话
async function adminView() {
  if (!adminA.value || !adminB.value) { ElMessage.warning('请选择两个用户'); return }
  activePeer.value = null
  adminMode.value = true
  loading.value = true
  try { messages.value = (await api.messageAll(adminA.value, adminB.value)) as any; await nextTick(); scrollBottom() }
  finally { loading.value = false }
}

function isAdminMine(m: any) {
  if (!adminMode.value) return m.from_id === user.current?.id
  return false
}

onMounted(async () => {
  await loadSessions()
  const pid = Number(route.params.peerId)
  if (pid) await openPeer(pid)
})

watch(() => route.params.peerId, async (pid) => {
  if (pid && Number(pid) !== activePeer.value?.id) await openPeer(Number(pid))
})
</script>

<template>
  <div class="page zg-container msg-page">
    <h1 class="zg-page-title"><ZgGlyph emoji="✉️" /> 站内信</h1>

    <div class="msg-layout">
      <!-- 左侧：会话列表 / 联系人 -->
      <aside class="sidebar glass">
        <div class="sb-title">会话<el-button v-if="sessions.some((s:any)=>s.unread)" size="small" text type="primary" style="margin-left:auto" :loading="readingAll" @click="readAllMessages">全部已读</el-button></div>
        <div class="sb-list">
          <div v-for="s in sessions" :key="s.peer?.id" class="sb-item" :class="{ on: activePeer?.id === s.peer?.id && !adminMode }" @click="openPeer(s.peer.id)">
            <img :src="s.peer?.avatar" class="si-avatar" />
            <div class="si-body">
              <div class="si-name">{{ peerName(s.peer) }}
                <el-tag size="small" :type="s.peer?.role === 'SUPER_ADMIN' ? 'danger' : s.peer?.role === 'TEACHER' ? 'warning' : 'info'">
                  {{ s.peer?.role === 'SUPER_ADMIN' ? '超管' : s.peer?.role === 'TEACHER' ? '教师' : '学生' }}
                </el-tag>
              </div>
              <div class="si-last">{{ (s.content || '').replace(/<[^>]+>/g, '').slice(0, 24) }}</div>
            </div>
            <span v-if="s.unread" class="si-badge">{{ s.unread }}</span>
          </div>
          <el-empty v-if="!sessions.length" description="暂无会话" :image-size="60" />
        </div>

        <!-- 发起新会话 -->
        <div class="sb-new">
          <el-select filterable placeholder="发消息给…" size="small" @change="(v: any) => openPeer(v)">
            <el-option v-for="c in contacts" :key="c.id" :label="c.real_name + (c.role === 'TEACHER' ? '（教师）' : c.role === 'SUPER_ADMIN' ? '（超管）' : '')" :value="c.id" />
          </el-select>
        </div>
      </aside>

      <!-- 右侧：聊天区 -->
      <main class="chat glass-strong">
        <template v-if="activePeer && !adminMode">
          <div class="chat-head">
            <img :src="activePeer.avatar" class="ch-avatar" />
            <div>
              <div class="ch-name">{{ peerName(activePeer) }}</div>
              <div class="ch-role">{{ activePeer.role === 'SUPER_ADMIN' ? '超级管理员' : activePeer.role === 'TEACHER' ? '学科教师' : '学生' }}</div>
            </div>
          </div>
          <div ref="chatBox" class="chat-body" v-loading="loading">
            <div v-for="m in messages" :key="m.id" class="msg-row" :class="{ mine: m.from_id === user.current?.id }">
              <div class="msg-bubble"><div class="msg-content" v-html="m.content"></div>
                <el-button v-if="attachInfo(m).hasApprove" type="primary" size="small" @click="goApprove(attachInfo(m).articleId)">前去确认美文</el-button>
              </div>
              <div class="msg-time">{{ timeShort(m.created_at) }}</div>
            </div>
            <el-empty v-if="!loading && !messages.length" description="还没有消息，发条招呼吧～" :image-size="80" />
          </div>
          <div class="chat-input">
            <el-input v-model="inputText" type="textarea" :rows="2" placeholder="输入消息…" resize="none" @keydown.enter.exact.prevent="send" />
            <el-button type="primary" :loading="sending" @click="send">发送</el-button>
          </div>
        </template>

        <!-- 超管监督模式 -->
        <template v-else-if="user.isSuperAdmin">
          <div class="admin-bar">
            <div class="ab-title"><ZgGlyph emoji="🔍" /> 超管监督 · 查看任意两人对话</div>
            <div class="ab-row">
              <el-select v-model="adminA" filterable placeholder="用户A" size="small" style="width:160px">
                <el-option v-for="u in allUsers" :key="u.id" :label="u.real_name" :value="u.id" />
              </el-select>
              <span><ZgGlyph emoji="⇄" /></span>
              <el-select v-model="adminB" filterable placeholder="用户B" size="small" style="width:160px">
                <el-option v-for="u in allUsers" :key="u.id" :label="u.real_name" :value="u.id" />
              </el-select>
              <el-button type="primary" size="small" @click="adminView">查看</el-button>
            </div>
          </div>
          <div ref="chatBox" class="chat-body" v-loading="loading">
            <template v-if="adminMode">
              <div v-for="m in messages" :key="m.id" class="msg-row" :class="{ mine: isAdminMine(m) }">
                <div class="msg-bubble">
                  <span class="msg-from">{{ m.from_id === adminA ? 'A' : 'B' }}：</span><div class="msg-content" v-html="m.content" style="display:inline"></div>
                  <el-button v-if="attachInfo(m).hasApprove" type="primary" size="small" @click="goApprove(attachInfo(m).articleId)">前去确认美文</el-button>
                </div>
                <div class="msg-time">{{ timeShort(m.created_at) }}</div>
              </div>
              <el-empty v-if="!loading && !messages.length" description="选择两个用户查看他们的对话" :image-size="80" />
            </template>
            <el-empty v-else description="使用上方选择两位用户，查看他们的全部聊天记录" :image-size="100" />
          </div>
        </template>

        <el-empty v-else description="选择左侧联系人开始聊天" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.msg-page { padding-bottom: 20px; }
.zg-page-title { font-size: 24px; font-weight: 800; margin: 16px 0; }
.msg-layout { display: flex; gap: 14px; height: calc(100vh - 200px); height: calc(100dvh - 200px); min-height: 480px; }
.sidebar { width: 280px; display: flex; flex-direction: column; padding: 14px; }
.sb-title { font-weight: 700; font-size: 14px; margin-bottom: 10px; color: var(--zg-text-dim); }
.sb-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.sb-item { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 10px; cursor: pointer; transition: background .2s; position: relative; }
.sb-item:hover { background: rgba(var(--zg-primary-rgb),.08); }
.sb-item.on { background: rgba(var(--zg-primary-rgb),.18); }
.si-avatar { width: 38px; height: 38px; border-radius: 50%; }
.si-body { flex: 1; min-width: 0; }
.si-name { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.si-last { font-size: 12px; color: var(--zg-text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.si-badge { position: absolute; top: 6px; right: 8px; background: #ef4444; color: #fff; font-size: 10px; min-width: 16px; height: 16px; border-radius: 8px; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
.sb-new { padding-top: 10px; border-top: 1px dashed rgba(var(--zg-primary-rgb),.15); margin-top: 8px; }

.chat { flex: 1; display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.chat-head { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid rgba(var(--zg-primary-rgb),.1); }
.ch-avatar { width: 42px; height: 42px; border-radius: 50%; }
.ch-name { font-weight: 700; font-size: 15px; }
.ch-role { font-size: 12px; color: var(--zg-text-dim); }
.chat-body { flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
.msg-row { display: flex; flex-direction: column; align-items: flex-start; max-width: 70%; }
.msg-row.mine { align-items: flex-end; margin-left: auto; }
.msg-bubble { padding: 10px 14px; border-radius: 14px 14px 14px 4px; background: rgba(var(--zg-primary-rgb),.1); font-size: 14px; line-height: 1.5; word-break: break-word; }
.msg-row.mine .msg-bubble { background: var(--zg-primary); color: #fff; border-radius: 14px 14px 4px 14px; }
.msg-content :deep(p) { margin: 4px 0; }
.msg-content :deep(b) { color: var(--zg-primary); }
.msg-row.mine .msg-content :deep(b) { color: #fff8e1; }
.msg-time { font-size: 11px; color: var(--zg-text-dim); margin-top: 4px; }
.msg-from { font-weight: 700; margin-right: 4px; }
.chat-input { display: flex; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(var(--zg-primary-rgb),.1); align-items: flex-end; }
.chat-input .el-button { height: 40px; }

.admin-bar { padding: 14px 18px; border-bottom: 1px solid rgba(var(--zg-primary-rgb),.1); background: rgba(239,68,68,.05); }
.ab-title { font-weight: 700; font-size: 13px; color: #dc2626; margin-bottom: 8px; }
.ab-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .msg-layout { flex-direction: column; height: auto; min-height: 0; }
  .sidebar { width: 100%; max-height: 240px; }
  .chat { min-height: 400px; }
}
</style>
