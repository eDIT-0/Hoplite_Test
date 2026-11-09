import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.mjs';

const TEST_KEY = 'test-key-never-return-this';
const IDEMPOTENCY_KEY = '123e4567-e89b-12d3-a456-426614174000';

async function withServer(options, callback) {
  const server = createApp(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(url, server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function request(url, pathname, options = {}) {
  return fetch(`${url}${pathname}`, options);
}

function rawLocalRequest(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end();
  });
}

test('status is available without a key and protected API returns a clear configuration error', async () => {
  let calls = 0;
  await withServer({ fetchImpl: async () => { calls++; throw new Error('unexpected upstream call'); } }, async (url) => {
    const status = await request(url, '/local/status');
    assert.deepEqual(await status.json(), { configured: false });
    assert.equal(status.headers.get('cache-control'), 'no-store');

    const response = await request(url, '/api/projects');
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /HOPLITE_API_KEY/);
    assert.equal(calls, 0);
  });
});

test('API key is forwarded only upstream and is never included in the local response', async () => {
  await withServer({
    apiKey: TEST_KEY,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers['X-Api-Key'], TEST_KEY);
      return jsonResponse({ accepted: true });
    },
  }, async (url) => {
    const response = await request(url, '/api/model-providers');
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { accepted: true });
    assert.equal(text.includes(TEST_KEY), false);
  });
});

test('credential echoes in an upstream success payload are rejected', async () => {
  await withServer({ apiKey: TEST_KEY, fetchImpl: async () => jsonResponse({ secret: TEST_KEY }) }, async (url) => {
    const response = await request(url, '/api/projects');
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(TEST_KEY), false);
  });
});

test('rejects untrusted Host, cross-origin Origin, and cross-site fetch metadata', async () => {
  let calls = 0;
  await withServer({ apiKey: TEST_KEY, fetchImpl: async () => { calls++; return jsonResponse({}); } }, async (url, port) => {
    const badHost = await rawLocalRequest(port, '/api/projects', { Host: `evil.example:${port}` });
    assert.equal(badHost.statusCode, 403);

    const badOrigin = await request(url, '/api/projects', { headers: { Origin: `http://evil.example:${port}` } });
    assert.equal(badOrigin.status, 403);

    const crossSite = await request(url, '/api/projects', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    assert.equal(calls, 0);
  });
});

test('forwards only allowlisted routes and query parameters to the fixed API origin', async () => {
  const calls = [];
  await withServer({
    apiKey: TEST_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    },
  }, async (url) => {
    const paths = [
      '/api/projects?pagination=cursor&cursor=next&limit=5&ignored=secret',
      '/api/model-providers',
      '/api/billing/summary',
      '/api/threads?projectId=proj_1&status=running&archived=false&q=hello&limit=4&cursor=next&ignored=x',
      '/api/threads/thr_01JQ7B',
      '/api/threads/thr_01JQ7B/messages?cursor=abc&limit=20&activityLimit=10&ignored=x',
      '/api/threads/thr_01JQ7B/active-run',
      '/api/threads/thr_01JQ7B/usage',
    ];
    for (const pathname of paths) {
      const response = await request(url, pathname);
      assert.equal(response.status, 200);
    }
    assert.deepEqual(calls.map(({ url }) => url), [
      'https://api.hoplite.sh/api/projects?pagination=cursor&cursor=next&limit=5',
      'https://api.hoplite.sh/api/model-providers',
      'https://api.hoplite.sh/api/billing/summary',
      'https://api.hoplite.sh/api/threads?projectId=proj_1&status=running&archived=false&q=hello&limit=4&cursor=next',
      'https://api.hoplite.sh/api/threads/thr_01JQ7B',
      'https://api.hoplite.sh/api/threads/thr_01JQ7B/messages?cursor=abc&limit=20&activityLimit=10',
      'https://api.hoplite.sh/api/threads/thr_01JQ7B/active-run',
      'https://api.hoplite.sh/api/threads/thr_01JQ7B/usage',
    ]);
    assert.equal(calls.every(({ init }) => init.redirect === 'error'), true);

    for (const pathname of ['/api/admin', '/api/threads/x/other']) {
      assert.equal((await request(url, pathname)).status, 404);
    }
    assert.equal((await request(url, '/api/projects', { method: 'POST' })).status, 405);
    assert.equal(calls.length, paths.length);
  });
});

test('POST requires JSON and a UUID idempotency key and forwards both exactly', async () => {
  const calls = [];
  await withServer({
    apiKey: TEST_KEY,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ created: true }, 201);
    },
  }, async (url) => {
    const badKey = await request(url, '/api/threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'not-a-uuid' }, body: '{}',
    });
    assert.equal(badKey.status, 400);
    const missingType = await request(url, '/api/threads', {
      method: 'POST', headers: { 'Idempotency-Key': IDEMPOTENCY_KEY }, body: '{}',
    });
    assert.equal(missingType.status, 415);
    assert.equal(calls.length, 0);

    const response = await request(url, '/api/threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({ projectId: 'proj_1', prompt: 'Do work' }),
    });
    assert.equal(response.status, 201);
    assert.equal(calls[0].url, 'https://api.hoplite.sh/api/threads');
    assert.equal(calls[0].init.headers['Idempotency-Key'], IDEMPOTENCY_KEY);
    assert.equal(calls[0].init.body, JSON.stringify({ projectId: 'proj_1', prompt: 'Do work' }));
  });
});

test('POST message and stop routes are forwarded with idempotency keys; stop requires an active run ID', async () => {
  const calls = [];
  await withServer({ apiKey: TEST_KEY, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ accepted: true }, 202);
  } }, async (url) => {
    const missingRun = await request(url, '/api/threads/thr_01JQ7B/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY }, body: '{}',
    });
    assert.equal(missingRun.status, 400);
    assert.match((await missingRun.json()).error, /runId/);

    for (const pathname of ['/api/threads/thr_01JQ7B/messages', '/api/threads/thr_01JQ7B/stop']) {
      const response = await request(url, pathname, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
        body: pathname.endsWith('/stop') ? '{"runId":"run_from_active_run"}' : '{"runId":"run_1"}',
      });
      assert.equal(response.status, 202);
    }
    assert.deepEqual(calls.map(({ url }) => url), [
      'https://api.hoplite.sh/api/threads/thr_01JQ7B/messages',
      'https://api.hoplite.sh/api/threads/thr_01JQ7B/stop',
    ]);
    assert.ok(calls.every(({ init }) => init.headers['Idempotency-Key'] === IDEMPOTENCY_KEY));
    assert.equal(calls[1].init.body, '{"runId":"run_from_active_run"}');
  });
});

test('rejects request bodies larger than 128 KiB before contacting upstream', async () => {
  let calls = 0;
  await withServer({ apiKey: TEST_KEY, fetchImpl: async () => { calls++; return jsonResponse({}); } }, async (url) => {
    const response = await request(url, '/api/threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': IDEMPOTENCY_KEY },
      body: JSON.stringify({ value: 'x'.repeat(128 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(calls, 0);
  });
});

test('upstream error bodies and fetch exceptions are redacted', async (t) => {
  await t.test('HTTP error', async () => {
    await withServer({ apiKey: TEST_KEY, fetchImpl: async () => jsonResponse({ message: TEST_KEY, stack: 'private' }, 401) }, async (url) => {
      const response = await request(url, '/api/projects');
      const text = await response.text();
      assert.equal(response.status, 401);
      assert.equal(text.includes(TEST_KEY), false);
      assert.equal(text.includes('private'), false);
      assert.match(JSON.parse(text).error, /авторизац/i);
    });
  });
  await t.test('fetch exception', async () => {
    await withServer({ apiKey: TEST_KEY, fetchImpl: async () => { throw new Error(TEST_KEY); } }, async (url) => {
      const response = await request(url, '/api/projects');
      assert.equal(response.status, 502);
      assert.equal((await response.text()).includes(TEST_KEY), false);
    });
  });
});

test('serves only the explicit local files with security headers', async () => {
  const publicDir = await mkdtemp(path.join(os.tmpdir(), 'hoplite-public-'));
  try {
    await mkdir(publicDir, { recursive: true });
    await writeFile(path.join(publicDir, 'index.html'), '<!doctype html><script src="/app.js"></script>');
    await writeFile(path.join(publicDir, 'app.js'), 'console.log("ok")');
    await writeFile(path.join(publicDir, 'chat.js'), 'export const ready = true;');
    await writeFile(path.join(publicDir, 'style.css'), 'body { color: black; }');
    await withServer({ publicDir, fetchImpl: async () => { throw new Error('unexpected upstream call'); } }, async (url) => {
      for (const [pathname, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/chat.js', 'text/javascript'], ['/style.css', 'text/css']]) {
        const response = await request(url, pathname);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), new RegExp(type));
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
        assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      assert.equal((await request(url, '/secret.txt')).status, 404);
    });
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test('message read denial explains thread:read without disclosing upstream data', async () => {
  await withServer({ apiKey: TEST_KEY, fetchImpl: async () => jsonResponse({ secret: TEST_KEY }, 403) }, async (url) => {
    const response = await request(url, '/api/threads/test/messages');
    assert.equal(response.status, 403);
    const text = await response.text();
    assert.match(text, /thread:read/);
    assert.equal(text.includes(TEST_KEY), false);
  });
});
