<script setup lang="ts">
// 【v4.18.3】线上考试作答页全面加固（对标主流网考平台）：
//   ① 倒计时自动交卷（duration>0 时启用，开始时间持久化，刷新不重置；末 5 分钟红色警示）
//   ② 断点保存：答案/存疑/切屏记录按 quizId+userId 存 localStorage，意外刷新可恢复
//   ③ 提交前确认弹窗（展示未答数 / 存疑数），不再"警告一下就直接交"
//   ④ 答题卡导航：题号网格 + 已答/未答/存疑配色 + 点击跳题
//   ⑤ 存疑标记、离开页面提醒（beforeunload + 路由守卫）
//   ⑥ 主观题 Markdown 工具条（对齐练习页，追加公式快捷键）
//   ⑦ 切屏记录（visibilitychange），随答卷提交，教师端可见次数
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter, useRoute, onBeforeRouteLeave } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

import { renderMarkdown as renderMd, wrapBareLatex } from '@/utils/markdown'
import { attachmentUrl } from '@/utils/helpers'

const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const quiz = ref<any>(null)
const questions = ref<any[]>([])
const answers = ref<Record<number, any>>({})
const submitting = ref(false)
const loading = ref(true)
// 提交结果状态
const submitted = ref(false)
const result = ref<any>(null)
// 试卷存档密码门
const locked = ref(false)
const pwdInput = ref('')
const paperTitle = ref('')
// 【v4.18.3】截止时间已过（后端 403 expired）：学生禁止进入作答
const expired = ref(false)
const expiredUntil = ref('')

// ===== 【v4.18.3】本地持久化 key（按 题库+用户 隔离，多人共用设备不串数据）=====
const quizId = Number(route.params.id)
const uid = computed(() => userStore.current?.id || 0)
const K_DRAFT = computed(() => `zg_quiz_draft_${quizId}_${uid.value}`)
const K_START = computed(() => `zg_quiz_start_${quizId}_${uid.value}`)
/**
 * App.vue 的启动栅栏与页面渲染并行，首屏瞬间 userStore.current 可能还是 null
 * （zg_user 缓存未命中时）→ uid=0 → 草稿 key 退化成 `_0`，与用户真正登录后的 key 不一致。
 * 这里在初始化本地状态前等一小会儿（一般 loadQuiz 网络请求期间就已就绪）。
 */
async function ensureUid() {
  if (uid.value) return
  for (let i = 0; i < 50 && !uid.value; i++) await new Promise(r => setTimeout(r, 100))
}

// ===== ① 倒计时 =====
const remainSec = ref(0)          // 0 = 不限时（或已结束）
const timerId = ref<any>(null)
const urgent = computed(() => remainSec.value > 0 && remainSec.value <= 300)
const autoFailed = ref(false)     // 自动交卷失败（网络等），需手动提交
function fmtRemain(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
function startCountdown() {
  const dur = Number(quiz.value?.duration || 0)
  if (!dur) return                       // duration=0 → 不限时
  let start = Number(localStorage.getItem(K_START.value) || 0)
  const now = Date.now()
  // 无记录 / 记录异常（未来时间）→ 以本次进入为开始
  if (!start || start > now + 5 * 60_000) {
    start = now
    try { localStorage.setItem(K_START.value, String(start)) } catch {}
  }
  const deadline = start + dur * 60_000
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    remainSec.value = left
    if (left <= 0) {
      stopCountdown()
      doSubmit(true)                     // 时间到 → 自动交卷
    }
  }
  tick()
  timerId.value = setInterval(tick, 1000)
}
function stopCountdown() {
  if (timerId.value) { clearInterval(timerId.value); timerId.value = null }
}

// ===== ② 断点保存（答案 + 存疑 + 切屏记录）=====
const flagged = ref<Record<number, boolean>>({})
const switchLogs = ref<{ t: string; type: string; ms?: number }[]>([])
let draftTimer: any = null
watch([answers, flagged, switchLogs], () => {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraftNow, 500)   // 防抖：连点选项不狂写 localStorage
}, { deep: true })
function saveDraftNow() {
  if (submitted.value) return
  try {
    localStorage.setItem(K_DRAFT.value, JSON.stringify({
      answers: answers.value, flagged: flagged.value, switchLogs: switchLogs.value, savedAt: Date.now(),
    }))
  } catch {}
}
function restoreDraft() {
  try {
    const raw = localStorage.getItem(K_DRAFT.value)
    if (!raw) return
    const d = JSON.parse(raw)
    if (d?.answers && Object.keys(d.answers).length) {
      answers.value = { ...d.answers }
      if (d.flagged) flagged.value = { ...d.flagged }
      if (Array.isArray(d.switchLogs)) switchLogs.value = d.switchLogs
      const when = d.savedAt ? new Date(d.savedAt).toLocaleString('zh-CN', { hour12: false }) : ''
      ElMessage.success(`已恢复上次未提交的作答进度${when ? `（${when} 保存）` : ''}`)
    }
  } catch {}
}
function clearLocal() {
  try { localStorage.removeItem(K_DRAFT.value); localStorage.removeItem(K_START.value) } catch {}
}

// ===== ⑦ 切屏记录 =====
let lastHiddenAt = 0
function onVisibility() {
  if (submitted.value) return
  if (document.visibilityState === 'hidden') {
    lastHiddenAt = Date.now()
    switchLogs.value.push({ t: new Date().toISOString(), type: 'hide' })
  } else if (lastHiddenAt) {
    switchLogs.value.push({ t: new Date().toISOString(), type: 'show', ms: Date.now() - lastHiddenAt })
    lastHiddenAt = 0
  }
}
function bindSwitchWatch() { document.addEventListener('visibilitychange', onVisibility) }
function unbindSwitchWatch() { document.removeEventListener('visibilitychange', onVisibility) }

async function loadQuiz(pwd?: string) {
  const r: any = await api.quiz(Number(route.params.id), pwd)
  quiz.value = r
  questions.value = r.questions || []
}

/** 已提交过 → 跳报告页；返回 true 表示已跳转（调用方应中止后续初始化） */
async function checkSubmittedAndRedirect(): Promise<boolean> {
  try {
    await api.quizMyReport(Number(route.params.id))
    ElMessage.info('你已提交过该题库，正在跳转报告页')
    clearLocal()                       // 已提交 → 草稿/计时都应清掉
    router.replace(`/quiz/${route.params.id}/report`)
    return true
  } catch { return false }
}

onMounted(async () => {
  loading.value = true
  try {
    await loadQuiz()
    if (await checkSubmittedAndRedirect()) return
    await ensureUid()
    restoreDraft()
    startCountdown()
    bindSwitchWatch()
  } catch (e: any) {
    if (e?.response?.status === 403 && e?.response?.data?.expired) {
      expired.value = true
      expiredUntil.value = e?.response?.data?.valid_until || ''
    } else if (e?.response?.status === 403 && e?.response?.data?.needPwd) {
      locked.value = true
      paperTitle.value = e?.response?.data?.title || '该试卷'
    } else {
      ElMessage.error(e?.response?.data?.message || '加载失败')
      router.back()
    }
  } finally { loading.value = false }
})

async function unlock() {
  if (!pwdInput.value) { ElMessage.warning('请输入访问密码'); return }
  loading.value = true
  try {
    await loadQuiz(pwdInput.value)
    locked.value = false
    if (await checkSubmittedAndRedirect()) return
    await ensureUid()
    restoreDraft()
    startCountdown()
    bindSwitchWatch()
    ElMessage.success('验证成功，已解锁')
  } catch (e: any) {
    if (e?.response?.status === 403 && e?.response?.data?.needPwd) {
      ElMessage.error('密码错误，请重试')
      pwdInput.value = ''
    } else {
      ElMessage.error(e?.response?.data?.message || '加载失败')
    }
  } finally { loading.value = false }
}

function setAnswer(qId: number, val: any) { answers.value[qId] = val }
function toggleMulti(qId: number, opt: string) {
  const cur = answers.value[qId] || ''
  const set = cur.split(',').filter(Boolean)
  const i = set.indexOf(opt)
  if (i >= 0) set.splice(i, 1); else set.push(opt)
  set.sort()
  answers.value[qId] = set.join(',')
}
/** 主观题 Markdown 工具条：在末尾插入片段（对齐练习页，追加公式快捷键） */
function mdInsert(qId: number, snippet: string) {
  answers.value[qId] = String(answers.value[qId] || '') + snippet
}
/** 存疑标记 */
function toggleFlag(qId: number) { flagged.value[qId] = !flagged.value[qId] }

const answeredCount = computed(() => Object.keys(answers.value).filter(k => answers.value[+k] !== '' && answers.value[+k] != null).length)
const flaggedCount = computed(() => Object.values(flagged.value).filter(Boolean).length)
const unansweredCount = computed(() => questions.value.length - answeredCount.value)
const hasSubjective = computed(() => questions.value.some(q => q.qtype === 'subjective'))
const objectiveCount = computed(() => questions.value.filter(q => q.qtype !== 'subjective').length)
const subjectiveCount = computed(() => questions.value.filter(q => q.qtype === 'subjective').length)
const objCorrect = computed(() => {
  if (!result.value?.graded) return 0
  return Object.values(result.value.graded).filter((g: any) => g.type !== 'subjective' && g.correct).length
})

// ===== ③ 提交确认 + 交卷 =====
async function confirmSubmit() {
  const parts: string[] = []
  if (unansweredCount.value > 0) parts.push(`还有 <b style="color:#ef4444">${unansweredCount.value}</b> 题未作答，将按 0 分计`)
  else parts.push(`全部 ${questions.value.length} 题均已作答`)
  if (flaggedCount.value > 0) parts.push(`${flaggedCount.value} 题标记了「存疑」`)
  try {
    await ElMessageBox.confirm(
      `${parts.join('<br/>')}<br/>提交后不可修改，确定提交吗？`,
      '提交确认',
      { type: 'warning', dangerouslyUseHTMLString: true, confirmButtonText: '确认提交', cancelButtonText: '继续作答' },
    )
  } catch { return }   // 取消 / 关闭
  await doSubmit(false)
}

async function doSubmit(auto = false) {
  if (submitting.value || submitted.value) return
  submitting.value = true
  try {
    const payload: any = { answers: answers.value }
    // 切屏记录随答卷提交（教师端可见）；空数组不发，保持向后兼容
    if (switchLogs.value.length) payload.switch_logs = switchLogs.value
    const r: any = await api.submitQuiz(Number(route.params.id), payload)
    result.value = r
    submitted.value = true
    autoFailed.value = false
    stopCountdown()
    unbindSwitchWatch()
    clearLocal()
    if (auto) ElMessage.warning('答题时间到，已自动交卷')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '提交失败'
    if (auto) {
      // 自动交卷失败：停表并提示手动提交，绝不静默吞掉
      autoFailed.value = true
      ElMessage.error(`自动交卷失败：${msg}，请立即手动提交`)
    } else {
      ElMessage.error(msg)
    }
  } finally { submitting.value = false }
}

// ===== ④ 答题卡导航 =====
const showCard = ref(false)
function jumpTo(i: number) {
  showCard.value = false
  nextTick(() => {
    const el = document.getElementById(`q-card-${i}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1800)
  })
}

// ===== ⑤ 离开页面提醒 =====
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!submitted.value && answeredCount.value > 0) {
    e.preventDefault()
    e.returnValue = ''   // Chrome 需要returnValue才会弹确认
  }
}
window.addEventListener('beforeunload', onBeforeUnload)
onBeforeRouteLeave((_to, _from, next) => {
  // 已提交 / 未作答 → 直接放行；草稿已自动保存，"离开"不等于"丢进度"，提醒仅为防误触
  if (submitted.value || answeredCount.value === 0) return next()
  const ok = window.confirm('线上考试尚未提交。离开页面不会丢失已保存的草稿，但倒计时不会暂停。确定离开？')
  next(ok)
})
onBeforeUnmount(() => {
  stopCountdown()
  unbindSwitchWatch()
  window.removeEventListener('beforeunload', onBeforeUnload)
  clearTimeout(draftTimer)
  saveDraftNow()   // 组件销毁前最后落一次盘
})
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <!-- 【v4.18.3】截止时间已过 -->
    <div v-if="expired" class="glass-strong expired-gate">
      <div class="pg-icon"><ZgGlyph emoji="⏰" /></div>
      <h1 class="pg-title">该考试已截止</h1>
      <p class="pg-sub">截止时间：{{ expiredUntil || '未知' }}<br/>已过截止时间的考试不能进入作答，如有疑问请联系任课教师。</p>
      <el-button type="primary" round size="large" @click="router.push('/quiz')"><ZgGlyph emoji="←" /> 返回题库列表</el-button>
    </div>

    <!-- 试卷存档密码门 -->
    <div v-if="locked" class="glass-strong pwd-gate">
      <div class="pg-icon"><ZgGlyph emoji="🔒" /></div>
      <h1 class="pg-title">{{ paperTitle }} · 已加密</h1>
      <p class="pg-sub">该试卷设置了访问密码，请输入密码后查看</p>
      <el-input v-model="pwdInput" type="password" show-password placeholder="请输入访问密码" class="pg-input" @keyup.enter="unlock" />
      <el-button type="primary" round size="large" @click="unlock"><ZgGlyph emoji="🔑" /> 解锁查看</el-button>
    </div>

    <template v-else>
    <!-- 提交结果页 -->
    <div v-if="submitted && result" class="glass-strong result-card">
      <div class="rs-icon"><ZgGlyph v-if="result.status === 'graded'" emoji="🎉" /><ZgGlyph v-else emoji="⏳" /></div>
      <h1 class="rs-title">{{ result.status === 'graded' ? '答题完成' : '已提交，等待教师阅卷' }}</h1>
      <p class="rs-sub">{{ quiz.title }}</p>

      <div class="rs-score">
        <div class="rs-score-num">
          <span class="rs-num">{{ result.totalScore }}</span>
          <span class="rs-max"> / {{ result.maxScore }}</span>
        </div>
        <div class="rs-score-label">客观题得分</div>
      </div>

      <div class="rs-summary">
        <div class="rss-item">
          <div class="rss-num">{{ objectiveCount }}</div>
          <div class="rss-label">客观题</div>
        </div>
        <div class="rss-item">
          <div class="rss-num correct">{{ objCorrect }}</div>
          <div class="rss-label">正确</div>
        </div>
        <div class="rss-item">
          <div class="rss-num wrong">{{ objectiveCount - objCorrect }}</div>
          <div class="rss-label">错误</div>
        </div>
        <div class="rss-item" v-if="subjectiveCount">
          <div class="rss-num">{{ subjectiveCount }}</div>
          <div class="rss-label">主观题</div>
        </div>
      </div>

      <div v-if="result.status === 'pending'" class="rs-notice">
        <div class="rsn-icon"><ZgGlyph emoji="⏳" /></div>
        <div class="rsn-text">
          <div class="rsn-title">主观题等待教师批改</div>
          <div class="rsn-desc">已通过站内信通知任课教师阅卷。教师批改完成后，将再次通过站内信提醒你，届时可查看完整测评报告。</div>
        </div>
      </div>
      <div v-else class="rs-notice success">
        <div class="rsn-icon"><ZgGlyph emoji="✅" /></div>
        <div class="rsn-text">
          <div class="rsn-title">整张试卷报告已生成</div>
          <div class="rsn-desc">所有题目已判分完成，可查看完整测评报告。</div>
        </div>
      </div>

      <div class="rs-actions">
        <el-button round @click="router.replace(`/quiz/${route.params.id}/report`)"><ZgGlyph emoji="📊" /> 查看完整报告</el-button>
        <el-button round @click="router.push('/quiz')"><ZgGlyph emoji="←" /> 返回题库列表</el-button>
      </div>
    </div>

    <!-- 作答页 -->
    <template v-else>
    <!-- 【v4.18.3】倒计时条：sticky 吸顶，末 5 分钟变红警示 -->
    <div v-if="quiz?.duration && remainSec > 0" class="cd-bar glass" :class="{ urgent }">
      <span class="cd-icon"><ZgGlyph emoji="⏱" /></span>
      <span class="cd-num">{{ fmtRemain(remainSec) }}</span>
      <span class="cd-label">剩余时间</span>
      <span v-if="urgent" class="cd-warn">最后 5 分钟，请尽快检查并提交</span>
    </div>
    <div v-if="autoFailed" class="cd-fail glass">
      <ZgGlyph emoji="⚠️" /> 自动交卷失败，请检查网络后立即点击「提交作答」
    </div>

    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div v-if="quiz" class="glass-strong q-head">
      <h1 class="qh-title">{{ quiz.title }}</h1>
      <p class="qh-desc" v-if="quiz.description">{{ quiz.description }}</p>
      <div class="qh-meta">
        <span>共 {{ questions.length }} 题</span>
        <span v-if="quiz.duration"><ZgGlyph emoji="⏱" /> {{ quiz.duration }} 分钟</span>
        <span v-if="quiz.valid_until"><ZgGlyph emoji="📅" /> 截止 {{ quiz.valid_until }}</span>
        <span class="qh-saved"><ZgGlyph emoji="💾" /> 答案自动保存</span>
      </div>
    </div>

    <div v-for="(q, i) in questions" :key="q.id" :id="`q-card-${i}`" class="glass q-card" :class="{ 'q-flagged': flagged[q.id] }">
      <div class="q-head">
        <span class="q-no">{{ i + 1 }}.</span>
        <el-tag size="small">{{ q.qtype === 'single' ? '单选' : q.qtype === 'multiple' ? '多选' : q.qtype === 'judge' ? '判断' : '主观' }}</el-tag>
        <span class="q-score">{{ q.score }} 分</span>
        <!-- 【v4.18.3】存疑标记 -->
        <el-button text size="small" class="q-flag" :type="flagged[q.id] ? 'warning' : 'default'" @click.stop="toggleFlag(q.id)">
          <ZgGlyph emoji="🚩" /> {{ flagged[q.id] ? '取消存疑' : '存疑' }}
        </el-button>
      </div>
      <div class="q-content markdown-body zg-rich" v-html="renderMd(q.content)"></div>

      <div v-if="q.attachments?.length" class="q-attachments">
        <a v-for="(a, idx) in q.attachments" :key="idx" :href="attachmentUrl(a)" target="_blank" class="qa-link"><ZgGlyph emoji="📎" /> {{ a.name }}</a>
      </div>

      <!-- 单选/判断 -->
      <template v-if="q.qtype === 'single' || q.qtype === 'judge'">
        <div class="q-options">
          <div v-for="(opt, idx) in q.options" :key="idx"
            class="q-opt" :class="{ on: answers[q.id] === String.fromCharCode(65 + idx) }"
            @click="setAnswer(q.id, String.fromCharCode(65 + idx))">
            <span class="qo-letter">{{ String.fromCharCode(65 + idx) }}</span>
            <span v-html="renderMd(wrapBareLatex(opt))"></span>
          </div>
        </div>
      </template>
      <!-- 多选 -->
      <template v-else-if="q.qtype === 'multiple'">
        <div class="q-options">
          <div v-for="(opt, idx) in q.options" :key="idx"
            class="q-opt" :class="{ on: (answers[q.id] || '').split(',').includes(String.fromCharCode(65 + idx)) }"
            @click="toggleMulti(q.id, String.fromCharCode(65 + idx))">
            <span class="qo-letter">{{ String.fromCharCode(65 + idx) }}</span>
            <span v-html="renderMd(wrapBareLatex(opt))"></span>
          </div>
        </div>
      </template>
      <!-- 主观题（含 Markdown 工具条） -->
      <template v-else>
        <div class="subj-area">
          <div class="toolbar">
            <button type="button" title="加粗" @click="mdInsert(q.id, '**加粗**')"><b>B</b></button>
            <button type="button" title="列表" @click="mdInsert(q.id, '\n- 列表项\n')">列表</button>
            <button type="button" title="行内公式" @click="mdInsert(q.id, '$x^2+y^2=z^2$')">公式</button>
            <button type="button" title="代码" @click="mdInsert(q.id, '\n```\n代码\n```\n')">代码</button>
          </div>
          <el-input v-model="answers[q.id]" type="textarea" :rows="6" placeholder="在此输入你的答案（支持 Markdown）" />
        </div>
      </template>
    </div>

    <div class="submit-bar glass" v-if="quiz">
      <span class="sb-info">已答 {{ answeredCount }} / {{ questions.length }}<template v-if="flaggedCount"> · 存疑 {{ flaggedCount }}</template></span>
      <span class="sb-btns">
        <el-button round @click="showCard = true"><ZgGlyph emoji="🧭" /> 答题卡</el-button>
        <el-button type="primary" round size="large" :loading="submitting" @click="confirmSubmit">提交作答</el-button>
      </span>
    </div>

    <!-- 【v4.18.3】答题卡：题号网格导航 -->
    <el-dialog v-model="showCard" title="答题卡" width="520px" append-to-body class="ac-dialog">
      <div class="ac-summary">
        <span class="ac-s-item"><i class="ac-dot on"></i> 已答 {{ answeredCount }}</span>
        <span class="ac-s-item"><i class="ac-dot off"></i> 未答 {{ unansweredCount }}</span>
        <span class="ac-s-item"><i class="ac-dot flag"></i> 存疑 {{ flaggedCount }}</span>
      </div>
      <div class="ac-grid">
        <button
          v-for="(q, i) in questions" :key="q.id" type="button"
          class="ac-cell"
          :class="{ on: answers[q.id] !== undefined && answers[q.id] !== '' && answers[q.id] != null, flag: flagged[q.id] }"
          @click="jumpTo(i)"
        >{{ i + 1 }}</button>
      </div>
      <p class="ac-tip">点击题号可快速跳到对应题目；「存疑」题目标记为橙色，交卷前建议回头检查。</p>
    </el-dialog>
    </template>
    </template>
  </div>
</template>

<style scoped>
.result-card { padding: 40px 32px; text-align: center; margin-top: 16px; }
.rs-icon { font-size: 64px; margin-bottom: 12px; }
.rs-title { font-size: 26px; font-weight: 800; }
.rs-sub { color: var(--zg-text-dim); font-size: 15px; margin: 6px 0 24px; }
.rs-score { display: flex; flex-direction: column; align-items: center; margin-bottom: 24px; }
.rs-score-num { display: flex; align-items: baseline; gap: 4px; }
.rs-num { font-size: 56px; font-weight: 800; color: var(--zg-primary); line-height: 1; }
.rs-max { font-size: 24px; color: var(--zg-text-dim); font-weight: 600; }
.rs-score-label { font-size: 13px; color: var(--zg-text-dim); margin-top: 6px; }
.rs-summary { display: flex; gap: 16px; justify-content: center; margin-bottom: 28px; flex-wrap: wrap; }
.rss-item { background: rgba(var(--zg-primary-rgb),.06); border-radius: 14px; padding: 14px 24px; min-width: 90px; }
.rss-num { font-size: 28px; font-weight: 800; }
.rss-num.correct { color: #10b981; }
.rss-num.wrong { color: #ef4444; }
.rss-label { font-size: 12px; color: var(--zg-text-dim); margin-top: 4px; }
.rs-notice { display: flex; align-items: flex-start; gap: 14px; background: rgba(var(--zg-primary-rgb),.1); border-radius: 14px; padding: 18px 22px; text-align: left; margin-bottom: 24px; max-width: 560px; margin-left: auto; margin-right: auto; }
.rs-notice.success { background: rgba(16,185,129,.1); }
.rsn-icon { font-size: 32px; flex-shrink: 0; }
.rsn-title { font-weight: 700; font-size: 16px; margin-bottom: 4px; }
.rsn-desc { font-size: 13px; color: var(--zg-text-dim); line-height: 1.7; }
.rs-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }

.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.pwd-gate { padding: 48px 32px; text-align: center; margin-top: 16px; max-width: 460px; margin-left: auto; margin-right: auto; }
.expired-gate { padding: 48px 32px; text-align: center; margin-top: 16px; max-width: 460px; margin-left: auto; margin-right: auto; }
.pg-icon { font-size: 56px; margin-bottom: 12px; }
.pg-title { font-size: 22px; font-weight: 800; }
.pg-sub { color: var(--zg-text-dim); font-size: 14px; margin: 8px 0 24px; }
.pg-input { margin-bottom: 18px; }
.pg-input :deep(.el-input__inner) { text-align: center; letter-spacing: 2px; }
.q-head { padding: 24px; margin-top: 16px; }
.qh-title { font-size: 22px; font-weight: 800; }
.qh-desc { color: var(--zg-text-dim); margin: 6px 0; }
.qh-meta { display: flex; gap: 16px; font-size: 13px; color: var(--zg-text-dim); margin-top: 8px; flex-wrap: wrap; }
.qh-saved { color: var(--zg-success, #10b981); }
.q-card { padding: 22px; margin-top: 14px; scroll-margin-top: 130px; }
.q-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.q-no { font-weight: 800; font-size: 17px; }
.q-score { margin-left: auto; color: var(--zg-accent); font-size: 13px; }
.q-flag { margin-left: 4px; }
.q-card.q-flagged { border: 1.5px solid rgba(245,158,11,.55); }
.q-content { font-size: 15px; line-height: 1.8; margin-bottom: 14px; }
.q-content :deep(img) { max-width: 100%; border-radius: 10px; }
.q-attachments { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.qa-link { color: var(--zg-primary); font-size: 13px; }
.q-options { display: flex; flex-direction: column; gap: 8px; }
.q-opt { display: flex; gap: 12px; padding: 12px 16px; border-radius: 10px; background: rgba(var(--zg-primary-rgb),.04); border: 1.5px solid rgba(var(--zg-primary-rgb),.1); cursor: pointer; transition: all .2s; }
.q-opt:hover { background: rgba(var(--zg-primary-rgb),.1); }
.q-opt.on { background: rgba(var(--zg-primary-rgb),.18); border-color: var(--zg-primary); }
.qo-letter { width: 26px; height: 26px; border-radius: 50%; background: rgba(var(--zg-primary-rgb),.15); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.q-opt.on .qo-letter { background: var(--zg-primary); color: #fff; }

/* 主观题 Markdown 工具条（对齐练习页） */
.subj-area { margin-bottom: 4px; }
.toolbar { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.toolbar button { background: rgba(var(--zg-primary-rgb),.06); border: 1px solid rgba(var(--zg-primary-rgb),.15); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; color: var(--zg-text); }
.toolbar button:hover { background: rgba(var(--zg-primary-rgb),.12); }

/* 【v4.18.3】倒计时条 */
.cd-bar { display: flex; align-items: center; gap: 10px; padding: 10px 18px; margin-top: 12px; position: sticky; top: 64px; z-index: 20; border: 1px solid rgba(var(--zg-primary-rgb),.18); }
.cd-num { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--zg-primary); }
.cd-label { font-size: 13px; color: var(--zg-text-dim); }
.cd-bar.urgent { border-color: rgba(239,68,68,.5); background: rgba(239,68,68,.08); }
.cd-bar.urgent .cd-num { color: #ef4444; animation: cdPulse 1s ease-in-out infinite; }
.cd-warn { margin-left: auto; font-size: 13px; font-weight: 700; color: #ef4444; }
@keyframes cdPulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
.cd-fail { margin-top: 12px; padding: 12px 18px; border: 1px solid rgba(239,68,68,.5); background: rgba(239,68,68,.1); color: #ef4444; font-weight: 700; border-radius: 12px; }

/* 跳题高亮闪烁 */
.q-card.flash { animation: qFlash 1.8s ease; }
@keyframes qFlash {
  0%, 60% { box-shadow: 0 0 0 3px rgba(var(--zg-primary-rgb),.55); }
  100% { box-shadow: 0 0 0 0 transparent; }
}

.submit-bar { display: flex; justify-content: space-between; align-items: center; padding: 14px 22px; margin-top: 20px; position: sticky; bottom: 0; gap: 10px; flex-wrap: wrap; }
.sb-info { color: var(--zg-text-dim); font-size: 14px; }
.sb-btns { display: flex; gap: 10px; align-items: center; }

/* 答题卡 */
.ac-summary { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 14px; font-size: 13px; color: var(--zg-text-dim); }
.ac-s-item { display: inline-flex; align-items: center; gap: 6px; }
.ac-dot { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
.ac-dot.on { background: var(--zg-primary); }
.ac-dot.off { background: rgba(var(--zg-primary-rgb),.18); }
.ac-dot.flag { background: #f59e0b; }
.ac-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 8px; }
.ac-cell { aspect-ratio: 1; border-radius: 8px; border: 1.5px solid rgba(var(--zg-primary-rgb),.18); background: rgba(var(--zg-primary-rgb),.05); color: var(--zg-text); font-weight: 700; font-size: 14px; cursor: pointer; transition: all .15s; }
.ac-cell:hover { border-color: var(--zg-primary); }
.ac-cell.on { background: var(--zg-primary); border-color: var(--zg-primary); color: #fff; }
.ac-cell.flag { border-color: #f59e0b; color: #b45309; }
.ac-cell.on.flag { background: #f59e0b; border-color: #f59e0b; color: #fff; }
.ac-tip { font-size: 12px; color: var(--zg-text-dim); margin: 14px 0 0; line-height: 1.6; }

@media (max-width: 720px) {
  .q-head, .q-card { padding: 16px; }
  .submit-bar { padding: 10px 16px; }
  .cd-bar { top: 56px; padding: 8px 14px; gap: 8px; }
  .cd-num { font-size: 19px; }
  .cd-warn { margin-left: 0; width: 100%; }
  .q-card { scroll-margin-top: 150px; }
  .ac-grid { grid-template-columns: repeat(6, 1fr); }
  .ac-dialog :deep(.el-dialog) { width: 92vw !important; }
  .sb-btns { width: 100%; justify-content: space-between; }
  .sb-btns .el-button { flex: 1; }
}
</style>
