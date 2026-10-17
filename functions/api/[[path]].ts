// ==============================================================================
// 追光 · Pages Function：/api/* 同域代理（v4.17.0 性能专项）
// ==============================================================================
//
// 【为什么做同域代理】
//   改造前：前端在 xkzg.de5.net（Pages），API 在 api.xkzg.de5.net（Worker 自定义域）。
//   每个用户的每个页面都要多付一次**跨子域成本**：
//     · 一次独立 DNS 解析（api.xkzg.de5.net）
//     · 一次独立 TCP + TLS 建连 —— 实测建连 0.2~1.5s，跨境链路拥塞时冲到 15s+
//   SPA 首屏要并发打 5~8 个 API，这些建连抖动直接叠加成「网站卡顿」的体感。
//
//   改造后：前端请求同域相对路径 /api/*（baseURL=''），由本 Function 在
//   **CF 内部网络**转发到 api.xkzg.de5.net：
//     · 用户侧：零额外 DNS、零额外 TLS（与页面同连接复用，HTTP/2 多路复用）
//     · 服务侧：Pages Function → Worker 走 Cloudflare 内网，毫秒级
//   净效果：用户可感知的卡顿主要来源（跨子域建连抖动）被整体消除。
//
// 【为什么不用 Workers Routes（xkzg.de5.net/api/* → zhuiguang-api）】
//   那条路更优（同域直达 API Worker，零代理跳数），但它需要 Zone 级
//   Workers Routes 写权限，当前 API Token 没有（Method not allowed）。
//   等 Token 权限升级后可平滑迁移：删掉本目录 + 加 wrangler routes 配置即可，
//   前端无需任何改动（本来就是同域相对路径）。
//
// 【兼容性保证（不牺牲功能）】
//   · 透传 method / headers / body —— POST 上传、PUT、DELETE 全部原样
//   · 透传 status + 响应头 + **流式 body** —— SSE（AI 流式识别）、
//     文件下载（/api/file/* 大文件流式）都不会被缓冲破坏
//   · Authorization: Bearer <token> 头原样转发，鉴权链路不变
//   · api.xkzg.de5.net 继续可用（Worker 自定义域未动），旧链接/直连不失效
// ==============================================================================

const API_ORIGIN = 'https://api.xkzg.de5.net'

export async function onRequest(context: {
  request: Request
  env: Record<string, unknown>
}): Promise<Response> {
  const { request } = context

  // 目标 URL：同域路径原样转到 API 源站（pathname + search 都不动）
  const url = new URL(request.url)
  const target = API_ORIGIN + url.pathname + url.search

  // 构造转发请求头：剥掉 host（让 fetch 按目标重设，否则 api Worker 会收到
  // 错误 Host 导致虚拟主机路由错乱）；cf-connecting-ip 等 CF 内部头保留无碍
  const headers = new Headers(request.headers)
  headers.delete('host')

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const resp = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual', // 不自动跟随重定向，保留 API 的真实状态码
    })

    // 透传响应：status / headers / 流式 body 全量保留
    // （用 Response 构造器复制 init，body 用 resp.body 保持流式）
    const respHeaders = new Headers(resp.headers)
    // 同域下无需 CORS 头，但 API 侧已带 access-control-allow-origin: *，
    // 透传无副作用，保持简单不做删除。
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    })
  } catch (e) {
    // API 源站不可达（内网故障等）——返回明确 502，而不是让 SPA 拿到 HTML 兜底
    return new Response(
      JSON.stringify({ message: 'API 代理失败：后端暂不可达', detail: String(e).slice(0, 200) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
