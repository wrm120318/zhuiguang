// v-swipe-close：移动端抽屉右滑（横向滑动超过阈值）关闭 —— B8 手势
// 用法：<el-drawer v-swipe-close> 或任意元素上，滑动时平移，松手超阈值触发关闭
import type { Directive } from 'vue'

interface SwipeCtx {
  startX: number
  startY: number
  dx: number
  dragging: boolean
  target: HTMLElement | null
  closing: boolean
}

function findDrawer(el: HTMLElement): HTMLElement | null {
  return el.closest('.el-drawer') as HTMLElement | null
}

function closeDrawer(drawer: HTMLElement) {
  // Element Plus 抽屉关闭：触发其遮罩层点击（最稳，不依赖内部 API）
  const overlay = drawer.closest('.el-overlay') as HTMLElement | null
  if (overlay) {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    overlay.dispatchEvent(ev)
    return
  }
  // 兜底：派发自定义事件供父组件监听
  drawer.dispatchEvent(new CustomEvent('zg-swipe-close', { bubbles: true }))
}

export const swipeClose: Directive<HTMLElement, boolean | undefined> = {
  mounted(el) {
    const ctx: SwipeCtx = { startX: 0, startY: 0, dx: 0, dragging: false, target: null, closing: false }
    el.__swipeCtx = ctx
    const enabled = () => {
      const v = (el as any).__swipeVal
      return v === undefined ? true : v !== false
    }
    ;(el as any).__swipeVal = el.__swipeVal

    el.addEventListener('touchstart', (e: TouchEvent) => {
      if (!enabled()) return
      const t = e.touches[0]
      ctx.startX = t.clientX; ctx.startY = t.clientY; ctx.dx = 0; ctx.dragging = true; ctx.closing = false
      ctx.target = findDrawer(el)
    }, { passive: true })

    el.addEventListener('touchmove', (e: TouchEvent) => {
      if (!ctx.dragging || !ctx.target) return
      const t = e.touches[0]
      const dx = t.clientX - ctx.startX
      const dy = t.clientY - ctx.startY
      // 仅当以横向滑动为主时才平移抽屉
      if (Math.abs(dx) > Math.abs(dy)) {
        ctx.dx = dx
        const rtl = ctx.target.classList.contains('rtl')
        const offset = rtl ? Math.min(0, dx) : Math.max(0, dx)
        ctx.target.style.transition = 'none'
        ctx.target.style.transform = `translateX(${offset}px)`
      }
    }, { passive: true })

    el.addEventListener('touchend', () => {
      if (!ctx.dragging || !ctx.target) return
      ctx.dragging = false
      const rtl = ctx.target.classList.contains('rtl')
      const passed = rtl ? ctx.dx < -60 : ctx.dx > 60
      ctx.target.style.transition = ''
      ctx.target.style.transform = ''
      if (passed) closeDrawer(ctx.target)
    })
  },
  updated(el, binding) {
    ;(el as any).__swipeVal = binding.value
  },
  unmounted(el) {
    delete (el as any).__swipeCtx
  },
}

declare global {
  interface HTMLElement { __swipeCtx?: any; __swipeVal?: boolean }
}
