<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue'
import * as echarts from 'echarts'
import { api } from '@/api'
import { useRouter } from 'vue-router'
import { ElMessageBox, ElMessage } from 'element-plus'
import { useThemeStore } from '@/store/theme'

const router = useRouter()
const theme = useThemeStore()
const features = [
  { name: '用户管理', icon: '👥', desc: '添加/删除/禁用用户、调整经验等级、重置密码', color: '#F59E0B', to: () => router.push('/admin/users') },
  { name: '学科管理', icon: '📚', desc: '创建/编辑/删除学科，配置模块，发布公告', color: '#FBBF24', to: () => router.push('/admin/subjects') },
  { name: '班级管理', icon: '🏫', desc: '班级增删改，管理学生成员，配置教师', color: '#FB923C', to: () => router.push('/admin/classes') },
  { name: '内容审核', icon: '✅', desc: '美文、资料审核发布，支持驳回删除操作', color: '#10B981', to: () => router.push('/admin/audit') },
  { name: '数据查询', icon: '📈', desc: '创建成绩查询任务，支持姓名匹配、导出', color: '#60A5FA', to: () => router.push('/admin/query') },
  { name: '界面风格', icon: '🎨', desc: '主题色、背景、动画配置，一键切换风格', color: '#A78BFA', to: () => router.push('/admin/theme') },
  { name: '群发通知', icon: '📢', desc: '向全站活跃用户推送系统通知', color: '#F87171', to: async () => {
    try {
      const { value: t } = await ElMessageBox.prompt('请输入通知标题（取消=默认：系统公告）', '群发通知', {
        confirmButtonText: '发送',
        cancelButtonText: '取消',
        inputPlaceholder: '系统公告',
        inputValidator: v => !!v || '请输入通知标题'
      })
      if (!t) return
      const { value: c } = await ElMessageBox.prompt('请输入通知内容', '群发通知', {
        confirmButtonText: '发送',
        cancelButtonText: '取消',
        inputValidator: v => !!v || '请输入通知内容'
      })
      if (!c) return
      await api.broadcastNotice({ title: t, content: c })
      ElMessage.success(`✓ 已发送：${t}`)
    } catch (e: any) {
      if (e !== 'cancel') ElMessage.error('发送失败：' + (e?.response?.data?.message || e.message))
    }
  } },
  { name: '前台首页', icon: '🏠', desc: '返回前台查看各学科美文与资料', color: '#34D399', to: () => router.push('/') },
]

const users = ref<any[]>([])
const subjects = ref<any[]>([])
const articles = ref<any[]>([])
const resources = ref<any[]>([])
const queryTasks = ref<any[]>([])

const chart1 = ref<HTMLDivElement>()
const chart2 = ref<HTMLDivElement>()
let c1: echarts.ECharts, c2: echarts.ECharts

const pendingCount = computed(() => articles.value.filter(a => a.status === 'pending').length + resources.value.filter(r => r.status === 'pending').length)

const stats = computed(() => {
  const base = [
    { label: '总用户', value: users.value.length, icon: '👥', color: '#f59e0b' },
    { label: '学科数', value: subjects.value.length, icon: '📚', color: '#fbbf24' },
    { label: '美文总数', value: articles.value.length, icon: '✍️', color: '#f97316' },
    { label: '资料总数', value: resources.value.length, icon: '📦', color: '#eab308' },
    { label: '查询任务', value: queryTasks.value.length, icon: '📊', color: '#fdba74' },
    { label: '待审核', value: pendingCount.value, icon: '⏳', color: '#d97706' },
  ]
  return base.map((s, i) => {
    // 生成一条温和上行的小趋势，作为迷你折线图（非真实历史，仅视觉点缀）
    const v = Math.max(s.value, 1)
    const seed = (i + 1) * 7
    const spark = Array.from({ length: 7 }, (_, k) => Math.max(1, Math.round(v * (0.55 + 0.07 * k + 0.05 * Math.sin(seed + k)))))
    return { ...s, spark }
  })
})

// 墨金 / 经典 双调色板：经典保持原暖橙；墨金切换为更深金（#BA7517 / #854F0B）
const isInkgold = computed(() => theme.activeTheme?.config?.designMode === 'inkgold')
const palette = computed(() => isInkgold.value
  ? { bar1: '#BA7517', bar2: '#854F0B', axis: '#1F2430', soft: 'rgba(186,117,23,.35)', split: 'rgba(186,117,23,.12)', border: 'rgba(186,117,23,.35)' }
  : { bar1: '#f59e0b', bar2: '#fbbf24', axis: '#78350F', soft: 'rgba(245,158,11,.3)', split: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.3)' }
)

function renderCharts() {
  if (chart1.value) {
    if (!c1) c1 = echarts.init(chart1.value)
    c1.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 40, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: subjects.value.map(s => s.name), axisLabel: { color: palette.value.axis }, axisLine: { lineStyle: { color: palette.value.soft } } },
      yAxis: { type: 'value', axisLabel: { color: palette.value.axis }, splitLine: { lineStyle: { color: palette.value.split } } },
      series: [
        { name: '资料', type: 'bar', stack: 'a', data: subjects.value.map(s => resources.value.filter(r => r.subject_id === s.id).length), itemStyle: { color: palette.value.bar1, borderRadius: [4, 4, 0, 0] } },
        { name: '美文', type: 'bar', stack: 'a', data: subjects.value.map(s => articles.value.filter(a => a.subject_id === s.id).length), itemStyle: { color: palette.value.bar2, borderRadius: [4, 4, 0, 0] } },
      ],
      legend: { textStyle: { color: palette.value.axis }, top: 0 },
    })
  }
  if (chart2.value) {
    if (!c2) c2 = echarts.init(chart2.value)
    c2.setOption({
      tooltip: { trigger: 'item' },
      legend: { textStyle: { color: palette.value.axis }, bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
        label: { color: palette.value.axis },
        data: users.value.map(u => ({ name: u.real_name, value: u.exp })),
        itemStyle: { borderColor: palette.value.border, borderWidth: 2 },
      }]
    })
  }
}

// 切换设计模式（经典 / 墨金）时重绘图表，套用对应调色板
watch(() => theme.activeTheme?.config?.designMode, () => {
  if (chart1.value || chart2.value) renderCharts()
})

onMounted(async () => {
  const [us, ss, arts, ress, qs] = await Promise.all([
    api.users() as any, api.subjects() as any,
    api.articles({}) as any, api.resources({}) as any,
    api.queryTasks() as any,
  ])
  users.value = us || []
  subjects.value = ss || []
  articles.value = arts || []
  resources.value = ress || []
  queryTasks.value = qs || []
  setTimeout(renderCharts, 50)
  window.addEventListener('resize', resize)
})
function resize() { c1?.resize(); c2?.resize() }
onBeforeUnmount(() => { window.removeEventListener('resize', resize); c1?.dispose(); c2?.dispose() })
</script>

<template>
  <div class="dash">
    <h1 class="dh-title"><span class="zg-grad-text">超级管理员控制台</span></h1>
    <div class="feat-grid">
      <div v-for="f in features" :key="f.name" class="feat-card glass zg-card" @click="f.to()">
        <div class="fc-icon" :style="{ background: `linear-gradient(135deg, ${f.color}, ${f.color}cc)` }"><ZgGlyph :emoji="f.icon" /></div>
        <div class="fc-body">
          <div class="fc-name">{{ f.name }}</div>
          <div class="fc-desc">{{ f.desc }}</div>
        </div>
        <span class="fc-arrow">›</span>
      </div>
    </div>
    <div class="d-section-title"><ZgGlyph emoji="📊" /> 数据概览</div>
    <div class="stat-grid">
      <div v-for="s in stats" :key="s.label" class="stat-card glass zg-card">
        <div class="sc-icon" :style="{ background: s.color + '22', color: s.color }"><ZgGlyph :emoji="s.icon" /></div>
        <div class="sc-body">
          <div class="sc-num">{{ s.value }}</div>
          <div class="sc-label">{{ s.label }}</div>
          <ZgSparkline class="sc-spark" :data="s.spark" :color="s.color" :width="84" :height="26" />
        </div>
      </div>
    </div>
    <div class="chart-row">
      <div class="chart-card glass">
        <div class="cc-title">各学科资料 / 美文分布</div>
        <div ref="chart1" class="chart"></div>
      </div>
      <div class="chart-card glass">
        <div class="cc-title">用户经验值占比</div>
        <div ref="chart2" class="chart"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dh-title { font-size:24px; font-weight:800; margin-bottom:20px; }
.d-section-title { font-size: 18px; font-weight: 700; margin: 28px 0 14px; display:flex; align-items:center; gap:8px; }
.d-section-title::before { content:''; width: 3px; height: 16px; border-radius: 3px; background: linear-gradient(180deg, var(--zg-accent), var(--zg-primary)); }

.feat-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.feat-card { display:flex; align-items:center; gap:14px; padding: 18px; cursor:pointer; }
.feat-card:hover { transform: translateY(-3px) scale(1.01); }
.fc-icon { width: 48px; height: 48px; border-radius: 14px; display:flex; align-items:center; justify-content:center; font-size:24px; color:#fff; flex-shrink:0; box-shadow: 0 4px 12px rgba(0,0,0,.08); }
.fc-body { flex:1; min-width: 0; }
.fc-name { font-weight: 700; font-size: 16px; }
.fc-desc { font-size: 12px; color: var(--zg-text-dim); margin-top: 3px; line-height: 1.45; }
.fc-arrow { font-size: 22px; color: var(--zg-primary); opacity: .6; font-weight: 700; }
.feat-card:hover .fc-arrow { opacity: 1; transform: translateX(3px); transition: all .25s; }

.stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:16px; }
.stat-card { display:flex; align-items:center; gap:14px; padding:18px; }
.sc-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; flex-shrink:0; }
.sc-body { flex:1; min-width:0; }
.sc-num { font-size:24px; font-weight:800; color:var(--zg-accent); }
.sc-label { font-size:12px; color:var(--zg-text-dim); }
.sc-spark { margin-top:6px; }
.chart-row { display:grid; grid-template-columns:1.4fr 1fr; gap:20px; margin-top:20px; }
.chart-card { padding:20px; }
.cc-title { font-weight:700; margin-bottom:12px; }
.chart { height:300px; }
@media (max-width:980px){ .chart-row{grid-template-columns:1fr;} }
@media (max-width:768px){ .stat-grid{grid-template-columns:repeat(2,1fr);} .chart{height:220px;} }

@media (max-width: 768px) {
  .dh-title { font-size: 20px; margin-bottom: 14px; }
  .stat-grid { grid-template-columns: 1fr; gap: 10px; }
  .stat-card { padding: 14px; gap: 10px; }
  .sc-icon { width: 40px; height: 40px; font-size: 20px; border-radius: 10px; }
  .sc-num { font-size: 20px; }
  .sc-label { font-size: 11px; }
  .chart-row { gap: 12px; margin-top: 14px; }
  .chart-card { padding: 16px; }
  .cc-title { font-size: 16px; margin-bottom: 10px; }
  .chart { height: 200px; }
}

@media (min-width: 1200px) {
  .dash { padding: 0; }
  .dh-title { font-size: 30px; margin-bottom: 28px; }
  .stat-grid { gap: 22px; }
  .stat-card { padding: 32px; gap: 18px; }
  .sc-icon { width: 56px; height: 56px; font-size: 28px; border-radius: 14px; }
  .sc-num { font-size: 36px; }
  .sc-label { font-size: 14px; }
  .chart-row { gap: 28px; margin-top: 28px; }
  .chart-card { padding: 32px; }
  .cc-title { font-size: 18px; margin-bottom: 16px; }
  .chart { height: 340px; }
}
</style>
