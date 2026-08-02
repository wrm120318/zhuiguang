<script setup lang="ts">
import { onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'

const router = useRouter()
const user = useUserStore()
const settings = useSettingsStore()

onMounted(async () => {
  if (!settings.loaded) await settings.fetchAll()
})

const rules = computed(() => settings.expRules)

// 经验值行为说明
const RULE_DESC: Record<string, { label: string; icon: string; desc: string }> = {
  login: { label: '每日登录', icon: '🔑', desc: '每日首次登录获得经验' },
  register: { label: '注册奖励', icon: '🎁', desc: '新用户注册一次性奖励' },
  article: { label: '发布美文', icon: '✍️', desc: '美文审核通过后获得经验' },
  resource: { label: '上传资料', icon: '📦', desc: '资料审核通过后获得经验' },
  query: { label: '完成查询', icon: '🔍', desc: '参与数据查询获得经验' },
  quiz_pass: { label: '题库自测', icon: '📝', desc: '完成题库自测并获得通过' },
  blog: { label: '发布博客', icon: '📔', desc: '在网站博客发布一篇博文' },
  announcement_read: { label: '阅读公告', icon: '📢', desc: '阅读网站公告' },
  message_reply: { label: '回复站内信', icon: '✉️', desc: '回复他人站内信' },
}

const ruleList = computed(() => {
  const seen = new Set<string>()
  const out: { key: string; label: string; icon: string; desc: string; exp: number }[] = []
  for (const [k, v] of Object.entries(rules.value)) {
    const meta = RULE_DESC[k] || { label: k, icon: '⭐', desc: '' }
    out.push({ key: k, label: meta.label, icon: meta.icon, desc: meta.desc, exp: v })
    seen.add(k)
  }
  // 补全未配置但已知的规则
  for (const [k, meta] of Object.entries(RULE_DESC)) {
    if (!seen.has(k)) out.push({ key: k, label: meta.label, icon: meta.icon, desc: meta.desc, exp: 0 })
  }
  return out
})

function levelExp(level: number) { return (level - 1) * 60 }
</script>

<template>
  <div class="page zg-container">
    <div class="head">
      <h1 class="zg-page-title">⭐ 经验值说明</h1>
      <el-button v-if="user.isSuperAdmin" type="primary" round @click="router.push('/admin/exp-rules')">⚙️ 配置经验规则</el-button>
    </div>

    <div class="glass-strong doc">
      <section class="sec">
        <h2>🌟 什么是经验值？</h2>
        <p>经验值是你在追光平台上活跃与贡献的量化体现。通过登录、分享美文、上传资料、参与题库自测等行为，都能获得经验值。经验值越高，等级越高，在经验排行榜上的名次也越靠前。</p>
      </section>

      <section class="sec">
        <h2>📊 经验值获取规则</h2>
        <p class="muted">下表为当前生效的经验值规则，超级管理员可在「管理后台 → 经验设置」中调整。</p>
        <div class="rule-grid">
          <div v-for="r in ruleList" :key="r.key" class="rule-card glass">
            <div class="rc-icon">{{ r.icon }}</div>
            <div class="rc-body">
              <div class="rc-label">{{ r.label }}</div>
              <div class="rc-desc">{{ r.desc }}</div>
            </div>
            <div class="rc-exp">+{{ r.exp }}</div>
          </div>
        </div>
      </section>

      <section class="sec">
        <h2>🏆 等级说明</h2>
        <p>每累计 <b>60 经验值</b> 提升一级，等级公式：<code>等级 = floor(经验值 / 60) + 1</code></p>
        <div class="level-table">
          <div class="lt-head"><span>等级</span><span>所需累计经验</span><span>头衔</span></div>
          <div v-for="lv in 10" :key="lv" class="lt-row">
            <span>Lv.{{ lv }}</span>
            <span>{{ levelExp(lv) }}</span>
            <span>{{ ['追光萌新','追光学徒','追光行者','追光能手','追光达人','追光专家','追光大师','追光贤者','追光传奇','追光至尊'][lv - 1] }}</span>
          </div>
        </div>
      </section>

      <section class="sec">
        <h2>📈 如何快速提升？</h2>
        <ul>
          <li>坚持每日登录，积少成多</li>
          <li>积极分享优质美文与学习资料</li>
          <li>认真完成老师布置的题库自测</li>
          <li>参与数据查询任务</li>
          <li>在博客记录学习心得</li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: center; margin: 16px 0; flex-wrap: wrap; gap: 12px; }
.zg-page-title { font-size: 26px; font-weight: 800; }
.doc { padding: 28px; }
.sec { margin-bottom: 28px; }
.sec h2 { font-size: 19px; font-weight: 700; margin-bottom: 12px; }
.sec p { font-size: 14px; line-height: 1.8; color: var(--zg-text); }
.muted { color: var(--zg-text-dim); font-size: 13px; }
.sec ul { padding-left: 24px; }
.sec li { font-size: 14px; line-height: 2; }
.sec code { background: rgba(245,158,11,.12); padding: 2px 8px; border-radius: 6px; font-size: 13px; }
.rule-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
.rule-card { display: flex; align-items: center; gap: 12px; padding: 14px; }
.rc-icon { font-size: 26px; }
.rc-body { flex: 1; }
.rc-label { font-weight: 700; font-size: 14px; }
.rc-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.rc-exp { font-size: 20px; font-weight: 800; color: var(--zg-primary); }
.level-table { margin-top: 14px; max-width: 480px; }
.lt-head, .lt-row { display: grid; grid-template-columns: 1fr 1fr 1.5fr; padding: 10px 14px; }
.lt-head { font-weight: 700; font-size: 13px; color: var(--zg-text-dim); border-bottom: 2px solid rgba(245,158,11,.2); }
.lt-row { font-size: 14px; border-bottom: 1px dashed rgba(245,158,11,.1); }
.lt-row span:first-child { font-weight: 700; color: var(--zg-primary); }
@media (max-width: 768px) { .doc { padding: 18px; } .rule-grid { grid-template-columns: 1fr; } }
</style>
