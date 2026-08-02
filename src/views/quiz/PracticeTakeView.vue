<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '@/api'
import { ElMessage } from 'element-plus'
import { renderMarkdown as md } from '@/utils/markdown'

const router = useRouter()
const route = useRoute()

const q = ref<any>(null)
const subject = ref<any>(null)
const loading = ref(true)
const answer = ref('')
const multiAns = ref<string[]>([])
const submitting = ref(false)
const result = ref<any>(null)

const qid = Number(route.params.id)

function letter(idx: number) { return String.fromCharCode(65 + idx) }

const qtypeLabel = computed(() => {
  const t = q.value?.qtype
  return t === 'single' ? '单选题' : t === 'multiple' ? '多选题' : t === 'judge' ? '判断题' : '主观题'
})

async function load() {
  loading.value = true
  try {
    const r: any = await api.subjectQuestion(qid)
    q.value = r
    subject.value = r.subject
    try {
      const res: any = await api.practiceMyResult(qid)
      if (res && res.id) result.value = res
    } catch { /* 未作答 */ }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '题目不存在')
    router.back()
  } finally { loading.value = false }
}
onMounted(load)

function toggleMulti(l: string) {
  const i = multiAns.value.indexOf(l)
  if (i >= 0) multiAns.value.splice(i, 1)
  else multiAns.value.push(l)
}

async function submit() {
  let ans = answer.value
  if (q.value.qtype === 'multiple') {
    ans = multiAns.value.slice().sort().join(',')
    if (!ans) { ElMessage.warning('请至少选择一项'); return }
  } else if (q.value.qtype !== 'subjective') {
    if (!ans) { ElMessage.warning('请选择答案'); return }
  } else {
    if (!ans.trim()) { ElMessage.warning('请输入作答内容'); return }
  }
  submitting.value = true
  try {
    const r: any = await api.submitPractice(qid, ans)
    ElMessage.success(r.status === 'graded' ? '已提交，客观题自动评分完成' : '已提交，等待教师批改')
    await load()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '提交失败')
  } finally { submitting.value = false }
}

function retry() {
  result.value = null
  answer.value = ''
  multiAns.value = []
}
</script>

<template>
  <div class="page zg-container" v-loading="loading">
    <div class="back" @click="router.back()">← 返回题目池</div>

    <div v-if="q && !result" class="glass-strong practice-box">
      <div class="pb-head">
        <span class="pb-subj">{{ subject?.icon }} {{ subject?.name }}</span>
        <el-tag size="small">{{ qtypeLabel }}</el-tag>
        <span class="pb-score">{{ q.score }} 分</span>
        <span class="pb-author" v-if="q.creator_name">出题：{{ q.creator_name }}</span>
      </div>

      <div class="pb-content q-content" v-html="md(q.content)"></div>

      <div v-if="q.attachments?.length" class="pb-att">
        <a v-for="(a, i) in q.attachments" :key="i" :href="a.url" target="_blank" class="att-link">📎 {{ a.name }}</a>
      </div>

      <!-- 客观题选项 -->
      <div v-if="q.qtype === 'single' || q.qtype === 'judge'" class="opts">
        <div v-for="(opt, idx) in q.options" :key="idx" class="opt" :class="{ on: answer === letter(idx) }" @click="answer = letter(idx)">
          <span class="opt-letter">{{ letter(idx) }}</span>
          <span>{{ opt }}</span>
        </div>
      </div>
      <div v-else-if="q.qtype === 'multiple'" class="opts">
        <div v-for="(opt, idx) in q.options" :key="idx" class="opt" :class="{ on: multiAns.includes(letter(idx)) }" @click="toggleMulti(letter(idx))">
          <span class="opt-letter">{{ letter(idx) }}</span>
          <span>{{ opt }}</span>
        </div>
      </div>
      <!-- 主观题作答 -->
      <div v-else class="subj-area">
        <div class="toolbar">
          <button @click="answer += '**加粗**'"><b>B</b></button>
          <button @click="answer += '\n- 列表项\n'">列表</button>
          <button @click="answer += '\n```\n代码\n```\n'">代码</button>
        </div>
        <el-input v-model="answer" type="textarea" :rows="8" placeholder="支持 Markdown 作答" />
      </div>

      <div class="pb-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">提交作答</el-button>
      </div>
    </div>

    <!-- 结果展示 -->
    <div v-if="q && result" class="glass-strong result-box">
      <h1 class="rb-title">🎯 训练结果</h1>
      <div class="rb-subj">{{ subject?.icon }} {{ subject?.name }} · {{ qtypeLabel }}</div>

      <div class="rb-content q-content" v-html="md(q.content)"></div>

      <div class="rb-score-row">
        <template v-if="result.status === 'graded'">
          <div class="rb-score">
            <span class="rb-num">{{ result.score }}</span>
            <span class="rb-max">/ {{ result.max_score }}</span>
          </div>
          <el-tag :type="result.correct === 1 || result.correct === true ? 'success' : 'danger'" size="large">
            {{ result.correct === 1 || result.correct === true ? '✓ 正确' : '✗ 错误' }}
          </el-tag>
        </template>
        <template v-else>
          <el-tag type="warning" size="large">⏳ 等待教师批改</el-tag>
          <span class="rb-tip">主观题已提交，批改完成后将通过站内信通知你。</span>
        </template>
      </div>

      <div class="rb-line">你的作答：</div>
      <div class="rb-answer" v-html="md(result.answer || '未作答')"></div>

      <template v-if="q.qtype !== 'subjective'">
        <div class="rb-line">正确答案：<b>{{ q.answer }}</b></div>
      </template>
      <template v-else>
        <div class="rb-line" v-if="result.comment">教师评语：{{ result.comment }}</div>
        <div class="rb-line" v-if="q.answer">参考答案：</div>
        <div class="rb-ref" v-if="q.answer" v-html="md(q.answer)"></div>
      </template>

      <div class="pb-foot">
        <el-button @click="router.back()">返回题目池</el-button>
        <el-button type="primary" @click="retry">再练一次</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { display: inline-block; margin: 16px 0 0; color: var(--zg-text-dim); cursor: pointer; }
.back:hover { color: var(--zg-primary); }
.practice-box, .result-box { padding: 28px; margin-top: 16px; }
.pb-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.pb-subj { font-weight: 700; color: var(--zg-text); }
.pb-score { color: var(--zg-primary); font-weight: 600; }
.pb-author { margin-left: auto; font-size: 12px; color: var(--zg-text-dim); }
.pb-content { font-size: 16px; line-height: 1.9; margin-bottom: 16px; }
.pb-att { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
.att-link { font-size: 13px; color: var(--zg-primary); text-decoration: underline; }
.opts { display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px; }
.opt { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 10px; background: rgba(245,158,11,.05); border: 2px solid transparent; cursor: pointer; transition: all .2s; }
.opt:hover { background: rgba(245,158,11,.1); }
.opt.on { background: rgba(245,158,11,.15); border-color: var(--zg-primary); }
.opt-letter { width: 30px; height: 30px; border-radius: 50%; background: rgba(245,158,11,.15); display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; }
.opt.on .opt-letter { background: var(--zg-primary); color: #fff; }
.subj-area { margin-bottom: 20px; }
.toolbar { display: flex; gap: 6px; margin-bottom: 8px; }
.toolbar button { background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.15); padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.pb-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.rb-title { font-size: 22px; font-weight: 800; text-align: center; }
.rb-subj { text-align: center; color: var(--zg-text-dim); margin: 6px 0 18px; font-size: 13px; }
.rb-content { font-size: 15px; line-height: 1.8; margin-bottom: 16px; }
.rb-score-row { display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; margin-bottom: 18px; }
.rb-score { display: flex; align-items: baseline; gap: 4px; }
.rb-num { font-size: 48px; font-weight: 800; color: var(--zg-primary); }
.rb-max { font-size: 18px; color: var(--zg-text-dim); }
.rb-tip { font-size: 13px; color: var(--zg-text-dim); }
.rb-line { font-size: 14px; color: var(--zg-text-dim); margin: 10px 0 6px; }
.rb-answer { padding: 12px; background: rgba(245,158,11,.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
.rb-ref { padding: 12px; background: rgba(16,185,129,.06); border-radius: 8px; font-size: 14px; line-height: 1.7; }
</style>
