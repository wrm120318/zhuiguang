// Pages Function: 代理所有 /api/* 请求到 Worker
export const config = { path: '/api/*' };

export async function onRequest(context) {
  const { request, params } = context;
  const slug = params.slug?.join('/') || '';
  const targetUrl = `https://api.xkzg.dpdns.org/api/${slug}`;

  // 处理 CORS
  const headers = new Headers(request.headers);
  headers.set('Origin', 'https://xkzg.dpdns.org');

  const resp = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.body,
  });

  const respHeaders = new Headers(resp.headers);
  respHeaders.set('Access-Control-Allow-Origin', '*');
  respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
