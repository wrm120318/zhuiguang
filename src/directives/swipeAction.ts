/**
 * v-swipe-action — 移动端卡片滑动操作指令
 * 要求被指令元素内部包含：
 *   .zg-swipe-front   前台内容（默认可见，可点击）
 *   .zg-swipe-actions 后台操作区（含 .zg-swipe-btn 按钮）
 * 行为：
 *   - 触摸横向拖动 front 露出后台操作；超过阈值松手即吸附展开，否则回弹
 *   - 展开状态下点击 front 仅收起（不触发 front 内导航）
 *   - 桌面端（hover 设备）由 CSS 悬停露出，鼠标直接点击操作
 * 仅做交互增强，不改动任何既有按钮逻辑（铁律4 兼容）
 */
const THRESHOLD = 44

interface SwipeCtx {
  setT: (x: number) => void
}

export const vSwipeAction = {
  mounted(el: HTMLElement) {
    requestAnimationFrame(() => setup(el))
  },
  unmounted(el: HTMLElement) {
    delete (el as any)._zgSwipe
  },
}

function setup(el: HTMLElement) {
  const front = el.querySelector('.zg-swipe-front') as HTMLElement | null
  const actions = el.querySelector('.zg-swipe-actions') as HTMLElement | null
  if (!front || !actions) return

  let maxX = actions.offsetWidth || 64
  let startX = 0
  let startY = 0
  let base = 0
  let cur = 0
  let dragging = false
  let decided = false
  let horiz = false

  function setT(x: number) {
    cur = Math.max(-maxX, Math.min(0, x))
    front!.style.transform = `translateX(${cur}px)`
  }

  function onStart(x: number, y: number) {
    maxX = actions!.offsetWidth || 64
    startX = x
    startY = y
    base = cur
    dragging = true
    decided = false
    horiz = false
    front!.style.transition = 'none'
  }

  function onMove(x: number, y: number, ev: TouchEvent) {
    if (!dragging) return
    const dx = x - startX
    const dy = y - startY
    if (!decided) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
      decided = true
      horiz = Math.abs(dx) > Math.abs(dy)
      if (horiz && ev.cancelable) ev.preventDefault()
    }
    if (!horiz) return
    setT(base + dx)
  }

  function onEnd(x: number) {
    if (!dragging) return
    dragging = false
    front!.style.transition = ''
    const dx = x - startX
    if (horiz) setT(dx < -THRESHOLD ? -maxX : 0)
  }

  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0]
    onStart(t.clientX, t.clientY)
  }, { passive: true })

  el.addEventListener('touchmove', (e) => {
    const t = e.touches[0]
    onMove(t.clientX, t.clientY, e)
  }, { passive: false })

  el.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0]
    onEnd(t.clientX)
  })

  // 捕获阶段拦截：展开状态下点击前台只收起，不触发内部导航
  front.addEventListener('click', (e) => {
    if (cur < -2) {
      e.stopPropagation()
      setT(0)
    }
  }, true)

  ;(el as any)._zgSwipe = { setT } as SwipeCtx
}
