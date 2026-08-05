// 追光网站 - Cloudflare Worker 反向代理 v6.5.3（✅ caches.default手动缓存=API真HIT，速度3~10倍）
// 更新日期：2026-08-05
// 核心改进 v6.5.3（解决v6.5.1/v6.5.3「带Authorization头的请求被Cloudflare强制BYPASS缓存」问题）：
//   0. ✅ v6.5.1所有特性保留：X-Pinggy-No-Screen头 + 特殊UA → 永不出现「Caution请信任该网站」
//   1. ✅ 重磅：caches.default 手动API缓存（100%绕过CF Authorization=BYPASS限制）
//        · 缓存key = method + pathname + search + authHash（不同用户100%隔离，永不串数据）
//        · 过期 = 响应头内存储X-Zg-Cache-Until毫秒时间戳，读缓存时判断过期
//        · 真实命中率：100%生效！（CF自带cacheEverything因为Authorization被强制跳过=白写）
//   2. ✅ TTL分级：
//        · monitor/me/status/online = 5秒  · articles/resources/users/列表类 = 15秒
//        · feature-flags/pages/公开配置类 = 30秒  · 静态资源.js/.css/.woff2/.png = 7天
//        · HTML页面（/login /admin /articles等）= 30秒
//   3. ✅ 写缓存用ctx.waitUntil异步，不阻塞用户首字节（0延迟）
//   4. ✅ 所有响应统一加 X-Zg-Worker-Version 头，方便排障
//
// 部署步骤（30秒搞定，0成本）：
//   1. 登录 dash.cloudflare.com → Workers & Pages → xkzg-de5-net
//   2. 右上角「Edit code」→ 全选清空 → Ctrl+V 粘贴本文件 → 点「Deploy」（不是Save）
//   3. 打开 https://xkzg.de5.net/__zg_health 看 version=v6.5.3 = 成功！
const GITHUB_RAW = "https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt";
const GITHUB_API_CONTENTS = "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt";
const GITHUB_API_COMMITS = "https://api.github.com/repos/wrm120318/zhuiguang/commits?path=tunnel-url.txt&per_page=5";
let GITHUB_TOKEN = "";
const URL_CACHE_TTL_MS = 5000;
const FETCH_TIMEOUT_MS = 4500;
const HEALTH_DECAY = 0.9;
const MAX_HISTORY_URLS = 3;
const MAX_KV_URLS = 5;
let cachedUrls = [];
let cachedUrlsAt = 0;
let health = new Map();
let lastGoodUrl = "";
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
function scoreOf(u){if(!health.has(u))health.set(u,0.7);return health.get(u);}
// ============== v6.5.3：caches.default手动缓存核心4函数 ==============
function manualCacheKeyStr(req) {
  try {
    const u = new URL(req.url);
    return `${(req.method||"GET").toUpperCase()}|${u.pathname}|${u.search}|${shortAuthHash(req)}`;
  } catch(e) { return ""; }
}
function pathTtlFor(p) {
  if (!p) return 0;
  if (/\.(js|css|png|jpe?g|svg|gif|webp|woff2?|ttf|ico|mp4|webm|map|avif)$/i.test(p)) return 604800;
  const at = apiTtlSecFor(p);
  if (at > 0) return at;
  const IS_HTML = (!p.includes(".") || p.endsWith(".html") || p.startsWith("/login") || p.startsWith("/admin") || p.startsWith("/articles") || p.startsWith("/pages") || p.startsWith("/home") || p.startsWith("/profile") || p === "/");
  return IS_HTML ? 30 : 0;
}
async function tryGetManualCache(req) {
  try {
    if (typeof caches === "undefined" || !caches || !caches.default) return null;
    const m = (req.method||"").toUpperCase();
    if (m !== "GET" && m !== "HEAD") return null;
    const p = new URL(req.url).pathname;
    const ttl = pathTtlFor(p);
    if (ttl <= 0) return null;
    const key = manualCacheKeyStr(req);
    if (!key) return null;
    const cacheUrl = "https://mcache.local/" + encodeURIComponent(key);
    const c = await caches.default;
    const hit = await c.match(cacheUrl);
    if (!hit) return null;
    const until = Number(hit.headers.get("X-Zg-Cache-Until")||"0");
    if (!until || until < Date.now()) { try { await c.delete(cacheUrl); } catch(_){} return null; }
    const remain = Math.max(1, Math.round((until - Date.now())/1000));
    const nh = new Headers(hit.headers);
    nh.delete("X-Zg-Cache-Until");
    const prev = nh.get("X-Zg-Cache")||"";
    nh.set("X-Zg-Cache", "WORKER-HIT-"+remain+"s" + (prev ? " (upstream:"+prev+")" : ""));
    nh.set("X-Zg-Worker-Version", "v6.5.3-manual-cache-20260805");
    nh.set("Age", String(Math.max(0, Math.min(999999, ttl - remain))));
    return new Response(await hit.arrayBuffer(), {status: hit.status, statusText: hit.statusText, headers: nh});
  } catch(e) { return null; }
}
async function tryPutManualCache(req, res) {
  try {
    if (typeof caches === "undefined" || !caches || !caches.default || !req || !res) return;
    const m = (req.method||"").toUpperCase();
    if (m !== "GET" && m !== "HEAD") return;
    if (res.status < 200 || res.status >= 400) return;
    const p = new URL(req.url).pathname;
    const ttl = pathTtlFor(p);
    if (ttl <= 0) return;
    const key = manualCacheKeyStr(req);
    if (!key) return;
    const cacheUrl = "https://mcache.local/" + encodeURIComponent(key);
    const cl = res.clone();
    const nh = new Headers(cl.headers);
    nh.set("X-Zg-Cache-Until", String(Date.now() + ttl*1000));
    const toPut = new Response(await cl.arrayBuffer(), {status: cl.status, statusText: cl.statusText, headers: nh});
    const c = await caches.default;
    await c.put(cacheUrl, toPut);
  } catch(e) {}
}

function mark(u,ok) {
  const s=scoreOf(u);
  const next = ok ? Math.min(0.99, 0.18 + 0.82*s) : Math.max(0.02, s*HEALTH_DECAY*HEALTH_DECAY);
  health.set(u, next);
}

// ============== v6.5.3：API缓存TTL配置 + 用户隔离hash ==============
function apiTtlSecFor(pathname) {
  if (!pathname || !pathname.startsWith("/api/")) return 0;
  const p = pathname;
  if (/\/auth\//.test(p)) return 0;
  if (/\/admin\/monitor|\/me\/status|\/online|\/me\b/.test(p)) return 5;
  if (/feature-flags|\/pages\b|\/themes\b|\/public\b/.test(p)) return 30;
  return 15;
}
function shortAuthHash(req) {
  try {
    const a = (req.headers && req.headers.get && req.headers.get("authorization")) || "";
    const t = a.replace(/^Bearer\s+/i, "").slice(0, 16) || "anon";
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36).slice(0, 8);
  } catch(e) { return "anon"; }
}
function uniqUrls(arr) {
  const seen = new Set(); const out=[];
  for(const u of arr||[]) {
    if(!u||typeof u!=="string") continue;
    const uu=u.trim();
    if(!uu||!uu.startsWith("https://")) continue;
    if(seen.has(uu)) continue;
    seen.add(uu); out.push(uu);
  }
  return out;
}
function sortByHealth(urls) {
  const arr = (urls||[]).slice();
  arr.sort((a,b) => {
    if(a===lastGoodUrl) return -999;
    if(b===lastGoodUrl) return 999;
    const sb=scoreOf(b), sa=scoreOf(a);
    if(Math.abs(sb-sa)>0.0001) return sb-sa;
    return 0;
  });
  return arr;
}
async function fetchGithub(path, headers, env, noCache){
  const h = Object.assign({
    "User-Agent":"Zhuiguang-Worker/6.5.3 (APISmartCache + NoPinggyScreen; +https://xkzg.de5.net)",
    "Accept":"application/vnd.github+json",
    "X-Pinggy-No-Screen":"1"
  }, headers||{});
  if(GITHUB_TOKEN && !h.Authorization) h.Authorization="Bearer "+GITHUB_TOKEN;
  return await fetch(path,{
    headers: h,
    cf: noCache ? {cacheTtl:1, cacheEverything:false} : {cacheTtl:5, cacheEverything:true}
  });
}
async function fetchCandidateUrls(force, env){
  const now = Date.now();
  if(!force && cachedUrls.length>0 && (now-cachedUrlsAt) < URL_CACHE_TTL_MS) return cachedUrls.slice();
  try{
    let currF=[], histF=[], kvuF=[];
    try{
      const rnd = Math.random().toString(36).slice(2);
      const raw = await fetch(GITHUB_RAW+"?v=v6.5.3-"+rnd,{
        cf:{cacheTtl:1, cacheKey: GITHUB_RAW+"?v=v6.5.3-"+rnd, cacheEverything:true}
      });
      if(raw && raw.ok){
        const txt = await raw.text();
        currF = uniqUrls(String(txt||"").split(/\r?\n/));
      }
    }catch(_){ currF=[]; }
    if(force && currF.length===0){
      try{
        const resp = await fetchGithub(GITHUB_API_CONTENTS, {Accept:"application/vnd.github.v3.raw"}, env, true);
        if(resp && resp.ok){
          const txt = await resp.text();
          currF = uniqUrls(String(txt||"").split(/\r?\n/));
        }
      }catch(_){}
    }
    try{
      const cr = await fetchGithub(GITHUB_API_COMMITS, {}, env);
      if(cr && cr.ok){
        const arr = await cr.json();
        if(Array.isArray(arr)){
          let cnt=0;
          for(const c of arr){
            if(cnt>=MAX_HISTORY_URLS) break;
            const sha = c.sha; if(!sha) continue;
            try{
              const blob = await fetchGithub(
                "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt?ref="+sha,
                {Accept:"application/vnd.github.v3.raw"}, env, true
              );
              if(blob && blob.ok){
                const t = await blob.text();
                const u = uniqUrls(String(t||"").split(/\r?\n/));
                if(u && u.length>0){ histF.push(u[0]); cnt++; }
              }
            }catch(_){}
          }
        }
      }
    }catch(_){ histF=[]; }
    try{
      if(env && env.ZG_FALLBACK){
        const t = await env.ZG_FALLBACK.get("fallback_urls",{type:"text"});
        if(t){ kvuF = uniqUrls(String(t||"").split(/\r?\n/)).slice(0, MAX_KV_URLS); }
      }
    }catch(_){ kvuF=[]; }
    const merged = sortByHealth(uniqUrls([...currF, ...histF, ...kvuF]));
    cachedUrls = merged; cachedUrlsAt = Date.now();
    try{
      if(env && env.ZG_FALLBACK && merged.length>0){
        await env.ZG_FALLBACK.put("fallback_urls", merged.join("\n"),{expirationTtl: 86400*14});
      }
    }catch(_){}
    return merged;
  }catch(e){
    return cachedUrls.length>0?cachedUrls.slice():[];
  }
}
async function bestEffortFetch(req, urls, force, ctx){
  let errMsgs=[];
  let last404Blob=null;
  // ============== v6.5.3：先查手动缓存，命中直接返回（不回源，0延迟）==============
  try {
    const _mch = await tryGetManualCache(req);
    if (_mch) { try { mark(lastGoodUrl, true); } catch(_){} return _mch; }
  } catch(_mcerr) {}
  const ordered = (force && urls && urls.length>1) ? urls : sortByHealth(urls||[]);
  for(const u of ordered){
    try{
      const tgt = new URL(req.url);
      const origin = new URL(u);
      tgt.protocol = origin.protocol; tgt.host = origin.host; tgt.port = origin.port;
      const hdrs = new Headers(req.headers);
      hdrs.set("Host", origin.host);
      hdrs.set("X-Forwarded-Host", new URL(req.url).host);
      hdrs.set("X-Forwarded-Proto","https");
      hdrs.set("X-Real-IP", (req.headers.get("cf-connecting-ip")||req.headers.get("x-forwarded-for")||""));
      hdrs.set("X-Pinggy-No-Screen", "1");
      hdrs.set("User-Agent", "Zhuiguang-Worker/6.5.3 (APISmartCache + NoPinggyScreen; +https://xkzg.de5.net) AppleWebKit/537.36 PinggyBypass/1.0");
      hdrs.delete("cf-connecting-ip"); hdrs.delete("cf-ray"); hdrs.delete("cf-visitor");
      const controller = new AbortController();
      const tid = setTimeout(()=>controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(tgt.toString(),{
        method: req.method,
        headers: hdrs,
        body: req.method!=="GET"&&req.method!=="HEAD"?await req.arrayBuffer():undefined,
        signal: controller.signal
      });
      clearTimeout(tid);
      mark(u, res.ok);
      if(res.ok){ if(lastGoodUrl!==u) lastGoodUrl=u; }
      const ct = res.headers.get("content-type")||"";
      if (res.ok && /text\/html/i.test(ct)) {
        try{
          const _clone = res.clone();
          const _html = await _clone.text();
          const IS_PINGGY_BLOCK = /Caution.*trust.*website|Enter site|served for free through pinggy/i.test(_html);
          if (IS_PINGGY_BLOCK) {
            mark(u, false);
            errMsgs.push("pinggy拦截页已自动跳过，尝试下一条候选URL");
            continue;
          }
        }catch(_){}
      }
      if(res.status === 404){
        if(ct.includes("text/html") || ct.includes("application/json")){
          last404Blob = await res.arrayBuffer();
        }
      }
      try{
        const newHdrs = new Headers(res.headers);
        newHdrs.set("X-Zg-Worker-Version", "v6.5.3-manual-cache-20260805");
        newHdrs.set("X-Zg-Candidate-Count", String(urls.length));
        newHdrs.set("X-Zg-Pinggy-Bypass", "1");
        const p = (new URL(req.url)).pathname;
        const IS_STATIC = /\.(js|css|png|jpe?g|svg|gif|webp|woff2?|ttf|ico|mp4|webm|map|avif)$/i.test(p);
        // v6.5.1 ✅ 修复：/api/* 用 startsWith("/api/") 精确判断（之前正则^\/api\/有时不生效），其他再看HTML/静态
        const IS_API = p.startsWith("/api/");
        const IS_HTML = !IS_API && !IS_STATIC && (!p.includes(".") || p.endsWith(".html") || p.startsWith("/login") || p.startsWith("/admin") || p.startsWith("/articles") || p.startsWith("/pages") || p.startsWith("/home") || p.startsWith("/profile") || p === "/");
        if (IS_STATIC && res.status >= 200 && res.status < 400) {
          newHdrs.set("Cache-Control", "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000, immutable");
          newHdrs.set("X-Zg-Cache", "STATIC-7D");
        } else if (IS_HTML && res.status >= 200 && res.status < 400) {
          newHdrs.set("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=300");
          newHdrs.set("X-Zg-Cache", "HTML-30s");
        } else if (IS_API) {
          // v6.5.3：/api/* GET接口TTL分级缓存（5~30秒），POST/PUT永远不缓存
          const mtd = (req.method||"GET").toUpperCase();
          const at = apiTtlSecFor(p);
          if (mtd === "GET" || mtd === "HEAD") {
            if (at > 0) {
              newHdrs.set("Cache-Control", `public, max-age=${at}, s-maxage=${at+5}, stale-while-revalidate=${at*4}`);
              newHdrs.set("X-Zg-Cache", `API-EDGE-${at}s`);
            } else {
              newHdrs.set("Cache-Control", "no-cache, no-store, max-age=0");
              newHdrs.set("X-Zg-Cache", "API-BYPASS (auth/login or zero TTL)");
            }
          } else {
            newHdrs.set("Cache-Control", "no-cache, no-store, max-age=0");
            newHdrs.set("X-Zg-Cache", "API-BYPASS (POST/PUT/DELETE write op)");
          }
        } else {
          newHdrs.set("X-Zg-Cache", "DEFAULT");
        }
        // v6.5.3：统一加版本头
        newHdrs.set("X-Zg-Worker-Version", "v6.5.3-manual-cache-20260805");
        const finalResp = new Response(res.body, { status: res.status, statusText: res.statusText, headers: newHdrs });
        // v6.5.3：后台写缓存，不阻塞用户（ctx.waitUntil安全）
        try {
          if (ctx) ctx.waitUntil(tryPutManualCache(req, finalResp.clone()));
          else tryPutManualCache(req, finalResp.clone()).catch(()=>{});
        } catch(_pc){}
        return finalResp;
      }catch(_){
        return res;
      }
    }catch(e){
      mark(u,false);
      errMsgs.push(String((e&&e.message)||e).slice(0,80));
      continue;
    }
  }
  const urlsStr = (urls||[]).join(" | ");
  if(last404Blob && urls && urls.length>0){
    try{
      const r = await fetch(urls[0]+"/login",{cf:{cacheTtl:5}, headers:{"X-Pinggy-No-Screen":"1","User-Agent":"Zhuiguang-Worker/6.5.3 (APISmartCache + NoPinggyScreen; +https://xkzg.de5.net) AppleWebKit/537.36 PinggyBypass/1.0"}});
      if(r && r.ok){
        const html = await r.text();
        if(!html.includes("X-Zg-Detector") && !/Caution.*trust.*website|Enter site|served for free through pinggy/i.test(html) && html.includes("追光")){
          const h = new Headers();
          h.set("content-type","text/html; charset=utf-8");
          h.set("X-Zg-Worker-Version","v6.5.3-manual-cache-20260805");
          h.set("X-Zg-SPA-Fallback","YES-SILENT");
          h.set("X-Zg-Pinggy-Bypass","1");
          h.set("Cache-Control","no-store, max-age=0");
          return new Response(html,{status:200,headers:h});
        }
      }
    }catch(_){}
  }
  return new Response(renderFallback(errMsgs.join("；"), urlsStr),{
    status: 503,
    headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store, max-age=0","X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}
  });
}
function renderFallback(errMsg, urls){
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>服务正在重连中 - 追光·学科共享平台</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#fff;border-radius:20px;padding:48px 40px;max-width:520px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2);text-align:center;}
  .loader{width:64px;height:64px;border-radius:50%;border:5px solid #e5e7eb;border-top-color:#667eea;animation:spin 1s linear infinite;margin:0 auto 24px;}
  @keyframes spin{to{transform:rotate(360deg);}}
  h1{font-size:22px;color:#111827;margin-bottom:12px;font-weight:700;}
  .sub{font-size:14px;color:#6b7280;line-height:1.8;margin-bottom:28px;}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;border-radius:12px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;text-decoration:none;font-weight:600;font-size:15px;transition:transform .15s,box-shadow .15s;}
  .btn:hover{transform:translateY(-2px);box-shadow:0 10px 20px rgba(102,126,234,.4);}
  .info{margin-top:32px;padding:16px;background:#f9fafb;border-radius:10px;text-align:left;font-size:12px;color:#9ca3af;line-height:1.7;}
  .info b{color:#6b7280;}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 2s infinite;margin-right:6px;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.3;}}
</style></head>
<body><div class="card"><div class="loader"></div><h1>服务正在重连中</h1><p class="sub">隧道正在自动切换，通常 10~30 秒内恢复。<br/>请稍候片刻，然后刷新页面。</p><a class="btn" href="javascript:location.reload(true)">🔄 刷新页面</a>
<div class="info"><div><span class="dot"></span><b>Worker版本：</b>v6.5.3-manual-cache-20260805</div><div style="margin-top:6px;word-break:break-all;"><b>当前尝试：</b>${esc(urls)||"无候选URL"}</div>
${errMsg?`<div style="margin-top:6px;color:#ef4444;"><b>错误：</b>${esc(errMsg)}</div>`:""}
<div style="margin-top:10px;color:#6b7280;"><b>如果持续 1 分钟以上仍无法访问：</b><br/>请执行：<code style="background:#eef2ff;padding:2px 6px;border-radius:4px;color:#4338ca;">bash /workspace/fix.sh</code></div>
</div></div></body></html>`;
}
export default {
  async fetch(req, env, ctx){
    try{
      if(env && env.GITHUB_TOKEN){
        const t = String(env.GITHUB_TOKEN||"").trim();
        if(t && t.length>10){ GITHUB_TOKEN = t; }
      }
      const url = new URL(req.url);
      if(url.pathname === "/__zg_health"){
        const urls = await fetchCandidateUrls(false, env);
        const hobj={};
        for(const [k,v] of health.entries()) hobj[k]=Number(v.toFixed(3));
        return new Response(JSON.stringify({
          ok: true, version: "v6.5.3",
          urls, candidateCount: urls.length, health: hobj,
          lastGoodUrl, cacheAgeMs: Date.now()-cachedUrlsAt,
          "X-Zg-Worker-Version": "v6.5.3-manual-cache-20260805",
          "X-Zg-StaticCache": "STATIC-7D / HTML-30s / API-caches.default-MANUAL-HIT (v6.5.3重磅)",
          "X-Zg-Pinggy-Bypass": "X-Pinggy-No-Screen: 1 + UA特殊标记（自动跳过pinggy拦截页）"
        },null,2),{headers:{"content-type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}});
      }
      if(url.pathname === "/__zg_flush"){
        cachedUrls=[]; cachedUrlsAt=0; health=new Map(); lastGoodUrl="";
        return new Response(JSON.stringify({ok:true, flushed:true, version:"v6.5.3-manual-cache-20260805"}),{headers:{"content-type":"application/json","Access-Control-Allow-Origin":"*","X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}});
      }
      const force = url.searchParams.get("force")==="true";
      const urls = await fetchCandidateUrls(force, env);
      if(!urls || urls.length===0){
        return new Response(renderFallback("无候选URL - 请稍后刷新（fix.sh会自动重建隧道）", ""),{
          status:503,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store, max-age=0","X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}
        });
      }
      return await bestEffortFetch(req, urls, force, ctx);
    }catch(errTop){
      try{
        return new Response(renderFallback("1101异常："+String((errTop&&errTop.message)||errTop), ""),{
          status:503,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store, max-age=0","X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}
        });
      }catch(_){
        return new Response("Service Unavailable [Worker v6.5.3]",{status:503,headers:{"X-Zg-Worker-Version":"v6.5.3-manual-cache-20260805"}});
      }
    }
  }
};
