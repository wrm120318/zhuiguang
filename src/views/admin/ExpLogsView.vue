<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()

const list = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(50)
const loading = ref(false)

// 搜索 / 筛选（客户端过滤当前页数据）
const search = ref('')
const actionFilter = ref('')

const ACTION_OPTIONS = [
  { value: '', label: '全部行为' },
  { value: 'login', label: '每日登录' },
  { value: 'register', label: '注册奖励' },
  { value: 'article', label: '发布美文' },
  { value: 'resource', label: '上传资料' },
  { value: 'query', label: '完成查询' },
  { value: 'quiz_pass', label: '题库自测' },
  { value: 'blog', label: '发布博客' },
  { value: 'comment', label: '收到评论' },
  { value: 'like', label: '收到点赞' },
  { value: 'favorite', label: '被收藏' },
  { value: 'practice_pass', label: '单题训练' },
  { value: 'announcement_read', label: '阅读公告' },
  { value: 'message_reply', label: '回复站内信' },
  { value: 'article_delete', label: '删除美文' },
  { value: 'resource_delete', label: '删除资料' },
  { value: 'blog_delete', label: '删除博客' },
  { value: 'query_delete', label: '删除查询' },
  { value: 'comment_delete', label: '删除评论' },
  { value: 'like_cancel', label: '取消点赞' },
  { value: 'favorite_cancel', label: '取消收藏' },
  { value: 'quiz_fail', label: '自测未通过' },
  { value: 'practice_fail', label: '训练未通过' },
  { value: 'admin_adjust', label: '管理员调整' },
]

const ACTION_LABELS: Record<string, string> = Object.fromEntries(
  ACTION_OPTIONS.filter(o => o.value).map(o => [o.value, o.label])
)

function actionLabel(t: string) {
  return ACTION_LABELS[t] || t
}

// 统计当前页净经验变动
const pageNetExp = computed(() =>
  list.value.reduce((s: number, it: any) => s + Number(it.exp_change || 0), 0)
)

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  const a = actionFilter.value
  return list.value.filter((it: any) => {
    if (a && it.action_type !== a) return false
    if (q) {
      const name = (it.real_name || '').toLowerCase()
      const uname = (it.username || '').toLowerCase()
      if (!name.includes(q) && !uname.includes(q)) return false
    }
    return true
  })
})

async function load() {
  loading.value = true
  try {
    const r: any = await api.allExpLogs(page.value, pageSize.value)
    list.value = r.list || []
    total.value = r.total || 0
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载经验记录失败')
  } finally {
    loading.value = false
  }
}

function onPageChange(p: number) {
  page.value = p
  load()
}

function onSizeChange(s: number) {
  pageSize.value = s
  page.value = 1
  load()
}

function resetFilter() {
  search.value = ''
  actionFilter.value = ''
}

function roleLabel(r: string) {
  return r === 'SUPER_ADMIN' ? '超管' : r === 'TEACHER' ? '教师' : '学生'
}

function roleType(r: string): 'danger' | 'warning' | 'info' {
  return r === 'SUPER_ADMIN' ? 'danger' : r === 'TEACHER' ? 'warning' : 'info'
}

function expColor(v: number) {
  if (v > 0) return '#16a34a'
  if (v < 0) return '#dc2626'
  return 'var(--zg-text-dim)'
}

function expText(v: number) {
  if (v > 0) return `+${v}`
  return `${v}`
}

function fmtTime(t: string) {
  if (!t) return '-'
  return String(t).replace('T', ' ').slice(0, 19)
}

function onAvatarError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.visibility = 'hidden'
}

onMounted(load)
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title">📋 经验记录</h1>
        <p class="dh-sub">查看全部用户的经验值变动明细，共 {{ total }} 条记录。</p>
      </div>
      <div class="head-actions">
        <el-button @click="router.push({ name: 'admin-dashboard' })">← 返回</el-button>
        <el-button type="primary" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="glass filter-bar">
      <el-input
        v-model="search"
        placeholder="搜索用户姓名 / 用户名"
        clearable
        class="fb-search"
      >
        <template #prefix><span>🔍</span></template>
      </el-input>
      <el-select v-model="actionFilter" placeholder="行为类型" clearable class="fb-action">
        <el-option
          v-for="o in ACTION_OPTIONS"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>
      <el-button v-if="search || actionFilter" text @click="resetFilter">清除筛选</el-button>
      <div class="fb-stat">
        <span class="fb-stat-label">本页净变动</span>
        <span class="fb-stat-val" :style="{ color: expColor(pageNetExp) }">{{ expText(pageNetExp) }}</span>
      </div>
    </div>

    <div class="table-wrap glass">
      <el-table :data="filtered" style="width:100%" row-key="id" empty-text="暂无经验记录">
        <el-table-column label="用户" min-width="190">
          <template #default="{ row }">
            <div class="u-cell">
              <img
                v-if="row.avatar"
                :src="row.avatar"
                class="u-avatar"
                @error="onAvatarError"
              />
              <div v-else class="u-avatar u-avatar-ph">{{ (row.real_name || '?').slice(0, 1) }}</div>
              <div class="u-info">
                <div class="u-name">{{ row.real_name || '-' }}</div>
                <div class="u-id">
                  @{{ row.username }}
                  <el-tag size="small" :type="roleType(row.role)" class="u-role">{{ roleLabel(row.role) }}</el-tag>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="行为类型" width="140">
          <template #default="{ row }">
            <el-tag size="small" effect="plain" class="action-tag">{{ actionLabel(row.action_type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="经验变动" width="110" align="center">
          <template #default="{ row }">
            <span class="exp-val" :style="{ color: expColor(Number(row.exp_change)) }">
              {{ expText(Number(row.exp_change)) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="描述" min-width="220">
          <template #default="{ row }">
            <span class="desc">{{ row.description || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span class="time">{{ fmtTime(row.created_at) }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="pager">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100, 200]"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
.dh-title { font-size:24px; font-weight:800; }
.dh-sub { font-size:13px; color:var(--zg-text-dim); margin-top:4px; }
.head-actions { display:flex; gap:10px; }

.filter-bar { display:flex; align-items:center; gap:12px; padding:14px 18px; margin-bottom:16px; flex-wrap:wrap; }
.fb-search { width:260px; }
.fb-action { width:180px; }
.fb-stat { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:var(--zg-fs-sm); }
.fb-stat-label { color:var(--zg-text-dim); }
.fb-stat-val { font-weight:800; font-size:16px; }

.table-wrap { padding:8px; overflow-x:auto; }

.u-cell { display:flex; align-items:center; gap:10px; }
.u-avatar { width:38px; height:38px; border-radius:50%; object-fit:cover; flex-shrink:0; background:rgba(245,158,11,.08); }
.u-avatar-ph { display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--zg-primary); font-size:16px; background:rgba(245,158,11,.12); }
.u-info { min-width:0; }
.u-name { font-weight:600; }
.u-id { font-size:12px; color:var(--zg-text-dim); display:flex; align-items:center; gap:6px; }
.u-role { transform:scale(.9); transform-origin:left center; }

.action-tag { border-color:rgba(245,158,11,.3); color:var(--zg-text-dim); }
.exp-val { font-weight:800; font-size:15px; }
.desc { font-size:var(--zg-fs-sm); color:var(--zg-text); word-break:break-word; }
.time { font-size:12px; color:var(--zg-text-dim); white-space:nowrap; }

.pager { display:flex; justify-content:flex-end; margin-top:18px; flex-wrap:wrap; }

@media (max-width: 768px) {
  .dh-title { font-size:20px; }
  .head { margin-bottom:14px; }
  .head-actions { width:100%; }
  .filter-bar { padding:12px; gap:10px; }
  .fb-search { width:100%; }
  .fb-action { width:100%; }
  .fb-stat { margin-left:0; width:100%; justify-content:flex-end; }
  .table-wrap { padding:6px; }
  .u-avatar { width:32px; height:32px; }
  .u-name { font-size:13px; }
  .u-id { font-size:11px; }
  .exp-val { font-size:14px; }
  .pager { justify-content:center; margin-top:14px; }
}

@media (min-width: 1200px) {
  .dh-title { font-size:28px; }
  .head { margin-bottom:28px; }
  .table-wrap { padding:12px; }
  .filter-bar { padding:16px 22px; margin-bottom:20px; }
}

:deep(.el-table .cell) { padding:8px 0; font-size:13px; }
:deep(.el-table th .cell) { color:var(--zg-text-dim); font-weight:600; }
@media (min-width: 1200px) {
  :deep(.el-table .cell) { padding:14px 0; font-size:15px; }
}
</style>
