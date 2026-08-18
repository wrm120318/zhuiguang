<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { ElMessage } from 'element-plus'

const router = useRouter()
const user = useUserStore()
const data = useDataStore()
const form = ref({
  title: '', content: '', scope: 'site' as 'site' | 'class', classId: null as number | null,
  // 需求2：置顶选项
  pinned: false, pinnedScope: 'site' as 'site' | 'class'
})
const attachments = ref<any[]>([])
const submitting = ref(false)

// 权限：超管可发全站+班级；教师只能发班级
const canSite = computed(() => user.isSuperAdmin)
const canClass = computed(() => user.isSuperAdmin || user.isTeacher)

function onScopeChange() {
  if (form.value.scope === 'site') { form.value.classId = null; form.value.pinnedScope = 'site' }
  else if (!form.value.classId && data.classes.length) { form.value.classId = data.classes[0].id }
}

const TAGS = {
  h2: '## 小标题\n\n',
  h3: '### 三级标题\n\n',
  b: '**加粗文字**',
  list: '- 列表项\n- 列表项\n',
  quote: '> 引用文字\n\n',
  link: '[文字](链接)',
}
function insertTag(tag: string) { form.value.content += tag }

async function onUploadImage(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadImage(file)
    form.value.content += `\n![图片](${r.url})\n`
    ElMessage.success('图片已插入')
  } catch (e: any) {
    console.error('[图片上传失败]', e)
    ElMessage.error(e?.message || '图片上传失败')
  }
}

async function onUploadFile(req: any) {
  const file = req.file as File
  if (!file) return
  try {
    const r: any = await api.uploadFile(file)
    attachments.value.push({ url: r.url, name: r.fileName, size: r.fileSize, type: r.fileType })
    ElMessage.success('附件已添加')
  } catch (e: any) {
    console.error('[附件上传失败]', e)
    ElMessage.error(e?.message || '附件上传失败')
  }
}

function removeAttach(idx: number) { attachments.value.splice(idx, 1) }
function fmtSize(n: number) { return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB' }

async function submit() {
  if (!form.value.title || !form.value.content) { ElMessage.warning('请填写标题和正文'); return }
  if (form.value.scope === 'class' && !form.value.classId) { ElMessage.warning('请选择班级'); return }
  submitting.value = true
  try {
    await api.createPage({
      ptype: 'announcement', scope: form.value.scope, classId: form.value.classId,
      title: form.value.title, content: form.value.content, attachments: attachments.value,
      // 需求2：置顶参数
      pinned: form.value.pinned, pinnedScope: form.value.pinned ? form.value.pinnedScope : 'none',
    })
    ElMessage.success('公告已发布')
    router.push('/announcements')
  } catch { /* */ } finally { submitting.value = false }
}
</script>

<template>
  <div class="page zg-container">
    <div class="back" @click="router.back()"><ZgGlyph emoji="←" /> 返回</div>
    <div class="glass-strong editor">
      <h1 class="ep-title"><ZgGlyph emoji="📢" /> 发布公告</h1>

      <div class="scope-row">
        <span class="sr-label">公告类型：</span>
        <el-radio-group v-model="form.scope" @change="onScopeChange">
          <el-radio v-if="canSite" value="site"><ZgGlyph emoji="🌐" /> 全站公告（所有人可见）</el-radio>
          <el-radio v-if="canClass" value="class"><ZgGlyph emoji="🏫" /> 班级公告（仅本班学生可见）</el-radio>
        </el-radio-group>
      </div>

      <div v-if="form.scope === 'class'" class="class-row">
        <span class="sr-label">选择班级：</span>
        <el-select v-model="form.classId" placeholder="选择班级" style="width:240px">
          <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
      </div>

      <!-- 需求2：置顶选项（仅超管可用） -->
      <div v-if="user.isSuperAdmin" class="pin-row">
        <span class="sr-label">置顶设置：</span>
        <el-checkbox v-model="form.pinned"><ZgGlyph emoji="📌" /> 置顶此公告</el-checkbox>
        <el-select v-if="form.pinned" v-model="form.pinnedScope" size="small" style="width:180px; margin-left:12px">
          <el-option value="site"><ZgGlyph emoji="🌐" /> 全站置顶（所有人顶部）</el-option>
          <el-option value="class"><ZgGlyph emoji="🏫" /> 班级置顶（仅对应班级）</el-option>
        </el-select>
      </div>

      <el-input v-model="form.title" placeholder="公告标题" size="large" style="margin:12px 0" />

      <div class="toolbar">
        <button @click="insertTag(TAGS.h2)">H2</button>
        <button @click="insertTag(TAGS.h3)">H3</button>
        <button @click="insertTag(TAGS.b)"><b>B</b></button>
        <button @click="insertTag(TAGS.list)">列表</button>
        <button @click="insertTag(TAGS.quote)">引用</button>
        <button @click="insertTag(TAGS.link)">链接</button>
        <el-upload :http-request="onUploadImage" :show-file-list="false" accept="image/*" class="tb-upload">
          <button><ZgGlyph emoji="🖼" /> 插入图片</button>
        </el-upload>
        <el-upload :http-request="onUploadFile" :show-file-list="false" multiple class="tb-upload">
          <button><ZgGlyph emoji="📎" /> 添加附件</button>
        </el-upload>
      </div>
      <el-input v-model="form.content" type="textarea" :rows="14" placeholder="支持 Markdown：## 标题、**加粗**、- 列表、> 引用、![图片](url)、[链接](url)" />

      <div v-if="attachments.length" class="att-list">
        <div class="att-title"><ZgGlyph emoji="📎" /> 附件（{{ attachments.length }}）</div>
        <div v-for="(a, i) in attachments" :key="i" class="att-item">
          <span><ZgGlyph emoji="📄" /> {{ a.name }} ({{ fmtSize(a.size) }})</span>
          <el-button text type="danger" size="small" @click="removeAttach(i)">移除</el-button>
        </div>
      </div>

      <div class="ep-foot">
        <el-button @click="router.back()">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">发布公告</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.back { padding: 12px 0; color: var(--zg-text-dim); cursor: pointer; width: fit-content; font-size: 14px; }
.back:hover { color: var(--zg-primary); }
.editor { padding: 24px; }
.ep-title { font-size: 24px; font-weight: 800; margin-bottom: 16px; }
.scope-row, .class-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.sr-label { font-weight: 600; font-size: 14px; }
.toolbar { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; align-items: center; }
.toolbar button { background: rgba(245,158,11,.06); border: 1px solid rgba(245,158,11,.15); color: var(--zg-text); padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.toolbar button:hover { background: rgba(245,158,11,.2); }
.tb-upload { display: inline-block; }
.att-list { margin-top: 16px; }
.att-title { font-size: 13px; color: var(--zg-text-dim); margin-bottom: 8px; }
.att-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: rgba(245,158,11,.05); border-radius: 8px; margin-bottom: 6px; font-size: 13px; }
.ep-foot { margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end; }
@media (max-width: 768px) { .editor { padding: 16px; } }
</style>
