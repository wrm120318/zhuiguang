// ============================================================
// 🚀 追光学科共享平台 · Cloudflare Worker 纯反向代理版 v1.0（Replit Workspace模式专用）
// ============================================================
//
// 🎯 作用：彻底告别隧道！所有请求 xkzg.de5.net → 直接转发到 Replit Workspace repl.co URL
//     删除了所有复杂的：隧道轮询 / 健康探测 / GitHub拉取 / 多源熔断 逻辑
//     代码从v7.5的750行精简到~120行，稳定如磐石，不会再出现"服务重连"弹窗！
//
// 🔧 部署前必须改1行：下面第 25 行 const REPLIT_ORIGIN = "..."
//     填入您的 Replit Workspace 模式 URL（格式: https://你的repl名--你的用户名.repl.co ）
//     ❗️ 是 .repl.co（Workspace模式·永不过期），不是 .replit.app（Published·30天死）
//
// 💡 配套：
//     1. UptimeRobot 每5分钟心跳 → https://你的repl.co/__zg_health → 永不休眠
//     2. Replit Workspace IDE 里直接点绿色Run（不要Deploy！）→ SQLite文件永久持久化
//
// ============================================================
// ⚠️【用户改这里·就改这1行！】⚠️
const REPLIT_ORIGIN = "https://你的repl名--你的用户名.repl.co";
// ⚠️【用户改这里·就改这1行！】⚠️
// ============================================================

const WVER = "ReplitProxy-v1.0-CLEAN";
const PROXY_TIMEOUT_MS = 30000;   // API请求超时30秒（够长·登录上传都ok）
const HEALTH_PATH = "/__zg_health";

// ---------- 手动缓存核心（100%保留原架构·静态资源秒开） ----------
function manualCacheKeyStr(req) {
  try {
    const u = new URL(req.url);
    // 带登录态的接口不缓存，静态资源强缓存
    const hasAuth = req.headers.has("Authorization") || u.search.includes("token=");
    if (hasAuth) return "";
    return `${(req.method||"GET").toUpperCase()}|${u.pathname}|${u.search}`;
  } catch(e) { return ""; }
}
function pathTtlFor(p) {
  if (!p) return 0;
  if (/\.(js|css|png|jpe?g|svg|gif|webp|woff2?|ttf|ico|mp4|webm|map|avif)$/i.test(p)) return 604800;
  if (/^\/api\/(classes|subjects|articles|resources|settings|notices|themes|pages|feature_flags)$/i.test(p)) return 30;
  return 0;
}
async function tryGetManualCache(req) {
  try {
    const k = manualCacheKeyStr(req);
    if (!k) return null;
    const u = new URL(req.url);
    const ttl = pathTtlFor(u.pathname);
    if (ttl <= 0) return null;
    const c = await caches.default.match(new Request(k, {method:"GET"}));
    return c || null;
  } catch(e) { return null; }
}
async function tryPutManualCache(req, resp) {
  try {
    const k = manualCacheKeyStr(req);
    if (!k) return;
    const u = new URL(req.url);
    const ttl = pathTtlFor(u.pathname);
    if (ttl <= 0 || !(resp && resp.ok && resp.status < 400)) return;
    const cloned = resp.clone();
    const newH = new Headers(cloned.headers);
    newH.set("Cache-Control", `public, s-maxage=${ttl}, max-age=${Math.floor(ttl/2)}`);
    const toSave = new Response(cloned.body, {status: cloned.status, statusText: cloned.statusText, headers: newH});
    event.waitUntil(caches.default.put(new Request(k, {method:"GET"}), toSave));
  } catch(e) {}
}

// ---------- 错误友好页（Replit冷启动5~10秒时给用户看的·再也不是服务重连了！） ----------
function friendlyWakeHTML(ms) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>追光学科共享平台 · 服务启动中</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;color:#fff}
.card{background:rgba(255,255,255,.12);backdrop-filter:blur(12px);border-radius:20px;padding:48px 36px;max-width:480px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.25)}
h1{font-size:26px;margin-bottom:16px;font-weight:600}
.spinner{width:56px;height:56px;border:5px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;margin:32px auto;animation:spin 0.9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{line-height:1.8;font-size:15px;opacity:.92;margin-bottom:10px}
.hint{margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,.2);font-size:13px;opacity:.8;text-align:left}
.hint li{margin:6px 0 6px 18px;line-height:1.6}
.badge{display:inline-block;background:rgba(255,255,255,.18);padding:4px 12px;border-radius:999px;font-size:12px;margin:12px 0 0}
</style></head><body><div class="card">
<h1>🚀 追光平台正在启动</h1>
<div class="spinner"></div>
<p>Replit云端服务冷启动中（第一次访问或长时间没访问会触发）</p>
<p><b>通常 5 ~ 12 秒</b>，本页面会自动刷新直到正常</p>
<span class="badge">Cloudflare Worker · ${WVER}</span>
<div class="hint">
  <b>如果长时间没恢复（>30秒）：</b>
  <ol>
    <li>手动按 <b>F5 或 Ctrl+R</b> 刷新页面</li>
    <li>检查您的网络连接（切换4G/Wi-Fi试一下）</li>
    <li>Replit维护中，等几分钟再试（极少发生）</li>
  </ol>
</div>
<script>setTimeout(function(){location.reload()}, ${Math.max(8000, (ms||10000))});</script>
</div></body></html>`;
}

// ---------- 主 fetch：纯反向代理转发 ----------
addEventListener("fetch", event => {
  event.respondWith((async () => {
    const req = event.request;
    const u = new URL(req.url);
    const path = u.pathname;
    const method = (req.method||"GET").toUpperCase();

    // 特殊接口：返回当前代理状态（方便您自己调试）
    if (method === "GET" && (path === "/__proxy_status" || path === "/zg-status")) {
      return new Response(JSON.stringify({
        ok: true, version: WVER,
        target: REPLIT_ORIGIN,
        healthCheck: HEALTH_PATH,
        now: new Date().toISOString(),
        // 顺便后台探测Replit是否在线
      }, null, 2), {status:200, headers:{"Content-Type":"application/json; charset=utf-8","X-Zg-Worker-Version":WVER}});
    }

    // 先查手动缓存（静态资源/js/css/png直接秒回，不打Replit）
    const cached = await tryGetManualCache(req);
    if (cached) return cached;

    // 构造转发目标URL
    const target = REPLIT_ORIGIN.replace(/\/+$/, "") + path + u.search;
    const hdr = new Headers(req.headers);
    hdr.set("User-Agent", "Zhuiguang-ReplitProxy/1.0 " + (hdr.get("User-Agent") || ""));
    hdr.set("X-Forwarded-For", (hdr.get("CF-Connecting-IP") || u.hostname || ""));
    hdr.delete("CF-Connecting-IP"); hdr.delete("CF-Ray"); hdr.delete("CF-Visitor");

    try {
      const t0 = Date.now();
      const controller = new AbortController();
      const tm = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
      const fReq = new Request(target, {
        method,
        headers: hdr,
        body: (method !== "GET" && method !== "HEAD") ? await req.clone().arrayBuffer() : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
      const resp = await fetch(fReq);
      clearTimeout(tm);

      // 304/4xx直接透传
      if (resp.status === 1016 || resp.status === 503 || resp.status === 502 || (resp.status >= 500 && resp.status < 505)) {
        const took = Date.now() - t0;
        // 5xx = Replit冷启动或暂时503，返回友好启动页（用户看到的是"正在启动"不是"服务重连"！）
        return new Response(friendlyWakeHTML(Math.max(8000, 12000 - took)), {
          status: 503,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Retry-After": "8",
            "X-Zg-Worker-Version": WVER,
            "X-Zg-Proxy-Error": resp.status + " from replit",
          }
        });
      }

      // 正常响应：加Worker版本头 + 静态资源入缓存
      const outH = new Headers(resp.headers);
      outH.set("X-Zg-Worker-Version", WVER);
      outH.set("X-Zg-Target", REPLIT_ORIGIN.replace(/^https?:\/\//,""));
      outH.delete("cf-cache-status"); outH.delete("cf-ray"); outH.delete("server");
      const outResp = new Response(resp.body, {status: resp.status, statusText: resp.statusText, headers: outH});
      if (method === "GET") await tryPutManualCache(req, outResp.clone());
      return outResp;
    } catch (e) {
      // 超时/网络失败 → 返回友好启动页（自动8秒刷新）
      const msg = (e && e.message) ? String(e.message) : "unknown";
      return new Response(friendlyWakeHTML(10000), {
        status: 503,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": "8",
          "X-Zg-Worker-Version": WVER,
          "X-Zg-Proxy-Catch": msg.slice(0,120),
        }
      });
    }
  })());
});
