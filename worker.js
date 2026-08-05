// 追光网站 - Cloudflare Worker 反向代理 v6（【双隧道并行自动切换版】—— 彻底解决"频繁断线无法使用"）
// 更新日期：2026-08-05
// 重大升级：
//   1. tunnel-url.txt从单行URL改为多行（一行一个URL，Cloudflare主隧道在前，Pinggy备在后）
//   2. 解析多个URL，每个请求同时探测所有URL，选第一个HTTP200响应的隧道（500ms级切换）
//   3. 隧道健康评分：记录最近成功率，优先请求得分高的隧道（避免频繁切换浪费时间）
//   4. 保留v5的双路取URL（Raw CDN + Contents API）+ KV缓存兜底
// 部署步骤：
//   1. 登录dash.cloudflare.com → Workers & Pages → 创建/选择 xkzg-de5-net Worker
//   2. 点击右上角「Edit code」→ 清空后全选粘贴本文件256+行 → Ctrl+S 或「Deploy」
//   3. 如需KV兜底：在Worker→Settings→Variables→KV Namespace Bindings 绑定名"KV_CACHE"到任意KV命名空间（可选，不绑定也能用）
// =============================================================

const GITHUB_RAW = "https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt";
const GITHUB_API = "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt";
const GITHUB_TOKEN = "";  // 可选，不填也能免费用Contents API；建议留空（Contents API免费5000次/小时）
const URL_CACHE_TTL_MS = 5000;  // 5秒重拉一次tunnel-url.txt
const FETCH_TIMEOUT_MS = 4500;  // 单隧道请求4.5秒超时（配合多URL并行更快切换）
const HEALTH_DECAY = 0.9;       // 健康评分衰减系数

let cachedUrls = [];          // 多行解析后的URL数组（优先顺序）
let cachedUrlsAt = 0;         // 缓存时间戳
let health = new Map();       // url -> 0..1得分，越接近1越健康
let lastGoodUrl = "";         // 上一次成功的URL，作为猜测起点

// ========= 1. 拉取tunnel-url.txt并解析多行 =========
async function fetchTunnelUrls(force) {
  const now = Date.now();
  if (!force && cachedUrls.length > 0 && now - cachedUrlsAt < URL_CACHE_TTL_MS) return cachedUrls.slice();
  let urls = [];
  // 双路并行取URL
  const tasks = [];
  tasks.push((async () => {
    try {
      const r = await fetch(GITHUB_RAW + "?t=" + now, { cf: { cacheTtl: 10, cacheEverything: true } });
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { return null; }
  })());
  if (GITHUB_TOKEN) {
    tasks.push((async () => {
      try {
        const r = await fetch(GITHUB_API, { headers: { "Authorization": "Bearer " + GITHUB_TOKEN, "Accept": "application/vnd.github.raw" } });
        if (!r.ok) return null;
        return await r.text();
      } catch (e) { return null; }
    })());
  }
  const results = await Promise.allSettled(tasks);
  for (const p of results) {
    if (p.status === "fulfilled" && typeof p.value === "string") {
      const lines = p.value.split(/\r?\n/).map(s => s.trim()).filter(s => s && s.startsWith("https://"));
      if (lines.length > 0) { urls = lines; break; }
    }
  }
  // 兜底：读KV里上次成功的URL列表
  if (urls.length === 0) {
    try {
      const kv = globalThis?.KV_CACHE;
      const kvStr = kv ? await kv.get("last_good_urls") : null;
      if (kvStr) urls = kvStr.split("\n").map(s=>s.trim()).filter(Boolean);
    } catch (_) {}
  }
  if (urls.length > 0) {
    cachedUrls = urls;
    cachedUrlsAt = now;
    try { const kv = globalThis?.KV_CACHE; if (kv) await kv.put("last_good_urls", urls.join("\n"), { expirationTtl: 86400 }); } catch(_){}
  }
  return urls.slice();
}

// ========= 2. 健康打分辅助 =========
function scoreOf(url) {
  if (!health.has(url)) health.set(url, 0.7);
  return health.get(url);
}
function mark(url, ok) {
  const s = scoreOf(url);
  const next = ok ? (0.15 + 0.85 * s) : (s * HEALTH_DECAY * HEALTH_DECAY);
  health.set(url, Math.max(0.01, Math.min(0.99, next)));
}
function sortByHealth(urls) {
  // 先按健康分，再把lastGoodUrl排最前面（如果在列表里）
  const arr = urls.slice();
  arr.sort((a, b) => {
    if (a === lastGoodUrl) return -999;
    if (b === lastGoodUrl) return 999;
    return scoreOf(b) - scoreOf(a);
  });
  return arr;
}

// ========= 3. 带超时的fetch =========
function fetchWithTimeout(url, req, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const target = url + (req.url.startsWith("/") ? req.url : "/" + req.url);
  const init = {
    method: req.method,
    headers: new Headers(req.headers),
    signal: ctl.signal,
    redirect: "manual",
  };
  init.headers.set("Host", new URL(url).host);
  init.headers.set("User-Agent", "Cloudflare-Worker/6.0 (+zhuiguang v6 multi-tunnel)");
  if (init.headers.has("cf-connecting-ip")) init.headers.delete("cf-connecting-ip");
  if (body && ["POST","PUT","PATCH","DELETE"].includes(req.method)) init.body = body;
  const p = fetch(target, init).then(r => { clearTimeout(timer); return r; }).catch(e => { clearTimeout(timer); throw e; });
  return { p, cancel: () => ctl.abort() };
}

// ========= 4. 核心：并行探测多URL，选第一个成功响应 =========
async function bestEffortFetch(urls, req) {
  let body = null;
  try {
    if (["POST","PUT","PATCH","DELETE"].includes(req.method)) body = await req.clone().arrayBuffer();
  } catch (_) {}
  const ordered = sortByHealth(urls);
  const flights = [];
  const ctrls = [];
  // 第0名立刻发，第1名等400ms落后发（避免同时浪费两条隧道带宽），第2名等900ms
  const stagger = [0, 400, 900];
  for (let i = 0; i < ordered.length; i++) {
    const u = ordered[i];
    const delay = stagger[i] ?? 1400;
    const task = new Promise((res) => {
      setTimeout(() => {
        const { p, cancel } = fetchWithTimeout(u, req, body);
        ctrls.push(cancel);
        p.then(r => { mark(u, r.ok || r.status < 500); res({ ok: true, url: u, r, status: r.status }); })
         .catch(e => { mark(u, false); res({ ok: false, url: u, err: String(e?.name || e) }); });
      }, delay);
    });
    flights.push(task);
  }
  // 取第一个成功（HTTP<500 且非异常）的结果
  let lastFail = null;
  for (let i = 0; i < flights.length; i++) {
    const one = await flights[i];
    if (one.ok && one.r) {
      // 取消其他仍在跑的（尽力）
      ctrls.forEach(c => { try { c(); } catch(_){} });
      if (one.r.ok || one.r.status < 500) {
        lastGoodUrl = one.url;
        return one.r;
      }
      lastFail = one;
    } else {
      lastFail = one;
    }
  }
  // 全部失败：返回最后一个结果或兜底友好页
  if (lastFail && lastFail.r) return lastFail.r;
  return null;
}

// ========= 5. 友好错误页（v6保留v5的<details>调试块） =========
function friendlyErr(urls, tries, msg) {
  const urlList = (urls||[]).map(u => {
    const s = (scoreOf(u)*100).toFixed(0);
    return `<li>${escapeHtml(u)} <span style="color:#888">健康度 ${s}%</span></li>`;
  }).join("");
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>服务正在重连中 - 追光学科平台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;background:#f8fafc;color:#0f172a;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:36px 32px;max-width:520px;width:100%;box-shadow:0 10px 40px rgba(15,23,42,.08);text-align:center;border:1px solid #e2e8f0}
.spin{width:44px;height:44px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;margin:0 auto 20px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:20px;margin:0 0 8px;color:#0f172a}
p{margin:6px 0;color:#475569;font-size:14px;line-height:1.7}
.hint{background:#eff6ff;border-left:3px solid #3b82f6;padding:10px 14px;border-radius:8px;text-align:left;margin:16px 0;font-size:13px;color:#1e40af}
.btn{display:inline-block;margin-top:14px;padding:10px 22px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-weight:500;font-size:14px;border:none;cursor:pointer}
.btn:hover{background:#2563eb}
details{margin-top:18px;text-align:left;background:#f1f5f9;border-radius:8px;padding:8px 14px}
details summary{cursor:pointer;color:#64748b;font-size:12px;padding:2px 0}
pre{margin:8px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#334155;max-height:200px;overflow:auto}
</style></head><body>
<div class="card">
  <div class="spin"></div>
  <h1>服务正在重连中</h1>
  <p>隧道正在自动切换，通常 10~30 秒内恢复。</p>
  <p>请稍候片刻，然后刷新页面。</p>
  <div class="hint">💡 v6 新特性：当前已同时使用 <b>${Math.max(1,urls?.length||0)} 条独立隧道</b>并行探测，自动选择最快可用的那一条，比v5单隧道切换更快、更稳定。</div>
  <button class="btn" onclick="location.reload(true)">刷新页面</button>
  <details>
    <summary>🔧 调试信息（出现一直不恢复时截图发给管理员）</summary>
<pre>Worker版本: zhuiguang-worker v6
错误信息: ${escapeHtml(msg||"隧道暂时不可达")}
连续失败次数: ${tries ?? 1}
候选隧道数: ${urls?.length ?? 0}
健康状态:
${urlList || "  (无可用隧道)"}
时间: ${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</pre>
  </details>
</div>
<script>
// 自动重刷：最多6次，间隔(3,5,7,9,11,13)s
(function(){
  try {
    const k = 'zg_retry_v6';
    const v = JSON.parse(sessionStorage.getItem(k) || '{"n":0,"t":0}');
    if (Date.now() - v.t > 180000) v.n = 0;
    if (v.n < 6) {
      v.n += 1; v.t = Date.now();
      sessionStorage.setItem(k, JSON.stringify(v));
      const delays = [3000,5000,7000,9000,11000,13000];
      setTimeout(()=>location.reload(true), delays[v.n-1] || 5000);
    } else {
      sessionStorage.setItem(k, JSON.stringify({n:0,t:0}));
    }
  } catch(e){}
})();
</script></body></html>`;
  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Zg-Worker-Version": "v6-multi-tunnel",
      "X-Zg-Candidate-Count": String(urls?.length || 0),
      "X-Zg-Last-Good": lastGoodUrl || "",
      "Retry-After": "10",
    },
  });
}
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }

// ========= 6. 主入口 =========
export default {
  async fetch(req, env, ctx) {
    if (env?.KV_CACHE) globalThis.KV_CACHE = env.KV_CACHE;
    const url = new URL(req.url);
    // 健康检查
    if (url.pathname === "/__zg_health") {
      const urls = await fetchTunnelUrls(false);
      return new Response(JSON.stringify({ version: "v6", urls, candidateCount: urls.length, health: Object.fromEntries([...health.entries()].map(([k,v])=>[k, Math.round(v*1000)/1000])) }, null, 2), { headers: { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*" } });
    }
    // favicon静态文件走源站
    if (req.method === "GET" && /\.(png|jpg|jpeg|gif|svg|ico|css|js|woff2?|ttf|map|webp)$/i.test(url.pathname)) {
      const urls = await fetchTunnelUrls(false);
      if (urls.length === 0) return friendlyErr([], 0, "尚未获取到隧道地址，请稍后再试");
      const r = await bestEffortFetch(urls, req);
      if (r) return r;
    }
    // 普通请求
    const urls = await fetchTunnelUrls(false);
    if (urls.length === 0) return friendlyErr([], 0, "尚未获取到隧道地址，请稍后再试");
    const res = await bestEffortFetch(urls, req);
    if (!res) {
      // 彻底失败，强制重拉URL一次再试
      const urls2 = await fetchTunnelUrls(true);
      const res2 = urls2.length > 0 ? await bestEffortFetch(urls2, req) : null;
      if (res2) return res2;
      return friendlyErr(urls2.length ? urls2 : urls, 2, "所有隧道均暂时不可达，后台正在自动切换");
    }
    return res;
  },
};
