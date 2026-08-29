<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import { api } from '@/api'
import { renderMarkdown as md } from '@/utils/markdown'

const router = useRouter()
const user = useUserStore()
const settings = useSettingsStore()

const guide = ref<any>(null)
const loading = ref(true)
const activeTab = ref<'guide' | 'exp'>('guide')

onMounted(async () => {
  try {
    const [g] = await Promise.all([
      api.guide(),
      settings.loaded ? Promise.resolve() : settings.fetchAll(),
    ])
    guide.value = g
    // 网站说明为空时，默认展示经验值说明，避免空白
    if (!g) activeTab.value = 'exp'
  } finally {
    loading.value = false
  }
})

const rules = computed(() => settings.expRules)

// 格式化最后更新时间：'none' / null / 空 均显示「暂无」，有值时截取为 YYYY-MM-DD
const guideDate = computed(() => {
  if (!guide.value) return '暂无'
  const raw = guide.value.updated_at || guide.value.created_at
  if (!raw || raw === 'none') return '暂无'
  return String(raw).slice(0, 10)
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
  forum_post: { label: '发布论坛帖', icon: '💬', desc: '论坛帖子审核通过/自动通过' },
  comment: { label: '收到评论', icon: '💬', desc: '你的内容收到他人评论' },
  like: { label: '收到点赞', icon: '❤️', desc: '你的内容收到他人点赞' },
  favorite: { label: '被收藏', icon: '⭐', desc: '你的内容被他人收藏' },
  practice_pass: { label: '单题训练', icon: '🎯', desc: '单题训练通过获得经验' },
  announcement_read: { label: '阅读公告', icon: '📢', desc: '阅读网站公告' },
  message_reply: { label: '回复站内信', icon: '✉️', desc: '回复他人站内信' },
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

function levelExp(level: number) { return (level - 1) * 60 }
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="glass-strong guide-card">
      <!-- 顶部标签切换 -->
      <div class="tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'guide' }"
          @click="activeTab = 'guide'"
        >
          <span class="tab-icon"><ZgGlyph emoji="📘" /></span>网站说明
        </button>
        <button
          class="tab"
          :class="{ active: activeTab === 'exp' }"
          @click="activeTab = 'exp'"
        >
          <span class="tab-icon"><ZgGlyph emoji="⭐" /></span>经验值说明
        </button>
      </div>

      <!-- 网站说明 -->
      <div v-show="activeTab === 'guide'" class="tab-panel">
        <template v-if="guide">
          <h1 class="g-title">{{ guide.title }}</h1>
          <div class="g-meta" v-if="guideDate !== '暂无' || guide.author_name">
            最后更新：{{ guideDate }} · 作者：{{ guide.author_name }}
          </div>
          <div class="g-content" v-html="md(guide.content)"></div>
          <div class="g-foot">
            <el-button v-if="user.isSuperAdmin" type="primary" round @click="router.push('/admin/guide')">
              <ZgGlyph emoji="✏️" /> 编辑此说明
            </el-button>
          </div>
        </template>
        <ZgState v-else-if="!loading" type="empty" title="暂无网站说明" desc="管理员还没有撰写网站说明。">
          <template #actions>
            <el-button v-if="user.isSuperAdmin" type="primary" @click="router.push('/admin/guide')">前往编辑</el-button>
          </template>
        </ZgState>
      </div>

      <!-- 经验值说明 -->
      <div v-show="activeTab === 'exp'" class="tab-panel">
        <section class="sec">
          <h2><ZgGlyph emoji="🌟" /> 什么是经验值？</h2>
          <p>经验值是你在追光平台上活跃与贡献的量化体现。通过登录、分享美文、上传资料、参与题库自测等行为，都能获得经验值。经验值越高，等级越高，在经验排行榜上的名次也越靠前。</p>
        </section>

        <section class="sec">
          <h2><ZgGlyph emoji="📊" /> 经验值获取规则</h2>
          <p class="muted">下表为当前生效的经验值规则，超级管理员可在「管理后台 <ZgGlyph emoji="→" /> 经验设置」中调整。删除/取消类操作将直接删除相关经验值记录，无需单独配置回收规则。</p>
          <div class="rule-grid">
            <div v-for="r in ruleList" :key="r.key" class="rule-card glass">
              <div class="rc-icon"><ZgGlyph :emoji="r.icon" /></div>
              <div class="rc-body">
                <div class="rc-label">{{ r.label }}</div>
                <div class="rc-desc">{{ r.desc }}</div>
              </div>
              <div class="rc-exp" :class="{ 'rc-exp-neg': r.exp < 0 }">{{ r.exp > 0 ? '+' + r.exp : r.exp }}</div>
            </div>
          </div>
        </section>

        <section class="sec">
          <h2><ZgGlyph emoji="🏆" /> 等级说明</h2>
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
          <h2><ZgGlyph emoji="📈" /> 如何快速提升？</h2>
          <ul>
            <li>坚持每日登录，积少成多</li>
            <li>积极分享优质美文与学习资料</li>
            <li>认真完成老师布置的题库自测</li>
            <li>参与数据查询任务</li>
            <li>在博客记录学习心得</li>
          </ul>
        </section>

        <div class="g-foot">
          <el-button v-if="user.isSuperAdmin" type="primary" round @click="router.push('/admin/exp-rules')">
            <ZgGlyph emoji="⚙️" /> 配置经验规则
          </el-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.guide-card { padding: 32px; margin-top: 20px; }

/* 标签切换 */
.tabs {
  display: flex;
  gap: 8px;
  padding: 6px;
  margin-bottom: 28px;
  background: rgba(var(--zg-primary-rgb), .08);
  border: 1px solid rgba(var(--zg-primary-rgb), .15);
  border-radius: 14px;
}
.tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  font-size: 15px;
  font-weight: 700;
  color: var(--zg-text-dim);
  background: transparent;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  transition: all .25s ease;
  white-space: nowrap;
}
.tab:hover { color: var(--zg-primary); background: rgba(var(--zg-primary-rgb), .1); }
.tab.active {
  color: #fff;
  background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary));
  box-shadow: 0 6px 16px rgba(var(--zg-primary-rgb), .3);
}
.tab-icon { font-size: 17px; }

.tab-panel { animation: fade .3s ease; }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* 网站说明 */
.g-title { font-size: 28px; font-weight: 800; }
.g-meta { color: var(--zg-text-dim); font-size: 13px; margin: 8px 0 24px; }
.g-content { font-size: 15px; line-height: 1.9; color: var(--zg-text); }
.g-content :deep(h2) { font-size: 22px; margin-top: 28px; margin-bottom: 14px; }
.g-content :deep(h3) { font-size: 18px; margin-top: 22px; margin-bottom: 10px; }
.g-content :deep(ul), .g-content :deep(ol) { padding-left: 24px; margin: 10px 0; }
.g-content :deep(li) { margin: 6px 0; }
.g-content :deep(b) { font-weight: 700; }
.g-content :deep(a) { color: var(--zg-primary); }
.g-content :deep(img) { max-width: 100%; border-radius: 12px; margin: 12px 0; }

/* 经验值说明 */
.sec { margin-bottom: 28px; }
.sec h2 { font-size: 19px; font-weight: 700; margin-bottom: 12px; }
.sec p { font-size: 14px; line-height: 1.8; color: var(--zg-text); }
.muted { color: var(--zg-text-dim); font-size: 13px; }
.sec ul { padding-left: 24px; }
.sec li { font-size: 14px; line-height: 2; }
.sec code { background: rgba(var(--zg-primary-rgb), .12); padding: 2px 8px; border-radius: 6px; font-size: 13px; }
.rule-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
.rule-card { display: flex; align-items: center; gap: 12px; padding: 14px; }
.rc-icon { font-size: 26px; }
.rc-body { flex: 1; min-width: 0; }
.rc-label { font-weight: 700; font-size: 14px; }
.rc-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 2px; }
.rc-exp { font-size: 20px; font-weight: 800; color: var(--zg-primary); flex-shrink: 0; }
.rc-exp-neg { color: #ef4444; }
.level-table { margin-top: 14px; max-width: 480px; }
.lt-head, .lt-row { display: grid; grid-template-columns: 1fr 1fr 1.5fr; padding: 10px 14px; }
.lt-head { font-weight: 700; font-size: 13px; color: var(--zg-text-dim); border-bottom: 2px solid rgba(var(--zg-primary-rgb), .2); }
.lt-row { font-size: 14px; border-bottom: 1px dashed rgba(var(--zg-primary-rgb), .1); }
.lt-row span:first-child { font-weight: 700; color: var(--zg-primary); }

/* 通用底部操作区 */
.g-foot { margin-top: 32px; padding-top: 20px; border-top: 1px dashed rgba(var(--zg-primary-rgb), .15); }

/* 移动端适配 */
@media (max-width: 768px) {
  .guide-card { padding: 18px; }
  .g-title { font-size: 22px; }
  .tabs { margin-bottom: 20px; }
  .tab { padding: 9px 10px; font-size: 14px; }
  .rule-grid { grid-template-columns: 1fr; }
  .sec h2 { font-size: 17px; }
  .lt-head, .lt-row { padding: 9px 10px; }
  .lt-row { font-size: 13px; }
}
</style>
