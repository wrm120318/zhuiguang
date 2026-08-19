<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useSettingsStore } from '@/store/settings'

const settings = useSettingsStore()
const rules = ref<Record<string, number>>({})
const loading = ref(true)

onMounted(async () => {
  try {
    await settings.fetchAll()
    rules.value = { ...settings.expRules }
  } finally {
    loading.value = false
  }
})

// 经验值行为说明（只显示获取经验的规则，删除/取消类规则不显示）
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
  comment: { label: '收到评论', icon: '💬', desc: '你的内容收到他人评论' },
  like: { label: '收到点赞', icon: '❤️', desc: '你的内容收到他人点赞' },
  favorite: { label: '被收藏', icon: '⭐', desc: '你的内容被他人收藏' },
  practice_pass: { label: '单题训练', icon: '🎯', desc: '完成单题训练并获得通过' },
  quiz_fail: { label: '自测未通过', icon: '❌', desc: '题库自测未通过' },
  practice_fail: { label: '训练未通过', icon: '❌', desc: '单题训练未通过' },
  admin_adjust: { label: '管理员调整', icon: '⚙️', desc: '管理员手动调整经验' },
}

// 过滤掉删除/取消类规则
const excludeKeys = new Set(['article_delete', 'resource_delete', 'blog_delete', 'query_delete', 'comment_delete', 'like_cancel', 'favorite_cancel'])

const ruleList = computed(() => {
  const seen = new Set<string>()
  const out: { key: string; label: string; icon: string; desc: string; exp: number }[] = []
  for (const [k, v] of Object.entries(rules.value)) {
    if (excludeKeys.has(k)) continue  // 跳过删除/取消类规则
    const meta = RULE_DESC[k] || { label: k, icon: '⭐', desc: '' }
    out.push({ key: k, label: meta.label, icon: meta.icon, desc: meta.desc, exp: v })
    seen.add(k)
  }
  // 补全未配置但已知的规则
  for (const [k, meta] of Object.entries(RULE_DESC)) {
    if (excludeKeys.has(k)) continue  // 跳过删除/取消类规则
    if (!seen.has(k)) out.push({ key: k, label: meta.label, icon: meta.icon, desc: meta.desc, exp: 0 })
  }
  return out
})
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title"><ZgGlyph emoji="📖" /> 经验值说明</h1>
        <p class="dh-sub">了解追光平台经验值系统：如何获得经验、经验值的作用、以及删除内容时的经验值回收规则。</p>
      </div>
    </div>

    <div class="glass">
      <!-- 经验值获取规则 -->
      <section class="section">
        <h2 class="sec-title">
          <span class="sec-icon"><ZgGlyph emoji="📈" /></span>
          经验值获取规则
        </h2>
        <div class="tip"><ZgGlyph emoji="💡" /> 以下规则为用户获得经验值的途径。删除/取消类操作（如删除美文、取消点赞）将直接删除相关经验值记录，无需单独配置回收规则。</div>
        <div class="rule-list">
          <div v-for="r in ruleList" :key="r.key" class="rule-item">
            <div class="ri-icon"><ZgGlyph :emoji="r.icon" /></div>
            <div class="ri-body">
              <div class="ri-label">{{ r.label }}</div>
              <div class="ri-desc">{{ r.desc }}</div>
            </div>
            <div class="ri-value">
              <span class="exp-num">{{ r.exp > 0 ? '+' + r.exp : '0' }}</span>
              <span class="exp-unit">经验</span>
            </div>
          </div>
        </div>
      </section>

      <!-- 经验值作用 -->
      <section class="section">
        <h2 class="sec-title">
          <span class="sec-icon"><ZgGlyph emoji="🎯" /></span>
          经验值的作用
        </h2>
        <div class="rule-list">
          <div class="rule-item">
            <div class="ri-icon"><ZgGlyph emoji="📊" /></div>
            <div class="ri-body">
              <div class="ri-label">等级提升</div>
              <div class="ri-desc">经验值达到一定数量后可提升等级，等级越高权益越多</div>
            </div>
          </div>
          <div class="rule-item">
            <div class="ri-icon"><ZgGlyph emoji="🏆" /></div>
            <div class="ri-body">
              <div class="ri-label">排行榜</div>
              <div class="ri-desc">经验值参与全校排行榜，展示个人学习成果</div>
            </div>
          </div>
        </div>
      </section>

      <!-- 等级说明 -->
      <section class="section">
        <h2 class="sec-title">
          <span class="sec-icon"><ZgGlyph emoji="📋" /></span>
          等级说明
        </h2>
        <div class="tip"><ZgGlyph emoji="💡" /> 等级计算方式：等级 = 经验值 / 60 + 1</div>
        <div class="level-grid">
          <div class="level-item">
            <div class="level-num">1</div>
            <div class="level-label">新手</div>
            <div class="level-exp">0-59 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">2</div>
            <div class="level-label">入门</div>
            <div class="level-exp">60-119 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">3</div>
            <div class="level-label">进阶</div>
            <div class="level-exp">120-179 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">4</div>
            <div class="level-label">熟练</div>
            <div class="level-exp">180-239 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">5</div>
            <div class="level-label">专家</div>
            <div class="level-exp">240-299 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">6</div>
            <div class="level-label">大师</div>
            <div class="level-exp">300-359 经验</div>
          </div>
          <div class="level-item">
            <div class="level-num">7</div>
            <div class="level-label">宗师</div>
            <div class="level-exp">360+ 经验</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { margin-bottom: 24px; }
.dh-title { font-size: 24px; font-weight: 800; }
.dh-sub { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.section { margin-bottom: 24px; }
.sec-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
.sec-icon { font-size: 20px; }
.tip { background: rgba(var(--zg-primary-rgb),.08); padding: 10px 14px; border-radius: 10px; font-size: 13px; color: var(--zg-text-dim); margin-bottom: 16px; }
.tip.note { background: rgba(59,130,246,.08); }
.rule-list { display: flex; flex-direction: column; gap: 10px; }
.rule-item { display: flex; align-items: center; gap: 14px; padding: 14px; background: rgba(var(--zg-primary-rgb),.04); border-radius: 12px; }
.ri-icon { font-size: 26px; }
.ri-body { flex: 1; }
.ri-label { font-weight: 700; font-size: 15px; }
.ri-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.ri-value { display: flex; align-items: baseline; gap: 4px; }
.exp-num { font-size: 20px; font-weight: 800; color: var(--zg-primary); }
.exp-unit { font-size: 12px; color: var(--zg-text-dim); }
.level-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.level-item { padding: 16px; background: rgba(var(--zg-primary-rgb),.04); border-radius: 12px; text-align: center; }
.level-num { font-size: 24px; font-weight: 800; color: var(--zg-primary); }
.level-label { font-size: 14px; font-weight: 600; margin-top: 4px; }
.level-exp { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
@media (max-width: 768px) { .section { padding: 16px; } .rule-item { flex-wrap: wrap; } .ri-value { width: 100%; justify-content: flex-end; margin-top: 8px; } }
</style>
