<script setup lang="ts">
// 【v4.6.0】学情分析中心（对标智学网）：班级成绩 / 成绩分布 / 知识点掌握度 / 高频错题 / 学生分层
import { ref, onMounted, nextTick, computed } from 'vue'
import { useRoute } from 'vue-router'
import * as echarts from 'echarts'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { ElMessage } from 'element-plus'
import ZgGlyph from '@/components/ZgGlyph.vue'

const route = useRoute()
const user = useUserStore()
const slug = route.params.slug as string
const subject = ref<any>(null)
const data = ref<any>(null)
const loading = ref(false)

const histChart = ref<HTMLElement>()
const masteryChart = ref<HTMLElement>()

const TIERS = [
  { key: 'excellent', label: '尖子层', cls: 't-excellent', desc: '正确率≥85%' },
  { key: 'good', label: '良好层', cls: 't-good', desc: '70%~85%' },
  { key: 'medium', label: '中等层', cls: 't-medium', desc: '60%~70%' },
  { key: 'weak', label: '待提升', cls: 't-weak', desc: '<60%' },
]

const stats = computed(() => data.value?.examStats || {})
const hasExam = computed(() => (stats.value.subCount || 0) > 0)
const hasPractice = computed(() => (data.value?.kpMastery || []).some((m: any) => (m.tries || 0) > 0))

function renderCharts() {
  if (!data.value) return
  nextTick(() => {
    if (histChart.value) {
      const h = data.value.scoreHistogram || []
      const c = echarts.init(histChart.value)
      c.setOption({
        grid: { left: 40, right: 16, top: 24, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', name: '分数', data: h.map((x: any) => `${x.range}-${x.range + 9}`) },
        yAxis: { type: 'value', name: '人数' },
        series: [{ type: 'bar', data: h.map((x: any) => x.count), itemStyle: { color: '#b06a00' }, barWidth: '55%' }],
      })
    }
    if (masteryChart.value) {
      const m = [...(data.value.kpMastery || [])].sort((a: any, b: any) => (a.rate ?? 0) - (b.rate ?? 0))
      const c = echarts.init(masteryChart.value)
      c.setOption({
        grid: { left: 96, right: 32, top: 16, bottom: 24 },
        tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0].name}<br/>正确率：${p[0].value}%` },
        xAxis: { type: 'value', max: 100, name: '正确率%' },
        yAxis: { type: 'category', data: m.map((x: any) => x.kpName) },
        series: [{
          type: 'bar',
          data: m.map((x: any) => ({ value: x.rate ?? 0, itemStyle: { color: (x.rate ?? 0) < 60 ? '#e06b5a' : (x.rate ?? 0) < 80 ? '#e0a93a' : '#5aa86b' } })),
          barWidth: '55%',
          label: { show: true, position: 'right', formatter: (p: any) => `${p.value}%` },
        }],
      })
    }
  })
}

onMounted(async () => {
  loading.value = true
  try {
    subject.value = await api.subject(slug)
    data.value = await api.subjectAnalytics(subject.value.id)
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '加载学情失败') }
  finally { loading.value = false }
  // 【v4.6.0 修复】必须在 loading=false 且 DOM 渲染出图表容器后再初始化 echarts，
  // 否则 loading 期间显示的是骨架屏，v-else-if="data" 的图表 div 尚未挂载，ref 为 null 导致图表空白。
  await nextTick()
  renderCharts()
})
</script>

<template>
  <div class="zg-container analytics">
    <div class="a-head">
      <h2><ZgGlyph emoji="📊" /> 学情分析中心 · {{ subject?.name }}</h2>
      <span class="hint">对标智学网：班级成绩 / 知识点掌握度 / 高频错题 / 学生分层</span>
    </div>

    <el-skeleton v-if="loading" :rows="8" animated />
    <template v-else-if="data">
      <!-- 班级成绩概览 -->
      <el-card shadow="never" class="blk">
        <template #header><b>① 班级成绩概览</b><span class="muted" v-if="!hasExam">（暂无考试/测验提交数据）</span></template>
        <div class="stat-grid">
          <div class="stat"><div class="num">{{ stats.avgScore ?? '—' }}</div><div class="lab">平均分</div></div>
          <div class="stat"><div class="num">{{ stats.maxScore ?? '—' }}</div><div class="lab">最高分</div></div>
          <div class="stat"><div class="num">{{ stats.minScore ?? '—' }}</div><div class="lab">最低分</div></div>
          <div class="stat"><div class="num">{{ stats.excellentRate ?? 0 }}%</div><div class="lab">优秀率(≥85%)</div></div>
          <div class="stat"><div class="num">{{ stats.passRate ?? 0 }}%</div><div class="lab">及格率(≥60%)</div></div>
          <div class="stat"><div class="num">{{ stats.difficulty ?? 0 }}</div><div class="lab">难度系数</div></div>
          <div class="stat"><div class="num">{{ stats.discrimination ?? 0 }}</div><div class="lab">区分度</div></div>
          <div class="stat"><div class="num">{{ stats.subCount ?? 0 }}</div><div class="lab">有效提交</div></div>
        </div>
        <div ref="histChart" class="chart" v-if="hasExam"></div>
      </el-card>

      <!-- 知识点掌握度 + 题库覆盖 -->
      <el-row :gutter="16">
        <el-col :md="14" :sm="24">
          <el-card shadow="never" class="blk">
            <template #header><b>② 知识点掌握度</b><span class="muted" v-if="!hasPractice">（暂无练习数据）</span></template>
            <div ref="masteryChart" class="chart tall" v-if="hasPractice"></div>
            <el-empty v-else description="学生完成单题练习后将自动统计各知识点正确率" :image-size="80" />
          </el-card>
        </el-col>
        <el-col :md="10" :sm="24">
          <el-card shadow="never" class="blk">
            <template #header><b>③ 题库知识点覆盖</b></template>
            <div class="cov-list">
              <div v-for="c in (data.kpCoverage || [])" :key="c.kpId" class="cov">
                <span class="nm">{{ c.kpName }}</span>
                <span class="bar"><i :style="{ width: (c.count ? Math.min(100, c.count * 12) : 4) + '%' }"></i></span>
                <span class="cnt">{{ c.count }} 题</span>
              </div>
              <p v-if="!(data.kpCoverage||[]).length" class="muted center">暂无知识点</p>
            </div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 高频错题 -->
      <el-card shadow="never" class="blk">
        <template #header><b>④ 高频错题 Top</b></template>
        <el-table :data="data.topWrong || []" stripe size="small" empty-text="暂无错题数据">
          <el-table-column label="序号" type="index" width="56" />
          <el-table-column label="题干" min-width="280">
            <template #default="{ row }"><span v-html="row.content?.slice(0, 80)" /></template>
          </el-table-column>
          <el-table-column label="题型" width="80"><template #default="{ row }">{{ ({single:'单选',multiple:'多选',judge:'判断',fill:'填空',subjective:'主观'} as any)[row.qtype] || row.qtype }}</template></el-table-column>
          <el-table-column label="知识点" prop="kpName" width="120" />
          <el-table-column label="错误率" width="100"><template #default="{ row }"><b style="color:#e06b5a">{{ row.wrongRate }}%</b></template></el-table-column>
          <el-table-column label="作答/错次" width="110"><template #default="{ row }">{{ row.tries }} / {{ row.wrongs }}</template></el-table-column>
        </el-table>
      </el-card>

      <!-- 学生分层 -->
      <el-card shadow="never" class="blk">
        <template #header><b>⑤ 学生分层</b><span class="muted" v-if="!hasExam">（基于考试成绩）</span></template>
        <el-row :gutter="12">
          <el-col v-for="t in TIERS" :key="t.key" :span="6">
            <div class="tier" :class="t.cls">
              <div class="t-top"><b>{{ t.label }}</b><span>{{ t.desc }}</span></div>
              <div class="t-body">
                <div v-for="u in (data.tiers?.[t.key] || [])" :key="u.uid" class="u">
                  <span class="un">{{ u.name }}</span><span class="us">{{ u.avg }}分</span>
                </div>
                <p v-if="!(data.tiers?.[t.key]||[]).length" class="muted">—</p>
              </div>
            </div>
          </el-col>
        </el-row>
      </el-card>
    </template>
    <el-empty v-else description="暂无数据" />
  </div>
</template>

<style scoped>
.a-head { display: flex; align-items: baseline; gap: 12px; margin: 8px 0 16px; flex-wrap: wrap; }
.a-head h2 { margin: 0; font-size: 20px; }
.a-head .hint { color: #b06a00; font-size: 13px; }
.blk { margin-bottom: 16px; }
.muted { color: #999; font-size: 12px; }
.center { text-align: center; }
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.stat { background: #fff8ec; border-radius: 12px; padding: 12px; text-align: center; }
.stat .num { font-size: 24px; font-weight: 700; color: #b06a00; }
.stat .lab { font-size: 12px; color: #8a6a3a; margin-top: 2px; }
.chart { width: 100%; height: 240px; margin-top: 12px; }
.chart.tall { height: 360px; }
.cov-list { max-height: 360px; overflow-y: auto; }
.cov { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; }
.cov .nm { width: 96px; color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cov .bar { flex: 1; height: 8px; background: #f0e2c8; border-radius: 4px; overflow: hidden; }
.cov .bar i { display: block; height: 100%; background: #b06a00; }
.cov .cnt { width: 48px; text-align: right; color: #8a6a3a; }
.tier { border-radius: 12px; padding: 10px; height: 100%; }
.tier.t-excellent { background: #eafaf0; } .tier.t-good { background: #f3faf0; }
.tier.t-medium { background: #fff7e8; } .tier.t-weak { background: #fdecea; }
.t-top { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.t-top b { color: #8a5a00; } .t-top span { font-size: 11px; color: #999; }
.t-body .u { display: flex; justify-content: space-between; font-size: 13px; padding: 3px 0; border-bottom: 1px dashed #eee; }
.t-body .us { color: #b06a00; font-weight: 600; }
</style>
