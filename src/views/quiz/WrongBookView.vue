<script setup lang="ts">
// 【v4.6.0】错题本（对标智学网·学生端）：归集答错题目，按知识点归类，可一键重练
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useUserStore } from '@/store/user'
import { renderMarkdown } from '@/utils/markdown'
import { ElMessage } from 'element-plus'
import ZgGlyph from '@/components/ZgGlyph.vue'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const slug = route.params.slug as string | undefined

const subject = ref<any>(null)
const list = ref<any[]>([])
const loading = ref(false)
const expanded = ref<Record<number, boolean>>({})

async function load() {
  loading.value = true
  try {
    let sid: number | undefined
    if (slug) { subject.value = await api.subject(slug); sid = subject.value.id }
    else if (!user.isStudent) {
      // 教师全局视图：可切换学科
      const subs = (await api.subjects()) as any
      subject.value = subs[0] || null
      sid = subject.value?.id
    }
    list.value = (await api.myWrongQuestions(sid)) as any
  } catch (e: any) { ElMessage.error(e?.response?.data?.message || '加载错题失败') }
  finally { loading.value = false }
}

// 按知识点分组
const groups = computed(() => {
  const m: Record<string, any[]> = {}
  for (const q of list.value) {
    const kp = (q.knowledge_points && q.knowledge_points[0]?.name) || '未分类'
    ;(m[kp] ||= []).push(q)
  }
  return Object.entries(m).map(([name, items]) => ({ name, items, count: items.length }))
})

function toggle(id: number) { expanded.value[id] = !expanded.value[id] }
function repractice(id: number) { router.push(`/practice/${id}`) }

onMounted(load)
</script>

<template>
  <div class="zg-container wrongbook">
    <div class="wb-head">
      <h2><ZgGlyph emoji="📕" /> 我的错题本 · {{ subject?.name || '全部学科' }}</h2>
      <span class="hint">答错的题目自动归集，按知识点归类，点击「重练」巩固薄弱点</span>
    </div>

    <el-skeleton v-if="loading" :rows="6" animated />
    <template v-else>
      <el-alert v-if="!list.length" type="info" :closable="false" show-icon
        title="太棒了，目前没有错题！" description="完成单题练习后，答错的题目会自动出现在这里。" style="margin-bottom:16px" />
      <el-card v-for="g in groups" :key="g.name" shadow="never" class="blk">
        <template #header>
          <b><ZgGlyph emoji="🏷️" /> {{ g.name }}</b>
          <el-tag size="small" type="danger" effect="plain" style="margin-left:8px">{{ g.count }} 道</el-tag>
        </template>
        <div v-for="q in g.items" :key="q.id" class="wq">
          <div class="wq-top" @click="toggle(q.id)">
            <span class="qtag">{{ ({single:'单选',multiple:'多选',judge:'判断',fill:'填空',subjective:'主观'} as any)[q.qtype] || q.qtype }}</span>
            <span class="qcontent" v-html="renderMarkdown(String(q.content).slice(0, 90))" />
            <el-button text size="small">{{ expanded[q.id] ? '收起' : '展开' }}</el-button>
          </div>
          <div v-if="expanded[q.id]" class="wq-detail">
            <div class="row"><b>参考答案：</b><span v-html="renderMarkdown(q.answer || '—')" /></div>
            <div class="row" v-if="q.analysis"><b>解析：</b><span v-html="renderMarkdown(q.analysis)" /></div>
            <el-button type="primary" size="small" :icon="'Refresh'" @click="repractice(q.id)">重练此题</el-button>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.wb-head { display: flex; align-items: baseline; gap: 12px; margin: 8px 0 16px; flex-wrap: wrap; }
.wb-head h2 { margin: 0; font-size: 20px; }
.wb-head .hint { color: var(--zg-primary); font-size: 13px; }
.blk { margin-bottom: 14px; }
.wq { border-bottom: 1px dashed rgba(var(--zg-primary-rgb), .22); padding: 8px 0; }
.wq:last-child { border-bottom: none; }
.wq-top { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.qtag { font-size: 11px; padding: 1px 6px; border-radius: 6px; color: #fff; background: var(--zg-primary); flex: none; }
.qcontent { flex: 1; font-size: 14px; color: #444; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wq-detail { margin-top: 8px; padding: 10px; background: rgba(var(--zg-primary-rgb), .06); border-radius: 10px; font-size: 14px; line-height: 1.7; }
.wq-detail .row { margin-bottom: 6px; }
.wq-detail :deep(p) { margin: 0; display: inline; }
</style>
