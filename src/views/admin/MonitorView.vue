<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import * as echarts from 'echarts'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const loading = ref(false)
const data = ref<any>(null)
const chart1 = ref<HTMLDivElement>()
const chart2 = ref<HTMLDivElement>()
let c1: echarts.ECharts | null = null
let c2: echarts.ECharts | null = null
let timer: any = null

async function load() {
  loading.value = true
  try {
    data.value = await api.monitor() as any
    renderCharts()
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载监控数据失败')
  } finally {
    loading.value = false
  }
}

function renderCharts() {
  if (!data.value) return
  // 7天活跃趋势图
  if (chart1.value) {
    if (!c1) c1 = echarts.init(chart1.value)
    c1.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { textStyle: { color: '#78350F' }, top: 0 },
      grid: { left: 40, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: data.value.dailyActive.map((d: any) => d.date),
        axisLabel: { color: '#78350F' },
        axisLine: { lineStyle: { color: 'rgba(245,158,11,.3)' } }
      },
      yAxis: [
        {
          type: 'value', name: '活跃用户',
          axisLabel: { color: '#78350F' },
          splitLine: { lineStyle: { color: 'rgba(245,158,11,.12)' } }
        },
        {
          type: 'value', name: '美文数',
          axisLabel: { color: '#78350F' },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          name: '活跃用户', type: 'bar',
          data: data.value.dailyActive.map((d: any) => d.users),
          itemStyle: { color: '#f59e0b', borderRadius: [6, 6, 0, 0] }
        },
        {
          name: '美文数', type: 'line', yAxisIndex: 1, smooth: true,
          data: data.value.dailyActive.map((d: any) => d.articles),
          itemStyle: { color: '#ef4444' },
          lineStyle: { width: 3 },
          areaStyle: { color: 'rgba(239,68,68,.12)' }
        }
      ]
    })
  }
  // 服务器饼图
  if (chart2.value) {
    if (!c2) c2 = echarts.init(chart2.value)
    c2.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { textStyle: { color: '#78350F' }, bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
        label: { color: '#78350F', formatter: '{b}\n{d}%' },
        data: [
          { name: '已用内存', value: data.value.server.usedMem, itemStyle: { color: '#f59e0b' } },
          { name: '空闲内存', value: data.value.server.freeMem, itemStyle: { color: '#34d399' } },
        ],
        itemStyle: { borderColor: 'rgba(245,158,11,.3)', borderWidth: 2 }
      }]
    })
  }
}

const tableNameZh: Record<string, string> = {
  users: '用户', classes: '班级', class_members: '班级成员', subjects: '学科',
  articles: '美文', resources: '资料', query_tasks: '查询任务', query_rows: '查询数据行',
  exp_logs: '经验流水', notices: '通知', pages: '通用页面(公告/博客)', page_comments: '页面评论',
  messages: '站内信', quizzes: '题库', quiz_questions: '题目', quiz_submissions: '答题记录',
  subject_questions: '单题训练题', practice_submissions: '训练提交', likes_map: '点赞收藏',
}

function resize() { c1?.resize(); c2?.resize() }

onMounted(async () => {
  await load()
  // 自动刷新：30秒一次
  timer = setInterval(load, 30000)
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  window.removeEventListener('resize', resize)
  c1?.dispose(); c2?.dispose()
})

function pctBar(pct: number, color = '#f59e0b') {
  return `background:linear-gradient(90deg, ${color} ${pct}%, rgba(245,158,11,.08) ${pct}%);border-radius:8px;padding:4px 10px;font-weight:700;`
}
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <h1 class="dh-title">🖥️ 网站运行监控</h1>
      <div>
        <el-button @click="load" :loading="loading">🔄 刷新</el-button>
        <span class="auto-refresh-hint">自动每30秒刷新</span>
      </div>
    </div>

    <template v-if="data">
      <!-- 在线状态 -->
      <div class="section-title">👥 实时在线 & 今日概览</div>
      <div class="stat-grid">
        <div class="stat-card glass zg-card online">
          <div class="sc-icon">🟢</div>
          <div>
            <div class="sc-num big">{{ data.online.online5min }}</div>
            <div class="sc-label">最近5分钟在线</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">🕒</div>
          <div>
            <div class="sc-num">{{ data.online.online1hour }}</div>
            <div class="sc-label">最近1小时活跃</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">👥</div>
          <div>
            <div class="sc-num">{{ data.online.activeUsers }} / {{ data.online.totalUsers }}</div>
            <div class="sc-label">活跃用户 / 总用户</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">🔐</div>
          <div>
            <div class="sc-num">{{ data.online.todayLogins }}</div>
            <div class="sc-label">今日登录人次</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">✍️</div>
          <div>
            <div class="sc-num">{{ data.online.todayArticles }}</div>
            <div class="sc-label">今日发布美文</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">📦</div>
          <div>
            <div class="sc-num">{{ data.online.todayResources }}</div>
            <div class="sc-label">今日上传资料</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon">⭐</div>
          <div>
            <div class="sc-num">{{ data.online.todayExps }}</div>
            <div class="sc-label">今日发放经验值</div>
          </div>
        </div>
        <div class="stat-card glass zg-card pending">
          <div class="sc-icon">⏳</div>
          <div>
            <div class="sc-num">{{ data.pending.articles + data.pending.resources }}</div>
            <div class="sc-label">待审核（美文{{ data.pending.articles }} / 资料{{ data.pending.resources }}）</div>
          </div>
        </div>
      </div>

      <!-- 服务器状态 -->
      <div class="section-title">🖥️ 服务器运行状态</div>
      <div class="row">
        <div class="glass info-panel server">
          <div class="ip-title">💻 系统信息</div>
          <div class="kv"><span class="k">主机名</span><span class="v">{{ data.server.hostname }}</span></div>
          <div class="kv"><span class="k">系统</span><span class="v">{{ data.server.platform }} / {{ data.server.arch }}</span></div>
          <div class="kv"><span class="k">CPU</span><span class="v">{{ data.server.cpuModel }}</span></div>
          <div class="kv"><span class="k">核心数</span><span class="v">{{ data.server.cpuCores }} 核</span></div>
          <div class="kv"><span class="k">系统运行</span><span class="v strong">{{ data.server.serverUptimeFmt }}</span></div>
          <div class="kv"><span class="k">Node运行</span><span class="v strong">{{ data.server.nodeUptimeFmt }}</span></div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title">⚡ CPU & 内存负载</div>
          <div class="bar-row">
            <div class="br-label">1分钟负载</div>
            <div class="br-bar">{{ data.server.loadAvg1.toFixed(2) }}</div>
          </div>
          <div class="bar-row">
            <div class="br-label">5分钟负载</div>
            <div class="br-bar">{{ data.server.loadAvg5.toFixed(2) }}</div>
          </div>
          <div class="bar-row">
            <div class="br-label">15分钟负载</div>
            <div class="br-bar">{{ data.server.loadAvg15.toFixed(2) }}</div>
          </div>
          <div class="bar-row">
            <div class="br-label">内存使用率</div>
            <div class="br-bar" :style="pctBar(data.server.memUsagePct, data.server.memUsagePct>80?'#ef4444':'#f59e0b')">
              {{ data.server.memUsagePct }}% · {{ data.server.usedMemFmt }} / {{ data.server.totalMemFmt }}
            </div>
          </div>
          <div class="bar-row">
            <div class="br-label">Node堆内存</div>
            <div class="br-bar" :style="pctBar(data.server.nodeHeapPct, '#f97316')">
              {{ data.server.nodeHeapPct }}% · {{ data.server.nodeHeapUsedFmt }} / {{ data.server.nodeHeapTotalFmt }}
            </div>
          </div>
          <div class="bar-row">
            <div class="br-label">Node总占用(RSS)</div>
            <div class="br-bar">{{ data.server.nodeRssFmt }}</div>
          </div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title">💾 数据库 SQLite</div>
          <div class="kv"><span class="k">数据库文件</span><span class="v strong">{{ data.database.fileSizeFmt }}</span></div>
          <div class="tables">
            <div v-for="(n, t) of data.database.tables" :key="t" class="tbl-row">
              <span class="tbl-name">{{ tableNameZh[t] || t }}</span>
              <span class="tbl-num">{{ n.toLocaleString() }} 条</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 图表 -->
      <div class="section-title">📈 趋势分析</div>
      <div class="chart-row">
        <div class="chart-card glass">
          <div class="cc-title">最近 7 天活跃趋势</div>
          <div ref="chart1" class="chart"></div>
        </div>
        <div class="chart-card glass">
          <div class="cc-title">内存分配占比</div>
          <div ref="chart2" class="chart"></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
.dh-title { font-size:24px; font-weight:800; }
.auto-refresh-hint { font-size:12px; color:var(--zg-text-dim); margin-left:8px; }
.section-title { font-size:18px; font-weight:700; margin:28px 0 14px; display:flex; align-items:center; gap:8px; }
.section-title::before { content:''; width:3px; height:16px; border-radius:3px; background:linear-gradient(180deg,var(--zg-accent),var(--zg-primary)); }

.stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
.stat-card { display:flex; align-items:center; gap:14px; padding:18px; }
.stat-card.online { border:2px solid rgba(16,185,129,.3); background:rgba(16,185,129,.05); }
.stat-card.pending { border:2px solid rgba(239,68,68,.3); }
.sc-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; background:rgba(245,158,11,.1); }
.sc-num { font-size:22px; font-weight:800; color:var(--zg-accent); }
.sc-num.big { font-size:30px; color:#10b981; }
.sc-label { font-size:12px; color:var(--zg-text-dim); }

.row { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
.info-panel { padding:20px; display:flex; flex-direction:column; gap:8px; }
.ip-title { font-weight:700; font-size:15px; margin-bottom:6px; }
.kv { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; border-bottom:1px dashed rgba(245,158,11,.1); }
.kv:last-child { border-bottom:none; }
.k { color:var(--zg-text-dim); }
.v { color:var(--zg-text); text-align:right; max-width:60%; word-break:break-all; }
.v.strong { font-weight:700; color:var(--zg-primary); }

.bar-row { display:flex; align-items:center; gap:12px; margin:4px 0; }
.br-label { width:110px; font-size:12px; color:var(--zg-text-dim); flex-shrink:0; }
.br-bar { flex:1; padding:4px 10px; font-size:12px; background:rgba(245,158,11,.08); border-radius:8px; font-weight:600; }

.tables { margin-top:6px; max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
.tbl-row { display:flex; justify-content:space-between; padding:5px 8px; font-size:12px; border-radius:6px; }
.tbl-row:nth-child(odd) { background:rgba(245,158,11,.05); }
.tbl-name { color:var(--zg-text-dim); }
.tbl-num { font-weight:700; color:var(--zg-accent); }

.chart-row { display:grid; grid-template-columns:1.3fr 1fr; gap:20px; margin-top:16px; }
.chart-card { padding:20px; }
.cc-title { font-weight:700; margin-bottom:12px; }
.chart { height:300px; }

@media (max-width:1100px){
  .row { grid-template-columns:1fr; }
  .chart-row { grid-template-columns:1fr; }
}
@media (max-width:768px){
  .stat-grid { grid-template-columns:repeat(2,1fr); gap:10px; }
  .stat-card { padding:14px; gap:10px; }
  .sc-icon { width:40px; height:40px; font-size:20px; }
  .sc-num { font-size:18px; }
  .sc-num.big { font-size:24px; }
  .info-panel { padding:16px; }
  .chart { height:220px; }
  .dh-title { font-size:20px; }
}
</style>
