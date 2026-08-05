// 追光网站 - Cloudflare Worker 反向代理 v6.1（【1101异常修复版 + 3层URL候选池】）
// 更新日期：2026-08-05
// 修复v6 bug：
//   BUG1: 1101 JavaScript异常 —— v6 里 Promise.allSettled 索引0访问+健康分排序没有URL时的空数组越界，或headers Host设置时URL解析失败，都会抛出未捕获异常=Error 1101
//   BUG2: candidateCount=1 但是隧道直连HTTP200 —— 问题不是隧道挂了，是v6代码里 fetch 返回了 redirect=manual 后 3xx 响应体为空，我们仍认为它"r.ok || r.status<500"=成功，然后浏览器收到无body的302/空HTML=异常。
//
// 升级特性（解决pinggy免费版同IP并发1条限制→候选池方案）：
//   因为pinggy免费版同IP只能建1条并发SSH隧道，所以物理上真的只能有1条当前隧道。改而用"3层URL候选池"实现兜底：
//     第1层（最新）：GitHub tunnel-url.txt 当前值
//     第2层（历史）：从 GitHub 读 tunnel-url.txt 的 commit 历史，取最近 3 次成功更新的 URL（即使当前隧道重建了，旧URL也可能还能再撑几十秒~几分钟，命中就兜底）
//     第3层（KV缓存）：KV_CACHE 存 last_good_urls（上次成功过的多行，最多5条）
//   → 3层合并后去重，得到 1~5 条候选URL，v6的并行错峰探测+健康评分依然生效！
//   这样，即使 pinggy 只有 1 条物理隧道，Worker 也有 3~5 条候选可以 500ms 级快速切（= 模拟多隧道效果）
//
// 部署步骤：
//   1. 登录dash.cloudflare.com → Workers & Pages → 选 xkzg-de5-net Worker
//   2. 右上角「Edit code」→ 清空后全选粘贴本文件 → Ctrl+S / 「Deploy」
//   3. 可选增强：Worker→Settings→Variables→KV Namespace Bindings，把 KV_CACHE 绑定到任意KV命名空间（不绑定也能用，只是少了第3层兜底）
// =============================================================

const GITHUB_RAW = "https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt";
const GITHUB_API_CONTENTS = "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt";
const GITHUB_API_COMMITS = "https://api.github.com/repos/wrm120318/zhuiguang/commits?path=tunnel-url.txt&per_page=5";
const GITHUB_TOKEN = "";  // 可选，不填也免费用 Contents API+Commits API
const URL_CACHE_TTL_MS = 5000;
const FETCH_TIMEOUT_MS = 4500;
const HEALTH_DECAY = 0.9;
const MAX_HISTORY_URLS = 3;
const MAX_KV_URLS = 5;

let cachedUrls = [];
let cachedUrlsAt = 0;
let health = new Map();
let lastGoodUrl = "";

// ========= 工具 =========
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
function scoreOf(u){if(!health.has(u))health.set(u,0.7);return health.get(u);}
function mark(u,ok){
  const s=scoreOf(u);
  const next = ok ? Math.min(0.99, 0.18 + 0.82*s) : Math.max(0.02, s*HEALTH_DECAY*HEALTH_DECAY);
  health.set(u, next);
}
function uniqUrls(arr){
  const seen = new Set(); const out=[];
  for(const u of arr||[]){
    if(!u||typeof u!=="string") continue;
    const uu=u.trim();
    if(!uu||!uu.startsWith("https://")) continue;
    if(seen.has(uu)) continue;
    seen.add(uu); out.push(uu);
  }
  return out;
}
function sortByHealth(urls){
  const arr = (urls||[]).slice();
  arr.sort((a,b)=>{
    if(a===lastGoodUrl) return -999;
    if(b===lastGoodUrl) return 999;
    const sb=scoreOf(b), sa=scoreOf(a);
    if(Math.abs(sb-sa)>0.0001) return sb-sa;
    return 0;
  });
  return arr;
}

// ========= 1. 取 GitHub 当前 tunnel-url.txt（支持多行） =========
async function fetchCurrentUrls(){
  try{
    const hdrs = { "Accept":"text/plain,application/vnd.github.raw" };
    if(GITHUB_TOKEN) hdrs["Authorization"]="Bearer "+GITHUB_TOKEN;
    // 两路并行：Raw + Contents API raw
    const tasks = [
      (async ()=>{
        try{
          const r=await fetch(GITHUB_RAW+"?t="+Date.now(),{cf:{cacheTtl:10,cacheEverything:true}});
          if(!r.ok) return "";
          return await r.text();
        }catch(e){ return ""; }
      })(),
      (async ()=>{
        try{
          const r=await fetch(GITHUB_API_CONTENTS,{headers:hdrs});
          if(!r.ok) return "";
          return await r.text();
        }catch(e){ return ""; }
      })(),
    ];
    const res = await Promise.allSettled(tasks);
    for(const p of res){
      if(p.status==="fulfilled" && typeof p.value==="string" && p.value.trim().length>0){
        const lines = p.value.split(/\r?\n/).map(s=>s.trim()).filter(s=>s.startsWith("https://"));
        if(lines.length>0) return lines;
      }
    }
  }catch(e){}
  return [];
}

// ========= 2. 取 GitHub 最近 3 次 commit 里的历史 tunnel-url.txt =========
async function fetchHistoryUrls(){
  const out = [];
  try{
    const hdrs = { "Accept":"application/vnd.github+json" };
    if(GITHUB_TOKEN) hdrs["Authorization"]="Bearer "+GITHUB_TOKEN;
    const rc = await fetch(GITHUB_API_COMMITS,{headers:hdrs,cf:{cacheTtl:60}});
    if(!rc.ok) return [];
    const commits = await rc.json();
    if(!Array.isArray(commits)) return [];
    const shas = [];
    for(const c of commits.slice(0, MAX_HISTORY_URLS+1)){
      if(c && c.sha && typeof c.sha==="string") shas.push(c.sha);
    }
    // 并行取历史文件
    const tasks = shas.map(sha => (async ()=>{
      try{
        const u = `https://raw.githubusercontent.com/wrm120318/zhuiguang/${sha}/tunnel-url.txt`;
        const r = await fetch(u,{cf:{cacheTtl:300}});
        if(!r.ok) return "";
        return await r.text();
      }catch(e){ return ""; }
    })());
    const ress = await Promise.allSettled(tasks);
    for(const p of ress){
      if(p.status!=="fulfilled"||typeof p.value!=="string") continue;
      const lines = p.value.split(/\r?\n/).map(s=>s.trim()).filter(s=>s.startsWith("https://"));
      for(const l of lines) out.push(l);
    }
  }catch(e){}
  return out;
}

// ========= 3. KV 兜底 last_good_urls =========
async function fetchKvUrls(){
  try{
    const kv = globalThis?.KV_CACHE;
    if(!kv) return [];
    const s = await kv.get("last_good_urls");
    if(!s||typeof s!=="string") return [];
    const arr = s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    return arr.slice(0, MAX_KV_URLS);
  }catch(e){ return []; }
}
async function writeKvUrls(urls){
  try{
    const kv = globalThis?.KV_CACHE;
    if(!kv) return;
    const data = uniqUrls(urls).slice(0, MAX_KV_URLS).join("\n");
    if(!data) return;
    await kv.put("last_good_urls", data, {expirationTtl: 86400*7});
  }catch(e){}
}

// ========= 4. 组合 3 层候选池 =========
async function fetchCandidateUrls(force){
  const now = Date.now();
  if(!force && cachedUrls.length>0 && now-cachedUrlsAt<URL_CACHE_TTL_MS){
    return cachedUrls.slice();
  }
  const [curr, hist, kvu] = await Promise.all([
    fetchCurrentUrls(),
    fetchHistoryUrls(),
    fetchKvUrls(),
  ]);
  const merged = uniqUrls([ ...(curr||[]), ...(hist||[]), ...(kvu||[]) ]);
  if(merged.length>0){
    cachedUrls = merged.slice();
    cachedUrlsAt = now;
    // 异步写KV
    writeKvUrls(merged).catch(()=>{});
  }
  return merged.slice();
}

// ========= 5. 带超时的 fetch（无异常抛出版本，永远不抛1101） =========
function safeFetch(urlStr, req, body){
  let ctrl; let timer; let settled=false;
  try { ctrl = new AbortController(); } catch(e){ ctrl = null; }
  try {
    timer = setTimeout(()=>{
      if(ctrl && !settled){ try{ ctrl.abort(); }catch(_){} }
    }, FETCH_TIMEOUT_MS);
  }catch(e){ timer = null; }

  let target; let host;
  try{
    target = urlStr + (req.url.startsWith("/")?req.url:"/"+req.url);
    host = new URL(urlStr).host;
  }catch(e){
    // URL解析失败，直接返回失败结果
    return Promise.resolve({ok:false, url:urlStr, err:"URL_PARSE"});
  }

  const init = { method: req.method, redirect: "follow" }; // ← 修复BUG2：redirect 从 manual 改成 follow，让302自动跳转
  try{
    init.headers = new Headers(req.headers);
    init.headers.set("Host", host);
    init.headers.set("User-Agent", "Cloudflare-Worker/6.1 (+zhuiguang v6.1 pool)");
    init.headers.set("X-Forwarded-Proto", "https");
    if(init.headers.has("cf-connecting-ip")) init.headers.delete("cf-connecting-ip");
    if(init.headers.has("cf-ray")) init.headers.delete("cf-ray");
    if(init.headers.has("cf-worker")) init.headers.delete("cf-worker");
    if(ctrl) init.signal = ctrl.signal;
  }catch(e){}
  if(body && ["POST","PUT","PATCH","DELETE"].includes(req.method)) init.body = body;

  const p = fetch(target, init).then(r=>{
    settled=true;
    if(timer) clearTimeout(timer);
    // 2xx 或 3xx 都算成功（redirect follow后最终是2xx也正常）
    const ok = (r.status>=200 && r.status<500);
    mark(urlStr, ok);
    return {ok, url:urlStr, status: r.status, r};
  }).catch(e=>{
    settled=true;
    if(timer) clearTimeout(timer);
    mark(urlStr, false);
    return {ok:false, url:urlStr, err: String(e?.name || e || "FETCH_ERR")};
  });
  return p;
}

// ========= 6. 多候选并行错峰请求（核心：任何异常都捕获，绝不抛1101） =========
async function bestEffortFetch(urls, req){
  if(!urls || urls.length===0) return null;
  let body = null;
  try{
    if(["POST","PUT","PATCH","DELETE"].includes(req.method)){
      try{ body = await req.clone().arrayBuffer(); }catch(_){ body=null; }
    }
  }catch(_){}
  const ordered = sortByHealth(urls);
  const tasks = [];
  const stagger = [0, 350, 800, 1400, 2200];
  for(let i=0;i<ordered.length;i++){
    const u = ordered[i];
    const d = stagger[i] ?? 3000;
    const task = new Promise(resolve=>{
      setTimeout(()=>{
        safeFetch(u, req, body).then(resolve).catch(err=>{
          resolve({ok:false, url:u, err: String(err?.name||err||"CATCH")});
        });
      }, d);
    });
    tasks.push(task);
  }
  // 按完成顺序拿第一个成功的
  try{
    let firstOk = null;
    const wraps = tasks.map(t => t.then(r=>{ return {r}; }));
    // 简易首个成功：一个个等
    for(let i=0;i<wraps.length;i++){
      try{
        const w = await wraps[i];
        if(w.r && w.r.ok && w.r.r){
          firstOk = w.r;
          break;
        }
      }catch(_){}
    }
    if(firstOk){
      lastGoodUrl = firstOk.url;
      return firstOk.r;
    }
    // 没有成功：找最后一个有响应的作为兜底
    const all = await Promise.all(tasks);
    for(const r of all){
      if(r && r.r){ lastGoodUrl = r.url; return r.r; }
    }
    return null;
  }catch(e){
    return null;
  }
}

// ========= 7. 友好错误页（v6.1：任何情况都返回这个，不会抛1101） =========
function friendlyErr(urls, tries, msg){
  const urlList = (urls||[]).map(u=>{
    const s=(scoreOf(u)*100).toFixed(0);
    return `<li>${esc(u)} <span style="color:#888">健康度 ${s}%</span></li>`;
  }).join("");
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>服务正在重连中 - 追光学科平台</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;background:#f8fafc;color:#0f172a;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;border-radius:16px;padding:36px 32px;max-width:560px;width:100%;box-shadow:0 10px 40px rgba(15,23,42,.08);text-align:center;border:1px solid #e2e8f0}
.spin{width:44px;height:44px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;margin:0 auto 20px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:20px;margin:0 0 8px;color:#0f172a}
p{margin:6px 0;color:#475569;font-size:14px;line-height:1.7}
.hint{background:#eff6ff;border-left:3px solid #3b82f6;padding:10px 14px;border-radius:8px;text-align:left;margin:16px 0;font-size:13px;color:#1e40af}
.btn{display:inline-block;margin-top:14px;padding:10px 22px;background:#3b82f6;color:#fff;border-radius:10px;text-decoration:none;font-weight:500;font-size:14px;border:none;cursor:pointer}
.btn:hover{background:#2563eb}
details{margin-top:18px;text-align:left;background:#f1f5f9;border-radius:8px;padding:8px 14px}
details summary{cursor:pointer;color:#64748b;font-size:12px;padding:2px 0}
pre{margin:8px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-all;color:#334155;max-height:240px;overflow:auto}
</style></head><body>
<div class="card">
  <div class="spin"></div>
  <h1>服务正在重连中</h1>
  <p>隧道正在自动切换，通常 10~30 秒内恢复。</p>
  <p>请稍候片刻，然后刷新页面。</p>
  <div class="hint">💡 v6.1 新特性：3层候选URL池（GitHub当前 + 最近3次历史URL + KV缓存）= 即使物理隧道切换中，也有 ${Math.max(1,(urls?.length||0))} 条候选自动探测，通常一次刷新即可恢复。</div>
  <button class="btn" onclick="location.reload(true)">刷新页面</button>
  <details>
    <summary>🔧 调试信息（一直不恢复请截图发管理员）</summary>
<pre>Worker版本: zhuiguang-worker v6.1
错误信息: ${esc(msg||"隧道暂时不可达")}
连续失败次数: ${tries ?? 1}
候选URL数: ${urls?.length ?? 0}
健康状态:
${urlList || "  (无候选，后台正在建隧道)"}
时间: ${new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</pre>
  </details>
</div>
<script>
(function(){
  try {
    const k='zg_retry_v61';
    const v=JSON.parse(sessionStorage.getItem(k)||'{"n":0,"t":0}');
    if(Date.now()-v.t>180000) v.n=0;
    if(v.n<6){
      v.n+=1; v.t=Date.now();
      sessionStorage.setItem(k, JSON.stringify(v));
      const delays=[3000,5000,7000,9000,11000,13000];
      setTimeout(()=>location.reload(true), delays[v.n-1]||5000);
    }else{
      sessionStorage.setItem(k, JSON.stringify({n:0,t:0}));
    }
  }catch(e){}
})();
</script></body></html>`;
  return new Response(body, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Zg-Worker-Version": "v6.1-3layer-pool",
      "X-Zg-Candidate-Count": String(urls?.length || 0),
      "X-Zg-Last-Good": lastGoodUrl || "",
      "Retry-After": "10",
    },
  });
}

// ========= 8. 主入口（任何异常都捕获 → 友好页，绝不抛1101） =========
export default {
  async fetch(req, env, ctx) {
    try {
      if(env?.KV_CACHE){ try{ globalThis.KV_CACHE = env.KV_CACHE; }catch(_){} }
      const url = new URL(req.url);

      // 健康检查调试接口
      if(url.pathname === "/__zg_health"){
        let urls = [];
        try{ urls = await fetchCandidateUrls(false); }catch(_){ urls = cachedUrls.slice(); }
        const hObj = {};
        for(const [k,v] of health.entries()){ try{ hObj[k] = Math.round(v*1000)/1000; }catch(_){} }
        const body = JSON.stringify({
          version: "v6.1",
          urls,
          candidateCount: urls.length,
          health: hObj,
          lastGoodUrl,
          cacheAgeMs: cachedUrlsAt ? Date.now() - cachedUrlsAt : -1,
        }, null, 2);
        return new Response(body, { headers: { "Content-Type":"application/json; charset=utf-8", "Access-Control-Allow-Origin":"*", "X-Zg-Worker-Version":"v6.1" }});
      }

      // 静态资源和普通请求 → 走候选池并行探测
      let urls = [];
      try {
        urls = await fetchCandidateUrls(false);
      } catch(e){
        try{ urls = cachedUrls.slice(); }catch(_){ urls=[]; }
      }
      if(urls.length===0){
        return friendlyErr([], 0, "尚未获取到隧道地址，请稍后再试");
      }
      let res = null;
      try {
        res = await bestEffortFetch(urls, req);
      } catch(e){
        res = null;
      }
      if(res){
        // 成功 → 透传响应（加上 v6.1 header 方便排障）
        try{
          const newHdrs = new Headers(res.headers);
          newHdrs.set("X-Zg-Worker-Version", "v6.1-3layer-pool");
          newHdrs.set("X-Zg-Candidate-Count", String(urls.length));
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers: newHdrs });
        }catch(_){
          return res;
        }
      }
      // 第一轮全部失败 → 强制重拉候选池一次再试
      try {
        const urls2 = await fetchCandidateUrls(true);
        if(urls2.length>0){
          try{
            const res2 = await bestEffortFetch(urls2, req);
            if(res2) return res2;
          }catch(_){}
          return friendlyErr(urls2, 2, "全部候选隧道暂时不可达，后台正在自动切换");
        }
      }catch(_){}
      return friendlyErr(urls, 2, "全部候选隧道暂时不可达，后台正在自动切换");
    } catch (eTop) {
      // ❗❗ 任何没有被上面捕获的漏网之鱼 → 最后兜底友好页，绝不抛1101
      try {
        return friendlyErr(cachedUrls.slice(), 3, "Worker内部异常: " + String(eTop?.message || eTop?.name || eTop));
      } catch(_fatal){
        return new Response("服务重连中，请稍后刷新 (v6.1 fatal fallback)", { status: 503, headers: { "Content-Type":"text/plain; charset=utf-8", "Retry-After":"10" }});
      }
    }
  },
};
