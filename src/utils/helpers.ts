export function formatSize(bytes: number | undefined | null): string {
  if (!bytes || isNaN(bytes)) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

export function fileIcon(type: string): string {
  const map: Record<string, string> = { pdf: '📄', ppt: '📽️', word: '📝', video: '🎬', zip: '🗜️', image: '🖼️' }
  return map[type] || '📎'
}

export function levelFromExp(exp: number): number {
  return Math.floor(exp / 60) + 1
}

export function expProgress(exp: number): number {
  return Math.round(((exp % 60) / 60) * 100)
}

export function expToNextLevel(exp: number): number {
  return (levelFromExp(exp)) * 60
}

// 经验值获得粒子特效
export function burstParticles(x: number, y: number, color = '#a5b4fc') {
  const colors = ['#a5b4fc', '#67e8f9', '#fda4af', '#fcd34d']
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('div')
    p.className = 'zg-particle'
    p.style.left = x + 'px'
    p.style.top = y + 'px'
    p.style.background = colors[i % colors.length]
    p.style.boxShadow = `0 0 8px ${color}`
    document.body.appendChild(p)
    const ang = (Math.PI * 2 * i) / 14
    const dist = 60 + Math.random() * 50
    const dx = Math.cos(ang) * dist
    const dy = Math.sin(ang) * dist - 30
    p.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px,${dy}px) scale(0)`, opacity: 0 }
      ],
      { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.2,1)' }
    ).onfinish = () => p.remove()
  }
}
