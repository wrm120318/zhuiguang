// ==============================================================================
// 追光 · Pages Function：/file/* 同域代理（v4.18.4 修复资料下载变空 htm）
// ==============================================================================
//
// 【BUG 根因（v4.17.0 同域改造引入）】
//   v4.17.0 起前端 baseURL 改为 ''（同域相对路径），但本目录此前只代理了
//   `/api/*`。资料下载走的是 `/file/r/:id`（ serveFileWithCache ）、
//   图片/头像走 `/file/raw/*` —— 这些路径**不在** /api/ 前缀下，
//   同域请求直接落入 CF Pages 的 SPA fallback → 返回 index.html
//   （text/html）→ 前端 fetch+blob 存盘时 Chrome 按 blob 类型补 `.htm`
//   扩展名 → 用户下载到的是「空白 SPA 壳」，即「md 资料下载变成 htm、
//   里面啥也没有」。实测 xkzg.de5.net/file/r/1 返回 8107 字节 text/html。
//
// 【修法】与 functions/api/[[path]].ts 完全同构：把 /file/* 原样透传到
//   api.xkzg.de5.net（Cloudflare 内网，毫秒级），status/headers/流式 body
//   全量保留 —— 大文件流式下载、Range、Content-Disposition 均不受影响。
//
// 【注意】本目录必须与 functions/api 平级；Pages 按目录前缀匹配路由，
//   `/file/*` 命中本 Function，`/api/*` 继续命中 api 目录，互不干扰。
// ==============================================================================

const API_ORIGIN = 'https://api.xkzg.de5.net'

export async function onRequest(context: {
  request: Request
  env: Record<string, unknown>
}): Promise<Response> {
  const { request } = context

  // 目标 URL：同域路径原样转到 API 源站（pathname + search 都不动，
  //   ?token=xxx 查询鉴权、Range 头等一概保留）
  const url = new URL(request.url)
  const target = API_ORIGIN + url.pathname + url.search

  const headers = new Headers(request.headers)
  headers.delete('host')

  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
    const resp = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    })

    const respHeaders = new Headers(resp.headers)
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
    })
  } catch (e) {
    return new Response(
      JSON.stringify({ message: 'API 代理失败：后端暂不可达', detail: String(e).slice(0, 200) }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    )
  }
}
