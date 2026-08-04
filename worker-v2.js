// 追光网站 - Cloudflare Worker 反向代理
// 从 GitHub 读取当前 pinggy 隧道 URL，转发请求并绕过 pinggy 安全页面

let cachedUrl = null;
let lastFetch = 0;
const CACHE_TTL = 30000;

const GITHUB_RAW = 'https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt';

async function getTargetUrl() {
  const now = Date.now();
  if (cachedUrl && now - lastFetch < CACHE_TTL) return cachedUrl;
  try {
    const resp = await fetch(GITHUB_RAW + '?t=' + Math.floor(now / 30000), { cache: 'no-store' });
    if (resp.ok) {
      const url = (await resp.text()).trim();
      if (url.startsWith('https://')) { cachedUrl = url; lastFetch = now; return url; }
    }
  } catch (e) {}
  return cachedUrl;
}

// 需要缓存的静态资源路径
const STATIC_RE = /\.(js|css|woff2?|ttf|eot|svg|png|jpe?g|gif|webp|ico|mp4|mp3|zip|pdf)(\?|$)/i;

export default {
  async fetch(request) {
    const targetUrl = await getTargetUrl();
    if (!targetUrl) {
      return new Response('隧道尚未就绪，请稍后重试。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const url = new URL(request.url);
    const target = new URL(targetUrl);
    target.pathname = url.pathname;
    target.search = url.search;

    // 构建转发 headers - 关键：添加 X-Pinggy-No-Screen 绕过安全页
    const headers = new Headers();
    headers.set('Host', target.host);
    headers.set('X-Pinggy-No-Screen', '1');
    headers.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0');
    headers.set('Accept', request.headers.get('Accept') || '*/*');
    headers.set('Accept-Language', request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9');
    headers.set('Referer', request.headers.get('Referer') || targetUrl);
    // 保留 Cookie
    const cookie = request.headers.get('Cookie');
    if (cookie) headers.set('Cookie', cookie);

    const init = {
      method: request.method,
      headers,
    };

    // 只有非 GET/HEAD 才带 body
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      init.set('Content-Type', request.headers.get('Content-Type') || '');
    }

    try {
      const resp = await fetch(target.toString(), init);
      const respHeaders = new Headers(resp.headers);

      // 移除可能导致问题的 headers
      respHeaders.delete('transfer-encoding');
      respHeaders.delete('connection');

      // 静态资源缓存 1 小时
      if (STATIC_RE.test(url.pathname)) {
        respHeaders.set('Cache-Control', 'public, max-age=3600');
      } else {
        // HTML/API 不缓存
        respHeaders.set('Cache-Control', 'no-cache, must-revalidate');
      }

      // 确保 Content-Type 正确
      const contentType = respHeaders.get('Content-Type') || '';
      if (!contentType && STATIC_RE.test(url.pathname)) {
        const ext = (url.pathname.match(STATIC_RE) || [])[1] || '';
        const mimeMap = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.html': 'text/html',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.mp4': 'video/mp4',
          '.mp3': 'audio/mpeg',
          '.zip': 'application/zip',
          '.pdf': 'application/pdf',
        };
        respHeaders.set('Content-Type', mimeMap[ext] || 'application/octet-stream');
      }

      // 读取完整 body 确保数据完整
      const body = await resp.arrayBuffer();

      return new Response(body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response('隧道重连中，请稍后重试。', {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};
