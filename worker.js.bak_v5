// 追光网站 - Cloudflare Worker 反向代理 v5（双路取URL兜底版）
// 免费方案：① GitHub Raw CDN读（快但有1-10分钟缓存） ② GitHub Contents API（绕过CDN，100%实时，免费额度5000次/小时足够）
// 修复 v4 "几十分钟一直显示重连中"Bug：Raw CDN缓存了旧隧道URL，Worker v4虽然5秒重拉但一直拉到CDN旧值 → 永远1016
// v5新增：连续失败≥2次 → 自动切换到Contents API直接取（不经过raw CDN）+ 空串友好页

let cachedUrl = null;       // 当前使用的隧道URL
let lastGoodUrl = null;     // 最后一个已知可用的URL（降级缓存）
let lastGoodTime = 0;       // 最后一个已知可用URL的时间戳
let lastFetch = 0;          // 最后一次从GitHub读取的时间
let failCount = 0;          // 连续失败计数（本次会话全局）
let forceApiNext = false;   // 下次强制走API（而非Raw）

const CACHE_TTL = 5000;              // 正常模式：5秒缓存
const FAIL_THRESHOLD = 2;            // 2次失败进入"快速刷新+API兜底"模式
const FAIL_TTL = 2000;               // 失败模式：2秒刷新
const DEGRADE_TTL = 30 * 60 * 1000;  // 降级缓存有效期：30分钟（最后一条好URL）

const GITHUB_RAW = 'https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt';
// GitHub Contents API（绕过Raw CDN，直取最新内容；免费公开仓库读不需要token）
// 注意：匿名访问API限额≈60次/小时，够用；如需更高可以配置下方TOKEN（不用也行）
const GITHUB_API = 'https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt';
// 如果有token请填（没有就留空串），能提升到5000次/小时。这里默认匿名免费用：
const GITHUB_TOKEN = '';  // 可选：'ghp_xxxxxxx'

// 友好错误页面（不再让用户看到Cloudflare的1016裸页）
const FRIENDLY_ERROR_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服务正在重连中 - 追光学科平台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:12px;padding:40px;max-width:460px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
.icon{font-size:48px;margin-bottom:16px}
h2{color:#333;margin:0 0 8px;font-size:20px}
p{color:#666;font-size:14px;line-height:1.6;margin:8px 0}
.spinner{width:32px;height:32px;border:3px solid #e0e0e0;border-top-color:#409eff;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
.btn{display:inline-block;margin-top:16px;padding:8px 24px;background:#409eff;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;border:none;cursor:pointer}
.tip{margin-top:12px;font-size:12px;color:#999}
details{margin-top:16px;text-align:left;color:#999;font-size:12px}
</style>
</head>
<body>
<div class="card">
<div class="spinner"></div>
<h2>服务正在重连中</h2>
<p>隧道正在自动切换，通常 10~30 秒内恢复。</p>
<p>请稍候片刻，然后点击下方按钮刷新。</p>
<button class="btn" onclick="location.reload()">立即刷新</button>
<p class="tip">如果超过2分钟仍未恢复，请联系管理员。</p>
<details>
<summary>🔧 调试信息（供管理员看）</summary>
<ul>
<li>连续失败次数：<span id="fc">--</span></li>
<li>上次取URL来源：<span id="src">--</span></li>
<li>当前缓存URL：<span id="cu">--</span></li>
<li>最后可用URL时间：<span id="lt">--</span></li>
</ul>
<script>
try{
  document.getElementById('fc').textContent = (sessionStorage.getItem('zg_fc')||'0');
  document.getElementById('src').textContent = (sessionStorage.getItem('zg_src')||'--');
  document.getElementById('cu').textContent = (sessionStorage.getItem('zg_cu')||'--').replace(/^https?:\/\//,'').substring(0,24)+'…';
  const lt = parseInt(sessionStorage.getItem('zg_lt')||'0');
  document.getElementById('lt').textContent = lt ? new Date(lt).toLocaleString('zh-CN') : '--';
  const n = parseInt(sessionStorage.getItem('zg_fc')||'0');
  sessionStorage.setItem('zg_fc', n+1);
}catch(e){}
</script>
</details>
</div>
<script>setTimeout(function(){location.reload()},10000)</script>
</body>
</html>`;

// ============ Base64 decode（GitHub API返回内容是base64编码）============
function b64DecodeUnicode(str) {
  try {
    // 先处理URL安全base64
    const cleaned = (str || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes).trim();
  } catch (e) {
    return '';
  }
}

// ============ 双路取URL：优先Raw，失败/缓存过期/强制→走API ============
async function getTargetUrl(forceRefresh, preferApi) {
  const now = Date.now();
  let effectiveTTL = CACHE_TTL;
  if (failCount >= FAIL_THRESHOLD) effectiveTTL = FAIL_TTL;
  if (forceRefresh) effectiveTTL = 0;

  if (cachedUrl && (now - lastFetch) < effectiveTTL && !forceRefresh) {
    return cachedUrl;
  }

  // 决定取URL的来源
  const useApiFirst = preferApi || forceApiNext || (failCount >= FAIL_THRESHOLD);
  let fetchedUrl = null;
  let fetchSrc = useApiFirst ? 'GITHUB_API(FORCE)' : 'GITHUB_RAW';
  forceApiNext = false;

  const tryRaw = async () => {
    try {
      // 加随机时间戳 + cf.cacheTtl=0，尽最大努力绕过CDN（但CDN服务端强缓存依然可能命中）
      const resp = await fetch(GITHUB_RAW + '?t=' + now, { cf: { cacheTtl: 0, cacheEverything: false } });
      if (resp.ok) {
        const u = (await resp.text()).trim();
        if (u && (u.startsWith('https://') || u.startsWith('http://'))) return u;
      }
    } catch (e) {}
    return null;
  };

  const tryApi = async () => {
    try {
      const hdrs = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'zhuiguang-worker-v5' };
      if (GITHUB_TOKEN) hdrs['Authorization'] = 'token ' + GITHUB_TOKEN;
      const resp = await fetch(GITHUB_API, { headers: hdrs, cf: { cacheTtl: 0, cacheEverything: false } });
      if (resp.ok) {
        const d = await resp.json();
        const u = b64DecodeUnicode(d.content);
        if (u && (u.startsWith('https://') || u.startsWith('http://'))) return u;
      }
    } catch (e) {}
    return null;
  };

  if (useApiFirst) {
    // 优先API（实时）
    fetchedUrl = await tryApi();
    if (!fetchedUrl) fetchedUrl = await tryRaw();
  } else {
    // 优先Raw（快），失败补API
    fetchedUrl = await tryRaw();
    if (!fetchedUrl) fetchedUrl = await tryApi();
  }

  // 处理结果
  if (!fetchedUrl) {
    // 两种方式都失败：用最后一个好URL降级
    if (lastGoodUrl && (now - lastGoodTime) < DEGRADE_TTL) return lastGoodUrl;
    return cachedUrl || lastGoodUrl || null;
  }

  // 拿到有效URL
  if (fetchedUrl !== cachedUrl) failCount = 0;
  cachedUrl = fetchedUrl;
  lastFetch = now;
  lastGoodUrl = fetchedUrl;
  lastGoodTime = now;
  return fetchedUrl;
}

function friendlyError(status, extra) {
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (extra) {
    for (const k in extra) headers.set('X-Zg-' + k, String(extra[k]));
  }
  return new Response(FRIENDLY_ERROR_HTML, { status: status || 503, headers });
}

export default {
  async fetch(request) {
    // 取URL（正常情况不强制刷新）
    const targetUrl = await getTargetUrl(false, false);
    if (!targetUrl) return friendlyError(503, { fail: failCount, src: 'NO_URL' });

    const url = new URL(request.url);
    const buildReq = function(targetUrlStr, req) {
      const u = new URL(targetUrlStr);
      u.pathname = url.pathname;
      u.search = url.search;
      const hdrs = new Headers(req.headers);
      hdrs.set('Host', u.host);
      hdrs.set('X-Pinggy-No-Screen', '1');
      hdrs.set('User-Agent', 'Cloudflare-Worker/5.0');
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
      const shouldScan = (st === 502 || st === 520 || st === 521 || st === 522 || st === 530 || st === 403 || st === 503 || st === 1016);
      const bodyForCheck = shouldScan ? await resp.text() : null;

      const looksLike1016 = bodyForCheck !== null && bodyForCheck.length < 15000 &&
        (bodyForCheck.includes('Error 1016') || bodyForCheck.includes('1016') ||
         bodyForCheck.includes('Origin DNS error') || bodyForCheck.includes('DNS resolution') ||
         bodyForCheck.includes('重连中') ||
         (st >= 520 && st <= 530));

      if (looksLike1016) {
        failCount++;
        // v5关键修复：1016时不仅forceRefresh，还强制走Contents API（绕过Raw CDN缓存）
        forceApiNext = true;
        const newUrl = await getTargetUrl(true, true);
        if (newUrl && newUrl !== targetUrl) {
          try {
            const resp2 = await buildReq(newUrl, request);
            failCount = 0;
            const rh = new Headers(resp2.headers); rh.delete('transfer-encoding');
            const body2 = await resp2.text();
            rh.set('X-Zg-Src', 'API-RETRY');
            rh.set('X-Zg-NewUrl', newUrl.substring(8, 24) + '…');
            return new Response(body2, { status: resp2.status, statusText: resp2.statusText, headers: rh });
          } catch (_) {}
        }
        // 新URL也不行 → 连续失败≥阈值用降级缓存（最后一条好URL）再试一次
        if (failCount >= FAIL_THRESHOLD && lastGoodUrl && lastGoodUrl !== targetUrl) {
          try {
            const resp3 = await buildReq(lastGoodUrl, request);
            const st3 = resp3.status;
            if (st3 < 500) {
              const rh = new Headers(resp3.headers); rh.delete('transfer-encoding');
              rh.set('X-Zg-Src', 'DEGRADE-LASTGOOD');
              const body3 = await resp3.text();
              failCount = 0;
              cachedUrl = lastGoodUrl;
              return new Response(body3, { status: resp3.status, statusText: resp3.statusText, headers: rh });
            }
          } catch (_) {}
        }
        return friendlyError(503, { fail: failCount, status: st });
      }

      // 正常响应
      const outHeaders = new Headers(resp.headers);
      outHeaders.delete('transfer-encoding');
      const outBody = bodyForCheck !== null ? bodyForCheck : await resp.text();
      failCount = 0;
      return new Response(outBody, { status: resp.status, statusText: resp.statusText, headers: outHeaders });

    } catch (e) {
      failCount++;
      if (failCount >= FAIL_THRESHOLD) {
        return friendlyError(502, { fail: failCount, err: (e && e.message) ? e.message.substring(0,20) : 'fetch_err' });
      }
      return friendlyError(502, { fail: failCount });
    }
  }
};
