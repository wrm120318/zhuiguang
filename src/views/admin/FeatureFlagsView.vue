<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettingsStore, type FlagKey } from '@/store/settings'
import { ElMessage, ElMessageBox } from 'element-plus'

const settings = useSettingsStore()
const local = ref<Record<string, boolean>>({})
const saving = ref(false)
const loading = ref(true)

// 全部可控功能开关（含说明）
const ALL_FLAGS: { key: FlagKey; label: string; icon: string; desc: string }[] = [
  { key: 'subjects', label: '学科子站', icon: '📚', desc: '学科导航、学科内容、学科榜' },
  { key: 'guide', label: '网站说明', icon: '📖', desc: '网站使用说明页面' },
  { key: 'blog', label: '网站博客', icon: '✍️', desc: '所有人可发布博客' },
  { key: 'announcement', label: '网站公告', icon: '📢', desc: '全站公告 + 班级公告' },
  { key: 'quiz', label: '题库自测', icon: '📝', desc: '题库创建、作答、批改、报告' },
  { key: 'leaderboard', label: '经验排行榜', icon: '🏆', desc: '全站 / 班级 / 学科经验榜' },
  { key: 'message', label: '站内信', icon: '✉️', desc: '成员间互发消息' },
  { key: 'favorites', label: '我的收藏', icon: '⭐', desc: '收藏美文与资料' },
  { key: 'search', label: '搜索', icon: '🔍', desc: '搜索美文与资料' },
  { key: 'registration_enabled', label: '自助注册', icon: '🚪', desc: '开启后游客可在登录页注册新账号；关闭后仅管理员可手动导入账号（默认开启）' },
]

onMounted(async () => {
  try {
    if (!settings.loaded) await settings.fetchAll()
    const next: Record<string, boolean> = {}
    for (const f of ALL_FLAGS) next[f.key] = settings.flags[f.key] !== false
    local.value = next
  } finally { loading.value = false }
})

function toggle(key: string, val: boolean) {
  local.value[key] = val
}

async function save() {
  saving.value = true
  try {
    await settings.saveFlags({ ...local.value })
    ElMessage.success('功能开关已保存，立即生效')
  } catch { /* */ } finally { saving.value = false }
}

async function turnAllOn() {
  try {
    await ElMessageBox.confirm('确定开启全部功能？', '全部开启', { type: 'warning' })
    for (const f of ALL_FLAGS) local.value[f.key] = true
    await save()
  } catch { /* */ }
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title"><ZgGlyph emoji="🧩" /> 功能开关总控</h1>
        <p class="dh-sub">一键控制网站所有功能的开启 / 关闭，关闭后对应入口对全体用户隐藏。</p>
      </div>
      <div class="head-actions">
        <el-button @click="turnAllOn">全部开启</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>

    <div class="glass flag-page">
      <div class="tip"><ZgGlyph emoji="💡" /> 关闭某功能后，导航栏与相关页面入口会立即隐藏，但已存在的数据仍保留。</div>

      <div class="flag-grid">
        <div v-for="f in ALL_FLAGS" :key="f.key" class="flag-card" :class="{ off: !local[f.key] }">
          <div class="fc-icon"><ZgGlyph :emoji="f.icon" /></div>
          <div class="fc-body">
            <div class="fc-label">{{ f.label }}</div>
            <div class="fc-desc">{{ f.desc }}</div>
          </div>
          <el-switch :model-value="local[f.key]" @update:model-value="(v: any) => toggle(f.key, !!v)" />
        </div>
      </div>

      <div class="foot">
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.dh-sub { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.head-actions { display: flex; gap: 10px; }
.flag-page { padding: 24px; }
.tip { background: rgba(var(--zg-primary-rgb),.08); padding: 10px 14px; border-radius: 10px; font-size: 13px; color: var(--zg-text-dim); margin-bottom: 18px; }
.flag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.flag-card { display: flex; align-items: center; gap: 14px; padding: 16px; background: rgba(var(--zg-primary-rgb),.06); border-radius: 12px; transition: all .2s; border: 1px solid transparent; }
.flag-card.off { background: rgba(107,114,128,.08); opacity: .7; }
.fc-icon { font-size: 28px; }
.fc-body { flex: 1; }
.fc-label { font-weight: 700; font-size: 15px; }
.fc-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.foot { margin-top: 20px; display: flex; justify-content: flex-end; }
@media (max-width: 768px) { .flag-page { padding: 16px; } .flag-grid { grid-template-columns: 1fr; } }
</style>
