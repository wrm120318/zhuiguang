<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()
const route = useRoute()
const user = useUserStore()

const mode = ref<'login' | 'register'>('login')
const form = ref({ username: '', password: '', realName: '', email: '', phone: '' })
const loading = ref(false)
const regEnabled = ref(true)

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
</script>

<template>
  <div class="login-page">
    <div class="login-bg">
      <div class="lb-orb a"></div>
      <div class="lb-orb b"></div>
      <div class="lb-orb c"></div>
    </div>
    <div class="login-card glass-strong zg-scale-in">
      <div class="lc-logo">
        <span class="lc-emoji">🌟</span>
        <h1 class="zg-grad-text">追光</h1>
      </div>
      <p class="lc-subtitle">追光的人，终会身披万丈光芒</p>

      <div class="lc-tabs">
        <div class="lc-tab" :class="{ on: mode === 'login' }" @click="mode = 'login'">登录</div>
        <div class="lc-tab" :class="{ on: mode === 'register' }" @click="mode = 'register'">注册</div>
      </div>

      <div class="lc-form">
        <el-input v-model="form.username" placeholder="用户名" size="large" prefix-icon="👤" @keyup.enter="submit" />
        <el-input v-model="form.password" type="password" placeholder="密码" size="large" prefix-icon="🔒" show-password @keyup.enter="submit" />
        <template v-if="mode === 'register'">
          <el-input v-model="form.realName" placeholder="真实姓名" size="large" prefix-icon="✏️" :disabled="!regEnabled" />
          <el-input v-model="form.email" placeholder="邮箱（选填）" size="large" prefix-icon="📧" :disabled="!regEnabled" />
          <el-input v-model="form.phone" placeholder="手机号（选填）" size="large" prefix-icon="📱" :disabled="!regEnabled" />
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
.lb-orb.a { width: 400px; height: 400px; background: radial-gradient(circle, #FBBF24, transparent 70%); top: -100px; left: -80px; }
.lb-orb.b { width: 350px; height: 350px; background: radial-gradient(circle, #FB923C, transparent 70%); bottom: -100px; right: -60px; animation-delay: -6s; }
.lb-orb.c { width: 250px; height: 250px; background: radial-gradient(circle, #FDE68A, transparent 70%); top: 50%; left: 60%; animation-delay: -12s; opacity: 0.3; }
.login-card { position: relative; z-index: 1; width: 400px; max-width: 92vw; padding: 36px 32px; border-radius: 24px; }
.lc-logo { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.lc-emoji { font-size: 36px; filter: drop-shadow(0 0 12px var(--zg-primary)); }
.lc-logo h1 { font-size: 32px; font-weight: 800; }
.lc-subtitle { text-align: center; color: var(--zg-text-dim); font-size: var(--zg-fs-sm); margin-bottom: 28px; }
.lc-tabs { display:flex; gap:8px; margin-bottom: 20px; background: rgba(245,158,11,.08); padding: 4px; border-radius: 12px; }
.lc-tab { flex:1; text-align:center; padding: 10px; border-radius: 10px; cursor:pointer; color:var(--zg-text-dim); font-weight:600; transition:all .2s; }
.lc-tab.on { background: var(--zg-primary); color: #fff; box-shadow: 0 4px 12px rgba(245,158,11,.3); }
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
</style>
