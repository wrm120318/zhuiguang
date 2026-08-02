<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { levelFromExp, expToNextLevel } from '@/utils/helpers'

const router = useRouter()
const user = useUserStore()
const expLogs = ref<any[]>([])
const myArticles = ref<any[]>([])
const editing = ref(false)
const form = ref({ realName: '', email: '', phone: '', avatar: '' })

async function load() {
  try {
    expLogs.value = (await api.expLogs()) as any
  } catch { /* */ }
  try {
    const all = (await api.articles({ author: user.current?.username, limit: 10 })) as any
    myArticles.value = all
  } catch { /* */ }
}
onMounted(async () => {
  await user.fetchProfile()
  form.value = { realName: user.current?.realName || '', email: user.current?.email || '', phone: user.current?.phone || '', avatar: user.current?.avatar || '' }
  await load()
})

async function saveProfile() {
  try {
    await user.updateProfile(form.value)
    ElMessage.success('保存成功')
    editing.value = false
  } catch (e: any) { ElMessage.error('保存失败') }
}

const expProgress = ref(0)
function calcProgress() {
  if (!user.current?.exp) return 0
  const cur = user.current.exp
  const need = expToNextLevel(cur)
  const levelBase = (levelFromExp(cur) - 1) * 100
  return Math.min(100, ((cur - levelBase) / (need - levelBase)) * 100)
}
onMounted(() => { expProgress.value = calcProgress() })
</script>

<template>
  <div class="page zg-container" v-if="user.current">
    <!-- 个人信息卡 -->
    <div class="profile-hero glass-strong zg-slide-up">
      <div class="ph-bg"></div>
      <div class="ph-content">
        <div class="ph-avatar-wrap">
          <img :src="user.current.avatar" class="ph-avatar" />
          <div class="ph-level-badge">Lv.{{ user.current.level }}</div>
        </div>
        <div class="ph-info">
          <div class="ph-name-row">
            <h1 class="ph-name">{{ user.current.realName }}</h1>
            <span class="ph-role">{{ user.current.role === 'SUPER_ADMIN' ? '超级管理员' : user.current.role === 'TEACHER' ? '教师' : '学生' }}</span>
          </div>
          <div class="ph-contact">
            <span v-if="user.current.email">📧 {{ user.current.email }}</span>
            <span v-if="user.current.phone">📱 {{ user.current.phone }}</span>
          </div>
          <div class="ph-exp-bar">
            <div class="ph-exp-fill" :style="{ width: calcProgress() + '%' }"></div>
          </div>
          <div class="ph-exp-text">{{ user.current.exp }} EXP · 距下一级 {{ expToNextLevel(user.current.exp) - user.current.exp }} EXP</div>
        </div>
        <el-button text circle class="ph-edit" @click="editing = true">✏️</el-button>
      </div>
    </div>

    <!-- 数据概览 -->
    <div class="stat-grid">
      <div class="stat-card glass zg-card">
        <div class="stat-icon" style="background:linear-gradient(135deg,#FBBF24,#F59E0B)">📝</div>
        <div class="stat-info"><div class="stat-num">{{ myArticles.length }}</div><div class="stat-label">我的美文</div></div>
      </div>
      <div class="stat-card glass zg-card" @click="router.push('/favorites')">
        <div class="stat-icon" style="background:linear-gradient(135deg,#FB923C,#EF4444)">⭐</div>
        <div class="stat-info"><div class="stat-num">收藏</div><div class="stat-label">查看收藏</div></div>
      </div>
      <div class="stat-card glass zg-card" @click="router.push('/leaderboard')">
        <div class="stat-icon" style="background:linear-gradient(135deg,#FDE68A,#FBBF24)">🏆</div>
        <div class="stat-info"><div class="stat-num">排行</div><div class="stat-label">查看排名</div></div>
      </div>
    </div>

    <!-- 经验日志 -->
    <div class="section">
      <div class="section-title">经验记录</div>
      <div class="exp-list">
        <div v-for="log in expLogs.slice(0, 10)" :key="log.id" class="exp-item glass">
          <div class="ei-icon" :class="{ pos: log.change > 0, neg: log.change < 0 }">{{ log.change > 0 ? '+' : '' }}{{ log.change }}</div>
          <div class="ei-body">
            <div class="ei-desc">{{ log.description }}</div>
            <div class="ei-meta">{{ log.action_type }} · {{ log.created_at?.slice(0, 16) }}</div>
          </div>
        </div>
        <el-empty v-if="!expLogs.length" description="暂无经验记录" />
      </div>
    </div>

    <!-- 我的美文 -->
    <div class="section" v-if="myArticles.length">
      <div class="section-title">我的美文</div>
      <div class="my-art-list">
        <div v-for="a in myArticles" :key="a.id" class="my-art-item glass zg-card" @click="router.push(`/article/${a.id}`)">
          <div class="ma-title">{{ a.title }}</div>
          <div class="ma-meta">
            <span :class="['ma-status', a.status]">{{ a.status === 'approved' ? '已通过' : a.status === 'pending' ? '待审核' : '已驳回' }}</span>
            <span>❤ {{ a.likes || 0 }}</span>
            <span>{{ a.created_at?.slice(0, 10) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editing" title="编辑个人信息" width="440px">
      <el-form label-width="80px">
        <el-form-item label="头像URL"><el-input v-model="form.avatar" /></el-form-item>
        <el-form-item label="姓名"><el-input v-model="form.realName" /></el-form-item>
        <el-form-item label="邮箱"><el-input v-model="form.email" /></el-form-item>
        <el-form-item label="手机"><el-input v-model="form.phone" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="editing = false">取消</el-button><el-button type="primary" @click="saveProfile">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.profile-hero { position: relative; overflow: hidden; margin-top: 20px; border-radius: 24px; padding: 28px 32px; }
.ph-bg { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(251,191,36,.1), rgba(251,146,60,.06)); z-index: 0; }
.ph-content { position: relative; z-index: 1; display: flex; gap: 20px; align-items: flex-start; }
.ph-avatar-wrap { position: relative; flex-shrink: 0; }
.ph-avatar { width: 80px; height: 80px; border-radius: 24px; object-fit: cover; border: 3px solid rgba(245,158,11,.3); }
.ph-level-badge { position: absolute; bottom: -6px; left: 50%; transform: translateX(-50%); background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2)); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: 10px; white-space: nowrap; box-shadow: 0 2px 8px rgba(245,158,11,.3); }
.ph-info { flex: 1; min-width: 0; }
.ph-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ph-name { font-size: var(--zg-fs-xl); font-weight: 800; }
.ph-role { font-size: var(--zg-fs-xs); padding: 2px 10px; border-radius: 6px; background: rgba(245,158,11,.2); color: #92400e; font-weight: 600; }
.ph-contact { display: flex; gap: 16px; margin-top: 6px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); flex-wrap: wrap; }
.ph-exp-bar { height: 8px; border-radius: 8px; background: rgba(245,158,11,.12); margin-top: 14px; overflow: hidden; }
.ph-exp-fill { height: 100%; border-radius: 8px; background: linear-gradient(90deg, var(--zg-accent), var(--zg-primary)); transition: width .5s; }
.ph-exp-text { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 6px; }
.ph-edit { position: absolute; top: 16px; right: 16px; font-size: 18px; }

.stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 20px; }
.stat-card { display: flex; align-items: center; gap: 14px; padding: 18px 20px; cursor: pointer; }
.stat-icon { width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; }
.stat-num { font-size: var(--zg-fs-lg); font-weight: 800; }
.stat-label { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); }

.section { margin-top: 28px; }
.exp-list { display: flex; flex-direction: column; gap: 8px; }
.exp-item { display: flex; align-items: center; gap: 14px; padding: 14px 18px; }
.ei-icon { font-size: var(--zg-fs-sm); font-weight: 800; padding: 4px 10px; border-radius: 8px; min-width: 50px; text-align: center; }
.ei-icon.pos { background: rgba(52,211,153,.15); color: #059669; }
.ei-icon.neg { background: rgba(239,68,68,.15); color: #dc2626; }
.ei-body { flex: 1; }
.ei-desc { font-weight: 600; font-size: var(--zg-fs-sm); }
.ei-meta { font-size: var(--zg-fs-xs); color: var(--zg-text-dim); margin-top: 2px; }

.my-art-list { display: flex; flex-direction: column; gap: 8px; }
.my-art-item { padding: 14px 18px; cursor: pointer; }
.ma-title { font-weight: 700; font-size: var(--zg-fs-sm); }
.ma-meta { display: flex; gap: 12px; margin-top: 6px; font-size: var(--zg-fs-xs); color: var(--zg-text-dim); align-items: center; }
.ma-status { padding: 2px 8px; border-radius: 6px; font-weight: 600; }
.ma-status.approved { background: rgba(52,211,153,.15); color: #059669; }
.ma-status.pending { background: rgba(245,158,11,.15); color: #b45309; }
.ma-status.rejected { background: rgba(239,68,68,.15); color: #dc2626; }

@media (max-width: 768px) {
  .profile-hero { padding: 20px; border-radius: 18px; margin-top: 12px; }
  .ph-content { flex-direction: column; align-items: center; text-align: center; gap: 12px; }
  .ph-avatar { width: 72px; height: 72px; border-radius: 18px; }
  .ph-name-row { justify-content: center; }
  .ph-contact { justify-content: center; }
  .ph-exp-bar { width: 100%; }
  .ph-edit { top: 10px; right: 10px; }
  .stat-grid { grid-template-columns: 1fr; gap: 10px; }
  .stat-card { padding: 14px 16px; }
  .exp-item { padding: 12px 14px; gap: 10px; }
  .my-art-item { padding: 12px 14px; }
}

@media (min-width: 1200px) {
  .profile-hero { padding: 40px 48px; border-radius: 28px; }
  .ph-avatar { width: 100px; height: 100px; border-radius: 28px; }
  .ph-level-badge { font-size: 13px; padding: 4px 14px; bottom: -8px; }
  .ph-name { font-size: 36px; }
  .ph-role { font-size: 14px; }
  .ph-contact { font-size: 14px; gap: 24px; }
  .ph-exp-bar { height: 10px; margin-top: 20px; }
  .ph-exp-text { font-size: 13px; }
  .stat-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 28px; }
  .stat-card { padding: 24px; }
  .stat-icon { width: 54px; height: 54px; border-radius: 14px; font-size: 28px; }
  .stat-num { font-size: 28px; }
  .stat-label { font-size: 13px; }
  .exp-list { gap: 12px; }
  .exp-item { padding: 18px 24px; }
  .ei-icon { font-size: 15px; min-width: 60px; }
  .ei-desc { font-size: 16px; }
  .ei-meta { font-size: 13px; }
  .my-art-list { gap: 12px; }
  .my-art-item { padding: 18px 24px; }
  .ma-title { font-size: 16px; }
}
</style>
