// 追光网站 - Cloudflare Worker 反向代理 v2
// 多级缓存 + 降级策略 + 健康检查

// KV 存储（如果绑定了，用作持久缓存）
// const STORAGE = new KV_NAMESPACE(); // 需要在 wrangler.toml 中绑定

let cachedUrl = null;
let lastFetch = 0;
let failedUrl = null;
let failCount = 0;
const CACHE_TTL = 15000; // 15秒缓存（更短，更快切换）
const FAIL_THRESHOLD = 3; // 连续失败次数阈值

const GITHUB_RAW = 'https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt';

async function getTargetUrl() {
  const now = Date.now();
  // 如果连续失败超过阈值，尝试更频繁地刷新
  const effectiveTTL = failCount >= FAIL_THRESHOLD ? 5000 : CACHE_TTL;
  
  if (cachedUrl && now - lastFetch < effectiveTTL) {
    return cachedUrl;
  }
  try {
    const resp = await fetch(GITHUB_RAW + '?t=' + now, { cache: 'no-store' });
    if (resp.ok) {
      const url = (await resp.text()).trim();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        // URL 变了，重置失败计数
        if (url !== failedUrl) failCount = 0;
        cachedUrl = url;
        lastFetch = now;
        return url;
      }
    }
  } catch (e) {
    // 继续用缓存
  }
  return cachedUrl;
}

async function tryFetch(targetUrl, request) {
  const url = new URL(request.url);
  const target = new URL(targetUrl);
  target.pathname = url.pathname;
  target.search = url.search;

  const headers = new Headers(request.headers);
  headers.set('Host', target.host);
  headers.set('X-Pinggy-No-Screen', '1');
  headers.set('User-Agent', 'Cloudflare-Worker/2.0');

  const init = {
    method: request.method,
    headers: headers,
    redirect: 'manual',
    cf: {
      timeout: 25, // 25秒超时
    },
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  const resp = await fetch(target.toString(), init);
  
  // 检查是否是 pinggy 安全页面（不是真正的内容）
  const text = await resp.text();
  if (text.includes('pinggy') && text.includes('security') && text.length < 5000) {
    // 可能是 pinggy 安全页面，返回原始 URL 让用户处理
    const respHeaders = new Headers(resp.headers);
    respHeaders.delete('transfer-encoding');
    return new Response(text, {
      status: 403,
      headers: {
        ...respHeaders,
        'X-Warning': 'pinggy-security-page',
      },
    });
  }

  const respHeaders = new Headers(resp.headers);
  respHeaders.delete('transfer-encoding');

  return new Response(text, {
    status: resp.status,
    statusText: resp.statusText,
    headers: respHeaders,
  });
}

export default {
  async fetch(request) {
    const targetUrl = await getTargetUrl();
    if (!targetUrl) {
      return new Response('隧道URL尚未配置，请等待隧道建立。', { 
        status: 503, 
        headers: { 'Content-Type': 'text/plain; charset=utf-8' } 
      });
    }

    try {
      const resp = await tryFetch(targetUrl, request);
      // 成功请求，重置失败计数
      failCount = 0;
      failedUrl = null;
      return resp;
    } catch (e) {
      // 连接失败
      failCount++;
      failedUrl = targetUrl;
      
      // 如果缓存了旧 URL，尝试用旧 URL 重新获取（可能是隧道刚重启）
      // 但这里简单处理，直接返回错误
      const errorMsg = failCount >= FAIL_THRESHOLD 
        ? '服务正在重启中，请稍后重试...' 
        : '暂时无法连接，请刷新页面重试。';
      
      return new Response(errorMsg, {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  }
};
