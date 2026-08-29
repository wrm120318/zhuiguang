import { onMounted, onBeforeUnmount, type Ref } from 'vue'

/**
 * 错落入场动画（仅墨金模式）。
 * 经典模式（<html> 无 zg-inkgold 类）直接返回，元素保持原样、不被隐藏。
 * 用法：容器 ref 调 useReveal(rootRef)，子项加 class="zg-reveal"。
 */
export function useReveal(root: Ref<HTMLElement | null>, selector = '.zg-reveal') {
  let io: IntersectionObserver | null = null
  onMounted(() => {
    // 经典模式不初始化：元素不隐藏，表现与现状一致
    if (!root.value || !document.documentElement.classList.contains('zg-inkgold')) return
    // 不支持 IntersectionObserver 时直接显示，避免元素永远不可见
    if (typeof IntersectionObserver === 'undefined') {
      root.value.querySelectorAll(selector).forEach((el) => el.classList.add('zg-reveal-in'))
      return
    }
    io = new IntersectionObserver((entries) => {
      entries.forEach((e, i) => {
        if (e.isIntersecting) {
          ;(e.target as HTMLElement).style.transitionDelay = `${Math.min(i, 6) * 60}ms`
          e.target.classList.add('zg-reveal-in')
          io!.unobserve(e.target)
        }
      })
    }, { threshold: 0.12 })
    root.value.querySelectorAll(selector).forEach((el) => io!.observe(el))
  })
  onBeforeUnmount(() => io?.disconnect())
}
