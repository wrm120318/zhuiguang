<script setup lang="ts">
// 【v4.8.15】答题卡制作（对标智学网制卡工具）
// ---------------------------------------------------------------------------
// 替换原先 ExamManageView 里那个 20 行的 window.open + 手写 HTML 实现。
// 旧实现的问题：
//   ① 客观题只画「（  ）」括号，不是真正的涂卡区（机器/网阅都识别不了）；
//   ② 主观题固定 3 条横线，与分值无关 —— 6 分的解答题和 2 分的填空一样高；
//   ③ 没有考号填涂区、没有缺考标记、没有 AB 卷标记；
//   ④ 纸张固定 A4 单栏，A3 双栏根本出不来；
//   ⑤ 打印用 window.open 易被拦截，且样式依赖内联字符串难以维护。
//
// 本组件按智学网的实际制卡要素实现：
//   · 卡型：网阅卡 / 手阅卡
//   · 纸张：A4 纵向 / A3 横向
//   · 版面：一栏 / 两栏 / 三栏
//   · 考号：填涂式（可选 8/9/10/12 位）或条形码
//   · 客观题：真正的 ABCD 涂卡点（椭圆，可调直径与间距）
//   · 主观题：作答区高度按分值自适应（分值越大留白越多）
//   · 标记：缺考标记、AB 卷标记、页码、装订线
//   · 输出：新窗口打印（带 @page 尺寸），降级为 Blob 下载
//
// 设计取舍：不做「拖拽框选题块」（那需要 canvas + 坐标系 + 后端切图配合，
// 是完整产品的量级）。这里做的是「参数化生成标准答题卡」，
// 覆盖教师日常印卡需求，且所有参数可调、可复用。
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { renderMarkdown } from '@/utils/markdown'

const props = defineProps<{
  exam: any
  subjectName?: string
}>()

// ===== 参数 =====
const paper = ref<'A4' | 'A3'>('A4')
const orientation = ref<'portrait' | 'landscape'>('portrait')
const columns = ref<1 | 2 | 3>(1)
const cardType = ref<'online' | 'hand'>('online')
const idMode = ref<'fill' | 'barcode'>('fill')
const idDigits = ref(9)
const bubSize = ref(7)          // 涂点直径 px
const bubGap = ref(15)          // 同题选项间距 px
const showAbsent = ref(true)    // 缺考标记
const showVersion = ref(false)  // AB 卷标记
const showSealLine = ref(true)  // 装订线
const showPageMark = ref(true)  // 页码标记
const lineHeight = ref(26)      // 主观题每行高度 px
const linesPerPoint = ref(1.6)  // 每 1 分给几行（1.6 行/分）

// 纸张尺寸（mm）—— 打印用 @page，屏幕预览按 mm 渲染
const paperSize = computed(() => {
  if (paper.value === 'A3') return orientation.value === 'landscape' ? '420mm 297mm' : '297mm 420mm'
  return orientation.value === 'landscape' ? '297mm 210mm' : '210mm 297mm'
})

const questions = computed<any[]>(() => props.exam?.questions || [])
const objective = computed(() => questions.value.filter(q => ['single', 'multiple', 'judge'].includes(q.qtype)))
const subjective = computed(() => questions.value.filter(q => !['single', 'multiple', 'judge'].includes(q.qtype)))
const totalScore = computed(() => questions.value.reduce((s, q) => s + (Number(q.score) || 0), 0))

// 客观题选项数（取最大值，保证涂卡区列宽一致）
const maxOptions = computed(() => {
  let m = 4
  objective.value.forEach(q => { m = Math.max(m, (q.options || []).length || 4) })
  return Math.min(m, 8)
})

function letters(n: number) { return Array.from({ length: n }, (_, i) => 'ABCDEFGH'[i]) }
const optionLetters = computed(() => letters(maxOptions.value))

// 主观题作答区行数：按分值换算，最少 2 行
function answerLines(q: any): number {
  const sc = Number(q.score) || 0
  return Math.max(2, Math.round(sc * linesPerPoint.value))
}

// 学生信息栏 / 考号填涂格
const idDigitList = computed(() => Array.from({ length: idDigits.value }, (_, i) => i))

// ===== 生成打印 HTML =====
function buildHtml(): string {
  const es = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
  const stripMd = (s: string) => String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>=]/g, '')
    .replace(/\$\$?([^$]+)\$\$?/g, '$1')   // 公式退化为纯文本（打印不需 KaTeX）
    .trim()

  const colCount = columns.value
  const title = props.exam?.title || '考试'

  // --- 客观题涂卡区：每题一行，题号 + N 个椭圆涂点 ---
  const objRows = objective.value.map((q, i) => {
    const n = (q.options || []).length || 4
    const bubs = letters(n).map(L =>
      `<span class="opt"><span class="bub" style="width:${bubSize.value}mm;height:${bubSize.value + 1.6}mm"></span><span class="ol">${L}</span></span>`
    ).join('')
    const multi = q.qtype === 'multiple' ? ' <span class="mtag">多选</span>' : ''
    return `<div class="obj-row"><span class="onum">${i + 1}</span><span class="opts">${bubs}</span>${multi}</div>`
  }).join('')

  // --- 主观题作答区：按分值给行数 ---
  const subjBlocks = subjective.value.map((q, i) => {
    const idx = objective.value.length + i + 1
    const lines = answerLines(q)
    const rule = Array.from({ length: lines }, () => '<div class="aline"></div>').join('')
    return `<div class="subj">
      <div class="subj-head"><span class="snum">${idx}</span><span class="sscore">（${es(q.score)} 分）</span><span class="stext">${es(stripMd(q.content)).slice(0, 150)}</span></div>
      <div class="subj-body">${rule}</div>
    </div>`
  }).join('')

  // --- 考号填涂区 ---
  let idBlock = ''
  if (idMode.value === 'fill') {
    const head = idDigitList.value.map(() => '<span class="idcell"></span>').join('')
    const rows = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d =>
      `<div class="idrow">${idDigitList.value.map(() => `<span class="idbub"><i></i>${d}</span>`).join('')}</div>`
    ).join('')
    idBlock = `<div class="idzone">
      <div class="idlabel">准考证号</div>
      <div class="idhead">${head}</div>
      <div class="idgrid">${rows}</div>
    </div>`
  } else {
    idBlock = `<div class="idzone barcode">
      <div class="idlabel">条形码粘贴处</div>
      <div class="barframe">（请将条形码粘贴在此框内，切勿超出边框）</div>
    </div>`
  }

  // --- 缺考 / AB 卷标记 ---
  const absentBlock = showAbsent.value
    ? `<div class="absent"><span class="bub big"></span><span>缺考标记（由监考教师填涂）</span></div>` : ''
  const versionBlock = showVersion.value
    ? `<div class="version">试卷类型：<span class="vp"><span class="bub"></span>A卷</span><span class="vp"><span class="bub"></span>B卷</span></div>` : ''

  // --- 页脚页码 ---
  const pageFoot = showPageMark.value ? `<div class="pages">第 ____ 页 / 共 ____ 页</div>` : ''

  // 装订线：竖向虚线 + 文字（只在左侧）
  const sealLine = showSealLine.value ? '<div class="seal">装 订 线</div>' : ''

  const bodyClass = `cols-${colCount}${sealLine ? ' has-seal' : ''}`
  const pageRule = columns.value > 1 ? 'column-rule:1px dashed #bbb;column-gap:8mm;' : ''

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${es(title)} · 答题卡</title>
<style>
  @page { size: ${paperSize.value}; margin: 10mm 8mm; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;
         color:#111; margin:0; font-size:10.5pt; line-height:1.5; position:relative; }
  /* 装订线 */
  .seal { position:fixed; left:2mm; top:0; bottom:0; width:8mm; border-right:1px dashed #999;
          writing-mode:vertical-rl; text-align:center; letter-spacing:6px; color:#888; font-size:9pt; padding-top:20mm; }
  body.has-seal .wrap { padding-left:12mm; }
  h1 { font-size:15pt; text-align:center; margin:0 0 2mm; letter-spacing:1px; }
  .subtitle { text-align:center; color:#555; font-size:9.5pt; margin-bottom:3mm; }
  /* 头部：学生信息 + 考号/条码 */
  .head { display:flex; gap:6mm; align-items:flex-start; border:1px solid #333;
          padding:3mm; margin-bottom:4mm; }
  .head-left { flex:1; }
  .info-line { display:flex; gap:4mm; margin-bottom:3mm; font-size:10pt; }
  .info-line .fld { flex:1; border-bottom:1px solid #333; padding-bottom:1mm; }
  .info-line .fld b { font-weight:400; color:#333; }
  .absent, .version { font-size:9.5pt; margin-top:2mm; display:flex; align-items:center; gap:2mm; }
  .version .vp { display:inline-flex; align-items:center; gap:1mm; margin-left:3mm; }
  .bub { display:inline-block; width:7mm; height:8.6mm; border:0.6pt solid #333; border-radius:50%/50%;
         vertical-align:middle; }
  .absent .bub.big { width:9mm; height:11mm; }
  /* 考号填涂区 */
  .idzone { flex:0 0 auto; }
  .idlabel { font-size:9pt; text-align:center; margin-bottom:1mm; color:#333; }
  .idhead { display:flex; gap:1.6mm; margin-bottom:1mm; }
  .idcell { width:6mm; height:4mm; border:0.6pt solid #333; }
  .idrow { display:flex; gap:1.6mm; }
  .idbub { width:6mm; height:6mm; border:0.6pt solid #333; font-size:7pt; text-align:center;
           line-height:6mm; position:relative; }
  .idbub i { display:block; width:3.4mm; height:3.4mm; border:0.5pt solid #666; border-radius:50%;
             margin:1.3mm auto 0; }
  .idbub { text-indent:-100px; overflow:hidden; }   /* 数字仅在下方显示 */
  .idzone.barcode { width:52mm; }
  .barframe { height:28mm; border:0.8pt dashed #333; font-size:9pt; color:#666;
              display:flex; align-items:center; justify-content:center; text-align:center; padding:2mm; }
  /* 分栏容器 */
  .wrap { ${pageRule} }
  body.cols-2 .wrap, body.cols-3 .wrap { }
  .cols-2 .sec, .cols-3 .sec { break-inside:avoid; }
  body.cols-2 .wrap { column-count:2; }
  body.cols-3 .wrap { column-count:3; }
  body.cols-1 .wrap { column-count:1; }
  /* 小节标题 */
  .sec { margin-bottom:4mm; break-inside:avoid; }
  .sec-title { font-weight:700; font-size:11pt; border-left:3px solid #333; padding-left:2mm;
               margin:0 0 2mm; }
  /* 客观题行 */
  .obj-row { display:flex; align-items:center; gap:2mm; margin-bottom:2.2mm; break-inside:avoid; }
  .onum { width:7mm; text-align:right; font-weight:700; font-size:10pt; flex:0 0 auto; }
  .opts { display:flex; gap:${bubGap.value / 3}mm; flex-wrap:wrap; }
  .opt { display:inline-flex; align-items:center; gap:0.8mm; }
  .ol { font-size:9pt; }
  .mtag { font-size:8pt; color:#666; border:0.5pt solid #999; padding:0 1mm; border-radius:1mm; }
  /* 主观题 */
  .subj { margin-bottom:4mm; break-inside:avoid; }
  .subj-head { display:flex; gap:2mm; align-items:baseline; margin-bottom:1.5mm; }
  .snum { font-weight:700; font-size:10pt; flex:0 0 auto; }
  .sscore { color:#555; font-size:9pt; flex:0 0 auto; }
  .stext { color:#333; font-size:9pt; overflow:hidden; }
  .subj-body { border:0.6pt solid #999; padding:2mm; }
  .aline { height:${lineHeight.value / 3.2}mm; border-bottom:0.5pt dotted #bbb; }
  .aline:last-child { border-bottom:none; }
  .pages { text-align:center; font-size:9pt; color:#666; margin-top:4mm; }
</style></head><body class="${bodyClass}">
${sealLine}
<div class="wrap">
  <h1>${es(title)}</h1>
  <div class="subtitle">${es(props.subjectName || '')} ｜ 总分 ${totalScore.value} 分 ｜ 共 ${questions.value.length} 题${cardType.value === 'online' ? ' ｜ 网阅卡' : ' ｜ 手阅卡'}</div>
  <div class="head">
    <div class="head-left">
      <div class="info-line"><span class="fld"><b>姓名：</b></span><span class="fld"><b>班级：</b></span><span class="fld"><b>学号：</b></span></div>
      ${absentBlock}
      ${versionBlock}
    </div>
    ${idBlock}
  </div>
  ${objective.value.length ? `<div class="sec sec-obj"><div class="sec-title">一、客观题（请用 2B 铅笔填涂）</div>${objRows}</div>` : ''}
  ${subjective.value.length ? `<div class="sec sec-subj"><div class="sec-title">二、主观题（请在框内作答）</div>${subjBlocks}</div>` : ''}
  ${pageFoot}
</div>
</body></html>`
}

// ===== 输出 =====
const previewHtml = ref('')
const showPreview = ref(false)

function openPreview() {
  previewHtml.value = buildHtml()
  showPreview.value = true
}

function printSheet() {
  const html = buildHtml()
  const w = window.open('', '_blank')
  if (!w) {
    // 弹窗被拦截 → 降级为下载 HTML，用户可自行打开打印
    downloadHtml(html)
    return
  }
  w.document.open()
  w.document.write(html)
  w.document.close()
  // 等字体/布局稳定再唤起打印
  setTimeout(() => { try { w.focus(); w.print() } catch { /* 用户可手动 Ctrl+P */ } }, 400)
}

function downloadHtml(html?: string) {
  const content = html || buildHtml()
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${props.exam?.title || '答题卡'}·答题卡.html`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(a.href), 3000)
  ElMessage.success('答题卡已下载，用浏览器打开后可直接打印')
}
</script>

<template>
  <div class="sheet-panel">
    <el-alert
      type="info" :closable="false" show-icon
      title="答题卡制作"
      description="按考试题目自动生成标准答题卡：客观题为可填涂椭圆，主观题作答区高度按分值自适应。支持 A4/A3、一栏/两栏/三栏、考号填涂或条形码。" />

    <!-- 参数区 -->
    <div class="sp-form">
      <div class="sp-row">
        <label>卡型</label>
        <el-radio-group v-model="cardType" size="small">
          <el-radio-button value="online">网阅卡</el-radio-button>
          <el-radio-button value="hand">手阅卡</el-radio-button>
        </el-radio-group>
      </div>
      <div class="sp-row">
        <label>纸张</label>
        <el-radio-group v-model="paper" size="small">
          <el-radio-button value="A4">A4</el-radio-button>
          <el-radio-button value="A3">A3</el-radio-button>
        </el-radio-group>
        <el-radio-group v-model="orientation" size="small" style="margin-left:8px">
          <el-radio-button value="portrait">纵向</el-radio-button>
          <el-radio-button value="landscape">横向</el-radio-button>
        </el-radio-group>
      </div>
      <div class="sp-row">
        <label>版面</label>
        <el-radio-group v-model="columns" size="small">
          <el-radio-button :value="1">一栏</el-radio-button>
          <el-radio-button :value="2">两栏</el-radio-button>
          <el-radio-button :value="3">三栏</el-radio-button>
        </el-radio-group>
      </div>
      <div class="sp-row">
        <label>考号</label>
        <el-radio-group v-model="idMode" size="small">
          <el-radio-button value="fill">填涂式</el-radio-button>
          <el-radio-button value="barcode">条形码</el-radio-button>
        </el-radio-group>
        <el-input-number v-if="idMode === 'fill'" v-model="idDigits" :min="6" :max="12" size="small" style="width:110px;margin-left:8px" />
        <span v-if="idMode === 'fill'" class="sp-hint">位</span>
      </div>
      <div class="sp-row">
        <label>主观题留白</label>
        <el-slider v-model="linesPerPoint" :min="0.8" :max="3" :step="0.2" style="width:160px" />
        <span class="sp-hint">{{ linesPerPoint.toFixed(1) }} 行/分</span>
      </div>
      <div class="sp-row">
        <label>标记</label>
        <el-checkbox v-model="showAbsent" size="small">缺考标记</el-checkbox>
        <el-checkbox v-model="showVersion" size="small">AB 卷</el-checkbox>
        <el-checkbox v-model="showSealLine" size="small">装订线</el-checkbox>
        <el-checkbox v-model="showPageMark" size="small">页码</el-checkbox>
      </div>
    </div>

    <!-- 摘要 + 操作 -->
    <div class="sp-summary">
      <div class="sp-stat"><b>{{ objective.length }}</b><span>客观题</span></div>
      <div class="sp-stat"><b>{{ subjective.length }}</b><span>主观题</span></div>
      <div class="sp-stat"><b>{{ totalScore }}</b><span>总分</span></div>
      <div class="sp-actions">
        <el-button icon="View" @click="openPreview">预览</el-button>
        <el-button type="primary" icon="Printer" @click="printSheet">打印答题卡</el-button>
        <el-button icon="Download" @click="downloadHtml()">下载 HTML</el-button>
      </div>
    </div>

    <!-- 预览（iframe 沙箱渲染，与打印输出完全一致） -->
    <el-dialog v-model="showPreview" title="答题卡预览" width="92%" top="3vh" append-to-body class="sheet-preview-dlg">
      <div class="sp-preview">
        <iframe :srcdoc="previewHtml" title="答题卡预览" />
      </div>
      <template #footer>
        <el-button @click="showPreview = false">关闭</el-button>
        <el-button type="primary" icon="Printer" @click="printSheet">打印</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.sheet-panel { display: flex; flex-direction: column; gap: 14px; }
.sp-form {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px; border-radius: 14px;
  background: rgba(var(--zg-primary-rgb, 245 158 11), .05);
  border: 1px solid rgba(var(--zg-primary-rgb, 245 158 11), .12);
}
.sp-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sp-row > label { width: 84px; flex: none; font-size: 13px; color: var(--zg-text-dim, #8a7a5e); }
.sp-hint { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); }
.sp-summary {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 12px 14px; border-radius: 14px;
  background: rgba(var(--zg-primary-rgb, 245 158 11), .06);
}
.sp-stat { display: flex; flex-direction: column; align-items: center; min-width: 56px; }
.sp-stat b { font-size: 18px; color: var(--zg-primary, #f59e0b); font-variant-numeric: tabular-nums; }
.sp-stat span { font-size: 12px; color: var(--zg-text-dim, #8a7a5e); }
.sp-actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.sp-preview {
  height: 72vh; overflow: auto; background: #6b6b6b; padding: 16px;
  border-radius: 10px; display: flex; justify-content: center;
}
.sp-preview iframe {
  width: 100%; max-width: 900px; height: 100%;
  border: 0; background: #fff; border-radius: 4px;
  box-shadow: 0 8px 28px rgba(0,0,0,.35);
}
@media (max-width: 768px) {
  .sp-row > label { width: 100%; }
  .sp-actions { margin-left: 0; width: 100%; }
  .sp-actions .el-button { flex: 1 1 calc(50% - 4px); margin: 0; min-height: 44px; }
  .sp-preview { height: 60vh; padding: 8px; }
}
</style>
