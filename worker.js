// 追光网站 - Cloudflare Worker 反向代理 v3
// 更短缓存 + 失败立即刷新 + 1016/520错误自动强制刷新URL并重试一次

let cachedUrl = null;
let lastFetch = 0;
let failedUrl = null;
let failCount = 0;
const CACHE_TTL = 5000;         // 默认5秒缓存（之前v2是15秒，现在更快切换）
const FAIL_THRESHOLD = 2;      // 2次失败进入快速刷新模式
const FAIL_TTL = 2000;         // 失败模式每2秒刷一次
const REFETCH_AFTER_1016 = true;

const GITHUB_RAW = 'https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt';

async function getTargetUrl(forceRefresh) {
  const now = Date.now();
  let effectiveTTL = CACHE_TTL;
  if (failCount >= FAIL_THRESHOLD) effectiveTTL = FAIL_TTL;
  if (forceRefresh) effectiveTTL = 0;

  if (cachedUrl && (now - lastFetch) < effectiveTTL && !forceRefresh) {
    return cachedUrl;
  }
  try {
    const resp = await fetch(GITHUB_RAW + '?t=' + now, { cf: { cacheTtl: 0 } });
    if (resp.ok) {
      const url = (await resp.text()).trim();
      if (url.startsWith('https://') || url.startsWith('http://')) {
        if (url !== cachedUrl) failCount = 0;
        cachedUrl = url;
        lastFetch = now;
        return url;
      }
    }
  } catch (e) {}
  return cachedUrl;
}

export default {
  async fetch(request) {
    const targetUrl = await getTargetUrl(false);
    if (!targetUrl) {
      return new Response('隧道URL尚未配置，请等待隧道建立。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const url = new URL(request.url);
    const buildReq = function(targetUrlStr, req) {
      const u = new URL(targetUrlStr);
      u.pathname = url.pathname;
      u.search = url.search;
      const hdrs = new Headers(req.headers);
      hdrs.set('Host', u.host);
      hdrs.set('X-Pinggy-No-Screen', '1');
      hdrs.set('User-Agent', 'Cloudflare-Worker/3.0');
      const init = {
        method: req.method,
        headers: hdrs,
        redirect: 'manual',
        cf: { timeout: 20, cacheTtl: 0 },
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
      return fetch(u.toString(), init);
    };

    try {
      let resp = await buildReq(targetUrl, request);

      const st = resp.status;
      const shouldScan = (st === 502 || st === 520 || st === 521 || st === 522 || st === 530 || st === 403 || st === 503);
      const bodyForCheck = shouldScan ? await resp.text() : null;
      const looksLike1016 = bodyForCheck !== null && bodyForCheck.length < 12000 &&
        (bodyForCheck.includes('Error 1016') || bodyForCheck.includes('1016') ||
         bodyForCheck.includes('Origin DNS error') ||
         (st >= 520 && st <= 530));
      const looksLikePinggySec = bodyForCheck !== null &&
        bodyForCheck.includes('pinggy') && bodyForCheck.length < 5000;

      if (REFETCH_AFTER_1016 && looksLike1016) {
        const newUrl = await getTargetUrl(true);
        if (newUrl && newUrl !== targetUrl) {
          try {
            const resp2 = await buildReq(newUrl, request);
            failCount = 0; failedUrl = null;
            const rh = new Headers(resp2.headers); rh.delete('transfer-encoding');
            const body2 = await resp2.text();
            return new Response(body2, { status: resp2.status, statusText: resp2.statusText, headers: rh });
          } catch (_) {}
        }
      }

      const outHeaders = new Headers(resp.headers);
      outHeaders.delete('transfer-encoding');
      const outBody = bodyForCheck !== null ? bodyForCheck : await resp.text();
      if (looksLikePinggySec) outHeaders.set('X-Warning', 'pinggy-security-page');
      failCount = 0; failedUrl = null;
      return new Response(outBody, { status: resp.status, statusText: resp.statusText, headers: outHeaders });

    } catch (e) {
      failCount++;
      failedUrl = targetUrl;
      const errorMsg = failCount >= FAIL_THRESHOLD
        ? '服务正在重启中，请稍后重试...'
        : '暂时无法连接，请刷新页面重试。';
      return new Response(errorMsg, { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  }
};
