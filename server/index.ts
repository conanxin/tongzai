import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { database } from './node-env';
import {
  body, createRoom, endpoint, getSignals, joinRoom, json, performAction, postSignal,
  readRoom, roomInfo, roomVoiceConfig, voiceConfig, voiceToken,
} from '../lib/server/service';

const configuredBase = (process.env.APP_BASE_PATH || '').replace(/\/+$/, '');
if (configuredBase && !/^(\/[a-zA-Z0-9_-]+)+$/.test(configuredBase)) throw new Error('APP_BASE_PATH must be empty or a path such as /tongzai');
const basePath = configuredBase;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
const staticDirectory = resolve(process.env.STATIC_DIR || fileURLToPath(new URL('../client/', import.meta.url)));
const MAX_REQUEST_BYTES = 96 * 1024;
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function routePath(rawUrl: string): { pathname: string; search: string } {
  const question = rawUrl.indexOf('?');
  const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
  const search = question < 0 ? '' : rawUrl.slice(question);
  if (!rawPath.startsWith('/')) throw new HttpError(400, '请求路径无效。');
  let pathname: string;
  try { pathname = decodeURIComponent(rawPath); } catch { throw new HttpError(400, '请求路径无效。'); }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '.' || part === '..')) throw new HttpError(400, '请求路径无效。');
  if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) throw new HttpError(404, '没有找到这个页面。');
  return { pathname: pathname.slice(basePath.length) || '/', search };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const length = Number(request.headers['content-length'] || 0);
  if (length > MAX_REQUEST_BYTES) throw new HttpError(413, '提交的内容太长。');
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new HttpError(400, '请求已中断。'));
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST_BYTES) {
        cleanup(); request.resume(); reject(new HttpError(413, '提交的内容太长。')); return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => { cleanup(); resolveBody(Buffer.concat(chunks)); };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
}

async function webRequest(incoming: IncomingMessage, pathname: string, search: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = incoming.method || 'GET';
  const payload = method === 'GET' || method === 'HEAD' ? undefined : (await readRequestBody(incoming)).toString('utf8');
  return new Request(`http://localhost${pathname}${search}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
}

function wrongMethod(allowed: string): Response {
  const response = json({ error: '请求方法不受支持。', code: 'METHOD_NOT_ALLOWED' }, 405);
  response.headers.set('Allow', allowed);
  return response;
}

async function api(request: Request, pathname: string): Promise<Response> {
  const method = request.method;
  if (pathname === '/api/health') {
    if (method !== 'GET' && method !== 'HEAD') return wrongMethod('GET, HEAD');
    await database.prepare('SELECT 1 AS ready').first();
    return json({ ok: true, service: 'tongzai', runtime: 'node', storage: 'sqlite', basePath });
  }
  if (pathname === '/api/rooms') return method === 'POST' ? endpoint(async () => createRoom(await body(request))) : wrongMethod('POST');
  if (pathname === '/api/voice-config') return method === 'GET' ? endpoint(async () => voiceConfig()) : wrongMethod('GET');
  const match = /^\/api\/rooms\/([^/]+)(?:\/(info|join|actions|signals|voice-token|voice-config))?$/.exec(pathname);
  if (!match) return json({ error: '没有找到这个接口。', code: 'NOT_FOUND' }, 404);
  const [, id, operation] = match;
  switch (operation) {
    case undefined: return method === 'GET' ? endpoint(() => readRoom(id, request)) : wrongMethod('GET');
    case 'info': return method === 'GET' ? endpoint(() => roomInfo(id)) : wrongMethod('GET');
    case 'join': return method === 'POST' ? endpoint(async () => joinRoom(id, await body(request))) : wrongMethod('POST');
    case 'actions': return method === 'POST' ? endpoint(async () => performAction(id, request, await body(request))) : wrongMethod('POST');
    case 'signals':
      if (method === 'GET') return endpoint(() => getSignals(id, request));
      if (method === 'POST') return endpoint(async () => postSignal(id, request, await body(request)));
      return wrongMethod('GET, POST');
    case 'voice-token': return method === 'POST' ? endpoint(() => voiceToken(id, request)) : wrongMethod('POST');
    case 'voice-config': return method === 'GET' ? endpoint(() => roomVoiceConfig(id, request)) : wrongMethod('GET');
    default: return json({ error: '没有找到这个接口。', code: 'NOT_FOUND' }, 404);
  }
}

async function staticFile(pathname: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return wrongMethod('GET, HEAD');
  if (pathname.split('/').some(part => part.startsWith('.'))) throw new HttpError(404, '没有找到这个页面。');
  const spaRoute = pathname === '/' || /^\/r\/[a-f0-9]{12}\/?$/i.test(pathname);
  const filename = spaRoute ? 'index.html' : pathname.slice(1);
  const candidate = resolve(staticDirectory, filename);
  const contained = (root: string, file: string) => { const part = relative(root, file); return part !== '..' && !part.startsWith('../') && !isAbsolute(part); };
  if (!contained(staticDirectory, candidate)) throw new HttpError(400, '请求路径无效。');
  try {
    const [root, actual] = await Promise.all([realpath(staticDirectory), realpath(candidate)]);
    if (!contained(root, actual)) throw new HttpError(403, '无法访问这个文件。');
    const metadata = await stat(actual);
    if (!metadata.isFile()) throw new HttpError(404, '没有找到这个页面。');
    const headers = {
      'Content-Type': MIME_TYPES[extname(actual).toLowerCase()] || 'application/octet-stream',
      'Content-Length': String(metadata.size),
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    const bytes = method === 'HEAD' ? null : new Uint8Array(await readFile(actual));
    return new Response(bytes, { headers });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new HttpError(404, '没有找到这个页面。');
    throw error;
  }
}

async function writeResponse(incoming: IncomingMessage, outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  for (const [key, value] of response.headers) outgoing.setHeader(key, value);
  if (incoming.method === 'HEAD') { outgoing.end(); return; }
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const { pathname, search } = routePath(incoming.url || '/');
    const response = pathname.startsWith('/api/')
      ? await api(await webRequest(incoming, pathname, search), pathname)
      : await staticFile(pathname, incoming.method || 'GET');
    await writeResponse(incoming, outgoing, response);
  } catch (error) {
    if (outgoing.headersSent || outgoing.destroyed) return;
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) console.error('Tongzai HTTP error', error instanceof Error ? error.name : 'unknown');
    if (status === 413) outgoing.setHeader('Connection', 'close');
    await writeResponse(incoming, outgoing, json({ error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后再试。' }, status));
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.on('error', error => { console.error('Tongzai could not start:', error.message); database.close(); process.exitCode = 1; });
server.listen(port, host, () => {
  const address = server.address();
  console.log(JSON.stringify({ event: 'listening', service: 'tongzai', host, port: typeof address === 'object' && address ? address.port : port, basePath }));
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => { server.closeAllConnections(); database.close(); process.exit(0); }, 5000);
  timeout.unref();
  server.close(() => { clearTimeout(timeout); database.close(); process.exit(0); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
