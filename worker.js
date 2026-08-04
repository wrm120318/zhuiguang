// 追光网站 - Cloudflare Worker 反向代理 v4（方案A优化版）
// 特性：5秒缓存 + 1016自动重试 + 缓存降级30分钟 + 空串友好页 + pinggy安全页检测

let cachedUrl = null;       // 当前使用的隧道URL
let lastGoodUrl = null;     // 最后一个已知可用的URL（降级缓存）
let lastGoodTime = 0;       // 最后一个已知可用URL的时间戳
let lastFetch = 0;          // 最后一次从GitHub读取的时间
let failCount = 0;          // 连续失败计数

const CACHE_TTL = 5000;              // 正常模式：5秒缓存
const FAIL_THRESHOLD = 2;            // 2次失败进入快速刷新
const FAIL_TTL = 2000;               // 失败模式：2秒刷新
const DEGRADE_TTL = 30 * 60 * 1000;  // 降级缓存有效期：30分钟

const GITHUB_RAW = 'https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt';

// 友好错误页面（不再让用户看到Cloudflare的1016裸页）
const FRIENDLY_ERROR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服务正在重连中 - 追光学科平台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:12px;padding:40px;max-width:420px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
.icon{font-size:48px;margin-bottom:16px}
h2{color:#333;margin:0 0 8px;font-size:20px}
p{color:#666;font-size:14px;line-height:1.6;margin:8px 0}
.spinner{width:32px;height:32px;border:3px solid #e0e0e0;border-top-color:#409eff;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.btn{display:inline-block;margin-top:16px;padding:8px 24px;background:#409eff;color:#fff;border-radius:6px;text-decoration:none;font-size:14px}
</style>
</head>
<body>
<div class="card">
<div class="spinner"></div>
<h2>服务正在重连中</h2>
<p>隧道正在自动切换，通常 10~30 秒内恢复。</p>
<p>请稍候片刻，然后刷新页面。</p>
<a href="/" class="btn">刷新页面</a>
</div>
<script>setTimeout(function(){location.reload()},10000)</script>
</body>
</html>`;

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
      // 空串：隧道守护脚本写入的兜底值
      if (!url) {
        // 如果有30分钟内的已知可用URL，降级使用
        if (lastGoodUrl && (now - lastGoodTime) < DEGRADE_TTL) {
          cachedUrl = lastGoodUrl;
          lastFetch = now;
          return cachedUrl;
        }
        return null; // 没有降级缓存，返回null触发友好页面
      }
      if (url.startsWith('https://') || url.startsWith('http://')) {
        if (url !== cachedUrl) failCount = 0;
        cachedUrl = url;
        lastFetch = now;
        lastGoodUrl = url;
        lastGoodTime = now;
        return url;
      }
    }
  } catch (e) {}

  // GitHub读取失败：尝试降级缓存
  if (lastGoodUrl && (now - lastGoodTime) < DEGRADE_TTL) {
    return lastGoodUrl;
  }
  return cachedUrl;
}

function friendlyError(status) {
  return new Response(FRIENDLY_ERROR_HTML, {
    status: status || 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
}

export default {
  async fetch(request) {
    const targetUrl = await getTargetUrl(false);

    // 无可用URL：返回友好页面（不再让Cloudflare抛1016裸页）
    if (!targetUrl) {
      return friendlyError(503);
    }

    const url = new URL(request.url);
    const buildReq = function(targetUrlStr, req) {
      const u = new URL(targetUrlStr);
      u.pathname = url.pathname;
      u.search = url.search;
      const hdrs = new Headers(req.headers);
      hdrs.set('Host', u.host);
      hdrs.set('X-Pinggy-No-Screen', '1');
      hdrs.set('User-Agent', 'Cloudflare-Worker/4.0');
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

      // 检测1016/DNS错误 → 立即强制刷新URL并重试一次
      const looksLike1016 = bodyForCheck !== null && bodyForCheck.length < 12000 &&
        (bodyForCheck.includes('Error 1016') || bodyForCheck.includes('1016') ||
         bodyForCheck.includes('Origin DNS error') ||
         (st >= 520 && st <= 530));

      // 检测pinggy安全页面
      const looksLikePinggySec = bodyForCheck !== null &&
        bodyForCheck.includes('pinggy') && bodyForCheck.length < 5000;

      if (looksLike1016) {
        // 强制从GitHub拉最新URL
        const newUrl = await getTargetUrl(true);
        if (newUrl && newUrl !== targetUrl) {
          try {
            const resp2 = await buildReq(newUrl, request);
            failCount = 0;
            const rh = new Headers(resp2.headers); rh.delete('transfer-encoding');
            const body2 = await resp2.text();
            return new Response(body2, { status: resp2.status, statusText: resp2.statusText, headers: rh });
          } catch (_) {}
        }
        // 新URL也不行 → 返回友好页面
        return friendlyError(503);
      }

      // 正常响应或pinggy安全页面
      const outHeaders = new Headers(resp.headers);
      outHeaders.delete('transfer-encoding');
      const outBody = bodyForCheck !== null ? bodyForCheck : await resp.text();
      if (looksLikePinggySec) outHeaders.set('X-Warning', 'pinggy-security-page');
      failCount = 0;
      return new Response(outBody, { status: resp.status, statusText: resp.statusText, headers: outHeaders });

    } catch (e) {
      failCount++;
      // 连续失败超阈值 → 返回友好页面
      if (failCount >= FAIL_THRESHOLD) {
        return friendlyError(502);
      }
      return friendlyError(502);
    }
  }
};
