<script setup lang="ts">
// 【v4.5.0】Word 导出（客户端 docx.js，免费可靠）：试卷 / 答案解析 / 答题卡
import { ref, reactive } from 'vue'
import { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel, PageBreak } from 'docx'
import { saveAs } from 'file-saver'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  subjectName: string
  items: any[]
}>()
const emit = defineEmits<{ (e: 'done'): void }>()

const cfg = reactive({
  title: `${props.subjectName} 测验卷`,
  template: 'formal' as 'formal' | 'test' | 'homework',
  withAnswer: true,     // 试卷是否直接带答案/解析
  withAnswerSheet: true, // 是否附加答题卡
  twoColumn: false,
  fontSize: 12,
})

const templates: Record<string, string> = {
  formal: '正式考试卷', test: '日常测验卷', homework: '课后作业卷',
}

// Markdown → 纯文本（docx 不支持直接渲染 Markdown，做基础降级）
function mdToText(md: string): string {
  if (!md) return ''
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`~]/g, '')
    .replace(/==([^=]+)==/g, '$1')
    .replace(/\$\$([^$]+)\$\$/g, '$1')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

function optLetter(i: number) { return 'ABCDEFGH'[i] || '?' }

async function buildDoc(withAnswers: boolean, sheetOnly: boolean): Promise<Blob> {
  const children: any[] = []
  if (!sheetOnly) {
    children.push(new Paragraph({ text: cfg.title, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }))
    children.push(new Paragraph({ text: `学科：${props.subjectName}　总分：${props.items.reduce((s, i) => s + (Number(i.basketScore) || 0), 0)} 分　共 ${props.items.length} 题`, alignment: AlignmentType.CENTER, spacing: { after: 200 } }))
    props.items.forEach((it, idx) => {
      const labels: Record<string, string> = { single: '单选题', multiple: '多选题', judge: '判断题', fill: '填空题', subjective: '主观题' }
      const label = labels[it.qtype] || ''
      children.push(new Paragraph({
        children: [new TextRun({ text: `${idx + 1}.（${label}）`, bold: true }), new TextRun(` ${mdToText(it.content)}（${it.basketScore}分）`)],
        spacing: { before: 120, after: 40 },
      }))
      ;(it.options || []).forEach((o: string, i: number) => {
        children.push(new Paragraph({ text: `${optLetter(i)}. ${mdToText(o)}`, indent: { left: 360 }, spacing: { after: 20 } }))
      })
      if (withAnswers) {
        children.push(new Paragraph({ text: `【答案】${mdToText(it.answer)}`, spacing: { before: 20, after: 20 }, indent: { left: 360 } }))
        if (it.analysis) children.push(new Paragraph({ text: `【解析】${mdToText(it.analysis)}`, indent: { left: 360 }, spacing: { after: 20 } }))
      }
    })
  } else {
    children.push(new Paragraph({ text: `${cfg.title} · 答题卡`, heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER }))
    children.push(new Paragraph({ text: '班级：__________ 姓名：__________ 学号：__________', spacing: { after: 200 } }))
    props.items.forEach((it, idx) => {
      children.push(new Paragraph({ text: `${idx + 1}. （${it.basketScore}分）`, spacing: { before: 80, after: 40 } }))
      children.push(new Paragraph({ text: '答：________________________________________', spacing: { after: 20 } }))
    })
  }
  const doc = new Document({
    sections: [{
      properties: cfg.twoColumn ? { column: { count: 2, space: 360 } } : {},
      children,
    }],
  })
  return await Packer.toBlob(doc)
}

async function download(blob: Blob, name: string) {
  saveAs(blob, `${cfg.title}-${name}.docx`)
}

async function onExportPaper() {
  try {
    const blob = await buildDoc(cfg.withAnswer, false)
    await download(blob, cfg.withAnswer ? '试卷(含答案)' : '试卷')
    if (cfg.withAnswerSheet) {
      const sheet = await buildDoc(false, true)
      await download(sheet, '答题卡')
    }
    ElMessage.success('已生成 Word')
    emit('done')
  } catch (e: any) { ElMessage.error('生成失败：' + (e?.message || e)) }
}
</script>

<template>
  <div class="export-panel">
    <el-form label-position="top">
      <el-form-item label="试卷标题">
        <el-input v-model="cfg.title" />
      </el-form-item>
      <el-form-item label="试卷模板">
        <el-radio-group v-model="cfg.template">
          <el-radio-button v-for="(l, v) in templates" :key="v" :value="v">{{ l }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="导出选项">
        <el-checkbox v-model="cfg.withAnswer">试卷内附带答案/解析</el-checkbox>
        <el-checkbox v-model="cfg.withAnswerSheet">同时生成答题卡</el-checkbox>
        <el-checkbox v-model="cfg.twoColumn">双栏排版</el-checkbox>
      </el-form-item>
      <el-form-item label="字号">
        <el-slider v-model="cfg.fontSize" :min="10" :max="16" />
      </el-form-item>
      <el-alert type="info" :closable="false" title="说明" description="Word 导出在浏览器端完成，使用免费开源库 docx.js，无需任何付费服务。Markdown 公式/图片在 Word 中以纯文本降级呈现，复杂排版建议在网页端校对。" />
      <el-button type="primary" :disabled="!props.items.length" @click="onExportPaper" icon="Download">生成并下载 Word</el-button>
    </el-form>
  </div>
</template>

<style scoped>
.export-panel { padding: 4px; }
</style>
