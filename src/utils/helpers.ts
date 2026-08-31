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

// 封面图：使用 Bing 每日壁纸高清美图池。
// 选择理由：picsum.photos / unsplash 等境外图床在国内常被墙，会导致封面全空白；
// Bing 壁纸（www.bing.com）在国内可稳定访问、图片清晰美观、免费、且零 B2 调用。
// 尺寸统一用 _1366x768（实测可达，约 170KB，比例适合做封面）。
export const BING_COVERS: string[] = [
  'https://www.bing.com/th?id=OHR.SamarkandCeiling_ZH-CN1818913296_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.YellowShark_ZH-CN1570569826_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.SantaCatarina_ZH-CN4170292043_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.MichelSunset_ZH-CN0822968543_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.LakeMagadi_ZH-CN0601527009_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.AurorasIceland_ZH-CN9781322454_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.RedwoodPark_ZH-CN9513051062_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.BKBridge_ZH-CN3870511222_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.EndofHeatY26_ZH-CN8936468848_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.CommonBlue_ZH-CN8521430009_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.JulierPass_ZH-CN3064797820_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.LynnCanalOrca_ZH-CN0719217908_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.WhyteCliffP_ZH-CN0573407830_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.Palmanova_ZH-CN0378401592_1366x768.jpg',
  'https://www.bing.com/th?id=OHR.CabilaoClowns_ZH-CN0147033898_1366x768.jpg',
]

// 按 seed 确定性地选一张美图（同一篇文章每次都拿到同一张，避免刷新变图）
export function bingCover(seed?: string): string {
  let h = 0
  const s = String(seed || 'zhuiguang')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return BING_COVERS[h % BING_COVERS.length]
}

// 兼容旧调用：封面默认 / 破图兜底 统一走 Bing 美图池
export function zgCover(seed?: string): string {
  return bingCover(seed)
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
