<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const list = ref<any[]>([])
const loading = ref(false)
const filter = ref<'all' | 'site' | 'class'>('all')

async function load() {
  loading.value = true
  try { list.value = (await api.announcements()) as any } finally { loading.value = false }
}
onMounted(load)

const filtered = computed(() => {
  if (filter.value === 'all') return list.value
  return list.value.filter(a => a.scope === filter.value)
})

function scopeLabel(a: any) {
  if (a.scope === 'site') return '全站公告'
  const cn = data.classById(a.class_id)?.name || '班级'
  return `班级公告 · ${cn}`
}
function scopeType(a: any) { return a.scope === 'site' ? 'success' : 'warning' }
function canPost() { return user.isSuperAdmin || user.isTeacher }
function excerpt(html: string) {
  const text = (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return text.length > 120 ? text.slice(0, 120) + '…' : text
}

// 需求2：超管切换置顶
async function togglePin(a: any, e: Event) {
  e.stopPropagation()
  if (!user.isSuperAdmin) return
  try {
    if (a.pinned) {
      await ElMessageBox.confirm('取消置顶该公告？', '确认', { type: 'warning' })
      await api.pinPage(a.id, false)
      a.pinned = 0; a.pinned_scope = 'none'
    } else {
      const scope = a.scope // 跟随公告的scope
      await api.pinPage(a.id, true, scope)
      a.pinned = 1; a.pinned_scope = scope
    }
    ElMessage.success(a.pinned ? '已置顶' : '已取消置顶')
  } catch {}
}

async function deleteAnn(a: any, e: Event) {
  e.stopPropagation()
  try {
    await ElMessageBox.confirm(`确定删除公告「${a.title}」？此操作不可恢复。`, '删除', { type: 'error' })
    await api.deletePage(a.id)
    list.value = list.value.filter(x => x.id !== a.id)
    ElMessage.success('已删除')
  } catch {}
}
</script>

<template>
  <div class="page zg-container">
    <div class="head">
      <h1 class="zg-page-title"><ZgGlyph emoji="📢" /> 网站公告</h1>
      <div class="head-actions">
        <el-radio-group v-model="filter" size="small">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="site">全站</el-radio-button>
          <el-radio-button value="class">班级</el-radio-button>
        </el-radio-group>
        <el-button v-if="canPost()" type="primary" round @click="router.push('/announcements/new')">+ 发布公告</el-button>
      </div>
    </div>

    <div v-loading="loading" class="list">
      <div v-for="a in filtered" :key="a.id" class="ann-card glass zg-card" :class="{ pinned: a.pinned }" @click="router.push(`/announcements/${a.id}`)">
        <div class="ac-head">
          <div class="ac-tags">
            <span v-if="a.pinned" class="pin-tag"><ZgGlyph emoji="📌" /> 置顶</span>
            <el-tag :type="scopeType(a)" size="small">{{ scopeLabel(a) }}</el-tag>
          </div>
          <div class="ac-actions" v-if="user.isSuperAdmin" @click.stop>
            <el-button size="small" :type="a.pinned?'warning':'primary'" plain @click="togglePin(a, $event)">
              {{ a.pinned ? '取消置顶' : '置顶' }}
            </el-button>
            <el-button size="small" type="danger" plain @click="deleteAnn(a, $event)">删除</el-button>
          </div>
          <span class="ac-time">{{ a.created_at?.slice(0, 16) }}</span>
        </div>
        <div class="ac-title">{{ a.title }}</div>
        <div class="ac-excerpt">{{ excerpt(a.content) }}</div>
        <div class="ac-meta">
          <span><ZgGlyph emoji="👤" /> {{ a.author_name }}</span>
          <span><ZgGlyph emoji="👁" /> {{ a.views }}</span>
        </div>
      </div>
      <ZgState v-if="!loading && !filtered.length" type="empty" title="暂无公告" desc="新的通知发布后会第一时间出现在这里。" />
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; flex-wrap: wrap; gap: 12px; }
.zg-page-title { font-size: 26px; font-weight: 800; }
.head-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.list { display: flex; flex-direction: column; gap: 12px; }
.ann-card { padding: 18px 20px; cursor: pointer; transition: all .2s; }
.ann-card:hover { transform: translateY(-2px); }
.ac-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--zg-text-dim); }
.ac-title { font-size: 17px; font-weight: 700; }
.ac-excerpt { color: var(--zg-text-dim); font-size: 13px; line-height: 1.6; margin: 8px 0 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ac-meta { display: flex; gap: 12px; font-size: 12px; color: var(--zg-text-dim); }
.ac-head { flex-wrap: wrap; align-items: center; gap: 10px; }
.ac-tags { display: flex; gap: 6px; align-items: center; }
.pin-tag { background: linear-gradient(135deg,#ef4444,#f97316); color:#fff; padding:2px 10px; border-radius:10px; font-size:11px; font-weight:700; }
.ann-card.pinned { border: 2px solid rgba(239,68,68,.35); background: rgba(239,68,68,.04); position:relative; overflow:hidden; }
.ann-card.pinned::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; background:linear-gradient(90deg,#ef4444,#f97316,var(--zg-primary)); }
.ac-actions { display: flex; gap: 6px; }
@media (max-width: 768px) { .zg-page-title { font-size: 22px; } }
</style>
