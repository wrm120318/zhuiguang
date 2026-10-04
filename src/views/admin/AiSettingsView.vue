<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'

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
 * CF 候选模型（与 shared/ai-paper.ts 的 CF_MODEL_CHOICES 保持内容一致）。
 * tag：free=免费档可用 / heavy=免费但耗量偏高 / paid=官方标需付费计费（以测试连接实测为准）。
 * 两个下拉均支持「直接粘贴任意 @cf/... 模型 ID」（filterable + allow-create），
 * 所以这里没收录的模型也能用。
 */
const CF_MODELS = [
  { id: '@cf/zai-org/glm-5.3-flash', label: 'GLM-5.3-Flash（智谱新模型 · 最省神经元）', tag: 'free' as const },
  { id: '@cf/zai-org/glm-4.7-flash', label: 'GLM-4.7-Flash（智谱 · 中文强 · 最稳最省）', tag: 'free' as const },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama-4-Scout-17B（Meta 最新 · 多模态 · 10M 上下文）', tag: 'free' as const },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama-3.3-70B（JSON 最规范 · 耗量高）', tag: 'heavy' as const },
  { id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', label: 'Llama-3.1-8B（最轻量 · 省神经元）', tag: 'free' as const },
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', label: 'Llama-3.2-11B-Vision（看图 · 适合含图试卷）', tag: 'free' as const },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3-30B-A3B（通义新模型 · 中文/JSON 强）', tag: 'free' as const },
  { id: '@cf/qwen/qwen2.5-coder-32b-instruct', label: 'Qwen2.5-Coder-32B（公式/代码强）', tag: 'heavy' as const },
  { id: '@cf/qwen/qwq-32b', label: 'QwQ-32B（推理强）', tag: 'heavy' as const },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek-R1-Distill-32B（推理强）', tag: 'heavy' as const },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral-Small-3.1-24B', tag: 'heavy' as const },
  { id: '@cf/mistral/mistral-7b-instruct-v0.2', label: 'Mistral-7B-v0.2（轻量）', tag: 'free' as const },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma-4-26B（Google · 256K 上下文）', tag: 'heavy' as const },
  { id: '@cf/google/gemma-3-12b-it', label: 'Gemma-3-12B', tag: 'free' as const },
]
/** 计算标签样式：免费=绿 / 耗量大=橙 / 可能需付费=黄 */
function tagType(t: string): 'success' | 'warning' | 'info' {
  if (t === 'free') return 'success'
  if (t === 'heavy') return 'warning'
  return 'info'
}
function tagText(t: string): string {
  return t === 'free' ? '免费' : t === 'heavy' ? '耗量大' : '可能需付费'
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

onMounted(load)

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
              <el-tag size="small" :type="tagType(m.tag)" effect="dark" class="opt-tag">{{ tagText(m.tag) }}</el-tag>
            </el-option>
          </el-select>
          <div class="hint">
            默认 GLM-5.3-Flash：中文试卷理解好、最省神经元。找不到想要的模型？直接在输入框<b>粘贴 Cloudflare 控制台里的 <code>@cf/...</code> 模型 ID</b> 即可（按回车确认）。
          </div>
        </el-form-item>
        <el-form-item label="备用模型">
          <el-select v-model="form.modelCfFallback" filterable allow-create default-first-option style="width:100%"
            placeholder="选择或粘贴 @cf/... 模型 ID" no-match-text="按回车使用此模型">
            <el-option v-for="m in CF_MODELS" :key="m.id" :label="m.label" :value="m.id">
              <span>{{ m.label }}</span>
              <el-tag size="small" :type="tagType(m.tag)" effect="dark" class="opt-tag">{{ tagText(m.tag) }}</el-tag>
            </el-option>
          </el-select>
          <div class="hint">主力模型调用失败时自动改用这个，建议保留默认的 Llama-4-Scout-17B（多模态、免费）。</div>
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
    <div class="glass sec">
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

@media (max-width: 768px) {
  .sec { padding: 16px; }
  .head-actions { width: 100%; }
  .head-actions .el-button { flex: 1; }
  .key-row { flex-wrap: wrap; }
  .stat-row { grid-template-columns: 1fr 1fr; }
}
</style>
