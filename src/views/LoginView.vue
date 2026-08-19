<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import LogoMark from '@/components/LogoMark.vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const router = useRouter()
const route = useRoute()
const user = useUserStore()

const mode = ref<'login' | 'register'>('login')
const form = ref({ username: '', password: '', realName: '', email: '', phone: '' })
const loading = ref(false)
const regEnabled = ref(true)
const fixing = ref(false)

onMounted(async () => {
  try {
    const r: any = await api.publicFeatureFlags()
    regEnabled.value = !!(r.data?.registration_enabled ?? r.registration_enabled ?? true)
  } catch { /* 默认保持开启 */ }
})

async function submit() {
  if (!form.value.username || !form.value.password) { ElMessage.warning('请输入用户名和密码'); return }
  loading.value = true
  try {
    if (mode.value === 'login') {
      await user.login(form.value.username, form.value.password)
      ElMessage.success('登录成功')
    } else {
      if (!form.value.realName) { ElMessage.warning('请输入真实姓名'); loading.value = false; return }
      await user.register(form.value)
      ElMessage.success('注册成功，请登录')
      mode.value = 'login'
      form.value.password = ''
      return
    }
    const redirect = route.query.redirect as string
    router.push(redirect || '/')
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '操作失败')
  } finally { loading.value = false }
}

// 🔧 登录页右上角小扳手：不用登录、不用进后台、网站半挂也能点修
async function clickFixLoginPage() {
  if (fixing.value) { ElMessage.warning('修复正在跑，请耐心等1~2分钟后F5刷新'); return }
  try {
    await ElMessageBox.confirm(
      '网站有问题吗？点确定后服务器会在1~2分钟内自动修好（后端崩溃、隧道断了、1016/530错误都能修），您只需稍后多按几次F5刷新页面即可。\n\n💡 终极方案：如果连这个按钮都点不了 → 直接和AI助手说「网站挂了」，0操作成本。',
      '🔧 一键修复（不用登录）',
      { confirmButtonText: '确定自动修复', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  fixing.value = true
  // 关键：直接打开 /__zg_fix 新标签页（就算Vue崩了也没事，后端直接返回HTML）
  try {
    window.open('/__zg_fix', '_blank')
    ElMessage.info('🔄 新标签页已打开修复页面！请耐心等待1~2分钟，然后多按几次F5刷新本页～')
  } catch {
    location.href = '/__zg_fix'
  }
  setTimeout(() => { fixing.value = false }, 70 * 1000)
}
</script>

<template>
  <div class="login-page">
    <div class="login-bg">
      <div class="lb-orb a"></div>
      <div class="lb-orb b"></div>
      <div class="lb-orb c"></div>
    </div>
    <!-- 🔧 登录页右上角极小的「🔧」修复按钮（不用登录，能看到登录页就能点！） -->
    <button
      class="zg-login-fix-btn"
      :class="{ on: fixing }"
      @click="clickFixLoginPage"
      :disabled="fixing"
      title="一键修复：网站出问题（1016/530/白屏/点不动）点这里，不用登录！"
    ><ZgGlyph v-if="fixing" emoji="⏳" /><ZgGlyph v-else emoji="🔧" /></button>
    <div class="login-card glass-strong zg-scale-in">
      <div class="lc-logo">
        <LogoMark class="lc-logo-mark" />
        <h1 class="zg-grad-text">追光</h1>
      </div>
      <p class="lc-subtitle">追光的人，终会身披万丈光芒</p>

      <div class="lc-tabs">
        <div class="lc-tab" :class="{ on: mode === 'login' }" @click="mode = 'login'">登录</div>
        <div class="lc-tab" :class="{ on: mode === 'register' }" @click="mode = 'register'">注册</div>
      </div>

      <div class="lc-form">
        <el-input v-model="form.username" placeholder="用户名" size="large" @keyup.enter="submit" />
        <el-input v-model="form.password" type="password" placeholder="密码" size="large" show-password @keyup.enter="submit" />
        <template v-if="mode === 'register'">
          <el-input v-model="form.realName" placeholder="真实姓名" size="large" :disabled="!regEnabled" />
          <el-input v-model="form.email" placeholder="邮箱（选填）" size="large" :disabled="!regEnabled" />
          <el-input v-model="form.phone" placeholder="手机号（选填）" size="large" :disabled="!regEnabled" />
          <div v-if="!regEnabled" class="reg-disabled-tip">管理员已关闭自助注册，请联系老师</div>
        </template>
        <el-button type="primary" size="large" round :loading="loading" @click="submit" style="width:100%; height:48px; font-size:16px; font-weight:600;" :disabled="mode === 'register' && !regEnabled">
          {{ mode === 'login' ? '登 录' : '注 册' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 500; overflow: hidden; }
.login-bg { position: absolute; inset: 0; z-index: 0; }
.lb-orb { position: absolute; border-radius: 50%; filter: blur(80px); opacity: 0.4; animation: zgFloat 18s ease-in-out infinite; }
.lb-orb.a { width: 400px; height: 400px; background: radial-gradient(circle, var(--zg-accent), transparent 70%); top: -100px; left: -80px; }
.lb-orb.b { width: 350px; height: 350px; background: radial-gradient(circle, #FB923C, transparent 70%); bottom: -100px; right: -60px; animation-delay: -6s; }
.lb-orb.c { width: 250px; height: 250px; background: radial-gradient(circle, var(--zg-cream-200), transparent 70%); top: 50%; left: 60%; animation-delay: -12s; opacity: 0.3; }
.login-card { position: relative; z-index: 1; width: 400px; max-width: 92vw; padding: 36px 32px; border-radius: 24px; box-shadow: 0 2px 8px rgba(120,53,15,0.06), 0 18px 48px rgba(120,53,15,0.14); }
.lc-logo { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.lc-logo-mark { font-size: 40px; filter: drop-shadow(0 0 14px rgba(var(--zg-primary-rgb),0.45)); }
.zg-inkgold .lc-logo-mark { filter: drop-shadow(0 0 16px rgba(212,175,55,0.5)); }
.zg-inkgold .lb-orb { opacity: 0.12 !important; filter: blur(90px) !important; }
.zg-inkgold .lb-orb.a { background: radial-gradient(circle, rgba(212,175,55,0.5), transparent 70%) !important; }
.zg-inkgold .lb-orb.b { background: radial-gradient(circle, rgba(230,198,110,0.42), transparent 70%) !important; }
.zg-inkgold .lb-orb.c { background: radial-gradient(circle, rgba(212,175,55,0.32), transparent 70%) !important; opacity: 0.08 !important; }
/* A5 修复：墨金浅色 → 双层柔和棕金阴影（原先误用深色档的单层重黑影 0 28px 80px rgba(0,0,0,.55)） */
.zg-inkgold .login-card { border: 1px solid rgba(186,117,23,0.22) !important; box-shadow: 0 2px 8px rgba(120,90,30,0.06), 0 20px 48px rgba(120,90,30,0.16) !important; }
/* A5 修复：墨金深色 → 收暗双层 + 顶部 1px 高光描边（文档 §A5 规格，避免"黑洞"质感） */
.zg-inkgold-dark .login-card { border: 1px solid rgba(212,175,55,0.22) !important; box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 24px 64px rgba(0,0,0,0.40), inset 0 1px 0 rgba(255,255,255,0.08) !important; }
.lc-logo h1 { font-size: 32px; font-weight: 800; }
.lc-subtitle { text-align: center; color: var(--zg-text-dim); font-size: var(--zg-fs-sm); margin-bottom: 28px; }
.lc-tabs { display:flex; gap:8px; margin-bottom: 20px; background: rgba(var(--zg-primary-rgb),.08); padding: 4px; border-radius: 12px; }
.lc-tab { flex:1; text-align:center; padding: 10px; border-radius: 10px; cursor:pointer; color:var(--zg-text-dim); font-weight:600; transition:all .2s; }
.lc-tab.on { background: var(--zg-primary); color: #fff; box-shadow: 0 4px 12px rgba(var(--zg-primary-rgb),.3); }
.lc-form { display:flex; flex-direction:column; gap:14px; }
.reg-disabled-tip { font-size:13px; color:#ef4444; text-align:center; padding:6px 10px; background:rgba(239,68,68,.08); border-radius:8px; }
@media (max-width: 768px) {
  .login-card { padding: 28px 20px; border-radius: 20px; }
  .lc-emoji { font-size: 30px; }
  .lc-logo h1 { font-size: 28px; }
  .lc-subtitle { font-size: var(--zg-fs-xs); margin-bottom: 20px; }
}

@media (min-width: 1024px) {
  .login-card { width: 460px; padding: 44px 40px; }
  .lc-emoji { font-size: 44px; }
  .lc-logo h1 { font-size: 40px; }
  .lc-subtitle { font-size: 15px; margin-bottom: 36px; }
}

/* 🔧 登录页右上角小修复按钮：极小，不挡UI，只有管理员知道用途 */
.zg-login-fix-btn {
  position: fixed;
  top: calc(18px + env(safe-area-inset-top)); /* BUG-11: 刘海屏顶部安全区 */
  right: 20px;
  z-index: 99999;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: rgba(var(--zg-primary-rgb), 0.18);
  color: #b45309;
  font-size: 17px;
  line-height: 1;
  transition: all .25s cubic-bezier(.2,.8,.2,1);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.zg-login-fix-btn:hover {
  background: linear-gradient(135deg, #ef4444, #f97316);
  color: #fff;
  transform: scale(1.12) rotate(-12deg);
  box-shadow: 0 6px 18px rgba(239,68,68,.3);
}
.zg-login-fix-btn:active { transform: scale(0.95); }
.zg-login-fix-btn:disabled,
.zg-login-fix-btn.on { background: rgba(100,116,139,.25); color: #475569; cursor: not-allowed; animation: zgSpin 1.4s linear infinite; transform: none; box-shadow: none; }
@keyframes zgSpin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
@media (max-width: 640px) {
  .zg-login-fix-btn { top: 12px; right: 12px; width: 32px; height: 32px; font-size: 15px; }
}
</style>
