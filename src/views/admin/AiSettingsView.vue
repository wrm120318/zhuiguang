<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '@/api'
// 【v4.15.0】模型清单改为从共享层 import —— 单一数据源，杜绝前后端漂移（铁律#11）
import { CF_MODEL_CHOICES, CF_FREE_DAILY_NEURONS, BUDGET_MODEL_CF } from '@shared/ai-paper'

// ============================================================================
// 【v4.13.0】AI 设置
//
// 【为什么有这个页面】
//   用户原话：「Google 这个我弄不了」+「智谱的 api 我完了给你 或者是
//   超级管理员可以在管理界面设置」。
//
//   所以试卷 AI 识别做成**双通道**：
//     · 通道 A Cloudflare Workers AI —— 零配置，本节只做"状态展示"，
//       不需要也不能在这里填 Key（它靠 Worker 的 [ai] 绑定，属于基础设施）
//     · 通道 B 智谱开放平台 —— 需要 Key，本页提供输入框让超管自己填
//
// 【两个防坑设计】
//   1) 智谱 Key 输入框**绝不回显明文**：后端下发的是脱敏串（abcd****wxyz），
//      用户不动它直接保存时，后端识别 `****` 并保留原 Key（否则保存一次就清空）。
//   2) 提供「测试连接」按钮：超管最需要回答的问题是「我配的到底能不能用」，
//      猜不出来，必须实测一道真题。
// ============================================================================

const loading = ref(true)
const saving = ref(false)
const testing = ref(false)
const showKey = ref(false)

/** 服务商选项（与后端 sanitizeAiConfig 的枚举严格一致） */
const PROVIDERS = [
  { value: 'auto', label: '自动（推荐）', desc: '优先用 Cloudflare Workers AI，失败自动切智谱' },
  { value: 'cf', label: '仅 Cloudflare Workers AI', desc: '只用零配置的免费通道，忽略智谱' },
  { value: 'zhipu', label: '仅智谱 GLM', desc: '只用智谱开放平台（需填 Key）' },
]

/**
 * CF 候选模型（与 shared/ai-paper.ts 的 CF_MODEL_CHOICES **内容一致**。
 *
 * 【v4.15.0 改为直接复用共享层常量】
 *   以前这里手抄一份，两处必然漂移（用户就报过"下拉里的模型实际不存在"）。
 *   现在改成 import —— 单一数据源，再也不会不一致（铁律#11）。
 *
 * tag：free=免费档可用 / heavy=耗量偏高 / paid=官方标需付费计费
 * price：官方单价（USD / 百万 token），来自 CF models/search 接口实测值。
 */
const CF_MODELS = CF_MODEL_CHOICES

/** 计算标签样式：免费=绿 / 耗量大=橙 / 可能需付费=黄 */
function tagType(t: string): 'success' | 'warning' | 'info' {
  if (t === 'free') return 'success'
  if (t === 'heavy') return 'warning'
  return 'info'
}
function tagText(t: string): string {
  return t === 'free' ? '免费' : t === 'heavy' ? '耗量大' : '可能需付费'
}

/** 把单价格式化成紧凑文本，缺价显示占位 */
function priceText(m: { price?: { in: number; out: number } }): string {
  if (!m.price) return ''
  return `$${m.price.in}/$${m.price.out}`
}

const form = ref({
  provider: 'auto',
  modelCf: CF_MODELS[0].id,
  modelCfFallback: CF_MODELS[2].id,
  modelZhipu: 'glm-4-flash',
  zhipuKey: '',
  // 【v4.13.8】高级旋钮；默认值与后端现状行为一致，避免"一升级就变化"
  temperature: 0.1,
  chunkQuestions: 6,
  maxTokens: 16000,
  concurrency: 1,
  retryAttempts: 3,
})

/** 后端返回的实时状态（可用性 / 实际生效通道 / 通道就绪情况） */
const status = ref<any>({
  available: false, effective: '', cfReady: false, zhipuReady: false, zhipuKeyMasked: '',
})

/** 测试结果（成功后显示识别出的题目，让超管直观判断效果） */
const testResult = ref<any>(null)

const providerLabel: Record<string, string> = { cf: 'Cloudflare Workers AI', zhipu: '智谱 GLM' }

const effectiveText = computed(() => {
  const e = status.value.effective
  return e ? providerLabel[e] || e : '无可用通道'
})

onMounted(async () => {
  await load()
  // 【v4.15.0】用量与额度独立加载：即便它失败也不应阻塞配置区展示
  loadUsage()
  loadCfQuota()
})

async function load() {
  loading.value = true
  try {
    const cfg: any = await api.getAiConfig()
    form.value = {
      provider: cfg.provider || 'auto',
      modelCf: cfg.modelCf || CF_MODELS[0].id,
      modelCfFallback: cfg.modelCfFallback || CF_MODELS[2].id,
      modelZhipu: cfg.modelZhipu || 'glm-4-flash',
      // 注意：这里拿到的是脱敏串，原样放回输入框；用户不改就原样提交
      zhipuKey: cfg.zhipuKeyMasked || '',
      // 【v4.13.8】高级旋钮回填；后端未配（空串/undefined）时回落到与现状一致的默认值
      temperature: cfg.temperature === '' || cfg.temperature == null ? 0.1 : Number(cfg.temperature),
      chunkQuestions: cfg.chunkQuestions === '' || cfg.chunkQuestions == null ? 6 : Number(cfg.chunkQuestions),
      maxTokens: cfg.maxTokens === '' || cfg.maxTokens == null ? 16000 : Number(cfg.maxTokens),
      concurrency: cfg.concurrency === '' || cfg.concurrency == null ? 1 : Number(cfg.concurrency),
      retryAttempts: cfg.retryAttempts === '' || cfg.retryAttempts == null ? 3 : Number(cfg.retryAttempts),
    }
    status.value = cfg
    // 同时刷新一次全局状态（含实际生效通道）
    try { status.value = { ...status.value, ...(await api.aiStatus() as any) } } catch { /* */ }
  } catch {
    ElMessage.error('读取 AI 配置失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await api.saveAiConfig({ ...form.value })
    ElMessage.success('AI 设置已保存，立即生效')
    testResult.value = null
    await load()
  } catch {
    ElMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

async function test() {
  testing.value = true
  testResult.value = null
  try {
    const r: any = await api.testAiConfig()
    testResult.value = r
    if (r.ok) ElMessage.success(r.message || '连接成功')
    else ElMessage.warning(r.message || '连接失败')
  } catch (e: any) {
    testResult.value = { ok: false, message: e?.message || '测试请求失败' }
    ElMessage.error('测试失败')
  } finally {
    testing.value = false
  }
}

function clearKey() {
  form.value.zhipuKey = ''
  ElMessage.info('已清空输入框；点击「保存设置」后将移除已配置的智谱 Key')
}

// ============================================================================
// 【v4.15.0】用量与额度
// ============================================================================
//
// 【为什么必须做这块】
//   用户原话：「我今天用都没用 AI，但是居然一直提示我用量耗尽！！！
//              给我在超级管理员后台 AI 设置里面加上剩余用量 和 使用记录」。
//
//   查证（2026-10-05，直连 Cloudflare 拿到的真实数据）：
//     · 10-03  28 次请求 /  887.0 神经元
//     · 10-04 132 次请求 / 10633.7 神经元  ← 超额度（10000）
//     · 10-05 120 次请求 /    0.0 神经元  ← 全部被拒（额度未回血）
//   三个根因，缺一个都解释不了用户看到的现象：
//     ① 额度是**账户级**共享，不是每人 1 万 —— 别人用也算在你头上
//     ② 额度耗尽后旧代码当"频率限制"重试 → 一次识别打 9 次注定失败的请求
//     ③ 界面上**看不到今天还剩多少** → 用户只能靠报错反推，无从判断
//   本区块解决③，并顺带把①②的证据（失败记录、配额事件）摊开给超管看。
// ============================================================================

const usageLoading = ref(false)
const usage = ref<any>(null)
/** Cloudflare 账户级真实额度（直连 CF 查询，可能与本地记账有差额） */
const cfQuota = ref<any>(null)
const usageDays = ref(14)
/** 明细筛选 */
const logFilter = ref<{ ok: '' | 0 | 1; model: string; scene: string }>({ ok: '', model: '', scene: '' })
const logPage = ref(1)

/** 额度进度条颜色：<60% 绿 / <90% 橙 / ≥90% 红 */
const quotaStatus = computed<'success' | 'warning' | 'exception'>(() => {
  const p = usage.value?.quota?.percent ?? 0
  if (p >= 90) return 'exception'
  if (p >= 60) return 'warning'
  return 'success'
})

/** 额度是否已耗尽（本地记账口径 或 CF 口径任一命中即算） */
const quotaExhausted = computed(() =>
  !!usage.value?.quota?.exhausted || !!cfQuota.value?.exhausted
)

/** 当前主力模型是不是已经是最省的了（不是才提示可优化） */
const modelIsBudget = computed(() => (usage.value?.currentModel || form.value.modelCf) === BUDGET_MODEL_CF)

async function loadUsage() {
  usageLoading.value = true
  try {
    const params: any = { days: usageDays.value, limit: 20, page: logPage.value }
    if (logFilter.value.ok !== '') params.ok = logFilter.value.ok
    if (logFilter.value.model) params.model = logFilter.value.model
    if (logFilter.value.scene) params.scene = logFilter.value.scene
    usage.value = await api.aiUsage(params)
  } catch {
    ElMessage.error('读取用量数据失败')
  } finally {
    usageLoading.value = false
  }
}

/** 查 Cloudflare 账户级真实消耗（失败不影响本地记账展示） */
async function loadCfQuota() {
  try { cfQuota.value = await api.aiQuota() } catch { cfQuota.value = null }
}

async function applyLogFilter() {
  logPage.value = 1
  await loadUsage()
}

async function changeLogPage(p: number) {
  logPage.value = p
  await loadUsage()
}

/** 一键切到最低价模型 */
async function useBudgetModel() {
  try {
    await ElMessageBox.confirm(
      `将把主力模型改为 IBM Granite-4.0-H-Micro，备用改为 GLM-4.7-Flash。\n` +
      `两者单价约为当前常用模型的 1/3.5，可显著延长额度使用时间。\n` +
      `（中文试卷的理解精度可能略降，额度恢复后可再切回 GLM-5.3-Flash）`,
      '切换为省额度模型', { type: 'warning', confirmButtonText: '确认切换', cancelButtonText: '取消' },
    )
  } catch { return }
  try {
    const r: any = await api.useBudgetModel()
    ElMessage.success(r?.message || '已切换为省额度模型')
    await load()
    await loadUsage()
  } catch {
    ElMessage.error('切换失败')
  }
}

/** 清理历史日志（防止 D1 被无限增长的记录撑爆） */
async function purgeLogs() {
  try {
    const { value } = await ElMessageBox.prompt(
      '保留最近多少天的使用记录？更早的记录将被永久删除（不影响 AI 功能，仅清理日志）。',
      '清理历史记录',
      { inputValue: '30', inputPattern: /^\d+$/, inputErrorMessage: '请输入 7~365 之间的整数', type: 'warning' },
    )
    const keep = Math.min(365, Math.max(7, Number(value) || 30))
    const r: any = await api.purgeAiUsage(keep)
    ElMessage.success(`已清理 ${r?.deleted ?? 0} 条记录（保留 ${r?.keptSince} 之后的数据）`)
    await loadUsage()
  } catch { /* 用户取消 */ }
}

function sceneLabel(s: string): string {
  return s === 'paper_parse' ? '试卷识别' : s === 'conn_test' ? '连接测试' : (s || '未标注')
}

/** 把 UTC 时间戳格式化成北京时间（用户在中国，直接看 UTC 要心算） */
function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 神经元格式化：小于 1 显示两位小数，否则取整（避免 "0.00" 这种无信息量的显示） */
function fmtNeurons(n: any): string {
  const v = Number(n) || 0
  return v >= 1 ? String(Math.round(v * 10) / 10) : v.toFixed(3)
}

/**
 * 柱状图单段高度（百分比）。
 *
 * 分母用「窗口内单日最大调用数」而不是固定值：这样在低用量时期
 * 柱子仍能看出相对高低，不会因为都挤在底部而失去可读性。
 * 最小值给 3% 是为了让"有调用但极少"的日子也能看见一条细柱，
 * 否则用户会以为那天没数据。
 */
const maxDailyCalls = computed(() => {
  const arr = (usage.value?.byDay || []) as any[]
  return Math.max(1, ...arr.map(d => (Number(d.okCalls) || 0) + (Number(d.failCalls) || 0)))
})
function barH(n: any): string {
  const v = Number(n) || 0
  if (!v) return '0%'
  return Math.max(3, (v / maxDailyCalls.value) * 100) + '%'
}

/**
 * 【v4.15.1】近 48 小时逐小时的横向条形图辅助。
 *
 * 分母同样取「窗口内单小时最大调用数」，让低用量时段的相对高低仍可见。
 * 最小值 2% 是为了让个位数调用也能画出一条可见的线。
 */
const maxHourCalls = computed(() => {
  const arr = (usage.value?.byHour || []) as any[]
  return Math.max(1, ...arr.map(h => Number(h.calls) || 0))
})
function barPct(n: any, max: number): string {
  const v = Number(n) || 0
  if (!v) return '0%'
  return Math.max(2, (v / (max || 1)) * 100) + '%'
}

/**
 * 把 "2026-10-05T08:00Z" 显示成北京时间的 "10-05 16:00"。
 *
 * 为什么要转换：数据是 UTC 小时桶（与 CF 计费口径一致），
 * 但用户在中国，看到 08:00Z 会误以为"早上八点"，实际是下午四点 ——
 * 排查「什么时候开始被拒」时这个 8 小时偏差会直接把人带偏。
 */
function fmtHour(h: string): string {
  if (!h) return ''
  const d = new Date(h)
  if (Number.isNaN(d.getTime())) return h
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00`
}

/** 智谱配置区的锚点 id —— 额度告警里的「去配置智谱 Key」靠它滚动定位 */
const ZHIPU_ANCHOR = 'ai-zhipu-section'
function scrollToZhipu() {
  const el = document.getElementById(ZHIPU_ANCHOR)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  else ElMessage.info('请向下滚动到「智谱 GLM 开放平台」区块')
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <div>
        <h1 class="dh-title"><ZgGlyph emoji="🤖" /> AI 设置</h1>
        <p class="dh-sub">配置 Word 试卷导入时的「AI 智能识别」——自动切割题目并抽取答案与解析。</p>
      </div>
      <div class="head-actions">
        <el-button :loading="testing" @click="test">
          <ZgGlyph emoji="🧪" /> 测试连接
        </el-button>
        <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
      </div>
    </div>

    <!-- ============ 实时状态 ============ -->
    <div class="glass sec">
      <div class="sec-title"><ZgGlyph emoji="📡" /> 当前状态</div>
      <div class="stat-row">
        <div class="stat" :class="status.available ? 'ok' : 'bad'">
          <div class="stat-k">AI 服务</div>
          <div class="stat-v">{{ status.available ? '可用' : '不可用' }}</div>
        </div>
        <div class="stat" :class="status.effective ? 'ok' : 'bad'">
          <div class="stat-k">实际生效通道</div>
          <div class="stat-v">{{ effectiveText }}</div>
        </div>
        <div class="stat" :class="status.cfReady ? 'ok' : 'bad'">
          <div class="stat-k">Workers AI（零配置）</div>
          <div class="stat-v">{{ status.cfReady ? '已绑定' : '未绑定' }}</div>
        </div>
        <div class="stat" :class="status.zhipuReady ? 'ok' : 'warn'">
          <div class="stat-k">智谱 GLM</div>
          <div class="stat-v">{{ status.zhipuReady ? '已配置' : '未配置（可选）' }}</div>
        </div>
      </div>
      <div class="tip">
        <ZgGlyph emoji="💡" />
        <b>Cloudflare Workers AI 是零配置通道</b>：不需要任何 API Key，每天免费 10000 神经元（约 2900 道题）。
        只要你看到上面「已绑定」，试卷 AI 识别就已经可以用了，下面的智谱配置是<b>可选备份</b>。
        若显示「未绑定」，需在 Cloudflare 后台确认本账号已开通 Workers AI，并重新部署 Worker。
      </div>
    </div>

    <!-- ============ 【v4.15.0】用量与额度 ============ -->
    <div class="glass sec">
      <div class="sec-title">
        <ZgGlyph emoji="📊" /> 用量与额度
        <el-button size="small" style="margin-left:auto" :loading="usageLoading" @click="() => { loadUsage(); loadCfQuota() }">
          刷新
        </el-button>
      </div>

      <!-- 额度耗尽告警：这是用户最需要一眼看到的东西 -->
      <el-alert
        v-if="quotaExhausted"
        type="error" :closable="false" show-icon class="quota-alert"
        title="今日免费额度已耗尽，全站 AI 识别暂时不可用"
      >
        <template #default>
          <div class="qa-line">
            Cloudflare Workers AI 的免费额度是 <b>账户级共享</b>的（不是"每人 1 万"）——
            同一账号下所有应用、控制台测试都从这 10000 神经元里扣，用完后全站一起停摆。
          </div>
          <div class="qa-line">
            <b>重置时间</b>：官方口径为每日 UTC 0 点（北京时间约早上 8:00），
            但实测偶有延迟，恢复通常在数小时内 —— 以本页「剩余额度」实时数字为准。
          </div>
          <div v-if="!modelIsBudget" class="qa-line">
            <b>想立刻继续用</b>：可切到单价最低的 IBM Granite-4.0-H-Micro（约省 3.5 倍）；
            或配置智谱 GLM Key（独立额度，不受此限制）。
          </div>
          <div class="qa-actions">
            <el-button v-if="!modelIsBudget" size="small" type="primary" @click="useBudgetModel">
              一键切到省额度模型
            </el-button>
            <el-button size="small" @click="scrollToZhipu">去配置智谱 Key</el-button>
          </div>
        </template>
      </el-alert>

      <!-- 今日额度进度 -->
      <div class="quota-box">
        <div class="quota-head">
          <span class="quota-title">今日额度（UTC {{ usage?.quota?.day || '—' }}）</span>
          <span class="quota-num">
            已用 <b>{{ fmtNeurons(usage?.quota?.used) }}</b> /
            {{ usage?.quota?.limit || CF_FREE_DAILY_NEURONS }} 神经元
            <template v-if="usage"> · 剩余 <b class="remain">{{ fmtNeurons(usage.quota.remain) }}</b></template>
          </span>
        </div>
        <el-progress
          :percentage="Number((usage?.quota?.percent || 0).toFixed(1))"
          :status="quotaStatus" :stroke-width="14" :text-inside="true"
        />
        <div class="hint" style="margin-top:8px">
          {{ usage?.quota?.resetHint }}。此额度为<b>账号级共享</b>：任意调用者都会消耗同一池，
          因此"我没用却提示耗尽"通常是其他人/其他场景已用满。
        </div>
      </div>

      <!-- 今日 / 窗口统计 -->
      <div class="stat-row" style="margin-top:16px">
        <div class="stat" :class="usage?.today?.calls ? 'ok' : ''">
          <div class="stat-k">今日调用</div>
          <div class="stat-v">{{ usage?.today?.calls ?? 0 }} 次</div>
          <div class="stat-sub">
            成功 {{ usage?.today?.okCalls ?? 0 }} / 失败 {{ usage?.today?.failCalls ?? 0 }}
          </div>
        </div>
        <div class="stat" :class="modelIsBudget ? 'ok' : 'warn'">
          <div class="stat-k">当前主力模型</div>
          <div class="stat-v" style="font-size:13px;word-break:break-all">{{ usage?.currentModel || form.modelCf }}</div>
          <div class="stat-sub">{{ modelIsBudget ? '已是最省模型' : '可切更省模型' }}</div>
        </div>
        <div class="stat">
          <div class="stat-k">近 {{ usageDays }} 日消耗</div>
          <div class="stat-v">{{ fmtNeurons(usage?.window?.neurons) }}</div>
          <div class="stat-sub">共 {{ usage?.window?.calls ?? 0 }} 次调用</div>
        </div>
        <div class="stat" :class="cfQuota?.available ? 'ok' : 'warn'">
          <div class="stat-k">Cloudflare 侧实测</div>
          <div class="stat-v">
            {{ cfQuota?.available ? fmtNeurons(cfQuota.used) + ' 神经元' : '未接入' }}
          </div>
          <div class="stat-sub">
            {{ cfQuota?.available ? `今日 ${cfQuota.todayCalls ?? 0} 次调用` : '需配 CF Token' }}
          </div>
        </div>
      </div>

      <div v-if="cfQuota?.available" class="tip" style="margin-top:12px">
        <ZgGlyph emoji="🔎" />
        <b>两个数字为什么可能不同</b>：上方进度条来自平台自身记账（只统计本平台调用）；
        「Cloudflare 侧实测」直连 CF 账户统计，<b>包含同一账号下所有应用与控制台测试</b>。
        两者差额就是"别人用掉的额度" —— 这正是「我没用却提示耗尽」的答案。
      </div>
      <div v-else-if="cfQuota && !cfQuota.available" class="tip" style="margin-top:12px">
        <ZgGlyph emoji="🔎" /> {{ cfQuota.message }}
        建议为后端配置 <code>CF_ACCOUNT_ID</code> 与 <code>CF_API_TOKEN</code>（只读即可），
        即可直接显示 Cloudflare 账户级的真实消耗。
      </div>

      <!-- 近 N 日趋势 -->
      <div class="sub-title">
        近 {{ usageDays }} 日用量趋势
        <el-radio-group v-model="usageDays" size="small" style="margin-left:12px" @change="applyLogFilter">
          <el-radio-button :value="7">7 天</el-radio-button>
          <el-radio-button :value="14">14 天</el-radio-button>
          <el-radio-button :value="30">30 天</el-radio-button>
        </el-radio-group>
      </div>
      <div v-if="usage?.byDay?.length" class="bar-chart">
        <div v-for="d in usage.byDay" :key="d.day" class="bar-col" :title="`${d.day}：${d.calls} 次调用，${fmtNeurons(d.neurons)} 神经元`">
          <div class="bar-stack">
            <div class="bar-seg ok-seg" :style="{ height: barH(d.okCalls) }" />
            <div class="bar-seg fail-seg" :style="{ height: barH(d.failCalls) }" />
          </div>
          <div class="bar-label">{{ d.day.slice(5) }}</div>
          <div class="bar-val" :class="{ over: d.neurons > CF_FREE_DAILY_NEURONS }">{{ fmtNeurons(d.neurons) }}</div>
        </div>
      </div>
      <div v-else class="hint">暂无数据。执行一次 AI 试卷识别后即可看到统计。</div>

      <!-- 按模型 / 场景 / 用户 -->
      <div class="grid-3">
        <div class="mini-card">
          <div class="mc-title">按模型（谁在烧额度）</div>
          <div v-if="!usage?.byModel?.length" class="hint">暂无数据</div>
          <div v-for="m in usage?.byModel || []" :key="m.model" class="mc-row">
            <span class="mc-name" :title="m.model">{{ m.model }}</span>
            <span class="mc-num">{{ fmtNeurons(m.neurons) }}</span>
          </div>
        </div>
        <div class="mini-card">
          <div class="mc-title">按场景</div>
          <div v-if="!usage?.byScene?.length" class="hint">暂无数据</div>
          <div v-for="s in usage?.byScene || []" :key="s.scene" class="mc-row">
            <span class="mc-name">{{ sceneLabel(s.scene) }}</span>
            <span class="mc-num">{{ s.calls }} 次 / {{ fmtNeurons(s.neurons) }}</span>
          </div>
        </div>
        <div class="mini-card">
          <div class="mc-title">按用户</div>
          <div v-if="!usage?.byActor?.length" class="hint">暂无数据</div>
          <div v-for="a in usage?.byActor || []" :key="a.actorId" class="mc-row">
            <span class="mc-name">{{ a.actorName }}</span>
            <span class="mc-num">{{ a.calls }} 次 / {{ fmtNeurons(a.neurons) }}</span>
          </div>
        </div>
      </div>

      <!-- 失败原因 TOP -->
      <div v-if="usage?.byError?.length" class="mini-card" style="margin-top:12px">
        <div class="mc-title">失败原因 TOP（含被拒的无效请求）</div>
        <div v-for="(e, i) in usage.byError" :key="i" class="err-row">
          <el-tag size="small" type="danger">{{ e.cnt }} 次</el-tag>
          <span class="err-text">{{ e.error }}</span>
          <span class="err-day">{{ e.lastDay }}</span>
        </div>
      </div>

      <!--
        近 48 小时逐小时（v4.15.1）
        【为什么必须单独做这一块】用户会看到「今天消耗 0 却提示额度耗尽」这个反直觉现象，
        然后合理地怀疑「你怎么说用完了」：
          · 额度池满了 → 当天每次调用都被拒 → 被拒不计费 → 当天消耗就是 0
        只看「按天」柱状图，今天那根柱是 0，看起来像"我今天根本没用"。
        逐小时把「调用次数」与「消耗神经元」分开画，才能一眼看出
        「有大量调用、但消耗为 0」= 全部被拒 —— 这正是那 165 次失败的可视化。
      -->
      <div v-if="usage?.byHour?.length" class="mini-card" style="margin-top:12px">
        <div class="mc-title">
          近 48 小时逐小时
          <span class="mc-sub">灰=调用次数　红=被拒次数　消耗为 0 但有调用 = 额度已满在拒单</span>
        </div>
        <div class="hour-list">
          <div v-for="h in usage.byHour" :key="h.hour" class="hour-row">
            <span class="hour-label">{{ fmtHour(h.hour) }}</span>
            <span class="hour-bar-wrap">
              <span class="hour-bar calls" :style="{ width: barPct(h.calls, maxHourCalls) }" />
              <span
                v-if="h.rejected"
                class="hour-bar rejected"
                :style="{ width: barPct(h.rejected, maxHourCalls) }"
              />
            </span>
            <span class="hour-num">{{ h.calls }} 次</span>
            <span class="hour-neurons" :class="{ zero: !h.neurons }">{{ fmtNeurons(h.neurons) }}</span>
            <el-tag v-if="h.rejected" size="small" type="danger">拒 {{ h.rejected }}</el-tag>
          </div>
        </div>
        <div class="hint" style="margin-top:8px">
          提示：若某小时「有调用但神经元为 0」，说明该小时请求全部被 Cloudflare 拒绝 ——
          这解释了为什么「当天消耗是 0」却「一直提示额度耗尽」。
        </div>
      </div>

      <!-- ============ 使用记录（明细） ============ -->
      <div class="sub-title" style="margin-top:20px">
        使用记录
        <span class="sub-count">共 {{ usage?.logTotal ?? 0 }} 条</span>
      </div>
      <div class="log-filter">
        <el-select v-model="logFilter.ok" placeholder="结果" style="width:120px" @change="applyLogFilter">
          <el-option label="全部" value="" />
          <el-option label="仅成功" :value="1" />
          <el-option label="仅失败" :value="0" />
        </el-select>
        <el-select v-model="logFilter.scene" placeholder="场景" clearable style="width:150px" @change="applyLogFilter">
          <el-option label="试卷识别" value="paper_parse" />
          <el-option label="连接测试" value="conn_test" />
        </el-select>
        <el-select v-model="logFilter.model" placeholder="模型" clearable filterable style="width:260px" @change="applyLogFilter">
          <el-option v-for="m in usage?.byModel || []" :key="m.model" :label="m.model" :value="m.model" />
        </el-select>
        <el-button @click="purgeLogs">清理历史记录</el-button>
      </div>

      <el-table :data="usage?.logs || []" size="small" class="log-table" empty-text="暂无使用记录">
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ fmtTime(row.at) }}</template>
        </el-table-column>
        <el-table-column label="触发者" width="110">
          <template #default="{ row }">{{ row.actorName || '—' }}</template>
        </el-table-column>
        <el-table-column label="场景" width="90">
          <template #default="{ row }">{{ sceneLabel(row.scene) }}</template>
        </el-table-column>
        <el-table-column label="模型" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.model || '—' }}
            <el-tag v-if="row.provider === 'zhipu'" size="small" type="info" style="margin-left:6px">智谱</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag :type="row.ok ? 'success' : 'danger'" size="small">{{ row.ok ? '成功' : '失败' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="神经元" width="90" align="right">
          <template #default="{ row }">{{ fmtNeurons(row.neurons) }}</template>
        </el-table-column>
        <el-table-column label="tokens" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.promptTokens || row.completionTokens">{{ row.promptTokens }}+{{ row.completionTokens }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="80" align="right">
          <template #default="{ row }">{{ row.elapsedMs ? (row.elapsedMs / 1000).toFixed(1) + 's' : '—' }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="200">
          <template #default="{ row }">
            <el-tag v-if="row.quotaExhausted" size="small" type="danger" style="margin-right:6px">额度耗尽</el-tag>
            <span v-if="row.error" class="err-text">{{ row.error }}</span>
            <span v-else class="hint">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="(usage?.logTotal ?? 0) > (usage?.logLimit ?? 20)" class="pager">
        <el-pagination
          layout="prev, pager, next" small
          :total="usage?.logTotal ?? 0" :page-size="usage?.logLimit ?? 20"
          :current-page="logPage" @current-change="changeLogPage"
        />
      </div>
    </div>

    <!-- ============ 服务商优先级 ============ -->
    <div class="glass sec">
      <div class="sec-title"><ZgGlyph emoji="🔀" /> 服务商优先级</div>
      <el-radio-group v-model="form.provider" class="prov-group">
        <label
          v-for="p in PROVIDERS"
          :key="p.value"
          class="prov-card"
          :class="{ active: form.provider === p.value }"
        >
          <el-radio :value="p.value">
            <span class="prov-label">{{ p.label }}</span>
          </el-radio>
          <div class="prov-desc">{{ p.desc }}</div>
        </label>
      </el-radio-group>
    </div>

    <!-- ============ Cloudflare Workers AI ============ -->
    <div class="glass sec">
      <div class="sec-title"><ZgGlyph emoji="⚡" /> Cloudflare Workers AI（零配置 · 免费）</div>
      <el-form label-width="140px" label-position="left">
        <el-form-item label="主力模型">
          <el-select v-model="form.modelCf" filterable allow-create default-first-option style="width:100%"
            placeholder="选择或粘贴 @cf/... 模型 ID" no-match-text="按回车使用此模型">
            <el-option v-for="m in CF_MODELS" :key="m.id" :label="m.label" :value="m.id">
              <span>{{ m.label }}</span>
              <span v-if="priceText(m)" class="opt-price">{{ priceText(m) }}</span>
              <el-tag size="small" :type="tagType(m.tag)" effect="dark" class="opt-tag">{{ tagText(m.tag) }}</el-tag>
            </el-option>
          </el-select>
          <div class="hint">
            默认 GLM-5.3-Flash：中文试卷理解最好。列表已按<b>官方单价从低到高排序</b>，
            价格标签 <code>$输入/$输出</code> 单位为「USD / 百万 token」——
            <b>额度紧张时选最上面的 IBM Granite-4.0-H-Micro</b>（约为 GLM 的 1/3.5）。<br />
            找不到想要的模型？直接<b>粘贴 Cloudflare 控制台里的 <code>@cf/...</code> 模型 ID</b>（按回车确认）。
          </div>
        </el-form-item>
        <el-form-item label="备用模型">
          <el-select v-model="form.modelCfFallback" filterable allow-create default-first-option style="width:100%"
            placeholder="选择或粘贴 @cf/... 模型 ID" no-match-text="按回车使用此模型">
            <el-option v-for="m in CF_MODELS" :key="m.id" :label="m.label" :value="m.id">
              <span>{{ m.label }}</span>
              <span v-if="priceText(m)" class="opt-price">{{ priceText(m) }}</span>
              <el-tag size="small" :type="tagType(m.tag)" effect="dark" class="opt-tag">{{ tagText(m.tag) }}</el-tag>
            </el-option>
          </el-select>
          <div class="hint">
            主力模型调用失败时自动改用这个。建议选<b>同样便宜</b>的模型（如 GLM-4.7-Flash）——
            若备用模型比主力贵，主力失败后会把额度烧得更快。
          </div>
        </el-form-item>
      </el-form>
    </div>

    <!-- ============ 高级参数（免费范围内可调） ============ -->
    <div class="glass sec">
      <div class="sec-title"><ZgGlyph emoji="⚙️" /> 高级参数（免费范围内可调）</div>
      <el-collapse :model-value="['adv']">
        <el-collapse-item name="adv" title="展开 / 收起：温度、每批题数、输出长度、并发、重试">
          <el-form label-width="140px" label-position="left">
            <el-form-item label="采样温度">
              <el-slider v-model="form.temperature" :min="0" :max="1" :step="0.05" style="width:60%" />
              <span class="val">{{ form.temperature }}</span>
              <div class="hint">0~1，默认 0.1。越低越稳、越省神经元；越高越发散（试卷识别建议保持低位）。</div>
            </el-form-item>
            <el-form-item label="每批题数">
              <el-input-number v-model="form.chunkQuestions" :min="1" :max="20" :step="1" />
              <div class="hint">切块时每批最多几道题，默认 6。越少越稳/越省（单次输出短），越多越快但长块易被截断丢题。</div>
            </el-form-item>
            <el-form-item label="最大输出 tokens">
              <el-input-number v-model="form.maxTokens" :min="1024" :max="32768" :step="1024" />
              <div class="hint">单次模型输出上限，默认 16000。题多时调大防截断，调小更省神经元。</div>
            </el-form-item>
            <el-form-item label="并发数">
              <el-input-number v-model="form.concurrency" :min="1" :max="4" :step="1" />
              <div class="hint">
                长卷多块同时跑的并发，默认 1（最稳）。调高更快，但免费档易触发<b>频率限制(429)</b>导致丢题——
                <b>除非你已确认额度充足，否则保持 1</b>。
              </div>
            </el-form-item>
            <el-form-item label="429 重试次数">
              <el-input-number v-model="form.retryAttempts" :min="0" :max="6" :step="1" />
              <div class="hint">遇到频率限制/过载时退避重试的次数，默认 3。设为 0 则不重试（出错直接失败）。</div>
            </el-form-item>
          </el-form>
        </el-collapse-item>
      </el-collapse>
    </div>

    <!-- ============ 智谱 GLM ============ -->
    <div :id="ZHIPU_ANCHOR" class="glass sec">
      <div class="sec-title"><ZgGlyph emoji="🔑" /> 智谱 GLM 开放平台（可选备份）</div>
      <el-form label-width="140px" label-position="left">
        <el-form-item label="API Key">
          <div class="key-row">
            <el-input
              v-model="form.zhipuKey"
              :type="showKey ? 'text' : 'password'"
              :placeholder="status.zhipuKeyMasked || '粘贴智谱 API Key（形如 xxxxx.xxxxx）'"
              clearable
            />
            <el-button @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</el-button>
            <el-button @click="clearKey">清空</el-button>
          </div>
          <div class="hint">
            申请地址：
            <a href="https://open.bigmodel.cn/usercenter/apikeys" target="_blank" rel="noopener">
              open.bigmodel.cn/usercenter/apikeys
            </a>
            （国内直连，glm-4-flash 免费）。<br />
            <b>安全提示</b>：为防泄露，已保存的 Key 只显示前 4 位与后 4 位。
            不修改输入框内容直接点保存，<b>不会</b>覆盖原有 Key。
          </div>
        </el-form-item>
        <el-form-item label="模型">
          <el-input v-model="form.modelZhipu" placeholder="glm-4-flash" />
          <div class="hint">智谱开放平台的模型名，默认 <code>glm-4-flash</code>（免费）。</div>
        </el-form-item>
      </el-form>
    </div>

    <!-- ============ 测试结果 ============ -->
    <div v-if="testResult" class="glass sec">
      <div class="sec-title">
        <ZgGlyph emoji="🧪" /> 连接测试结果
        <el-tag :type="testResult.ok ? 'success' : 'danger'" style="margin-left:10px">
          {{ testResult.ok ? '成功' : '失败' }}
        </el-tag>
      </div>
      <div class="test-msg" :class="testResult.ok ? 'ok' : 'bad'">{{ testResult.message }}</div>

      <div v-if="testResult.ok" class="test-body">
        <div class="kv"><span>通道</span><b>{{ providerLabel[testResult.provider] || testResult.provider }}</b></div>
        <div class="kv"><span>模型</span><b>{{ testResult.model }}</b></div>
        <div class="kv"><span>耗时</span><b>{{ testResult.elapsed }} ms</b></div>
        <div v-if="testResult.usage" class="kv">
          <span>用量</span>
          <b>
            {{ testResult.usage.promptTokens || 0 }} + {{ testResult.usage.completionTokens || 0 }} tokens
            <template v-if="testResult.usage.neurons"> · {{ testResult.usage.neurons.toFixed(2) }} 神经元</template>
          </b>
        </div>

        <div v-if="testResult.params" class="test-params">
          <span class="tp-title">本次生效参数</span>
          <el-tag size="small" type="info">温度 {{ testResult.params.temperature }}</el-tag>
          <el-tag size="small" type="info">每批 {{ testResult.params.chunkQuestions }} 题</el-tag>
          <el-tag size="small" type="info">输出 {{ testResult.params.maxTokens }} tok</el-tag>
          <el-tag size="small" type="info">并发 {{ testResult.params.concurrency }}</el-tag>
          <el-tag size="small" type="info">重试 {{ testResult.params.retryAttempts }} 次</el-tag>
        </div>

        <div class="test-q-title">识别出的题目（样例）</div>
        <div v-for="(q, i) in testResult.questions" :key="i" class="test-q">
          <div class="tq-head">
            <el-tag size="small">{{ q.qtype }}</el-tag>
            <span class="tq-score">{{ q.score }} 分</span>
          </div>
          <div class="tq-content">{{ q.content }}</div>
          <div v-if="q.options?.length" class="tq-opts">
            <div v-for="(o, j) in q.options" :key="j">{{ String.fromCharCode(65 + j) }}. {{ o }}</div>
          </div>
          <div v-if="q.answer" class="tq-line"><b>答案</b>：{{ q.answer }}</div>
          <div v-if="q.analysis" class="tq-line"><b>解析</b>：{{ q.analysis }}</div>
        </div>
      </div>

      <div v-else-if="testResult.attempts?.length" class="test-body">
        <div v-for="(a, i) in testResult.attempts" :key="i" class="attempt">
          <b>{{ providerLabel[a.provider] || a.provider }}</b>
          <span v-if="a.error" class="attempt-err">{{ a.error }}</span>
          <span v-else class="attempt-ok">成功</span>
        </div>
      </div>
    </div>

    <div class="foot">
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
.dh-title { font-size: 24px; font-weight: 800; }
.dh-sub { font-size: 13px; color: var(--zg-text-dim); margin-top: 4px; }
.head-actions { display: flex; gap: 10px; }

.sec { padding: 22px; margin-bottom: 16px; }
.sec-title { font-size: 16px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; }

/* 状态卡 */
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat { padding: 14px 16px; border-radius: 12px; border: 1px solid transparent; }
.stat.ok { background: rgba(16,185,129,.10); border-color: rgba(16,185,129,.30); }
.stat.warn { background: rgba(245,158,11,.10); border-color: rgba(245,158,11,.30); }
.stat.bad { background: rgba(239,68,68,.10); border-color: rgba(239,68,68,.30); }
.stat-k { font-size: 12px; color: var(--zg-text-dim); }
.stat-v { font-size: 17px; font-weight: 800; margin-top: 4px; }
.stat.ok .stat-v { color: #10b981; }
.stat.warn .stat-v { color: #f59e0b; }
.stat.bad .stat-v { color: #ef4444; }

.tip { background: rgba(var(--zg-primary-rgb),.08); padding: 12px 16px; border-radius: 10px; font-size: 13px; line-height: 1.75; color: var(--zg-text-dim); }
.tip b { color: var(--zg-text); }

/* 服务商选择 */
.prov-group { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; width: 100%; }
.prov-card { display: block; padding: 14px 16px; border-radius: 12px; border: 1px solid rgba(var(--zg-primary-rgb),.20); background: rgba(var(--zg-primary-rgb),.04); transition: all .2s; cursor: pointer; }
.prov-card.active { border-color: var(--zg-primary); background: rgba(var(--zg-primary-rgb),.10); }
.prov-label { font-weight: 700; }
.prov-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 6px; padding-left: 24px; line-height: 1.6; }

.hint { font-size: 12px; color: var(--zg-text-dim); margin-top: 6px; line-height: 1.7; }
.hint b { color: var(--zg-text); }
.hint code { background: rgba(var(--zg-primary-rgb),.12); padding: 1px 6px; border-radius: 5px; }

/* 模型下拉里的标签 */
.opt-tag { margin-left: 8px; float: right; }
.val { margin-left: 12px; font-weight: 700; color: var(--zg-primary); }

/* 测试结果里的生效参数 */
.test-params { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 4px; }
.test-params .tp-title { font-size: 12px; color: var(--zg-text-dim); margin-right: 4px; }
.hint b { color: var(--zg-text); }
.hint code { background: rgba(var(--zg-primary-rgb),.12); padding: 1px 6px; border-radius: 5px; }

.key-row { display: flex; gap: 8px; width: 100%; }

/* 测试结果 */
.test-msg { padding: 10px 14px; border-radius: 10px; font-size: 13px; margin-bottom: 14px; }
.test-msg.ok { background: rgba(16,185,129,.12); color: #10b981; }
.test-msg.bad { background: rgba(239,68,68,.12); color: #ef4444; }

.test-body { font-size: 13px; }
.kv { display: flex; gap: 10px; padding: 4px 0; }
.kv span { color: var(--zg-text-dim); min-width: 48px; }
.test-q-title { font-weight: 800; margin: 14px 0 8px; }
.test-q { padding: 12px 14px; border-radius: 10px; background: rgba(var(--zg-primary-rgb),.06); margin-bottom: 10px; }
.tq-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.tq-score { font-size: 12px; color: var(--zg-text-dim); }
.tq-content { font-weight: 600; line-height: 1.7; }
.tq-opts { margin: 6px 0; padding-left: 4px; line-height: 1.8; color: var(--zg-text-dim); }
.tq-line { margin-top: 4px; line-height: 1.7; }
.attempt { padding: 6px 0; display: flex; gap: 10px; }
.attempt-err { color: #ef4444; }
.attempt-ok { color: #10b981; }

.foot { margin-top: 20px; display: flex; justify-content: flex-end; }

/* ===== 【v4.15.0】用量与额度 ===== */
.sub-title { font-size: 14px; font-weight: 800; margin: 22px 0 12px; display: flex; align-items: center; }
.sub-count { font-size: 12px; font-weight: 400; color: var(--zg-text-dim); margin-left: 10px; }

.quota-alert { margin-bottom: 16px; }
.quota-alert .qa-line { line-height: 1.8; font-size: 13px; }
.quota-alert .qa-line b { color: #ef4444; }
.qa-actions { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; }

.quota-box { padding: 4px 0; }
.quota-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.quota-title { font-size: 13px; font-weight: 700; }
.quota-num { font-size: 13px; color: var(--zg-text-dim); }
.quota-num b { color: var(--zg-text); font-size: 15px; }
.quota-num .remain { color: #10b981; }

.stat-sub { font-size: 11px; color: var(--zg-text-dim); margin-top: 4px; line-height: 1.5; }

/* 纯 CSS 柱状图（不引图表库，避免为一个统计多打 300KB 包） */
.bar-chart {
  display: flex; align-items: flex-end; gap: 6px;
  height: 170px; padding: 10px 6px 0;
  background: rgba(var(--zg-primary-rgb),.04); border-radius: 10px;
  overflow-x: auto;
}
.bar-col { flex: 1 1 0; min-width: 34px; display: flex; flex-direction: column; align-items: center; height: 100%; }
.bar-stack {
  flex: 1; width: 100%; max-width: 40px;
  display: flex; flex-direction: column-reverse; justify-content: flex-start;
  border-radius: 5px 5px 0 0; overflow: hidden;
}
.bar-seg { width: 100%; transition: height .25s; }
.ok-seg { background: linear-gradient(180deg, #34d399, #10b981); }
.fail-seg { background: linear-gradient(180deg, #f87171, #ef4444); }
.bar-label { font-size: 10px; color: var(--zg-text-dim); margin-top: 5px; white-space: nowrap; }
.bar-val { font-size: 10px; color: var(--zg-text-dim); }
.bar-val.over { color: #ef4444; font-weight: 700; }

.grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 14px; }
.mini-card { padding: 14px; border-radius: 12px; background: rgba(var(--zg-primary-rgb),.05); border: 1px solid rgba(var(--zg-primary-rgb),.12); }
.mc-title { font-size: 13px; font-weight: 800; margin-bottom: 10px; }
.mc-row { display: flex; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 12px; border-bottom: 1px dashed rgba(var(--zg-primary-rgb),.12); }
.mc-row:last-child { border-bottom: none; }
.mc-name { color: var(--zg-text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.mc-num { font-weight: 700; white-space: nowrap; }

.err-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; font-size: 12px; border-bottom: 1px dashed rgba(var(--zg-primary-rgb),.12); }
.err-row:last-child { border-bottom: none; }
.err-text { flex: 1; color: var(--zg-text-dim); line-height: 1.6; word-break: break-all; }
.err-day { color: var(--zg-text-dim); font-size: 11px; white-space: nowrap; }

/* ===== 【v4.15.1】近 48 小时逐小时 =====
   用双层横条把「调用次数」与「被拒次数」分开画：
   灰条 = 总调用，红条 = 其中被拒的部分（叠在灰条上层）。
   这样"有调用但没有消耗"= 灰条长、几乎全红，一眼可见。 */
.mc-sub { font-weight: 400; font-size: 11px; color: var(--zg-text-dim); margin-left: 8px; }
.hour-list { max-height: 320px; overflow-y: auto; }
.hour-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.hour-label { width: 74px; flex: none; color: var(--zg-text-dim); font-variant-numeric: tabular-nums; }
.hour-bar-wrap { flex: 1; min-width: 80px; height: 14px; border-radius: 4px; background: rgba(var(--zg-primary-rgb),.06); position: relative; overflow: hidden; }
.hour-bar { position: absolute; left: 0; top: 0; height: 100%; border-radius: 4px; transition: width .25s; }
.hour-bar.calls { background: rgba(var(--zg-primary-rgb),.28); }
.hour-bar.rejected { background: #e5484d; opacity: .85; }
.hour-num { width: 52px; flex: none; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.hour-neurons { width: 66px; flex: none; text-align: right; color: var(--zg-text-dim); font-variant-numeric: tabular-nums; }
.hour-neurons.zero { color: #e5484d; font-weight: 700; }

.log-filter { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.log-table { width: 100%; }
.pager { display: flex; justify-content: center; margin-top: 14px; }

.opt-price { font-size: 11px; color: var(--zg-text-dim); margin-left: 8px; font-family: ui-monospace, monospace; }

@media (max-width: 768px) {
  .sec { padding: 16px; }
  .head-actions { width: 100%; }
  .head-actions .el-button { flex: 1; }
  .key-row { flex-wrap: wrap; }
  .stat-row { grid-template-columns: 1fr 1fr; }
  .grid-3 { grid-template-columns: 1fr; }
  .quota-head { flex-direction: column; align-items: flex-start; }
  .log-filter > * { width: 100% !important; }
}
</style>
