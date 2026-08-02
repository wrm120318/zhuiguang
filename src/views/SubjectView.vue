<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDataStore } from '@/store/data'
import { useUserStore } from '@/store/user'
import { api } from '@/api'
import { formatSize, fileIcon } from '@/utils/helpers'
import { ElMessage, type UploadFile } from 'element-plus'

const route = useRoute()
const router = useRouter()
const data = useDataStore()
const user = useUserStore()

const subject = ref<any>(null)
const activeTab = ref('announcement')
const subjectResources = ref<any[]>([])
const subjectArticles = ref<any[]>([])
const subjectQueries = ref<any[]>([])
const contributors = ref<any[]>([])

async function load() {
  const slug = route.params.slug as string
  subject.value = await api.subject(slug)
  if (!subject.value) return
  activeTab.value = 'announcement'
  const sid = subject.value.id
  subjectResources.value = (await api.resources({ subjectId: sid, status: 'approved' })) as any
  subjectArticles.value = (await api.articles({ subjectId: sid, status: 'approved' })) as any
  if (user.isLogin) {
    const all = (await api.queryTasks()) as any
    subjectQueries.value = (all || []).filter((t: any) => t.subject_id === sid)
  }
  contributors.value = (await api.leaderboard({ scope: 'subject', subjectId: sid, period: 'total' })) as any
}
onMounted(load)
watch(() => route.params.slug, load)

const tabs = computed(() => {
  if (!subject.value) return []
  const m = subject.value.modules
  const t: { key: string; label: string }[] = []
  if (m.announcement) t.push({ key: 'announcement', label: '公告栏' })
  if (m.resources) t.push({ key: 'resources', label: '资料共享' })
  if (m.articles) t.push({ key: 'articles', label: '美文共赏' })
  if (m.query) t.push({ key: 'query', label: '数据查询' })
  if (m.leaderboard) t.push({ key: 'leaderboard', label: '学科榜' })
  return t
})

const canManage = computed(() => subject.value ? user.canManageSubject(subject.value.id) : false)
const canUpload = computed(() => user.isLogin)

async function toggleModule(key: string) {
  if (!subject.value) return
  subject.value.modules[key] = !subject.value.modules[key]
  await api.updateSubject(subject.value.id, { modules: subject.value.modules })
  ElMessage.success('模块设置已更新')
}

const moduleLabels: Record<string, string> = {
  announcement: '公告栏', resources: '资料共享', articles: '美文共赏', query: '数据查询', quiz: '题库自测', leaderboard: '学科榜'
}

async function likeArticle(id: number) { try { await api.likeArticle(id); const a = subjectArticles.value.find(x => x.id === id); if (a) a.likes++ } catch { /* */ } }
async function likeResource(id: number) { try { await api.likeResource(id); const r = subjectResources.value.find(x => x.id === id); if (r) r.likes++ } catch { /* */ } }
async function downloadResource(r: any) {
  try {
    const resp: any = await api.downloadResource(r.id)
    const contentType = resp.headers['content-type'] || ''
    if (contentType.includes('application/json')) {
      try {
        const text = await resp.data.text()
        const err = JSON.parse(text)
        ElMessage.error(err.message || '下载失败')
      } catch {
        ElMessage.error('下载失败')
      }
      return
    }
    const blob = new Blob([resp.data], { type: contentType || 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = r.file_name || r.title || 'download'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    r.downloads++
    ElMessage.success('下载开始')
  } catch (e: any) {
    const msg = e?.response?.data?.message || e?.message || '下载失败，请重试'
    ElMessage.error(msg)
  }
}

// 公告编辑
const announceEditing = ref(false)
const announceDraft = ref('')
function startEditAnnounce() { announceDraft.value = subject.value?.announcement || ''; announceEditing.value = true }
async function saveAnnounce() {
  if (!subject.value) return
  await api.updateSubject(subject.value.id, { announcement: announceDraft.value })
  subject.value.announcement = announceDraft.value
  announceEditing.value = false
  ElMessage.success('公告已更新')
}

// 资源上传
const resUploadVisible = ref(false)
const resForm = ref({ title: '', description: '', category: '课件', tagsInput: '' })
const resFile = ref<any>(null)
const resFileMeta = ref<any>({ fileName: '', fileType: '', fileSize: 0, filePath: '' })
const resSubmitting = ref(false)

function openResUpload() {
  resForm.value = { title: '', description: '', category: '课件', tagsInput: '' }
  resFile.value = null
  resFileMeta.value = { fileName: '', fileType: '', fileSize: 0, filePath: '' }
  resUploadVisible.value = true
}

async function onResFile(file: UploadFile) {
  const raw = file.raw as File
  if (!raw) return false
  try {
    const r: any = await api.uploadFile(raw)
    resFileMeta.value = { fileName: r.fileName, fileType: r.fileType, fileSize: r.fileSize, filePath: r.filePath }
    if (!resForm.value.title) resForm.value.title = r.fileName.replace(/\.[^.]+$/, '')
    ElMessage.success('文件已上传，请补充信息后提交')
  } catch { /* */ }
  return false
}

async function submitResource() {
  if (!resForm.value.title || !resFileMeta.value.filePath) { ElMessage.warning('请填写标题并上传文件'); return }
  resSubmitting.value = true
  try {
    const r: any = await api.createResource({
      subjectId: subject.value.id,
      title: resForm.value.title,
      description: resForm.value.description,
      fileName: resFileMeta.value.fileName,
      fileType: resFileMeta.value.fileType,
      fileSize: resFileMeta.value.fileSize,
      filePath: resFileMeta.value.filePath,
      category: resForm.value.category,
      tags: resForm.value.tagsInput.split(/[,，]/).map(t => t.trim()).filter(Boolean),
      classId: user.classIds[0] || 1,
    })
    ElMessage.success(r.status === 'approved' ? '资料已发布' : '资料已提交，待审核后公开')
    resUploadVisible.value = false
    subjectResources.value = (await api.resources({ subjectId: subject.value.id, status: 'approved' })) as any
  } catch { /* */ } finally { resSubmitting.value = false }
}
</script>

<template>
  <div class="page zg-container" v-if="subject">
    <div class="subj-hero glass-strong" :style="{ '--c': subject.color }">
      <div class="sh-icon" :style="{ background: `linear-gradient(135deg, ${subject.color}, ${subject.color}88)` }">{{ subject.icon }}</div>
      <div class="sh-info">
        <h1 class="sh-name">{{ subject.name }} <span class="sh-sub">/ {{ subject.slug }}</span></h1>
        <p class="sh-desc">{{ subject.description }}</p>
        <div class="sh-stats">
          <span>📚 资料 {{ subjectResources.length }}</span>
          <span v-if="subject.modules.articles">✍️ 美文 {{ subjectArticles.length }}</span>
          <span>📊 查询 {{ subjectQueries.length }}</span>
        </div>
      </div>
      <div class="sh-manage" v-if="canManage">
        <el-popover trigger="click" width="240" placement="bottom-end">
          <template #reference><el-button circle>⚙️</el-button></template>
          <div class="mod-toggle">
            <div class="mt-title">模块显隐</div>
            <div v-for="(label, key) in moduleLabels" :key="key" class="mt-row">
              <span>{{ label }}</span>
              <el-switch :model-value="subject.modules[key]" @change="toggleModule(key)" size="small" />
            </div>
          </div>
        </el-popover>
      </div>
    </div>

    <div class="sub-nav glass">
      <div v-for="t in tabs" :key="t.key" class="sub-tab" :class="{ on: activeTab === t.key }" @click="activeTab = t.key">{{ t.label }}</div>
    </div>

    <section v-if="activeTab === 'announcement'" class="tab-panel">
      <div class="glass announce-box">
        <div class="ab-tag">📌 教师置顶公告</div>
        <p class="ab-text" v-if="!announceEditing">{{ subject.announcement || '暂无公告' }}</p>
        <el-input v-else v-model="announceDraft" type="textarea" :rows="4" />
        <div class="ab-actions" v-if="canManage">
          <template v-if="!announceEditing">
            <el-button size="small" @click="startEditAnnounce">编辑公告</el-button>
          </template>
          <template v-else>
            <el-button size="small" @click="announceEditing = false">取消</el-button>
            <el-button size="small" type="primary" @click="saveAnnounce">保存</el-button>
          </template>
        </div>
      </div>
    </section>

    <section v-if="activeTab === 'resources'" class="tab-panel">
      <div class="panel-head">
        <div class="section-title">资料共享区</div>
        <el-button v-if="canUpload" type="primary" round size="small" @click="openResUpload">+ 上传资料</el-button>
      </div>
      <div class="res-grid">
        <div v-for="r in subjectResources" :key="r.id" class="res-card glass zg-card">
          <div class="rc-top"><div class="rc-icon">{{ fileIcon(r.file_type) }}</div><el-tag size="small" effect="dark">{{ r.category }}</el-tag></div>
          <div class="rc-title">{{ r.title }}</div>
          <div class="rc-desc">{{ r.description }}</div>
          <div class="rc-tags"><span v-for="t in r.tags" :key="t" class="rc-tag">#{{ t }}</span></div>
          <div class="rc-foot">
            <span class="rc-meta">{{ formatSize(r.file_size) }}</span>
            <div class="rc-acts"><span @click="downloadResource(r)">⬇ {{ r.downloads }}</span><span @click="likeResource(r.id)">👍 {{ r.likes }}</span></div>
          </div>
        </div>
      </div>
      <el-empty v-if="!subjectResources.length" description="暂无资料" />
    </section>

    <section v-if="activeTab === 'articles'" class="tab-panel">
      <div class="panel-head">
        <div class="section-title">美文共赏</div>
        <el-button v-if="canUpload" type="primary" round size="small" @click="router.push('/article/new')">+ 发布美文</el-button>
      </div>
      <div class="article-grid">
        <div v-for="a in subjectArticles" :key="a.id" class="art-card glass zg-card" @click="router.push(`/article/${a.id}`)">
          <div class="ac-cover" :style="{ backgroundImage: `url(${a.cover})` }"><span class="ac-cat">{{ a.category }}</span></div>
          <div class="ac-body"><div class="ac-title">{{ a.title }}</div><div class="ac-author">{{ a.author }}</div><div class="ac-meta"><span>❤ {{ a.likes }}</span><span>👁 {{ a.views }}</span></div></div>
        </div>
      </div>
      <el-empty v-if="!subjectArticles.length" description="暂无美文" />
    </section>

    <section v-if="activeTab === 'query'" class="tab-panel">
      <div class="section-title">数据查询任务</div>
      <div class="query-grid">
        <div v-for="t in subjectQueries" :key="t.id" class="query-card glass zg-card" @click="router.push(`/query/${t.id}`)">
          <div class="qc-title">{{ t.title }}</div>
          <div class="qc-note">{{ t.note }}</div>
          <div class="qc-foot"><span>发布：{{ t.creator_name }}</span><span>有效期至 {{ t.valid_until }}</span></div>
          <el-button type="primary" size="small" round>查询我的数据</el-button>
        </div>
      </div>
      <el-empty v-if="!subjectQueries.length" description="暂无查询任务" />
    </section>

    <section v-if="activeTab === 'leaderboard'" class="tab-panel">
      <div class="section-title">{{ subject.name }} · 贡献榜</div>
      <div class="rank-list glass">
        <div v-for="(u, i) in contributors" :key="u.id" class="rank-item" :class="{ top: i < 3 }">
          <div class="rank-no" :class="`n${i + 1}`">{{ i + 1 }}</div>
          <img :src="u.avatar" class="rank-avatar" />
          <div class="rank-info"><div class="rank-name">{{ u.real_name }}</div><div class="rank-role">{{ u.role === 'TEACHER' ? '教师' : '学生' }} · Lv.{{ u.level }}</div></div>
          <div class="rank-exp">{{ u.pe }}</div>
        </div>
        <el-empty v-if="!contributors.length" description="暂无贡献者" />
      </div>
    </section>

    <!-- 资料上传弹窗 -->
    <el-dialog v-model="resUploadVisible" title="上传资料" width="520px">
      <el-form label-width="80px">
        <el-form-item label="文件">
          <el-upload :before-upload="onResFile" :show-file-list="false">
            <el-button type="primary">📤 选择文件</el-button>
          </el-upload>
          <span v-if="resFileMeta.fileName" class="file-name">✅ {{ resFileMeta.fileName }} ({{ formatSize(resFileMeta.fileSize) }})</span>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="resForm.title" placeholder="资料标题" /></el-form-item>
        <el-form-item label="描述"><el-input v-model="resForm.description" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="分类">
          <el-select v-model="resForm.category" style="width:100%">
            <el-option label="课件" value="课件" /><el-option label="习题" value="习题" /><el-option label="拓展阅读" value="拓展阅读" /><el-option label="视频" value="视频" />
          </el-select>
        </el-form-item>
        <el-form-item label="标签"><el-input v-model="resForm.tagsInput" placeholder="用逗号分隔，如：圆锥曲线,专题" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resUploadVisible = false">取消</el-button>
        <el-button type="primary" :loading="resSubmitting" @click="submitResource">提交</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.subj-hero { display:flex; align-items:center; gap:24px; padding:32px; margin-top:16px; position:relative; overflow:hidden; }
.subj-hero::before { content:''; position:absolute; inset:0; background: radial-gradient(circle at 20% 20%, var(--c), transparent 60%); opacity:.18; }
.sh-icon { width:72px; height:72px; border-radius:20px; display:flex; align-items:center; justify-content:center; font-size:38px; flex-shrink:0; position:relative; z-index:1; }
.sh-info { flex:1; position:relative; z-index:1; }
.sh-name { font-size:30px; font-weight:800; }
.sh-sub { font-size:14px; color:var(--zg-text-dim); font-weight:400; }
.sh-desc { color:var(--zg-text-dim); margin:6px 0 12px; }
.sh-stats { display:flex; gap:18px; font-size:13px; color:var(--zg-text-dim); flex-wrap:wrap; }
.sh-manage { position:relative; z-index:1; }
.sub-nav { display:flex; gap:6px; padding:8px; margin-top:20px; overflow-x:auto; }
.sub-tab { padding:8px 18px; border-radius:10px; cursor:pointer; color:var(--zg-text-dim); font-weight:500; white-space:nowrap; transition:all .2s; }
.sub-tab:hover { color:var(--zg-text); background:rgba(245,158,11,.06); }
.sub-tab.on { color:var(--zg-text); background:var(--zg-primary); }
.tab-panel { margin-top:24px; }
.panel-head { display:flex; justify-content:space-between; align-items:center; }
.announce-box { padding:28px; }
.ab-tag { font-size:13px; color:var(--zg-accent); font-weight:600; margin-bottom:12px; }
.ab-text { font-size:16px; line-height:1.9; }
.ab-actions { margin-top:14px; display:flex; gap:8px; }
.res-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
.res-card { padding:18px; }
.rc-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.rc-icon { font-size:30px; }
.rc-title { font-weight:700; font-size:16px; }
.rc-desc { font-size:13px; color:var(--zg-text-dim); margin:6px 0 10px; line-height:1.6; min-height:40px; }
.rc-tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.rc-tag { font-size:11px; color:var(--zg-accent); background:rgba(245,158,11,.12); padding:2px 8px; border-radius:6px; }
.rc-foot { display:flex; justify-content:space-between; align-items:center; font-size:12px; color:var(--zg-text-dim); padding-top:10px; border-top:1px solid rgba(245,158,11,.06); }
.rc-acts { display:flex; gap:12px; }
.rc-acts span { cursor:pointer; }
.rc-acts span:hover { color:var(--zg-accent); }
.article-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:16px; }
.art-card { overflow:hidden; cursor:pointer; }
.ac-cover { height:140px; background-size:cover; background-position:center; position:relative; }
.ac-cat { position:absolute; top:8px; left:8px; padding:2px 8px; border-radius:6px; font-size:11px; background:rgba(0,0,0,.4); backdrop-filter:blur(4px); }
.ac-body { padding:14px; }
.ac-title { font-weight:700; font-size:15px; }
.ac-author { font-size:12px; color:var(--zg-text-dim); margin:4px 0 8px; }
.ac-meta { display:flex; gap:12px; font-size:12px; color:var(--zg-text-dim); }
.query-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px; }
.query-card { padding:18px; cursor:pointer; }
.qc-title { font-size:17px; font-weight:700; }
.qc-note { font-size:13px; color:var(--zg-text-dim); margin:8px 0; line-height:1.6; min-height:40px; }
.qc-foot { display:flex; justify-content:space-between; font-size:12px; color:var(--zg-text-dim); margin-bottom:12px; flex-wrap:wrap; gap:4px; }
.rank-list { padding:12px; }
.rank-item { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:10px; }
.rank-item.top { background:rgba(245,158,11,.06); }
.rank-no { width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; background:rgba(245,158,11,.1); }
.rank-no.n1 { background:linear-gradient(135deg,#fbbf24,#f59e0b); color:var(--zg-text); }
.rank-no.n2 { background:linear-gradient(135deg,#e5e7eb,#9ca3af); color:var(--zg-text); }
.rank-no.n3 { background:linear-gradient(135deg,#f97316,#c2410c); color:var(--zg-text); }
.rank-avatar { width:34px; height:34px; border-radius:50%; object-fit:cover; }
.rank-name { font-weight:600; font-size:14px; }
.rank-role { font-size:11px; color:var(--zg-text-dim); }
.rank-exp { margin-left:auto; font-weight:800; color:var(--zg-accent); }
.mt-title { font-weight:600; margin-bottom:10px; }
.mt-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; font-size:14px; }
.file-name { font-size:13px; color:#34d399; margin-left:10px; }
@media (max-width:768px){
  .subj-hero{padding:20px; gap:14px;}
  .sh-icon{width:52px; height:52px; font-size:28px;}
  .sh-name{font-size:22px;}
  .res-grid,.article-grid,.query-grid{grid-template-columns:1fr; gap:12px;}
  .announce-box{padding:18px;}
  .ab-text{font-size:14px;}
}

@media (min-width: 1200px) {
  .subj-hero { padding: 40px; }
  .sh-name { font-size: 36px; }
  .sub-nav { padding: 10px; gap: 10px; }
  .sub-tab { padding: 10px 22px; border-radius: 20px; }
  .tab-panel { margin-top: 28px; }
  .announce-box { padding: 32px; }
  .ab-text { font-size: 17px; }
  .res-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .res-card { padding: 22px; }
  .article-grid { grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .art-card .ac-body { padding: 18px; }
  .art-card .ac-title { font-size: 17px; }
  .query-grid { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; }
  .query-card { padding: 22px; }
  .rank-list { padding: 16px; }
  .rank-item { padding: 14px 18px; gap: 16px; }
  .rank-avatar { width: 40px; height: 40px; }
}
</style>
