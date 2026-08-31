<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import * as echarts from 'echarts'
import { api } from '@/api'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useThemeStore } from '@/store/theme'

const loading = ref(false)
const theme = useThemeStore()
const data = ref<any>(null)
const storageData = ref<any>(null)
const storageLoading = ref(false)
const activeTab = ref('b2-storage')
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

// 墨金 / 经典 双调色板：经典保持原暖橙；墨金切换为更深金（#BA7517）
const isInkgold = computed(() => theme.activeTheme?.config?.designMode === 'inkgold')
const palette = computed(() => isInkgold.value
  ? { bar1: '#BA7517', axis: '#1F2430', soft: 'rgba(186,117,23,.35)', split: 'rgba(186,117,23,.12)', border: 'rgba(186,117,23,.35)' }
  : { bar1: '#f59e0b', axis: '#78350F', soft: 'rgba(245,158,11,.3)', split: 'rgba(245,158,11,.12)', border: 'rgba(245,158,11,.3)' }
)

// 切换设计模式时重绘图表，套用对应调色板
watch(() => theme.activeTheme?.config?.designMode, () => { if (data.value) renderCharts() })

function renderCharts() {
  if (!data.value) return
  const dom1 = chart1.value || document.querySelector<HTMLElement>('[data-chart="c1"]')
  const dom2 = chart2.value || document.querySelector<HTMLElement>('[data-chart="c2"]')
  if (dom1) {
    if (!c1) c1 = echarts.init(dom1 as any)
    else c1.resize()
    c1.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { textStyle: { color: palette.value.axis }, top: 0 },
      grid: { left: 40, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: data.value.dailyActive.map((d: any) => d.date),
        axisLabel: { color: palette.value.axis },
        axisLine: { lineStyle: { color: palette.value.soft } }
      },
      yAxis: [
        { type: 'value', name: '活跃用户', axisLabel: { color: palette.value.axis }, splitLine: { lineStyle: { color: palette.value.split } } },
        { type: 'value', name: '美文数', axisLabel: { color: palette.value.axis }, splitLine: { show: false } }
      ],
      series: [
        { name: '活跃用户', type: 'bar', data: data.value.dailyActive.map((d: any) => d.users), itemStyle: { color: palette.value.bar1, borderRadius: [6, 6, 0, 0] } },
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
      legend: { textStyle: { color: palette.value.axis }, bottom: 0, type: 'scroll' },
      series: [{
        type: 'pie', radius: ['45%', '70%'], center: ['50%', '45%'],
        label: { color: palette.value.axis, formatter: '{b}\n{d}%' },
        data: pieData.length > 0 ? pieData : [{ name: '暂无数据', value: 1, itemStyle: { color: '#e5e7eb' } }],
        itemStyle: { borderColor: palette.value.border, borderWidth: 2 }
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

// v4.4.1：Supabase 已废弃，容量口径改为 B2
const storageUsedPercentNum = computed(() => {
  return parseFloat(data.value?.b2Storage?.usedPercent || '0')
})

// ===== v4.4.1 B2 运维操作：官方盘点 / 全量迁移 / 预热 =====
const censusLoading = ref(false)
const migrateLoading = ref(false)
const prewarmLoading = ref(false)

/** B2 官方容量盘点：实时全量列举桶（消耗 Class A 交易，每日最多 1 次；force 可强制重扫） */
async function runCensus(force = false) {
  censusLoading.value = true
  try {
    const r: any = await api.storageCensus(force)
    if (r?.ok === false) { ElMessage.warning(r.message || '盘点失败'); return }
    ElMessage.success(`盘点完成：${r.fileCount} 个文件 / ${fmtBytes(r.totalSizeBytes || 0)}${r.cached ? '（读取今日快照，未重复消耗额度）' : ''}`)
    await Promise.all([load(), loadStorage()])
  } catch (e: any) {
    ElMessage.error('盘点失败: ' + (e?.response?.data?.message || e?.message || ''))
  } finally {
    censusLoading.value = false
  }
}

/** 存量迁移 Supabase → B2：全量、幂等，自动改写 D1 引用 */
async function runMigrate(dryRun = false) {
  const total = data.value?.b2Storage?.migration?.migratedFiles ?? 0
  if (!dryRun) {
    try {
      await ElMessageBox.confirm(
        `将把 Supabase 存储桶中的存量文件全部搬迁到 B2，并自动改写数据库中的引用。\n` +
        `· 重复执行安全（已迁过的会跳过）\n· 不删除 Supabase 源文件，可随时回滚\n` +
        `· 已迁移：${total} 个\n\n确定开始吗？`,
        '存量迁移 Supabase → B2', { type: 'warning' })
    } catch { return }
  }
  migrateLoading.value = true
  try {
    const r: any = await api.migrateToB2({ dryRun })
    if (r?.ok === false) { ElMessage.warning(r.message || '迁移失败'); return }
    const err = (r.errors || []).slice(0, 2).join('；')
    ElMessage.success(
      dryRun
        ? `盘点完成：Supabase 桶内共 ${r.total} 个文件待迁移`
        : `迁移完成：成功 ${r.done}，跳过 ${r.skipped}，失败 ${r.failed}；改写引用 ${r.refsUpdated} 处，搬迁 ${fmtBytes(r.bytesMoved || 0)}${err ? '｜' + err : ''}`)
    await Promise.all([load(), loadStorage()])
  } catch (e: any) {
    ElMessage.error('迁移失败: ' + (e?.response?.data?.message || e?.message || ''))
  } finally {
    migrateLoading.value = false
  }
}

/** 预热：把 TOP N 大文件推到 CF 边缘缓存，显著改善首次下载速度 */
async function prewarmTop() {
  const ids = topFiles.value.slice(0, 10).map((f: any) => f.fileId).filter(Boolean)
  if (!ids.length) { ElMessage.warning('暂无可预热的文件'); return }
  prewarmLoading.value = true
  try {
    const r: any = await api.prewarmFiles(ids)
    const ok = (r.results || []).filter((x: any) => x.ok).length
    ElMessage.success(`预热完成：${ok}/${ids.length} 个文件已进入边缘缓存`)
  } catch (e: any) {
    ElMessage.error('预热失败: ' + (e?.response?.data?.message || e?.message || ''))
  } finally {
    prewarmLoading.value = false
  }
}

const d1UsedPercentNum = computed(() => {
  return parseFloat(data.value?.database?.usedPercent || '0')
})

// ===== 文件预览 & 删除 =====
const previewVisible = ref(false)
const previewFile = ref<any>(null)
const previewUrl = ref('')
const previewLoading = ref(false)
const deletingFile = ref<any>(null)
const deleteLoading = ref(false)
// 【v4.3.2】Blob 预览：记录当前 objectURL 以便及时回收，避免内存泄漏
const blobUrl = ref('')
// 【v4.3.2】下载中标记（按文件名区分，避免整列按钮一起转圈）
const downloadingFile = ref('')
const downloading = ref(false)
// 【v4.3.2】预览弹窗的来源：true=从「删除」进入（footer 显示删除按钮），false=从「查看」进入
const previewFromDelete = ref(false)

// ===== 【v4.3.1】文件溯源 =====
const onlyOrphan = ref(false)
const router = useRouter()

const topFiles = computed<any[]>(() => data.value?.b2Storage?.topFiles || [])
const orphanFiles = computed<any[]>(() => topFiles.value.filter(f => f.isOrphan))
const orphanCount = computed(() => orphanFiles.value.length)
const visibleTopFiles = computed<any[]>(() => onlyOrphan.value ? orphanFiles.value : topFiles.value)

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
const orphanSizeFmt = computed(() => fmtBytes(orphanFiles.value.reduce((s, f) => s + (f.size || 0), 0)))

/** 溯源信息的完整悬浮提示 */
function originTooltip(f: any): string {
  const o = f.origin
  if (!o) return f.name
  const parts: string[] = []
  parts.push(o.confident ? `来源：${o.label}` : `${o.label}（数据库未查到引用记录）`)
  if (o.refTitle) parts.push(`标题：${o.refTitle}`)
  if (o.uploader) parts.push(`上传人：${o.uploader}`)
  if (o.subjectName) parts.push(`学科：${o.subjectName}`)
  if (o.status) parts.push(`状态：${o.status}`)
  if (o.createdAt) parts.push(`时间：${o.createdAt}`)
  if (!o.confident) parts.push('该文件可能已随内容删除，属残留文件，可安全清理')
  return parts.join('\n')
}

/** 跳转到溯源到的内容详情页（v4.4.1：B2 口径下后端不再返回 origin，保留备用） */
function goOrigin(f: any) {
  const o = f.origin
  if (!o?.detailUrl) return
  if (o.type === 'resource' && o.refId) router.push(`/subject/${o.refId}`).catch(() => {})
  else router.push(o.detailUrl).catch(() => {})
}

// ===== v4.4.1：按 file_meta.purpose 展示文件用途（B2 口径）=====
const PURPOSE_MAP: Record<string, { icon: string; label: string }> = {
  avatar: { icon: '👤', label: '用户头像' },
  resource: { icon: '📚', label: '学科资料' },
  image: { icon: '🖼️', label: '图片素材' },
  announcement: { icon: '📢', label: '公告配图' },
  notice: { icon: '📢', label: '公告配图' },
  cover: { icon: '🖼️', label: '封面图' },
  logo: { icon: '🎨', label: '站点 Logo' },
  site: { icon: '🎨', label: '站点素材' },
  migrated: { icon: '🚚', label: 'Supabase 迁移' },
}
function purposeIcon(p: string): string { return PURPOSE_MAP[p]?.icon || '📄' }
function purposeLabel(p: string): string { return PURPOSE_MAP[p]?.label || (p || '未分类') }

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']
const PDF_EXTS = ['pdf']

function getFileExt(name: string): string {
  return (name.split('.').pop() || '').toLowerCase()
}
function isImage(name: string): boolean {
  return IMAGE_EXTS.includes(getFileExt(name))
}
function isPdf(name: string): boolean {
  return PDF_EXTS.includes(getFileExt(name))
}
function isPreviewable(name: string): boolean {
  return isImage(name) || isPdf(name)
}

/**
 * 【v4.3.2】预览文件
 * 旧实现走 /file/raw/:key?token=xxx，token 明文出现在浏览器地址栏与历史记录里，不安全。
 * 改为后端取流 + Blob：token 走 Authorization header，URL 中不再出现 token。
 */
async function openPreview(file: any, fromDelete = false) {
  previewFromDelete.value = fromDelete
  previewFile.value = file
  previewVisible.value = true
  previewLoading.value = true
  previewUrl.value = ''
  try {
    const blob = await api.getStorageFile(file.name, 'preview') as unknown as Blob
    if (!(blob instanceof Blob)) throw new Error('返回内容不是文件流')
    if (blobUrl.value) URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = URL.createObjectURL(blob)
    previewUrl.value = blobUrl.value
    if (isImage(file.name)) {
      const img = new Image()
      img.onload = () => { previewLoading.value = false }
      img.onerror = () => { previewLoading.value = false }
      img.src = previewUrl.value
    } else {
      setTimeout(() => { previewLoading.value = false }, 800)
    }
  } catch (e: any) {
    previewLoading.value = false
    // 4xx/5xx 已由 http 拦截器统一提示，这里只兜底「返回内容异常」的情况
    if (e?.message === '返回内容不是文件流') ElMessage.error('预览失败：服务器未返回文件流')
    else if (!e?.response) ElMessage.error('预览失败：' + (e?.message || '未知错误'))
  }
}

/** 【v4.3.2】下载文件到本地（同样走 Blob，URL 不含 token） */
async function downloadStorageFile(file: any) {
  downloading.value = true
  downloadingFile.value = file.name
  try {
    const blob = await api.getStorageFile(file.name, 'download') as unknown as Blob
    if (!(blob instanceof Blob)) throw new Error('返回内容不是文件流')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.name || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    ElMessage.success('已开始下载')
  } catch (e: any) {
    if (e?.message === '返回内容不是文件流') ElMessage.error('下载失败：服务器未返回文件流')
    else if (!e?.response) ElMessage.error('下载失败：' + (e?.message || '未知错误'))
  } finally {
    downloading.value = false
    downloadingFile.value = ''
  }
}

async function confirmDeleteFile() {
  if (!deletingFile.value) return
  const file = deletingFile.value
  const warning = file.hasResource
    ? `该文件关联了资源「${file.resourceTitle || '未命名'}」（ID: ${file.resourceId}），删除后该资源的文件引用将被清除，资源记录保留但无法再下载文件。\n\n确定删除文件「${file.name}」？`
    : `该文件为孤立文件（未关联任何资源记录），删除后不可恢复。\n\n确定删除文件「${file.name}」？`
  try {
    await ElMessageBox.confirm(warning, '⚠️ 删除文件确认', {
      type: 'error',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch { return }

  deleteLoading.value = true
  try {
    const res: any = await api.deleteStorageFile(file.name)
    ElMessage.success(res.message || '文件已删除')
    previewVisible.value = false
    deletingFile.value = null
    revokeBlobUrl()
    // 刷新监控数据
    await Promise.all([load(), loadStorage()])
  } catch (e: any) {
    ElMessage.error('删除失败: ' + (e?.response?.data?.message || e?.message || ''))
  } finally {
    deleteLoading.value = false
  }
}

function startDelete(file: any) {
  deletingFile.value = file
  // 如果可预览，先打开预览；否则直接确认删除
  if (isPreviewable(file.name)) {
    openPreview(file, true)
  } else {
    confirmDeleteFile()
  }
}

/** 释放当前预览占用的 Blob URL */
function revokeBlobUrl() {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = ''
  }
  previewUrl.value = ''
}

function handleClosePreview(done?: () => void) {
  previewVisible.value = false
  deletingFile.value = null
  previewFromDelete.value = false
  revokeBlobUrl()
  if (done) done()
}

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
  revokeBlobUrl() // 【v4.3.2】离开页面时释放 Blob，避免内存泄漏
})
</script>

<template>
  <div v-loading="loading">
    <div class="head">
      <h1 class="dh-title"><ZgGlyph emoji="🖥️" /> 网站运行监控</h1>
      <div>
        <el-button @click="() => { load(); loadStorage() }" :loading="loading"><ZgGlyph emoji="🔄" /> 刷新</el-button>
        <span class="auto-refresh-hint">自动每15秒刷新</span>
      </div>
    </div>

    <template v-if="data">
      <!-- 统一告警横幅 -->
      <div v-if="hasAlerts" class="alert-banner">
        <div v-for="(a, i) of data.alerts" :key="i" :class="['alert-item', `alert-${a.level}`]">
          <span class="alert-icon"><ZgGlyph v-if="a.level === 'danger'" emoji="🔴" /><ZgGlyph v-else-if="a.level === 'warning'" emoji="🟡" /><ZgGlyph v-else emoji="🔵" /></span>
          <span class="alert-source">[{{ a.source }}]</span>
          <span class="alert-msg">{{ a.message }}</span>
        </div>
      </div>

      <!-- 在线状态 -->
      <div class="section-title"><ZgGlyph emoji="👥" /> 实时在线 & 今日概览</div>
      <div class="stat-grid">
        <div class="stat-card glass zg-card online">
          <div class="sc-icon"><ZgGlyph emoji="🟢" /></div>
          <div>
            <div class="sc-num big">{{ data.online.online5min }}</div>
            <div class="sc-label">最近5分钟在线</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="🕒" /></div>
          <div>
            <div class="sc-num">{{ data.online.online1hour }}</div>
            <div class="sc-label">最近1小时活跃</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="👥" /></div>
          <div>
            <div class="sc-num">{{ data.online.activeUsers }} / {{ data.online.totalUsers }}</div>
            <div class="sc-label">活跃用户 / 总用户</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="🔐" /></div>
          <div>
            <div class="sc-num">{{ data.online.todayLogins }}</div>
            <div class="sc-label">今日登录人次</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="✍️" /></div>
          <div>
            <div class="sc-num">{{ data.online.todayArticles }}</div>
            <div class="sc-label">今日发布美文</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="📦" /></div>
          <div>
            <div class="sc-num">{{ data.online.todayResources }}</div>
            <div class="sc-label">今日上传资料</div>
          </div>
        </div>
        <div class="stat-card glass zg-card">
          <div class="sc-icon"><ZgGlyph emoji="⭐" /></div>
          <div>
            <div class="sc-num">{{ data.online.todayExps }}</div>
            <div class="sc-label">今日发放经验值</div>
          </div>
        </div>
        <div class="stat-card glass zg-card pending">
          <div class="sc-icon"><ZgGlyph emoji="⏳" /></div>
          <div>
            <div class="sc-num">{{ data.pending.articles + data.pending.resources }}</div>
            <div class="sc-label">待审核（美文{{ data.pending.articles }} / 资料{{ data.pending.resources }}）</div>
          </div>
        </div>
      </div>

      <!-- 双库监控 Tab -->
      <!-- 存储 + 数据库监控 Tab（v4.4.1：Supabase 已废弃，口径统一为 B2 + D1） -->
      <div class="section-title"><ZgGlyph emoji="🗄️" /> 存储与数据库监控（B2 + D1）</div>
      <el-tabs v-model="activeTab" class="monitor-tabs">
        <!-- ============ B2 存储监控 ============ -->
        <el-tab-pane name="b2-storage"><template #label><ZgGlyph emoji="📦" /> B2 存储</template>
          <div v-loading="storageLoading">
            <template v-if="data.b2Storage">
              <!-- 容量进度条 -->
              <div class="capacity-bar-wrap">
                <div class="cap-header">
                  <span class="cap-title">
                    B2 存储容量
                    <el-tooltip :content="data.b2Storage.capacityNote" placement="top">
                      <span style="cursor:help;opacity:.6;">ⓘ</span>
                    </el-tooltip>
                  </span>
                  <span class="cap-numbers">
                    <b>{{ data.b2Storage.totalSizeFmt }}</b> / {{ data.b2Storage.capacityFmt }}
                    （剩余 {{ data.b2Storage.remainingFmt }}）
                  </span>
                </div>
                <div class="capacity-bar">
                  <div :class="['capacity-fill', storageUsedPercentNum > 80 ? 'danger' : storageUsedPercentNum > 60 ? 'warning' : '']"
                       :style="{ width: Math.min(storageUsedPercentNum, 100) + '%' }">
                    <span class="cap-percent">{{ data.b2Storage.usedPercent }}%</span>
                  </div>
                </div>
                <div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                  <span style="font-size:12px;color:var(--zg-text-dim);">
                    数据来源：
                    <b v-if="data.b2Storage.censusSource === 'B2_OFFICIAL_LIST'" style="color:#10b981;">
                      B2 官方盘点
                    </b>
                    <b v-else style="color:#f59e0b;">尚未盘点</b>
                    <template v-if="data.b2Storage.censusDay">
                      ｜盘点日期 {{ data.b2Storage.censusDay }}
                      <el-tag v-if="data.b2Storage.censusStale" size="small" type="warning">非今日</el-tag>
                      <el-tag v-else size="small" type="success">今日</el-tag>
                    </template>
                  </span>
                  <el-button size="small" :loading="censusLoading" @click="runCensus(false)">
                    <ZgGlyph emoji="🔄" /> 立即盘点（每日限 1 次）
                  </el-button>
                  <el-button size="small" text :loading="censusLoading" @click="runCensus(true)">强制重扫</el-button>
                </div>
              </div>

              <div class="row" style="margin-top:16px;">
                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="📊" /> B2 存储概况</div>
                  <div class="kv"><span class="k">后端模式</span><span class="v strong">{{ data.b2Storage.backend }}</span></div>
                  <div class="kv"><span class="k">存储桶</span><span class="v strong">{{ data.b2Storage.bucket }}</span></div>
                  <div class="kv"><span class="k">桶类型</span><span class="v strong">{{ data.b2Storage.bucketType }}</span></div>
                  <div class="kv"><span class="k">文件总数</span><span class="v strong">{{ data.b2Storage.totalFiles ?? '—' }} 个</span></div>
                  <div class="kv"><span class="k">剩余空间</span><span class="v" style="color:#10b981;font-weight:700;">{{ data.b2Storage.remainingFmt }}</span></div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title">
                    <ZgGlyph emoji="🔁" /> 今日回源
                    <el-tooltip :content="data.b2Storage.quotaNote" placement="top">
                      <el-tag size="small" type="warning">本地统计·非官方</el-tag>
                    </el-tooltip>
                  </div>
                  <div class="kv"><span class="k">回源次数</span><span class="v strong">{{ data.b2Storage.quotaToday }} / {{ data.b2Storage.bClassFreeCap }}</span></div>
                  <div class="kv"><span class="k">告警阈值</span><span class="v strong">{{ data.b2Storage.quotaAlert }}</span></div>
                  <div class="kv"><span class="k">状态</span>
                    <span class="v strong" :style="{ color: data.b2Storage.quotaExhausted ? '#ef4444' : '#10b981' }">
                      {{ data.b2Storage.quotaExhausted ? '已耗尽' : '正常' }}
                    </span>
                  </div>
                  <div style="margin-top:8px;font-size:11px;color:var(--zg-text-dim);line-height:1.6;">
                    B2 免费账户不返回官方 B 类计数响应头，且 b2_get_account_info 实测 404，
                    故此数字为本系统实际回源次数，仅用于限速/告警，<b>不是 B2 官方口径</b>。
                  </div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="⚡" /> 下载性能</div>
                  <div class="kv"><span class="k">缓存命中率</span>
                    <span class="v strong" :style="{ color: data.b2Storage.cacheHitRate >= 50 ? '#10b981' : '#f59e0b' }">
                      {{ data.b2Storage.cacheHitRate }}%
                    </span>
                  </div>
                  <div class="kv"><span class="k">命中 / 回源</span><span class="v strong">{{ data.b2Storage.hitCount }} / {{ data.b2Storage.missCount }}</span></div>
                  <div class="kv"><span class="k">命中耗时</span><span class="v strong" style="color:#10b981;">{{ data.b2Storage.hitAvgMs }} ms</span></div>
                  <div class="kv"><span class="k">回源耗时</span><span class="v strong" :style="{ color: data.b2Storage.missAvgMs > 1500 ? '#ef4444' : 'inherit' }">{{ data.b2Storage.missAvgMs }} ms</span></div>
                  <div style="margin-top:8px;">
                    <el-button size="small" :loading="prewarmLoading" @click="prewarmTop">
                      <ZgGlyph emoji="🔥" /> 预热 TOP10 文件
                    </el-button>
                  </div>
                  <div style="margin-top:6px;font-size:11px;color:var(--zg-text-dim);line-height:1.6;">
                    B2 源站在美国西部，跨太平洋回源单文件常需 1~3 秒。
                    预热后由 Cloudflare 边缘节点直接返回，可显著提速。
                  </div>
                </div>
              </div>

              <div class="row" style="margin-top:16px;">
                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="📅" /> 今日流量</div>
                  <div class="kv"><span class="k">今日上传</span><span class="v strong">{{ data.b2Storage.todayUploads }} 个文件</span></div>
                  <div class="kv"><span class="k">上传流量</span><span class="v strong">{{ data.b2Storage.todayUploadSizeFmt }}</span></div>
                  <div class="kv"><span class="k">WebP 图片</span><span class="v strong">{{ data.b2Storage.webpCount }} 个 / {{ fmtBytes(data.b2Storage.webpSize) }}</span></div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="🚚" /> 存量迁移（Supabase → B2）</div>
                  <div class="kv"><span class="k">已迁移文件</span><span class="v strong">{{ data.b2Storage.migration?.migratedFiles ?? 0 }} 个</span></div>
                  <div class="kv"><span class="k">已迁移体积</span><span class="v strong">{{ fmtBytes(data.b2Storage.migration?.migratedBytes || 0) }}</span></div>
                  <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
                    <el-button size="small" type="primary" :loading="migrateLoading" @click="runMigrate(false)">
                      <ZgGlyph emoji="🚚" /> 全量迁移
                    </el-button>
                    <el-button size="small" :loading="migrateLoading" @click="runMigrate(true)">仅盘点</el-button>
                  </div>
                  <div style="margin-top:6px;font-size:11px;color:var(--zg-text-dim);line-height:1.6;">
                    重复执行安全（已迁过的自动跳过）；不删除 Supabase 源文件，可随时回滚。
                  </div>
                </div>

                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="🔥" /> 高频访问文件 TOP 5</div>
                  <div v-if="data.b2Storage.hotResources?.length" class="top-list">
                    <div v-for="f of data.b2Storage.hotResources.slice(0,5)" :key="f.id" class="top-row">
                      <span class="top-name" :title="f.title">{{ f.title }}</span>
                      <span class="top-dl"><ZgGlyph emoji="⬇" /> {{ f.downloads }}</span>
                      <span class="top-size">{{ f.fileSizeFmt }}</span>
                    </div>
                  </div>
                  <div v-else class="empty-hint">暂无下载记录</div>
                </div>
              </div>

              <!-- 大体积文件排行（支持预览+删除） -->
              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title">
                  <ZgGlyph emoji="📈" /> 大体积文件 TOP 10
                  <span class="ip-hint">点击 <ZgGlyph emoji="👁️" /> 查看，<ZgGlyph emoji="⬇️" /> 下载，<ZgGlyph emoji="🗑️" /> 删除</span>
                  <el-switch
                    v-model="onlyOrphan"
                    size="small"
                    active-text="仅看未关联"
                    style="margin-left:12px;"
                  />
                </div>
                <div class="top-list">
                  <template v-for="(f, i) of visibleTopFiles" :key="f.fileId || f.name">
                    <div class="top-row file-mgmt-row file-trace-row">
                      <span class="top-rank">{{ i + 1 }}</span>
                      <div class="ft-main">
                        <div class="ft-line1">
                          <span
                            class="top-name file-name-clickable"
                            :class="{ 'previewable': isPreviewable(f.name) }"
                            :title="isPreviewable(f.name) ? '点击预览' : f.name"
                            @click="isPreviewable(f.name) && openPreview(f)"
                          >{{ f.name }}</span>
                          <span class="top-size">{{ f.sizeFmt }}</span>
                        </div>
                        <div class="ft-line2">
                          <span class="origin-tag" :class="{ 'orphan': f.isOrphan }">
                            <ZgGlyph :emoji="purposeIcon(f.purpose)" />
                            {{ purposeLabel(f.purpose) }}
                          </span>
                          <span v-if="f.resourceTitle" class="origin-meta">
                            <ZgGlyph emoji="📄" /> {{ f.resourceTitle }}
                          </span>
                          <span v-else class="origin-meta" style="opacity:.7;">
                            <ZgGlyph emoji="⚠️" /> 无资源引用（疑似残留）
                          </span>
                          <span v-if="f.mime" class="origin-meta">{{ f.mime }}</span>
                        </div>
                      </div>
                      <el-button
                        size="small" text class="file-act-btn view-btn" title="查看文件内容"
                        @click="openPreview(f)"
                        :loading="previewLoading && previewFile?.name === f.name"
                      >
                        <span style="font-size:14px;"><ZgGlyph emoji="👁️" /></span>
                      </el-button>
                      <el-button
                        size="small" text class="file-act-btn dl-btn" title="下载到本地"
                        @click="downloadStorageFile(f)"
                        :loading="downloading && downloadingFile === f.name"
                      >
                        <span style="font-size:14px;"><ZgGlyph emoji="⬇️" /></span>
                      </el-button>
                      <el-button
                        size="small" type="danger" text class="delete-btn"
                        @click="startDelete(f)"
                        :loading="deleteLoading && deletingFile?.name === f.name"
                      >
                        <span style="font-size:14px;"><ZgGlyph emoji="🗑️" /></span>
                      </el-button>
                    </div>
                  </template>
                  <div v-if="!visibleTopFiles.length" class="empty-hint">
                    {{ onlyOrphan ? '没有未关联的残留文件' : '暂无文件' }}
                  </div>
                </div>
                <div v-if="orphanCount > 0" class="orphan-summary">
                  <ZgGlyph emoji="⚠️" />
                  检测到 <b>{{ orphanCount }}</b> 个未关联文件（数据库查无归属，疑似残留），
                  合计 <b>{{ orphanSizeFmt }}</b>，可安全清理
                </div>
              </div>
            </template>
            <div v-else class="empty-hint">B2 存储监控数据暂不可用</div>
          </div>
        </el-tab-pane>

        <!-- ============ B2 交易与配额（替代原 Supabase 数据库监控） ============ -->
        <el-tab-pane name="b2-quota"><template #label><ZgGlyph emoji="🎫" /> B2 交易与配额</template>
          <div v-loading="storageLoading">
            <div class="row">
              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="🔌" /> B2 连接</div>
                <div class="kv"><span class="k">后端模式</span><span class="v strong">{{ storageData?.backendMode || data.b2Storage?.backend || '—' }}</span></div>
                <div class="kv"><span class="k">存储桶</span><span class="v strong">{{ storageData?.b2?.bucketName || data.b2Storage?.bucket || '—' }}</span></div>
                <div class="kv"><span class="k">桶类型</span><span class="v strong">{{ storageData?.b2?.bucketType || 'allPrivate' }}</span></div>
                <div class="kv"><span class="k">鉴权缓存</span>
                  <span class="v strong" style="color:#10b981;">
                    <ZgGlyph emoji="✅" /> 已落 D1（全球共享）
                  </span>
                </div>
              </div>

              <div class="glass info-panel" style="grid-column: span 2;">
                <div class="ip-title"><ZgGlyph emoji="📋" /> B2 交易类别说明（免费档每日额度）</div>
                <div class="tables">
                  <div class="tbl-row"><span class="tbl-name">A 类 · 上传 / 列举</span><span class="tbl-num">2,500 / 日</span></div>
                  <div class="tbl-row"><span class="tbl-name">B 类 · 下载 / 获取上传 URL</span><span class="tbl-num">2,500 / 日</span></div>
                  <div class="tbl-row"><span class="tbl-name">C 类 · 鉴权 / 桶管理</span><span class="tbl-num">2,500 / 日</span></div>
                </div>
                <div style="margin-top:12px;font-size:12px;color:var(--zg-text-dim);line-height:1.8;">
                  <div><b>C 类为什么以前消耗异常？</b></div>
                  <div>· <code>b2_authorize_account</code>（鉴权）与 <code>b2_list_buckets</code> 都属 C 类。</div>
                  <div>· 旧版把 token 只存在 Worker 内存里，而 Cloudflare 在全球多个节点各起一个实例、且会冷启动回收，
                       于是每个实例、每次冷启动都要重新鉴权一次。</div>
                  <div>· 更糟的是打开监控面板就会调用 <code>b2_list_buckets</code>，刷几次面板就烧几次 C 类。</div>
                  <div>· <b>已修复</b>：token 落 D1 全球共享（每日约 1 次 C 类）；监控面板改为只读本地快照，不再实时调 B2。</div>
                </div>
              </div>
            </div>

            <div class="row" style="margin-top:16px;">
              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="👤" /> 用户回源 TOP（今日）</div>
                <div v-if="storageData?.originTop?.length" class="top-list">
                  <div v-for="(u, i) of storageData.originTop" :key="u.user_id" class="top-row">
                    <span class="top-rank">{{ i + 1 }}</span>
                    <span class="top-name">用户 #{{ u.user_id }}</span>
                    <span class="top-dl">{{ u.cnt }} 次回源</span>
                  </div>
                </div>
                <div v-else class="empty-hint">今日暂无回源记录</div>
              </div>

              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="🗂️" /> 缓存分布</div>
                <div class="kv"><span class="k">可缓存文件</span><span class="v strong" style="color:#10b981;">{{ storageData?.cacheSplit?.cacheable ?? 0 }} 个</span></div>
                <div class="kv"><span class="k">不可缓存文件</span><span class="v strong" style="color:#f59e0b;">{{ storageData?.cacheSplit?.uncacheable ?? 0 }} 个</span></div>
                <div class="kv"><span class="k">file_meta 总数</span><span class="v strong">{{ storageData?.totalFiles ?? 0 }} 个</span></div>
                <div class="kv"><span class="k">元数据体积合计</span><span class="v strong">{{ fmtBytes(storageData?.totalSize || 0) }}</span></div>
              </div>

              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="⚠️" /> Supabase 状态</div>
                <div class="kv"><span class="k">对象存储</span>
                  <span class="v strong" style="color:#ef4444;"><ZgGlyph emoji="⛔" /> 已废弃</span>
                </div>
                <div style="margin-top:8px;font-size:11px;color:var(--zg-text-dim);line-height:1.7;">
                  上传/下载已全部改走 B2。Supabase 仅保留只读回退，用于迁移未完成时的兼容，
                  不再写入任何新文件。存量文件可通过上方「全量迁移」搬到 B2。
                </div>
              </div>
            </div>

            <div v-if="storageData?.b2Error" class="glass info-panel" style="margin-top:16px;border-color:#ef4444;">
              <div class="ip-title" style="color:#ef4444;"><ZgGlyph emoji="❌" /> B2 数据拉取异常</div>
              <div style="font-size:12px;">{{ storageData.b2Error }}</div>
            </div>
          </div>
        </el-tab-pane>

        <!-- ============ D1 数据库监控 ============ -->
        <el-tab-pane name="d1"><template #label><ZgGlyph emoji="💾" /> D1 数据库</template>
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
                <div class="ip-title"><ZgGlyph emoji="🗄️" /> D1 概况</div>
                <div class="kv"><span class="k">已用空间</span><span class="v strong">{{ data.database.fileSizeFmt }}</span></div>
                <div class="kv"><span class="k">总页数</span><span class="v">{{ data.database.pageCount }} 页</span></div>
                <div class="kv"><span class="k">页大小</span><span class="v">{{ data.database.pageSize }} B</span></div>
                <div class="kv"><span class="k">空闲页</span><span class="v">{{ data.database.freePages }} 页 ({{ data.database.freeSpaceFmt }})</span></div>
                <div class="kv"><span class="k">总记录数</span><span class="v strong">{{ totalTableRows.toLocaleString() }} 条</span></div>
                <div class="kv"><span class="k">表数量</span><span class="v">{{ data.database.tableCount }} 张</span></div>
                <div v-if="data.database.emptyTables?.length" class="kv">
                  <span class="k">空表</span>
                  <span class="v" style="color:var(--zg-primary);">{{ data.database.emptyTables.length }} 张</span>
                </div>
              </div>
              <div class="glass info-panel db-tables">
                <div class="ip-title"><ZgGlyph emoji="📋" /> 各表数据量</div>
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
        <el-tab-pane name="cache"><template #label><ZgGlyph emoji="🚀" /> 缓存系统</template>
          <template v-if="data.cache">
            <div class="row">
              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="🔥" /> 热点文件缓存</div>
                <div class="kv"><span class="k">缓存文件数</span><span class="v strong">{{ data.cache.hotFile.count }} / {{ data.cache.hotFile.maxCount }}</span></div>
                <div class="kv"><span class="k">缓存总大小</span><span class="v strong">{{ data.cache.hotFile.totalSizeFmt }}</span></div>
                <div class="kv"><span class="k">总命中次数</span><span class="v" style="color:#10b981;font-weight:700;">{{ data.cache.hotFile.totalHits }} 次</span></div>
              </div>
              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="⚡" /> API 内存缓存</div>
                <div class="kv"><span class="k">缓存条目数</span><span class="v strong">{{ data.cache.api.count }} / {{ data.cache.api.maxCount }}</span></div>
              </div>
              <div class="glass info-panel">
                <div class="ip-title"><ZgGlyph emoji="🌐" /> 边缘缓存</div>
                <div class="kv"><span class="k">类型</span><span class="v strong">{{ data.cache.edgeCache }}</span></div>
                <div class="kv"><span class="k">缓存策略</span><span class="v">已审核资源：边缘缓存 24h</span></div>
                <div class="kv"><span class="k">热点策略</span><span class="v">Worker 内存缓存 30min</span></div>
              </div>
            </div>
            <div class="glass info-panel" style="margin-top:16px;">
              <div class="ip-title"><ZgGlyph emoji="🛠️" /> 缓存管理</div>
              <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">
                <el-button type="warning" size="small" @click="optimizeAction('purge_cache')"><ZgGlyph emoji="🗑️" /> 清除文件缓存</el-button>
                <span style="font-size:12px;color:var(--zg-text-dim);line-height:32px;">清除后所有文件将从 B2 重新拉取并重建缓存</span>
              </div>
            </div>
          </template>
        </el-tab-pane>

        <!-- ============ 存储优化 ============ -->
        <el-tab-pane name="optimize"><template #label><ZgGlyph emoji="📦" /> 存储优化</template>
          <div v-loading="storageLoading">
            <template v-if="storageData">
              <!-- 当前后端模式 -->
              <div class="optimize-summary glass zg-card">
                <div class="opt-stat">
                  <div class="opt-num" :style="{ color: (storageData.backendMode||'').includes('PAID') ? '#ef4444' : (storageData.backendMode||'').includes('SUPABASE') ? '#f59e0b' : '#10b981' }">{{ storageData.backendMode || 'B2_FREE' }}</div>
                  <div class="opt-label">当前存储后端</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num">{{ storageData.totalFiles || 0 }}</div>
                  <div class="opt-label">D1 元数据文件数</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num">{{ formatBytes(storageData.totalSize || 0) }}</div>
                  <div class="opt-label">已记录总字节</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num" style="color:#10b981;">{{ storageData.webpCount || 0 }}</div>
                  <div class="opt-label">WebP 转换数</div>
                </div>
                <div class="opt-stat">
                  <div class="opt-num" style="color:var(--zg-primary);">{{ formatBytes(storageData.webpSize || 0) }}</div>
                  <div class="opt-label">WebP 体积</div>
                </div>
              </div>

              <!-- B2 配额（本地真实回源统计，明确标注非官方） -->
              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title"><ZgGlyph emoji="📡" /> B2 回源统计（本地统计 · 非官方）</div>
                <div style="font-size:12px;color:#f59e0b;line-height:1.6;margin-bottom:8px;">
                  ⚠ {{ storageData.quotaNote || 'B2 免费账户不暴露官方每日 B 类计数，此值为本系统真实回源次数（非猜测），仅供限速/告警参考。' }}
                </div>
                <template v-if="storageData.b2">
                  <div class="capacity-bar-wrap">
                    <div class="cap-header">
                      <span class="cap-title">当日真实回源次数（本地统计）</span>
                      <span class="cap-numbers">
                        <b>{{ storageData.quotaToday || 0 }}</b> / {{ storageData.bClassFreeCap || 2500 }}
                        <span v-if="storageData.quotaAlerted" style="color:#ef4444;font-weight:700;margin-left:8px;">⚠ 已达告警阈值 {{ storageData.quotaAlert }}</span>
                        <span v-if="storageData.quotaExhausted" style="color:#ef4444;font-weight:700;margin-left:8px;">🚫 免费额度耗尽</span>
                      </span>
                    </div>
                    <div class="capacity-bar">
                      <div :class="['capacity-fill', storageData.quotaAlerted ? 'danger' : 'warning']"
                           :style="{ width: Math.min(Math.round((storageData.quotaToday || 0) / (storageData.bClassFreeCap || 2500) * 100), 100) + '%' }">
                        <span class="cap-percent">{{ Math.round((storageData.quotaToday || 0) / (storageData.bClassFreeCap || 2500) * 100) }}%</span>
                      </div>
                    </div>
                  </div>
                  <div class="kv"><span class="k">桶名称</span><span class="v strong">{{ storageData.b2.bucketName || '-' }}</span></div>
                  <div class="kv"><span class="k">桶类型</span><span class="v strong">{{ storageData.b2.bucketType || '-' }}</span></div>
                  <div class="kv"><span class="k">桶文件数（官方盘点）</span><span class="v strong">{{ storageData.b2.fileCount != null ? storageData.b2.fileCount : '未盘点' }}</span></div>
                  <div class="kv"><span class="k">桶已用容量（官方盘点）</span><span class="v strong">{{ storageData.b2.totalSizeBytes != null ? formatBytes(storageData.b2.totalSizeBytes) : '未盘点' }}</span></div>
                  <div class="kv"><span class="k">盘点日期</span>
                    <span class="v strong">{{ storageData.b2.censusDay || '—' }}
                      <el-tag v-if="storageData.b2.censusStale" size="small" type="warning">非今日</el-tag>
                      <el-tag v-else-if="storageData.b2.censusDay" size="small" type="success">今日</el-tag>
                    </span>
                  </div>
                  <div class="kv"><span class="k">容量上限</span><span class="v strong">{{ formatBytes(storageData.capacityBytes || 0) }}（B2 免费档，非 API 可得）</span></div>
                  <div class="kv"><span class="k">已迁移文件</span><span class="v strong">{{ storageData.migration?.migratedFiles ?? 0 }} 个 / {{ formatBytes(storageData.migration?.migratedBytes || 0) }}</span></div>
                  <div style="margin-top:8px;">
                    <el-button size="small" :loading="censusLoading" @click="runCensus(false)">
                      <ZgGlyph emoji="🔄" /> 立即盘点官方容量（每日限 1 次）
                    </el-button>
                  </div>
                  <div style="margin-top:6px;font-size:11px;color:var(--zg-text-dim);line-height:1.6;">
                    官方口径说明：B2 的 <code>b2_get_account_info</code> 在本账户实测返回 404，
                    <code>b2_list_buckets</code> 响应也不含 fileCount/totalSize 字段，
                    故「官方已用容量」只能通过 <code>b2_list_file_names</code> 全量盘点求和得到（属 A 类交易，故每日限 1 次）。
                  </div>
                </template>
                <div v-else class="empty-hint">⚠ B2 官方数据拉取失败：{{ storageData.b2Error || '未知错误' }}（请检查 B2 密钥与网络）</div>
              </div>

              <!-- 缓存命中率 / 下载速度（本地埋点，非 B2 容量类） -->
              <div class="row" style="margin-top:16px;">
                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="⚡" /> 缓存命中率（当日）</div>
                  <div class="opt-num" style="font-size:32px;color:var(--zg-primary);font-weight:800;">{{ storageData.cacheHitRate != null ? storageData.cacheHitRate : 0 }}%</div>
                  <div class="kv"><span class="k">命中次数</span><span class="v">{{ storageData.hitCount || 0 }}</span></div>
                  <div class="kv"><span class="k">回源次数</span><span class="v">{{ storageData.missCount || 0 }}</span></div>
                </div>
                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="⏱️" /> 下载耗时（当日均值）</div>
                  <div class="kv"><span class="k">缓存命中均值</span><span class="v strong" style="color:#10b981;">{{ storageData.hitAvgMs || 0 }} ms</span></div>
                  <div class="kv"><span class="k">回源均值</span><span class="v strong" style="color:#f59e0b;">{{ storageData.missAvgMs || 0 }} ms</span></div>
                  <div class="kv"><span class="k">可缓存/不可缓存</span><span class="v">{{ storageData.cacheSplit?.cacheable || 0 }} / {{ storageData.cacheSplit?.uncacheable || 0 }}</span></div>
                </div>
                <div class="glass info-panel">
                  <div class="ip-title"><ZgGlyph emoji="👥" /> 各用户当日真实回源 TOP</div>
                  <div v-if="storageData.originTop?.length" class="top-list">
                    <div v-for="(u, i) of storageData.originTop" :key="i" class="top-row">
                      <span class="top-rank">{{ i + 1 }}</span>
                      <span class="top-name">用户 #{{ u.user_id }}</span>
                      <span class="top-size">{{ u.cnt }} 次</span>
                    </div>
                  </div>
                  <div v-else class="empty-hint">暂无回源记录</div>
                </div>
              </div>

              <div class="glass info-panel" style="margin-top:16px;">
                <div class="ip-title"><ZgGlyph emoji="🛠️" /> 快捷操作</div>
                <div style="display:flex;gap:12px;margin-top:10px;flex-wrap:wrap;">
                  <el-button type="primary" size="small" @click="loadStorage()"><ZgGlyph emoji="🔄" /> 刷新 B2 监控</el-button>
                  <el-button type="warning" size="small" @click="optimizeAction('purge_cache')"><ZgGlyph emoji="🗑️" /> 清除文件缓存</el-button>
                </div>
              </div>
            </template>
          </div>
        </el-tab-pane>
      </el-tabs>

      <!-- Cloudflare 平台状态 + 用户角色分布 -->
      <div class="section-title"><ZgGlyph emoji="☁️" /> Cloudflare 平台状态</div>
      <div class="row">
        <div class="glass info-panel">
          <div class="ip-title"><ZgGlyph emoji="🌐" /> 运行环境</div>
          <div class="kv"><span class="k">运行时</span><span class="v strong">{{ data.platform.runtime }}</span></div>
          <div class="kv"><span class="k">边缘节点</span><span class="v strong">{{ data.platform.colo }}</span></div>
          <div class="kv"><span class="k">访问地区</span><span class="v">{{ data.platform.country }}</span></div>
          <div class="kv"><span class="k">HTTP协议</span><span class="v">{{ data.platform.httpProtocol }}</span></div>
          <div class="kv"><span class="k">TLS加密</span><span class="v">{{ data.platform.tlsVersion }}</span></div>
          <div class="kv"><span class="k">边缘部署</span><span class="v strong" style="color:#10b981;"><ZgGlyph emoji="✅" /> 是</span></div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title"><ZgGlyph emoji="📊" /> 套餐限制</div>
          <div class="kv"><span class="k">D1数据库区域</span><span class="v">{{ data.platform.d1Region }}</span></div>
          <div class="kv"><span class="k">D1容量上限</span><span class="v strong">{{ data.platform.d1SizeLimit }}</span></div>
          <div class="kv"><span class="k">Worker CPU</span><span class="v">{{ data.platform.workerCpuLimit }}</span></div>
          <div class="kv"><span class="k">子请求限制</span><span class="v">{{ data.platform.workerSubrequests }}</span></div>
          <div class="kv"><span class="k">每日请求</span><span class="v">100,000 次 (免费)</span></div>
          <div class="kv"><span class="k">费用</span><span class="v strong" style="color:#10b981;">¥0 不绑卡</span></div>
        </div>

        <div class="glass info-panel">
          <div class="ip-title"><ZgGlyph emoji="👤" /> 用户角色分布</div>
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
      <div class="section-title"><ZgGlyph emoji="📈" /> 趋势分析</div>
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

    <!-- ===== 文件预览弹窗（超管删除前预览） ===== -->
    <el-dialog
      v-model="previewVisible"
      title="文件预览"
      width="80%"
      top="5vh"
      :close-on-click-modal="false"
      :before-close="handleClosePreview"
    >
      <div v-loading="previewLoading" class="preview-container">
        <!-- 图片预览 -->
        <div v-if="previewFile && isImage(previewFile.name)" class="preview-image-wrap">
          <img :src="previewUrl" class="preview-image" alt="预览图片" @load="previewLoading = false" @error="previewLoading = false" />
        </div>
        <!-- PDF 预览 -->
        <iframe
          v-else-if="previewFile && isPdf(previewFile.name)"
          :src="previewUrl"
          class="preview-pdf"
          frameborder="0"
          @load="previewLoading = false"
        ></iframe>
        <!-- 不支持预览的文件类型 -->
        <div v-else class="preview-other">
          <div class="file-info-card">
            <div class="file-info-icon"><ZgGlyph emoji="📎" /></div>
            <div class="file-info-name">{{ previewFile?.name }}</div>
            <div class="file-info-size">{{ previewFile?.sizeFmt }}</div>
            <div v-if="previewFile?.hasResource" class="file-info-resource">
              <ZgGlyph emoji="🔗" /> 关联资源: {{ previewFile?.resourceTitle || '未命名' }}
              <span class="file-info-id">（ID: {{ previewFile?.resourceId }}）</span>
            </div>
            <div v-else class="file-info-resource" style="color:var(--zg-primary);"><ZgGlyph emoji="⚠️" /> 孤立文件（未关联任何资源记录）</div>
          </div>
          <div class="preview-tip">
            {{ previewFromDelete ? '该文件类型不支持在线预览，确认无误后可删除' : '该文件类型不支持在线预览，可下载到本地查看' }}
          </div>
        </div>
      </div>
      <!-- 预览弹窗底部：文件信息 + 删除按钮 -->
      <template #footer>
        <div class="preview-footer">
          <div class="preview-file-meta">
            <span class="pfm-name" :title="previewFile?.name">{{ previewFile?.name }}</span>
            <span class="pfm-size">{{ previewFile?.sizeFmt }}</span>
            <el-tag v-if="previewFile?.hasResource" size="small" type="warning">
              关联资源: {{ previewFile?.resourceTitle || '未命名' }}
            </el-tag>
            <el-tag v-else size="small" type="danger">孤立文件</el-tag>
          </div>
          <div class="preview-footer-actions">
            <el-button @click="handleClosePreview">{{ previewFromDelete ? '取消' : '关闭' }}</el-button>
            <!-- 【v4.3.2】不管从哪个入口进来，都能顺手把文件下载到本地 -->
            <el-button
              v-if="previewFile"
              @click="downloadStorageFile(previewFile)"
              :loading="downloading && downloadingFile === previewFile?.name"
            >
              <span style="margin-right:4px;"><ZgGlyph emoji="⬇️" /></span> 下载
            </el-button>
            <el-button
              v-if="previewFromDelete"
              type="danger"
              @click="confirmDeleteFile"
              :loading="deleteLoading"
            >
              <span style="margin-right:4px;"><ZgGlyph emoji="🗑️" /></span> 删除文件
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>
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
.alert-warning { background:rgba(var(--zg-primary-rgb),.1); border:1px solid rgba(var(--zg-primary-rgb),.3); color:#d97706; }
.alert-info { background:rgba(59,130,246,.1); border:1px solid rgba(59,130,246,.3); color:#2563eb; }
.alert-icon { font-size:16px; }
.alert-source { font-weight:700; flex-shrink:0; }
.alert-msg { flex:1; }

/* 统计卡片 */
.stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:14px; }
.stat-card { display:flex; align-items:center; gap:14px; padding:18px; }
.stat-card.online { border:2px solid rgba(16,185,129,.3); background:rgba(16,185,129,.05); }
.stat-card.pending { border:2px solid rgba(239,68,68,.3); }
.sc-icon { width:48px; height:48px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; background:rgba(var(--zg-primary-rgb),.1); }
.sc-num { font-size:22px; font-weight:800; color:var(--zg-accent); }
.sc-num.big { font-size:30px; color:#10b981; }
.sc-label { font-size:12px; color:var(--zg-text-dim); }

/* Tab */
.monitor-tabs { margin-top:8px; }
.monitor-tabs :deep(.el-tabs__item) { font-weight:600; font-size:14px; }

/* 容量进度条 */
.capacity-bar-wrap { background:rgba(var(--zg-primary-rgb),.05); border-radius:12px; padding:16px; }
.cap-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px; }
.cap-title { font-weight:700; font-size:14px; }
.cap-numbers { font-size:13px; color:var(--zg-text-dim); }
.cap-numbers b { color:var(--zg-primary); font-size:16px; }
.capacity-bar { height:28px; background:rgba(0,0,0,.06); border-radius:14px; overflow:hidden; position:relative; }
.capacity-fill { height:100%; background:linear-gradient(90deg,#10b981,#34d399); border-radius:14px; transition:width .5s ease; display:flex; align-items:center; justify-content:flex-end; padding-right:12px; min-width:40px; }
.capacity-fill.warning { background:linear-gradient(90deg,var(--zg-primary),var(--zg-accent)); }
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
.kv { display:flex; justify-content:space-between; font-size:13px; padding:4px 0; border-bottom:1px dashed rgba(var(--zg-primary-rgb),.1); }
.kv:last-child { border-bottom:none; }
.k { color:var(--zg-text-dim); }
.v { color:var(--zg-text); text-align:right; max-width:60%; word-break:break-all; }
.v.strong { font-weight:700; color:var(--zg-primary); }

.role-row { display:flex; align-items:center; gap:10px; padding:6px 0; }
.role-name { width:80px; font-size:13px; flex-shrink:0; }
.role-bar { flex:1; height:20px; background:rgba(var(--zg-primary-rgb),.08); border-radius:10px; overflow:hidden; }
.role-bar-fill { display:block; height:100%; background:linear-gradient(90deg,var(--zg-primary),var(--zg-accent)); border-radius:10px; transition:width .3s; }
.role-num { width:60px; font-size:13px; font-weight:700; text-align:right; flex-shrink:0; }

.db-row { display:grid; grid-template-columns:300px 1fr; gap:16px; }
.db-info { padding:20px; }
.db-tables { padding:20px; }
.tables { margin-top:6px; max-height:280px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
.tbl-row { display:flex; justify-content:space-between; padding:5px 8px; font-size:12px; border-radius:6px; }
.tbl-row:nth-child(odd) { background:rgba(var(--zg-primary-rgb),.05); }
.tbl-name { color:var(--zg-text-dim); }
.tbl-num { font-weight:700; color:var(--zg-accent); }
.tbl-empty { font-size:10px; color:var(--zg-primary); margin-left:8px; }

/* TOP 列表 */
.top-list { display:flex; flex-direction:column; gap:4px; max-height:300px; overflow-y:auto; }
.top-row { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:6px; font-size:12px; }
.top-row:nth-child(odd) { background:rgba(var(--zg-primary-rgb),.05); }
.top-rank { width:24px; height:24px; border-radius:50%; background:rgba(var(--zg-primary-rgb),.15); display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--zg-accent); flex-shrink:0; }
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

/* ===== 大体积文件管理（预览+删除） ===== */
.ip-hint { font-size:11px; color:var(--zg-text-dim); font-weight:400; margin-left:8px; }
.file-mgmt-row { padding:6px 8px; }
.file-mgmt-row:hover { background:rgba(var(--zg-primary-rgb),.1); }

/* ===== 【v4.3.1】文件溯源 ===== */
.file-trace-row { align-items:flex-start; }
.ft-main { flex:1; min-width:0; }
.ft-line1 { display:flex; align-items:center; gap:8px; }
.ft-line1 .top-size { margin-left:auto; flex-shrink:0; }
.ft-line2 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:3px; }
.origin-tag {
  display:inline-flex; align-items:center; gap:3px;
  padding:1px 7px; border-radius:6px; font-size:11px; font-weight:600; cursor:help;
  background:rgba(var(--zg-primary-rgb),.12); color:var(--zg-primary);
}
.origin-tag b { font-weight:700; }
/* 孤儿文件（数据库查无归属）用警示色，提醒可清理 */
.origin-tag.orphan { background:rgba(239,68,68,.12); color:#dc2626; }
.origin-tag.orphan b { color:#b91c1c; }
.origin-meta { font-size:11px; color:var(--zg-text-dim); }
.origin-jump { padding:0 4px; height:18px; font-size:11px; }
.orphan-summary {
  margin-top:10px; padding:8px 10px; border-radius:8px; font-size:12px;
  background:rgba(239,68,68,.08); color:#b91c1c; line-height:1.6;
}
.orphan-summary b { font-weight:700; }
.file-name-clickable { cursor:default; }
.file-name-clickable.previewable { cursor:pointer; color:var(--zg-accent); text-decoration:underline; text-decoration-style:dotted; }
.file-name-clickable.previewable:hover { color:var(--zg-primary); }
.resource-tag { font-size:12px; margin-left:4px; cursor:help; }
.delete-btn { padding:4px 6px; flex-shrink:0; }

/* ===== 【v4.3.2】文件操作按钮：查看 / 下载 ===== */
.file-act-btn { padding:4px 5px; flex-shrink:0; margin-left:2px; transition:color .18s ease; }
.file-act-btn.view-btn:hover { color:var(--zg-accent); }
.file-act-btn.dl-btn:hover { color:var(--zg-primary); }
/* 墨金主题下沿用主题强调色，不入侵经典暖橘 :root */
html.zg-inkgold .file-act-btn.view-btn:hover { color:var(--zg-accent); }
html.zg-inkgold.zg-inkgold-dark .file-act-btn.view-btn:hover { color:var(--zg-accent); }

/* ===== 文件预览弹窗 ===== */
.preview-container { min-height:300px; display:flex; align-items:center; justify-content:center; }
.preview-image-wrap { display:flex; justify-content:center; align-items:center; max-height:70vh; overflow:auto; }
.preview-image { max-width:100%; max-height:70vh; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,.15); }
.preview-pdf { width:100%; height:70vh; border-radius:8px; border:1px solid rgba(0,0,0,.1); }
.preview-other { text-align:center; padding:40px 20px; }
.file-info-card { display:inline-flex; flex-direction:column; align-items:center; gap:8px; padding:30px 40px; background:rgba(var(--zg-primary-rgb),.05); border-radius:12px; border:1px dashed rgba(var(--zg-primary-rgb),.2); }
.file-info-icon { font-size:48px; }
.file-info-name { font-weight:700; font-size:15px; color:var(--zg-text); word-break:break-all; max-width:400px; }
.file-info-size { font-size:13px; color:var(--zg-text-dim); }
.file-info-resource { font-size:12px; color:var(--zg-accent); }
.file-info-id { color:var(--zg-text-dim); }
.preview-tip { margin-top:16px; font-size:13px; color:var(--zg-text-dim); }

/* 预览弹窗底部 */
.preview-footer { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.preview-file-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0; }
.pfm-name { font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:300px; }
.pfm-size { font-size:12px; color:var(--zg-text-dim); flex-shrink:0; }
.preview-footer-actions { display:flex; gap:8px; flex-shrink:0; }
</style>
