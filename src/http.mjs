const MAX_FORM_BYTES = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function protectLocalRequest(request, response, localUrl) {
  // 页面包含本机记录，禁止缓存、外部嵌入和第三方资源。
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  // 固定 Host 防止外部域名指向本机，仅允许本站表单发起写操作。
  if (request.headers.host !== localUrl.host) {
    throw new HttpError(421, '请使用启动时给出的本机地址');
  }
  if (request.method === 'POST' && request.headers.origin !== localUrl.origin) {
    throw new HttpError(403, '请从本机页面提交表单');
  }
}

export function sendHtml(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

export function redirect(response, path) {
  // 保存后转回 GET 页面，避免浏览器刷新时重新提交表单。
  response.writeHead(303, { Location: path });
  response.end();
}

export async function readForm(request) {
  const type = request.headers['content-type']?.split(';', 1)[0].trim();
  if (type !== 'application/x-www-form-urlencoded') {
    throw new HttpError(415, '无法读取表单格式');
  }

  return new URLSearchParams((await readBody(request, MAX_FORM_BYTES)).toString('utf8'));
}

export async function readBody(request, maxBytes) {
  // 按实际收到的字节计数，分块传输同样受大小限制。
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume();
      throw new HttpError(413, '表单过大，请缩短正文后重试');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
