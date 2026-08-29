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
    </div>
    <!-- 🔧 登录页右上角极小的「🔧」修复按钮（不用登录，能看到登录页就能点！） -->
    <button
      class="zg-login-fix-btn"
      :class="{ on: fixing }"
      @click="clickFixLoginPage"
      :disabled="fixing"
      title="一键修复：网站出问题（1016/530/白屏/点不动）点这里，不用登录！"
    ><ZgGlyph v-if="fixing" emoji="⏳" /><ZgGlyph v-else emoji="🔧" /></button>
    <div class="login-card">
      <div class="lc-logo">
        <LogoMark class="lc-logo-mark" />
        <h1 class="lc-brand">追光</h1>
      </div>
      <p class="lc-subtitle">追光的人，终会身披万丈光芒</p>

      <div class="lc-tabs">
        <div class="lc-tab" :class="{ on: mode === 'login' }" @click="mode = 'login'">登录</div>
        <div class="lc-tab" :class="{ on: mode === 'register' }" @click="mode = 'register'">注册</div>
        <div class="lc-tab-indicator" :style="{ transform: `translateX(${mode === 'login' ? '0' : '100%'})` }"></div>
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
        <el-button type="primary" size="large" round :loading="loading" @click="submit" class="lc-submit" :disabled="mode === 'register' && !regEnabled">
          {{ mode === 'login' ? '登 录' : '注 册' }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  overflow: hidden;
  padding: 20px;
}
.login-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    radial-gradient(800px 600px at 20% 20%, rgba(var(--zg-primary-rgb), 0.06), transparent 60%),
    radial-gradient(600px 500px at 80% 80%, rgba(var(--zg-accent-rgb), 0.05), transparent 60%);
}
.lb-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(100px);
  opacity: 0.3;
  pointer-events: none;
}
.lb-orb.a {
  width: 500px;
  height: 500px;
  background: radial-gradient(circle, rgba(var(--zg-accent-rgb), 0.4), transparent 70%);
  top: -150px;
  left: -100px;
  animation: orbFloatA 20s ease-in-out infinite;
}
.lb-orb.b {
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(var(--zg-primary-rgb), 0.3), transparent 70%);
  bottom: -120px;
  right: -80px;
  animation: orbFloatB 24s ease-in-out infinite reverse;
}
@keyframes orbFloatA {
  0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.25; }
  50% { transform: translate(30px, 20px) scale(1.05); opacity: 0.35; }
}
@keyframes orbFloatB {
  0%, 100% { transform: translate(0, 0) scale(1); opacity: 0.2; }
  50% { transform: translate(-20px, -15px) scale(1.08); opacity: 0.3; }
}

/* 登录卡片：Liquid Glass 高级感 */
.login-card {
  position: relative;
  z-index: 1;
  width: 400px;
  max-width: 100%;
  padding: 40px 32px 36px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: blur(40px) saturate(150%);
  backdrop-filter: blur(40px) saturate(150%);
  border: none;
  box-shadow:
    inset 0 0.5px 0.5px rgba(255, 255, 255, 0.9),
    0 0 0 0.5px rgba(255, 255, 255, 0.3),
    0 1px 2px rgba(0, 0, 0, 0.03),
    0 12px 40px -12px rgba(0, 0, 0, 0.10),
    0 28px 64px -24px rgba(0, 0, 0, 0.08);
}

/* 墨金模式登录卡 */
.zg-inkgold .login-card {
  background: rgba(255, 253, 249, 0.85);
  box-shadow:
    inset 0 0.5px 0.5px rgba(255, 255, 255, 0.9),
    0 0 0 0.5px rgba(120, 90, 30, 0.08),
    0 1px 2px rgba(120, 90, 30, 0.04),
    0 12px 40px -12px rgba(120, 90, 30, 0.10),
    0 28px 64px -24px rgba(120, 90, 30, 0.08);
}

/* 深色墨金 */
.zg-inkgold-dark .login-card {
  background: rgba(40, 34, 24, 0.85);
  box-shadow:
    inset 0 0.5px 0.5px rgba(255, 243, 214, 0.10),
    0 0 0 0.5px rgba(255, 243, 214, 0.06),
    0 1px 2px rgba(0, 0, 0, 0.20),
    0 12px 40px -12px rgba(0, 0, 0, 0.40),
    0 28px 64px -24px rgba(0, 0, 0, 0.30);
}

.lc-logo {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  margin-bottom: 8px;
}
.lc-logo-mark {
  font-size: 38px;
  filter: drop-shadow(0 2px 10px rgba(var(--zg-primary-rgb), 0.3));
}
.lc-brand {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0;
}
.lc-subtitle {
  text-align: center;
  color: var(--zg-text-dim);
  font-size: 14px;
  margin-bottom: 28px;
  font-weight: 400;
  opacity: 0.8;
}

/* Tab：克制的滑动指示器，不用实色块 */
.lc-tabs {
  position: relative;
  display: flex;
  gap: 0;
  margin-bottom: 24px;
  padding: 4px;
  border-radius: 12px;
  background: rgba(var(--zg-primary-rgb), 0.06);
}
.lc-tab {
  flex: 1;
  text-align: center;
  padding: 10px;
  border-radius: 10px;
  cursor: pointer;
  color: var(--zg-text-dim);
  font-weight: 500;
  font-size: 14px;
  transition: color 0.25s ease;
  position: relative;
  z-index: 1;
}
.lc-tab.on {
  color: var(--zg-primary);
  font-weight: 600;
}
.lc-tab-indicator {
  position: absolute;
  top: 4px;
  left: 4px;
  width: calc(50% - 4px);
  height: calc(100% - 8px);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 2px 8px rgba(var(--zg-primary-rgb), 0.12);
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.zg-inkgold-dark .lc-tab-indicator {
  background: rgba(255, 243, 214, 0.08);
}

.lc-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lc-submit {
  width: 100%;
  height: 46px;
  font-size: 15px;
  font-weight: 600;
  margin-top: 4px;
  border-radius: 12px !important;
  box-shadow: 0 4px 14px rgba(var(--zg-primary-rgb), 0.25) !important;
  transition: all 0.25s ease !important;
}
.lc-submit:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(var(--zg-primary-rgb), 0.35) !important;
}
.reg-disabled-tip {
  font-size: 13px;
  color: #ef4444;
  text-align: center;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 10px;
}

/* 修复按钮：用主题色，不用硬编码橘色 */
.zg-login-fix-btn {
  position: fixed;
  top: calc(16px + env(safe-area-inset-top));
  right: 16px;
  z-index: 99999;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: rgba(var(--zg-primary-rgb), 0.1);
  color: var(--zg-text-dim);
  font-size: 16px;
  line-height: 1;
  transition: all 0.25s ease;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  user-select: none;
  -webkit-tap-highlight-color: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.6;
}
.zg-login-fix-btn:hover {
  opacity: 1;
  background: rgba(239, 68, 68, 0.9);
  color: #fff;
  transform: scale(1.08);
  box-shadow: 0 4px 14px rgba(239, 68, 68, 0.3);
}
.zg-login-fix-btn:active { transform: scale(0.95); }
.zg-login-fix-btn:disabled,
.zg-login-fix-btn.on {
  background: rgba(100, 116, 139, 0.15);
  color: var(--zg-text-dim);
  cursor: not-allowed;
  animation: zgSpin 1.4s linear infinite;
  transform: none;
  box-shadow: none;
  opacity: 0.6;
}
@keyframes zgSpin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

@media (max-width: 768px) {
  .login-page { padding: 16px; }
  .login-card { padding: 32px 22px 28px; border-radius: 18px; }
  .lc-logo-mark { font-size: 34px; }
  .lc-brand { font-size: 26px; }
  .lc-subtitle { font-size: 13px; margin-bottom: 24px; }
  .zg-login-fix-btn { top: calc(12px + env(safe-area-inset-top)); right: 12px; width: 30px; height: 30px; font-size: 14px; }
}
</style>
