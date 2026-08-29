/**
 * Service Worker: 拦截 /api/download/* 路径，转发到真实后端并注入 Authorization Header
 *
 * 目的：浏览器原生 <a href> 流式下载（显示真实进度+剩余时间），
 *       同时让 URL 完全不暴露 token，
 *       同时不开任何新标签页。
 *
 * 工作流：
 *   1. 前端 <a href="/api/download/123?name=xxx" download="xxx">
 *      → 浏览器发请求到当前域，不会离开当前页
 *   2. SW 拦截 /api/download/*，向前端 page 拿 token（通过 MessageChannel）
 *   3. SW 用 token 调真实 URL（后端已配 CORS 允许 Authorization）
 *   4. SW 把响应流回浏览器，浏览器按 Content-Disposition: attachment 触发下载
 */
const REAL_API_BASE = 'https://api.xkzg.dpdns.org'
const DOWNLOAD_PATH_PREFIX = '/api/download/'
const TOKEN_TIMEOUT_MS = 3000

self.addEventListener('install', (event) => {
  // 让新 SW 立即接管页面（无缓存旧版本，直接激活）
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // 只处理同源 /api/download/* 路径（不同源文件不过滤）
  if (url.origin === self.location.origin && url.pathname.startsWith(DOWNLOAD_PATH_PREFIX)) {
    event.respondWith(handleDownload(event, url))
  }
})

async function handleDownload(event, url) {
  const resourceId = url.pathname.slice(DOWNLOAD_PATH_PREFIX.length)
  if (!resourceId || !/^\d+$/.test(resourceId)) {
    return new Response('Invalid resource id', { status: 400 })
  }
  // 1) 拿 token
  let token
  try {
    token = await getToken(event, TOKEN_TIMEOUT_MS)
  } catch (e) {
    return new Response('Token unavailable', { status: 401 })
  }
  if (!token) {
    return new Response('Not authenticated', { status: 401 })
  }
  // 2) 用 token 调真实 URL（流式）
  try {
    const realResp = await fetch(`${REAL_API_BASE}/file/r/${resourceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // 3) 把响应包装成 attachment（即便后端已设 attachment，再强化一次确保 browser 下载）
    const headers = new Headers(realResp.headers)
    headers.set('Content-Disposition', headers.get('Content-Disposition') || 'attachment')
    if (!headers.has('Access-Control-Allow-Origin')) {
      headers.set('Access-Control-Allow-Origin', self.location.origin)
    }
    headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type')
    return new Response(realResp.body, {
      status: realResp.status,
      statusText: realResp.statusText,
      headers,
    })
  } catch (e) {
    return new Response('Fetch failed: ' + (e?.message || 'unknown'), { status: 502 })
  }
}

/**
 * 从客户端拿到 zg_token：通过 MessageChannel 异步握手
 */
function getToken(event, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('token timeout'))
    }, timeoutMs)

    // 优先尝试通过 event.source（通常是 client）拿 token
    if (event.source && 'postMessage' in event.source) {
      const channel = new MessageChannel()
      channel.port1.onmessage = (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(e.data?.token || '')
      }
      try {
        event.source.postMessage({ type: 'zg_download:get_token' }, [channel.port2])
      } catch {
        settled = true
        clearTimeout(timer)
        reject(new Error('postMessage failed'))
      }
    } else {
      // 没 source（旧 SW context），遍历所有 clients
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        if (settled) return
        if (!clients.length) {
          settled = true
          clearTimeout(timer)
          reject(new Error('no clients'))
          return
        }
        const channel = new MessageChannel()
        channel.port1.onmessage = (e) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(e.data?.token || '')
        }
        try {
          clients[0].postMessage({ type: 'zg_download:get_token' }, [channel.port2])
        } catch {
          settled = true
          clearTimeout(timer)
          reject(new Error('postMessage failed'))
        }
      })
    }
  })
}
