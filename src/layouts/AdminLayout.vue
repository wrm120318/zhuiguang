<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import LogoMark from '@/components/LogoMark.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const mobileOpen = ref(false)
const repairing = ref(false)

// 🔧 小白一键修复：SUPER_ADMIN点按钮就自动调后端跑fix.sh（10分钟锁）
async function selfRepair() {
  if (!user.isSuperAdmin) return
  try {
    await ElMessageBox.confirm(
      '网站出现问题了吗？点击确定，服务器会在1~2分钟内自动修复全部故障（后端崩溃、隧道断了、1016/530错误），您只需稍后刷新页面即可。\n\n小提示：也可以直接和我对话说「网站又挂了」，我会立刻帮您修好。',
      '小白一键修复',
      { confirmButtonText: '确定开始自动修复', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  if (repairing.value) { ElMessage.warning('修复正在进行中，请耐心等待1~2分钟后按F5刷新'); return }
  repairing.value = true
  ElMessage.info('自动修复已启动！正在重启后端+重建隧道，请耐心等待1~2分钟，然后多按几次F5刷新页面...')
  try {
    const r = await fetch('/api/admin/self-repair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    const d = await r.json().catch(() => ({}))
    if (d?.msg) ElMessage.success(d.msg)
    setTimeout(() => { repairing.value = false }, 70 * 1000)
  } catch (e: any) {
    ElMessage.error('自动修复启动失败：' + (e?.message || '未知错误'))
    repairing.value = false
  }
}

const menus = computed(() => {
  const list: { name: string; label: string; icon: string; badge?: number; role?: string; teacherVisible?: boolean }[] = [
    { name: 'admin-dashboard', label: '数据看板', icon: 'DataLine', role: 'SUPER_ADMIN' },
    { name: 'admin-users', label: '用户管理', icon: 'UserFilled', role: 'SUPER_ADMIN' },
    { name: 'admin-subjects', label: '学科管理', icon: 'Reading', role: 'SUPER_ADMIN' },
    { name: 'admin-classes', label: '班级管理', icon: 'School', role: 'SUPER_ADMIN' },
    { name: 'admin-audit', label: '内容审核', icon: 'CircleCheck', badge: data.pendingArticles.length + data.pendingResources.length, role: 'STAFF', teacherVisible: true },
    { name: 'admin-query', label: '数据查询', icon: 'TrendCharts', role: 'STAFF', teacherVisible: true },
    { name: 'admin-guide', label: '网站说明', icon: 'Notebook', role: 'SUPER_ADMIN' },
    { name: 'admin-site-config', label: '网站自定义', icon: 'HomeFilled', role: 'SUPER_ADMIN' },
    { name: 'admin-exp-rules', label: '经验设置', icon: 'Star', role: 'SUPER_ADMIN' },
    { name: 'admin-exp-logs', label: '经验记录', icon: 'Tickets', role: 'SUPER_ADMIN' },
    { name: 'admin-feature-flags', label: '功能开关', icon: 'Grid', role: 'SUPER_ADMIN' },
    { name: 'admin-theme', label: '界面风格', icon: 'Brush', role: 'SUPER_ADMIN' },
    { name: 'admin-monitor', label: '运行监控', icon: 'Monitor', role: 'SUPER_ADMIN' },
  ]
  return list.filter(m => {
    // 超级管理员可见全部菜单
    if (user.isSuperAdmin) return true
    // 教师（非超管）仅展示 teacherVisible 菜单（数据查询、内容审核）
    if (user.isTeacher && !user.isSuperAdmin) return m.teacherVisible === true
    return false
  })
})

// 教师重定向：路由 /admin 默认重定向到 admin-users（教师无权访问），
// 这里把非超级管理员的教师从无权限页面引导到 admin-audit（内容审核）
onMounted(() => {
  if (user.isTeacher && !user.isSuperAdmin) {
    const allowed = ['admin-audit', 'admin-query']
    if (!allowed.includes(route.name as string)) {
      router.replace({ name: 'admin-audit' })
    }
  }
})

function go(name: string) {
  mobileOpen.value = false
  router.push({ name })
}
</script>

<template>
  <div class="admin-layout">
    <!-- 手机端顶部栏 -->
    <div class="admin-topbar glass">
      <el-button text circle @click="mobileOpen = !mobileOpen" class="at-btn"><el-icon><component :is="mobileOpen ? 'Close' : 'Menu'" /></el-icon></el-button>
      <div class="at-brand zg-grad-text"><LogoMark class="logo" />管理后台</div>
      <el-button text class="at-back" @click="router.push('/')"><el-icon><ArrowLeft /></el-icon>前台</el-button>
    </div>

    <!-- 侧边栏 PC 端固定 -->
    <aside class="sidebar glass" :class="{ open: mobileOpen }">
      <div class="sb-brand zg-grad-text"><LogoMark class="logo" />管理后台</div>
      <div class="sb-role">{{ user.isSuperAdmin ? '超级管理员' : '学科教师' }} · {{ user.current?.realName ?? '' }}</div>
      <nav class="sb-nav">
        <div v-for="m in menus" :key="m.name" class="sb-item" :class="{ on: route.name === m.name }" @click="go(m.name)">
          <span class="sb-icon"><el-icon><component :is="m.icon" /></el-icon></span>
          <span class="sb-label">{{ m.label }}</span>
          <span v-if="m.badge" class="sb-badge">{{ m.badge }}</span>
        </div>
      </nav>
      <div class="sb-back" @click="router.push('/')"><el-icon><ArrowLeft /></el-icon>返回前台首页</div>
    </aside>

    <!-- 手机端遮罩 -->
    <div v-if="mobileOpen" class="sb-mask" @click="mobileOpen = false"></div>

    <main class="admin-main">
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in"><component :is="Component" /></transition>
      </router-view>
    </main>

    <!-- 🔧 小白一键修复按钮：只有超级管理员能看到，悬浮在右下角，永远不挡内容 -->
    <button
      v-if="user.isSuperAdmin"
      class="zg-self-repair-btn"
      :class="{ repairing: repairing }"
      @click="selfRepair"
      :disabled="repairing"
      title="小白一键修复：如果网站出问题（1016/530、点不动、白屏），点这里1~2分钟自动修好！"
    >
      <span class="zg-sr-icon"><el-icon><component :is="repairing ? 'Loading' : 'Tools'" /></el-icon></span>
      <span class="zg-sr-text">{{ repairing ? '修复中...' : '一键修复' }}</span>
    </button>
  </div>
</template>

<style scoped>
.admin-layout { display:flex; flex-wrap: wrap; gap:0; min-height:calc(100vh - 64px); position: relative; }
.admin-topbar { display:none; position: sticky; top:0; z-index: 150; border-radius:0; border-left:none; border-right:none; border-top:none; align-items:center; padding: 8px 14px; height: 52px; }
.at-btn { font-size: 20px !important; color: var(--zg-text) !important; }
.at-brand { font-size: 18px; font-weight: 800; flex: 1; text-align: center; }
.at-back { color: var(--zg-primary) !important; font-size: 13px !important; }

.sidebar { width:240px; padding:20px 16px; position:sticky; top:64px; height:calc(100vh - 64px); display:flex; flex-direction:column; border-radius:0; border-top:none; border-bottom:none; border-left:none; z-index: 160; }
.sb-brand { font-size:20px; font-weight:800; padding:8px 12px; }
.sb-role { font-size:12px; color:var(--zg-text-dim); padding:0 12px 16px; border-bottom:1px solid rgba(var(--zg-primary-rgb),.1); }
.sb-nav { flex:1; display:flex; flex-direction:column; gap:4px; padding-top:12px; overflow-y: auto; }
.sb-item { display:flex; align-items:center; gap:12px; padding:11px 14px; border-radius:10px; cursor:pointer; color:var(--zg-text-dim); font-weight:500; transition:all .2s; font-size: var(--zg-fs-sm); }
.sb-item:hover { background:rgba(var(--zg-primary-rgb),.06); color:var(--zg-text); transform: translateX(2px); }
.sb-item.on { background: linear-gradient(135deg, rgba(var(--zg-primary-rgb),.3), rgba(var(--zg-primary-2-rgb),.22)); color: var(--zg-text); font-weight: 700; }
.sb-icon { font-size:17px; }
.sb-icon :deep(.el-icon) { font-size:17px; }
.at-brand .logo { font-size:20px; }
.sb-brand .logo { font-size:22px; }
.sb-label { flex:1; }
.sb-badge { background:#ef4444; color:#fff; font-size:11px; padding:1px 7px; border-radius:10px; }
.sb-back { padding:12px; color:var(--zg-text-dim); cursor:pointer; font-size:13px; border-top: 1px dashed rgba(var(--zg-primary-rgb),.12); margin-top: 8px; }
.sb-back:hover { color:var(--zg-primary); font-weight: 600; }
.admin-main { flex:1; padding:24px 28px; min-width:0; }

.sb-mask { display:none; }

@media (min-width: 1200px) {
  .sidebar { width: 260px; padding: 24px; }
  .sb-item { padding: 12px 16px; font-size: 14px; }
  .admin-main { padding: 28px 36px; }
  .sb-brand { font-size: 22px; }
  .sb-role { font-size: 14px; }
}

@media (max-width: 960px) {
  .admin-layout { min-height: 100vh; flex-direction: column; }
  .admin-topbar { display:flex; }
  .sidebar {
    position: fixed; top: 52px; left: 0; bottom: 0;
    height: calc(100vh - 52px); width: 78%; max-width: 320px;
    transform: translateX(-102%); transition: transform .3s cubic-bezier(.2,.8,.2,1);
    padding: 16px 12px; z-index: 170; border-right: 1px solid rgba(var(--zg-primary-rgb),.18);
    border-radius: 0 16px 16px 0;
    background: rgba(255,251,235,0.98); backdrop-filter: blur(24px) saturate(180%);
    box-shadow: 4px 0 24px rgba(var(--zg-primary-rgb),.12);
  }
  .sidebar.open { transform: translateX(0); }
  .sb-brand { font-size: 18px; padding: 4px 10px 8px; }
  .sb-role { font-size: 12px; padding: 0 10px 14px; }
  .sb-item { padding: 12px 14px; font-size: var(--zg-fs-base); }
  .sb-icon { font-size: 19px; }
  .admin-main { padding: 14px 14px calc(24px + env(safe-area-inset-bottom)); }
  .sb-mask { display:block; position: fixed; inset: 0; z-index: 155; background: rgba(0,0,0,0.25); backdrop-filter: blur(2px); animation: zgFadeIn .25s; }
}

/* 🔧 小白一键修复按钮：右下角悬浮，超级管理员专属（只有登录后看到） */
.zg-self-repair-btn {
  position: fixed;
  right: 24px;
  bottom: calc(28px + env(safe-area-inset-bottom)); /* BUG-11: 全面屏底栏安全区 */
  z-index: 99999;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  background: linear-gradient(135deg, #ef4444 0%, #f97316 40%, var(--zg-primary) 100%);
  box-shadow: 0 8px 28px rgba(239,68,68,.35), 0 2px 6px rgba(var(--zg-primary-rgb),.18);
  transition: all .2s cubic-bezier(.2,.8,.2,1);
  animation: zgPulse 2.4s ease-in-out infinite;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.zg-self-repair-btn:hover { transform: translateY(-2px) scale(1.03); box-shadow: 0 12px 36px rgba(239,68,68,.42), 0 4px 10px rgba(var(--zg-primary-rgb),.22); }
.zg-self-repair-btn:active { transform: translateY(0) scale(0.98); }
.zg-self-repair-btn:disabled,
.zg-self-repair-btn.repairing {
  background: linear-gradient(135deg, #64748b 0%, #94a3b8 100%);
  cursor: not-allowed;
  animation: none;
  box-shadow: 0 4px 14px rgba(100,116,139,.25);
}
.zg-sr-icon { font-size: 16px; line-height: 1; }
.zg-sr-text { letter-spacing: .5px; }

@keyframes zgPulse {
  0%,100% { box-shadow: 0 8px 28px rgba(239,68,68,.35), 0 2px 6px rgba(var(--zg-primary-rgb),.18); }
  50%     { box-shadow: 0 10px 34px rgba(239,68,68,.52), 0 3px 10px rgba(var(--zg-primary-rgb),.28); }
}
@media (max-width: 640px) {
  .zg-self-repair-btn { right: 14px; bottom: 20px; padding: 10px 14px; font-size: 13px; }
}
</style>
