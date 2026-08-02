<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useSettingsStore } from '@/store/settings'
import { ElMessage } from 'element-plus'

const settings = useSettingsStore()
const local = ref<Record<string, number>>({})
const saving = ref(false)
const loading = ref(true)

const RULE_META: { key: string; label: string; icon: string; desc: string }[] = [
  { key: 'login', label: '每日登录', icon: '🔑', desc: '每日首次登录' },
  { key: 'register', label: '注册奖励', icon: '🎁', desc: '新用户注册' },
  { key: 'article', label: '发布美文', icon: '✍️', desc: '美文审核通过' },
  { key: 'resource', label: '上传资料', icon: '📦', desc: '资料审核通过' },
  { key: 'query', label: '完成查询', icon: '🔍', desc: '参与数据查询' },
  { key: 'quiz_pass', label: '题库自测', icon: '📝', desc: '完成题库自测' },
  { key: 'blog', label: '发布博客', icon: '📔', desc: '在博客发布博文' },
  { key: 'announcement_read', label: '阅读公告', icon: '📢', desc: '阅读网站公告' },
  { key: 'message_reply', label: '回复站内信', icon: '✉️', desc: '回复他人站内信' },
]

const ruleList = computed(() => {
  const seen = new Set<string>()
  const out = [...RULE_META]
  for (const m of out) seen.add(m.key)
  // 包含数据库中存在但未在元数据列表中的规则
  for (const k of Object.keys(local.value)) {
    if (!seen.has(k)) out.push({ key: k, label: k, icon: '⭐', desc: '自定义规则' })
  }
  return out
})

onMounted(async () => {
  try {
    if (!settings.loaded) await settings.fetchAll()
    const next: Record<string, number> = {}
    // 确保所有已知规则都有值
    for (const m of RULE_META) next[m.key] = settings.expRules[m.key] ?? 0
    // 保留数据库中的自定义规则
    for (const [k, v] of Object.entries(settings.expRules)) if (!(k in next)) next[k] = v
    local.value = next
  } finally { loading.value = false }
})

async function save() {
  saving.value = true
  try {
    await settings.saveRules({ ...local.value })
    ElMessage.success('经验值规则已保存')
  } catch { /* */ } finally { saving.value = false }
}

function reset() {
  local.value = {
    login: 5, register: 5, article: 15, resource: 15, query: 2, quiz_pass: 10, blog: 5,
    announcement_read: 1, message_reply: 0,
  }
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title">⭐ 经验值规则设置</h1>
        <p class="dh-sub">设置每个用户行为可获得的经验值，保存后立即生效。</p>
      </div>
      <div class="head-actions">
        <el-button @click="reset">恢复默认</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
      </div>
    </div>

    <div class="glass rule-page">
      <div class="tip">💡 提示：设为 0 表示该行为不获得经验值。学生可在「经验值说明」页面查看当前规则。</div>

      <div class="rule-list">
        <div v-for="r in ruleList" :key="r.key" class="rule-item">
          <div class="ri-icon">{{ r.icon }}</div>
          <div class="ri-body">
            <div class="ri-label">{{ r.label }}</div>
            <div class="ri-desc">{{ r.desc }} · <code>{{ r.key }}</code></div>
          </div>
          <div class="ri-input">
            <el-input-number v-model="local[r.key]" :min="0" :max="9999" :step="1" size="default" />
            <span class="ri-unit">经验 / 次</span>
          </div>
        </div>
      </div>

      <div class="foot">
        <el-button type="primary" :loading="saving" @click="save">保存规则</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.dh-sub { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.head-actions { display: flex; gap: 10px; }
.rule-page { padding: 24px; }
.tip { background: rgba(245,158,11,.08); padding: 10px 14px; border-radius: 10px; font-size: 13px; color: var(--zg-text-dim); margin-bottom: 18px; }
.rule-list { display: flex; flex-direction: column; gap: 10px; }
.rule-item { display: flex; align-items: center; gap: 14px; padding: 14px; background: rgba(245,158,11,.04); border-radius: 12px; }
.ri-icon { font-size: 26px; }
.ri-body { flex: 1; }
.ri-label { font-weight: 700; font-size: 15px; }
.ri-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.ri-desc code { background: rgba(245,158,11,.12); padding: 1px 6px; border-radius: 4px; }
.ri-input { display: flex; align-items: center; gap: 8px; }
.ri-unit { font-size: 12px; color: var(--zg-text-dim); white-space: nowrap; }
.foot { margin-top: 20px; display: flex; justify-content: flex-end; }
@media (max-width: 768px) { .rule-page { padding: 16px; } .rule-item { flex-wrap: wrap; } .ri-input { width: 100%; justify-content: flex-end; } }
</style>
