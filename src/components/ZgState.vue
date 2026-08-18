<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const props = withDefaults(defineProps<{
  type?: 'empty' | 'search' | 'error' | 'offline' | '404'
  title?: string
  desc?: string
  actionText?: string
  actionTo?: string
}>(), {
  type: 'empty',
  title: '',
  desc: '',
  actionText: '',
  actionTo: '',
})

const emit = defineEmits<{ (e: 'action'): void }>()
const router = useRouter()

const titles: Record<string, string> = {
  empty: '这里还空空如也',
  search: '没有找到相关内容',
  error: '出了点小差错',
  offline: '网络似乎断了',
  '404': '追光人迷路了',
}
const descs: Record<string, string> = {
  empty: '暂时还没有内容，去别处看看或创建第一条吧～',
  search: '换个关键词试试，也许会有新发现。',
  error: '页面加载失败，请稍后重试。',
  offline: '检查一下网络连接，再回来继续追光。',
  '404': '你访问的页面不存在或已移动。',
}

const t = computed(() => props.title || titles[props.type] || titles.empty)
const d = computed(() => props.desc || descs[props.type] || descs.empty)

function onAction() {
  if (props.actionTo) router.push(props.actionTo)
  emit('action')
}
</script>

<template>
  <div class="zg-state" :class="'zg-state--' + type" role="status" :aria-label="t">
    <!-- 空状态：捧书的小人 + 星光 -->
    <svg v-if="type === 'empty'" class="zg-illu" viewBox="0 0 200 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="zgG1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--zg-accent)"/><stop offset="1" stop-color="var(--zg-primary)"/>
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="140" rx="62" ry="10" fill="rgba(186,117,23,.10)"/>
      <path d="M52 96c10-7 26-7 38 0 12 7 28 7 38 0" stroke="url(#zgG1)" stroke-width="3" stroke-linecap="round"/>
      <path d="M52 96c-4 14 2 30 12 36 14 8 30 8 44 0 12-7 18-24 14-40" stroke="url(#zgG1)" stroke-width="3" stroke-linecap="round" opacity=".85"/>
      <path d="M90 96c4 7 14 7 18 0" stroke="url(#zgG1)" stroke-width="3" stroke-linecap="round"/>
      <circle cx="138" cy="54" r="13" stroke="url(#zgG1)" stroke-width="3"/>
      <line x1="148" y1="64" x2="158" y2="74" stroke="url(#zgG1)" stroke-width="3" stroke-linecap="round"/>
      <path d="M134 50l1.6 4.4L140 56l-4.4 1.6L134 62l-1.6-4.4L128 56l4.4-1.6z" fill="var(--zg-accent)"/>
      <path d="M70 44l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1z" fill="var(--zg-primary)" opacity=".7"/>
      <circle cx="100" cy="40" r="2" fill="var(--zg-primary)" opacity=".5"/>
    </svg>

    <!-- 搜索无结果 -->
    <svg v-else-if="type === 'search'" class="zg-illu" viewBox="0 0 200 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="zgG2" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--zg-accent)"/><stop offset="1" stop-color="var(--zg-primary)"/>
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="140" rx="58" ry="9" fill="rgba(186,117,23,.10)"/>
      <circle cx="86" cy="74" r="30" stroke="url(#zgG2)" stroke-width="4"/>
      <line x1="108" y1="96" x2="132" y2="120" stroke="url(#zgG2)" stroke-width="4" stroke-linecap="round"/>
      <path d="M74 74h24M86 62v24" stroke="url(#zgG2)" stroke-width="3" stroke-linecap="round" opacity=".55"/>
      <path d="M150 50l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1z" fill="var(--zg-primary)" opacity=".7"/>
    </svg>

    <!-- 错误 / 离线 -->
    <svg v-else-if="type === 'error' || type === 'offline'" class="zg-illu" viewBox="0 0 200 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="zgG3" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--zg-accent)"/><stop offset="1" stop-color="var(--zg-primary)"/>
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="142" rx="56" ry="9" fill="rgba(186,117,23,.10)"/>
      <path d="M70 56h60l-6 48H76z" stroke="url(#zgG3)" stroke-width="4" stroke-linejoin="round"/>
      <path d="M64 56l8-10h56l8 10" stroke="url(#zgG3)" stroke-width="4" stroke-linejoin="round"/>
      <line x1="100" y1="74" x2="100" y2="92" stroke="url(#zgG3)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="100" cy="102" r="2.6" fill="var(--zg-primary)"/>
      <path d="M150 48l1.1 3 3 1.1-3 1.1-1.1 3-1.1-3-3-1.1 3-1.1z" fill="var(--zg-primary)" opacity=".7"/>
    </svg>

    <!-- 404 星空迷路 -->
    <svg v-else class="zg-illu" viewBox="0 0 200 160" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="zgG4" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--zg-accent)"/><stop offset="1" stop-color="var(--zg-primary)"/>
        </linearGradient>
      </defs>
      <path d="M0 120 Q50 96 100 118 T200 116 V160 H0 Z" fill="rgba(186,117,23,.10)"/>
      <circle cx="34" cy="40" r="1.6" fill="var(--zg-accent)"/><circle cx="60" cy="26" r="1.2" fill="var(--zg-primary)" opacity=".7"/>
      <circle cx="120" cy="34" r="1.8" fill="var(--zg-accent)"/><circle cx="160" cy="50" r="1.3" fill="var(--zg-primary)" opacity=".7"/>
      <circle cx="92" cy="20" r="1.1" fill="var(--zg-primary)" opacity=".6"/>
      <path d="M82 96c8-6 22-6 30 0l-4 22c-8 4-18 4-26 0z" stroke="url(#zgG4)" stroke-width="3.5" stroke-linejoin="round"/>
      <circle cx="100" cy="78" r="8" stroke="url(#zgG4)" stroke-width="3.5"/>
      <path d="M100 86v8" stroke="url(#zgG4)" stroke-width="3.5" stroke-linecap="round"/>
      <text x="150" y="92" font-size="26" font-weight="800" fill="url(#zgG4)" font-family="Noto Serif SC, serif">404</text>
    </svg>

    <h3 class="zg-state-title">{{ t }}</h3>
    <p class="zg-state-desc">{{ d }}</p>
    <button v-if="actionText" class="zg-state-btn" type="button" @click="onAction">{{ actionText }}</button>
  </div>
</template>

<style scoped>
.zg-state { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 36px 20px; gap: 6px; }
.zg-illu { width: 180px; height: 144px; margin-bottom: 6px; animation: zgStateFloat 5s ease-in-out infinite; }
@keyframes zgStateFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
.zg-state-title { margin: 0; font-family: 'Noto Serif SC','Songti SC','SimSun',serif; font-weight: 800; font-size: 19px; color: var(--zg-text); }
.zg-state-desc { margin: 0; max-width: 320px; font-size: 14px; line-height: 1.7; color: var(--zg-text-dim); }
.zg-state-btn {
  margin-top: 12px; padding: 9px 22px; border: none; cursor: pointer;
  border-radius: 999px; font-size: 14px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, var(--zg-primary), var(--zg-primary-2));
  box-shadow: var(--zg-shadow-sm); transition: transform .18s cubic-bezier(.22,1,.36,1), box-shadow .25s;
}
.zg-state-btn:hover { box-shadow: var(--zg-shadow-md); }
.zg-state-btn:active { transform: scale(.96); }
.zg-state--404 .zg-illu, .zg-state--error .zg-illu { animation: none; }
</style>
