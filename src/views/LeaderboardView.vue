<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useUserStore } from '@/store/user'
import { useDataStore } from '@/store/data'
import { api } from '@/api'
import { levelFromExp } from '@/utils/helpers'

const user = useUserStore()
const data = useDataStore()

const scope = ref<'all' | 'class' | 'subject'>('all')
const period = ref<'week' | 'month' | 'total'>('total')
const classId = ref<number>(1)
const subjectId = ref<number>(1)
const ranked = ref<any[]>([])
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const params: any = { scope: scope.value, period: period.value }
    if (scope.value === 'class') params.classId = classId.value
    if (scope.value === 'subject') params.subjectId = subjectId.value
    ranked.value = (await api.leaderboard(params)) as any
  } finally { loading.value = false }
}
onMounted(async () => {
  if (!data.subjects.length) await data.fetchSubjects()
  if (!data.classes.length) await data.fetchClasses()
  await load()
})
watch([scope, period, classId, subjectId], load)

function medal(i: number) { return i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '' }
</script>

<template>
  <div class="page zg-container">
    <div class="lb-head glass-strong">
      <h1 class="lb-title">🏆 经验排行榜</h1>
      <p class="lb-desc">追光的人，终会身披万丈光芒。榜单缓存定时更新，鼓励持续贡献。</p>
    </div>

    <!-- 筛选 -->
    <div class="filters glass">
      <div class="f-group">
        <span class="f-label">范围</span>
        <el-radio-group v-model="scope" size="small">
          <el-radio-button value="all">全校总榜</el-radio-button>
          <el-radio-button value="class">班级榜</el-radio-button>
          <el-radio-button value="subject">学科贡献榜</el-radio-button>
        </el-radio-group>
        <el-select v-if="scope==='class'" v-model="classId" size="small" style="width:160px">
          <el-option v-for="c in data.classes" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-select v-if="scope==='subject'" v-model="subjectId" size="small" style="width:140px">
          <el-option v-for="s in data.subjects" :key="s.id" :label="s.name" :value="s.id" />
        </el-select>
      </div>
      <div class="f-group">
        <span class="f-label">周期</span>
        <el-radio-group v-model="period" size="small">
          <el-radio-button value="week">周榜</el-radio-button>
          <el-radio-button value="month">月榜</el-radio-button>
          <el-radio-button value="total">总榜</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 前三名 -->
    <div class="podium" v-if="ranked.length >= 3">
      <div v-for="(u, i) in ranked.slice(0,3)" :key="u.id" class="podium-item" :class="`p${i+1}`">
        <div class="pm-medal">{{ medal(i) }}</div>
        <img :src="u.avatar" class="pm-avatar" />
        <div class="pm-name">{{ u.real_name }}</div>
        <div class="pm-exp">{{ u.pe }} EXP</div>
        <div class="pm-bar" :style="{ height: i===0?'120px':i===1?'90px':'70px' }"></div>
      </div>
    </div>

    <!-- 完整榜单 -->
    <div class="rank-table glass">
      <div class="rt-head">
        <span class="col-no">排名</span><span class="col-user">用户</span><span class="col-role">角色</span><span class="col-level">等级</span><span class="col-exp">经验值</span>
      </div>
      <div v-for="(u, i) in ranked" :key="u.id" class="rt-row" :class="{ me: u.id === user.current?.id, top: i < 3 }">
        <span class="col-no">{{ i < 3 ? medal(i) : i + 1 }}</span>
        <span class="col-user"><img :src="u.avatar" class="rt-avatar" />{{ u.real_name }}</span>
        <span class="col-role">{{ u.role === 'SUPER_ADMIN' ? '超管' : u.role === 'TEACHER' ? '教师' : '学生' }}</span>
        <span class="col-level">Lv.{{ levelFromExp(u.exp) }}</span>
        <span class="col-exp">{{ u.pe }}</span>
      </div>
      <el-empty v-if="!ranked.length" description="暂无数据" />
    </div>
  </div>
</template>

<style scoped>
.lb-head { padding:32px; margin-top:20px; }
.lb-title { font-size:28px; font-weight:800; }
.lb-desc { color:var(--zg-text-dim); margin-top:8px; }
.filters { display:flex; justify-content:space-between; flex-wrap:wrap; gap:16px; padding:16px; margin-top:20px; }
.f-group { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.f-label { font-size:13px; color:var(--zg-text-dim); }
.podium { display:flex; justify-content:center; align-items:flex-end; gap:24px; margin:40px 0; }
.podium-item { display:flex; flex-direction:column; align-items:center; position:relative; }
.pm-medal { font-size:32px; }
.pm-avatar { width:64px; height:64px; border-radius:50%; border:3px solid rgba(245,158,11,.3); margin:6px 0; object-fit:cover; }
.p1 .pm-avatar { border-color:#fbbf24; box-shadow:0 0 20px rgba(251,191,36,.5); }
.p2 .pm-avatar { border-color:#cbd5e1; }
.p3 .pm-avatar { border-color:#f97316; }
.pm-name { font-weight:700; }
.pm-exp { font-size:13px; color:var(--zg-accent); font-weight:600; }
.pm-bar { width:80px; margin-top:12px; border-radius:12px 12px 0 0; background:linear-gradient(180deg, var(--zg-primary), transparent); }
.p1 .pm-bar { background:linear-gradient(180deg, #fbbf24, transparent); }
.p2 .pm-bar { background:linear-gradient(180deg, #cbd5e1, transparent); }
.p3 .pm-bar { background:linear-gradient(180deg, #f97316, transparent); }
.rank-table { padding:8px; margin-top:20px; }
.rt-head, .rt-row { display:grid; grid-template-columns: 80px 1fr 100px 100px 120px; align-items:center; padding:12px 16px; }
.rt-head { color:var(--zg-text-dim); font-size:13px; border-bottom:1px solid rgba(245,158,11,.1); }
.rt-row { border-radius:10px; transition:background .2s; }
.rt-row:hover { background:rgba(245,158,11,.06); }
.rt-row.me { background:rgba(245,158,11,.15); border:1px solid rgba(245,158,11,.3); }
.rt-avatar { width:30px; height:30px; border-radius:50%; margin-right:10px; vertical-align:middle; object-fit:cover; }
.col-user { display:flex; align-items:center; }
.col-exp { font-weight:700; color:var(--zg-accent); }
@media (max-width:720px){ .rt-head{display:none;} .rt-row{grid-template-columns:50px 1fr 80px; } .col-role,.col-level{display:none;} .podium{gap:14px; margin:24px 0;} .pm-avatar{width:52px;height:52px;} }

@media (min-width: 1200px) {
  .lb-head { padding: 48px; margin-top: 28px; }
  .lb-title { font-size: 38px; }
  .lb-desc { font-size: 15px; }
  .podium { gap: 40px; margin: 48px 0; }
  .p1 .pm-avatar { width: 84px; height: 84px; }
  .p2 .pm-avatar, .p3 .pm-avatar { width: 70px; height: 70px; }
  .rank-table { padding: 16px; }
  .rt-head, .rt-row { padding: 16px 24px; grid-template-columns: 100px 1.5fr 120px 120px 140px; }
  .rt-avatar { width: 36px; height: 36px; }
}
</style>
