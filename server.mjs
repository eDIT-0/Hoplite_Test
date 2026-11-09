import { createServer } from 'node:http';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API_ORIGIN = 'https://api.hoplite.sh';
const BODY_LIMIT = 128 * 1024;
const UPSTREAM_TIMEOUT = 30_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const QUERY_PARAMS = new Map([
  ['/api/projects', new Set(['pagination', 'cursor', 'limit'])],
  ['/api/threads', new Set(['projectId', 'status', 'archived', 'q', 'limit', 'cursor'])],
  ['/api/threads/{id}/messages', new Set(['cursor', 'limit', 'activityLimit'])],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function genericUpstreamError(status) {
  const messages = {
    400: 'Запрос к API отклонён.',
    401: 'API отклонил авторизацию. Проверьте API-ключ и его права.',
    402: 'Для запроса требуется доступный тариф или баланс.',
    403: 'Недостаточно прав для запроса к API.',
    404: 'Ресурс API не найден.',
    409: 'Запрос конфликтует с текущим состоянием ресурса.',
    413: 'Запрос превышает допустимый размер.',
    429: 'Слишком много запросов к API.',
    500: 'Внутренняя ошибка API.',
    501: 'Операция не поддерживается API.',
    503: 'API временно недоступен.',
  };
  return messages[status] ?? `Ошибка API (HTTP ${status}).`;
}

function parseRoute(pathname) {
  if (pathname === '/api/projects') return { method: 'GET', path: pathname };
  if (pathname === '/api/model-providers') return { method: 'GET', path: pathname };
  if (pathname === '/api/billing/summary') return { method: 'GET', path: pathname };
  if (pathname === '/api/threads') return { method: 'GET', post: 'POST', path: pathname };

  const match = /^\/api\/threads\/([A-Za-z0-9_-]{1,128})(?:\/(messages|stop|active-run|usage))?$/.exec(pathname);
  if (!match || !THREAD_ID_RE.test(match[1])) return null;
  const [, id, action] = match;
  if (action === 'messages') return { method: 'GET', post: 'POST', path: `/api/threads/${id}/messages`, queryPath: '/api/threads/{id}/messages' };
  if (action === 'stop') return { method: 'POST', path: `/api/threads/${id}/stop` };
  if (action === 'active-run' || action === 'usage') return { method: 'GET', path: `/api/threads/${id}/${action}` };
  return { method: 'GET', path: `/api/threads/${id}` };
}

function readJsonBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > BODY_LIMIT) {
    req.resume();
    return Promise.reject(new HttpError(413, 'Тело запроса слишком велико.'));
  }

  return new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        exceeded = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) {
        reject(new HttpError(413, 'Тело запроса слишком велико.'));
        return;
      }
      if (size === 0) {
        reject(new HttpError(400, 'Требуется JSON-тело запроса.'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Некорректное JSON-тело запроса.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'Не удалось прочитать запрос.')));
  });
}

export function createApp({ apiKey = '', fetchImpl = fetch, publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public') } = {}) {
  const key = typeof apiKey === 'string' ? apiKey : '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");

    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      const hostHeader = req.headers.host ?? '';
      const hostMatch = /^(localhost|127\.0\.0\.1):(\d{1,5})$/i.exec(hostHeader);
      if (port === null || !hostMatch || Number(hostMatch[2]) !== port) {
        throw new HttpError(403, 'Недопустимый Host.');
      }
      const hostName = hostMatch[1].toLowerCase();
      const expectedOrigin = `http://${hostName}:${port}`;
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let originValue;
        try {
          originValue = new URL(origin).origin;
        } catch {
          throw new HttpError(403, 'Недопустимый Origin.');
        }
        if (originValue !== expectedOrigin) throw new HttpError(403, 'Недопустимый Origin.');
      }
      if (req.headers['sec-fetch-site']?.toLowerCase() === 'cross-site') {
        throw new HttpError(403, 'Межсайтовый запрос запрещён.');
      }

      let localUrl;
      try {
        localUrl = new URL(req.url, `http://${hostHeader}`);
      } catch {
        throw new HttpError(400, 'Некорректный URL запроса.');
      }
      const pathname = localUrl.pathname;

      if (pathname === '/local/status') {
        if (req.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        json(res, 200, { configured: key.length > 0 });
        return;
      }

      const staticFile = STATIC_FILES.get(pathname);
      if (staticFile) {
        if (req.method !== 'GET') throw new HttpError(405, 'Метод не поддерживается.');
        try {
          const root = await realpath(publicDir);
          const filename = path.join(root, staticFile[0]);
          const resolved = await realpath(filename);
          if (path.dirname(resolved) !== root) throw new Error('Invalid static path');
          const contents = await readFile(resolved);
          res.statusCode = 200;
          res.setHeader('Content-Type', staticFile[1]);
          res.end(contents);
        } catch {
          json(res, 404, { error: 'Локальный файл не найден.' });
        }
        return;
      }

      const route = parseRoute(pathname);
      if (!route) throw new HttpError(404, 'Маршрут не найден.');
      if (req.method !== route.method && req.method !== route.post) {
        throw new HttpError(405, 'Метод не поддерживается.');
      }
      if (!key) {
        json(res, 503, { error: 'Для локального API задайте HOPLITE_API_KEY в файле .env.' });
        return;
      }

      const method = req.method;
      const headers = { 'X-Api-Key': key };
      let body;
      if (method === 'POST') {
        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || !UUID_RE.test(idempotencyKey)) {
          throw new HttpError(400, 'Для POST требуется UUID в заголовке Idempotency-Key.');
        }
        const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') {
          throw new HttpError(415, 'Для POST требуется Content-Type: application/json.');
        }
        body = await readJsonBody(req);
        if (route.path.endsWith('/stop') && (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.runId !== 'string' || body.runId.trim().length === 0)) {
          throw new HttpError(400, 'Для остановки требуется runId активного запуска.');
        }
        headers['Content-Type'] = 'application/json';
        headers['Idempotency-Key'] = idempotencyKey;
      }

      const upstreamUrl = new URL(route.path, API_ORIGIN);
      const allowedQuery = QUERY_PARAMS.get(route.queryPath ?? route.path);
      if (allowedQuery) {
        for (const [name, value] of localUrl.searchParams) {
          if (allowedQuery.has(name)) upstreamUrl.searchParams.append(name, value);
        }
      }

      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method,
          headers,
          ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
        });
      } catch {
        json(res, 502, { error: 'Не удалось безопасно связаться с API.' });
        return;
      }

      if (upstream.status >= 300 && upstream.status < 400) {
        json(res, 502, { error: 'API вернул недопустимое перенаправление.' });
        return;
      }
      if (!upstream.ok) {
        const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
        const permissionHint = method === 'GET' && route.path.startsWith('/api/threads') && !route.path.endsWith('/usage') && [401, 403].includes(status)
          ? ' Для получения диалогов и ответов ключу требуется thread:read и доступ к этому проекту.' : '';
        json(res, status, { error: genericUpstreamError(status) + permissionHint });
        return;
      }
      if (upstream.status === 204) {
        res.statusCode = 204;
        res.end();
        return;
      }

      let payload;
      try {
        payload = await upstream.json();
      } catch {
        json(res, 502, { error: 'API вернул некорректный ответ.' });
        return;
      }
      if (key && JSON.stringify(payload).includes(key)) {
        json(res, 502, { error: 'Ответ API отклонён по соображениям безопасности.' });
        return;
      }
      json(res, upstream.status, payload);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Внутренняя ошибка локального сервера.';
      if (!res.headersSent) json(res, status, { error: message });
      else res.destroy();
    }
  });

  server.requestTimeout = UPSTREAM_TIMEOUT;
  server.headersTimeout = Math.min(10_000, UPSTREAM_TIMEOUT);
  return server;
}

function isDirectRun() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const portText = process.env.PORT ?? '3210';
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  const server = createApp({ apiKey: process.env.HOPLITE_API_KEY ?? '' });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Local backend listening on http://127.0.0.1:${port}`);
  });
}
