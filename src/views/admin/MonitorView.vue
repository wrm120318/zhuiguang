<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
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
let renderRetryTimer: any = null

async function load() {
  loading.value = true
  try {
    data.value = await api.monitor() as any
    await nextTick()
    scheduleRender(0)
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || '加载监控数据失败')
  } finally {
    loading.value = false
  }
}

function scheduleRender(attempt: number) {
  if (attempt > 3) return
  const r1 = document.querySelector<HTMLElement>('[data-chart="c1"]') || chart1.value
  const r2 = document.querySelector<HTMLElement>('[data-chart="c2"]') || chart2.value
  if (r1 || r2 || attempt > 0) {
    renderCharts()
  }
  if ((!chart1.value || !chart2.value) && attempt < 3) {
    renderRetryTimer = setTimeout(() => scheduleRender(attempt + 1), 300)
  }
}

function renderCharts() {
  if (!data.value) return
  const dom1 = chart1.value || document.querySelector<HTMLElement>('[data-chart="c1"]')
  const dom2 = chart2.value || document.querySelector<HTMLElement>('[data-chart="c2"]')
  // 7天活跃趋势图
  if (dom1) {
    if (!c1) c1 = echarts.init(dom1 as any)
    else c1.resize()
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
        { type: 'value', name: '活跃用户', axisLabel: { color: '#78350F' }, splitLine: { lineStyle: { color: 'rgba(245,158,11,.12)' } } },
        { type: 'value', name: '美文数', axisLabel: { color: '#78350F' }, splitLine: { show: false } }
      ],
      series: [
        { name: '活跃用户', type: 'bar', data: data.value.dailyActive.map((d: any) => d.users), itemStyle: { color: '#f59e0b', borderRadius: [6, 6, 0, 0] } },
        { name: '美文数', type: 'line', yAxisIndex: 1, smooth: true, data: data.value.dailyActive.map((d: any) => d.articles), itemStyle: { color: '#ef4444' }, lineStyle: { width: 3 }, areaStyle: { color: 'rgba(239,68,68,.12)' } }
      ]
    }, true)
    requestAnimationFrame(() => c1?.resize())
  }
  // 学科内容分布饼图
  if (dom2) {
    if (!c2) c2 = echarts.init(dom2 as any)
    else c2.resize()
    const pieData = (data.value.subjectDist || []).map((s: any) => ({
      name: s.name, value: s.value
    }))
    c2.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { textStyle: { color: '#78350F' }, bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
        label: { color: '#78350F', formatter: '{b}\n{d}%' },
        data: pieData.length > 0 ? pieData : [{ name: '暂无数据', value: 1, itemStyle: { color: '#e5e7eb' } }],
        itemStyle: { borderColor: 'rgba(245,158,11,.3)', borderWidth: 2 }
      }]
    }, true)
    requestAnimationFrame(() => c2?.resize())
  }
}

watch([data, chart1, chart2], ([nv, c1d, c2d]) => {
  if (nv && (c1d || c2d)) {
    nextTick(() => {
      renderCharts()
      requestAnimationFrame(() => resize())
    })
  }
}, { flush: 'post' })

const tableNameZh: Record<string, string> = {
  users: '用户', classes: '班级', class_members: '班级成员', subjects: '学科',
  articles: '美文', resources: '资料', query_tasks: '查询任务', query_rows: '查询数据行',
  exp_logs: '经验流水', notices: '通知', pages: '通用页面(公告/博客)', page_comments: '页面评论',
  messages: '站内信', quizzes: '题库', quiz_questions: '题目', quiz_submissions: '答题记录',
  subject_questions: '单题训练题', practice_submissions: '训练提交', likes_map: '点赞收藏',
}

const totalTableRows = computed(() => {
  if (!data.value?.database?.tables) return 0
  return Object.values(data.value.database.tables).reduce((s: number, n: any) => s + Number(n), 0)
})

function resize() { c1?.resize(); c2?.resize() }

onMounted(async () => {
  await load()
  timer = setInterval(load, 15000)
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (renderRetryTimer) clearTimeout(renderRetryTimer)
  window.removeEventListener('resize', resize)
  c1?.dispose(); c2?.dispose()
})
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <h1 class="dh-title">🖥️ 网站运行监控</h1>
      <div>
        <el-button @click="load" :loading="loading">🔄 刷新</el-button>
        <span class="auto-refresh-hint">自动每15秒刷新</span>
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

      <!-- Cloudflare 平台状态 + 用户角色分布 -->
      <div class="section-title">☁️ Cloudflare 平台状态</div>
      <div class="row">
        <div class="glass info-panel">
          <div class="ip-title">🌐 运行环境</div>
          <div class="kv"><span class="k">运行时</span><span class="v strong">{{ data.platform.runtime }}</span></div>
          <div class="kv"><span class="k">边缘节点</span><span class="v strong">{{ data.platform.colo }}</span></div>
          <div class="kv"><span class="k">访问地区</span><span class="v">{{ data.platform.country }}</span></div>
          <div class="kv"><span class="k">HTTP协议</span><span class="v">{{ data.platform.httpProtocol }}</span></div>
          <div class="kv"><span class="k">TLS加密</span><span class="v">{{ data.platform.tlsVersion }}</span></div>
          <div class="kv"><span class="k">边缘部署</span><span class="v strong" style="color:#10b981;">✅ 是</span></div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title">📊 套餐限制</div>
          <div class="kv"><span class="k">D1数据库区域</span><span class="v">{{ data.platform.d1Region }}</span></div>
          <div class="kv"><span class="k">D1容量上限</span><span class="v strong">{{ data.platform.d1SizeLimit }}</span></div>
          <div class="kv"><span class="k">Worker CPU</span><span class="v">{{ data.platform.workerCpuLimit }}</span></div>
          <div class="kv"><span class="k">子请求限制</span><span class="v">{{ data.platform.workerSubrequests }}</span></div>
          <div class="kv"><span class="k">每日请求</span><span class="v">100,000 次 (免费)</span></div>
          <div class="kv"><span class="k">费用</span><span class="v strong" style="color:#10b981;">¥0 不绑卡</span></div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title">👤 用户角色分布</div>
          <div v-for="r of data.roleDist" :key="r.name" class="role-row">
            <span class="role-name">{{ r.name }}</span>
            <span class="role-bar">
              <span class="role-bar-fill" :style="{ width: (r.value / data.online.totalUsers * 100) + '%' }"></span>
            </span>
            <span class="role-num">{{ r.value }} 人</span>
          </div>
        </div>
      </div>

      <!-- D1 数据库状态 -->
      <div class="section-title">💾 D1 数据库状态</div>
      <div class="db-row">
        <div class="glass info-panel db-info">
          <div class="ip-title">🗄️ 数据库概况</div>
          <div class="kv"><span class="k">数据库</span><span class="v strong">Cloudflare D1</span></div>
          <div class="kv"><span class="k">已用空间</span><span class="v strong">{{ data.database.fileSizeFmt }}</span></div>
          <div class="kv"><span class="k">总记录数</span><span class="v strong">{{ totalTableRows.toLocaleString() }} 条</span></div>
          <div class="kv"><span class="k">表数量</span><span class="v">{{ Object.keys(data.database.tables).length }} 张</span></div>
        </div>
        <div class="glass info-panel db-tables">
          <div class="ip-title">📋 各表数据量</div>
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
          <div ref="chart1" data-chart="c1" class="chart"></div>
        </div>
        <div class="chart-card glass">
          <div class="cc-title">学科内容分布</div>
          <div ref="chart2" data-chart="c2" class="chart"></div>
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

.role-row { display:flex; align-items:center; gap:10px; padding:6px 0; }
.role-name { width:80px; font-size:13px; flex-shrink:0; }
.role-bar { flex:1; height:20px; background:rgba(245,158,11,.08); border-radius:10px; overflow:hidden; }
.role-bar-fill { display:block; height:100%; background:linear-gradient(90deg,#f59e0b,#fbbf24); border-radius:10px; transition:width .3s; }
.role-num { width:60px; font-size:13px; font-weight:700; text-align:right; flex-shrink:0; }

.db-row { display:grid; grid-template-columns:300px 1fr; gap:16px; }
.db-info { padding:20px; }
.db-tables { padding:20px; }
.tables { margin-top:6px; max-height:280px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
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
  .db-row { grid-template-columns:1fr; }
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
