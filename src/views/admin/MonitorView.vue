<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const data = ref<any>(null)
const storageData = ref<any>(null)
const storageLoading = ref(false)
const activeTab = ref('supabase-storage')
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

async function loadStorage() {
  storageLoading.value = true
  try {
    storageData.value = await api.storageMonitor() as any
  } catch (e: any) {
    ElMessage.error('存储监控数据加载失败: ' + (e?.response?.data?.message || ''))
  } finally {
    storageLoading.value = false
  }
}

async function optimizeAction(action: string) {
  const actionMap: Record<string, string> = {
    purge_cache: '清除所有文件缓存',
    clean_orphaned: '清理孤立文件',
    list: '刷新优化建议列表',
  }
  try {
    await ElMessageBox.confirm(`确定执行「${actionMap[action] || action}」操作？`, '确认', { type: 'warning' })
  } catch { return }
  try {
    const res: any = await api.storageOptimize(action)
    ElMessage.success(res.message || '操作完成')
    await loadStorage()
  } catch (e: any) {
    ElMessage.error('操作失败: ' + (e?.response?.data?.message || ''))
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

const hasAlerts = computed(() => (data.value?.alerts?.length || 0) > 0)

const storageUsedPercentNum = computed(() => {
  return parseFloat(data.value?.supabaseStorage?.usedPercent || '0')
})

const d1UsedPercentNum = computed(() => {
  return parseFloat(data.value?.database?.usedPercent || '0')
})

function formatBytes(b: number): string {
  if (!b || b < 0) return '0 B'
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB'
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function resize() { c1?.resize(); c2?.resize() }

onMounted(async () => {
  await load()
  await loadStorage()
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
        <el-button @click="() => { load(); loadStorage() }" :loading="loading">🔄 刷新</el-button>
        <span class="auto-refresh-hint">自动每15秒刷新</span>
      </div>
    </div>

    <template v-if="data">
      <!-- 统一告警横幅 -->
      <div v-if="hasAlerts" class="alert-banner">
        <div v-for="(a, i) of data.alerts" :key="i" :class="['alert-item', `alert-${a.level}`]">
          <span class="alert-icon">{{ a.level === 'danger' ? '🔴' : a.level === 'warning' ? '🟡' : '🔵' }}</span>
          <span class="alert-source">[{{ a.source }}]</span>
          <span class="alert-msg">{{ a.message }}</span>
        </div>
      </div>

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

      <!-- 双库监控 Tab -->
      <div class="section-title">🗄️ 双库全覆盖监控（Supabase + D1）</div>
      <el-tabs v-model="activeTab" class="monitor-tabs">
        <!-- ============ Supabase 存储监控 ============ -->
        <el-tab-pane label="📦 Supabase 存储" name="supabase-storage">
          <div v-loading="storageLoading">
            <template v-if="data.supabaseStorage">
              <!-- 容量进度条 -->
              <div class="capacity-bar-wrap">
                <div class="cap-header">
                  <span class="cap-title">存储容量使用情况</span>
                  <span class="cap-numbers">
                    <b>{{ data.supabaseStorage.totalSizeFmt }}</b> / {{ data.supabaseStorage.capacityFmt }}
                    （剩余 {{ data.supabaseStorage.remainingFmt }}）
                  </span>
                </div>
                <div class="capacity-bar">
                  <div :class="['capacity-fill', storageUsedPercentNum > 80 ? 'danger' : storageUsedPercentNum > 60 ? 'warning' : '']"
                       :style="{ width: Math.min(storageUsedPercentNum, 100) + '%' }">
                    <span class="cap-percent">{{ data.supabaseStorage.usedPercent }}%</span>
                  </div>
                </div>
              </div>

              <div class="row" style="margin-top:16px;">
                <div class="glass info-panel">
                  <div class="ip-title">📊 存储概况</div>
                  <div class="kv"><span class="k">存储桶</span><span class="v strong">{{ data.supabaseStorage.bucket }}</span></div>
                  <div class="kv"><span class="k">文件总数</span><span class="v strong">{{ data.supabaseStorage.totalFiles }} 个</span></div>
                  <div class="kv"><span class="k">已用空间</span><span class="v strong">{{ data.supabaseStorage.totalSizeFmt }}</span></div>
                  <div class="kv"><span class="k">剩余空间</span><span class="v" style="color:#10b981;font-weight:700;">{{ data.supabaseStorage.remainingFmt }}</span></div>
                  <div class="kv"><span class="k">使用率</span><span class="v" :style="{ color: storageUsedPercentNum > 80 ? '#ef4444' : storageUsedPercentNum > 60 ? '#f59e0b' : '#10b981', fontWeight: 700 }">{{ data.supabaseStorage.usedPercent }}%</span></div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title">📅 今日流量</div>
                  <div class="kv"><span class="k">今日上传</span><span class="v strong">{{ data.supabaseStorage.todayUploads }} 个文件</span></div>
                  <div class="kv"><span class="k">上传流量</span><span class="v strong">{{ data.supabaseStorage.todayUploadSizeFmt }}</span></div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title">🔥 高频访问文件 TOP 5</div>
                  <div v-if="data.supabaseStorage.hotResources?.length" class="top-list">
                    <div v-for="f of data.supabaseStorage.hotResources.slice(0,5)" :key="f.id" class="top-row">
                      <span class="top-name" :title="f.title">{{ f.title }}</span>
                      <span class="top-dl">⬇ {{ f.downloads }}</span>
                      <span class="top-size">{{ f.fileSizeFmt }}</span>
                    </div>
                  </div>
                  <div v-else class="empty-hint">暂无下载记录</div>
                </div>
              </div>

              <!-- 大体积文件排行 -->
              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title">📈 大体积文件 TOP 10</div>
                <div class="top-list">
                  <div v-for="(f, i) of data.supabaseStorage.topFiles" :key="i" class="top-row">
                    <span class="top-rank">{{ i + 1 }}</span>
                    <span class="top-name" :title="f.name">{{ f.name }}</span>
                    <span class="top-size">{{ f.sizeFmt }}</span>
                  </div>
                  <div v-if="!data.supabaseStorage.topFiles?.length" class="empty-hint">暂无文件</div>
                </div>
              </div>
            </template>
          </div>
        </el-tab-pane>

        <!-- ============ Supabase 数据库监控 ============ -->
        <el-tab-pane label="🗄️ Supabase 数据库" name="supabase-db">
          <template v-if="data.supabaseDb">
            <div class="row">
              <div class="glass info-panel">
                <div class="ip-title">🔌 数据库连接</div>
                <div class="kv"><span class="k">项目</span><span class="v strong">{{ data.supabaseDb.url }}</span></div>
                <div class="kv"><span class="k">状态</span><span class="v" :style="{ color: data.supabaseDb.configured ? '#10b981' : '#ef4444', fontWeight: 700 }">{{ data.supabaseDb.configured ? '✅ 已连接' : '❌ 未配置' }}</span></div>
                <div class="kv"><span class="k">总记录数</span><span class="v strong">{{ (data.supabaseDb.totalRows || 0).toLocaleString() }} 条</span></div>
              </div>
              <div class="glass info-panel" style="grid-column: span 2;">
                <div class="ip-title">📋 各表行数统计（Supabase PostgreSQL）</div>
                <div class="tables">
                  <div v-for="(n, t) of data.supabaseDb.tableStats" :key="t" class="tbl-row">
                    <span class="tbl-name">{{ tableNameZh[t] || t }}</span>
                    <span class="tbl-num">{{ Number(n).toLocaleString() }} 条</span>
                  </div>
                  <div v-if="!data.supabaseDb.tableStats" class="empty-hint">暂无数据</div>
                </div>
              </div>
            </div>
          </template>
        </el-tab-pane>

        <!-- ============ D1 数据库监控 ============ -->
        <el-tab-pane label="💾 D1 数据库" name="d1">
          <template v-if="data.database">
            <!-- D1 容量进度条 -->
            <div class="capacity-bar-wrap">
              <div class="cap-header">
                <span class="cap-title">D1 数据库容量</span>
                <span class="cap-numbers">
                  <b>{{ data.database.fileSizeFmt }}</b> / 500 MB（使用率 {{ data.database.usedPercent }}%）
                </span>
              </div>
              <div class="capacity-bar">
                <div :class="['capacity-fill', d1UsedPercentNum > 80 ? 'danger' : d1UsedPercentNum > 60 ? 'warning' : '']"
                     :style="{ width: Math.min(d1UsedPercentNum, 100) + '%' }">
                  <span class="cap-percent">{{ data.database.usedPercent }}%</span>
                </div>
              </div>
            </div>

            <div class="db-row" style="margin-top:16px;">
              <div class="glass info-panel db-info">
                <div class="ip-title">🗄️ D1 概况</div>
                <div class="kv"><span class="k">已用空间</span><span class="v strong">{{ data.database.fileSizeFmt }}</span></div>
                <div class="kv"><span class="k">总页数</span><span class="v">{{ data.database.pageCount }} 页</span></div>
                <div class="kv"><span class="k">页大小</span><span class="v">{{ data.database.pageSize }} B</span></div>
                <div class="kv"><span class="k">空闲页</span><span class="v">{{ data.database.freePages }} 页 ({{ data.database.freeSpaceFmt }})</span></div>
                <div class="kv"><span class="k">总记录数</span><span class="v strong">{{ totalTableRows.toLocaleString() }} 条</span></div>
                <div class="kv"><span class="k">表数量</span><span class="v">{{ data.database.tableCount }} 张</span></div>
                <div v-if="data.database.emptyTables?.length" class="kv">
                  <span class="k">空表</span>
                  <span class="v" style="color:#f59e0b;">{{ data.database.emptyTables.length }} 张</span>
                </div>
              </div>
              <div class="glass info-panel db-tables">
                <div class="ip-title">📋 各表数据量</div>
                <div class="tables">
                  <div v-for="(n, t) of data.database.tables" :key="t" class="tbl-row"
                       :style="{ opacity: n === 0 ? 0.5 : 1 }">
                    <span class="tbl-name">{{ tableNameZh[t] || t }}</span>
                    <span class="tbl-num">{{ Number(n).toLocaleString() }} 条</span>
                    <span v-if="n === 0" class="tbl-empty">空表</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </el-tab-pane>

        <!-- ============ 缓存监控 ============ -->
        <el-tab-pane label="🚀 缓存系统" name="cache">
          <template v-if="data.cache">
            <div class="row">
              <div class="glass info-panel">
                <div class="ip-title">🔥 热点文件缓存</div>
                <div class="kv"><span class="k">缓存文件数</span><span class="v strong">{{ data.cache.hotFile.count }} / {{ data.cache.hotFile.maxCount }}</span></div>
                <div class="kv"><span class="k">缓存总大小</span><span class="v strong">{{ data.cache.hotFile.totalSizeFmt }}</span></div>
                <div class="kv"><span class="k">总命中次数</span><span class="v" style="color:#10b981;font-weight:700;">{{ data.cache.hotFile.totalHits }} 次</span></div>
              </div>
              <div class="glass info-panel">
                <div class="ip-title">⚡ API 内存缓存</div>
                <div class="kv"><span class="k">缓存条目数</span><span class="v strong">{{ data.cache.api.count }} / {{ data.cache.api.maxCount }}</span></div>
              </div>
              <div class="glass info-panel">
                <div class="ip-title">🌐 边缘缓存</div>
                <div class="kv"><span class="k">类型</span><span class="v strong">{{ data.cache.edgeCache }}</span></div>
                <div class="kv"><span class="k">缓存策略</span><span class="v">已审核资源：边缘缓存 24h</span></div>
                <div class="kv"><span class="k">热点策略</span><span class="v">Worker 内存缓存 30min</span></div>
              </div>
            </div>
            <div class="glass info-panel" style="margin-top:16px;">
              <div class="ip-title">🛠️ 缓存管理</div>
              <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">
                <el-button type="warning" size="small" @click="optimizeAction('purge_cache')">🗑️ 清除文件缓存</el-button>
                <span style="font-size:12px;color:var(--zg-text-dim);line-height:32px;">清除后所有文件将从 Supabase 重新拉取并重建缓存</span>
              </div>
            </div>
          </template>
        </el-tab-pane>

        <!-- ============ 存储优化 ============ -->
        <el-tab-pane label="📦 存储优化" name="optimize">
          <div v-loading="storageLoading">
            <template v-if="storageData">
              <!-- 优化建议概览 -->
              <div class="optimize-summary glass zg-card">
                <div class="opt-stat">
                  <div class="opt-num">{{ storageData.storage?.totalFiles || 0 }}</div>
                  <div class="opt-label">总文件数</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num">{{ storageData.storage?.totalSizeFmt || '0 B' }}</div>
                  <div class="opt-label">已用空间</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num" style="color:#10b981;">{{ storageData.storage?.remainingFmt || '1 GB' }}</div>
                  <div class="opt-label">剩余空间</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num" style="color:#f59e0b;">{{ storageData.suggestions?.length || 0 }}</div>
                  <div class="opt-label">可优化文件</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num" style="color:#ef4444;">{{ storageData.suggestions?.reduce((s:number,c:any)=>s+c.potentialSaving,0) ? formatBytes(storageData.suggestions?.reduce((s:number,c:any)=>s+c.potentialSaving,0)) : '0 B' }}</div>
                  <div class="opt-label">预计可节省</div>
                </div>
              </div>

              <!-- 存储告警 -->
              <div v-if="storageData.alerts?.length" class="alert-banner" style="margin-top:16px;">
                <div v-for="(a, i) of storageData.alerts" :key="i" :class="['alert-item', `alert-${a.level}`]">
                  <span class="alert-icon">{{ a.level === 'danger' ? '🔴' : a.level === 'warning' ? '🟡' : '🔵' }}</span>
                  <span class="alert-msg">{{ a.message }}</span>
                </div>
              </div>

              <!-- 优化操作 -->
              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title">🛠️ 快捷操作</div>
                <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">
                  <el-button type="primary" size="small" @click="optimizeAction('list')">📊 刷新优化建议</el-button>
                  <el-button type="danger" size="small" @click="optimizeAction('clean_orphaned')">🧹 清理孤立文件</el-button>
                  <el-button type="warning" size="small" @click="optimizeAction('purge_cache')">🗑️ 清除文件缓存</el-button>
                </div>
              </div>

              <!-- 优化建议列表 -->
              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title">📋 文件优化建议（按预计节省空间排序）</div>
                <el-table v-if="storageData.suggestions?.length" :data="storageData.suggestions.slice(0, 20)" size="small" style="margin-top:10px;" max-height="400">
                  <el-table-column type="index" label="#" width="40" />
                  <el-table-column prop="fileName" label="文件名" min-width="180" show-overflow-tooltip />
                  <el-table-column prop="fileType" label="类型" width="80">
                    <template #default="{ row }">
                      <el-tag size="small" :type="row.fileType === 'image' ? 'success' : row.fileType === 'pdf' ? 'warning' : 'info'">
                        {{ row.fileType === 'image' ? '图片' : row.fileType === 'pdf' ? 'PDF' : row.fileType === 'document' ? '文档' : row.fileType === 'archive' ? '压缩包' : row.fileType }}
                      </el-tag>
                    </template>
                  </el-table-column>
                  <el-table-column label="当前大小" width="100">
                    <template #default="{ row }">{{ formatBytes(row.fileSize) }}</template>
                  </el-table-column>
                  <el-table-column label="预计节省" width="100">
                    <template #default="{ row }">
                      <span style="color:#10b981;font-weight:700;">{{ formatBytes(row.potentialSaving) }}</span>
                    </template>
                  </el-table-column>
                  <el-table-column prop="savingPercent" label="压缩率" width="80">
                    <template #default="{ row }">{{ row.savingPercent }}%</template>
                  </el-table-column>
                  <el-table-column prop="resourceTitle" label="关联资源" min-width="120" show-overflow-tooltip />
                </el-table>
                <div v-else class="empty-hint">暂无需优化的文件，所有文件体积均小于 500KB 🎉</div>
              </div>

              <!-- 孤立文件 -->
              <div v-if="storageData.orphanedFiles?.length" class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title">⚠️ 孤立文件（未关联资源记录，占用 {{ formatBytes(storageData.orphanedFiles.reduce((s:number,f:any)=>s+f.size,0)) }}）</div>
                <div class="top-list" style="max-height:200px;">
                  <div v-for="(f, i) of storageData.orphanedFiles.slice(0, 10)" :key="i" class="top-row">
                    <span class="top-rank">{{ i + 1 }}</span>
                    <span class="top-name" :title="f.name">{{ f.name }}</span>
                    <span class="top-size">{{ f.sizeFmt }}</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </el-tab-pane>
      </el-tabs>

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

/* 告警横幅 */
.alert-banner { display:flex; flex-direction:column; gap:8px; margin-bottom:16px; }
.alert-item { display:flex; align-items:center; gap:8px; padding:10px 16px; border-radius:8px; font-size:13px; }
.alert-danger { background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.3); color:#dc2626; }
.alert-warning { background:rgba(245,158,11,.1); border:1px solid rgba(245,158,11,.3); color:#d97706; }
.alert-info { background:rgba(59,130,246,.1); border:1px solid rgba(59,130,246,.3); color:#2563eb; }
.alert-icon { font-size:16px; }
.alert-source { font-weight:700; flex-shrink:0; }
.alert-msg { flex:1; }

/* 统计卡片 */
.stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
.stat-card { display:flex; align-items:center; gap:14px; padding:18px; }
.stat-card.online { border:2px solid rgba(16,185,129,.3); background:rgba(16,185,129,.05); }
.stat-card.pending { border:2px solid rgba(239,68,68,.3); }
.sc-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; background:rgba(245,158,11,.1); }
.sc-num { font-size:22px; font-weight:800; color:var(--zg-accent); }
.sc-num.big { font-size:30px; color:#10b981; }
.sc-label { font-size:12px; color:var(--zg-text-dim); }

/* Tab */
.monitor-tabs { margin-top:8px; }
.monitor-tabs :deep(.el-tabs__item) { font-weight:600; font-size:14px; }

/* 容量进度条 */
.capacity-bar-wrap { background:rgba(245,158,11,.05); border-radius:12px; padding:16px; }
.cap-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px; }
.cap-title { font-weight:700; font-size:14px; }
.cap-numbers { font-size:13px; color:var(--zg-text-dim); }
.cap-numbers b { color:var(--zg-primary); font-size:16px; }
.capacity-bar { height:28px; background:rgba(0,0,0,.06); border-radius:14px; overflow:hidden; position:relative; }
.capacity-fill { height:100%; background:linear-gradient(90deg,#10b981,#34d399); border-radius:14px; transition:width .5s ease; display:flex; align-items:center; justify-content:flex-end; padding-right:12px; min-width:40px; }
.capacity-fill.warning { background:linear-gradient(90deg,#f59e0b,#fbbf24); }
.capacity-fill.danger { background:linear-gradient(90deg,#ef4444,#f87171); }
.cap-percent { color:#fff; font-weight:800; font-size:13px; text-shadow:0 1px 2px rgba(0,0,0,.2); }

/* 优化概览 */
.optimize-summary { display:flex; gap:16px; padding:20px; flex-wrap:wrap; }
.opt-stat { text-align:center; flex:1; min-width:100px; }
.opt-num { font-size:24px; font-weight:800; color:var(--zg-primary); }
.opt-label { font-size:12px; color:var(--zg-text-dim); margin-top:4px; }

/* 信息面板 */
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
.tbl-empty { font-size:10px; color:#f59e0b; margin-left:8px; }

/* TOP 列表 */
.top-list { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow-y:auto; }
.top-row { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:6px; font-size:12px; }
.top-row:nth-child(odd) { background:rgba(245,158,11,.05); }
.top-rank { width:24px; height:24px; border-radius:50%; background:rgba(245,158,11,.15); display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--zg-accent); flex-shrink:0; }
.top-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--zg-text); }
.top-dl { color:var(--zg-accent); font-weight:700; flex-shrink:0; }
.top-size { color:var(--zg-text-dim); flex-shrink:0; min-width:60px; text-align:right; }
.empty-hint { text-align:center; padding:20px; color:var(--zg-text-dim); font-size:13px; }

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
  .optimize-summary { gap:10px; }
  .opt-stat { min-width:80px; }
  .opt-num { font-size:18px; }
}
</style>
