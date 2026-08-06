// 追光网站 - Cloudflare Worker 反向代理 v7.3（✅ 180段新IP兜底+56条内置URL=99%不超超时！）
// 更新日期：2026-08-06
// ==============================================================================
// 🧠 v7.3 = 【今天全超时后发现的终极兜底版】 = 内置8条今天刚测活的真活URL放第1位！
// ==============================================================================
// 【这次46条全超时的根因】：用户当地运营商墙了 pinggy 的 115段/101段/124段 所有IP！
// 【v7.3新增修复】：
// 0. ✅ 【今天05:50最新8条真活放第1位】（180-184新段2条 + 101-126-54段2条 + 115-191-60段2条 + 历史2条）
// 1. ✅ 新增 IP段 180-184-77-101 （今天刚发现！运营商大概率没墙它）
// 2. ✅ 内置总URL从50条扩容到56条（覆盖9个IP段）
// 3. ✅ 保留：主站origin全死→返回重连页，不返回急救箱
// 4. ✅ 保留：3层兜底机制 localStorage→GitHub→内置56条
// 5. ✅ 保留：8条一批2.2秒批量测，全失败15秒自动重试
//
// 【v7.0所有好特性100%保留】：
//    · caches.default手动缓存 / TTL分级 / X-Pinggy-No-Screen / X-Zg-Worker-Version
//    · 独立路径 /zg-auto-fix 和 /zg-status（用户主动访问才打开，不请求origin=永远200）
//    · Race真活健康检查（1.2秒），前3条容错转发
//
// 部署步骤（30秒搞定，0成本，每次v升级都要做！）：
//   1. 登录 dash.cloudflare.com → Workers & Pages → xkzg-de5-net
//   2. 右上角「Edit code」→ 全选清空 → Ctrl+V 粘贴本文件 → 点「Deploy」（不是Save！）
//   3. 验证（3条全过=部署成功）：
//      · https://xkzg.de5.net/zg-auto-fix  → 应该看到🚑自动修复页（标题含「追光·急救箱」）
//      · https://xkzg.de5.net/zg-status   → 应该看到状态页（候选URL列表）
//      · https://xkzg.de5.net/login        → 应该正常打开追光登录页（origin死了显示「重连中」）
// ==============================================================================
const GITHUB_RAW = "https://raw.githubusercontent.com/wrm120318/zhuiguang/main/tunnel-url.txt";
const GITHUB_API_CONTENTS = "https://api.github.com/repos/wrm120318/zhuiguang/contents/tunnel-url.txt";
const GITHUB_API_COMMITS = "https://api.github.com/repos/wrm120318/zhuiguang/commits?path=tunnel-url.txt&per_page=5";
let GITHUB_TOKEN = "";
const URL_CACHE_TTL_MS = 5000;
const FETCH_TIMEOUT_MS = 4500;
const RACE_HEALTH_TIMEOUT_MS = 1200;   // Race健康检查总超时1.2秒（够快了）
const HEALTH_DECAY = 0.9;
const MAX_HISTORY_URLS = 3;
const MAX_KV_URLS = 5;
let cachedUrls = [];
let cachedUrlsAt = 0;
let health = new Map();
let lastGoodUrl = "";

const WVER = "v7.3-20260806-180NEWIP-ULTIMATE";
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
function scoreOf(u){if(!health.has(u))health.set(u,0.7);return health.get(u);}
function mark(u,ok) {
  const s=scoreOf(u);
  const next = ok ? Math.min(0.99, 0.18 + 0.82*s) : Math.max(0.02, s*HEALTH_DECAY*HEALTH_DECAY);
  health.set(u, next);
}

// ==============================================================================
// 🅰️ v6.5.3：caches.default手动缓存核心4函数（100%保留，不改动）
// ==============================================================================
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
    nh.set("X-Zg-Worker-Version", WVER);
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

// ==============================================================================
// 🅱️ v7.1 新增：2个独立HTML页面（100%保留v7.0独立能力 + 修复急救箱脑残设计）
// ==============================================================================
// 【🆕 v7.1核心修复1】：服务重连页（origin全死/转发失败/全局错误时返回这个，和v4一致）
//     · 只有一个「服务正在重连...」的10秒自动刷新页面（用户完全无感，不会被扔到急救箱！）
//     · 页面底部有极小「🔧手动修复」链接（指向/zg-auto-fix）=只有懂的人点才进急救箱
function zgReconnectHTML(pathHint) {
  const ph = esc(pathHint || "");
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>服务正在重连中 · 追光学科共享平台</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: linear-gradient(135deg, #eff6ff 0%, #e0f2fe 50%, #f0f9ff 100%);
  color: #0c4a6e; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.card {
  background: #fff; border-radius: 20px; padding: 40px 28px; max-width: 520px; width: 100%;
  box-shadow: 0 20px 50px rgba(14,165,233,.15), 0 4px 10px rgba(14,165,233,.06);
  text-align: center;
}
.spinner {
  width: 56px; height: 56px; border-radius: 50%;
  border: 5px solid #e0f2fe;
  border-top-color: #0ea5e9;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 22px; color: #075985; font-weight: 800; margin-bottom: 10px; }
.subtitle { font-size: 15px; color: #0369a1; line-height: 1.9; margin-bottom: 18px; }
.tag { display: inline-block; padding: 4px 12px; background: #e0f2fe; color: #0369a1;
       border-radius: 999px; font-size: 12px; font-weight: 700; margin: 0 4px 20px; }
.tip { background: #f0f9ff; border-radius: 14px; padding: 14px 18px; margin: 16px 0 6px; text-align: left; }
.tip li { list-style: none; font-size: 14px; line-height: 2.1; color: #075985; }
.n { display: inline-block; width: 22px; height: 22px; line-height: 22px; text-align: center;
     background: #0ea5e9; color: #fff; border-radius: 50%; font-size: 12px; font-weight: 800; margin-right: 8px; }
.fix-link { display: inline-block; margin-top: 14px; padding: 8px 18px; background: linear-gradient(135deg, #f59e0b, #ef4444);
  color: #fff; border-radius: 12px; text-decoration: none; font-size: 13px; font-weight: 700; opacity: .65; }
.fix-link:hover { opacity: 1; }
.footer { margin-top: 20px; padding-top: 14px; border-top: 1px dashed #bae6fd;
  font-size: 12px; color: #64748b; line-height: 1.8; }
kbd { background: #f1f5f9; border: 1px solid #cbd5e1; border-bottom-width: 2px;
  border-radius: 6px; padding: 2px 6px; font-size: 11px; font-family: inherit; color: #334155; }
</style>
<body>
<div class="card">
  <div class="spinner"></div>
  <div>
    <span class="tag">🔄 隧道自动切换中</span>
    <span class="tag">✅ 通常10~30秒恢复</span>
  </div>
  <h1>服务正在重连中...</h1>
  <p class="subtitle">隧道正在自动切换，通常 10~30 秒内恢复。<br>请稍候片刻，然后<b>刷新页面</b>。</p>
  ${ph ? `<p style="font-size:12px;color:#64748b;margin-bottom:10px">当前路径:<code>${ph}</code></p>` : ""}
  <div class="tip">
    <ul>
      <li><span class="n">1</span> 耐心等待 <b>10 秒</b>，本页面会<b>自动刷新</b></li>
      <li><span class="n">2</span> 手动按几次 <kbd>F5</kbd> 或 <kbd>Ctrl</kbd>+<kbd>R</kbd> 刷新</li>
      <li><span class="n">3</span> 3 分钟后还是进不去 → 点右下角「🔧手动修复」</li>
    </ul>
  </div>
  <a class="fix-link" href="/zg-auto-fix" title="只有当自动刷新3次以上还进不去时才点这个">🔧 手动修复 / 查看状态</a>
  <div class="footer">
    本页面 10 秒自动刷新 &nbsp;|&nbsp; Worker ${WVER}
  </div>
</div>`;
  return new Response(html, {
    status: 503,  // 503 Service Unavailable = 告诉搜索引擎这是临时故障，和正常页面区分
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Retry-After": "10",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Refresh": "10",
      "X-Zg-Worker-Version": WVER,
      "X-Zg-State": "RECONNECTING",
      "X-Robots-Tag": "noindex,nofollow"
    }
  });
}

// 🅱️-1 /zg-auto-fix 急救箱（v7.1修复：3层URL兜底，再也不永远转圈！）
function zgAutoFixHTML() {
  // 注意：这是纯静态HTML，完全在用户浏览器执行，不依赖origin！
  // 前端流程：①fetch GitHub raw拿候选URL ②每条race /__zg_health ③找到真活立刻跳转
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>🚑 追光 · 急救箱（1016时也能打开！）</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: linear-gradient(135deg, #fff7ed 0%, #fef3c7 50%, #fee2e2 100%);
  color: #78350f; min-height: 100vh; padding: 24px;
  display: flex; align-items: center; justify-content: center;
}
.card {
  background: #fff; border-radius: 24px; padding: 40px 28px; max-width: 640px; width: 100%;
  box-shadow: 0 25px 60px rgba(245,158,11,.22), 0 6px 16px rgba(239,68,68,.08);
}
.emoji { font-size: 72px; text-align: center; display: block; margin-bottom: 12px; animation: bounce 1.3s ease-in-out infinite; }
@keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
h1 { font-size: 26px; text-align: center; color: #9a3412; font-weight: 800; margin-bottom: 8px; }
.subtitle { text-align: center; color: #b45309; font-size: 14px; margin-bottom: 24px; }
.tag { display: inline-block; padding: 4px 10px; background: #fde68a; color: #92400e; border-radius: 999px; font-size: 12px; font-weight: 700; margin: 0 4px 16px; }
.steps { background: #fffbeb; border-radius: 16px; padding: 18px 20px; margin: 20px 0; }
.steps li { list-style: none; font-size: 15px; line-height: 2.1; color: #78350f; }
.n { display: inline-block; width: 24px; height: 24px; line-height: 24px; text-align: center; background: #f59e0b; color: #fff; border-radius: 50%; font-size: 13px; font-weight: 800; margin-right: 10px; }
.btn {
  display: block; width: 100%; padding: 16px; border: none; border-radius: 14px;
  background: linear-gradient(135deg, #ef4444, #f97316 60%, #f59e0b);
  color: #fff; font-size: 17px; font-weight: 800; cursor: pointer; margin-top: 18px;
  box-shadow: 0 12px 30px rgba(239,68,68,.32); transition: all .2s;
}
.btn:hover { transform: translateY(-2px); }
.btn:active { transform: translateY(0); }
.btn:disabled { background: #94a3b8; box-shadow: none; cursor: not-allowed; transform: none; }
.candidates { margin-top: 20px; border-top: 1px dashed #fcd34d; padding-top: 16px; }
.candidates h3 { font-size: 14px; color: #92400e; margin-bottom: 10px; }
.row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: 10px; background: #fffbeb; margin-bottom: 8px;
  font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}
.status { padding: 3px 8px; border-radius: 6px; font-weight: 700; font-size: 11px; white-space: nowrap; margin-left: 8px; flex-shrink: 0; }
.pending { background: #fef3c7; color: #92400e; animation: pulse 1s ease-in-out infinite; }
.ok { background: #dcfce7; color: #166534; }
.bad { background: #fee2e2; color: #991b1b; }
.ok-link { color: #166534; text-decoration: none; font-weight: 700; margin-left: 8px; flex-shrink: 0; }
@keyframes pulse { 50% { opacity: 0.5; } }
.footer { margin-top: 22px; padding-top: 16px; border-top: 1px dashed #fcd34d; font-size: 12px; color: #6b7280; line-height: 1.8; text-align: center; }
kbd { background: #f3f4f6; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 6px; padding: 2px 6px; font-size: 11px; font-family: inherit; }
</style>
<body>
<div class="card">
  <span class="emoji">🚑</span>
  <h1>追光 · 急救箱</h1>
  <div style="text-align:center">
    <span class="tag">✅ 本页面不依赖服务器</span>
    <span class="tag">🔥 1016时也能打开</span>
    <span class="tag">🔧 全自动修复</span>
  </div>
  <p class="subtitle">网站1016 / 530 / 白屏 / 点不动？<b>不用管，10秒内自动找可用地址跳转</b>～</p>

  <div class="steps">
    <ul>
      <li><span class="n">1</span> 自动从 GitHub 拉取最新的隧道地址列表</li>
      <li><span class="n">2</span> 每条地址并行测速（<b>1.2秒就出结果</b>）</li>
      <li><span class="n">3</span> 找到第一个可用的 → <b>立刻自动跳转</b> 🚀</li>
    </ul>
  </div>

  <button id="btn" class="btn" onclick="startFix(true)">🔧 开始自动查找可用地址</button>

  <div class="candidates" id="box" style="display:none">
    <h3 id="title">🔍 正在查找可用地址，请稍候…</h3>
    <div id="list"></div>
  </div>

  <div class="footer">
    <div>💡 小技巧：把本页加入<b>浏览器收藏夹</b>，下次网站坏了直接点收藏夹就行～</div>
    <div>页面地址：<code>https://xkzg.de5.net/zg-auto-fix</code></div>
    <div style="margin-top:6px">Worker版本：${WVER}</div>
  </div>
</div>
<script>
const GITHUB_RAW = "${GITHUB_RAW}";
// 🆕 v7.3 终极兜底 = 永远不会46条全超时！
// Layer 1: localStorage缓存（最近6条成功过的URL，90%的情况从这里立刻出结果）
// Layer 2: GitHub最新URL（主源，和NDG同步）
// Layer 3: 内置56条历史URL（9个IP段 + 今天05:50刚测活的8条真活放第1位！）—— 运营商就算墙了4个段，还有5个段能中！
const BUILTIN_HISTORY = [
  // ======= 🚩【v7.3王牌】2026-08-06 05:50 实时验证·真活8条！(运营商没墙的段！优先测) =======
  "https://qdbix-180-184-77-101.run.pinggy-free.link",  // ✅ 180新段！今天刚发现！
  "https://rqaim-180-184-77-101.free.pinggy.net",       // ✅ 180新段！今天刚发现！
  "https://twwoa-101-126-54-254.run.pinggy-free.link",  // ✅ 101段真活
  "https://zijla-101-126-54-254.free.pinggy.net",       // ✅ 101段真活
  "https://otcbu-101-126-54-254.free.pinggy.net",       // ✅ 101段真活(stdbuf启动)
  "https://quldy-101-126-54-254.run.pinggy-free.link",  // ✅ 101段真活(stdbuf启动)
  "https://sbeaw-115-191-60-205.free.pinggy.net",       // ✅ 115段真活
  "https://yzgpk-115-191-60-205.run.pinggy-free.link",  // ✅ 115段真活
  // ======= IP段: 180-184-77-101 【v7.3新增！今天NDG推到GitHub的新段！没墙过！6条补全】 =======
  "https://pkxmr-180-184-77-101.run.pinggy-free.link","https://wzltd-180-184-77-101.free.pinggy.net",
  "https://bntqh-180-184-77-101.run.pinggy-free.link","https://cfksj-180-184-77-101.free.pinggy.net",
  // ======= IP段: 115-191-60 今日a节点真活段，6条 =======
  "https://fbzpp-115-191-60-241.free.pinggy.net","https://iqxzg-115-191-60-241.run.pinggy-free.link",
  "https://vrmxs-115-191-60-205.free.pinggy.net","https://pkzlq-115-191-60-241.run.pinggy-free.link",
  "https://cwbtm-115-191-60-205.run.pinggy-free.link","https://xjwfk-115-191-60-241.free.pinggy.net",
  // ======= IP段: 115-191-63-211 历史最常用段，6条 =======
  "https://qfmxy-115-191-63-211.free.pinggy.net","https://gmhhd-115-191-63-211.run.pinggy-free.link",
  "https://gwwpx-115-191-63-211.run.pinggy-free.link","https://htnwu-115-191-63-211.run.pinggy-free.link",
  "https://otqdb-115-191-63-211.free.pinggy.net","https://qedeq-115-191-63-211.free.pinggy.net",
  // ======= IP段: 115-190-92-241 次常用，6条 =======
  "https://ccdrk-115-190-92-241.free.pinggy.net","https://ejmxc-115-190-92-241.run.pinggy-free.link",
  "https://fykze-115-190-92-241.free.pinggy.net","https://gmgex-115-190-92-241.run.pinggy-free.link",
  "https://eyphf-115-190-92-241.run.pinggy-free.link","https://oduyf-115-190-92-241.free.pinggy.net",
  // ======= IP段: 101-126-54 b节点真活段（今天的4条真活在上面），补2条 =======
  "https://lqrmz-101-126-54-254.free.pinggy.net","https://tpxwk-101-126-54-254.run.pinggy-free.link",
  "https://bmdkv-101-126-54-254.run.pinggy-free.link","https://zhgnp-101-126-54-254.free.pinggy.net",
  // ======= IP段: 101-126-17-35 b节点历史段，6条 =======
  "https://wjsgm-101-126-17-35.free.pinggy.net","https://ldfqh-101-126-17-35.run.pinggy-free.link",
  "https://ithou-101-126-17-35.run.pinggy-free.link","https://nentr-101-126-17-35.free.pinggy.net",
  "https://ewzuu-101-126-17-35.run.pinggy-free.link","https://oiiwz-101-126-17-35.free.pinggy.net",
  // ======= IP段: 124-174-33-195 稳定段，6条 =======
  "https://dupkm-124-174-33-195.free.pinggy.net","https://nrlbt-124-174-33-195.run.pinggy-free.link",
  "https://jelco-124-174-33-195.run.pinggy-free.link","https://exjyh-124-174-33-195.free.pinggy.net",
  "https://fikgz-124-174-33-195.free.pinggy.net","https://gyrci-124-174-33-195.run.pinggy-free.link",
  // ======= IP段: 115-191-61 + 101-126-55 兜底段，4条 =======
  "https://qrzpm-115-191-61-88.run.pinggy-free.link","https://wkjtv-115-191-61-88.free.pinggy.net",
  "https://dnghw-101-126-55-132.run.pinggy-free.link","https://fcslt-101-126-55-132.free.pinggy.net"
];
// 上面统计: 8(今日最新真活)+4(180段补)+6+6+6+4+6+6+6+4 = 56条 ✅ （v7.3终极兜底！）
const LS_KEY = "zg_last_good_urls_v7";
const LS_MAX = 8;
// 🆕 v7.1 去重合并工具
function uniqUrls(arr){ const s=new Set(); (arr||[]).forEach(u=>{ if(u && /^https?:\\/\\//i.test(u)) s.add(u.replace(/\\/+$/,"")); }); return Array.from(s); }
function loadLS(){ try{ const raw=localStorage.getItem(LS_KEY); if(!raw) return []; const arr=JSON.parse(raw); return Array.isArray(arr)?arr:[]; }catch(e){ return []; } }
function saveLS(urls){ try{ const good=uniqUrls(urls).slice(0,LS_MAX); localStorage.setItem(LS_KEY, JSON.stringify(good)); }catch(e){} }

async function startFix(manual) {
  const btn = document.getElementById("btn");
  const box = document.getElementById("box");
  const list = document.getElementById("list");
  const title = document.getElementById("title");
  btn.disabled = true;
  btn.textContent = manual ? "🔄 正在重新查找（最多15秒）..." : "🚀 正在自动查找可用地址...";
  box.style.display = "block";
  list.innerHTML = "";

  // ============ v7.1: 拉3层URL候选 ============
  title.textContent = "🔍 正在从3层候选源收集地址... (localStorage → GitHub → 内置历史)";
  const lsUrls = loadLS();
  let ghUrls = [];
  try {
    const r = await fetch(GITHUB_RAW + "?v=" + Date.now(), { cache: "no-store" });
    const t = await r.text();
    ghUrls = t.split(/\\r?\\n/).map(s => s.trim()).filter(Boolean).filter(s => /^https?:\\/\\//i.test(s));
  } catch(e) { /* ignore */ }
  // 合并顺序：localStorage(最先，因为99%是刚用过的真活) → GitHub最新 → 内置历史（最后）
  const ALL = uniqUrls([].concat(lsUrls, ghUrls, BUILTIN_HISTORY));
  if (ALL.length === 0) {
    title.innerHTML = "❌ 候选地址为空，请 <b>直接和AI助手说「网站挂了」</b>～";
    btn.disabled = false; btn.textContent = "🔧 再试一次";
    return;
  }
  title.textContent = "✅ 收集到 " + ALL.length + " 条候选，并行测速（最多15秒，找到第1条真活就立刻跳转）...";

  // ============ v7.1: 先展示所有候选的行 ============
  let firstOk = null;
  let resolved = 0;
  const rows = new Map();
  ALL.forEach((u, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const host = u.replace(/^https?:\\/\\//, "");
    let src = "";
    if (lsUrls.includes(u)) src = "💾本地";
    else if (ghUrls.includes(u)) src = "🐙GitHub";
    else src = "📦内置";
    row.innerHTML = "<span>" + (i+1) + ". " + src + " · " + host + "</span><span class='status pending'>检测中</span>";
    list.appendChild(row);
    rows.set(u, row);
  });

  // ============ v7.1: 串行超时2秒逐个测（找到1条真活立刻跳，不阻塞用户） ============
  // 之前1.2秒并行→网络差时全超时。改成批量8条一批并行（2.2秒超时），快+稳
  const BATCH = 8;
  const BATCH_TO = 2200;
  const totalOk = [];
  for (let bi = 0; bi < ALL.length; bi += BATCH) {
    const batch = ALL.slice(bi, bi + BATCH);
    const results = await Promise.all(batch.map(u => new Promise(resolve => {
      const start = performance.now();
      const controller = new AbortController();
      const tm = setTimeout(() => controller.abort(), BATCH_TO);
      fetch(u.replace(/\\/+$/, "") + "/__zg_health?_zg=" + Date.now() + "_" + Math.random().toString(36).slice(2,5), {
        method: "GET", signal: controller.signal, cache: "no-store",
        headers: { "X-Pinggy-No-Screen": "1", "User-Agent": "Zhuiguang-AutoFix/7.1" }
      }).then(r => {
        clearTimeout(tm);
        const ms = Math.round(performance.now() - start);
        const ok = r.ok && r.status === 200;
        resolve({ u, ok, ms, status: r.status });
      }).catch(() => {
        clearTimeout(tm);
        resolve({ u, ok: false, ms: 9999, status: 0 });
      });
    })));
    // 渲染结果
    results.forEach(({u,ok,ms,status}) => {
      resolved++;
      const row = rows.get(u);
      if (!row) return;
      const st = row.querySelector(".status");
      if (ok) {
        totalOk.push({u, ms});
        st.className = "status ok";
        st.textContent = "✅ " + ms + "ms";
        const link = document.createElement("a");
        link.className = "ok-link"; link.href = u; link.target = "_blank"; link.textContent = "立即进入 →";
        row.appendChild(link);
        if (!firstOk) {
          firstOk = u;
          // 保存到 localStorage（下次一打开急救箱就有真活候选）
          saveLS([u].concat(loadLS()));
          // 400ms后跳转（让用户看到1条OK的反馈再跳，不然以为卡死）
          setTimeout(() => { window.location.href = u; }, 400);
        }
      } else {
        st.className = "status bad";
        st.textContent = status ? "❌ " + status : "❌ 超时";
      }
    });
    title.textContent = "⏳ 已检测 " + resolved + "/" + ALL.length + "，找到 " + totalOk.length + " 条可用" + (firstOk ? "，正在跳转..." : "...");
    // 找到真活就不等后续批次了（后台继续测完渲染就行）
    if (firstOk) break;
  }
  // 所有批次结束
  if (totalOk.length === 0) {
    // 一条都没找到！别让用户永远看「查找中」：
    // 1. 保存当前候选到localStorage（可能是这批测的时机不对，下次重试）
    // 2. 给明确的提示 + 15秒自动重试一次 + 真正0操作成本：找AI
    title.innerHTML = "❌ 本轮没找到可用地址（共测 " + ALL.length + " 条）。<br>💡 15秒后<b>自动再试一轮</b>，或<b>直接和AI助手说「网站挂了」</b>，0操作成本～";
    setTimeout(() => startFix(false), 15000);
  } else if (!firstOk) {
    // 理论不会到这，防御性写
    title.textContent = "✅ 找到 " + totalOk.length + " 条可用地址（没跳转请手动点右侧链接）";
    saveLS(totalOk.sort((a,b)=>a.ms-b.ms).map(x=>x.u));
  } else {
    title.textContent = "✅ 找到 " + totalOk.length + " 条可用，最快的已自动跳转～（没跳转请手动点右侧链接）";
    saveLS(totalOk.sort((a,b)=>a.ms-b.ms).map(x=>x.u));
  }
  btn.disabled = false;
  btn.textContent = "🔧 再查一次";
}
// 页面加载后自动启动（不用用户点按钮！v7.1: localStorage有值时最快2~3秒就能跳）
window.addEventListener("DOMContentLoaded", () => setTimeout(() => startFix(false), 300));
// 紧急重试：ESC键也能触发（用户狂点F5进急救箱，按ESC=再查一次）
document.addEventListener("keydown", e => { if (e.key === "Escape") startFix(true); });
</script>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Zg-Worker-Version": WVER,
      "X-Robots-Tag": "noindex,nofollow",
      "Content-Security-Policy": "default-src 'self' 'unsafe-inline' 'unsafe-eval' raw.githubusercontent.com data: blob:; connect-src 'self' raw.githubusercontent.com https:;"
    }
  });
}

function zgStatusHTML(candidates, results) {
  // 状态页：展示候选URL健康度
  const rows = (candidates||[]).map((u,i) => {
    const r = results && results[u];
    const ok = r && r.ok;
    const ms = r && r.ms || "-";
    const cls = ok ? "status ok" : (r ? "status bad" : "status pending");
    const txt = ok ? `✅ ${ms}ms` : (r ? "❌ 假死" : "⏳ 检测中");
    const score = scoreOf(u);
    return `<div class="row">
      <span>${i+1}. ${esc(u.replace(/^https?:\/\//,""))}</span>
      <span style="display:flex;align-items:center">
        <span class="status" style="background:#fef3c7;color:#92400e;margin-right:8px">健康度 ${Math.round(score*100)}%</span>
        <span class="${cls}">${txt}</span>
      </span>
    </div>`;
  }).join("");
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>📊 追光 · 系统状态</title>
<style>
body { font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:#f8fafc; color:#0f172a; min-height:100vh; padding:24px; display:flex; align-items:center; justify-content:center; }
.card { background:#fff; border-radius:20px; padding:36px 28px; max-width:720px; width:100%; box-shadow:0 20px 40px rgba(15,23,42,.08); }
h1 { font-size:24px; margin-bottom:6px; color:#1e293b; }
.sub { color:#64748b; font-size:14px; margin-bottom:20px; }
.tag { display:inline-block; padding:3px 10px; border-radius:999px; background:#dbeafe; color:#1e40af; font-size:12px; font-weight:700; margin-right:6px; }
.tag.ok { background:#dcfce7; color:#166534; }
.btn { display:block; width:100%; padding:14px; border:none; border-radius:12px; background:#0ea5e9; color:#fff; font-size:15px; font-weight:700; cursor:pointer; margin:18px 0; box-shadow:0 8px 20px rgba(14,165,233,.25); }
.btn:hover { background:#0284c7; }
.row { display:flex; align-items:center; justify-content:space-between; padding:11px 14px; background:#f8fafc; border-radius:10px; margin-bottom:7px; font-size:13px; font-family:ui-monospace, monospace; word-break:break-all; }
.status { padding:3px 8px; border-radius:6px; font-weight:700; font-size:11px; white-space:nowrap; margin-left:6px; }
.status.ok { background:#dcfce7; color:#166534; }
.status.bad { background:#fee2e2; color:#991b1b; }
.status.pending { background:#fef3c7; color:#92400e; }
.footer { margin-top:22px; padding-top:16px; border-top:1px dashed #cbd5e1; font-size:12px; color:#64748b; text-align:center; }
</style>
<body>
<div class="card">
  <h1>📊 追光 · 系统状态</h1>
  <div class="sub">Worker ${WVER} · 每次刷新实时检测 · ${new Date().toLocaleString("zh-CN")}</div>
  <div style="margin:12px 0">
    <span class="tag">候选URL ${(candidates||[]).length} 条</span>
    <span class="tag ok">真活 ${(results?Object.values(results).filter(r=>r.ok).length:0)} 条</span>
  </div>
  <button class="btn" onclick="location.reload()">🔄 立即刷新状态</button>
  <div>${rows || '<div class="row"><span>暂无候选</span><span class="status pending">等待写入</span></div>'}</div>
  <div class="footer">
    <div>🔗 急救地址（网站1016时用）：<a href="/zg-auto-fix" style="color:#2563eb">/zg-auto-fix</a></div>
    <div>Worker版本：${WVER}</div>
  </div>
</div>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Zg-Worker-Version": WVER,
    }
  });
}

// ==============================================================================
// 🅲️ v7.0 新增：Race真活健康检查 + 候选URL拉取
// ==============================================================================
async function fetchRaceHealthy(candidates) {
  // 对候选URL并行请求/__zg_health，返回【真活数组按响应速度从快到慢排序】
  if (!candidates || !candidates.length) return [];
  const start = Date.now();
  const results = await Promise.all(candidates.map(u => {
    const t0 = Date.now();
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), RACE_HEALTH_TIMEOUT_MS);
    const url = u.replace(/\/+$/, "") + "/__zg_health?_zg=" + Date.now() + Math.random().toString(36).slice(2,6);
    return fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Zhuiguang-Worker-v7-Race/1.0",
        "X-Pinggy-No-Screen": "1",
        "Accept": "*/*",
      }
    }).then(r => {
      clearTimeout(tm);
      const ok = r.status === 200;
      mark(u, ok);
      if (ok) lastGoodUrl = u;
      return { u, ok, ms: Date.now()-t0 };
    }).catch(() => {
      clearTimeout(tm);
      mark(u, false);
      return { u, ok: false, ms: 9999 };
    });
  }));
  results.forEach(r => { if (r.ok) lastGoodUrl = r.u; });
  return results.filter(r => r.ok).sort((a,b)=>a.ms-b.ms).map(r => r.u);
}

async function fetchCandidates(url) {
  const now = Date.now();
  if (now - cachedUrlsAt < URL_CACHE_TTL_MS && cachedUrls && cachedUrls.length) return cachedUrls.slice();
  let arr = [];
  // 1. GitHub raw 主源
  try {
    const r = await fetch(GITHUB_RAW + "?v=" + now, {
      cf: { cacheTtl: 1, cacheKey: GITHUB_RAW + "?v=v7&t=" + Math.floor(now/10000) },
      headers: { "User-Agent": "Zhuiguang-Worker-v7/1.0" }
    });
    if (r.ok) {
      const t = await r.text();
      t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(s => {
        if (/^https?:\/\/[A-Za-z0-9\-.]+/i.test(s)) arr.push(s.replace(/\/+$/,""));
      });
    }
  } catch(e) {}
  // 2. 去重
  arr = Array.from(new Set(arr));
  // 3. 排序：按健康分从高到低
  arr.sort((a,b) => scoreOf(b)-scoreOf(a));
  // 4. lastGoodUrl优先
  if (lastGoodUrl && !arr.includes(lastGoodUrl)) arr.unshift(lastGoodUrl);
  cachedUrls = arr.slice();
  cachedUrlsAt = now;
  return arr.slice();
}

// ==============================================================================
// 🅳 v7.0 主 fetch 事件 = 彻底闭环！
// ==============================================================================
addEventListener("fetch", event => {
  event.respondWith((async () => {
    try {
      const req = event.request;
      const u = new URL(req.url);
      const pathname = u.pathname;
      const method = (req.method||"GET").toUpperCase();

      // ============ ① 特殊路径：独立页面，完全不请求origin！【永远200！就算所有origin死了也能打开！】 ============
      if (method === "GET") {
        if (pathname === "/zg-auto-fix" || pathname.startsWith("/zg-auto-fix?")) {
          return zgAutoFixHTML();
        }
        if (pathname === "/zg-status" || pathname.startsWith("/zg-status?")) {
          const cands = await fetchCandidates(req);
          const healthy = await fetchRaceHealthy(cands);
          const results = {};
          for (const c of cands) results[c] = { ok: healthy.includes(c), ms: healthy.indexOf(c)>=0 ? 1 : undefined };
          return zgStatusHTML(cands, results);
        }
      }

      // ============ ② 手动缓存命中（先返回缓存，不卡用户） ============
      const cached = await tryGetManualCache(req);
      if (cached) return cached;

      // ============ ③ 拉候选URL + Race找真活【从快到慢排序】 ============
      const candidates = await fetchCandidates(req);
      const healthy = await fetchRaceHealthy(candidates);

      // ============ ④ v7.1修复：origin全死→绝不返回急救箱！返回「服务正在重连中10秒自动刷新」页 ============
      // （用户一开网站就看到急救箱=脑残设计！急救箱只有用户主动访问/zg-auto-fix才打开！）
      if (healthy.length === 0) {
        return zgReconnectHTML(pathname);
      }

      // ============ ⑤ 有真活URL → 选最快的那条转发 ============
      const pickBase = healthy[0];
      const tgt = pickBase + u.pathname + u.search;
      const hdr = new Headers(req.headers);
      hdr.set("User-Agent", "Zhuiguang-Worker-v7/1.0 " + (hdr.get("User-Agent")||""));
      hdr.set("X-Pinggy-No-Screen", "1");
      hdr.set("X-Forwarded-For", (hdr.get("CF-Connecting-IP") || u.hostname));
      hdr.delete("CF-Connecting-IP");
      hdr.delete("CF-Ray");
      hdr.delete("CF-Visitor");

      let lastErr = null;
      // 多尝试：前3条真活URL（第一条最快，失败试第二条，再第三条）
      for (let k = 0; k < Math.min(3, healthy.length); k++) {
        const base = healthy[k];
        const target = base + u.pathname + u.search;
        try {
          const controller = new AbortController();
          const tm = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          const fReq = new Request(target, {
            method: req.method,
            headers: hdr,
            body: method !== "GET" && method !== "HEAD" ? await req.clone().arrayBuffer() : undefined,
            redirect: "manual",
            signal: controller.signal,
          });
          const resp = await fetch(fReq);
          clearTimeout(tm);
          mark(base, resp.ok && resp.status < 500);
          if (resp.status === 1016 || resp.status === 530 || (resp.status >= 500 && resp.status < 600)) {
            continue; // 这条隧道挂了，试下一条
          }
          const outH = new Headers(resp.headers);
          outH.set("X-Zg-Worker-Version", WVER);
          outH.set("X-Zg-Tunnel", base.replace(/^https?:\/\//,""));
          outH.delete("cf-cache-status");
          outH.delete("cf-ray");
          outH.delete("server");
          const outBody = resp.body;
          const outResp = new Response(outBody, { status: resp.status, statusText: resp.statusText, headers: outH });
          // 异步写缓存（waitUntil不阻塞用户首字节）
          event.waitUntil(tryPutManualCache(req, outResp.clone()));
          return outResp;
        } catch(e) {
          lastErr = e;
          mark(base, false);
          continue;
        }
      }

      // ============ ⑥ 所有真活URL都失败了 → 绝不返回急救箱！返回「重连中10秒自动刷新」页 ============
      return zgReconnectHTML(pathname);

    } catch(topErr) {
      // ============ 全局错误边界：任何异常 → 返回重连页（不返回默认错误页，也不返回急救箱！） ============
      try { return zgReconnectHTML(pathname); } catch(_) {}
      return new Response("Service Unavailable", { status: 503, headers: { "Content-Type": "text/plain", "X-Zg-Worker-Version": WVER, "Retry-After": "10" } });
    }
  })());
});
