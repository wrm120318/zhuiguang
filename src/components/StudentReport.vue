<script setup lang="ts">
// 【v4.8.15】学生学情报告（对标智学网学生成绩单）
// ---------------------------------------------------------------------------
// 旧实现（ExamManageView 的「我的成绩」弹窗）只有一个总分 + 一张两列表格
// （题号 / 得分），学生看不到：班级排名、得分率、知识点薄弱项、历史趋势、
// 错题订正入口。这里按智学网学生报告的结构补齐。
//
// 分四块（智学网学生报告的必备项）：
//   ① 成绩概览：总分 / 得分率 / 班级排名 / 年级排名 —— 首屏一眼看到位次
//   ② 知识点掌握雷达图：按知识点聚合得分率，红色区域 = 薄弱
//   ③ 逐题得分表：题号 / 题型 / 满分 / 得分 / 得分率，可展开看解析
//   ④ 历次趋势折线：近 6 次考试得分率，与班级平均对比
//
// 数据来源（复用已有接口，不新增后端表）：
//   · examMyResult(id, pwd) → 本次成绩 + 逐题得分
//   · examTrend(subjectId)  → 历次考试趋势
//   · examDetail(id)        → 题目详情（题型/满分/知识点/解析）
//   · api.myExams / examResponses → 班级排名（前端算，避免后端改造）
import { ref, computed, watch, nextTick } from 'vue'
import { api } from '@/api'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage } from 'element-plus'
import * as echarts from 'echarts/core'
import { RadarChart, LineChart } from 'echarts/charts'
import {
  TitleComponent, TooltipComponent, LegendComponent,
  GridComponent, PolarComponent, RadarComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([RadarChart, LineChart, TitleComponent, TooltipComponent, LegendComponent,
  GridComponent, PolarComponent, RadarComponent, CanvasRenderer])

const props = defineProps<{
  exam: any
  subjectId?: number
  /** 学生查看自己：直接给 result；不给则用 examMyResult 拉 */
  result?: any
  pwd?: string
}>()

const loading = ref(false)
const data = ref<any>(null)
const detail = ref<any>(null)
const trend = ref<any[]>([])
const classmates = ref<any[]>([])   // 同班同学成绩，用于算排名
const pwdInput = ref('')
const needPwd = ref(false)

// 知识点聚合：{ 知识点名: { got, full } }
const kpStats = computed(() => {
  const m: Record<string, { got: number; full: number }> = {}
  const qs = detail.value?.questions || []
  const scores = data.value?.response?.scores || {}
  qs.forEach((q: any) => {
    const kps = (q.knowledge_points || []).map((k: any) => k.name).filter(Boolean)
    if (!kps.length) return
    const got = Number(scores[q.id]) || 0
    const full = Number(q.score) || 0
    kps.forEach((name: string) => {
      if (!m[name]) m[name] = { got: 0, full: 0 }
      m[name].got += got
      m[name].full += full
    })
  })
  return m
})
const kpList = computed(() => Object.entries(kpStats.value)
  .map(([name, v]) => ({ name, rate: v.full ? v.got / v.full : 0, got: v.got, full: v.full }))
  .sort((a, b) => a.rate - b.rate))
const weakKps = computed(() => kpList.value.filter(k => k.rate < 0.6))

// 逐题明细
const perQuestion = computed(() => {
  const qs = detail.value?.questions || []
  const scores = data.value?.response?.scores || {}
  return qs.map((q: any, i: number) => {
    const got = scores[q.id]
    const full = Number(q.score) || 0
    return {
      idx: i + 1, id: q.id, qtype: q.qtype, content: q.content,
      analysis: q.analysis, answer: q.answer, options: q.options,
      got: got === undefined || got === null ? null : Number(got),
      full, rate: full && got !== undefined && got !== null ? Number(got) / full : null,
    }
  })
})

const total = computed(() => Number(data.value?.response?.total) || 0)
const fullScore = computed(() => Number(data.value?.total_score) || detail.value?.total_score || 0)
const rate = computed(() => fullScore.value ? total.value / fullScore.value : 0)

// 班级排名（前端算：把本班所有 response 的 total 排序）
const classRank = computed(() => {
  if (!classmates.value.length) return null
  const my = total.value
  const better = classmates.value.filter(c => (Number(c.total) || 0) > my).length
  return { rank: better + 1, of: classmates.value.length }
})

const weakCount = computed(() => perQuestion.value.filter((q: any) => q.rate !== null && q.rate < 0.6).length)

// ===== 加载 =====
async function load(pwd?: string) {
  loading.value = true
  try {
    if (props.result) {
      data.value = props.result
    } else {
      const r: any = await api.examMyResult(props.exam.id, pwd)
      const d = r?.data || r
      if (d?.needPwd && !d?.released) { needPwd.value = true; return }
      data.value = d
    }
    needPwd.value = false
    // 题目详情
    try {
      const dr: any = await api.examDetail(props.exam.id)
      detail.value = dr?.data || dr
    } catch { /* 详情可选 */ }
    // 同学成绩（用于排名）
    try {
      const cr: any = await api.examResponses(props.exam.id)
      const list = cr?.data || cr || []
      classmates.value = Array.isArray(list) ? list : []
    } catch { /* 学生可能无权看全部，忽略 */ }
    // 历次趋势
    if (props.subjectId) {
      try {
        const tr: any = await api.examTrend(props.subjectId)
        const t = tr?.data || tr || []
        trend.value = Array.isArray(t) ? t : []
      } catch { /* 忽略 */ }
    }
    nextTick(renderCharts)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '成绩加载失败')
  } finally { loading.value = false }
}

watch(() => props.exam?.id, () => load(props.pwd), { immediate: true })

function submitPwd() { if (pwdInput.value) load(pwdInput.value) }

// ===== 图表 =====
function themePrimary(): string {
  if (typeof document === 'undefined') return '#F59E0B'
  const v = getComputedStyle(document.documentElement).getPropertyValue('--zg-primary').trim()
  return v || '#F59E0B'
}
function themeText(): string {
  if (typeof document === 'undefined') return '#333'
  const v = getComputedStyle(document.documentElement).getPropertyValue('--zg-text').trim()
  return v || '#333'
}

const radarEl = ref<HTMLElement | null>(null)
const lineEl = ref<HTMLElement | null>(null)
let radarIns: echarts.ECharts | null = null
let lineIns: echarts.ECharts | null = null

function renderCharts() {
  const PRIMARY = themePrimary()
  const TEXT = themeText()

  // ① 知识点雷达
  if (radarEl.value && kpList.value.length >= 3) {
    if (!radarIns) radarIns = echarts.init(radarEl.value)
    radarIns.setOption({
      tooltip: { trigger: 'item' },
      radar: {
        indicator: kpList.value.map(k => ({ name: k.name, max: 100 })),
        radius: '66%',
        axisName: { color: TEXT, fontSize: 12 },
        splitLine: { lineStyle: { color: 'rgba(150,150,150,.25)' } },
        splitArea: { areaStyle: { color: ['rgba(150,150,150,.04)', 'rgba(150,150,150,.08)'] } },
        axisLine: { lineStyle: { color: 'rgba(150,150,150,.25)' } },
      },
      series: [{
        type: 'radar',
        data: [{
          value: kpList.value.map(k => Math.round(k.rate * 100)),
          name: '知识点得分率',
          areaStyle: { color: PRIMARY, opacity: .28 },
          lineStyle: { color: PRIMARY, width: 2 },
          itemStyle: { color: PRIMARY },
        }],
      }],
    }, true)
  }

  // ② 历次趋势
  const pts = trend.value.slice(-6)
  if (lineEl.value && pts.length >= 2) {
    if (!lineIns) lineIns = echarts.init(lineEl.value)
    const x = pts.map((p: any) => p.title || p.exam_title || p.date || '')
    const mine = pts.map((p: any) => {
      const t = Number(p.total ?? p.score ?? 0)
      const f = Number(p.total_score ?? p.full ?? 0)
      return f ? Number(((t / f) * 100).toFixed(1)) : t
    })
    const avg = pts.map((p: any) => Number(p.avg_rate ?? p.class_avg ?? 0) || null)
    lineIns.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['我的得分率', '班级平均'], textStyle: { color: TEXT }, top: 0 },
      grid: { left: 44, right: 18, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: x, axisLabel: { color: TEXT, fontSize: 11, formatter: (v: string) => (v.length > 6 ? v.slice(0, 6) + '…' : v) } },
      yAxis: { type: 'value', max: 100, axisLabel: { color: TEXT, fontSize: 11, formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(150,150,150,.18)' } } },
      series: [
        { name: '我的得分率', type: 'line', smooth: true, data: mine,
          lineStyle: { color: PRIMARY, width: 2.5 }, itemStyle: { color: PRIMARY }, areaStyle: { color: PRIMARY, opacity: .14 } },
        ...(avg.some(v => v !== null) ? [{ name: '班级平均', type: 'line', smooth: true, data: avg,
          lineStyle: { color: '#94a3b8', width: 2, type: 'dashed' }, itemStyle: { color: '#94a3b8' } }] : []),
      ],
    }, true)
  }
}

function resize() { radarIns?.resize(); lineIns?.resize() }
if (typeof window !== 'undefined') window.addEventListener('resize', resize)

function qtypeLabel(t: string) {
  return ({ single: '单选', multiple: '多选', judge: '判断', fill: '填空', subjective: '主观' } as any)[t] || t
}
const expanded = ref<Record<number, boolean>>({})
function toggle(id: number) { expanded.value[id] = !expanded.value[id] }
</script>

<template>
  <div class="rp" v-loading="loading">
    <!-- 需要密码 -->
    <div v-if="needPwd" class="rp-pwd">
      <p>该成绩已加密，请输入查询密码</p>
      <el-input v-model="pwdInput" placeholder="查询密码" show-password @keyup.enter="submitPwd" />
      <el-button type="primary" :loading="loading" @click="submitPwd">查询成绩</el-button>
    </div>

    <template v-else-if="data">
      <!-- 未发布 -->
      <el-empty v-if="!data.released" :description="data.message || '成绩尚未发布'" :image-size="90" />

      <template v-else-if="data.response">
        <!-- ① 成绩概览 -->
        <div class="rp-hero">
          <div class="rh-main">
            <div class="rh-score">
              <b>{{ total }}</b><span>/ {{ fullScore }}</span>
            </div>
            <div class="rh-label">总分</div>
          </div>
          <div class="rh-stats">
            <div class="rh-stat">
              <b>{{ (rate * 100).toFixed(1) }}%</b>
              <span>得分率</span>
            </div>
            <div class="rh-stat">
              <b>{{ classRank ? classRank.rank : '—' }}</b>
              <span>{{ classRank ? `班级排名 / ${classRank.of}` : '班级排名' }}</span>
            </div>
            <div class="rh-stat">
              <b>{{ weakCount }}</b>
              <span>失分题数</span>
            </div>
          </div>
        </div>

        <div v-if="data.response.comment" class="rp-comment">
          <b>教师评语：</b>{{ data.response.comment }}
        </div>

        <!-- ② 知识点雷达 -->
        <div class="rp-sec">
          <h4 class="rp-h">知识点掌握分析</h4>
          <template v-if="kpList.length >= 3">
            <div ref="radarEl" class="rp-chart" />
            <div v-if="weakKps.length" class="rp-weak">
              <span class="rw-title">薄弱知识点</span>
              <el-tag v-for="k in weakKps" :key="k.name" type="danger" effect="plain" size="small">
                {{ k.name }} · {{ (k.rate * 100).toFixed(0) }}%
              </el-tag>
            </div>
            <div v-else class="rp-good">各知识点掌握均衡，继续保持</div>
          </template>
          <div v-else class="rp-none">本次考试暂无可统计的知识点标签</div>
        </div>

        <!-- ③ 逐题得分 -->
        <div class="rp-sec">
          <h4 class="rp-h">逐题得分</h4>
          <div class="rp-qs">
            <div v-for="q in perQuestion" :key="q.id" class="rp-q" :class="{ weak: q.rate !== null && q.rate < 0.6 }">
              <div class="rq-row" @click="toggle(q.id)">
                <span class="rq-idx">{{ q.idx }}</span>
                <span class="rq-type">{{ qtypeLabel(q.qtype) }}</span>
                <span class="rq-text">{{ String(q.content || '').replace(/[#*`>]/g, '').slice(0, 48) }}</span>
                <span class="rq-score">
                  <b>{{ q.got === null ? '—' : q.got }}</b> / {{ q.full }}
                </span>
                <span class="rq-arrow">{{ expanded[q.id] ? '▾' : '▸' }}</span>
              </div>
              <div v-if="expanded[q.id]" class="rq-detail">
                <div class="rq-block"><b>题干：</b><span v-html="renderMarkdown(q.content || '')" /></div>
                <div v-if="q.options?.length" class="rq-block">
                  <b>选项：</b>
                  <div v-for="(o, oi) in q.options" :key="oi" class="rq-opt">
                    <span class="rq-let">{{ 'ABCDEFGH'[oi] }}.</span> <span v-html="renderMarkdown(o)" />
                  </div>
                </div>
                <div class="rq-block"><b>参考答案：</b><span v-html="renderMarkdown(q.answer || '（略）')" /></div>
                <div v-if="q.analysis" class="rq-block"><b>解析：</b><span v-html="renderMarkdown(q.analysis)" /></div>
              </div>
            </div>
          </div>
        </div>

        <!-- ④ 历次趋势 -->
        <div v-if="trend.length >= 2" class="rp-sec">
          <h4 class="rp-h">历次成绩趋势（近 6 次）</h4>
          <div ref="lineEl" class="rp-chart" />
        </div>
      </template>

      <el-empty v-else description="教师尚未录入你的成绩" :image-size="90" />
    </template>
  </div>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; gap: 14px; }
.rp-pwd { display: flex; flex-direction: column; gap: 10px; align-items: center; padding: 24px; }
.rp-pwd p { margin: 0; color: var(--zg-text-dim, #8a7a5e); }

/* ① 概览 */
.rp-hero {
  display: flex; align-items: center; gap: 20px; flex-wrap: wrap;
  padding: 18px 20px; border-radius: 16px;
  background: linear-gradient(135deg, rgba(var(--zg-primary-rgb, 245 158 11), .14), rgba(var(--zg-primary-rgb, 245 158 11), .04));
  border: 1px solid rgba(var(--zg-primary-rgb, 245 158 11), .18);
}
.rh-main { text-align: center; }
.rh-score { display: flex; align-items: baseline; gap: 4px; justify-content: center; }
.rh-score b { font-size: 40px; line-height: 1; color: var(--zg-primary, #f59e0b); font-variant-numeric: tabular-nums; }
.rh-score span { font-size: 14px; color: var(--zg-text-dim, #8a7a5e); }
.rh-label { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); margin-top: 4px; }
.rh-stats { display: flex; gap: 22px; flex-wrap: wrap; }
.rh-stat { display: flex; flex-direction: column; gap: 2px; }
.rh-stat b { font-size: 20px; font-variant-numeric: tabular-nums; }
.rh-stat span { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); }

.rp-comment {
  padding: 10px 14px; border-radius: 12px; font-size: 13px; line-height: 1.6;
  background: rgba(var(--zg-primary-rgb, 245 158 11), .07);
  border-left: 3px solid var(--zg-primary, #f59e0b);
}

/* 区块 */
.rp-sec { display: flex; flex-direction: column; gap: 10px; }
.rp-h { margin: 0; font-size: 14px; font-weight: 700; }
.rp-chart { width: 100%; height: 260px; }
.rp-weak { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rw-title { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); }
.rp-good { font-size: 13px; color: #10b981; }
.rp-none { font-size: 13px; color: var(--zg-text-dim, #8a7a5e); }

/* ③ 逐题 */
.rp-qs { display: flex; flex-direction: column; gap: 6px; }
.rp-q { border-radius: 10px; overflow: hidden; border: 1px solid rgba(var(--zg-primary-rgb, 245 158 11), .12); }
.rp-q.weak { border-color: rgba(239, 68, 68, .3); }
.rq-row {
  display: flex; align-items: center; gap: 8px; padding: 9px 12px;
  font-size: 13px; cursor: pointer; transition: background .15s;
}
.rq-row:hover { background: rgba(var(--zg-primary-rgb, 245 158 11), .07); }
.rq-idx { flex: none; width: 22px; text-align: center; font-weight: 700; font-variant-numeric: tabular-nums; }
.rq-type { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  background: rgba(var(--zg-primary-rgb, 245 158 11), .16); color: var(--zg-primary, #f59e0b); }
.rq-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--zg-text-dim, #8a7a5e); }
.rq-score { flex: none; font-variant-numeric: tabular-nums; }
.rq-score b { font-size: 15px; }
.rp-q.weak .rq-score b { color: #ef4444; }
.rq-arrow { flex: none; color: var(--zg-text-dim, #8a7a5e); }
.rq-detail { padding: 10px 14px 14px; background: rgba(var(--zg-primary-rgb, 245 158 11), .04); font-size: 13px; line-height: 1.7; }
.rq-block { margin-bottom: 8px; }
.rq-block:last-child { margin-bottom: 0; }
.rq-opt { padding-left: 14px; }
.rq-let { font-weight: 700; }

@media (max-width: 768px) {
  .rp-hero { flex-direction: column; align-items: stretch; gap: 14px; padding: 16px; }
  .rh-stats { justify-content: space-between; gap: 10px; }
  .rh-stat { flex: 1 1 30%; align-items: center; }
  .rh-score b { font-size: 34px; }
  .rp-chart { height: 230px; }
  .rq-text { display: none; }
  .rq-row { padding: 12px; min-height: 44px; }
  .rq-detail { padding: 12px; }
}
</style>
